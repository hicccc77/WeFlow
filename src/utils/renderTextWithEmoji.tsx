import type { ReactNode } from 'react'
import { getEmojiPath } from 'wechat-emojis'

/**
 * 把文本中的微信表情代码（如 [微笑]）渲染为内联表情图片，
 * 未匹配的方括号内容原样保留。size 为表情边长（px）
 */
export function renderTextWithEmoji(text: string, size = 22): ReactNode {
    if (!text) return text
    const parts = text.split(/\[(.*?)\]/g)
    return parts.map((part, index) => {
        // 奇数索引是方括号捕获组的内容
        if (index % 2 === 1) {
            const path = getEmojiPath(part as Parameters<typeof getEmojiPath>[0])
            if (path) {
                // path 例如 'assets/face/微笑.png'，需要添加 base 前缀
                return (
                    <img
                        key={index}
                        src={`${import.meta.env.BASE_URL}${path}`}
                        alt={`[${part}]`}
                        className="inline-emoji"
                        style={{ width: size, height: size, verticalAlign: 'bottom', margin: '0 1px' }}
                    />
                )
            }
            return `[${part}]`
        }
        return part
    })
}
