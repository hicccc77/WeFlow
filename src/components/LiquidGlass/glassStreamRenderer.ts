// 视频流模式的 WebGL 玻璃渲染器：替代「<video> 元素 + CSS blur/saturate + SVG 位移滤镜」管线。
//
// 性能与延迟设计：
// - MediaStreamTrackProcessor 直读采集帧（无 <video> 播出缓冲，省 1~2 帧延迟），
//   帧到达立即渲染，latest-wins 丢弃积压帧；无帧到达时零渲染（桌面静止零开销）
// - 圆角矩形 SDF 及其梯度在片元着色器内解析式求值，替代 CPU 逐像素生成位移贴图
//   （lensDisplacementMap）+ feImage + 3×feDisplacementMap + 2×feBlend 的滤镜图
// - 模糊降到半分辨率两趟可分离高斯（工作面积仅玻璃+边距），
//   位移、色散、饱和度合并进最终一趟片元着色，整帧只有 3 个小渲染目标
// - 透镜几何与 lensDisplacementMap/GlassFilter 保持同一套公式（bezel/单峰剖面/色散递减），
//   视觉与应用内 SVG 路径一致
// - 运动补偿预测采样（timewarp 思路）：屏幕采集链路存在 ~60ms 物理延迟
//   （WGC 帧池 → 跨进程 → 合成上屏，应用层无法消除），对"拖拽/滚动"这类
//   均匀平移场景，用块匹配估计背景运动矢量，把采样窗口向运动方向外推一个
//   延迟量，折射内容与真实位置的感知滞后可从 ~70ms 压到接近零；
//   不可预测运动（旋转/局部变化）由置信门控自动退回普通滞后表现
import { createGlassMotionEstimator, MOTION_GRID_W, MOTION_GRID_H } from './glassMotionEstimator'

const BLUR_MARGIN = 40
/** 预测外推时长（ms）：按实测采集→上屏延迟标定，故意欠补偿留稳定余量 */
const MOTION_PREDICT_MS = 60
/** 预测偏移的逐帧平滑系数 */
const OFFSET_SMOOTH = 0.45
/** 无新帧超过该时长即进入偏移回收（内容停止运动后把预测偏移退回零） */
const IDLE_DECAY_DELAY = 90

export interface GlassStreamRendererOptions {
    canvas: HTMLCanvasElement
    /** 渲染器独占的视频轨（调用方负责 clone），dispose 时停止 */
    track: MediaStreamTrack
    /** 玻璃 CSS 尺寸与圆角 */
    width: number
    height: number
    cornerRadius: number
    /** 玻璃左上角的屏幕逻辑坐标（窗口坐标 + 页内布局偏移） */
    screenX: number
    screenY: number
    /** 屏幕逻辑尺寸（视频帧与屏幕的映射基准，与帧实际分辨率无关） */
    screenW: number
    screenH: number
    displacementScale: number
    aberrationIntensity: number
    saturation: number
    /** 高斯模糊标准差（CSS px） */
    blurSigma: number
    /** 首帧渲染完成（用于淡入时机） */
    onFirstFrame?: () => void
}

export interface GlassStreamRenderer {
    dispose: () => void
}

const VERT = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

