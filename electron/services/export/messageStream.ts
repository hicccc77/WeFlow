export interface MessageStreamRow {
  localId: number
  serverId: number
  serverIdRaw?: string
  createTime: number
  localType: number
  content: string
  senderUsername: string
  isSend: boolean
  emojiMd5?: string
  emojiCdnUrl?: string
  emojiCaption?: string
  locationLat?: number
  locationLng?: number
  locationPoiname?: string
  locationLabel?: string
}

export interface MessageCursorSource {
  openMessageCursor: (
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ) => Promise<{ success: boolean; cursor?: number; error?: string }>
  openMessageCursorLite?: (
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ) => Promise<{ success: boolean; cursor?: number; error?: string }>
  fetchMessageBatch: (cursor: number) => Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }>
  closeMessageCursor: (cursor: number) => Promise<unknown>
}

export interface MessageStreamControl {
  shouldStop?: () => boolean
  shouldPause?: () => boolean
}

export const MESSAGE_STREAM_STOP_CODE = 'WEFLOW_EXPORT_STOP_REQUESTED'
export const MESSAGE_STREAM_PAUSE_CODE = 'WEFLOW_EXPORT_PAUSE_REQUESTED'

export interface MessageStreamOptions {
  source: MessageCursorSource
  sessionId: string
  cleanedMyWxid: string
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  batchSize?: number
  ascending?: boolean
  useLiteCursor?: boolean
  control?: MessageStreamControl
  decodeContent?: (row: any, localType: number) => string
}

export function normalizeTimestampSeconds(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  let normalized = Math.floor(raw)
  while (normalized > 10000000000) {
    normalized = Math.floor(normalized / 1000)
  }
  return normalized
}

export function normalizeMessageStreamRow(
  row: any,
  options: Pick<MessageStreamOptions, 'sessionId' | 'cleanedMyWxid' | 'decodeContent'>
): MessageStreamRow {
  const localType = getIntFromRow(row, ['local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'], 1)
  const createTime = normalizeTimestampSeconds(getRowField(row, ['create_time', 'createTime', 'timestamp', 'msgCreateTime', 'WCDB_CT_create_time']))
  const localId = getIntFromRow(row, [
    'local_id', 'localId', 'LocalId',
    'msg_local_id', 'msgLocalId', 'MsgLocalId',
    'msg_id', 'msgId', 'MsgId', 'id',
    'WCDB_CT_local_id'
  ], 0)
  const rawServerIdValue = getRowField(row, [
    'server_id', 'serverId', 'ServerId',
    'msg_server_id', 'msgServerId', 'MsgServerId',
    'svr_id', 'svrId', 'msg_svr_id', 'msgSvrId', 'MsgSvrId',
    'WCDB_CT_server_id'
  ])
  const serverIdRaw = normalizeUnsignedIntToken(rawServerIdValue)
  const serverId = getIntFromRow(row, [
    'server_id', 'serverId', 'ServerId',
    'msg_server_id', 'msgServerId', 'MsgServerId',
    'svr_id', 'svrId', 'msg_svr_id', 'msgSvrId', 'MsgSvrId',
    'WCDB_CT_server_id'
  ], 0)
  const isSend = Number.parseInt(String(row?.computed_is_send ?? row?.is_send ?? row?.isSend ?? '0'), 10) === 1
  const senderUsername = isSend
    ? options.cleanedMyWxid
    : String(row?.sender_username || row?.senderUsername || options.sessionId || '').trim()
  const content = options.decodeContent
    ? options.decodeContent(row, localType)
    : String(row?.content || row?.message_content || row?.messageContent || '')
  const emojiMd5 = getStringFromRow(row, ['emoji_md5', 'emojiMd5'])
  const emojiCdnUrl = getStringFromRow(row, ['emoji_cdn_url', 'emojiCdnUrl'])
  const emojiCaption = getStringFromRow(row, ['emoji_caption', 'emojiCaption'])
  const locationLat = getNumberFromRow(row, ['location_lat', 'locationLat'])
  const locationLng = getNumberFromRow(row, ['location_lng', 'locationLng'])
  const locationPoiname = getStringFromRow(row, ['location_poiname', 'locationPoiname'])
  const locationLabel = getStringFromRow(row, ['location_label', 'locationLabel'])

  const normalized: MessageStreamRow = {
    localId,
    serverId,
    serverIdRaw: serverIdRaw !== '0' ? serverIdRaw : undefined,
    createTime,
    localType,
    content,
    senderUsername,
    isSend
  }
  if (emojiMd5) normalized.emojiMd5 = emojiMd5
  if (emojiCdnUrl) normalized.emojiCdnUrl = emojiCdnUrl
  if (emojiCaption) normalized.emojiCaption = emojiCaption
  if (typeof locationLat === 'number') normalized.locationLat = locationLat
  if (typeof locationLng === 'number') normalized.locationLng = locationLng
  if (locationPoiname) normalized.locationPoiname = locationPoiname
  if (locationLabel) normalized.locationLabel = locationLabel
  return normalized
}

