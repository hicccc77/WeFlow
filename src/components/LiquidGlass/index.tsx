import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import GlassFilter from './GlassFilter'
import { generateLensDisplacementMap } from './lensDisplacementMap'
import { createGlassStreamRenderer } from './glassStreamRenderer'
import './liquidGlass.scss'

/**
 * 液态玻璃容器，移植自 liquid-glass-react v1.1.1（MIT）
 * https://github.com/rdev/liquid-glass-react
 *
 * 相对原库的调整：
 * - 移除内部 Tailwind 类名，全部改为内联样式（WeFlow 无 Tailwind 运行时）
 * - 由"固定定位 + 居中平移"的悬浮布局改为常规文档流布局，定位交给调用方
 * - 移除原库 overLight 的黑色压暗层：Chromium 中与 backdrop-filter 同级的
 *   mix-blend 图层无法参与混合、会按普通合成渲染，不透明黑层因此退化为实心黑块。
 *   主题适配改由全局兼容层 liquidGlass.scss 的 CSS 变量统一控制
 *   （--liquid-glass-tint / --liquid-glass-shadow），色调层只使用普通 alpha 合成；
 *   边缘高光/悬停辉光均为低透明度白色渐变，混合失效时也只会退化为普通高光，安全
 * - 注意：根节点不能设置 isolation / opacity / mask 等会形成 backdrop root 的属性，
 *   否则内部 backdrop-filter 将采样不到页面内容，玻璃会失去模糊折射
 * - 鼠标追踪仅在 elasticity > 0 时监听，并用 rAF 节流；远离激活区时不触发重渲染
 * - 尺寸改用 ResizeObserver 跟踪，内容变化时滤镜区域同步更新
 * - 位移贴图不用原库静态 PNG（边缘位移带太窄，宽扁卡片上退化成模糊），
 *   改用 lensDisplacementMap 按实际尺寸/圆角生成的透镜贴图：中心零位移完全清晰、
 *   边缘全周透镜弯曲；polar/prominent 模式与 Firefox 降级逻辑不保留（固定 Chromium）
 */

/** 鼠标弹性效果的激活半径（距元素边缘的像素距离） */
const ACTIVATION_ZONE = 200

/** 像素源裁剪层向外的出血宽度：容纳模糊核的边缘采样（透镜位移只向内采样，不需要出血） */
const PIXEL_SOURCE_BLEED = 32

interface MouseState {
    engaged: boolean
    tx: number
    ty: number
    scaleX: number
    scaleY: number
    /** 相对元素中心的偏移百分比，用于边缘高光渐变 */
    offsetX: number
    offsetY: number
}

const IDLE_MOUSE: MouseState = { engaged: false, tx: 0, ty: 0, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 }

/** 玻璃的替代背景采样源：屏幕快照/视频流 + 玻璃所在窗口的屏幕坐标 */
export interface LiquidGlassBackdropImage {
    /** 静态快照，视频流启动前的首帧兜底；可为空 */
    dataUrl?: string | null
    /** 屏幕的 CSS 像素尺寸（即逻辑分辨率） */
    width: number
    height: number
    /** 玻璃所在窗口在屏幕上的位置 */
    screenX: number
    screenY: number
}

export interface LiquidGlassProps {
    children: ReactNode
    /** 位移折射强度 */
    displacementScale?: number
    /** 磨砂程度（0~1，映射为额外的 backdrop blur 像素） */
    blurAmount?: number
    /** 背景饱和度百分比 */
    saturation?: number
    /** 边缘色散强度 */
    aberrationIntensity?: number
    /** 鼠标弹性系数，默认 0（完全关闭鼠标追踪，需要弹性效果时显式开启） */
    elasticity?: number
    cornerRadius?: number
    className?: string
    padding?: string
    style?: CSSProperties
    /**
     * 替代背景采样源。Electron 透明窗口内 backdrop-filter 不生效（Chromium 限制），
     * 传入与桌面逐像素对齐的屏幕快照后，玻璃改用普通 filter 在内部现场加工快照，
     * 视觉效果与真实 backdrop 采样一致
     */
    backdropImage?: LiquidGlassBackdropImage
    /** 屏幕实时视频流：就绪后替换静态快照，折射随桌面实时更新 */
    backdropStream?: MediaStream | null
    /**
     * 原生玻璃模式（Windows）：模糊/折射/色散由主进程的原生面板在窗口下方渲染
     * （@hicccc77/electron-liquid-glass，DXGI 零拷贝 + D3D11，感知滞后中位 ~6ms），
     * 组件内不再渲染折射背景层，只保留色调纱层、内容与边缘高光
     */
    nativeBackdrop?: boolean
    onClick?: () => void
}

