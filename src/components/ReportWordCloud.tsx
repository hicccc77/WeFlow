import React from 'react'
import './ReportComponents.scss'

interface ReportWordCloudProps {
    words: { phrase: string; count: number }[]
}

const ReportWordCloud: React.FC<ReportWordCloudProps> = ({ words }) => {
    if (!words || words.length === 0) return null

    const maxCount = words.length > 0 ? words[0].count : 1
    const topWords = words.slice(0, 32)
    const baseSize = 520

    // 使用确定性随机数生成器
    const seededRandom = (seed: number) => {
        const x = Math.sin(seed) * 10000
        return x - Math.floor(x)
    }

    // 计算词云位置
    const placedItems: { x: number; y: number; w: number; h: number }[] = []

    const canPlace = (x: number, y: number, w: number, h: number): boolean => {
        const halfW = w / 2
        const halfH = h / 2
        const dx = x - 50
        const dy = y - 50
        const dist = Math.sqrt(dx * dx + dy * dy)
        const maxR = 49 - Math.max(halfW, halfH)
        if (dist > maxR) return false

        const pad = 1.8
        for (const p of placedItems) {
            if ((x - halfW - pad) < (p.x + p.w / 2) &&
                (x + halfW + pad) > (p.x - p.w / 2) &&
                (y - halfH - pad) < (p.y + p.h / 2) &&
                (y + halfH + pad) > (p.y - p.h / 2)) {
                return false
            }
        }
        return true
    }

    const wordItems = topWords.map((item, i) => {
        const ratio = item.count / maxCount
        const fontSize = Math.round(12 + Math.pow(ratio, 0.65) * 20)
        const opacity = Math.min(1, Math.max(0.35, 0.35 + ratio * 0.65))
        const delay = (i * 0.04).toFixed(2)

        // 计算词语宽度
        const charCount = Math.max(1, item.phrase.length)
        const hasCjk = /[\u4e00-\u9fff]/.test(item.phrase)
        const hasLatin = /[A-Za-z0-9]/.test(item.phrase)
        const widthFactor = hasCjk && hasLatin ? 0.85 : hasCjk ? 0.98 : 0.6
        const widthPx = fontSize * (charCount * widthFactor)
        const heightPx = fontSize * 1.1
        const widthPct = (widthPx / baseSize) * 100
        const heightPct = (heightPx / baseSize) * 100

        // 寻找位置
        let x = 50, y = 50
        let placedOk = false
        const tries = i === 0 ? 1 : 420

        for (let t = 0; t < tries; t++) {
            if (i === 0) {
                x = 50
                y = 50
            } else {
                const idx = i + t * 0.28
                const radius = Math.sqrt(idx) * 7.6 + (seededRandom(i * 1000 + t) * 1.2 - 0.6)
                const angle = idx * 2.399963 + seededRandom(i * 2000 + t) * 0.35
                x = 50 + radius * Math.cos(angle)
                y = 50 + radius * Math.sin(angle)
            }
            if (canPlace(x, y, widthPct, heightPct)) {
                placedOk = true
                break
            }
        }

        if (!placedOk) return null
        placedItems.push({ x, y, w: widthPct, h: heightPct })

        return (
            <span
                key={i}
                className="word-tag"
                style={{
                    '--final-opacity': opacity,
                    left: `${x.toFixed(2)}%`,
                    top: `${y.toFixed(2)}%`,
                    fontSize: `${fontSize}px`,
                    animationDelay: `${delay}s`,
                } as React.CSSProperties}
                title={`${item.phrase} (出现 ${item.count} 次)`}
            >
                {item.phrase}
            </span>
        )
    }).filter(Boolean)

    return (
        <div className="word-cloud-wrapper">
            <div className="word-cloud-inner">
                {wordItems}
            </div>
        </div>
    )
}

export default ReportWordCloud
