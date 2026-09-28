export function extractXmlValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i')
  const match = regex.exec(xml)
  if (match) {
    return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  }
  return ''
}

export function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  const tagRegex = new RegExp(`<${tagName}\\s+[^>]*${attrName}\\s*=\\s*"([^"]*)"`, 'i')
  const match = tagRegex.exec(xml)
  return match ? match[1] : ''
}

export function extractAppMessageType(xml: string): string {
  return extractXmlValue(xml, 'type')
}

export function normalizeAppMessageContent(content: string): string {
  if (!content) return ''
  const trimmed = content.trim()
  if (trimmed.startsWith('<?xml')) {
    const rootStart = trimmed.indexOf('<msg>')
    if (rootStart !== -1) {
      return trimmed.substring(rootStart)
    }
  }
  return trimmed
}
