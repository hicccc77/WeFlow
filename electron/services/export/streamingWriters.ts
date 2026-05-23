import type { MessageStreamRow } from './messageStream'
import { extractReadableSystemMessageText } from '../systemMessageFormatter'

export interface TextSink {
  write: (chunk: string) => Promise<void>
  end?: () => Promise<void>
}

export interface StreamingWriterOptions {
  flushEvery?: number
  getSenderName: (row: MessageStreamRow) => string | Promise<string>
  formatTimestamp?: (timestamp: number) => string
}

export interface HtmlStreamingWriterOptions extends StreamingWriterOptions {
  sessionName: string
}

export interface ChatLabJsonlStreamingWriterOptions extends StreamingWriterOptions {
  sessionName: string
}

export async function writeTxtStream(
  rows: AsyncIterable<MessageStreamRow>,
  sink: TextSink,
  options: StreamingWriterOptions
): Promise<{ messageCount: number }> {
  let buffer: string[] = []
  let messageCount = 0
  const flushEvery = Math.max(1, Math.floor(options.flushEvery || 120))
  const flush = async () => {
    if (buffer.length === 0) return
    await sink.write(buffer.join(''))
    buffer = []
  }

  for await (const row of rows) {
    const senderName = await options.getSenderName(row)
    const timestamp = formatTimestamp(row.createTime, options)
    const content = formatStreamingContent(row)
    buffer.push(`${timestamp} '${senderName}'\n${content}\n\n`)
    messageCount++
    if (buffer.length >= flushEvery) {
      await flush()
    }
  }

  await flush()
  await sink.end?.()
  return { messageCount }
}

export async function writeHtmlStream(
  rows: AsyncIterable<MessageStreamRow>,
  sink: TextSink,
  options: HtmlStreamingWriterOptions
): Promise<{ messageCount: number }> {
  const flushEvery = Math.max(1, Math.floor(options.flushEvery || 100))
  let buffer: string[] = []
  let messageCount = 0
  const flush = async () => {
    if (buffer.length === 0) return
    await sink.write(buffer.join(''))
    buffer = []
  }

  await sink.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(options.sessionName)}</title></head><body><main class="messages">\n`)
  for await (const row of rows) {
    const senderName = await options.getSenderName(row)
    const timestamp = formatTimestamp(row.createTime, options)
    const content = formatStreamingContent(row)
    buffer.push(
      `<article class="message ${row.isSend ? 'sent' : 'received'}">` +
      `<time>${escapeHtml(timestamp)}</time>` +
      `<b>${escapeHtml(senderName)}</b>` +
      `<p>${escapeHtml(content).replace(/\r?\n/g, '<br>')}</p>` +
      `</article>\n`
    )
    messageCount++
    if (buffer.length >= flushEvery) {
      await flush()
    }
  }
  await flush()
  await sink.write('</main></body></html>\n')
  await sink.end?.()
  return { messageCount }
}

export async function writeChatLabJsonlStream(
  rows: AsyncIterable<MessageStreamRow>,
  sink: TextSink,
  options: ChatLabJsonlStreamingWriterOptions
): Promise<{ messageCount: number }> {
  const flushEvery = Math.max(1, Math.floor(options.flushEvery || 200))
  let buffer: string[] = []
  let messageCount = 0
  const flush = async () => {
    if (buffer.length === 0) return
    await sink.write(buffer.join(''))
    buffer = []
  }

  await sink.write(`${JSON.stringify({ _type: 'chatlab', version: '1.0', generator: 'WeFlow' })}\n`)
  await sink.write(`${JSON.stringify({ _type: 'meta', name: options.sessionName, platform: 'wechat' })}\n`)

  for await (const row of rows) {
    const accountName = await options.getSenderName(row)
    const content = formatStreamingContent(row)
    buffer.push(`${JSON.stringify({
      _type: 'message',
      sender: row.senderUsername,
      accountName,
      timestamp: row.createTime,
      type: toChatLabType(row.localType),
      content,
      platformMessageId: row.serverIdRaw || String(row.serverId || row.localId)
    })}\n`)
    messageCount++
    if (buffer.length >= flushEvery) {
      await flush()
    }
  }

  await flush()
  await sink.end?.()
  return { messageCount }
}

function formatTimestamp(timestamp: number, options: Pick<StreamingWriterOptions, 'formatTimestamp'>): string {
  return options.formatTimestamp ? options.formatTimestamp(timestamp) : String(timestamp)
}

function formatStreamingContent(row: MessageStreamRow): string {
  if (row.localType === 10000 || /<sysmsg\b/i.test(row.content || '')) {
    return extractReadableSystemMessageText(row.content) || row.content
  }
  return row.content
}

export function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toChatLabType(localType: number): number {
  if (localType === 1) return 0
  if (localType === 3) return 1
  if (localType === 34) return 2
  if (localType === 43) return 3
  if (localType === 47) return 5
  if (localType === 48) return 8
  if (localType === 10000) return 80
  return 99
}