export async function* createMessageStream(options: MessageStreamOptions): AsyncGenerator<MessageStreamRow> {
  const batchSize = Math.max(1, Math.floor(options.batchSize || 2000))
  const ascending = options.ascending !== false
  const range = normalizeDateRange(options.dateRange)
  const begin = range?.start || 0
  const end = range?.end || 0
  const useLite = options.useLiteCursor === true && Boolean(options.source.openMessageCursorLite)
  throwIfMessageStreamControlRequested(options.control)
  const opened = useLite
    ? await options.source.openMessageCursorLite!(options.sessionId, batchSize, ascending, begin, end)
    : await options.source.openMessageCursor(options.sessionId, batchSize, ascending, begin, end)
  if (!opened.success || !opened.cursor) {
    throw new Error(opened.error || 'open message cursor failed')
  }

  try {
    let hasMore = true
    while (hasMore) {
      throwIfMessageStreamControlRequested(options.control)
      const batch = await options.source.fetchMessageBatch(opened.cursor)
      if (!batch.success) {
        throw new Error(batch.error || 'fetch message batch failed')
      }

      for (const rawRow of batch.rows || []) {
        throwIfMessageStreamControlRequested(options.control)
        const row = normalizeMessageStreamRow(rawRow, options)
        if (range) {
          if (row.createTime > 0 && range.start > 0 && row.createTime < range.start) continue
          if (row.createTime > 0 && range.end > 0 && row.createTime > range.end) continue
        }
        if (options.senderUsername && row.senderUsername !== options.senderUsername) continue
        yield row
      }

      hasMore = batch.hasMore === true
    }
  } finally {
    await options.source.closeMessageCursor(opened.cursor)
  }
}

function normalizeDateRange(dateRange?: { start: number; end: number } | null): { start: number; end: number } | null {
  if (!dateRange) return null
  let start = normalizeTimestampSeconds(dateRange.start)
  let end = normalizeTimestampSeconds(dateRange.end)
  if (start > 0 && end > 0 && start > end) {
    const tmp = start
    start = end
    end = tmp
  }
  if (start <= 0 && end <= 0) return null
  return { start, end }
}

export function throwIfMessageStreamControlRequested(control?: MessageStreamControl): void {
  if (control?.shouldStop?.()) throw createMessageStreamControlError('stop')
  if (control?.shouldPause?.()) throw createMessageStreamControlError('pause')
}

export function isMessageStreamStopError(error: unknown): boolean {
  return hasMessageStreamControlError(error, MESSAGE_STREAM_STOP_CODE, '导出任务已停止')
}

export function isMessageStreamPauseError(error: unknown): boolean {
  return hasMessageStreamControlError(error, MESSAGE_STREAM_PAUSE_CODE, '导出任务已暂停')
}

function createMessageStreamControlError(type: 'stop' | 'pause'): Error {
  const error = new Error(type === 'stop' ? '导出任务已停止' : '导出任务已暂停')
  ;(error as Error & { code?: string }).code = type === 'stop'
    ? MESSAGE_STREAM_STOP_CODE
    : MESSAGE_STREAM_PAUSE_CODE
  return error
}

function hasMessageStreamControlError(error: unknown, code: string, message: string): boolean {
  if (!error) return false
  if (typeof error === 'string') return error.includes(code) || error.includes(message)
  if (error instanceof Error) {
    const errorCode = (error as Error & { code?: string }).code
    return errorCode === code || error.message.includes(code) || error.message.includes(message)
  }
  return false
}

function getRowField(row: any, names: string[]): unknown {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null) return row[name]
  }
  return undefined
}

function getIntFromRow(row: any, names: string[], fallback: number): number {
  const value = getRowField(row, names)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.floor(parsed)
}

function getNumberFromRow(row: any, names: string[]): number | undefined {
  const value = getRowField(row, names)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function getStringFromRow(row: any, names: string[]): string | undefined {
  const value = getRowField(row, names)
  const text = String(value ?? '').trim()
  return text || undefined
}

function normalizeUnsignedIntToken(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return '0'
  if (/^\d+$/.test(text)) return text.replace(/^0+(?=\d)/, '') || '0'
  const numberValue = Number(text)
  if (!Number.isFinite(numberValue) || numberValue < 0) return '0'
  return String(Math.floor(numberValue))
}
