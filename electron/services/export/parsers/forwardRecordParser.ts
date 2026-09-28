import { ForwardChatRecordItem } from '../types'
import { extractXmlValue, normalizeAppMessageContent, extractAppMessageType } from './xmlExtractor'
import { decodeHtmlEntities } from '../utils/htmlEscape'

function parseForwardChatRecordDataItem(body: string, attrs: string): ForwardChatRecordItem | null {
  const datatypeByAttr = /datatype\s*=\s*["']?(\d+)["']?/i.exec(attrs || '')
  const datatypeRaw = datatypeByAttr?.[1] || extractXmlValue(body, 'datatype') || '0'
  const datatype = Number.parseInt(datatypeRaw, 10)
  const sourcename = decodeHtmlEntities(extractXmlValue(body, 'sourcename'))
  const sourcetime = extractXmlValue(body, 'sourcetime')
  const sourceheadurl = extractXmlValue(body, 'sourceheadurl')
  const datadesc = decodeHtmlEntities(extractXmlValue(body, 'datadesc') || extractXmlValue(body, 'content'))
  const datatitle = decodeHtmlEntities(extractXmlValue(body, 'datatitle'))
  const fileext = extractXmlValue(body, 'fileext')
  const datasizeRaw = extractXmlValue(body, 'datasize')
  const datasize = datasizeRaw ? Number.parseInt(datasizeRaw, 10) : 0
  const nestedRecordXml = extractXmlValue(body, 'recordxml') || ''
  const nestedRecordList =
    datatype === 17 && nestedRecordXml
      ? parseForwardChatRecordContainer(nestedRecordXml)
      : undefined
  const chatRecordTitle = decodeHtmlEntities(
    (nestedRecordXml && extractXmlValue(nestedRecordXml, 'title')) || datatitle || ''
  )
  const chatRecordDesc = decodeHtmlEntities(
    (nestedRecordXml && extractXmlValue(nestedRecordXml, 'desc')) || datadesc || ''
  )

  if (!sourcename && !datadesc && !datatitle) return null

  return {
    datatype: Number.isFinite(datatype) ? datatype : 0,
    sourcename: sourcename || '',
    sourcetime: sourcetime || '',
    sourceheadurl: sourceheadurl || undefined,
    datadesc: datadesc || undefined,
    datatitle: datatitle || undefined,
    fileext: fileext || undefined,
    datasize: Number.isFinite(datasize) && datasize > 0 ? datasize : undefined,
    chatRecordTitle: chatRecordTitle || undefined,
    chatRecordDesc: chatRecordDesc || undefined,
    chatRecordList: nestedRecordList && nestedRecordList.length > 0 ? nestedRecordList : undefined
  }
}

function parseForwardChatRecordContainer(containerXml: string): ForwardChatRecordItem[] {
  const source = containerXml || ''
  if (!source) return []

  const segments: string[] = [source]
  const decodedContainer = decodeHtmlEntities(source)
  if (decodedContainer !== source) {
    segments.push(decodedContainer)
  }

  const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let cdataMatch: RegExpExecArray | null
  while ((cdataMatch = cdataRegex.exec(source)) !== null) {
    const cdataInner = cdataMatch[1] || ''
    if (cdataInner) {
      segments.push(cdataInner)
      const decodedInner = decodeHtmlEntities(cdataInner)
      if (decodedInner !== cdataInner) {
        segments.push(decodedInner)
      }
    }
  }

  const items: ForwardChatRecordItem[] = []
  const seen = new Set<string>()
  for (const segment of segments) {
    if (!segment) continue
    const dataItemRegex = /<dataitem\b([^>]*)>([\s\S]*?)<\/dataitem>/gi
    let dataItemMatch: RegExpExecArray | null
    while ((dataItemMatch = dataItemRegex.exec(segment)) !== null) {
      const parsed = parseForwardChatRecordDataItem(dataItemMatch[2] || '', dataItemMatch[1] || '')
      if (!parsed) continue
      const key = `${parsed.datatype}|${parsed.sourcename}|${parsed.sourcetime}|${parsed.datadesc || ''}|${parsed.datatitle || ''}`
      if (!seen.has(key)) {
        seen.add(key)
        items.push(parsed)
      }
    }
  }

  if (items.length > 0) return items
  const fallback = parseForwardChatRecordDataItem(source, '')
  return fallback ? [fallback] : []
}

export function parseChatHistory(content: string): ForwardChatRecordItem[] | undefined {
  try {
    const normalized = normalizeAppMessageContent(content || '')
    const appMsgType = extractAppMessageType(normalized)
    if (appMsgType !== '19' && !normalized.includes('<recorditem')) {
      return undefined
    }

    const items: ForwardChatRecordItem[] = []
    const dedupe = new Set<string>()
    const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
    let recordItemMatch: RegExpExecArray | null
    while ((recordItemMatch = recordItemRegex.exec(normalized)) !== null) {
      const parsedItems = parseForwardChatRecordContainer(recordItemMatch[1] || '')
      for (const item of parsedItems) {
        const dedupeKey = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}`
        if (!dedupe.has(dedupeKey)) {
          dedupe.add(dedupeKey)
          items.push(item)
        }
      }
    }

    if (items.length === 0 && normalized.includes('<dataitem')) {
      const fallbackItems = parseForwardChatRecordContainer(normalized)
      for (const item of fallbackItems) {
        const dedupeKey = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}`
        if (!dedupe.has(dedupeKey)) {
          dedupe.add(dedupeKey)
          items.push(item)
        }
      }
    }

    return items.length > 0 ? items : undefined
  } catch (e) {
    console.error('ExportService: 解析聊天记录失败:', e)
    return undefined
  }
}

