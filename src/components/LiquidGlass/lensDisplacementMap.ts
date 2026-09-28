// 透镜位移贴图生成器（liquid-glass-react shader 模式思路的像素空间重写）
//
// 原版 shuding 公式在归一化坐标系里求 SDF，对宽扁卡片会把位移全部堆到四角、
// 长边中段几乎无效果。这里改为像素空间按真实圆角计算：
// 沿整个周边取弯曲带（bezel），带内用透镜剖面把采样点拉向中心，
// 中心区域零位移保持完全清晰，边缘全周产生"透过厚玻璃边看背景"的弯曲折射。
//
// 贴图尺寸=元素尺寸、放置在滤镜坐标 (0,0)：Chromium 实测 feImage 像素几何
// (0,0,w,h) 与元素原点精确对齐，负坐标/百分比几何解析不可靠

/** 圆角矩形 SDF：内部为负，边界为 0（像素坐标，原点在矩形中心） */
function roundedRectSDF(x: number, y: number, halfW: number, halfH: number, radius: number): number {
    const qx = Math.abs(x) - halfW + radius
    const qy = Math.abs(y) - halfH + radius
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

export interface LensDisplacementMap {
    /** 贴图 dataURL，生成失败时为空串（此时滤镜退化为无位移） */
    url: string
    /** 贴图编码的最大位移像素数；SVG 滤镜 scale 取 2×maxScale 时还原几何精确的透镜折射 */
    maxScale: number
    /** 贴图（=元素）尺寸，feImage 的像素几何 */
    width: number
    height: number
}

/** 按玻璃尺寸生成透镜位移贴图，R 通道编码 X 位移、G/B 通道编码 Y 位移，0.5 为零位移 */
export function generateLensDisplacementMap(width: number, height: number, cornerRadius: number): LensDisplacementMap {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    if (!context) return { url: '', maxScale: 0, width: w, height: h }

    const halfW = w / 2
    const halfH = h / 2
    const radius = Math.min(cornerRadius, halfW, halfH)
    // 弯曲带只占边缘一圈（真实玻璃只有斜面边缘折射，平板中心不弯曲）。
    // iOS 式宽幅湿边：带宽最多占短边一半的 75%（小药丸几乎整体是透镜，
    // 大面板保留清晰中心），不超过则弯曲不会叠进中心
    const bezel = Math.min(34, Math.min(halfW, halfH) * 0.75)
    // 弯月面鼓包峰值，斜率封顶保证映射单射（无断裂、无折叠）：
    // 上升斜率 1.5/tp·maxBend/bezel ≤ 0.7（tp=0.62）⇒ maxBend = 0.289·bezel
    const maxBend = 0.289 * bezel

    let maxScale = 0
    const rawValues: number[] = []
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            // 以玻璃中心为原点的像素坐标
            const px = x + 0.5 - halfW
            const py = y + 0.5 - halfH
            // 距边界深度（玻璃内部为正）
            const depth = -roundedRectSDF(px, py, halfW, halfH, radius)
            let dx = 0
            let dy = 0
            if (depth > 0 && depth < bezel) {
                // 液态弯月面剖面（iOS 边缘处理）：位移在边界与带内缘均为 0，
                // 内容跨玻璃边无缝衔接、平滑并入清晰中心；带内 smoothstep 升降
                //（峰值在 t=0.62），近边界抻胀、向内压缩回正，斜率封顶无折叠
                const t = depth / bezel
                const u = Math.min(1, t < 0.62 ? t / 0.62 : (1 - t) / 0.38)
                const hump = u * u * (3 - 2 * u)
                const amount = hump * maxBend
                // 法线 = 平滑化 max(q,0) 的方向（角区连续旋转，无对角线折痕）
                const qx = Math.abs(px) - halfW + radius
                const qy = Math.abs(py) - halfH + radius
                const soft = Math.max(radius * 0.8, 1)
                const sx = 0.5 * (qx + Math.hypot(qx, soft))
                const sy = 0.5 * (qy + Math.hypot(qy, soft))
                const len = Math.hypot(sx, sy)
                if (len > 1e-4) {
                    // 采样点沿法线向外：近边界内容被抻胀拽入边缘带（弯月面张力观感）
                    dx = (sx / len) * Math.sign(px || 1) * amount
                    dy = (sy / len) * Math.sign(py || 1) * amount
                }
            }
            maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy))
            rawValues.push(dx, dy)
        }
    }
    maxScale = Math.max(maxScale, 1)

    const imageData = context.createImageData(w, h)
    const data = imageData.data
    let rawIndex = 0
    let pixelIndex = 0
    const normalize = 2 * maxScale // [-max,max] 映射到 [0,1]，不裁剪、无平顶色带
    for (let i = 0; i < rawValues.length; i += 2) {
        const r = rawValues[rawIndex++] / normalize + 0.5
        const g = rawValues[rawIndex++] / normalize + 0.5
        data[pixelIndex++] = Math.max(0, Math.min(255, Math.round(r * 255))) // R：X 位移
        data[pixelIndex++] = Math.max(0, Math.min(255, Math.round(g * 255))) // G：Y 位移
        data[pixelIndex++] = Math.max(0, Math.min(255, Math.round(g * 255))) // B：Y 位移（滤镜取 B 通道）
        data[pixelIndex++] = 255
    }
    context.putImageData(imageData, 0, 0)
    return { url: canvas.toDataURL(), maxScale, width: w, height: h }
}
