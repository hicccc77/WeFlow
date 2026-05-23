import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import * as readline from 'readline'
import { canUseRustExportEngine } from './exportEngineRouter'
import {
  createMessageStream,
  isMessageStreamPauseError,
  isMessageStreamStopError,
  throwIfMessageStreamControlRequested,
  type MessageCursorSource,
  type MessageStreamControl,
  type MessageStreamRow
} from './messageStream'
import { parseRustExportEventLine, resolveRustExporterPath, type RustExportEvent } from './rustExportBridge'
import { exportService } from '../exportService'
import { extractReadableSystemMessageText } from '../systemMessageFormatter'

export interface RustStreamingExportOptions {
  format: 'txt' | 'html' | 'chatlab-jsonl' | 'weclone' | 'json' | string
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
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
}

export interface RustStreamingExportRequest {
  source: MessageCursorSource & {
    open: (accountDir: string, decryptKey: string) => Promise<boolean>
    getDisplayNames: (usernames: string[]) => Promise<{ success: boolean; map?: Record<string, string>; error?: string }>
    getContact?: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>
    getGroupNicknames?: (chatroomId: string) => Promise<{ success: boolean; nicknames?: Record<string, string>; error?: string }>
  }
  sessionIds: string[]
  outputDir: string
  options: RustStreamingExportOptions
  accountDir: string
  decryptKey: string
  cleanedMyWxid: string
  resourcesPath: string
  onProgress?: (progress: Record<string, unknown>) => void
  control?: MessageStreamControl & {
    recordCreatedFile?: (filePath: string) => void
    recordCreatedDir?: (dirPath: string) => void
  }
}

class RustWriterProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private resultPromise: Promise<Record<string, unknown>> | null = null
  private settleResult: ((value: Record<string, unknown>) => void) | null = null
  private rejectResult: ((error: unknown) => void) | null = null
  private stderr = ''

  constructor(
    private readonly executablePath: string,
    private readonly callbacks: {
      onProgress?: (progress: Record<string, unknown>) => void
      onCreatedFile?: (filePath: string) => void
      onCreatedDir?: (dirPath: string) => void
    }
  ) {}

  async start(request: Pick<RustStreamingExportRequest, 'outputDir' | 'options'>): Promise<void> {
    this.child = spawn(this.executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    this.resultPromise = new Promise((resolve, reject) => {
      this.settleResult = resolve
      this.rejectResult = reject
    })

    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let event: RustExportEvent
      try {
        event = parseRustExportEventLine(trimmed)
      } catch (error) {
        this.rejectResult?.(error)
        return
      }

      if (event.type === 'progress') {
        this.callbacks.onProgress?.((event.data ?? event) as Record<string, unknown>)
      } else if (event.type === 'createdFile') {
        this.callbacks.onCreatedFile?.(event.path)
      } else if (event.type === 'createdDir') {
        this.callbacks.onCreatedDir?.(event.path)
      } else if (event.type === 'result') {
        this.settleResult?.(event as Record<string, unknown>)
      } else if (event.type === 'error') {
        this.rejectResult?.(new Error(event.error))
      }
    })

    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk || '')
    })
    this.child.on('error', (error) => this.rejectResult?.(error))
    this.child.on('exit', (code) => {
      if (code === 0) return
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim().slice(0, 500)}` : ''
      this.rejectResult?.(new Error(`Rust writer exited before result (code ${code})${suffix}`))
    })

    await this.writeEvent({
      type: 'writerRequest',
      outputDir: request.outputDir,
      options: request.options
    })
  }

  async beginSession(sessionId: string, displayName: string, session?: Record<string, unknown>): Promise<void> {
    await this.writeEvent({ type: 'beginSession', sessionId, displayName, session })
  }

  async writeMessage(row: MessageStreamRow, senderName: string, jsonMessage?: Record<string, unknown>): Promise<void> {
    await this.writeEvent({ type: 'message', row, senderName, jsonMessage })
  }

  async endSession(): Promise<void> {
    await this.writeEvent({ type: 'endSession' })
  }

  async finish(): Promise<Record<string, unknown>> {
    await this.writeEvent({ type: 'finish' })
    this.child?.stdin.end()
    return await this.resultPromise!
  }

  cancel(): void {
    try {
      if (this.child && !this.child.stdin.destroyed) {
        this.child.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`)
      }
    } catch {}
    try {
      this.child?.kill()
    } catch {}
  }

  private async writeEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error('Rust writer is not running')
    }
    const line = `${JSON.stringify(event)}\n`
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
        this.child?.stdin.off('error', onError)
        this.child?.stdin.off('drain', onDrain)
      }
      this.child!.stdin.once('error', onError)
      if (!this.child!.stdin.write(line)) {
        this.child!.stdin.once('drain', onDrain)
      } else {
        cleanup()
        resolve()
      }
    })
  }
}

