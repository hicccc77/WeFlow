import * as fs from 'fs'
import * as path from 'path'
import { canUseTypeScriptStreamingEngine } from './exportEngineRouter'
import {
  createMessageStream,
  isMessageStreamPauseError,
  isMessageStreamStopError,
  throwIfMessageStreamControlRequested,
  type MessageCursorSource,
  type MessageStreamControl,
  type MessageStreamRow
} from './messageStream'
import { writeChatLabJsonlStream, writeHtmlStream, writeTxtStream, type TextSink } from './streamingWriters'

export interface TypeScriptStreamingExportOptions {
  format: 'txt' | 'html' | 'chatlab-jsonl' | string
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  contentType?: string
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  exportVoiceAsText?: boolean
}

export interface TypeScriptStreamingExportRequest {
  source: MessageCursorSource & {
    open: (accountDir: string, decryptKey: string) => Promise<boolean>
    getDisplayNames: (usernames: string[]) => Promise<{ success: boolean; map?: Record<string, string>; error?: string }>
  }
  sessionIds: string[]
  outputDir: string
  options: TypeScriptStreamingExportOptions
  accountDir: string
  decryptKey: string
  cleanedMyWxid: string
  onProgress?: (progress: Record<string, unknown>) => void
  control?: MessageStreamControl & {
    recordCreatedFile?: (filePath: string) => void
    recordCreatedDir?: (dirPath: string) => void
  }
}

class FileSink implements TextSink {
  private readonly stream: fs.WriteStream

  constructor(filePath: string) {
    this.stream = fs.createWriteStream(filePath, { encoding: 'utf-8' })
  }

  async write(chunk: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        this.stream.off('error', onError)
        this.stream.off('drain', onDrain)
      }
      this.stream.once('error', onError)
      if (!this.stream.write(chunk)) {
        this.stream.once('drain', onDrain)
      } else {
        cleanup()
        resolve()
      }
    })
  }

  async end(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject)
      this.stream.end(() => resolve())
    })
  }
}

export function canUseTypeScriptStreamingExport(options: TypeScriptStreamingExportOptions): boolean {
  return canUseTypeScriptStreamingEngine(options)
}

export async function exportSessionsWithTypeScriptStreaming(request: TypeScriptStreamingExportRequest): Promise<Record<string, unknown>> {
  if (!canUseTypeScriptStreamingExport(request.options)) {
    return { success: false, successCount: 0, failCount: request.sessionIds.length, error: `streaming exporter does not support format: ${request.options.format}` }
  }

  const opened = await request.source.open(request.accountDir, request.decryptKey)
  if (!opened) {
    return { success: false, successCount: 0, failCount: request.sessionIds.length, error: 'WCDB 打开失败' }
  }

  await fs.promises.mkdir(request.outputDir, { recursive: true })
  request.control?.recordCreatedDir?.(request.outputDir)
  const sessionNames = await getDisplayNameMap(request.source, request.sessionIds)
  const senderNameCache = new Map<string, string>()
  const successSessionIds: string[] = []
  const failedSessionIds: string[] = []
  const failedSessionErrors: Record<string, string> = {}
  const sessionOutputPaths: Record<string, string> = {}

  for (let index = 0; index < request.sessionIds.length; index++) {
    const sessionId = request.sessionIds[index]
    const sessionName = sessionNames.get(sessionId) || sessionId
    request.onProgress?.({
      current: index,
      total: request.sessionIds.length,
      currentSession: sessionName,
      currentSessionId: sessionId,
      phase: 'preparing'
    })

    try {
      throwIfMessageStreamControlRequested(request.control)
      const outputPath = reserveOutputPath(
        request.outputDir,
        `${sanitizeFileName(sessionName)}${request.options.fileNameSuffix || ''}`,
        extensionForFormat(request.options.format)
      )
      request.control?.recordCreatedFile?.(outputPath)
      const stream = createMessageStream({
        source: request.source,
        sessionId,
        cleanedMyWxid: request.cleanedMyWxid,
        dateRange: request.options.dateRange,
        senderUsername: request.options.senderUsername,
        control: request.control,
        decodeContent: decodeMessageContent
      })
      const getSenderName = async (row: MessageStreamRow) => {
        if (row.isSend) return '我'
        if (!sessionId.includes('@chatroom')) return sessionName
        if (senderNameCache.has(row.senderUsername)) return senderNameCache.get(row.senderUsername)!
        const nameMap = await getDisplayNameMap(request.source, [row.senderUsername])
        const name = nameMap.get(row.senderUsername) || row.senderUsername
        senderNameCache.set(row.senderUsername, name)
        return name
      }
      const sink = new FileSink(outputPath)
      const writerOptions = {
        sessionName,
        getSenderName,
        formatTimestamp: formatTimestamp,
        flushEvery: 256
      }
      const result = request.options.format === 'txt'
        ? await writeTxtStream(stream, sink, writerOptions)
        : request.options.format === 'html'
          ? await writeHtmlStream(stream, sink, writerOptions)
          : await writeChatLabJsonlStream(stream, sink, writerOptions)

      successSessionIds.push(sessionId)
      sessionOutputPaths[sessionId] = outputPath
      request.onProgress?.({
        current: index + 1,
        total: request.sessionIds.length,
        currentSession: sessionName,
        currentSessionId: sessionId,
        phase: 'complete',
        exportedMessages: result.messageCount,
        writtenFiles: 1
      })
    } catch (error) {
      const controlResult = buildControlResult(
        error,
        request.sessionIds.slice(index),
        successSessionIds,
        failedSessionIds,
        failedSessionErrors,
        sessionOutputPaths
      )
      if (controlResult) return controlResult
      failedSessionIds.push(sessionId)
      failedSessionErrors[sessionId] = error instanceof Error ? error.message : String(error)
    }
  }

  const successCount = successSessionIds.length
  const failCount = failedSessionIds.length
  return {
    success: successCount > 0 || failCount === 0,
    successCount,
    failCount,
    successSessionIds,
    failedSessionIds,
    failedSessionErrors,
    sessionOutputPaths,
    error: successCount === 0 && failCount > 0 ? Object.values(failedSessionErrors).slice(0, 3).join('；') : undefined
  }
}