/** 沿 offsetParent 链累计布局坐标：不受 transform 动画影响，可稳定对齐快照 */
function getLayoutOffset(el: HTMLElement): { x: number; y: number } {
    let x = 0
    let y = 0
    let node: HTMLElement | null = el
    while (node) {
        x += node.offsetLeft
        y += node.offsetTop
        node = node.offsetParent as HTMLElement | null
    }
    return { x, y }
}

export default function LiquidGlass({
    children,
    displacementScale = 70,
    blurAmount = 0.0625,
    saturation = 140,
    aberrationIntensity = 2,
    elasticity = 0,
    cornerRadius = 999,
    className = '',
    padding,
    style,
    backdropImage,
    backdropStream,
    nativeBackdrop = false,
    onClick
}: LiquidGlassProps) {
    const rootRef = useRef<HTMLDivElement>(null)
    const rawId = useId()
    // useId 可能包含 ':' 等 CSS url() 不接受的字符，需要清洗后才能用作滤镜 id
    const filterId = `liquid-glass-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

    const [isHovered, setIsHovered] = useState(false)
    const [isActive, setIsActive] = useState(false)
    const [glassSize, setGlassSize] = useState({ width: 270, height: 69 })
    const [anchor, setAnchor] = useState({ x: 0, y: 0 })
    const [mouse, setMouse] = useState<MouseState>(IDLE_MOUSE)
    const videoRef = useRef<HTMLVideoElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    // 视频流出帧后才切换显示，避免黑帧闪烁
    const [streamLive, setStreamLive] = useState(false)
    // WebGL 渲染器初始化失败时回退 <video> + SVG 滤镜管线
    const [glFailed, setGlFailed] = useState(false)
    const useGlPipeline = Boolean(backdropStream) && !glFailed && !nativeBackdrop

    // 透镜位移贴图按实际尺寸生成（中心零位移、边缘弯曲）；
    // WebGL 流管线在着色器内解析求值同一几何，无需贴图；原生模式折射在原生面板完成
    const lensMap = useMemo(
        () => (useGlPipeline || nativeBackdrop ? null : generateLensDisplacementMap(glassSize.width, glassSize.height, cornerRadius)),
        [useGlPipeline, nativeBackdrop, glassSize.width, glassSize.height, cornerRadius]
    )
    // 贴图生成失败时跳过位移滤镜（模糊和材质层仍然生效）
    const refractionFilter = lensMap?.url ? `url(#${filterId})` : undefined

    // WebGL 流管线：MediaStreamTrackProcessor 直读帧 + 着色器一次完成模糊/位移/色散/饱和，
    // 相比 <video> + CSS/SVG 滤镜省去播出缓冲与滤镜图逐帧重光栅化（延迟↓、GPU 开销↓）
    useEffect(() => {
        if (!useGlPipeline || !backdropImage) return
        const canvas = canvasRef.current
        const track = backdropStream?.getVideoTracks()[0]
        if (!canvas || !track) return

        // clone：同一流可能有多个玻璃实例（新旧通知过渡）与亮度采样共同消费
        const renderer = createGlassStreamRenderer({
            canvas,
            track: track.clone(),
            width: glassSize.width,
            height: glassSize.height,
            cornerRadius,
            screenX: backdropImage.screenX + anchor.x,
            screenY: backdropImage.screenY + anchor.y,
            screenW: backdropImage.width,
            screenH: backdropImage.height,
            displacementScale,
            aberrationIntensity,
            saturation,
            // 与回退管线的 blur(${(4 + blurAmount * 32) / 2}px) 一致
            blurSigma: (4 + blurAmount * 32) / 2,
            onFirstFrame: () => setStreamLive(true)
        })
        if (!renderer) {
            setGlFailed(true)
            return
        }
        return () => {
            renderer.dispose()
            setStreamLive(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        useGlPipeline, backdropStream, glassSize.width, glassSize.height, cornerRadius,
        backdropImage?.screenX, backdropImage?.screenY, backdropImage?.width, backdropImage?.height,
        anchor.x, anchor.y, displacementScale, aberrationIntensity, saturation, blurAmount
    ])

    // 回退管线：<video> 承载流，CSS/SVG 滤镜加工
    useEffect(() => {
        if (useGlPipeline) return
        const video = videoRef.current
        if (!video || !backdropStream) return
        let cancelled = false
        video.srcObject = backdropStream
        // 用首帧回调而非 playing 事件：真正出帧的一刻立即显示，最小化感知延迟
        video.requestVideoFrameCallback(() => {
            if (!cancelled) setStreamLive(true)
        })
        video.play().catch(() => { /* 流启动失败时保持静态快照/材质层 */ })
        return () => {
            cancelled = true
            video.srcObject = null
            setStreamLive(false)
        }
    }, [useGlPipeline, backdropStream])

    // 跟踪自身尺寸与页面内布局位置，供 SVG 滤镜和快照对齐使用
    useEffect(() => {
        const el = rootRef.current
        if (!el) return
        const update = () => {
            const width = el.offsetWidth
            const height = el.offsetHeight
            setGlassSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
            const offset = getLayoutOffset(el)
            setAnchor(prev => (prev.x === offset.x && prev.y === offset.y ? prev : offset))
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    // 鼠标接近时的弹性形变（rAF 节流；远离激活区时不重复 setState）
    useEffect(() => {
        if (elasticity <= 0) return

        let rafHandle = 0
        let lastEvent: MouseEvent | null = null

        const compute = () => {
            rafHandle = 0
            const el = rootRef.current
            if (!el || !lastEvent) return

            const rect = el.getBoundingClientRect()
            const centerX = rect.left + rect.width / 2
            const centerY = rect.top + rect.height / 2
            const deltaX = lastEvent.clientX - centerX
            const deltaY = lastEvent.clientY - centerY

            const edgeDistance = Math.hypot(
                Math.max(0, Math.abs(deltaX) - rect.width / 2),
                Math.max(0, Math.abs(deltaY) - rect.height / 2)
            )
            if (edgeDistance > ACTIVATION_ZONE) {
                setMouse(prev => (prev.engaged ? IDLE_MOUSE : prev))
                return
            }

            // 距离边缘越近效果越强
            const fadeIn = 1 - edgeDistance / ACTIVATION_ZONE
            const centerDistance = Math.hypot(deltaX, deltaY)
            const stretch = centerDistance === 0 ? 0 : Math.min(centerDistance / 300, 1) * elasticity * fadeIn
            const normalX = centerDistance === 0 ? 0 : Math.abs(deltaX / centerDistance)
            const normalY = centerDistance === 0 ? 0 : Math.abs(deltaY / centerDistance)

            setMouse({
                engaged: true,
                tx: deltaX * elasticity * 0.1 * fadeIn,
                ty: deltaY * elasticity * 0.1 * fadeIn,
                // 沿鼠标方向拉伸、垂直方向压缩，模拟液体
                scaleX: Math.max(0.8, 1 + normalX * stretch * 0.3 - normalY * stretch * 0.15),
                scaleY: Math.max(0.8, 1 + normalY * stretch * 0.3 - normalX * stretch * 0.15),
                offsetX: (deltaX / rect.width) * 100,
                offsetY: (deltaY / rect.height) * 100
            })
        }

        const handleMouseMove = (event: MouseEvent) => {
            lastEvent = event
            if (!rafHandle) rafHandle = requestAnimationFrame(compute)
        }

        document.addEventListener('mousemove', handleMouseMove)
        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            if (rafHandle) cancelAnimationFrame(rafHandle)
        }
    }, [elasticity])

    const clickable = Boolean(onClick)
    const pressed = isActive && clickable

    let transform: string | undefined
    if (mouse.engaged) {
        transform = `translate(${mouse.tx}px, ${mouse.ty}px) ${pressed ? 'scale(0.96)' : `scaleX(${mouse.scaleX}) scaleY(${mouse.scaleY})`}`
    } else if (pressed) {
        transform = 'scale(0.96)'
    }

    const borderGradient = (midAlpha: number, peakAlpha: number) => `linear-gradient(
    ${135 + mouse.offsetX * 1.2}deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, ${midAlpha + Math.abs(mouse.offsetX) * 0.008}) ${Math.max(10, 33 + mouse.offsetY * 0.3)}%,
    rgba(255, 255, 255, ${peakAlpha + Math.abs(mouse.offsetX) * 0.012}) ${Math.min(90, 66 + mouse.offsetY * 0.4)}%,
    rgba(255, 255, 255, 0) 100%
  )`

    const overlayBase: CSSProperties = {
        position: 'absolute',
        inset: 0,
        borderRadius: cornerRadius,
        pointerEvents: 'none'
    }

    // 快照/视频与屏幕逐像素对齐：按"窗口屏幕坐标 + 玻璃布局位置"负偏移，
    // 再补回裁剪层的出血宽度（像素源挂在 inset:-BLEED 的裁剪层内）
    const backdropPixelSourceStyle: CSSProperties | undefined = backdropImage
        ? {
            position: 'absolute',
            top: 0,
            left: 0,
            width: backdropImage.width,
            height: backdropImage.height,
            maxWidth: 'none',
            transform: `translate(${PIXEL_SOURCE_BLEED - (backdropImage.screenX + anchor.x)}px, ${PIXEL_SOURCE_BLEED - (backdropImage.screenY + anchor.y)}px)`,
            pointerEvents: 'none'
        }
        : undefined

    // 1.5px 环形高光：通过 padding + mask 挖空中心实现
    // 注意不要带深色投影，浅色页面上会形成一圈突兀的黑边
    const borderLayerBase: CSSProperties = {
        ...overlayBase,
        padding: 1.5,
        WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
        WebkitMaskComposite: 'xor',
        maskComposite: 'exclude',
        boxShadow: '0 0 0 0.5px rgba(255, 255, 255, 0.35) inset, 0 1px 3px rgba(255, 255, 255, 0.2) inset'
    }

    return (
        <div
            ref={rootRef}
            className={`liquid-glass ${className}`.trim()}
            style={{
                position: 'relative',
                borderRadius: cornerRadius,
                cursor: clickable ? 'pointer' : undefined,
                transform,
                transition: 'transform 0.2s ease-out',
                boxShadow: 'var(--liquid-glass-shadow)',
                ...style
            }}
            onClick={onClick}
            onMouseEnter={clickable ? () => setIsHovered(true) : undefined}
            onMouseLeave={clickable ? () => { setIsHovered(false); setIsActive(false) } : undefined}
            onMouseDown={clickable ? () => setIsActive(true) : undefined}
            onMouseUp={clickable ? () => setIsActive(false) : undefined}
        >
            {lensMap?.url && (
                <GlassFilter
                    id={filterId}
                    map={lensMap}
                    displacementScale={displacementScale}
                    aberrationIntensity={aberrationIntensity}
                />
            )}

            {/* 折射背景层：常规模式用 backdrop-filter 实时采样页面；
                原生模式（Windows）折射由主进程原生面板在窗口下方渲染，这里完全透明；
                流模式（透明窗口）优先走 WebGL 管线：采集帧直读进着色器，
                模糊/透镜位移/色散/饱和一次完成，画布尺寸即玻璃尺寸；
                WebGL 不可用时回退「<video> + CSS/SVG 滤镜」结构：
                外层裁剪（圆角）→ 中层挂位移滤镜 → 模糊裁剪层（玻璃+出血）→ 像素源。
                提供快照时先显示、视频流出帧后无缝接管；无快照时流首帧淡入 */}
            {nativeBackdrop ? null : useGlPipeline && backdropImage ? (
                <span style={{ ...overlayBase, overflow: 'hidden' }}>
                    <canvas
                        ref={canvasRef}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            opacity: streamLive ? 1 : 0,
                            transition: 'opacity 0.12s ease',
                            pointerEvents: 'none'
                        }}
                    />
                </span>
            ) : backdropImage ? (
                <span style={{ ...overlayBase, overflow: 'hidden' }}>
                    <span style={{ position: 'absolute', inset: 0, filter: refractionFilter }}>
                        <span
                            style={{
                                position: 'absolute',
                                inset: -PIXEL_SOURCE_BLEED,
                                overflow: 'hidden',
                                // 快照模式模糊直接作用于像素源，同参数观感重于 backdrop 采样，减半以保留折射细节
                                filter: `blur(${(4 + blurAmount * 32) / 2}px) saturate(${saturation}%)`
                            }}
                        >
                            {backdropImage.dataUrl && !streamLive && (
                                <img src={backdropImage.dataUrl} alt="" style={backdropPixelSourceStyle} />
                            )}
                            {backdropStream && (
                                <video
                                    ref={videoRef}
                                    autoPlay
                                    muted
                                    playsInline
                                    style={{
                                        ...backdropPixelSourceStyle,
                                        // 首帧就绪前保持透明、就绪后快速淡入：无快照兜底时折射内容不突兀也不拖沓
                                        opacity: streamLive ? 1 : 0,
                                        transition: 'opacity 0.12s ease'
                                    }}
                                />
                            )}
                        </span>
                    </span>
                </span>
            ) : (
                <span
                    style={{
                        ...overlayBase,
                        overflow: 'hidden',
                        // 与原库一致的轻模糊基线，保证玻璃通透而非磨砂
                        backdropFilter: `blur(${4 + blurAmount * 32}px) saturate(${saturation}%)`,
                        filter: refractionFilter
                    }}
                />
            )}

            {/* 主题色调层：由全局兼容层变量控制，保证深浅模式下内容可读；
                变量可能被外部按背景高频连续调节（如通知的自适应纱层，采样上限 ~60Hz），
                短过渡只负责抹平采样步进，不引入可感知的跟随延迟 */}
            <span style={{ ...overlayBase, background: 'var(--liquid-glass-tint)', transition: 'background 0.08s linear' }} />

            {/* 内容层保持清晰 */}
            <div style={{ position: 'relative', zIndex: 1, padding }}>{children}</div>

            {/* 边缘高光双层（screen + overlay 混合），强度由兼容层变量整体缩放 */}
            <span style={{ ...borderLayerBase, zIndex: 2, mixBlendMode: 'screen', opacity: 'calc(0.2 * var(--liquid-glass-ring, 1))', background: borderGradient(0.12, 0.4) }} />
            <span style={{ ...borderLayerBase, zIndex: 2, mixBlendMode: 'overlay', opacity: 'var(--liquid-glass-ring, 1)', background: borderGradient(0.32, 0.6) }} />

            {/* 可点击时的悬停 / 按下辉光 */}
            {clickable && (
                <>
                    <div
                        style={{
                            ...overlayBase,
                            zIndex: 2,
                            transition: 'opacity 0.2s ease-out',
                            opacity: isHovered || isActive ? 0.5 : 0,
                            backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 50%)',
                            mixBlendMode: 'overlay'
                        }}
                    />
                    <div
                        style={{
                            ...overlayBase,
                            zIndex: 2,
                            transition: 'opacity 0.2s ease-out',
                            opacity: isActive ? 0.5 : 0,
                            backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 80%)',
                            mixBlendMode: 'overlay'
                        }}
                    />
                    <div
                        style={{
                            ...overlayBase,
                            zIndex: 2,
                            transition: 'opacity 0.2s ease-out',
                            opacity: isHovered ? 0.4 : isActive ? 0.8 : 0,
                            backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 100%)',
                            mixBlendMode: 'overlay'
                        }}
                    />
                </>
            )}
        </div>
    )
}