export function canUseRustStreamingExport(options: RustStreamingExportOptions): boolean {
  return canUseRustExportEngine(options)
}

export async function exportSessionsWithRustStreaming(request: RustStreamingExportRequest): Promise<Record<string, unknown>> {
  if (!canUseRustStreamingExport(request.options)) {
    return { success: false, successCount: 0, failCount: request.sessionIds.length, error: `Rust streaming exporter does not support format: ${request.options.format}` }
  }

  const opened = await request.source.open(request.accountDir, request.decryptKey)
  if (!opened) {
    return { success: false, successCount: 0, failCount: request.sessionIds.length, error: 'WCDB 打开失败' }
  }

  const executablePath = resolveRustExporterPath({ resourcesPath: request.resourcesPath })
  const writer = new RustWriterProcess(executablePath, {
    onProgress: request.onProgress,
    onCreatedFile: request.control?.recordCreatedFile,
    onCreatedDir: request.control?.recordCreatedDir
  })
  const successSessionIds: string[] = []
  let activeSessionIndex = 0

  try {
    await writer.start({ outputDir: request.outputDir, options: request.options })
    const sessionNames = await getDisplayNameMap(request.source, request.sessionIds)
    const senderNameCache = new Map<string, string>()

    for (let index = 0; index < request.sessionIds.length; index++) {
      activeSessionIndex = index
      throwIfMessageStreamControlRequested(request.control)
      const sessionId = request.sessionIds[index]
      const sessionName = sessionNames.get(sessionId) || sessionId
      request.onProgress?.({
        current: index,
        total: request.sessionIds.length,
        currentSession: sessionName,
        currentSessionId: sessionId,
        phase: 'preparing',
        phaseLabel: 'Rust 写入器准备导出'
      })
      const detailedJsonContext = request.options.format === 'json'
        ? await createDetailedJsonContext(request.source, sessionId, sessionName, request.cleanedMyWxid, request.options.displayNamePreference)
        : null
      await writer.beginSession(sessionId, sessionName, detailedJsonContext?.sessionPayload)

      const stream = createMessageStream({
        source: request.source,
        sessionId,
        cleanedMyWxid: request.cleanedMyWxid,
        dateRange: request.options.dateRange,
        senderUsername: request.options.senderUsername,
        control: request.control,
        decodeContent: decodeMessageContent
      })

      let exportedMessages = 0
      for await (const row of stream) {
        throwIfMessageStreamControlRequested(request.control)
        const senderName = await resolveSenderName(request.source, row, sessionId, sessionName, senderNameCache)
        const messageIndex = exportedMessages + 1
        const jsonMessage = detailedJsonContext
          ? await buildDetailedJsonMessage(row, messageIndex, detailedJsonContext)
          : undefined
        await writer.writeMessage(formatRustWriterRow(row), senderName, jsonMessage)
        exportedMessages = messageIndex
        if (exportedMessages % 1000 === 0) {
          request.onProgress?.({
            current: index,
            total: request.sessionIds.length,
            currentSession: sessionName,
            currentSessionId: sessionId,
            phase: 'exporting',
            exportedMessages
          })
        }
      }

      await writer.endSession()
      successSessionIds.push(sessionId)
      request.onProgress?.({
        current: index + 1,
        total: request.sessionIds.length,
        currentSession: sessionName,
        currentSessionId: sessionId,
        phase: 'complete',
        exportedMessages,
        writtenFiles: 1
      })
    }

    return await writer.finish()
  } catch (error) {
    writer.cancel()
    if (isMessageStreamStopError(error) || isMessageStreamPauseError(error)) {
      const stopped = isMessageStreamStopError(error)
      const paused = isMessageStreamPauseError(error)
      return {
        success: true,
        successCount: successSessionIds.length,
        failCount: 0,
        stopped: stopped || undefined,
        paused: paused || undefined,
        pendingSessionIds: request.sessionIds.slice(activeSessionIndex),
        successSessionIds,
        failedSessionIds: [],
        failedSessionErrors: {},
        sessionOutputPaths: {}
      }
    }
    throw error
  }
}