function formatForwardChatRecordItemText(item: ForwardChatRecordItem): string {
  const desc = (item.datadesc || '').trim()
  const title = (item.datatitle || '').trim()
  if (desc) return desc
  if (title) return title
  switch (item.datatype) {
    case 3: return '[图片]'
    case 34: return '[语音消息]'
    case 43: return '[视频]'
    case 47: return '[表情包]'
    case 49:
    case 8: return title ? `[文件] ${title}` : '[文件]'
    case 17: return item.chatRecordDesc || title || '[聊天记录]'
    default: return '[消息]'
  }
}

function buildForwardChatRecordLines(record: ForwardChatRecordItem, depth = 0): string[] {
  const indent = depth > 0 ? `${'  '.repeat(Math.min(depth, 8))}` : ''
  const senderPrefix = record.sourcename ? `${record.sourcename}: ` : ''
  if (record.chatRecordList && record.chatRecordList.length > 0) {
    const nestedTitle = record.chatRecordTitle || record.datatitle || record.chatRecordDesc || '聊天记录'
    const header = `${indent}${senderPrefix}[转发的聊天记录]${nestedTitle}`
    const nestedLines = record.chatRecordList.flatMap((item) => buildForwardChatRecordLines(item, depth + 1))
    return [header, ...nestedLines]
  }
  const text = formatForwardChatRecordItemText(record)
  return [`${indent}${senderPrefix}${text}`]
}

export function formatForwardChatRecordContent(content: string): string {
  const normalized = normalizeAppMessageContent(content || '')
  const forwardName =
    extractXmlValue(normalized, 'nickname') ||
    extractXmlValue(normalized, 'title') ||
    extractXmlValue(normalized, 'des') ||
    extractXmlValue(normalized, 'displayname') ||
    '聊天记录'
  const records = parseChatHistory(normalized)
  if (!records || records.length === 0) {
    return forwardName ? `[转发的聊天记录]${forwardName}` : '[转发的聊天记录]'
  }

  const lines = records.flatMap((record) => buildForwardChatRecordLines(record))
  return `${forwardName ? `[转发的聊天记录]${forwardName}` : '[转发的聊天记录]'}\n${lines.join('\n')}`
}
