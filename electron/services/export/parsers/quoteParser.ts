import { extractXmlValue, normalizeAppMessageContent } from './xmlExtractor'
import { decodeHtmlEntities } from '../utils/htmlEscape'

export function looksLikeAccountId(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim().toLowerCase()
  if (trimmed.startsWith('accountId_')) return true
  return /^wx[a-z0-9_-]{4,}$/.test(trimmed)
}

export function sanitizeQuotedContent(content: string): string {
  if (!content) return ''
  let result = content
  result = result.replace(/accountId_[A-Za-z0-9_-]{3,}/g, '')
  result = result.replace(/^[\s:：\-]+/, '')
  result = result.replace(/[:：]{2,}/g, ':')
  result = result.replace(/^[\s:：\-]+/, '')
  result = result.replace(/\s+/g, ' ').trim()
  return result
}

function extractPartialQuotedText(xml: string, fullContent: string): string {
  if (!xml || !fullContent) return ''

  const startChar = extractXmlValue(xml, 'start')
  const endChar = extractXmlValue(xml, 'end')
  const startIndexRaw = extractXmlValue(xml, 'startindex')
  const endIndexRaw = extractXmlValue(xml, 'endindex')
  const startIndex = Number.parseInt(startIndexRaw, 10)
  const endIndex = Number.parseInt(endIndexRaw, 10)

  if (startChar && endChar) {
    const startPos = fullContent.indexOf(startChar)
    if (startPos !== -1) {
      const endPos = fullContent.indexOf(endChar, startPos + startChar.length - 1)
      if (endPos !== -1 && endPos >= startPos) {
        const sliced = fullContent.slice(startPos, endPos + endChar.length).trim()
        if (sliced) return sliced
      }
    }
  }

  if (Number.isFinite(startIndex) && Number.isFinite(endIndex) && endIndex >= startIndex) {
    const chars = Array.from(fullContent)
    const sliced = chars.slice(startIndex, endIndex + 1).join('').trim()
    if (sliced) return sliced
  }

  return ''
}

function extractPreferredQuotedText(referMsgXml: string): string {
  if (!referMsgXml) return ''

  const sources = [decodeHtmlEntities(referMsgXml)]
  const rawMsgSource = extractXmlValue(referMsgXml, 'msgsource')
  if (rawMsgSource) {
    const decodedMsgSource = decodeHtmlEntities(rawMsgSource)
    if (decodedMsgSource) {
      sources.push(decodedMsgSource)
    }
  }

  const fullContent = sanitizeQuotedContent(extractXmlValue(sources[0] || referMsgXml, 'content'))
  const partialText = extractPartialQuotedText(sources[0] || referMsgXml, fullContent)
  if (partialText) return partialText

  const candidateTags = [
    'selectedcontent',
    'selectedtext',
    'selectcontent',
    'selecttext',
    'quotecontent',
    'quotetext',
    'partcontent',
    'parttext',
    'excerpt',
    'summary',
    'preview'
  ]

  for (const source of sources) {
    for (const tag of candidateTags) {
      const value = sanitizeQuotedContent(extractXmlValue(source, tag))
      if (value) return value
    }
  }

  return fullContent
}

export function parseQuoteMessage(content: string): { content?: string; sender?: string; type?: string; svrid?: string } {
  try {
    const normalized = normalizeAppMessageContent(content || '')
    const referMsgStart = normalized.indexOf('<refermsg>')
    const referMsgEnd = normalized.indexOf('</refermsg>')
    if (referMsgStart === -1 || referMsgEnd === -1) {
      return {}
    }

    const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
    let sender = extractXmlValue(referMsgXml, 'displayname')
    if (sender && looksLikeAccountId(sender)) {
      sender = ''
    }

    const referContent = extractXmlValue(referMsgXml, 'content')
    const referType = extractXmlValue(referMsgXml, 'type')
    const svrid = extractXmlValue(referMsgXml, 'svrid')
    let displayContent = referContent

    switch (referType) {
      case '1':
        displayContent = extractPreferredQuotedText(referMsgXml)
        break
      case '3':
        displayContent = '[图片]'
        break
      case '34':
        displayContent = '[语音]'
        break
      case '43':
        displayContent = '[视频]'
        break
      case '47':
        displayContent = '[表情包]'
        break
      case '49':
        displayContent = '[链接]'
        break
      case '42':
        displayContent = '[名片]'
        break
      case '48':
        displayContent = '[位置]'
        break
      default:
        if (!referContent || referContent.includes('accountId_')) {
          displayContent = '[消息]'
        } else {
          displayContent = sanitizeQuotedContent(referContent)
        }
    }

    return {
      content: displayContent || undefined,
      sender: sender || undefined,
      type: referType || undefined,
      svrid: svrid || undefined
    }
  } catch {
    return {}
  }
}
