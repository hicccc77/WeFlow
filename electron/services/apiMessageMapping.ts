import { basename, extname } from 'path'
import * as fzstd from 'fzstd'
import type { Message } from './chatService'

/**
 * apiMessageMapping —— HTTP API 非媒体消息的「行 -> Message」纯函数映射管线。
 *
 * 这是 chatService.mapRowsToMessagesLiteForApi 及其完整调用闭包（约 23 个纯辅助函数）的
 * 忠实拷贝，去掉了对 `this` / configService / wcdbService / 原生层的依赖，唯一外部输入是
 * 调用方传入的 `myWxid`。目的是让这套 CPU 密集（hex/zstd 解压、字符清洗、key 构造）的解码
 * 映射可以脱离主进程，运行在 worker 线程（见 apiMessageWorker.ts / apiMessageMapperPool.ts），
 * 从而既不卡住 WeFlow 本体，又能多线程并行提速。
 *
 * 重要：这里的逻辑必须与 chatService 中对应的私有方法保持一致。两边都是「逐行独立、无跨行状态」
 * 的纯映射，因此分片/并行处理与一次性处理输出完全一致。若将来修改了 chatService 的任何解码/
 * 映射细节，请同步修改本文件（反之亦然）。
 */

function encodeMessageKeySegment(value: unknown): string {
  const normalized = String(value ?? '').trim()
  return encodeURIComponent(normalized)
}

function getMessageSourceInfo(row: Record<string, any>): { dbName?: string; tableName?: string; dbPath?: string } {
  const dbPath = String(row._db_path || row.db_path || '').trim()
  const explicitDbName = String(row.db_name || '').trim()
  const tableName = String(row.table_name || '').trim()
  const dbName = explicitDbName || (dbPath ? basename(dbPath, extname(dbPath)) : '')
  return {
    dbName: dbName || undefined,
    tableName: tableName || undefined,
    dbPath: dbPath || undefined
  }
}