interface DetailedJsonContext {
  sessionId: string
  sessionName: string
  isGroup: boolean
  cleanedMyWxid: string
  displayNamePreference: 'group-nickname' | 'remark' | 'nickname'
  groupNicknamesMap: Map<string, string>
  contactCache: Map<string, Promise<{ success: boolean; contact?: any; error?: string }>>
  source: RustStreamingExportRequest['source']
  sessionPayload: Record<string, unknown>
}

async function createDetailedJsonContext(
  source: RustStreamingExportRequest['source'],
  sessionId: string,
  sessionName: string,
  cleanedMyWxid: string,
  displayNamePreference?: RustStreamingExportOptions['displayNamePreference']
): Promise<DetailedJsonContext> {
  const preference = displayNamePreference || 'remark'
  const isGroup = sessionId.includes('@chatroom')
  const contactCache = new Map<string, Promise<{ success: boolean; contact?: any; error?: string }>>()
  const groupNicknamesMap = isGroup ? await getGroupNicknamesMap(source, sessionId) : new Map<string, string>()
  const sessionContact = await getContactCached(source, contactCache, sessionId)
  const sessionNickname = getContactNickname(sessionContact.contact) || sessionName
  const sessionRemark = getContactRemark(sessionContact.contact)
  const sessionGroupNickname = isGroup
    ? callExportHelper<string>('resolveGroupNicknameByCandidates', groupNicknamesMap, [sessionId]) || ''
    : ''
  const sessionDisplayName = getPreferredDisplayName(sessionId, sessionNickname, sessionRemark, sessionGroupNickname, preference)

  return {
    sessionId,
    sessionName,
    isGroup,
    cleanedMyWxid,
    displayNamePreference: preference,
    groupNicknamesMap,
    contactCache,
    source,
    sessionPayload: {
      wxid: sessionId,
      nickname: sessionNickname,
      remark: sessionRemark,
      displayName: sessionDisplayName,
      type: isGroup ? '群聊' : '私聊',
      lastTimestamp: null,
      messageCount: 0
    }
  }
}

async function buildDetailedJsonMessage(
  row: MessageStreamRow,
  localId: number,
  context: DetailedJsonContext
): Promise<Record<string, unknown>> {
  const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(row.content || '')
  const source = sourceMatch ? sourceMatch[0] : ''
  let content: string | null = parseMessageContent(row, context)
  if (callExportHelper<boolean>('isReadableSystemMessage', row.localType, row.content)) {
    content = callExportHelper<string | null>('extractReadableSystemMessageText', row.content) || content
  }

  const quotedReplyDisplay = await resolveQuotedReplyDisplay(row, context)
  if (quotedReplyDisplay) {
    content = callExportHelper<string>('buildQuotedReplyText', quotedReplyDisplay) || content
  }
  const appendedLinkContent = quotedReplyDisplay
    ? null
    : callExportHelper<string | null>('formatLinkCardExportText', row.content, row.localType, 'append-url')
  if (appendedLinkContent) {
    content = appendedLinkContent
  }

  const senderDisplayName = await resolveDetailedSenderDisplayName(row, context)
  const message: Record<string, unknown> = {
    localId,
    createTime: row.createTime,
    formattedTime: formatTimestamp(row.createTime),
    type: getMessageTypeName(row.localType, row.content),
    localType: row.localType,
    content,
    isSend: row.isSend ? 1 : 0,
    senderUsername: row.senderUsername,
    senderDisplayName,
    source,
    senderAvatarKey: row.senderUsername
  }

  if (row.localType === 47) {
    if (row.emojiMd5) message.emojiMd5 = row.emojiMd5
    if (row.emojiCdnUrl) message.emojiCdnUrl = row.emojiCdnUrl
    if (row.emojiCaption) message.emojiCaption = row.emojiCaption
  }

  const platformMessageId = normalizeUnsignedIntToken(row.serverIdRaw ?? row.serverId)
  if (platformMessageId !== '0') message.platformMessageId = platformMessageId

  const replyToMessageId = callExportHelper<string | undefined>('getExportReplyToMessageId', row.content)
  if (replyToMessageId) message.replyToMessageId = replyToMessageId

  const appMsgMeta = callExportHelper<Record<string, unknown> | null>('extractArkmeAppMessageMeta', row.content, row.localType)
  if (appMsgMeta && (appMsgMeta.appMsgKind === 'quote' || appMsgMeta.appMsgKind === 'link')) {
    Object.assign(message, appMsgMeta)
  }
  if (quotedReplyDisplay) {
    if (quotedReplyDisplay.quotedSender) message.quotedSender = quotedReplyDisplay.quotedSender
    if (quotedReplyDisplay.quotedPreview) message.quotedContent = quotedReplyDisplay.quotedPreview
  }

  if (typeof message.content === 'string' && callExportHelper<boolean>('isTransferExportContent', message.content) && row.content) {
    const transferDesc = await resolveTransferDesc(row.content, context)
    if (transferDesc) {
      message.content = callExportHelper<string>('appendTransferDesc', message.content, transferDesc) || message.content
    }
  }

  if (row.localType === 48) {
    if (row.locationLat != null) message.locationLat = row.locationLat
    if (row.locationLng != null) message.locationLng = row.locationLng
    if (row.locationPoiname) message.locationPoiname = row.locationPoiname
    if (row.locationLabel) message.locationLabel = row.locationLabel
  }

  return message
}