function buildControlResult(
  error: unknown,
  pendingSessionIds: string[],
  successSessionIds: string[],
  failedSessionIds: string[],
  failedSessionErrors: Record<string, string>,
  sessionOutputPaths: Record<string, string>
): Record<string, unknown> | null {
  const stopped = isMessageStreamStopError(error)
  const paused = isMessageStreamPauseError(error)
  if (!stopped && !paused) return null

  return {
    success: true,
    successCount: successSessionIds.length,
    failCount: failedSessionIds.length,
    stopped: stopped || undefined,
    paused: paused || undefined,
    pendingSessionIds,
    successSessionIds,
    failedSessionIds,
    failedSessionErrors,
    sessionOutputPaths
  }
}

async function getDisplayNameMap(
  source: TypeScriptStreamingExportRequest['source'],
  usernames: string[]
): Promise<Map<string, string>> {
  const result = await source.getDisplayNames(usernames)
  const map = new Map<string, string>()
  for (const username of usernames) {
    map.set(username, result.success && result.map ? (result.map[username] || username) : username)
  }
  return map
}

function extensionForFormat(format: string): string {
  if (format === 'html') return '.html'
  if (format === 'chatlab-jsonl') return '.jsonl'
  return '.txt'
}

function reserveOutputPath(outputDir: string, baseName: string, ext: string): string {
  let candidate = path.join(outputDir, `${baseName}${ext}`)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${baseName} (${index})${ext}`)
    index++
  }
  return candidate
}

function sanitizeFileName(value: string): string {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '')
  return cleaned || 'session'
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function decodeMessageContent(row: any): string {
  const compressed = decodeMaybeEncoded(row?.compress_content ?? row?.compressContent)
  if (compressed) return compressed
  return decodeMaybeEncoded(row?.message_content ?? row?.messageContent ?? row?.content ?? '')
}

function decodeMaybeEncoded(raw: unknown): string {
  if (!raw) return ''
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (!value) return ''
  if (/^[0-9]+$/.test(value)) return value
  if (value.length > 16 && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    try {
      return decodeBinaryContent(Buffer.from(value, 'hex'))
    } catch {
      return ''
    }
  }
  if (value.length > 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
    try {
      return decodeBinaryContent(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  }
  return value
}

function decodeBinaryContent(data: Buffer): string {
  if (data.length >= 4 && data.readUInt32LE(0) === 0xFD2FB528) {
    try {
      const fzstd = require('fzstd')
      const decompressed = fzstd.decompress(data)
      return Buffer.from(decompressed).toString('utf-8')
    } catch {
      return ''
    }
  }
  return data.toString('utf-8').replace(/\uFFFD/g, '')
}