function buildMessageKey(input: {
  localId: number
  serverId: number
  createTime: number
  sortSeq: number
  senderUsername?: string | null
  localType: number
  dbName?: string
  tableName?: string
  dbPath?: string
}): string {
  const localId = Number.isFinite(input.localId) ? Math.max(0, Math.floor(input.localId)) : 0
  const serverId = Number.isFinite(input.serverId) ? Math.max(0, Math.floor(input.serverId)) : 0
  const createTime = Number.isFinite(input.createTime) ? Math.max(0, Math.floor(input.createTime)) : 0
  const sortSeq = Number.isFinite(input.sortSeq) ? Math.max(0, Math.floor(input.sortSeq)) : 0
  const localType = Number.isFinite(input.localType) ? Math.floor(input.localType) : 0
  const senderUsername = encodeMessageKeySegment(input.senderUsername || '')
  const dbPath = String(input.dbPath || '').trim()
  const dbName = String(input.dbName || '').trim() || (input.dbPath ? basename(input.dbPath, extname(input.dbPath)) : '')
  const tableName = String(input.tableName || '').trim()
  const sourceScope = dbPath || dbName

  if (localId > 0 && sourceScope && tableName) {
    return `${encodeMessageKeySegment(sourceScope)}:${encodeMessageKeySegment(tableName)}:${localId}`
  }

  if (localId > 0 && sourceScope) {
    // 当底层未返回 table_name 时，避免使用 db:_:localId（会误并同库不同表的消息）。
    return `local:${encodeMessageKeySegment(sourceScope)}:${localId}:${createTime}:${sortSeq}:${senderUsername}:${localType}`
  }

  if (serverId > 0) {
    const scopedServer = sourceScope ? `${encodeMessageKeySegment(sourceScope)}:${serverId}` : String(serverId)
    return `server:${scopedServer}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
  }

  return `fallback:${encodeMessageKeySegment(sourceScope)}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
}

function getRowField(row: Record<string, any>, keys: string[]): any {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  const lowerMap = new Map<string, string>()
  for (const actual of Object.keys(row)) {
    lowerMap.set(actual.toLowerCase(), actual)
  }
  for (const key of keys) {
    const actual = lowerMap.get(key.toLowerCase())
    if (actual && row[actual] !== undefined && row[actual] !== null) {
      return row[actual]
    }
  }
  return undefined
}

function coerceRowNumber(raw: any): number {
  if (raw === undefined || raw === null) return NaN
  if (typeof raw === 'number') return raw
  if (typeof raw === 'bigint') return Number(raw)
  if (Buffer.isBuffer(raw)) {
    return coerceRowNumber(raw.toString('utf-8'))
  }
  if (raw instanceof Uint8Array) {
    return coerceRowNumber(Buffer.from(raw).toString('utf-8'))
  }
  if (Array.isArray(raw)) {
    return coerceRowNumber(Buffer.from(raw).toString('utf-8'))
  }
  if (typeof raw === 'object') {
    if ('value' in raw) return coerceRowNumber(raw.value)
    if ('intValue' in raw) return coerceRowNumber(raw.intValue)
    if ('low' in raw && 'high' in raw) {
      try {
        const low = BigInt(raw.low >>> 0)
        const high = BigInt(raw.high >>> 0)
        return Number((high << 32n) + low)
      } catch {
        return NaN
      }
    }
    const text = raw.toString ? String(raw) : ''
    if (text && text !== '[object Object]') {
      return coerceRowNumber(text)
    }
    return NaN
  }
  const text = String(raw).trim()
  if (!text) return NaN
  if (/^[+-]?\d+$/.test(text)) {
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  if (/^[+-]?\d+\.\d+$/.test(text)) {
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

function getRowInt(row: Record<string, any>, keys: string[], fallback = 0): number {
  const raw = getRowField(row, keys)
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = coerceRowNumber(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseCompactDateTimeDigitsToSeconds(raw: string): number {
  const text = String(raw || '').trim()
  if (!/^\d{8}(?:\d{4}(?:\d{2})?)?$/.test(text)) return 0

  const year = Number.parseInt(text.slice(0, 4), 10)
  const month = Number.parseInt(text.slice(4, 6), 10)
  const day = Number.parseInt(text.slice(6, 8), 10)
  const hour = text.length >= 12 ? Number.parseInt(text.slice(8, 10), 10) : 0
  const minute = text.length >= 12 ? Number.parseInt(text.slice(10, 12), 10) : 0
  const second = text.length >= 14 ? Number.parseInt(text.slice(12, 14), 10) : 0

  if (!Number.isFinite(year) || year < 1990 || year > 2200) return 0
  if (!Number.isFinite(month) || month < 1 || month > 12) return 0
  if (!Number.isFinite(day) || day < 1 || day > 31) return 0
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return 0
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return 0
  if (!Number.isFinite(second) || second < 0 || second > 59) return 0

  const dt = new Date(year, month - 1, day, hour, minute, second)
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day ||
    dt.getHours() !== hour ||
    dt.getMinutes() !== minute ||
    dt.getSeconds() !== second
  ) {
    return 0
  }
  const ts = Math.floor(dt.getTime() / 1000)
  return Number.isFinite(ts) && ts > 0 ? ts : 0
}

function parseDateTimeTextToSeconds(raw: unknown): number {
  const text = String(raw ?? '').trim()
  if (!text) return 0

  const compactDigits = parseCompactDateTimeDigitsToSeconds(text)
  if (compactDigits > 0) return compactDigits

  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text)
    const seconds = Math.floor(parsed / 1000)
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }

  const normalized = text.replace('T', ' ').replace(/\.\d+$/, '').replace(/\//g, '-')
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (!match) return 0

  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const hour = Number.parseInt(match[4] || '0', 10)
  const minute = Number.parseInt(match[5] || '0', 10)
  const second = Number.parseInt(match[6] || '0', 10)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return 0
  const dt = new Date(year, month - 1, day, hour, minute, second)
  const ts = Math.floor(dt.getTime() / 1000)
  return Number.isFinite(ts) && ts > 0 ? ts : 0
}

function normalizeTimestampLikeToSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0
  const text = String(raw ?? '').trim()
  if (!text) return 0

  const compactDigits = parseCompactDateTimeDigitsToSeconds(text)
  if (compactDigits > 0) return compactDigits

  const parsed = coerceRowNumber(raw)
  if (Number.isFinite(parsed) && parsed > 0) {
    let normalized = Math.floor(parsed)
    while (normalized > 10000000000) {
      normalized = Math.floor(normalized / 1000)
    }
    return normalized
  }

  return parseDateTimeTextToSeconds(text)
}

function getRowTimestampSeconds(row: Record<string, any>, keys: string[], fallback = 0): number {
  const raw = getRowField(row, keys)
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = normalizeTimestampLikeToSeconds(raw)
  return parsed > 0 ? parsed : fallback
}

function normalizeUnsignedIntegerToken(raw: any): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined

  if (typeof raw === 'bigint') {
    return raw >= 0n ? raw.toString() : '0'
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined
    return String(Math.max(0, Math.floor(raw)))
  }

  if (Buffer.isBuffer(raw)) {
    return normalizeUnsignedIntegerToken(raw.toString('utf-8').trim())
  }
  if (raw instanceof Uint8Array) {
    return normalizeUnsignedIntegerToken(Buffer.from(raw).toString('utf-8').trim())
  }
  if (Array.isArray(raw)) {
    return normalizeUnsignedIntegerToken(Buffer.from(raw).toString('utf-8').trim())
  }

  if (typeof raw === 'object') {
    if ('value' in raw) return normalizeUnsignedIntegerToken(raw.value)
    if ('intValue' in raw) return normalizeUnsignedIntegerToken(raw.intValue)
    if ('low' in raw && 'high' in raw) {
      try {
        const low = BigInt(raw.low >>> 0)
        const high = BigInt(raw.high >>> 0)
        const value = (high << 32n) + low
        return value >= 0n ? value.toString() : '0'
      } catch {
        return undefined
      }
    }
    const text = raw.toString ? String(raw).trim() : ''
    if (text && text !== '[object Object]') {
      return normalizeUnsignedIntegerToken(text)
    }
    return undefined
  }

  const text = String(raw).trim()
  if (!text) return undefined
  if (/^\d+$/.test(text)) {
    return text.replace(/^0+(?=\d)/, '') || '0'
  }
  if (/^[+-]?\d+$/.test(text)) {
    try {
      const value = BigInt(text)
      return value >= 0n ? value.toString() : '0'
    } catch {
      return undefined
    }
  }

  const parsed = Number(text)
  if (Number.isFinite(parsed)) {
    return String(Math.max(0, Math.floor(parsed)))
  }
  return undefined
}

function cleanAccountDirName(dirName: string): string {
  const trimmed = dirName.trim()
  if (!trimmed) return trimmed

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    if (match) return match[1]
    return trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  const cleaned = suffixMatch ? suffixMatch[1] : trimmed

  return cleaned
}

function buildIdentityKeys(raw: string): string[] {
  const value = String(raw || '').trim()
  if (!value) return []
  const lowerRaw = value.toLowerCase()
  const cleaned = cleanAccountDirName(value).toLowerCase()
  if (cleaned && cleaned !== lowerRaw) {
    return [cleaned, lowerRaw]
  }
  return [lowerRaw]
}

/**
 * 判断消息是否由「我」发出。与 chatService.resolveMessageIsSend 等价，但 myWxid 由参数传入
 * （chatService 版本从 configService.getMyWxidCleaned() 读取）。
 */
function resolveMessageIsSend(
  rawIsSend: number | null,
  senderUsername: string | null | undefined,
  myWxidRaw: string
): { isSend: number | null; selfMatched: boolean; correctedBySelfIdentity: boolean } {
  const normalizedRawIsSend = Number.isFinite(rawIsSend as number) ? rawIsSend : null
  const senderKeys = buildIdentityKeys(String(senderUsername || ''))
  if (senderKeys.length === 0) {
    return {
      isSend: normalizedRawIsSend,
      selfMatched: false,
      correctedBySelfIdentity: false
    }
  }

  const myWxid = String(myWxidRaw || '').trim()
  const selfKeys = buildIdentityKeys(myWxid)
  if (selfKeys.length === 0) {
    return {
      isSend: normalizedRawIsSend,
      selfMatched: false,
      correctedBySelfIdentity: false
    }
  }

  const selfMatched = senderKeys.some(senderKey =>
    selfKeys.some(selfKey =>
      senderKey === selfKey ||
      senderKey.startsWith(selfKey + '_') ||
      selfKey.startsWith(senderKey + '_')
    )
  )

  if (selfMatched && normalizedRawIsSend !== 1) {
    return {
      isSend: 1,
      selfMatched: true,
      correctedBySelfIdentity: true
    }
  }

  if (normalizedRawIsSend === null) {
    return {
      isSend: selfMatched ? 1 : 0,
      selfMatched,
      correctedBySelfIdentity: false
    }
  }

  return {
    isSend: normalizedRawIsSend,
    selfMatched,
    correctedBySelfIdentity: false
  }
}

function decodeHtmlEntities(content: string): string {
  return content
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function cleanUtf16(input: string): string {
  if (!input) return input
  try {
    const cleaned = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    const codeUnits = cleaned.split('').map((c) => c.charCodeAt(0))
    const validUnits: number[] = []
    for (let i = 0; i < codeUnits.length; i += 1) {
      const unit = codeUnits[i]
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (i + 1 < codeUnits.length) {
          const nextUnit = codeUnits[i + 1]
          if (nextUnit >= 0xdc00 && nextUnit <= 0xdfff) {
            validUnits.push(unit, nextUnit)
            i += 1
            continue
          }
        }
        continue
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        continue
      }
      validUnits.push(unit)
    }
    return String.fromCharCode(...validUnits)
  } catch {
    return input.replace(/[^ -~一-鿿　-〿]/g, '')
  }
}

function extractSenderUsernameFromContent(content: string): string | null {
  if (!content) return null

  const normalized = cleanUtf16(decodeHtmlEntities(String(content)))
  const match = /^\s*([a-zA-Z0-9_@-]{4,}):(?!\/\/)\s*(?:\r?\n|<br\s*\/?>)/i.exec(normalized)
  if (!match?.[1]) return null

  const candidate = match[1].trim()
  return candidate || null
}

function compactEncodedPayload(raw: string): string {
  return String(raw || '').replace(/\s+/g, '').trim()
}

function looksLikeHex(s: string): boolean {
  const compact = compactEncodedPayload(s)
  if (compact.length % 2 !== 0) return false
  return /^[0-9a-fA-F]+$/.test(compact)
}

function looksLikeBase64(s: string): boolean {
  const compact = compactEncodedPayload(s)
  if (compact.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/=]+$/.test(compact)
}

function decodeBinaryContent(data: Buffer, fallbackValue?: string): string {
  if (data.length === 0) return ''

  try {
    // 检查是否是 zstd 压缩数据 (magic number: 0xFD2FB528)
    if (data.length >= 4) {
      const magicLE = data.readUInt32LE(0)
      const magicBE = data.readUInt32BE(0)
      if (magicLE === 0xFD2FB528 || magicBE === 0xFD2FB528) {
        // zstd 压缩，需要解压
        try {
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        } catch (e) {
          console.error('zstd 解压失败:', e)
        }
      }
    }

    // 尝试直接 UTF-8 解码
    const decoded = data.toString('utf-8')
    // 检查是否有太多替换字符
    const replacementCount = (decoded.match(/�/g) || []).length
    if (replacementCount < decoded.length * 0.2) {
      return decoded.replace(/�/g, '')
    }

    // 如果提供了 fallbackValue，且解码结果看起来像二进制垃圾，则返回 fallbackValue
    if (fallbackValue && replacementCount > 0) {
      return fallbackValue
    }

    // 尝试 latin1 解码
    return data.toString('latin1')
  } catch {
    return fallbackValue || ''
  }
}

function decodeMaybeCompressed(raw: any): string {
  if (!raw) return ''

  // 如果是 Buffer/Uint8Array
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return decodeBinaryContent(Buffer.from(raw), String(raw))
  }

  // 如果是字符串
  if (typeof raw === 'string') {
    if (raw.length === 0) return ''
    const compactRaw = compactEncodedPayload(raw)

    // 检查是否是 hex 编码
    if (compactRaw.length > 16 && looksLikeHex(compactRaw)) {
      const bytes = Buffer.from(compactRaw, 'hex')
      if (bytes.length > 0) {
        return decodeBinaryContent(bytes, raw)
      }
    }

    // 检查是否是 base64 编码
    if (compactRaw.length > 16 && looksLikeBase64(compactRaw)) {
      try {
        const bytes = Buffer.from(compactRaw, 'base64')
        return decodeBinaryContent(bytes, raw)
      } catch { }
    }

    // 普通字符串
    return raw
  }

  return ''
}

function decodeMessageContent(messageContent: any, compressContent: any): string {
  // 优先使用 compress_content
  let content = decodeMaybeCompressed(compressContent)
  if (!content || content.length === 0) {
    content = decodeMaybeCompressed(messageContent)
  }
  return content
}

/**
 * 行 -> Message[] 的轻量映射（非媒体）。等价于 chatService.mapRowsToMessagesLiteForApi，
 * 但是纯函数（myWxid 由参数传入），可在 worker 线程运行。逐行独立、无跨行状态。
 */
export function mapRowsToMessagesLite(rows: Record<string, any>[], myWxidRaw: string): Message[] {
  const myWxid = String(myWxidRaw || '').trim()
  const messages: Message[] = []
  for (const row of rows) {
    const sourceInfo = getMessageSourceInfo(row)
    const localType = getRowInt(row, ['local_type'], 1)
    const createTime = getRowTimestampSeconds(row, ['create_time', 'createTime', 'msg_time', 'msgTime', 'time'], 0)
    const sortSeq = getRowInt(row, ['sort_seq'], createTime > 0 ? createTime * 1000 : 0)
    const localId = getRowInt(row, ['local_id'], 0)
    const serverIdRaw = normalizeUnsignedIntegerToken(row.server_id)
    const serverId = getRowInt(row, ['server_id'], 0)
    const content = decodeMessageContent(row.message_content, row.compress_content)

    const isSendRaw = row.computed_is_send ?? row.is_send
    const parsedRawIsSend = isSendRaw === null || isSendRaw === undefined
      ? null
      : parseInt(String(isSendRaw), 10)
    const normalizedIsSend = typeof parsedRawIsSend === 'number' && Number.isFinite(parsedRawIsSend)
      ? parsedRawIsSend
      : null
    const senderFromRow = String(row.sender_username || '').trim() || extractSenderUsernameFromContent(content) || null
    const { isSend } = resolveMessageIsSend(normalizedIsSend, senderFromRow, myWxid)
    const senderUsername = senderFromRow || (isSend === 1 && myWxid ? myWxid : null)

    messages.push({
      messageKey: buildMessageKey({
        localId,
        serverId,
        createTime,
        sortSeq,
        senderUsername,
        localType,
        ...sourceInfo
      }),
      localId,
      serverId,
      serverIdRaw,
      localType,
      createTime,
      sortSeq,
      isSend,
      senderUsername,
      parsedContent: '',
      rawContent: content,
      content,
      _db_path: sourceInfo.dbPath
    } as Message)
  }
  return messages
}