function parseMessageContent(row: MessageStreamRow, context: DetailedJsonContext): string | null {
  const parsed = callExportHelper<string | null>(
    'parseMessageContent',
    row.content,
    row.localType,
    undefined,
    undefined,
    context.cleanedMyWxid,
    row.senderUsername,
    row.isSend,
    row.emojiCaption
  )
  return parsed ?? row.content ?? ''
}

async function resolveQuotedReplyDisplay(row: MessageStreamRow, context: DetailedJsonContext): Promise<any | null> {
  if (!row.content || !/(<refermsg>|&lt;refermsg&gt;|<appmsg|&lt;appmsg)/i.test(row.content)) return null
  return await callExportHelperAsync<any | null>('resolveQuotedReplyDisplayWithNames', {
    content: row.content,
    isGroup: context.isGroup,
    displayNamePreference: context.displayNamePreference,
    getContact: (username: string) => getContactCached(context.source, context.contactCache, username),
    groupNicknamesMap: context.groupNicknamesMap,
    cleanedMyWxid: context.cleanedMyWxid,
    rawMyWxid: context.cleanedMyWxid,
    myDisplayName: context.cleanedMyWxid
  })
}

async function resolveTransferDesc(content: string, context: DetailedJsonContext): Promise<string> {
  return await callExportHelperAsync<string>('resolveTransferDesc', content, context.cleanedMyWxid, context.groupNicknamesMap, async (username: string) => {
    const contactResult = await getContactCached(context.source, context.contactCache, username)
    return getContactRemark(contactResult.contact) || getContactNickname(contactResult.contact) || username
  }) || ''
}

async function resolveDetailedSenderDisplayName(row: MessageStreamRow, context: DetailedJsonContext): Promise<string> {
  const senderWxid = row.senderUsername || ''
  const contactResult = senderWxid
    ? await getContactCached(context.source, context.contactCache, senderWxid)
    : { success: false as const }
  const senderNickname = getContactNickname(contactResult.contact) || senderWxid
  const senderRemark = getContactRemark(contactResult.contact)
  const senderGroupNickname = context.isGroup
    ? callExportHelper<string>('resolveGroupNicknameByCandidates', context.groupNicknamesMap, [senderWxid]) || ''
    : ''
  return getPreferredDisplayName(senderWxid, senderNickname, senderRemark, senderGroupNickname, context.displayNamePreference)
}

function getPreferredDisplayName(
  wxid: string,
  nickname: string,
  remark: string,
  groupNickname: string,
  preference: 'group-nickname' | 'remark' | 'nickname'
): string {
  return callExportHelper<string>('getPreferredDisplayName', wxid, nickname, remark, groupNickname, preference)
    || groupNickname
    || remark
    || nickname
    || wxid
}

