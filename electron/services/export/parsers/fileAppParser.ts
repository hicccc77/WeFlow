export function normalizeEmojiCaption(value: unknown): string | null {
  const caption = String(value || '').trim()
  if (!caption) return null
  return caption
}

export function formatEmojiSemanticText(caption?: string | null): string {
  const normalizedCaption = normalizeEmojiCaption(caption)
  if (!normalizedCaption) return '[表情包]'
  return `[表情包：${normalizedCaption}]`
}

function normalizeEmojiMd5(value: unknown): string | undefined {
  const md5 = String(value || '').trim().toLowerCase()
  if (!md5) return undefined
  if (/^[a-f0-9]{32}$/.test(md5)) return md5
  return undefined
}

export function extractLooseHexMd5(content: string): string | undefined {
  if (!content) return undefined
  const keyedMatch =
    /(?:emoji|sticker|md5)[^a-fA-F0-9]{0,32}([a-fA-F0-9]{32})/i.exec(content) ||
    /([a-fA-F0-9]{32})/i.exec(content)
  return normalizeEmojiMd5(keyedMatch?.[1] || keyedMatch?.[0])
}