/** 下采样 + 单方向高斯（半分辨率，两趟可分离） */
const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSrcOrigin;   // 采样区域原点（源纹理 UV）
uniform vec2 uSrcSpan;     // 采样区域跨度（源纹理 UV）
uniform vec2 uOutSize;     // 本目标像素尺寸
uniform vec2 uDir;         // 模糊方向（源纹理 UV 每标准差步长）
out vec4 outColor;
void main() {
  vec2 t = gl_FragCoord.xy / uOutSize;
  vec2 uv = uSrcOrigin + t * uSrcSpan;
  outColor = texture(uTex, uv) * 0.4026
    + (texture(uTex, uv + uDir) + texture(uTex, uv - uDir)) * 0.2442
    + (texture(uTex, uv + uDir * 2.0) + texture(uTex, uv - uDir * 2.0)) * 0.0545;
}`

/** 透镜主着色：解析式 SDF 位移 + RGB 色散 + 饱和度 */
const LENS_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBlurTex;
uniform vec2 uGlassSize;   // CSS px
uniform float uDpr;
uniform float uRadius;
uniform float uBezel;
uniform float uMaxBend;
uniform float uDispFactor; // displacementScale / 70
uniform float uAberration;
uniform float uSaturation;
uniform float uMargin;     // 模糊纹理相对玻璃的外扩边距（CSS px）
out vec4 outColor;

// 圆角矩形 SDF（p 以玻璃中心为原点）
float sdRoundRect(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// 平滑 max(q,0)：法线方向在角区连续旋转，消除对角线上的方向折痕
vec2 softClamp(vec2 q, float soft) {
  return 0.5 * (q + sqrt(q * q + vec2(soft * soft)));
}

vec2 toBlurUV(vec2 cssPos) {
  return (cssPos + uMargin) / (uGlassSize + uMargin * 2.0);
}

void main() {
  // 画布像素 → 玻璃 CSS 坐标（画布原点左上，gl_FragCoord 原点左下）
  vec2 css = vec2(gl_FragCoord.x, uGlassSize.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 halfSize = uGlassSize * 0.5;
  vec2 p = css - halfSize;
  float r = min(uRadius, min(halfSize.x, halfSize.y));

  // 液态弯月面边缘（iOS 边缘处理，与原生面板/lensDisplacementMap 一致）：
  // 边缘带只重新分布"自己的内容"——靠边界处抻胀（拉伸）、往中心方向追赶压缩。
  // 采样映射 s(d) = -d + bump(t)·bend 两端连续（bump(0)=bump(1)=0）：
  // 内容跨玻璃边无缝衔接（无断裂线）、平滑并入清晰中心。单射性：上升斜率
  // 通过 maxBend ≤ 0.7/1.5·tp·bezel 封顶（局部拉伸 ≤ ~3.3×），
  // 镜像"舌头"折叠结构上不可能；下降侧只压缩（斜率 < -1），恒单射
  float depth = -sdRoundRect(p, halfSize, r);
  vec2 disp = vec2(0.0);
  vec2 nrm = vec2(0.0);
  float bump = 0.0;
  float edgeW = 0.0;
  if (depth > 0.0 && depth < uBezel) {
    vec2 q = abs(p) - halfSize + r;
    vec2 qs = softClamp(q, max(r * 0.8, 1.0));
    nrm = (qs / max(length(qs), 1e-4)) * sign(p + vec2(1e-6));
    float t = depth / uBezel;
    edgeW = (1.0 - t) * (1.0 - t);
    // C¹ 鼓包：smoothstep 上升至 t=0.62 峰值，smoothstep 回落到 0
    float u = clamp(t < 0.62 ? t / 0.62 : (1.0 - t) / 0.38, 0.0, 1.0);
    bump = u * u * (3.0 - 2.0 * u);
    disp = nrm * (bump * uMaxBend * min(uDispFactor, 1.0));
  }

  // 压缩带内做 5 tap 足迹积分（径向 + 切向拉丝）：边缘带是 2~3 倍缩小映射，
  // 点采样会产生锯齿/摩尔纹；径向扩散随压缩强度自适应加宽做抗锯齿。
  // 色散：与 GlassFilter 相同的 RGB 位移递减（R 全量、G/B 递减）
  vec3 c;
  float dispLen2 = dot(disp, disp);
  if (dispLen2 > 0.25) {
    vec2 tangent = vec2(nrm.y, -nrm.x) * sqrt(dispLen2);
    float rs = 0.05 + 0.10 * bump;
    float radial[5]; radial[0] = 1.0 - 2.0 * rs; radial[1] = 1.0 - rs; radial[2] = 1.0; radial[3] = 1.0 + rs; radial[4] = 1.0 + 2.0 * rs;
    float lateral[5]; lateral[0] = -0.36; lateral[1] = 0.18; lateral[2] = 0.0; lateral[3] = -0.18; lateral[4] = 0.36;
    float wts[5]; wts[0] = 0.14; wts[1] = 0.22; wts[2] = 0.28; wts[3] = 0.22; wts[4] = 0.14;
    c = vec3(0.0);
    for (int i = 0; i < 5; ++i) {
      vec2 d = disp * radial[i] + tangent * lateral[i];
      c += wts[i] * vec3(
          texture(uBlurTex, toBlurUV(css + d)).r,
          texture(uBlurTex, toBlurUV(css + d * (1.0 - uAberration * 0.05))).g,
          texture(uBlurTex, toBlurUV(css + d * (1.0 - uAberration * 0.1))).b);
    }
  } else {
    c = texture(uBlurTex, toBlurUV(css + disp)).rgb;
  }

  // CSS saturate() 等效矩阵
  float lum = dot(c, vec3(0.213, 0.715, 0.072));
  c = mix(vec3(lum), c, uSaturation);

  // 贴边宽幅边缘光（与原生面板一致，光源方向左上）：受光侧提亮、背光侧微压暗，
  // 权重 edgeW 在边界处最大、向内 C¹ 衰减，独立于位移鼓包——iOS 玻璃的
  // "实体厚度"暗示；细锐的描边环仍由内容层负责
  float lightDot = dot(nrm, vec2(-0.40, -0.92));
  c = clamp(c + edgeW * (0.09 * clamp(lightDot, 0.0, 1.0) - 0.04 * clamp(-lightDot, 0.0, 1.0)), 0.0, 1.0);

  outColor = vec4(c, 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('[LiquidGlass] shader compile failed:', gl.getShaderInfoLog(shader))
        gl.deleteShader(shader)
        return null
    }
    return shader
}

function link(gl: WebGL2RenderingContext, frag: string): WebGLProgram | null {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, frag)
    if (!vs || !fs) return null
    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn('[LiquidGlass] program link failed:', gl.getProgramInfoLog(program))
        gl.deleteProgram(program)
        return null
    }
    return program
}

/** 创建流渲染器；WebGL 不可用或轨道无效时返回 null（调用方回退 <video> 管线） */
export function createGlassStreamRenderer(options: GlassStreamRendererOptions): GlassStreamRenderer | null {
    const { canvas, track } = options
    const dpr = window.devicePixelRatio || 1
    const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        // 低延迟提示：帧到达即绘制，desynchronized 允许绕过合成器队列
        desynchronized: true,
        powerPreference: 'low-power'
    }) as WebGL2RenderingContext | null
    if (!gl) return null

    const blurProgram = link(gl, BLUR_FRAG)
    const lensProgram = link(gl, LENS_FRAG)
    if (!blurProgram || !lensProgram) {
        track.stop()
        return null
    }

    canvas.width = Math.max(1, Math.round(options.width * dpr))
    canvas.height = Math.max(1, Math.round(options.height * dpr))

    // 半分辨率模糊目标（玻璃 + 外扩边距）
    const blurW = Math.max(1, Math.ceil((options.width + BLUR_MARGIN * 2) / 2))
    const blurH = Math.max(1, Math.ceil((options.height + BLUR_MARGIN * 2) / 2))

    const screenTex = gl.createTexture()
    const makeTarget = () => {
        const tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, blurW, blurH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        const fbo = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        return { tex, fbo }
    }
    const targetA = makeTarget()
    const targetB = makeTarget()

    // 运动估计降采样目标：56×24 网格（复用模糊程序做加权降采样，uDir=0 时权重和为 1）
    const motionTex = gl.createTexture()
    const motionFbo = gl.createFramebuffer()
    gl.bindTexture(gl.TEXTURE_2D, motionTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, MOTION_GRID_W, MOTION_GRID_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, motionFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, motionTex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const blurU = {
        tex: gl.getUniformLocation(blurProgram, 'uTex'),
        srcOrigin: gl.getUniformLocation(blurProgram, 'uSrcOrigin'),
        srcSpan: gl.getUniformLocation(blurProgram, 'uSrcSpan'),
        outSize: gl.getUniformLocation(blurProgram, 'uOutSize'),
        dir: gl.getUniformLocation(blurProgram, 'uDir')
    }
    const lensU = {
        blurTex: gl.getUniformLocation(lensProgram, 'uBlurTex'),
        glassSize: gl.getUniformLocation(lensProgram, 'uGlassSize'),
        dpr: gl.getUniformLocation(lensProgram, 'uDpr'),
        radius: gl.getUniformLocation(lensProgram, 'uRadius'),
        bezel: gl.getUniformLocation(lensProgram, 'uBezel'),
        maxBend: gl.getUniformLocation(lensProgram, 'uMaxBend'),
        dispFactor: gl.getUniformLocation(lensProgram, 'uDispFactor'),
        aberration: gl.getUniformLocation(lensProgram, 'uAberration'),
        saturation: gl.getUniformLocation(lensProgram, 'uSaturation'),
        margin: gl.getUniformLocation(lensProgram, 'uMargin')
    }

    // 与 lensDisplacementMap 相同的几何参数（iOS 式宽幅湿边）。
    // maxBend = 弯月面鼓包峰值，斜率封顶保证映射单射：
    // 上升斜率 1.5/tp·maxBend/bezel ≤ 0.7（tp=0.62）⇒ maxBend = 0.289·bezel，
    // 远小于模糊纹理外扩边距，足迹采样不会越界
    const halfMin = Math.min(options.width, options.height) / 2
    const bezel = Math.min(34, halfMin * 0.75)
    const maxBend = 0.289 * bezel

    let disposed = false
    let firstFrame = true
    let texW = 0
    let texH = 0

    // 玻璃区域（+模糊边距）的屏幕逻辑坐标
    const regionX = options.screenX - BLUR_MARGIN
    const regionY = options.screenY - BLUR_MARGIN
    const regionW = options.width + BLUR_MARGIN * 2
    const regionH = options.height + BLUR_MARGIN * 2

    // —— 运动补偿状态：估计器输出目标偏移，渲染时平滑逼近 ——
    const estimator = createGlassMotionEstimator(regionW / MOTION_GRID_W, regionH / MOTION_GRID_H, MOTION_PREDICT_MS)
    const motionPixels = new Uint8Array(MOTION_GRID_W * MOTION_GRID_H * 4)
    let offsetX = 0
    let offsetY = 0
    let targetOffsetX = 0
    let targetOffsetY = 0
    let decayTimer = 0

    // 内容停止运动后采集不再出帧，渲染循环停摆，需要主动把预测偏移收回零，
    // 否则折射内容会停在外推位置上（错位定格）；首步等 IDLE_DECAY_DELAY
    // 确认无新帧，后续以短步长快速滑回
    const scheduleDecay = (delay = IDLE_DECAY_DELAY) => {
        clearTimeout(decayTimer)
        decayTimer = window.setTimeout(() => {
            if (disposed) return
            const t = estimator.decay()
            targetOffsetX = t.x
            targetOffsetY = t.y
            offsetX = offsetX * 0.5 + targetOffsetX * 0.5
            offsetY = offsetY * 0.5 + targetOffsetY * 0.5
            drawGlass()
            if (Math.abs(offsetX) > 0.5 || Math.abs(offsetY) > 0.5) scheduleDecay(40)
        }, delay)
    }

    const uploadTexture = (source: TexImageSource, w: number, h: number) => {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, screenTex)
        if (w !== texW || h !== texH) {
            texW = w
            texH = h
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    }

    /** 用当前 screenTex 内容执行模糊 + 透镜两级绘制（可被运动偏移回收重绘复用） */
    const drawGlass = () => {
        // 趟1：纹理采样区域 → 半分辨率 + 水平高斯。
        // 采样原点按运动预测偏移前移：显示"内容此刻应到达的位置"而非采集帧的旧位置
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, screenTex)
        gl.useProgram(blurProgram)
        gl.uniform1i(blurU.tex, 0)
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetA.fbo)
        gl.viewport(0, 0, blurW, blurH)
        gl.uniform2f(blurU.srcOrigin, (regionX - offsetX) / options.screenW, (regionY - offsetY) / options.screenH)
        gl.uniform2f(blurU.srcSpan, regionW / options.screenW, regionH / options.screenH)
        gl.uniform2f(blurU.outSize, blurW, blurH)
        gl.uniform2f(blurU.dir, options.blurSigma / options.screenW, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        // 趟2：垂直高斯（源为趟1 结果，UV 全幅，步长换算到区域跨度）
        gl.bindTexture(gl.TEXTURE_2D, targetA.tex)
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetB.fbo)
        gl.uniform2f(blurU.srcOrigin, 0, 0)
        gl.uniform2f(blurU.srcSpan, 1, 1)
        gl.uniform2f(blurU.dir, 0, options.blurSigma / regionH)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        // 趟3：透镜主着色 → 画布
        gl.useProgram(lensProgram)
        gl.bindTexture(gl.TEXTURE_2D, targetB.tex)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.uniform1i(lensU.blurTex, 0)
        gl.uniform2f(lensU.glassSize, options.width, options.height)
        gl.uniform1f(lensU.dpr, dpr)
        gl.uniform1f(lensU.radius, options.cornerRadius)
        gl.uniform1f(lensU.bezel, bezel)
        gl.uniform1f(lensU.maxBend, maxBend)
        gl.uniform1f(lensU.dispFactor, options.displacementScale / 70)
        gl.uniform1f(lensU.aberration, options.aberrationIntensity)
        gl.uniform1f(lensU.saturation, options.saturation / 100)
        gl.uniform1f(lensU.margin, BLUR_MARGIN)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        // 立即提交而不等下一次合成对齐（desynchronized 画布的低延迟关键）
        gl.flush()
    }

    /** 固定区域降采样出 56×24 亮度网格并回读，喂给运动估计器。
        采样区域不随补偿偏移移动，估计的是真实屏幕运动（避免补偿反馈回路） */
    const estimateMotion = (timestampMs: number) => {
        gl.useProgram(blurProgram)
        gl.uniform1i(blurU.tex, 0)
        gl.bindFramebuffer(gl.FRAMEBUFFER, motionFbo)
        gl.viewport(0, 0, MOTION_GRID_W, MOTION_GRID_H)
        gl.uniform2f(blurU.srcOrigin, regionX / options.screenW, regionY / options.screenH)
        gl.uniform2f(blurU.srcSpan, regionW / options.screenW, regionH / options.screenH)
        gl.uniform2f(blurU.outSize, MOTION_GRID_W, MOTION_GRID_H)
        // uDir=0 时高斯核权重和恰为 1，等价于纯降采样
        gl.uniform2f(blurU.dir, 0, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        // 5KB 同步回读，实测 <0.5ms；异步 PBO 会引入一帧估计延迟，得不偿失
        gl.readPixels(0, 0, MOTION_GRID_W, MOTION_GRID_H, gl.RGBA, gl.UNSIGNED_BYTE, motionPixels)
        const t = estimator.update(motionPixels, timestampMs)
        targetOffsetX = t.x
        targetOffsetY = t.y
        offsetX += (targetOffsetX - offsetX) * OFFSET_SMOOTH
        offsetY += (targetOffsetY - offsetY) * OFFSET_SMOOTH
        scheduleDecay()
    }

    const render = (frame: VideoFrame | HTMLVideoElement) => {
        if (disposed) return
        const fw = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.displayWidth
        const fh = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.displayHeight
        if (!fw || !fh) return

        // 整帧直传：采集帧是 GPU 背书的，texImage2D 走 GPU-GPU 拷贝；
        // 实测 visibleRect 裁剪视图反而更慢（触发同步转换路径），不做预裁剪。
        // UV 按屏幕逻辑坐标映射，帧分辨率高于逻辑尺寸时（Retina/高 DPI）采样自动降分辨率
        uploadTexture(frame as TexImageSource, fw, fh)
        estimateMotion(frame instanceof HTMLVideoElement ? performance.now() : frame.timestamp / 1000)
        drawGlass()

        if (firstFrame) {
            firstFrame = false
            options.onFirstFrame?.()
        }
    }

    // —— 帧泵：MediaStreamTrackProcessor 为主源（帧到达即渲染，无播出缓冲）。
    // 同轨再挂一个离屏 <video> 作首帧引子与后备：MSTP 只在画面变化时出帧，
    // 静态桌面上新挂载的玻璃会一直等不到首帧；video 的 loadeddata 能立刻
    // 给出当前帧，rVFC 则在 MSTP 不可用/停摆时兜底渲染 ——
    let lastPumpRender = 0

    const video = document.createElement('video')
    video.muted = true
    video.srcObject = new MediaStream([track])
    const onVideoFrame = () => {
        if (disposed) return
        // 主源正常供帧时后备不重复渲染（同帧二次绘制无意义）
        if (performance.now() - lastPumpRender > 250) render(video)
        video.requestVideoFrameCallback(onVideoFrame)
    }
    video.addEventListener('loadeddata', () => {
        if (!disposed && firstFrame) render(video)
    }, { once: true })
    video.requestVideoFrameCallback(onVideoFrame)
    video.play().catch(() => { /* 流启动失败保持首帧前状态 */ })

    const ProcessorCtor = (window as unknown as {
        MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }
    }).MediaStreamTrackProcessor
    let stopPump = () => { /* MSTP 不可用时仅有 video 后备 */ }

    if (ProcessorCtor) {
        // MSTP 会独占消费传入轨道，供 video 后备的轨道需要单独 clone
        const pumpTrack = track.clone()
        const reader = new ProcessorCtor({ track: pumpTrack }).readable.getReader()
        const pump = async () => {
            try {
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done || disposed) {
                        value?.close()
                        return
                    }
                    lastPumpRender = performance.now()
                    render(value)
                    value.close()
                }
            } catch { /* 轨道停止时 read 抛错，正常退出 */ }
        }
        void pump()
        stopPump = () => {
            void reader.cancel().catch(() => { /* 已关闭 */ })
            pumpTrack.stop()
        }
    }

    return {
        dispose: () => {
            if (disposed) return
            disposed = true
            clearTimeout(decayTimer)
            stopPump()
            video.srcObject = null
            track.stop()
            gl.deleteTexture(screenTex)
            gl.deleteTexture(targetA.tex)
            gl.deleteTexture(targetB.tex)
            gl.deleteTexture(motionTex)
            gl.deleteFramebuffer(targetA.fbo)
            gl.deleteFramebuffer(targetB.fbo)
            gl.deleteFramebuffer(motionFbo)
            gl.deleteProgram(blurProgram)
            gl.deleteProgram(lensProgram)
        }
    }
}
