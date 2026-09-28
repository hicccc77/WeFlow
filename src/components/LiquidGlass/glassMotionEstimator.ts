// 玻璃背景全局运动估计器：块匹配连续两帧的低分辨率亮度网格，
// 得到内容平移速度，用于预测采样（补偿采集链路 ~60ms 延迟，见 glassStreamRenderer）。
//
// 设计要点：
// - 置信门控：只有当位移显著优于零位移（SAD 对比）且方向与历史一致时才更新速度，
//   旋转/局部运动/画面突变等不可预测场景自动衰减到零补偿（退回普通滞后表现）
// - 亚格点精度：SAD 极值点抛物线插值，配合 EMA 平滑，避免逐帧抖动
// - 失败模式安全：估计错误的最坏结果是折射内容短暂偏移后回正，且经过模糊层视觉柔和

export const MOTION_GRID_W = 56
export const MOTION_GRID_H = 24

const SEARCH_X = 10 // 搜索半径（格）：±10 格 ≈ ±76px/帧 ≈ 4500px/s
const SEARCH_Y = 6
const MAX_VELOCITY = 6 // px/ms 上限（6000px/s，超出视为误匹配）
const MAX_OFFSET = 72 // 预测偏移上限（px），防极端外推

export interface GlassMotionEstimator {
    /** 输入当前帧的 RGBA 网格与时间戳，返回预测采样偏移目标（px，运动方向） */
    update: (rgba: Uint8Array, timestampMs: number) => { x: number; y: number }
    /** 无新帧时的衰减步（内容停止变化后把偏移收回零） */
    decay: () => { x: number; y: number }
}

/** SAD 极值点抛物线亚格点插值 */
function subCell(sadPrev: number, sadBest: number, sadNext: number): number {
    const denom = sadPrev - 2 * sadBest + sadNext
    if (denom <= 0) return 0
    return Math.max(-0.5, Math.min(0.5, (sadPrev - sadNext) / (2 * denom)))
}

export function createGlassMotionEstimator(
    cellPxX: number,
    cellPxY: number,
    predictMs: number
): GlassMotionEstimator {
    const size = MOTION_GRID_W * MOTION_GRID_H
    let prev: Uint8Array | null = null
    let curr: Uint8Array = new Uint8Array(size)
    let prevTs = 0
    let velX = 0
    let velY = 0

    const target = () => {
        // 速度低于 60px/s 视为静止（噪声区），不做补偿
        const speed = Math.hypot(velX, velY)
        if (speed < 0.06) return { x: 0, y: 0 }
        return {
            x: Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, velX * predictMs)),
            y: Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, velY * predictMs))
        }
    }

    /** 全搜索块匹配：返回最优位移（格）与置信信息 */
    const search = (prevGrid: Uint8Array) => {
        let bestDx = 0
        let bestDy = 0
        let bestSad = Infinity
        let zeroSad = 0
        // 缓存 x 方向 SAD 曲线（bestDy 行），用于亚格点插值
        const sadRow = new Float32Array(SEARCH_X * 2 + 1)
        for (let dy = -SEARCH_Y; dy <= SEARCH_Y; dy++) {
            const y0 = Math.max(0, -dy)
            const y1 = MOTION_GRID_H - Math.max(0, dy)
            for (let dx = -SEARCH_X; dx <= SEARCH_X; dx++) {
                const x0 = Math.max(0, -dx)
                const x1 = MOTION_GRID_W - Math.max(0, dx)
                let sad = 0
                for (let y = y0; y < y1; y++) {
                    const rowC = y * MOTION_GRID_W
                    const rowP = (y + dy) * MOTION_GRID_W + dx
                    for (let x = x0; x < x1; x++) {
                        sad += Math.abs(curr[rowC + x] - prevGrid[rowP + x])
                    }
                }
                sad /= (x1 - x0) * (y1 - y0)
                if (dx === 0 && dy === 0) zeroSad = sad
                if (sad < bestSad) {
                    bestSad = sad
                    bestDx = dx
                    bestDy = dy
                }
            }
        }
        // 最优行的 x 邻域 SAD（亚格点用），只在需要时补算
        const y0 = Math.max(0, -bestDy)
        const y1 = MOTION_GRID_H - Math.max(0, bestDy)
        for (let i = 0; i < sadRow.length; i++) {
            const dx = i - SEARCH_X
            const x0 = Math.max(0, -dx)
            const x1 = MOTION_GRID_W - Math.max(0, dx)
            let sad = 0
            for (let y = y0; y < y1; y++) {
                const rowC = y * MOTION_GRID_W
                const rowP = (y + bestDy) * MOTION_GRID_W + dx
                for (let x = x0; x < x1; x++) {
                    sad += Math.abs(curr[rowC + x] - prevGrid[rowP + x])
                }
            }
            sadRow[i] = sad / ((x1 - x0) * (y1 - y0))
        }
        return { bestDx, bestDy, bestSad, zeroSad, sadRow }
    }

    return {
        update(rgba, timestampMs) {
            // RGBA → 亮度网格，同时统计对比度
            let min = 255
            let max = 0
            const next = prev ?? new Uint8Array(size)
            for (let i = 0; i < size; i++) {
                const p = i * 4
                const luma = (rgba[p] * 54 + rgba[p + 1] * 183 + rgba[p + 2] * 19) >> 8
                next[i] = luma
                if (luma < min) min = luma
                if (luma > max) max = luma
            }
            prev = curr
            curr = next

            const dt = timestampMs - prevTs
            prevTs = timestampMs
            // 帧间隔异常（首帧/长暂停/时钟跳变）或画面无结构：不更新速度
            if (dt < 4 || dt > 90 || max - min < 10) {
                velX *= 0.55
                velY *= 0.55
                return target()
            }

            const { bestDx, bestDy, bestSad, zeroSad, sadRow } = search(prev)

            if (bestDx === 0 && bestDy === 0) {
                // 零位移最优 → 置信静止
                velX *= 0.35
                velY *= 0.35
                return target()
            }

            // 置信条件：位移匹配显著优于不动（否则可能是局部运动/画面突变）
            if (bestSad >= zeroSad * 0.8) {
                velX *= 0.55
                velY *= 0.55
                return target()
            }

            const i = bestDx + SEARCH_X
            const fracX = i > 0 && i < sadRow.length - 1 ? subCell(sadRow[i - 1], sadRow[i], sadRow[i + 1]) : 0
            // 匹配含义：curr[x] ≈ prev[x + dx]，内容位移 = -dx（向右运动时 dx 为负）
            const instVx = (-(bestDx + fracX) * cellPxX) / dt
            const instVy = (-bestDy * cellPxY) / dt
            if (Math.hypot(instVx, instVy) > MAX_VELOCITY) {
                velX *= 0.55
                velY *= 0.55
                return target()
            }

            if (instVx * velX + instVy * velY < 0) {
                // 方向反转（如拖拽折返）：快速重锚定，幅度打折避免过冲
                velX = instVx * 0.3
                velY = instVy * 0.3
            } else {
                velX = velX * 0.65 + instVx * 0.35
                velY = velY * 0.65 + instVy * 0.35
            }
            return target()
        },

        decay() {
            velX *= 0.5
            velY *= 0.5
            return target()
        }
    }
}
