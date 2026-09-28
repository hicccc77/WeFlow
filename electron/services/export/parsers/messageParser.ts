import { extractAppMessageType, extractXmlValue, normalizeAppMessageContent, extractXmlAttribute } from './xmlExtractor'
import { formatForwardChatRecordContent } from './forwardRecordParser'

import { parseVoipMessage } from './voipParser'
import { getTransferPrefix } from './transferParser'
import { formatEmojiSemanticText } from './fileAppParser'

export function stripSenderPrefix(content: string): string {
  return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '')
}

export function parseDurationSeconds(value: string): number | null {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  if (numeric >= 1000) return Math.round(numeric / 1000)
  return Math.round(numeric)
}

export function cleanSystemMessage(content: string): string {
  if (!content) return '[系统消息]'

  const sysmsgTextMatch = /<sysmsg[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(content)
  if (sysmsgTextMatch) {
    content = sysmsgTextMatch[1]
  }

  const revokeMatch = /<replacemsg><!\[CDATA\[(.*?)\]\]><\/replacemsg>/i.exec(content)
  if (revokeMatch) {
    return revokeMatch[1].trim()
  }

  const patMatch = /<template><!\[CDATA\[(.*?)\]\]><\/template>/i.exec(content)
  if (patMatch) {
    return patMatch[1]
      .replace(/\$\{([^}]+)\}/g, (_, varName) => {
        const varMatch = new RegExp(`<${varName}><!\\\[CDATA\\\[([^\]]*)\\\]\\\]><\/${varName}>`, 'i').exec(content)
        return varMatch ? varMatch[1] : ''
      })
      .replace(/<[^>]+>/g, '')
      .trim()
  }

  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(content)
  if (titleMatch) {
    const title = titleMatch[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    if (title) {
      return title
    }
  }

  content = content.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')

  return content
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/?[a-zA-Z0-9_:]+[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '[系统消息]'
}

export function extractReadableSystemMessageText(content: string): string {
  if (!content) return ''
  const normalized = normalizeAppMessageContent(content)
  const sysmsgMatch = /<sysmsg\b[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(stripSenderPrefix(normalized))
  const source = sysmsgMatch?.[1] || normalized
  const text =
    extractXmlValue(source, 'plain') ||
    extractXmlValue(source, 'text') ||
    ''
  return stripSenderPrefix(text).replace(/\s+/g, ' ').trim()
}