async function getContactCached(
  source: RustStreamingExportRequest['source'],
  cache: Map<string, Promise<{ success: boolean; contact?: any; error?: string }>>,
  username: string
): Promise<{ success: boolean; contact?: any; error?: string }> {
  const normalized = String(username || '').trim()
  if (!normalized || !source.getContact) return { success: false }
  const cached = cache.get(normalized)
  if (cached) return await cached
  const pending = source.getContact(normalized).catch((error) => ({ success: false as const, error: String(error) }))
  cache.set(normalized, pending)
  return await pending
}

async function getGroupNicknamesMap(
  source: RustStreamingExportRequest['source'],
  sessionId: string
): Promise<Map<string, string>> {
  if (!source.getGroupNicknames) return new Map()
  try {
    const result = await source.getGroupNicknames(sessionId)
    if (!result.success || !result.nicknames) return new Map()
    return new Map(Object.entries(result.nicknames).map(([key, value]) => [key, String(value || '')]).filter(([, value]) => value))
  } catch {
    return new Map()
  }
}

function getContactNickname(contact: any): string {
  return String(contact?.nickName || contact?.nick_name || contact?.nickname || contact?.displayName || '').trim()
}

function getContactRemark(contact: any): string {
  return String(contact?.remark || '').trim()
}

function getMessageTypeName(localType: number, content: string): string {
  return callExportHelper<string>('getMessageTypeName', localType, content) || fallbackMessageTypeName(localType)
}

function formatTimestamp(timestamp: number): string {
  return callExportHelper<string>('formatTimestamp', timestamp) || fallbackFormatTimestamp(timestamp)
}

function normalizeUnsignedIntToken(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return '0'
  if (/^\d+$/.test(text)) return text.replace(/^0+(?=\d)/, '') || '0'
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0) return '0'
  return String(Math.floor(parsed))
}

function fallbackMessageTypeName(localType: number): string {
  const names: Record<number, string> = {
    1: '文本消息',
    3: '图片消息',
    34: '语音消息',
    42: '名片消息',
    43: '视频消息',
    47: '动画表情',
    48: '位置消息',
    49: '链接消息',
    50: '通话消息',
    10000: '系统消息',
    244813135921: '引用消息'
  }
  return names[localType] || '其他消息'
}

function fallbackFormatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function callExportHelper<T>(name: string, ...args: any[]): T | undefined {
  const helper = (exportService as any)[name]
  if (typeof helper !== 'function') return undefined
  try {
    return helper.apply(exportService, args) as T
  } catch {
    return undefined
  }
}

async function callExportHelperAsync<T>(name: string, ...args: any[]): Promise<T | undefined> {
  const helper = (exportService as any)[name]
  if (typeof helper !== 'function') return undefined
  try {
    return await helper.apply(exportService, args) as T
  } catch {
    return undefined
  }
}

async function resolveSenderName(
  source: RustStreamingExportRequest['source'],
  row: MessageStreamRow,
  sessionId: string,
  sessionName: string,
  senderNameCache: Map<string, string>
): Promise<string> {
  if (row.isSend) return '我'
  if (!sessionId.includes('@chatroom')) return sessionName
  if (senderNameCache.has(row.senderUsername)) return senderNameCache.get(row.senderUsername)!
  const nameMap = await getDisplayNameMap(source, [row.senderUsername])
  const name = nameMap.get(row.senderUsername) || row.senderUsername
  senderNameCache.set(row.senderUsername, name)
  return name
}

function formatRustWriterRow(row: MessageStreamRow): MessageStreamRow {
  if (row.localType !== 10000 && !/<sysmsg\b/i.test(row.content || '')) return row
  const content = extractReadableSystemMessageText(row.content) || row.content
  return content === row.content ? row : { ...row, content }
}

async function getDisplayNameMap(
  source: RustStreamingExportRequest['source'],
  usernames: string[]
): Promise<Map<string, string>> {
  const result = await source.getDisplayNames(usernames)
  const map = new Map<string, string>()
  for (const username of usernames) {
    map.set(username, result.success && result.map ? (result.map[username] || username) : username)
  }
  return map
}

function decodeMessageContent(row: any): string {
  const compressed = decodeMaybeEncoded(row?.compress_content ?? row?.compressContent)
  if (compressed) return compressed
  return decodeMaybeEncoded(row?.message_content ?? row?.messageContent ?? row?.content ?? '')
}

function decodeMaybeEncoded(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return ''
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
