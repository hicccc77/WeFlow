import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import { getEmojiPath } from 'wechat-emojis'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { imageDecryptService } from './imageDecryptService'
import { chatService } from './chatService'
import { videoService } from './videoService'
import { voiceTranscribeService } from './voiceTranscribeService'
import { exportRecordService } from './exportRecordService'
import { EXPORT_HTML_STYLES } from './exportHtmlStyles'
import { LRUCache } from '../utils/LRUCache.js'

// ChatLab 格式类型定义
interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
}

interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
  chatRecords?: any[]  // 嵌套的聊天记录
}

interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportVoiceAsText?: boolean
  excelCompactColumns?: boolean
  txtColumns?: string[]
  sessionLayout?: 'shared' | 'per-session'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
}

const TXT_COLUMN_DEFINITIONS: Array<{ id: string; label: string }> = [
  { id: 'index', label: '序号' },
  { id: 'time', label: '时间' },
  { id: 'senderRole', label: '发送者身份' },
  { id: 'messageType', label: '消息类型' },
  { id: 'content', label: '内容' },
  { id: 'senderNickname', label: '发送者昵称' },
  { id: 'senderWxid', label: '发送者微信ID' },
  { id: 'senderRemark', label: '发送者备注' }
]

interface MediaExportItem {
  relativePath: string
  kind: 'image' | 'voice' | 'emoji' | 'video'
  posterDataUrl?: string
}

interface ExportDisplayProfile {
  wxid: string
  nickname: string
  remark: string
  alias: string
  groupNickname: string
  displayName: string
}

type MessageCollectMode = 'full' | 'text-fast' | 'media-fast'
type MediaContentType = 'voice' | 'image' | 'video' | 'emoji'

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  currentSessionId?: string
  phase: 'preparing' | 'exporting' | 'exporting-media' | 'exporting-voice' | 'writing' | 'complete'
  phaseProgress?: number
  phaseTotal?: number
  phaseLabel?: string
}

interface ExportTaskControl {
  shouldPause?: () => boolean
  shouldStop?: () => boolean
}

interface ExportStatsResult {
  totalMessages: number
  voiceMessages: number
  cachedVoiceCount: number
  needTranscribeCount: number
  mediaMessages: number
  estimatedSeconds: number
  sessions: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }>
}

interface ExportStatsSessionSnapshot {
  totalCount: number
  voiceCount: number
  imageCount: number
  videoCount: number
  emojiCount: number
  cachedVoiceCount: number
  lastTimestamp?: number
}

interface ExportStatsCacheEntry {
  createdAt: number
  result: ExportStatsResult
  sessions: Record<string, ExportStatsSessionSnapshot>
}

interface ExportAggregatedSessionMetric {
  totalMessages?: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  lastTimestamp?: number
}

interface ExportAggregatedSessionStatsCacheEntry {
  createdAt: number
  data: Record<string, ExportAggregatedSessionMetric>
}

// 并发控制：限制同时执行的 Promise 数量
async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  async function runNext(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++
      results[index] = await fn(items[index], index)
    }
  }

  // 启动 limit 个并发任务
  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => runNext())

  await Promise.all(workers)
  return results
}

class ExportService {
  private configService: ConfigService
  private contactCache: LRUCache<string, { displayName: string; avatarUrl?: string }>
  private inlineEmojiCache: LRUCache<string, string>
  private htmlStyleCache: string | null = null
  private exportStatsCache = new Map<string, ExportStatsCacheEntry>()
  private exportAggregatedSessionStatsCache = new Map<string, ExportAggregatedSessionStatsCacheEntry>()
  private readonly exportStatsCacheTtlMs = 2 * 60 * 1000
  private readonly exportAggregatedSessionStatsCacheTtlMs = 60 * 1000
  private readonly exportStatsCacheMaxEntries = 16
  private readonly STOP_ERROR_CODE = 'WEFLOW_EXPORT_STOP_REQUESTED'

  constructor() {
    this.configService = new ConfigService()
    // 限制缓存大小，防止内存泄漏
    this.contactCache = new LRUCache(500) // 最多缓存500个联系人
    this.inlineEmojiCache = new LRUCache(100) // 最多缓存100个表情
  }

  private createStopError(): Error {
    const error = new Error('导出任务已停止')
    ;(error as Error & { code?: string }).code = this.STOP_ERROR_CODE
    return error
  }

  private normalizeSessionIds(sessionIds: string[]): string[] {
    return Array.from(
      new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))
    )
  }

  private getExportStatsDateRangeToken(dateRange?: { start: number; end: number } | null): string {
    if (!dateRange) return 'all'
    const start = Number.isFinite(dateRange.start) ? Math.max(0, Math.floor(dateRange.start)) : 0
    const end = Number.isFinite(dateRange.end) ? Math.max(0, Math.floor(dateRange.end)) : 0
    return `${start}-${end}`
  }

  private buildExportStatsCacheKey(
    sessionIds: string[],
    options: Pick<ExportOptions, 'dateRange' | 'senderUsername'>,
    cleanedWxid?: string
  ): string {
    const normalizedIds = this.normalizeSessionIds(sessionIds).sort()
    const senderToken = String(options.senderUsername || '').trim()
    const dateToken = this.getExportStatsDateRangeToken(options.dateRange)
    const dbPath = String(this.configService.get('dbPath') || '').trim()
    const wxidToken = String(cleanedWxid || this.cleanAccountDirName(String(this.configService.get('myWxid') || '')) || '').trim()
    return `${dbPath}::${wxidToken}::${dateToken}::${senderToken}::${normalizedIds.join('\u001f')}`
  }

  private cloneExportStatsResult(result: ExportStatsResult): ExportStatsResult {
    return {
      ...result,
      sessions: result.sessions.map((item) => ({ ...item }))
    }
  }

  private pruneExportStatsCaches(): void {
    const now = Date.now()
    for (const [key, entry] of this.exportStatsCache.entries()) {
      if (now - entry.createdAt > this.exportStatsCacheTtlMs) {
        this.exportStatsCache.delete(key)
      }
    }
    for (const [key, entry] of this.exportAggregatedSessionStatsCache.entries()) {
      if (now - entry.createdAt > this.exportAggregatedSessionStatsCacheTtlMs) {
        this.exportAggregatedSessionStatsCache.delete(key)
      }
    }
  }

  private getExportStatsCacheEntry(key: string): ExportStatsCacheEntry | null {
    this.pruneExportStatsCaches()
    const entry = this.exportStatsCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.exportStatsCacheTtlMs) {
      this.exportStatsCache.delete(key)
      return null
    }
    return entry
  }

  private setExportStatsCacheEntry(key: string, entry: ExportStatsCacheEntry): void {
    this.pruneExportStatsCaches()
    this.exportStatsCache.set(key, entry)
    if (this.exportStatsCache.size <= this.exportStatsCacheMaxEntries) return
    const staleKeys = Array.from(this.exportStatsCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, Math.max(0, this.exportStatsCache.size - this.exportStatsCacheMaxEntries))
      .map(([cacheKey]) => cacheKey)
    for (const staleKey of staleKeys) {
      this.exportStatsCache.delete(staleKey)
    }
  }

  private getAggregatedSessionStatsCache(key: string): Record<string, ExportAggregatedSessionMetric> | null {
    this.pruneExportStatsCaches()
    const entry = this.exportAggregatedSessionStatsCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.exportAggregatedSessionStatsCacheTtlMs) {
      this.exportAggregatedSessionStatsCache.delete(key)
      return null
    }
    return entry.data
  }

  private setAggregatedSessionStatsCache(
    key: string,
    data: Record<string, ExportAggregatedSessionMetric>
  ): void {
    this.pruneExportStatsCaches()
    this.exportAggregatedSessionStatsCache.set(key, {
      createdAt: Date.now(),
      data
    })
    if (this.exportAggregatedSessionStatsCache.size <= this.exportStatsCacheMaxEntries) return
    const staleKeys = Array.from(this.exportAggregatedSessionStatsCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, Math.max(0, this.exportAggregatedSessionStatsCache.size - this.exportStatsCacheMaxEntries))
      .map(([cacheKey]) => cacheKey)
    for (const staleKey of staleKeys) {
      this.exportAggregatedSessionStatsCache.delete(staleKey)
    }
  }

  private isStopError(error: unknown): boolean {
    if (!error) return false
    if (typeof error === 'string') {
      return error.includes(this.STOP_ERROR_CODE) || error.includes('导出任务已停止')
    }
    if (error instanceof Error) {
      const code = (error as Error & { code?: string }).code
      return code === this.STOP_ERROR_CODE || error.message.includes(this.STOP_ERROR_CODE) || error.message.includes('导出任务已停止')
    }
    return false
  }

  private throwIfStopRequested(control?: ExportTaskControl): void {
    if (control?.shouldStop?.()) {
      throw this.createStopError()
    }
  }

  private getClampedConcurrency(value: number | undefined, fallback = 2, max = 6): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const raw = Math.floor(value)
    return Math.max(1, Math.min(raw, max))
  }

  private isMediaExportEnabled(options: ExportOptions): boolean {
    return options.exportMedia === true &&
      Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis)
  }

  private isUnboundedDateRange(dateRange?: { start: number; end: number } | null): boolean {
    if (!dateRange) return true
    const start = Number.isFinite(dateRange.start) ? dateRange.start : 0
    const end = Number.isFinite(dateRange.end) ? dateRange.end : 0
    return start <= 0 && end <= 0
  }

  private shouldUseFastTextCollection(options: ExportOptions): boolean {
    // 文本批量导出优先走轻量采集：不做媒体字段预提取，减少 CPU 与内存占用
    return !this.isMediaExportEnabled(options)
  }

  private getMediaContentType(options: ExportOptions): MediaContentType | null {
    const value = options.contentType
    if (value === 'voice' || value === 'image' || value === 'video' || value === 'emoji') {
      return value
    }
    return null
  }

  private isMediaContentBatchExport(options: ExportOptions): boolean {
    return this.getMediaContentType(options) !== null
  }

  private getTargetMediaLocalTypes(options: ExportOptions): Set<number> {
    const mediaContentType = this.getMediaContentType(options)
    if (mediaContentType === 'voice') return new Set([34])
    if (mediaContentType === 'image') return new Set([3])
    if (mediaContentType === 'video') return new Set([43])
    if (mediaContentType === 'emoji') return new Set([47])

    const selected = new Set<number>()
    if (options.exportImages) selected.add(3)
    if (options.exportVoices) selected.add(34)
    if (options.exportVideos) selected.add(43)
    if (options.exportEmojis) selected.add(47)
    return selected
  }

  private resolveCollectMode(options: ExportOptions): MessageCollectMode {
    if (this.isMediaContentBatchExport(options)) {
      return 'media-fast'
    }
    return this.shouldUseFastTextCollection(options) ? 'text-fast' : 'full'
  }

  private resolveCollectParams(options: ExportOptions): { mode: MessageCollectMode; targetMediaTypes?: Set<number> } {
    const mode = this.resolveCollectMode(options)
    if (mode === 'media-fast') {
      const targetMediaTypes = this.getTargetMediaLocalTypes(options)
      if (targetMediaTypes.size > 0) {
        return { mode, targetMediaTypes }
      }
    }
    return { mode }
  }

  private createCollectProgressReporter(
    sessionName: string,
    onProgress?: (progress: ExportProgress) => void,
    progressCurrent = 5
  ): ((payload: { fetched: number }) => void) | undefined {
    if (!onProgress) return undefined
    let lastReportAt = 0
    return ({ fetched }) => {
      const now = Date.now()
      if (now - lastReportAt < 350) return
      lastReportAt = now
      onProgress({
        current: progressCurrent,
        total: 100,
        currentSession: sessionName,
        phase: 'preparing',
        phaseLabel: `收集消息 ${fetched.toLocaleString()} 条`
      })
    }
  }

  private shouldDecodeMessageContentInFastMode(localType: number): boolean {
    // 这些类型在文本导出里只需要占位符，无需解码完整 XML / 压缩内容
    if (localType === 3 || localType === 34 || localType === 42 || localType === 43 || localType === 47) {
      return false
    }
    return true
  }

  private shouldDecodeMessageContentInMediaMode(localType: number, targetMediaTypes: Set<number> | null): boolean {
    if (!targetMediaTypes || !targetMediaTypes.has(localType)) return false
    // 语音导出仅需要 localId 读取音频数据，不依赖 XML 内容
    if (localType === 34) return false
    // 图片/视频/表情可能需要从 XML 提取 md5/datName/cdnUrl
    if (localType === 3 || localType === 43 || localType === 47) return true
    return false
  }

  private cleanAccountDirName(dirName: string): string {
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

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
    if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }
    if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid }
  }

  private async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
    if (this.contactCache.has(username)) {
      return this.contactCache.get(username)!
    }

    const [nameResult, avatarResult] = await Promise.all([
      wcdbService.getDisplayNames([username]),
      wcdbService.getAvatarUrls([username])
    ])

    const displayName = (nameResult.success && nameResult.map ? nameResult.map[username] : null) || username
    const avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined

    const info = { displayName, avatarUrl }
    this.contactCache.set(username, info)
    return info
  }

  private resolveSessionFilePrefix(sessionId: string, contact?: any): string {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return '私聊_'
    if (normalizedSessionId.endsWith('@chatroom')) return '群聊_'
    if (normalizedSessionId.startsWith('gh_')) return '公众号_'

    const rawLocalType = contact?.local_type ?? contact?.localType ?? contact?.WCDB_CT_local_type
    const localType = Number.parseInt(String(rawLocalType ?? ''), 10)
    const quanPin = String(contact?.quan_pin ?? contact?.quanPin ?? contact?.WCDB_CT_quan_pin ?? '').trim()

    if (Number.isFinite(localType) && localType === 0 && quanPin) {
      return '曾经的好友_'
    }

    return '私聊_'
  }

  private async getSessionFilePrefix(sessionId: string): Promise<string> {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return '私聊_'
    if (normalizedSessionId.endsWith('@chatroom')) return '群聊_'
    if (normalizedSessionId.startsWith('gh_')) return '公众号_'

    try {
      const contactResult = await wcdbService.getContact(normalizedSessionId)
      if (contactResult.success && contactResult.contact) {
        return this.resolveSessionFilePrefix(normalizedSessionId, contactResult.contact)
      }
    } catch {
      // ignore and use default private prefix
    }

    return '私聊_'
  }

  private async preloadContacts(
    usernames: Iterable<string>,
    cache: Map<string, { success: boolean; contact?: any; error?: string }>,
    limit = 8
  ): Promise<void> {
    const unique = Array.from(new Set(Array.from(usernames).filter(Boolean)))
    if (unique.length === 0) return
    await parallelLimit(unique, limit, async (username) => {
      if (cache.has(username)) return
      const result = await wcdbService.getContact(username)
      cache.set(username, result)
    })
  }

  private async preloadContactInfos(
    usernames: Iterable<string>,
    limit = 8
  ): Promise<Map<string, { displayName: string; avatarUrl?: string }>> {
    const infoMap = new Map<string, { displayName: string; avatarUrl?: string }>()
    const unique = Array.from(new Set(Array.from(usernames).filter(Boolean)))
    if (unique.length === 0) return infoMap

    await parallelLimit(unique, limit, async (username) => {
      const info = await this.getContactInfo(username)
      infoMap.set(username, info)
    })

    return infoMap
  }

  /**
   * 获取群成员群昵称。优先使用 DLL，必要时回退到 `contact.chat_room.ext_buffer` 解析。
   */
  async getGroupNicknamesForRoom(chatroomId: string, candidates: string[] = []): Promise<Map<string, string>> {
    const nicknameMap = new Map<string, string>()

    try {
      const dllResult = await wcdbService.getGroupNicknames(chatroomId)
      if (dllResult.success && dllResult.nicknames) {
        this.mergeGroupNicknameEntries(nicknameMap, Object.entries(dllResult.nicknames))
      }
    } catch (e) {
      console.error('getGroupNicknamesForRoom dll error:', e)
    }

    try {
      const sql = 'SELECT ext_buffer FROM chat_room WHERE username = ? LIMIT 1'
      const result = await wcdbService.execQuery('contact', null, sql, [chatroomId])
      if (!result.success || !result.rows || result.rows.length === 0) {
        return nicknameMap
      }

      const extBuffer = this.decodeExtBuffer((result.rows[0] as any).ext_buffer)
      if (!extBuffer) return nicknameMap
      this.mergeGroupNicknameEntries(nicknameMap, this.parseGroupNicknamesFromExtBuffer(extBuffer, candidates).entries())
      return nicknameMap
    } catch (e) {
      console.error('getGroupNicknamesForRoom error:', e)
      return nicknameMap
    }
  }

  private mergeGroupNicknameEntries(
    target: Map<string, string>,
    entries: Iterable<[string, string]>
  ): void {
    for (const [memberIdRaw, nicknameRaw] of entries) {
      const nickname = this.normalizeGroupNickname(nicknameRaw || '')
      if (!nickname) continue
      for (const alias of this.buildGroupNicknameIdCandidates([memberIdRaw])) {
        if (!alias) continue
        if (!target.has(alias)) target.set(alias, nickname)
        const lower = alias.toLowerCase()
        if (!target.has(lower)) target.set(lower, nickname)
      }
    }
  }

  private decodeExtBuffer(value: unknown): Buffer | null {
    if (!value) return null
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)

    if (typeof value === 'string') {
      const raw = value.trim()
      if (!raw) return null

      if (this.looksLikeHex(raw)) {
        try { return Buffer.from(raw, 'hex') } catch { }
      }
      if (this.looksLikeBase64(raw)) {
        try { return Buffer.from(raw, 'base64') } catch { }
      }

      try { return Buffer.from(raw, 'hex') } catch { }
      try { return Buffer.from(raw, 'base64') } catch { }
      try { return Buffer.from(raw, 'utf8') } catch { }
      return null
    }

    return null
  }

  private readVarint(buffer: Buffer, offset: number, limit: number = buffer.length): { value: number; next: number } | null {
    let value = 0
    let shift = 0
    let pos = offset
    while (pos < limit && shift <= 53) {
      const byte = buffer[pos]
      value += (byte & 0x7f) * Math.pow(2, shift)
      pos += 1
      if ((byte & 0x80) === 0) return { value, next: pos }
      shift += 7
    }
    return null
  }

  private isLikelyGroupMemberId(value: string): boolean {
    const id = String(value || '').trim()
    if (!id) return false
    if (id.includes('@chatroom')) return false
    if (id.length < 4 || id.length > 80) return false
    return /^[A-Za-z][A-Za-z0-9_.@-]*$/.test(id)
  }

  private parseGroupNicknamesFromExtBuffer(buffer: Buffer, candidates: string[] = []): Map<string, string> {
    const nicknameMap = new Map<string, string>()
    if (!buffer || buffer.length === 0) return nicknameMap

    try {
      const candidateSet = new Set(this.buildGroupNicknameIdCandidates(candidates).map((id) => id.toLowerCase()))

      for (let i = 0; i < buffer.length - 2; i += 1) {
        if (buffer[i] !== 0x0a) continue

        const idLenInfo = this.readVarint(buffer, i + 1)
        if (!idLenInfo) continue
        const idLen = idLenInfo.value
        if (!Number.isFinite(idLen) || idLen <= 0 || idLen > 96) continue

        const idStart = idLenInfo.next
        const idEnd = idStart + idLen
        if (idEnd > buffer.length) continue

        const memberId = buffer.toString('utf8', idStart, idEnd).trim()
        if (!this.isLikelyGroupMemberId(memberId)) continue

        const memberIdLower = memberId.toLowerCase()
        if (candidateSet.size > 0 && !candidateSet.has(memberIdLower)) {
          i = idEnd - 1
          continue
        }

        const cursor = idEnd
        if (cursor >= buffer.length || buffer[cursor] !== 0x12) {
          i = idEnd - 1
          continue
        }

        const nickLenInfo = this.readVarint(buffer, cursor + 1)
        if (!nickLenInfo) {
          i = idEnd - 1
          continue
        }
        const nickLen = nickLenInfo.value
        if (!Number.isFinite(nickLen) || nickLen <= 0 || nickLen > 128) {
          i = idEnd - 1
          continue
        }

        const nickStart = nickLenInfo.next
        const nickEnd = nickStart + nickLen
        if (nickEnd > buffer.length) {
          i = idEnd - 1
          continue
        }

        const rawNick = buffer.toString('utf8', nickStart, nickEnd)
        const nickname = this.normalizeGroupNickname(rawNick.replace(/[\x00-\x1F\x7F]/g, '').trim())
        if (!nickname) {
          i = nickEnd - 1
          continue
        }

        const aliases = this.buildGroupNicknameIdCandidates([memberId])
        for (const alias of aliases) {
          if (!alias) continue
          if (!nicknameMap.has(alias)) nicknameMap.set(alias, nickname)
          const lower = alias.toLowerCase()
          if (!nicknameMap.has(lower)) nicknameMap.set(lower, nickname)
        }

        i = nickEnd - 1
      }
    } catch (e) {
      console.error('Failed to parse chat_room.ext_buffer in exportService:', e)
    }

    return nicknameMap
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? parseInt(xmlTypeMatch[1]) : null

    // 特殊处理 type 49 或 XML type
    if (localType === 49 || xmlType) {
      const subType = xmlType || 0
      switch (subType) {
        case 6: return 4   // 文件 -> FILE
        case 19: return 7  // 聊天记录 -> LINK (ChatLab 没有专门的聊天记录类型)
        case 33:
        case 36: return 24 // 小程序 -> SHARE
        case 57: return 25 // 引用回复 -> REPLY
        case 2000: return 99 // 转账 -> OTHER (ChatLab 没有转账类型)
        case 5:
        case 49: return 7  // 链接 -> LINK
        default:
          if (xmlType) return 7 // 有 XML type 但未知，默认为链接
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99 // 未知类型 -> OTHER
  }

  /**
   * 解码消息内容
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      if (/^[0-9]+$/.test(raw)) {
        return raw
      }
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch {
          return raw
        }
      }
      return raw
    }
    return ''
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    try {
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          const fzstd = require('fzstd')
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        }
      }
      const decoded = data.toString('utf-8')
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private normalizeGroupNickname(value: string): string {
    const trimmed = (value || '').trim()
    if (!trimmed) return ''
    const cleaned = trimmed.replace(/[\x00-\x1F\x7F]/g, '')
    if (!cleaned) return ''
    if (/^[,"'“”‘’，、]+$/.test(cleaned)) return ''
    return cleaned
  }

  private buildGroupNicknameIdCandidates(values: Array<string | undefined | null>): string[] {
    const set = new Set<string>()
    for (const rawValue of values) {
      const raw = String(rawValue || '').trim()
      if (!raw) continue
      set.add(raw)
      const cleaned = this.cleanAccountDirName(raw)
      if (cleaned && cleaned !== raw) set.add(cleaned)
    }
    return Array.from(set)
  }

  private resolveGroupNicknameByCandidates(groupNicknamesMap: Map<string, string>, candidates: Array<string | undefined | null>): string {
    const idCandidates = this.buildGroupNicknameIdCandidates(candidates)
    if (idCandidates.length === 0) return ''

    for (const id of idCandidates) {
      const exact = this.normalizeGroupNickname(groupNicknamesMap.get(id) || '')
      if (exact) return exact
      const lower = this.normalizeGroupNickname(groupNicknamesMap.get(id.toLowerCase()) || '')
      if (lower) return lower
    }

    for (const id of idCandidates) {
      const lower = id.toLowerCase()
      let found = ''
      let matched = 0
      for (const [key, value] of groupNicknamesMap.entries()) {
        if (String(key || '').toLowerCase() !== lower) continue
        const normalized = this.normalizeGroupNickname(value || '')
        if (!normalized) continue
        found = normalized
        matched += 1
        if (matched > 1) return ''
      }
      if (matched === 1 && found) return found
    }

    return ''
  }

  /**
   * 根据用户偏好获取显示名称
   */
  private getPreferredDisplayName(
    wxid: string,
    nickname: string,
    remark: string,
    groupNickname: string,
    preference: 'group-nickname' | 'remark' | 'nickname' = 'remark'
  ): string {
    switch (preference) {
      case 'group-nickname':
        return groupNickname || remark || nickname || wxid
      case 'remark':
        return remark || nickname || wxid
      case 'nickname':
        return nickname || wxid
      default:
        return nickname || wxid
    }
  }

  private async resolveExportDisplayProfile(
    wxid: string,
    preference: ExportOptions['displayNamePreference'],
    getContact: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>,
    groupNicknamesMap: Map<string, string>,
    fallbackDisplayName = '',
    extraGroupNicknameCandidates: Array<string | undefined | null> = []
  ): Promise<ExportDisplayProfile> {
    const resolvedWxid = String(wxid || '').trim() || String(fallbackDisplayName || '').trim() || 'unknown'
    const contactResult = resolvedWxid ? await getContact(resolvedWxid) : { success: false as const }
    const contact = contactResult.success ? contactResult.contact : null
    const nickname = String(contact?.nickName || contact?.nick_name || fallbackDisplayName || resolvedWxid)
    const remark = String(contact?.remark || '')
    const alias = String(contact?.alias || '')
    const groupNickname = this.resolveGroupNicknameByCandidates(
      groupNicknamesMap,
      [
        resolvedWxid,
        contact?.username,
        contact?.userName,
        contact?.encryptUsername,
        contact?.encryptUserName,
        alias,
        ...extraGroupNicknameCandidates
      ]
    ) || ''
    const displayName = this.getPreferredDisplayName(
      resolvedWxid,
      nickname,
      remark,
      groupNickname,
      preference || 'remark'
    )

    return {
      wxid: resolvedWxid,
      nickname,
      remark,
      alias,
      groupNickname,
      displayName
    }
  }

  /**
   * 从转账消息 XML 中提取并解析 "谁转账给谁" 描述
   * @param content 原始消息内容 XML
   * @param myWxid 当前用户 wxid
   * @param groupNicknamesMap 群昵称映射
   * @param getContactName 联系人名称解析函数
   * @returns "A 转账给 B" 或 null
   */
  private async resolveTransferDesc(
    content: string,
    myWxid: string,
    groupNicknamesMap: Map<string, string>,
    getContactName: (username: string) => Promise<string>
  ): Promise<string | null> {
    const normalizedContent = this.normalizeAppMessageContent(content || '')
    if (!normalizedContent) return null

    const xmlType = this.extractXmlValue(normalizedContent, 'type')
    if (xmlType && xmlType !== '2000') return null

    const payerUsername = this.extractXmlValue(normalizedContent, 'payer_username')
    const receiverUsername = this.extractXmlValue(normalizedContent, 'receiver_username')
    if (!payerUsername || !receiverUsername) return null

    const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

    const resolveName = async (username: string): Promise<string> => {
      // 当前用户自己
      if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
        const groupNick = this.resolveGroupNicknameByCandidates(groupNicknamesMap, [username, myWxid, cleanedMyWxid])
        if (groupNick) return groupNick
        return '我'
      }
      // 群昵称
      const groupNick = this.resolveGroupNicknameByCandidates(groupNicknamesMap, [username])
      if (groupNick) return groupNick
      // 联系人名称
      return getContactName(username)
    }

    const [payerName, receiverName] = await Promise.all([
      resolveName(payerUsername),
      resolveName(receiverUsername)
    ])

    return `${payerName} 转账给 ${receiverName}`
  }

  private isSameWxid(lhs?: string, rhs?: string): boolean {
    const left = new Set(this.buildGroupNicknameIdCandidates([lhs]).map((id) => id.toLowerCase()))
    if (left.size === 0) return false
    const right = this.buildGroupNicknameIdCandidates([rhs]).map((id) => id.toLowerCase())
    return right.some((id) => left.has(id))
  }

  private getTransferPrefix(content: string, myWxid?: string, senderWxid?: string, isSend?: boolean): '[转账]' | '[转账收款]' {
    const normalizedContent = this.normalizeAppMessageContent(content || '')
    if (!normalizedContent) return '[转账]'

    const paySubtype = this.extractXmlValue(normalizedContent, 'paysubtype')
    // 转账消息在部分账号数据中 `payer_username` 可能为空，优先用 `paysubtype` 判定
    // 实测：1=发起侧，3=收款侧
    if (paySubtype === '3') return '[转账收款]'
    if (paySubtype === '1') return '[转账]'

    const payerUsername = this.extractXmlValue(normalizedContent, 'payer_username')
    const receiverUsername = this.extractXmlValue(normalizedContent, 'receiver_username')
    const senderIsPayer = senderWxid ? this.isSameWxid(senderWxid, payerUsername) : false
    const senderIsReceiver = senderWxid ? this.isSameWxid(senderWxid, receiverUsername) : false

    // 实测字段语义：sender 命中 receiver_username 为转账发起侧，命中 payer_username 为收款侧
    if (senderWxid) {
      if (senderIsReceiver && !senderIsPayer) return '[转账]'
      if (senderIsPayer && !senderIsReceiver) return '[转账收款]'
    }

    // 兜底：按当前账号角色判断
    if (myWxid) {
      if (this.isSameWxid(myWxid, receiverUsername)) return '[转账]'
      if (this.isSameWxid(myWxid, payerUsername)) return '[转账收款]'
    }

    return '[转账]'
  }

  private isTransferExportContent(content: string): boolean {
    return content.startsWith('[转账]') || content.startsWith('[转账收款]')
  }

  private appendTransferDesc(content: string, transferDesc: string): string {
    const prefix = content.startsWith('[转账收款]') ? '[转账收款]' : '[转账]'
    return content.replace(prefix, `${prefix} (${transferDesc})`)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析消息内容为可读文本
   * 注意：语音消息在这里返回占位符，实际转文字在导出时异步处理
   */
  private parseMessageContent(
    content: string,
    localType: number,
    sessionId?: string,
    createTime?: number,
    myWxid?: string,
    senderWxid?: string,
    isSend?: boolean
  ): string | null {
    if (!content) return null

    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

    switch (localType) {
      case 1: // 文本
        return this.stripSenderPrefix(content)
      case 3: return '[图片]'
      case 34: {
        // 语音消息 - 尝试获取转写文字
        const transcriptGetter = (voiceTranscribeService as unknown as {
          getCachedTranscript?: (sessionId: string, createTime: number) => string | null | undefined
        }).getCachedTranscript

        if (sessionId && createTime && typeof transcriptGetter === 'function') {
          const transcript = transcriptGetter(sessionId, createTime)
          if (transcript) {
            return `[语音消息] ${transcript}`
          }
        }
        return '[语音消息]'  // 占位符，导出时会替换为转文字结果
      }
      case 42: return '[名片]'
      case 43: return '[视频]'
      case 47: return '[动画表情]'
      case 48: {
        const normalized48 = this.normalizeAppMessageContent(content)
        const locPoiname = this.extractXmlAttribute(normalized48, 'location', 'poiname') || this.extractXmlValue(normalized48, 'poiname') || this.extractXmlValue(normalized48, 'poiName')
        const locLabel = this.extractXmlAttribute(normalized48, 'location', 'label') || this.extractXmlValue(normalized48, 'label')
        const locLat = this.extractXmlAttribute(normalized48, 'location', 'x') || this.extractXmlAttribute(normalized48, 'location', 'latitude')
        const locLng = this.extractXmlAttribute(normalized48, 'location', 'y') || this.extractXmlAttribute(normalized48, 'location', 'longitude')
        const locParts: string[] = []
        if (locPoiname) locParts.push(locPoiname)
        if (locLabel && locLabel !== locPoiname) locParts.push(locLabel)
        if (locLat && locLng) locParts.push(`(${locLat},${locLng})`)
        return locParts.length > 0 ? `[位置] ${locParts.join(' ')}` : '[位置]'
      }
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        const type = this.extractXmlValue(content, 'type')
        const songName = this.extractXmlValue(content, 'songname')

        // 转账消息特殊处理
        if (type === '2000') {
          const feedesc = this.extractXmlValue(content, 'feedesc')
          const payMemo = this.extractXmlValue(content, 'pay_memo')
          const transferPrefix = this.getTransferPrefix(content, myWxid, senderWxid, isSend)
          if (feedesc) {
            return payMemo ? `${transferPrefix} ${feedesc} ${payMemo}` : `${transferPrefix} ${feedesc}`
          }
          return transferPrefix
        }

        if (type === '3') return songName ? `[音乐] ${songName}` : (title ? `[音乐] ${title}` : '[音乐]')
        if (type === '6') return title ? `[文件] ${title}` : '[文件]'
        if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
        if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]'
        if (type === '57') return title || '[引用消息]'
        if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]'
        return title ? `[链接] ${title}` : '[链接]'
      }
      case 50: return this.parseVoipMessage(content)
      case 10000: return this.cleanSystemMessage(content)
      case 266287972401: return this.cleanSystemMessage(content)  // 拍一拍
      case 244813135921: {
        // 引用消息
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      }
      default:
        // 对于未知的 localType，检查 XML type 来判断消息类型
        if (xmlType) {
          const title = this.extractXmlValue(content, 'title')

          // 群公告消息（type 87）
          if (xmlType === '87') {
            const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
            if (textAnnouncement) {
              return `[群公告] ${textAnnouncement}`
            }
            return '[群公告]'
          }

          // 转账消息
          if (xmlType === '2000') {
            const feedesc = this.extractXmlValue(content, 'feedesc')
            const payMemo = this.extractXmlValue(content, 'pay_memo')
            const transferPrefix = this.getTransferPrefix(content, myWxid, senderWxid, isSend)
            if (feedesc) {
              return payMemo ? `${transferPrefix} ${feedesc} ${payMemo}` : `${transferPrefix} ${feedesc}`
            }
            return transferPrefix
          }

          // 其他类型
          if (xmlType === '3') return title ? `[音乐] ${title}` : '[音乐]'
          if (xmlType === '6') return title ? `[文件] ${title}` : '[文件]'
          if (xmlType === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
          if (xmlType === '33' || xmlType === '36') return title ? `[小程序] ${title}` : '[小程序]'
          if (xmlType === '57') return title || '[引用消息]'
          if (xmlType === '5' || xmlType === '49') return title ? `[链接] ${title}` : '[链接]'

          // 有 title 就返回 title
          if (title) return title
        }

        // 最后尝试提取文本内容
        return this.stripSenderPrefix(content) || null
    }
  }

  private formatPlainExportContent(
    content: string,
    localType: number,
    options: { exportVoiceAsText?: boolean },
    voiceTranscript?: string,
    myWxid?: string,
    senderWxid?: string,
    isSend?: boolean
  ): string {
    const safeContent = content || ''

    if (localType === 3) return '[图片]'
    if (localType === 1) return this.stripSenderPrefix(safeContent)
    if (localType === 34) {
      if (options.exportVoiceAsText) {
        return voiceTranscript || '[语音消息 - 转文字失败]'
      }
      return '[其他消息]'
    }
    if (localType === 42) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const nickname =
        this.extractXmlValue(normalized, 'nickname') ||
        this.extractXmlValue(normalized, 'displayname') ||
        this.extractXmlValue(normalized, 'name')
      return nickname ? `[名片]${nickname}` : '[名片]'
    }
    if (localType === 43) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const lengthValue =
        this.extractXmlValue(normalized, 'playlength') ||
        this.extractXmlValue(normalized, 'playLength') ||
        this.extractXmlValue(normalized, 'length') ||
        this.extractXmlValue(normalized, 'duration')
      const seconds = lengthValue ? this.parseDurationSeconds(lengthValue) : null
      return seconds ? `[视频]${seconds}s` : '[视频]'
    }
    if (localType === 48) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const locPoiname = this.extractXmlAttribute(normalized, 'location', 'poiname') || this.extractXmlValue(normalized, 'poiname') || this.extractXmlValue(normalized, 'poiName')
      const locLabel = this.extractXmlAttribute(normalized, 'location', 'label') || this.extractXmlValue(normalized, 'label')
      const locLat = this.extractXmlAttribute(normalized, 'location', 'x') || this.extractXmlAttribute(normalized, 'location', 'latitude')
      const locLng = this.extractXmlAttribute(normalized, 'location', 'y') || this.extractXmlAttribute(normalized, 'location', 'longitude')
      const locParts: string[] = []
      if (locPoiname) locParts.push(locPoiname)
      if (locLabel && locLabel !== locPoiname) locParts.push(locLabel)
      if (locLat && locLng) locParts.push(`(${locLat},${locLng})`)
      return locParts.length > 0 ? `[位置] ${locParts.join(' ')}` : '[位置]'
    }
    if (localType === 50) {
      return this.parseVoipMessage(safeContent)
    }
    if (localType === 10000 || localType === 266287972401) {
      return this.cleanSystemMessage(safeContent)
    }

    const normalized = this.normalizeAppMessageContent(safeContent)
    const isAppMessage = normalized.includes('<appmsg') || normalized.includes('<msg>')
    if (localType === 49 || isAppMessage) {
      const typeMatch = /<type>(\d+)<\/type>/i.exec(normalized)
      const subType = typeMatch ? parseInt(typeMatch[1], 10) : 0
      const title = this.extractXmlValue(normalized, 'title') || this.extractXmlValue(normalized, 'appname')

      // 群公告消息（type 87）
      if (subType === 87) {
        const textAnnouncement = this.extractXmlValue(normalized, 'textannouncement')
        if (textAnnouncement) {
          return `[群公告]${textAnnouncement}`
        }
        return '[群公告]'
      }

      // 转账消息特殊处理
      if (subType === 2000 || title.includes('转账') || normalized.includes('transfer')) {
        const feedesc = this.extractXmlValue(normalized, 'feedesc')
        const payMemo = this.extractXmlValue(normalized, 'pay_memo')
        const transferPrefix = this.getTransferPrefix(normalized, myWxid, senderWxid, isSend)
        if (feedesc) {
          return payMemo ? `${transferPrefix}${feedesc} ${payMemo}` : `${transferPrefix}${feedesc}`
        }
        const amount = this.extractAmountFromText(
          [
            title,
            this.extractXmlValue(normalized, 'des'),
            this.extractXmlValue(normalized, 'money'),
            this.extractXmlValue(normalized, 'amount'),
            this.extractXmlValue(normalized, 'fee')
          ]
            .filter(Boolean)
            .join(' ')
        )
        return amount ? `${transferPrefix}${amount}` : transferPrefix
      }

      if (subType === 3 || normalized.includes('<musicurl') || normalized.includes('<songname')) {
        const songName = this.extractXmlValue(normalized, 'songname') || title || '音乐'
        return `[音乐]${songName}`
      }
      if (subType === 6) {
        const fileName = this.extractXmlValue(normalized, 'filename') || title || '文件'
        return `[文件]${fileName}`
      }
      if (title.includes('红包') || normalized.includes('hongbao')) {
        return `[红包]${title || '微信红包'}`
      }
      if (subType === 19 || normalized.includes('<recorditem')) {
        const forwardName =
          this.extractXmlValue(normalized, 'nickname') ||
          this.extractXmlValue(normalized, 'title') ||
          this.extractXmlValue(normalized, 'des') ||
          this.extractXmlValue(normalized, 'displayname')
        return forwardName ? `[转发的聊天记录]${forwardName}` : '[转发的聊天记录]'
      }
      if (subType === 33 || subType === 36) {
        const appName = this.extractXmlValue(normalized, 'appname') || title || '小程序'
        return `[小程序]${appName}`
      }
      if (subType === 57) {
        return title || '[引用消息]'
      }
      if (title) {
        return `[链接]${title}`
      }
      return '[其他消息]'
    }

    return '[其他消息]'
  }

  private parseDurationSeconds(value: string): number | null {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    if (numeric >= 1000) return Math.round(numeric / 1000)
    return Math.round(numeric)
  }

  private extractAmountFromText(text: string): string | null {
    if (!text) return null
    const match = /([¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(text)
    return match ? match[1].replace(/\s+/g, '') : null
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '')
  }

  private getWeCloneTypeName(localType: number, content: string): string {
    if (localType === 1) return 'text'
    if (localType === 3) return 'image'
    if (localType === 47) return 'sticker'
    if (localType === 43) return 'video'
    if (localType === 34) return 'voice'
    if (localType === 48) return 'location'
    if (localType === 49) {
      const xmlType = this.extractXmlValue(content || '', 'type')
      if (xmlType === '6') return 'file'
      return 'text'
    }
    return 'text'
  }

  private getWeCloneSource(msg: any, typeName: string, mediaItem: MediaExportItem | null): string {
    if (mediaItem?.relativePath) {
      return mediaItem.relativePath
    }

    if (typeName === 'image') {
      return msg.imageDatName || ''
    }
    if (typeName === 'sticker') {
      return msg.emojiCdnUrl || ''
    }
    if (typeName === 'video') {
      return ''
    }
    if (typeName === 'file') {
      const xml = msg.content || ''
      return this.extractXmlValue(xml, 'filename') || this.extractXmlValue(xml, 'title') || ''
    }
    return ''
  }

  private escapeCsvCell(value: unknown): string {
    if (value === null || value === undefined) return ''
    const text = String(value)
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`
    }
    return text
  }

  private formatIsoTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString()
  }

  /**
   * 从撤回消息内容中提取撤回者的 wxid
   * 撤回消息 XML 格式通常包含 <session> 或 <newmsgid> 等字段
   * 以及撤回者的 wxid 在某些字段中
   * @returns { isRevoke: true, isSelfRevoke: true } - 是自己撤回的消息
   * @returns { isRevoke: true, revokerWxid: string } - 是别人撤回的消息，提取到撤回者
   * @returns { isRevoke: false } - 不是撤回消息
   */
  private extractRevokerInfo(content: string): { isRevoke: boolean; isSelfRevoke?: boolean; revokerWxid?: string } {
    if (!content) return { isRevoke: false }

    // 检查是否是撤回消息
    if (!content.includes('revokemsg') && !content.includes('撤回')) {
      return { isRevoke: false }
    }

    // 检查是否是 "你撤回了" - 自己撤回
    if (content.includes('你撤回')) {
      return { isRevoke: true, isSelfRevoke: true }
    }

    // 尝试从 <session> 标签提取（格式: wxid_xxx）
    const sessionMatch = /<session>([^<]+)<\/session>/i.exec(content)
    if (sessionMatch) {
      const session = sessionMatch[1].trim()
      // 如果 session 是 wxid 格式，返回它
      if (session.startsWith('wxid_') || /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(session)) {
        return { isRevoke: true, revokerWxid: session }
      }
    }

    // 尝试从 <fromusername> 提取
    const fromUserMatch = /<fromusername>([^<]+)<\/fromusername>/i.exec(content)
    if (fromUserMatch) {
      return { isRevoke: true, revokerWxid: fromUserMatch[1].trim() }
    }

    // 是撤回消息但无法提取撤回者
    return { isRevoke: true }
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
    const tagRegex = new RegExp(`<${tagName}\\s+[^>]*${attrName}\\s*=\\s*"([^"]*)"`, 'i')
    const match = tagRegex.exec(xml)
    return match ? match[1] : ''
  }

  private cleanSystemMessage(content: string): string {
    if (!content) return '[系统消息]'

    // 先尝试提取特定的系统消息内容
    // 1. 提取 sysmsg 中的文本内容
    const sysmsgTextMatch = /<sysmsg[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(content)
    if (sysmsgTextMatch) {
      content = sysmsgTextMatch[1]
    }

    // 2. 提取 revokemsg 撤回消息
    const revokeMatch = /<replacemsg><!\[CDATA\[(.*?)\]\]><\/replacemsg>/i.exec(content)
    if (revokeMatch) {
      return revokeMatch[1].trim()
    }

    // 3. 提取 pat 拍一拍消息（sysmsg 内的 template 格式）
    const patMatch = /<template><!\[CDATA\[(.*?)\]\]><\/template>/i.exec(content)
    if (patMatch) {
      // 移除模板变量占位符
      return patMatch[1]
        .replace(/\$\{([^}]+)\}/g, (_, varName) => {
          const varMatch = new RegExp(`<${varName}><!\\\[CDATA\\\[([^\]]*)\\\]\\\]><\/${varName}>`, 'i').exec(content)
          return varMatch ? varMatch[1] : ''
        })
        .replace(/<[^>]+>/g, '')
        .trim()
    }

    // 3.5 提取 <title> 内容（适用于 appmsg 格式的拍一拍等消息）
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(content)
    if (titleMatch) {
      const title = titleMatch[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
      if (title) {
        return title
      }
    }

    // 4. 处理 CDATA 内容
    content = content.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')

    // 5. 移除所有 XML 标签
    return content
      .replace(/<img[^>]*>/gi, '')
      .replace(/<\/?[a-zA-Z0-9_:]+[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim() || '[系统消息]'
  }

  /**
   * 解析通话消息
   * 格式: <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[...]]></msg><room_type>0/1</room_type>...</VoIPBubbleMsg></voipmsg>
   * room_type: 0 = 语音通话, 1 = 视频通话
   */
  private parseVoipMessage(content: string): string {
    try {
      if (!content) return '[通话]'

      // 提取 msg 内容（中文通话状态）
      const msgMatch = /<msg><!\[CDATA\[(.*?)\]\]><\/msg>/i.exec(content)
      const msg = msgMatch?.[1]?.trim() || ''

      // 提取 room_type（0=视频，1=语音）
      const roomTypeMatch = /<room_type>(\d+)<\/room_type>/i.exec(content)
      const roomType = roomTypeMatch ? parseInt(roomTypeMatch[1], 10) : -1

      // 构建通话类型标签
      let callType: string
      if (roomType === 0) {
        callType = '视频通话'
      } else if (roomType === 1) {
        callType = '语音通话'
      } else {
        callType = '通话'
      }

      // 解析通话状态
      if (msg.includes('通话时长')) {
        const durationMatch = /通话时长\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(msg)
        const duration = durationMatch?.[1] || ''
        if (duration) {
          return `[${callType}] ${duration}`
        }
        return `[${callType}] 已接听`
      } else if (msg.includes('对方无应答')) {
        return `[${callType}] 对方无应答`
      } else if (msg.includes('已取消')) {
        return `[${callType}] 已取消`
      } else if (msg.includes('已在其它设备接听') || msg.includes('已在其他设备接听')) {
        return `[${callType}] 已在其他设备接听`
      } else if (msg.includes('对方已拒绝') || msg.includes('已拒绝')) {
        return `[${callType}] 对方已拒绝`
      } else if (msg.includes('忙线未接听') || msg.includes('忙线')) {
        return `[${callType}] 忙线未接听`
      } else if (msg.includes('未接听')) {
        return `[${callType}] 未接听`
      } else if (msg) {
        return `[${callType}] ${msg}`
      }

      return `[${callType}]`
    } catch (e) {
      return '[通话]'
    }
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number, content?: string): string {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    if (content) {
      const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
      const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

      if (xmlType) {
        switch (xmlType) {
          case '3': return '音乐消息'
          case '87': return '群公告'
          case '2000': return '转账消息'
          case '5': return '链接消息'
          case '6': return '文件消息'
          case '19': return '聊天记录'
          case '33':
          case '36': return '小程序消息'
          case '57': return '引用消息'
        }
      }
    }

    const typeNames: Record<number, string> = {
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
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  private normalizeTxtColumns(columns?: string[] | null): string[] {
    const fallback = ['index', 'time', 'senderRole', 'messageType', 'content']
    const selected = new Set((columns && columns.length > 0 ? columns : fallback).filter(Boolean))
    const ordered = TXT_COLUMN_DEFINITIONS.map((col) => col.id).filter((id) => selected.has(id))
    return ordered.length > 0 ? ordered : fallback
  }

  private sanitizeTxtValue(value: string): string {
    return value.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim()
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, c => {
      switch (c) {
        case '&': return '&amp;'
        case '<': return '&lt;'
        case '>': return '&gt;'
        case '"': return '&quot;'
        case "'": return '&#39;'
        default: return c
      }
    })
  }

  private escapeAttribute(value: string): string {
    return value.replace(/[&<>"'`]/g, c => {
      switch (c) {
        case '&': return '&amp;'
        case '<': return '&lt;'
        case '>': return '&gt;'
        case '"': return '&quot;'
        case "'": return '&#39;'
        case '`': return '&#96;'
        default: return c
      }
    })
  }

  private getAvatarFallback(name: string): string {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  private renderMultilineText(value: string): string {
    return this.escapeHtml(value).replace(/\r?\n/g, '<br />')
  }

  private loadExportHtmlStyles(): string {
    if (this.htmlStyleCache !== null) {
      return this.htmlStyleCache
    }
    const candidates = [
      path.join(__dirname, 'exportHtml.css'),
      path.join(process.cwd(), 'electron', 'services', 'exportHtml.css')
    ]
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          if (content.trim().length > 0) {
            this.htmlStyleCache = content
            return content
          }
        } catch {
          continue
        }
      }
    }
    this.htmlStyleCache = EXPORT_HTML_STYLES
    return this.htmlStyleCache
  }

  /**
   * 解析合并转发的聊天记录 (Type 19)
   */
  private parseChatHistory(content: string): any[] | undefined {
    try {
      const type = this.extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      const parseRecordItemBody = (body: string, datatype = 0) => {
        const datasizeRaw = this.extractXmlValue(body, 'datasize')
        const datasize = datasizeRaw ? parseInt(datasizeRaw, 10) : undefined

        return {
          datatype,
          sourcename: this.extractXmlValue(body, 'sourcename'),
          sourcetime: this.extractXmlValue(body, 'sourcetime'),
          sourceheadurl: this.extractXmlValue(body, 'sourceheadurl') || undefined,
          datadesc: this.decodeHtmlEntities(this.extractXmlValue(body, 'datadesc')) || undefined,
          datatitle: this.decodeHtmlEntities(this.extractXmlValue(body, 'datatitle')) || undefined,
          fileext: this.extractXmlValue(body, 'fileext') || undefined,
          datasize: Number.isFinite(datasize) ? datasize : undefined
        }
      }

      const cdataMatch = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/i.exec(content)
      if (cdataMatch) {
        const items: any[] = []
        const itemRegex = /<dataitem\b([^>]*)>([\s\S]*?)<\/dataitem>/gi
        let itemMatch: RegExpExecArray | null

        while ((itemMatch = itemRegex.exec(cdataMatch[1])) !== null) {
          const datatypeMatch = /datatype="(\d+)"/i.exec(itemMatch[1])
          const datatype = datatypeMatch ? parseInt(datatypeMatch[1], 10) : 0
          items.push(parseRecordItemBody(itemMatch[2], datatype))
        }

        if (items.length > 0) {
          return items
        }
      }

      const legacyItems: any[] = []
      const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
      let match: RegExpExecArray | null

      while ((match = recordItemRegex.exec(content)) !== null) {
        const datatypeStr = this.extractXmlValue(match[1], 'datatype')
        const datatype = datatypeStr ? parseInt(datatypeStr, 10) : 0
        legacyItems.push(parseRecordItemBody(match[1], datatype))
      }

      return legacyItems.length > 0 ? legacyItems : undefined
    } catch (e) {
      console.error('ExportService: 解析聊天记录失败:', e)
      return undefined
    }
  }

  /**
   * 解码 HTML 实体
   */
  private decodeHtmlEntities(text: string): string {
    if (!text) return ''
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
  }

  private normalizeAppMessageContent(content: string): string {
    if (!content) return ''
    if (content.includes('&lt;') && content.includes('&gt;')) {
      return content
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    }
    return content
  }

  private extractFinderFeedDesc(content: string): string {
    if (!content) return ''
    const match = /<finderFeed[\s\S]*?<desc>([\s\S]*?)<\/desc>/i.exec(content)
    if (!match) return ''
    return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  }

  private extractAppMessageType(content: string): string {
    if (!content) return ''
    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
    if (appmsgMatch) {
      const appmsgInner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
      if (typeMatch) return typeMatch[1].trim()
    }
    return this.extractXmlValue(content, 'type')
  }

  private looksLikeWxid(text: string): boolean {
    if (!text) return false
    const trimmed = text.trim().toLowerCase()
    if (trimmed.startsWith('wxid_')) return true
    return /^wx[a-z0-9_-]{4,}$/.test(trimmed)
  }

  private sanitizeQuotedContent(content: string): string {
    if (!content) return ''
    let result = content
    result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
    result = result.replace(/^[\s:：\-]+/, '')
    result = result.replace(/[:：]{2,}/g, ':')
    result = result.replace(/^[\s:：\-]+/, '')
    result = result.replace(/\s+/g, ' ').trim()
    return result
  }

  private parseQuoteMessage(content: string): { content?: string; sender?: string; type?: string } {
    try {
      const normalized = this.normalizeAppMessageContent(content || '')
      const referMsgStart = normalized.indexOf('<refermsg>')
      const referMsgEnd = normalized.indexOf('</refermsg>')
      if (referMsgStart === -1 || referMsgEnd === -1) {
        return {}
      }

      const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
      let sender = this.extractXmlValue(referMsgXml, 'displayname')
      if (sender && this.looksLikeWxid(sender)) {
        sender = ''
      }

      const referContent = this.extractXmlValue(referMsgXml, 'content')
      const referType = this.extractXmlValue(referMsgXml, 'type')
      let displayContent = referContent

      switch (referType) {
        case '1':
          displayContent = this.sanitizeQuotedContent(referContent)
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
          displayContent = '[动画表情]'
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
          if (!referContent || referContent.includes('wxid_')) {
            displayContent = '[消息]'
          } else {
            displayContent = this.sanitizeQuotedContent(referContent)
          }
      }

      return {
        content: displayContent || undefined,
        sender: sender || undefined,
        type: referType || undefined
      }
    } catch {
      return {}
    }
  }

  private extractArkmeAppMessageMeta(content: string, localType: number): Record<string, any> | null {
    if (!content) return null

    const normalized = this.normalizeAppMessageContent(content)
    const looksLikeAppMsg =
      localType === 49 ||
      localType === 244813135921 ||
      normalized.includes('<appmsg') ||
      normalized.includes('<msg>')
    const hasReferMsg = normalized.includes('<refermsg>')
    const xmlType = this.extractAppMessageType(normalized)
    const isFinder =
      xmlType === '51' ||
      normalized.includes('<finder') ||
      normalized.includes('finderusername') ||
      normalized.includes('finderobjectid')
    const isMusic =
      xmlType === '3' ||
      normalized.includes('<musicurl') ||
      normalized.includes('<playurl>') ||
      normalized.includes('<dataurl>')

    if (!looksLikeAppMsg && !isFinder && !hasReferMsg) return null

    let appMsgKind: string | undefined
    if (isFinder) {
      appMsgKind = 'finder'
    } else if (xmlType === '2001') {
      appMsgKind = 'red-packet'
    } else if (isMusic) {
      appMsgKind = 'music'
    } else if (xmlType === '33' || xmlType === '36') {
      appMsgKind = 'miniapp'
    } else if (xmlType === '6') {
      appMsgKind = 'file'
    } else if (xmlType === '19') {
      appMsgKind = 'chat-record'
    } else if (xmlType === '2000') {
      appMsgKind = 'transfer'
    } else if (xmlType === '87') {
      appMsgKind = 'announcement'
    } else if (xmlType === '57' || hasReferMsg || localType === 244813135921) {
      appMsgKind = 'quote'
    } else if (xmlType === '5' || xmlType === '49') {
      appMsgKind = 'link'
    } else if (looksLikeAppMsg) {
      appMsgKind = 'card'
    }

    const meta: Record<string, any> = {}
    if (xmlType) meta.appMsgType = xmlType
    else if (appMsgKind === 'quote') meta.appMsgType = '57'
    if (appMsgKind) meta.appMsgKind = appMsgKind

    const appMsgDesc = this.extractXmlValue(normalized, 'des') || this.extractXmlValue(normalized, 'desc')
    const appMsgAppName = this.extractXmlValue(normalized, 'appname')
    const appMsgSourceName =
      this.extractXmlValue(normalized, 'sourcename') ||
      this.extractXmlValue(normalized, 'sourcedisplayname')
    const appMsgSourceUsername = this.extractXmlValue(normalized, 'sourceusername')
    const appMsgThumbUrl =
      this.extractXmlValue(normalized, 'thumburl') ||
      this.extractXmlValue(normalized, 'cdnthumburl') ||
      this.extractXmlValue(normalized, 'cover') ||
      this.extractXmlValue(normalized, 'coverurl') ||
      this.extractXmlValue(normalized, 'thumbUrl') ||
      this.extractXmlValue(normalized, 'coverUrl')

    if (appMsgDesc) meta.appMsgDesc = appMsgDesc
    if (appMsgAppName) meta.appMsgAppName = appMsgAppName
    if (appMsgSourceName) meta.appMsgSourceName = appMsgSourceName
    if (appMsgSourceUsername) meta.appMsgSourceUsername = appMsgSourceUsername
    if (appMsgThumbUrl) meta.appMsgThumbUrl = appMsgThumbUrl

    if (appMsgKind === 'quote') {
      const quoteInfo = this.parseQuoteMessage(normalized)
      if (quoteInfo.content) meta.quotedContent = quoteInfo.content
      if (quoteInfo.sender) meta.quotedSender = quoteInfo.sender
      if (quoteInfo.type) meta.quotedType = quoteInfo.type
    }

    if (appMsgKind === 'link') {
      const linkCard = this.extractHtmlLinkCard(normalized, localType)
      const linkUrl = linkCard?.url || this.normalizeHtmlLinkUrl(
        this.extractXmlValue(normalized, 'shareurl') ||
        this.extractXmlValue(normalized, 'shorturl') ||
        this.extractXmlValue(normalized, 'dataurl')
      )
      if (linkCard?.title) meta.linkTitle = linkCard.title
      if (linkUrl) meta.linkUrl = linkUrl
      if (appMsgThumbUrl) meta.linkThumb = appMsgThumbUrl
    }

    if (isMusic) {
      const musicTitle =
        this.extractXmlValue(normalized, 'songname') ||
        this.extractXmlValue(normalized, 'title')
      const musicUrl =
        this.extractXmlValue(normalized, 'musicurl') ||
        this.extractXmlValue(normalized, 'playurl') ||
        this.extractXmlValue(normalized, 'songalbumurl')
      const musicDataUrl =
        this.extractXmlValue(normalized, 'dataurl') ||
        this.extractXmlValue(normalized, 'lowurl')
      const musicAlbumUrl = this.extractXmlValue(normalized, 'songalbumurl')
      const musicCoverUrl =
        this.extractXmlValue(normalized, 'thumburl') ||
        this.extractXmlValue(normalized, 'cdnthumburl') ||
        this.extractXmlValue(normalized, 'coverurl') ||
        this.extractXmlValue(normalized, 'cover')
      const musicSinger =
        this.extractXmlValue(normalized, 'singername') ||
        this.extractXmlValue(normalized, 'artist') ||
        this.extractXmlValue(normalized, 'albumartist')
      const musicAppName = this.extractXmlValue(normalized, 'appname')
      const musicSourceName = this.extractXmlValue(normalized, 'sourcename')
      const durationRaw =
        this.extractXmlValue(normalized, 'playlength') ||
        this.extractXmlValue(normalized, 'play_length') ||
        this.extractXmlValue(normalized, 'duration')
      const musicDuration = durationRaw ? this.parseDurationSeconds(durationRaw) : null

      if (musicTitle) meta.musicTitle = musicTitle
      if (musicUrl) meta.musicUrl = musicUrl
      if (musicDataUrl) meta.musicDataUrl = musicDataUrl
      if (musicAlbumUrl) meta.musicAlbumUrl = musicAlbumUrl
      if (musicCoverUrl) meta.musicCoverUrl = musicCoverUrl
      if (musicSinger) meta.musicSinger = musicSinger
      if (musicAppName) meta.musicAppName = musicAppName
      if (musicSourceName) meta.musicSourceName = musicSourceName
      if (musicDuration != null) meta.musicDuration = musicDuration
    }

    if (!isFinder) {
      return Object.keys(meta).length > 0 ? meta : null
    }

    const rawTitle = this.extractXmlValue(normalized, 'title')
    const finderFeedDesc = this.extractFinderFeedDesc(normalized)
    const finderTitle = (!rawTitle || rawTitle.includes('不支持')) ? finderFeedDesc : rawTitle
    const finderDesc = this.extractXmlValue(normalized, 'des') || this.extractXmlValue(normalized, 'desc')
    const finderUsername =
      this.extractXmlValue(normalized, 'finderusername') ||
      this.extractXmlValue(normalized, 'finder_username') ||
      this.extractXmlValue(normalized, 'finderuser')
    const finderNickname =
      this.extractXmlValue(normalized, 'findernickname') ||
      this.extractXmlValue(normalized, 'finder_nickname')
    const finderCoverUrl =
      this.extractXmlValue(normalized, 'thumbUrl') ||
      this.extractXmlValue(normalized, 'coverUrl') ||
      this.extractXmlValue(normalized, 'thumburl') ||
      this.extractXmlValue(normalized, 'coverurl')
    const finderAvatar = this.extractXmlValue(normalized, 'avatar')
    const durationRaw = this.extractXmlValue(normalized, 'videoPlayDuration') || this.extractXmlValue(normalized, 'duration')
    const finderDuration = durationRaw ? this.parseDurationSeconds(durationRaw) : null
    const finderObjectId =
      this.extractXmlValue(normalized, 'finderobjectid') ||
      this.extractXmlValue(normalized, 'finder_objectid') ||
      this.extractXmlValue(normalized, 'objectid') ||
      this.extractXmlValue(normalized, 'object_id')
    const finderUrl =
      this.extractXmlValue(normalized, 'url') ||
      this.extractXmlValue(normalized, 'shareurl')

    if (finderTitle) meta.finderTitle = finderTitle
    if (finderDesc) meta.finderDesc = finderDesc
    if (finderUsername) meta.finderUsername = finderUsername
    if (finderNickname) meta.finderNickname = finderNickname
    if (finderCoverUrl) meta.finderCoverUrl = finderCoverUrl
    if (finderAvatar) meta.finderAvatar = finderAvatar
    if (finderDuration != null) meta.finderDuration = finderDuration
    if (finderObjectId) meta.finderObjectId = finderObjectId
    if (finderUrl) meta.finderUrl = finderUrl

    return Object.keys(meta).length > 0 ? meta : null
  }

  private extractArkmeContactCardMeta(content: string, localType: number): Record<string, any> | null {
    if (!content || localType !== 42) return null

    const normalized = this.normalizeAppMessageContent(content)
    const readAttr = (attrName: string): string =>
      this.extractXmlAttribute(normalized, 'msg', attrName) || this.extractXmlValue(normalized, attrName)

    const contactCardWxid =
      readAttr('username') ||
      readAttr('encryptusername') ||
      readAttr('encrypt_user_name')
    const contactCardNickname = readAttr('nickname')
    const contactCardAlias = readAttr('alias')
    const contactCardRemark = readAttr('remark')
    const contactCardProvince = readAttr('province')
    const contactCardCity = readAttr('city')
    const contactCardSignature = readAttr('sign') || readAttr('signature')
    const contactCardAvatar =
      readAttr('smallheadimgurl') ||
      readAttr('bigheadimgurl') ||
      readAttr('headimgurl') ||
      readAttr('avatar')
    const sexRaw = readAttr('sex')
    const contactCardGender = sexRaw ? parseInt(sexRaw, 10) : NaN

    const meta: Record<string, any> = {
      cardKind: 'contact-card'
    }
    if (contactCardWxid) meta.contactCardWxid = contactCardWxid
    if (contactCardNickname) meta.contactCardNickname = contactCardNickname
    if (contactCardAlias) meta.contactCardAlias = contactCardAlias
    if (contactCardRemark) meta.contactCardRemark = contactCardRemark
    if (contactCardProvince) meta.contactCardProvince = contactCardProvince
    if (contactCardCity) meta.contactCardCity = contactCardCity
    if (contactCardSignature) meta.contactCardSignature = contactCardSignature
    if (contactCardAvatar) meta.contactCardAvatar = contactCardAvatar
    if (Number.isFinite(contactCardGender) && contactCardGender >= 0) {
      meta.contactCardGender = contactCardGender
    }

    return Object.keys(meta).length > 0 ? meta : null
  }

  private getInlineEmojiDataUrl(name: string): string | null {
    if (!name) return null
    const cached = this.inlineEmojiCache.get(name)
    if (cached) return cached
    const emojiPath = getEmojiPath(name as any)
    if (!emojiPath) return null
    const baseDir = path.dirname(require.resolve('wechat-emojis'))
    const absolutePath = path.join(baseDir, emojiPath)
    if (!fs.existsSync(absolutePath)) return null
    try {
      const buffer = fs.readFileSync(absolutePath)
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
      this.inlineEmojiCache.set(name, dataUrl)
      return dataUrl
    } catch {
      return null
    }
  }

  private renderTextWithEmoji(text: string): string {
    if (!text) return ''
    const parts = text.split(/\[(.*?)\]/g)
    const rendered = parts.map((part, index) => {
      if (index % 2 === 1) {
        const emojiDataUrl = this.getInlineEmojiDataUrl(part)
        if (emojiDataUrl) {
          // Cache full <img> tag to avoid re-escaping data URL every time
          const escapedName = this.escapeAttribute(part)
          return `<img class="inline-emoji" src="${emojiDataUrl}" alt="[${escapedName}]" />`
        }
        return this.escapeHtml(`[${part}]`)
      }
      return this.escapeHtml(part)
    })
    return rendered.join('')
  }

  private getChatRecordPreviewText(record: {
    datatype?: number
    datadesc?: string
    datatitle?: string
    fileext?: string
    duration?: number
  }): string {
    const text = record.datadesc || record.datatitle || ''
    if (text) return text

    switch (record.datatype) {
      case 3:
        return '[图片]'
      case 34:
        return record.duration ? `[语音] ${(record.duration / 1000).toFixed(0)}"` : '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[动画表情]'
      case 49:
      case 8:
      case 6:
        return record.fileext ? `[文件] .${record.fileext}` : '[文件]'
      default:
        return '[消息]'
    }
  }

  private formatChatRecordPlainText(input: {
    title?: string
    records?: Array<{
      sourcename?: string
      sourcetime?: string
      datatype?: number
      datadesc?: string
      datatitle?: string
      fileext?: string
      duration?: number
    }>
  }): string {
    const records = input.records || []
    const header = input.title ? `[聊天记录] ${input.title}` : '[聊天记录]'
    if (records.length === 0) return header

    const lines = [header]
    for (const record of records) {
      const sender = record.sourcename || '未知发送者'
      const time = record.sourcetime ? ` ${record.sourcetime}` : ''
      const preview = this.getChatRecordPreviewText(record)
      lines.push(`${sender}${time}: ${preview}`)
    }
    return lines.join('\n')
  }

  private renderHtmlChatRecordCard(input: {
    title?: string
    records?: Array<{
      sourcename?: string
      sourcetime?: string
      datatype?: number
      datadesc?: string
      datatitle?: string
      fileext?: string
      duration?: number
    }>
  }): string {
    const records = input.records || []
    if (records.length === 0) return ''

    const title = input.title || '聊天记录'
    const itemsHtml = records.map((record) => {
      const sender = record.sourcename || '未知发送者'
      const time = record.sourcetime ? `<span class="chat-record-item-time">${this.escapeHtml(record.sourcetime)}</span>` : ''
      const previewText = this.getChatRecordPreviewText(record)
      return `<div class="chat-record-item">
        <div class="chat-record-item-head">
          <span class="chat-record-item-sender">${this.escapeHtml(sender)}</span>
          ${time}
        </div>
        <div class="chat-record-item-body">${this.renderTextWithEmoji(previewText).replace(/\r?\n/g, '<br />')}</div>
      </div>`
    }).join('')

    return `<div class="chat-record-card">
      <div class="chat-record-card-title">${this.escapeHtml(title)}</div>
      <div class="chat-record-card-meta">共 ${records.length} 条聊天记录</div>
      <div class="chat-record-card-list">${itemsHtml}</div>
    </div>`
  }

  private formatHtmlMessageText(content: string, localType: number, myWxid?: string, senderWxid?: string, isSend?: boolean): string {
    if (!content) return ''

    if (localType === 1) {
      return this.stripSenderPrefix(content)
    }

    if (localType === 34) {
      return this.parseMessageContent(content, localType, undefined, undefined, myWxid, senderWxid, isSend) || ''
    }

    return this.formatPlainExportContent(content, localType, { exportVoiceAsText: false }, undefined, myWxid, senderWxid, isSend)
  }

  private extractHtmlLinkCard(content: string, localType: number): { title: string; url: string } | null {
    if (!content) return null

    const normalized = this.normalizeAppMessageContent(content)
    const isAppMessage = localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>')
    if (!isAppMessage) return null

    const subType = this.extractXmlValue(normalized, 'type')
    if (subType && subType !== '5' && subType !== '49') return null

    const url = this.normalizeHtmlLinkUrl(this.extractXmlValue(normalized, 'url'))
    if (!url) return null

    const title = this.extractXmlValue(normalized, 'title') || this.extractXmlValue(normalized, 'des') || url
    return { title, url }
  }

  private normalizeHtmlLinkUrl(rawUrl: string): string {
    const value = (rawUrl || '').trim()
    if (!value) return ''

    const parseHttpUrl = (candidate: string): string => {
      try {
        const parsed = new URL(candidate)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.toString()
        }
      } catch {
        return ''
      }
      return ''
    }

    if (value.startsWith('//')) {
      return parseHttpUrl(`https:${value}`)
    }

    const direct = parseHttpUrl(value)
    if (direct) return direct

    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
    const isDomainLike = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:[/:?#].*)?$/.test(value)
    if (!hasScheme && isDomainLike) {
      return parseHttpUrl(`https://${value}`)
    }

    return ''
  }

  /**
   * 导出媒体文件到指定目录
   */
  private async exportMediaForMessage(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string,
    options: {
      exportImages?: boolean
      exportVoices?: boolean
      exportVideos?: boolean
      exportEmojis?: boolean
      exportVoiceAsText?: boolean
      includeVoiceWithTranscript?: boolean
    }
  ): Promise<MediaExportItem | null> {
    const localType = msg.localType

    // 图片消息
    if (localType === 3 && options.exportImages) {
      const result = await this.exportImage(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      if (result) {
      }
      return result
    }

    // 语音消息
    if (localType === 34) {
      if (options.exportVoices) {
        return this.exportVoice(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      }
      if (options.exportVoiceAsText) {
        return null
      }
    }

    // 动画表情
    if (localType === 47 && options.exportEmojis) {
      const result = await this.exportEmoji(msg, sessionId, mediaRootDir, mediaRelativePrefix)
      if (result) {
      }
      return result
    }

    if (localType === 43 && options.exportVideos) {
      return this.exportVideo(msg, sessionId, mediaRootDir, mediaRelativePrefix)
    }

    return null
  }

  /**
   * 导出图片文件
   */
  private async exportImage(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const imagesDir = path.join(mediaRootDir, mediaRelativePrefix, 'images')
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true })
      }

      // 使用消息对象中已提取的字段
      const imageMd5 = msg.imageMd5
      const imageDatName = msg.imageDatName

      if (!imageMd5 && !imageDatName) {
        return null
      }

      const result = await imageDecryptService.decryptImage({
        sessionId,
        imageMd5,
        imageDatName,
        force: false  // 先尝试缩略图
      })

      if (!result.success || !result.localPath) {
        console.log(`[Export] 图片解密失败 (localId=${msg.localId}): imageMd5=${imageMd5}, imageDatName=${imageDatName}, error=${result.error || '未知'}`)
        // 尝试获取缩略图
        const thumbResult = await imageDecryptService.resolveCachedImage({
          sessionId,
          imageMd5,
          imageDatName
        })
        if (thumbResult.success && thumbResult.localPath) {
          console.log(`[Export] 使用缩略图替代 (localId=${msg.localId}): ${thumbResult.localPath}`)
          result.localPath = thumbResult.localPath
        } else {
          console.log(`[Export] 缩略图也获取失败 (localId=${msg.localId}): error=${thumbResult.error || '未知'}`)
          // 最后尝试：直接从 imageStore 获取缓存的缩略图 data URL
          const { imageStore } = await import('../main')
          const cachedThumb = imageStore?.getCachedImage(sessionId, imageMd5, imageDatName)
          if (cachedThumb) {
            console.log(`[Export] 从 imageStore 获取到缓存缩略图 (localId=${msg.localId})`)
            result.localPath = cachedThumb
          } else {
            console.log(`[Export] 所有方式均失败 → 将显示 [图片] 占位符`)
            return null
          }
        }
      }

      // 为每条消息生成稳定且唯一的文件名前缀，避免跨日期/消息发生同名覆盖
      const messageId = String(msg.localId || Date.now())
      const imageKey = (imageMd5 || imageDatName || 'image').replace(/[^a-zA-Z0-9_-]/g, '')

      // 从 data URL 或 file URL 获取实际路径
      let sourcePath = result.localPath
      if (sourcePath.startsWith('data:')) {
        // 是 data URL，需要保存为文件
        const base64Data = sourcePath.split(',')[1]
        const ext = this.getExtFromDataUrl(sourcePath)
        const fileName = `${messageId}_${imageKey}${ext}`
        const destPath = path.join(imagesDir, fileName)

        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'))

        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'images', fileName),
          kind: 'image'
        }
      } else if (sourcePath.startsWith('file://')) {
        sourcePath = fileURLToPath(sourcePath)
      }

      // 复制文件
      if (!fs.existsSync(sourcePath)) {
        console.log(`[Export] 源图片文件不存在 (localId=${msg.localId}): ${sourcePath} → 将显示 [图片] 占位符`)
        return null
      }
      const ext = path.extname(sourcePath) || '.jpg'
      const fileName = `${messageId}_${imageKey}${ext}`
      const destPath = path.join(imagesDir, fileName)

      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(sourcePath, destPath)
      }

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'images', fileName),
        kind: 'image'
      }
    } catch (e) {
      console.error(`[Export] 导出图片异常 (localId=${msg.localId}):`, e, `→ 将显示 [图片] 占位符`)
      return null
    }
  }

  /**
   * 导出语音文件
   */
  private async exportVoice(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const voicesDir = path.join(mediaRootDir, mediaRelativePrefix, 'voices')
      if (!fs.existsSync(voicesDir)) {
        fs.mkdirSync(voicesDir, { recursive: true })
      }

      const msgId = String(msg.localId)
      const safeSession = this.cleanAccountDirName(sessionId)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 48) || 'session'
      const fileName = `voice_${safeSession}_${msgId}.wav`
      const destPath = path.join(voicesDir, fileName)

      // 如果已存在则跳过
      if (fs.existsSync(destPath)) {
        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'voices', fileName),
          kind: 'voice'
        }
      }

      // 调用 chatService 获取语音数据
      const voiceResult = await chatService.getVoiceData(sessionId, msgId)
      if (!voiceResult.success || !voiceResult.data) {
        return null
      }

      // voiceResult.data 是 base64 编码的 wav 数据
      const wavBuffer = Buffer.from(voiceResult.data, 'base64')
      fs.writeFileSync(destPath, wavBuffer)

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'voices', fileName),
        kind: 'voice'
      }
    } catch (e) {
      return null
    }
  }

  /**
   * 转写语音为文字
   */
  private async transcribeVoice(sessionId: string, msgId: string, createTime: number, senderWxid: string | null): Promise<string> {
    try {
      const transcript = await chatService.getVoiceTranscript(sessionId, msgId, createTime, undefined, senderWxid || undefined)
      if (transcript.success && transcript.transcript) {
        return `[语音转文字] ${transcript.transcript}`
      }
      return `[语音消息 - 转文字失败: ${transcript.error || '未知错误'}]`
    } catch (e) {
      return `[语音消息 - 转文字失败: ${String(e)}]`
    }
  }

  /**
   * 导出表情文件
   */
  private async exportEmoji(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const emojisDir = path.join(mediaRootDir, mediaRelativePrefix, 'emojis')
      if (!fs.existsSync(emojisDir)) {
        fs.mkdirSync(emojisDir, { recursive: true })
      }

      // 使用 chatService 下载表情包 (利用其重试和 fallback 逻辑)
      const localPath = await chatService.downloadEmojiFile(msg)

      if (!localPath || !fs.existsSync(localPath)) {
        return null
      }

      // 确定目标文件名
      const ext = path.extname(localPath) || '.gif'
      const key = msg.emojiMd5 || String(msg.localId)
      const fileName = `${key}${ext}`
      const destPath = path.join(emojisDir, fileName)

      // 复制文件到导出目录 (如果不存在)
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(localPath, destPath)
      }

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'emojis', fileName),
        kind: 'emoji'
      }
    } catch (e) {
      console.error('ExportService: exportEmoji failed', e)
      return null
    }
  }

  /**
   * 导出视频文件
   */
  private async exportVideo(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string
  ): Promise<MediaExportItem | null> {
    try {
      const videoMd5 = msg.videoMd5
      if (!videoMd5) return null

      const videosDir = path.join(mediaRootDir, mediaRelativePrefix, 'videos')
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true })
      }

      const videoInfo = await videoService.getVideoInfo(videoMd5)
      if (!videoInfo.exists || !videoInfo.videoUrl) {
        return null
      }

      const sourcePath = videoInfo.videoUrl
      const fileName = path.basename(sourcePath)
      const destPath = path.join(videosDir, fileName)

      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(sourcePath, destPath)
      }

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'videos', fileName),
        kind: 'video',
        posterDataUrl: videoInfo.coverUrl || videoInfo.thumbUrl
      }
    } catch (e) {
      return null
    }
  }

  /**
   * 从消息内容提取图片 MD5
   */
  private extractImageMd5(content: string): string | undefined {
    if (!content) return undefined
    const match = /md5="([^"]+)"/i.exec(content)
    return match?.[1]
  }

  /**
   * 从消息内容提取图片 DAT 文件名
   */
  private extractImageDatName(content: string): string | undefined {
    if (!content) return undefined
    // 尝试从 cdnthumburl 或其他字段提取
    const urlMatch = /cdnthumburl[^>]*>([^<]+)/i.exec(content)
    if (urlMatch) {
      const urlParts = urlMatch[1].split('/')
      const last = urlParts[urlParts.length - 1]
      if (last && last.includes('_')) {
        return last.split('_')[0]
      }
    }
    return undefined
  }

  /**
   * 从消息内容提取表情 URL
   */
  private extractEmojiUrl(content: string): string | undefined {
    if (!content) return undefined
    // 参考 echotrace 的正则：cdnurl\s*=\s*['"]([^'"]+)['"]
    const attrMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
    if (attrMatch) {
      // 解码 &amp; 等实体
      let url = attrMatch[1].replace(/&amp;/g, '&')
      // URL 解码
      try {
        if (url.includes('%')) {
          url = decodeURIComponent(url)
        }
      } catch { }
      return url
    }
    // 备用：尝试 XML 标签形式
    const tagMatch = /cdnurl[^>]*>([^<]+)/i.exec(content)
    return tagMatch?.[1]
  }

  /**
   * 从消息内容提取表情 MD5
   */
  private extractEmojiMd5(content: string): string | undefined {
    if (!content) return undefined
    const match = /md5="([^"]+)"/i.exec(content) || /<md5>([^<]+)<\/md5>/i.exec(content)
    return match?.[1]
  }

  private extractVideoMd5(content: string): string | undefined {
    if (!content) return undefined
    const attrMatch = /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
    if (attrMatch) {
      return attrMatch[1].toLowerCase()
    }
    const tagMatch = /<md5>([^<]+)<\/md5>/i.exec(content)
    return tagMatch?.[1]?.toLowerCase()
  }

  private extractLocationMeta(content: string, localType: number): {
    locationLat?: number
    locationLng?: number
    locationPoiname?: string
    locationLabel?: string
  } | null {
    if (!content || localType !== 48) return null

    const normalized = this.normalizeAppMessageContent(content)
    const rawLat = this.extractXmlAttribute(normalized, 'location', 'x') || this.extractXmlAttribute(normalized, 'location', 'latitude')
    const rawLng = this.extractXmlAttribute(normalized, 'location', 'y') || this.extractXmlAttribute(normalized, 'location', 'longitude')
    const locationPoiname =
      this.extractXmlAttribute(normalized, 'location', 'poiname') ||
      this.extractXmlValue(normalized, 'poiname') ||
      this.extractXmlValue(normalized, 'poiName')
    const locationLabel =
      this.extractXmlAttribute(normalized, 'location', 'label') ||
      this.extractXmlValue(normalized, 'label')

    const meta: {
      locationLat?: number
      locationLng?: number
      locationPoiname?: string
      locationLabel?: string
    } = {}

    if (rawLat) {
      const parsed = parseFloat(rawLat)
      if (Number.isFinite(parsed)) meta.locationLat = parsed
    }
    if (rawLng) {
      const parsed = parseFloat(rawLng)
      if (Number.isFinite(parsed)) meta.locationLng = parsed
    }
    if (locationPoiname) meta.locationPoiname = locationPoiname
    if (locationLabel) meta.locationLabel = locationLabel

    return Object.keys(meta).length > 0 ? meta : null
  }

  /**
   * 从 data URL 获取扩展名
   */
  private getExtFromDataUrl(dataUrl: string): string {
    if (dataUrl.includes('image/png')) return '.png'
    if (dataUrl.includes('image/gif')) return '.gif'
    if (dataUrl.includes('image/webp')) return '.webp'
    return '.jpg'
  }

  private getMediaLayout(outputPath: string, options: ExportOptions): {
    exportMediaEnabled: boolean
    mediaRootDir: string
    mediaRelativePrefix: string
  } {
    const exportMediaEnabled = options.exportMedia === true &&
      Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis)
    const outputDir = path.dirname(outputPath)
    const rawWriteLayout = this.configService.get('exportWriteLayout')
    const writeLayout = rawWriteLayout === 'A' || rawWriteLayout === 'B' || rawWriteLayout === 'C'
      ? rawWriteLayout
      : 'A'
    // A: type-first layout, text exports are placed under `texts/`, media is placed at sibling type directories.
    if (writeLayout === 'A' && path.basename(outputDir) === 'texts') {
      return {
        exportMediaEnabled,
        mediaRootDir: outputDir,
        mediaRelativePrefix: '..'
      }
    }
    const outputBaseName = path.basename(outputPath, path.extname(outputPath))
    const useSharedMediaLayout = options.sessionLayout === 'shared'
    const mediaRelativePrefix = useSharedMediaLayout
      ? path.posix.join('media', outputBaseName)
      : 'media'
    return { exportMediaEnabled, mediaRootDir: outputDir, mediaRelativePrefix }
  }

  /**
   * 下载文件
   */
  private async downloadFile(url: string, destPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const protocol = url.startsWith('https') ? https : http
        const request = protocol.get(url, { timeout: 30000 }, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location
            if (redirectUrl) {
              this.downloadFile(redirectUrl, destPath).then(resolve)
              return
            }
          }
          if (response.statusCode !== 200) {
            resolve(false)
            return
          }
          const fileStream = fs.createWriteStream(destPath)
          response.pipe(fileStream)
          fileStream.on('finish', () => {
            fileStream.close()
            resolve(true)
          })
          fileStream.on('error', (err) => {
            // 确保在错误情况下销毁流，释放文件句柄
            fileStream.destroy()
            resolve(false)
          })
          response.on('error', (err) => {
            // 确保在响应错误时也关闭文件句柄
            fileStream.destroy()
            resolve(false)
          })
        })
        request.on('error', () => resolve(false))
        request.on('timeout', () => {
          request.destroy()
          resolve(false)
        })
      } catch {
        resolve(false)
      }
    })
  }

  private async collectMessages(
    sessionId: string,
    cleanedMyWxid: string,
    dateRange?: { start: number; end: number } | null,
    senderUsernameFilter?: string,
    collectMode: MessageCollectMode = 'full',
    targetMediaTypes?: Set<number>,
    control?: ExportTaskControl,
    onCollectProgress?: (payload: { fetched: number }) => void
  ): Promise<{ rows: any[]; memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>; firstTime: number | null; lastTime: number | null }> {
    const rows: any[] = []
    const memberSet = new Map<string, { member: ChatLabMember; avatarUrl?: string }>()
    const senderSet = new Set<string>()
    let firstTime: number | null = null
    let lastTime: number | null = null
    const mediaTypeFilter = collectMode === 'media-fast' && targetMediaTypes && targetMediaTypes.size > 0
      ? targetMediaTypes
      : null

    // 修复时间范围：0 表示不限制，而不是时间戳 0
    const beginTime = dateRange?.start || 0
    const endTime = dateRange?.end && dateRange.end > 0 ? dateRange.end : 0
    
    const batchSize = (collectMode === 'text-fast' || collectMode === 'media-fast') ? 2000 : 500
    this.throwIfStopRequested(control)
    const cursor = collectMode === 'media-fast'
      ? await wcdbService.openMessageCursorLite(
        sessionId,
        batchSize,
        true,
        beginTime,
        endTime
      )
      : await wcdbService.openMessageCursor(
        sessionId,
        batchSize,
        true,
        beginTime,
        endTime
      )
    if (!cursor.success || !cursor.cursor) {
      console.error(`[Export] 打开游标失败: ${cursor.error || '未知错误'}`)
      return { rows, memberSet, firstTime, lastTime }
    }

    try {
      let hasMore = true
      let batchCount = 0
      while (hasMore) {
        this.throwIfStopRequested(control)
        const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
        batchCount++
        
        if (!batch.success) {
          console.error(`[Export] 获取批次 ${batchCount} 失败: ${batch.error}`)
          break
        }
        
        if (!batch.rows) break
        
        let rowIndex = 0
        for (const row of batch.rows) {
          if ((rowIndex++ & 0x7f) === 0) {
            this.throwIfStopRequested(control)
          }
          const createTime = parseInt(row.create_time || '0', 10)
          if (dateRange) {
            if (createTime < dateRange.start || createTime > dateRange.end) continue
          }

          const localType = parseInt(row.local_type || row.type || '1', 10)
          if (mediaTypeFilter && !mediaTypeFilter.has(localType)) {
            continue
          }
          const shouldDecodeContent = collectMode === 'full'
            || (collectMode === 'text-fast' && this.shouldDecodeMessageContentInFastMode(localType))
            || (collectMode === 'media-fast' && this.shouldDecodeMessageContentInMediaMode(localType, mediaTypeFilter))
          const content = shouldDecodeContent
            ? this.decodeMessageContent(row.message_content, row.compress_content)
            : ''
          const senderUsername = row.sender_username || ''
          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10) === 1
          const localId = parseInt(row.local_id || row.localId || '0', 10)

          // 确定实际发送者
          let actualSender: string
          if (localType === 10000 || localType === 266287972401) {
            // 系统消息特殊处理
            const revokeInfo = this.extractRevokerInfo(content)
            if (revokeInfo.isRevoke) {
              // 撤回消息
              if (revokeInfo.isSelfRevoke) {
                // "你撤回了" - 发送者是当前用户
                actualSender = cleanedMyWxid
              } else if (revokeInfo.revokerWxid) {
                // 提取到了撤回者的 wxid
                actualSender = revokeInfo.revokerWxid
              } else {
                // 无法确定撤回者，使用 sessionId
                actualSender = sessionId
              }
            } else {
              // 普通系统消息（如"xxx加入群聊"），发送者是群聊ID
              actualSender = sessionId
            }
          } else {
            actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
          }

          if (senderUsernameFilter && !this.isSameWxid(actualSender, senderUsernameFilter)) {
            continue
          }
          senderSet.add(actualSender)

          // 提取媒体相关字段（轻量模式下跳过）
          let imageMd5: string | undefined
          let imageDatName: string | undefined
          let emojiCdnUrl: string | undefined
          let emojiMd5: string | undefined
          let videoMd5: string | undefined
          let locationLat: number | undefined
          let locationLng: number | undefined
          let locationPoiname: string | undefined
          let locationLabel: string | undefined
          let chatRecordTitle: string | undefined
          let chatRecordList: any[] | undefined

          if (localType === 48 && content) {
            const locationMeta = this.extractLocationMeta(content, localType)
            if (locationMeta) {
              locationLat = locationMeta.locationLat
              locationLng = locationMeta.locationLng
              locationPoiname = locationMeta.locationPoiname
              locationLabel = locationMeta.locationLabel
            }
          }

          if (collectMode === 'full' || collectMode === 'media-fast') {
            // 优先复用游标返回的字段，缺失时再回退到 XML 解析。
            imageMd5 = String(row.image_md5 || row.imageMd5 || '').trim() || undefined
            imageDatName = String(row.image_dat_name || row.imageDatName || '').trim() || undefined
            emojiCdnUrl = String(row.emoji_cdn_url || row.emojiCdnUrl || '').trim() || undefined
            emojiMd5 = String(row.emoji_md5 || row.emojiMd5 || '').trim() || undefined
            videoMd5 = String(row.video_md5 || row.videoMd5 || '').trim() || undefined

            if (localType === 3 && content) {
              // 图片消息
              imageMd5 = imageMd5 || this.extractImageMd5(content)
              imageDatName = imageDatName || this.extractImageDatName(content)
            } else if (localType === 47 && content) {
              // 动画表情
              emojiCdnUrl = emojiCdnUrl || this.extractEmojiUrl(content)
              emojiMd5 = emojiMd5 || this.extractEmojiMd5(content)
            } else if (localType === 43 && content) {
              // 视频消息
              videoMd5 = videoMd5 || this.extractVideoMd5(content)
            }

            const looksLikeAppMsg = Boolean(content && (content.includes('<appmsg') || content.includes('&lt;appmsg')))
            if (collectMode === 'full' && content && (localType === 49 || looksLikeAppMsg)) {
              const xmlType = this.extractXmlValue(content, 'type')
              if (xmlType === '19') {
                chatRecordTitle = this.extractXmlValue(content, 'title') || '聊天记录'
                chatRecordList = this.parseChatHistory(content)
              }
            }
          }

          rows.push({
            localId,
            createTime,
            localType,
            content,
            senderUsername: actualSender,
            isSend,
            imageMd5,
            imageDatName,
            emojiCdnUrl,
            emojiMd5,
            videoMd5,
            locationLat,
            locationLng,
            locationPoiname,
            locationLabel,
            chatRecordTitle,
            chatRecordList
          })

          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
        }
        onCollectProgress?.({ fetched: rows.length })
        hasMore = batch.hasMore === true
      }
      
    } catch (err) {
      if (this.isStopError(err)) throw err
      console.error(`[Export] 收集消息异常:`, err)
    } finally {
      try {
        await wcdbService.closeMessageCursor(cursor.cursor)
      } catch (err) {
        console.error(`[Export] 关闭游标失败:`, err)
      }
    }

    this.throwIfStopRequested(control)
    if (collectMode === 'media-fast' && mediaTypeFilter && rows.length > 0) {
      await this.backfillMediaFieldsFromMessageDetail(sessionId, rows, mediaTypeFilter, control)
    }

    this.throwIfStopRequested(control)
    if (senderSet.size > 0) {
      const usernames = Array.from(senderSet)
      const [nameResult, avatarResult] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      const nameMap = nameResult.success && nameResult.map ? nameResult.map : {}
      const avatarMap = avatarResult.success && avatarResult.map ? avatarResult.map : {}

      for (const username of usernames) {
        const displayName = nameMap[username] || username
        const avatarUrl = avatarMap[username]
        memberSet.set(username, {
          member: {
            platformId: username,
            accountName: displayName
          },
          avatarUrl
        })
        this.contactCache.set(username, { displayName, avatarUrl })
      }
    }

    return { rows, memberSet, firstTime, lastTime }
  }

  private async backfillMediaFieldsFromMessageDetail(
    sessionId: string,
    rows: any[],
    targetMediaTypes: Set<number>,
    control?: ExportTaskControl
  ): Promise<void> {
    const needsBackfill = rows.filter((msg) => {
      if (!targetMediaTypes.has(msg.localType)) return false
      if (msg.localType === 3) return !msg.imageMd5 && !msg.imageDatName
      if (msg.localType === 47) return !msg.emojiMd5 && !msg.emojiCdnUrl
      if (msg.localType === 43) return !msg.videoMd5
      return false
    })
    if (needsBackfill.length === 0) return

    const DETAIL_CONCURRENCY = 6
    await parallelLimit(needsBackfill, DETAIL_CONCURRENCY, async (msg) => {
      this.throwIfStopRequested(control)
      const localId = Number(msg.localId || 0)
      if (!Number.isFinite(localId) || localId <= 0) return

      try {
        const detail = await wcdbService.getMessageById(sessionId, localId)
        if (!detail.success || !detail.message) return

        const row = detail.message as any
        const rawMessageContent = row.message_content ?? row.messageContent ?? row.msg_content ?? row.msgContent ?? ''
        const rawCompressContent = row.compress_content ?? row.compressContent ?? row.msg_compress_content ?? row.msgCompressContent ?? ''
        const content = this.decodeMessageContent(rawMessageContent, rawCompressContent)

        if (msg.localType === 3) {
          const imageMd5 = String(row.image_md5 || row.imageMd5 || '').trim() || this.extractImageMd5(content)
          const imageDatName = String(row.image_dat_name || row.imageDatName || '').trim() || this.extractImageDatName(content)
          if (imageMd5) msg.imageMd5 = imageMd5
          if (imageDatName) msg.imageDatName = imageDatName
          return
        }

        if (msg.localType === 47) {
          const emojiMd5 = String(row.emoji_md5 || row.emojiMd5 || '').trim() || this.extractEmojiMd5(content)
          const emojiCdnUrl = String(row.emoji_cdn_url || row.emojiCdnUrl || '').trim() || this.extractEmojiUrl(content)
          if (emojiMd5) msg.emojiMd5 = emojiMd5
          if (emojiCdnUrl) msg.emojiCdnUrl = emojiCdnUrl
          return
        }

        if (msg.localType === 43) {
          const videoMd5 = String(row.video_md5 || row.videoMd5 || '').trim() || this.extractVideoMd5(content)
          if (videoMd5) msg.videoMd5 = videoMd5
        }
      } catch (error) {
        // 详情补取失败时保持降级导出（占位符），避免中断整批任务。
      }
    })
  }

  // 补齐群成员，避免只导出发言者导致头像缺失
  private async mergeGroupMembers(
    chatroomId: string,
    memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>,
    includeAvatars: boolean
  ): Promise<void> {
    const result = await wcdbService.getGroupMembers(chatroomId)
    if (!result.success || !result.members || result.members.length === 0) return

    const rawMembers = result.members as Array<{
      username?: string
      avatarUrl?: string
      nickname?: string
      displayName?: string
      remark?: string
      originalName?: string
    }>
    const usernames = rawMembers
      .map((member) => member.username)
      .filter((username): username is string => Boolean(username))
    if (usernames.length === 0) return

    const lookupUsernames = new Set<string>()
    for (const username of usernames) {
      lookupUsernames.add(username)
      const cleaned = this.cleanAccountDirName(username)
      if (cleaned && cleaned !== username) {
        lookupUsernames.add(cleaned)
      }
    }

    const [displayNames, avatarUrls] = await Promise.all([
      wcdbService.getDisplayNames(Array.from(lookupUsernames)),
      includeAvatars ? wcdbService.getAvatarUrls(Array.from(lookupUsernames)) : Promise.resolve({ success: true, map: {} as Record<string, string> })
    ])

    for (const member of rawMembers) {
      const username = member.username
      if (!username) continue

      const cleaned = this.cleanAccountDirName(username)
      const displayName = displayNames.success && displayNames.map
        ? (displayNames.map[username] || (cleaned ? displayNames.map[cleaned] : undefined) || username)
        : username
      const groupNickname = member.nickname || member.displayName || member.remark || member.originalName
      const avatarUrl = includeAvatars && avatarUrls.success && avatarUrls.map
        ? (avatarUrls.map[username] || (cleaned ? avatarUrls.map[cleaned] : undefined) || member.avatarUrl)
        : member.avatarUrl

      const existing = memberSet.get(username)
      if (existing) {
        if (displayName && existing.member.accountName === existing.member.platformId && displayName !== existing.member.platformId) {
          existing.member.accountName = displayName
        }
        if (groupNickname && !existing.member.groupNickname) {
          existing.member.groupNickname = groupNickname
        }
        if (!existing.avatarUrl && avatarUrl) {
          existing.avatarUrl = avatarUrl
        }
        memberSet.set(username, existing)
        continue
      }

      const chatlabMember: ChatLabMember = {
        platformId: username,
        accountName: displayName
      }
      if (groupNickname) {
        chatlabMember.groupNickname = groupNickname
      }
      memberSet.set(username, { member: chatlabMember, avatarUrl })
    }
  }

  private extractGroupMemberUsername(member: any): string {
    if (!member) return ''
    if (typeof member === 'string') return member.trim()
    return String(
      member.username ||
      member.userName ||
      member.user_name ||
      member.encryptUsername ||
      member.encryptUserName ||
      member.encrypt_username ||
      member.originalName ||
      ''
    ).trim()
  }

  private extractGroupSenderCountMap(groupStats: any, sessionId: string): Map<string, number> {
    const senderCountMap = new Map<string, number>()
    if (!groupStats || typeof groupStats !== 'object') return senderCountMap

    const sessions = (groupStats as any).sessions
    const sessionStats = sessions && typeof sessions === 'object'
      ? (sessions[sessionId] || sessions[String(sessionId)] || null)
      : null
    const senderRaw = (sessionStats && typeof sessionStats === 'object' && (sessionStats as any).senders && typeof (sessionStats as any).senders === 'object')
      ? (sessionStats as any).senders
      : ((groupStats as any).senders && typeof (groupStats as any).senders === 'object' ? (groupStats as any).senders : {})
    const idMap = (groupStats as any).idMap && typeof (groupStats as any).idMap === 'object'
      ? (groupStats as any).idMap
      : ((sessionStats && typeof sessionStats === 'object' && (sessionStats as any).idMap && typeof (sessionStats as any).idMap === 'object')
        ? (sessionStats as any).idMap
        : {})

    for (const [senderKey, rawCount] of Object.entries(senderRaw)) {
      const countNumber = Number(rawCount)
      if (!Number.isFinite(countNumber) || countNumber <= 0) continue
      const count = Math.max(0, Math.floor(countNumber))
      const mapped = typeof (idMap as any)[senderKey] === 'string' ? String((idMap as any)[senderKey]).trim() : ''
      const wxid = (mapped || String(senderKey || '').trim())
      if (!wxid) continue
      senderCountMap.set(wxid, (senderCountMap.get(wxid) || 0) + count)
    }

    return senderCountMap
  }

  private sumSenderCountsByIdentity(senderCountMap: Map<string, number>, wxid: string): number {
    const target = String(wxid || '').trim()
    if (!target) return 0
    let total = 0
    for (const [senderWxid, count] of senderCountMap.entries()) {
      if (!Number.isFinite(count) || count <= 0) continue
      if (this.isSameWxid(senderWxid, target)) {
        total += count
      }
    }
    return total
  }

  private async queryFriendFlagMap(usernames: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>()
    const unique = Array.from(
      new Set((usernames || []).map((username) => String(username || '').trim()).filter(Boolean))
    )
    if (unique.length === 0) return result

    const BATCH = 200
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH)
      const inList = batch.map((username) => `'${username.replace(/'/g, "''")}'`).join(',')
      const sql = `SELECT username, local_type FROM contact WHERE username IN (${inList})`
      const query = await wcdbService.execQuery('contact', null, sql)
      if (!query.success || !query.rows) continue
      for (const row of query.rows) {
        const username = String((row as any).username || '').trim()
        if (!username) continue
        const localType = Number.parseInt(String((row as any).local_type ?? (row as any).localType ?? (row as any).WCDB_CT_local_type ?? ''), 10)
        result.set(username, Number.isFinite(localType) && localType === 1)
      }
    }

    for (const username of unique) {
      if (!result.has(username)) {
        result.set(username, false)
      }
    }

    return result
  }

  private resolveAvatarFile(avatarUrl?: string): { data?: Buffer; sourcePath?: string; sourceUrl?: string; ext: string; mime?: string } | null {
    if (!avatarUrl) return null
    if (avatarUrl.startsWith('data:')) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(avatarUrl)
      if (!match) return null
      const mime = match[1].toLowerCase()
      const data = Buffer.from(match[2], 'base64')
      const ext = mime.includes('png') ? '.png'
        : mime.includes('gif') ? '.gif'
          : mime.includes('webp') ? '.webp'
            : '.jpg'
      return { data, ext, mime }
    }
    if (avatarUrl.startsWith('file://')) {
      try {
        const sourcePath = fileURLToPath(avatarUrl)
        const ext = path.extname(sourcePath) || '.jpg'
        return { sourcePath, ext }
      } catch {
        return null
      }
    }
    if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
      const url = new URL(avatarUrl)
      const ext = path.extname(url.pathname) || '.jpg'
      return { sourceUrl: avatarUrl, ext }
    }
    const sourcePath = avatarUrl
    const ext = path.extname(sourcePath) || '.jpg'
    return { sourcePath, ext }
  }

  private async downloadToBuffer(url: string, remainingRedirects = 2): Promise<{ data: Buffer; mime?: string } | null> {
    const client = url.startsWith('https:') ? https : http
    return new Promise((resolve) => {
      const request = client.get(url, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location && remainingRedirects > 0) {
          res.resume()
          const redirectedUrl = new URL(res.headers.location, url).href
          this.downloadToBuffer(redirectedUrl, remainingRedirects - 1)
            .then(resolve)
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          resolve(null)
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const data = Buffer.concat(chunks)
          const mime = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined
          resolve({ data, mime })
        })
      })
      request.on('error', () => resolve(null))
      request.setTimeout(15000, () => {
        request.destroy()
        resolve(null)
      })
    })
  }

  private async exportAvatars(
    members: Array<{ username: string; avatarUrl?: string }>
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (members.length === 0) return result

    // 直接使用 URL，不转换为 base64（与 ciphertalk 保持一致）
    for (const member of members) {
      if (member.avatarUrl) {
        result.set(member.username, member.avatarUrl)
      }
    }

    return result
  }

  /**
   * 导出头像为外部文件（仅用于HTML格式）
   * 将头像保存到 avatars/ 子目录，返回相对路径
   */
  private async exportAvatarsToFiles(
    members: Array<{ username: string; avatarUrl?: string }>,
    outputDir: string
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (members.length === 0) return result

    // 创建 avatars 子目录
    const avatarsDir = path.join(outputDir, 'avatars')
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true })
    }

    const AVATAR_CONCURRENCY = 8
    await parallelLimit(members, AVATAR_CONCURRENCY, async (member) => {
      const fileInfo = this.resolveAvatarFile(member.avatarUrl)
      if (!fileInfo) return
      try {
        let data: Buffer | null = null
        let mime = fileInfo.mime
        if (fileInfo.data) {
          data = fileInfo.data
        } else if (fileInfo.sourcePath && fs.existsSync(fileInfo.sourcePath)) {
          data = await fs.promises.readFile(fileInfo.sourcePath)
        } else if (fileInfo.sourceUrl) {
          const downloaded = await this.downloadToBuffer(fileInfo.sourceUrl)
          if (downloaded) {
            data = downloaded.data
            mime = downloaded.mime || mime
          }
        }
        if (!data) return

        // 优先使用内容检测出的 MIME 类型
        const detectedMime = this.detectMimeType(data)
        const finalMime = detectedMime || mime || this.inferImageMime(fileInfo.ext)

        // 根据 MIME 类型确定文件扩展名
        const ext = this.getExtensionFromMime(finalMime)

        // 清理用户名作为文件名（移除非法字符，限制长度）
        const sanitizedUsername = member.username
          .replace(/[<>:"/\\|?*@]/g, '_')
          .substring(0, 100)

        const filename = `${sanitizedUsername}${ext}`
        const avatarPath = path.join(avatarsDir, filename)

        // 跳过已存在文件
        try {
          await fs.promises.access(avatarPath)
        } catch {
          await fs.promises.writeFile(avatarPath, data)
        }

        // 返回相对路径
        result.set(member.username, `avatars/${filename}`)
      } catch {
        return
      }
    })

    return result
  }

  private getExtensionFromMime(mime: string): string {
    switch (mime) {
      case 'image/png':
        return '.png'
      case 'image/gif':
        return '.gif'
      case 'image/webp':
        return '.webp'
      case 'image/bmp':
        return '.bmp'
      case 'image/jpeg':
      default:
        return '.jpg'
    }
  }


  private detectMimeType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png'
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg'
    }

    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif'
    }

    // WEBP: RIFF ... WEBP
    if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp'
    }

    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return 'image/bmp'
    }

    return null
  }

  private inferImageMime(ext: string): string {
    switch (ext.toLowerCase()) {
      case '.png':
        return 'image/png'
      case '.gif':
        return 'image/gif'
      case '.webp':
        return 'image/webp'
      case '.bmp':
        return 'image/bmp'
      default:
        return 'image/jpeg'
    }
  }

  private getWeflowHeader(): { version: string; exportedAt: number; generator: string } {
    return {
      version: '1.0.3',
      exportedAt: Math.floor(Date.now() / 1000),
      generator: 'WeFlow'
    }
  }

  /**
   * 生成通用的导出元数据 (参考 ChatLab 格式)
   */
  private getExportMeta(
    sessionId: string,
    sessionInfo: { displayName: string },
    isGroup: boolean,
    sessionAvatar?: string
  ): { chatlab: ChatLabHeader; meta: ChatLabMeta } {
    return {
      chatlab: {
        version: '0.0.2',
        exportedAt: Math.floor(Date.now() / 1000),
        generator: 'WeFlow'
      },
      meta: {
        name: sessionInfo.displayName,
        platform: 'wechat',
        type: isGroup ? 'group' : 'private',
        ...(isGroup && { groupId: sessionId }),
        ...(sessionAvatar && { groupAvatar: sessionAvatar })
      }
    }
  }

  /**
   * 导出单个会话为 ChatLab 格式（并行优化版本）
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = String(this.configService.get('myWxid') || '').trim()

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)
      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )
      const allMessages = collected.rows

      // 如果没有消息,不创建文件
      if (allMessages.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? allMessages.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of allMessages) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      senderUsernames.add(cleanedMyWxid)
      await this.preloadContacts(senderUsernames, contactCache)

      if (isGroup) {
        this.throwIfStopRequested(control)
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      // ========== 获取群昵称并更新到 memberSet ==========
      const groupNicknameCandidates = isGroup
        ? this.buildGroupNicknameIdCandidates([
          ...Array.from(collected.memberSet.keys()),
          ...allMessages.map(msg => msg.senderUsername),
          cleanedMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      // 将群昵称更新到 memberSet 中
      if (isGroup && groupNicknamesMap.size > 0) {
        for (const [username, info] of collected.memberSet) {
          // 尝试多种方式查找群昵称（支持大小写）
          const groupNickname = this.resolveGroupNicknameByCandidates(groupNicknamesMap, [username]) || ''
          if (groupNickname) {
            info.member.groupNickname = groupNickname
          }
        }
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = exportMediaEnabled
        ? allMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||   // 图片
            (t === 47 && options.exportEmojis) ||  // 表情
            (t === 43 && options.exportVideos) ||  // 视频
            (t === 34 && options.exportVoices)  // 语音文件
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 20,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: `导出媒体 0/${mediaMessages.length}`
        })

        // 并行导出媒体，并发数跟随导出设置
        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 20,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: `导出媒体 ${mediaExported}/${mediaMessages.length}`
            })
          }
        })
      }

      // ========== 阶段2：并行语音转文字 ==========
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 40,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`
        })

        // 并行转写语音，限制 4 个并发（转写比较耗资源）
        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
          voiceTranscribed++
          onProgress?.({
            current: 40,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      // ========== 阶段3：构建消息列表 ==========
      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const chatLabMessages: ChatLabMessage[] = []
      const senderProfileMap = new Map<string, ExportDisplayProfile>()
      let messageIndex = 0
      for (const msg of allMessages) {
        if ((messageIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const memberInfo = collected.memberSet.get(msg.senderUsername)?.member || {
          platformId: msg.senderUsername,
          accountName: msg.senderUsername,
          groupNickname: undefined
        }

        // 如果 memberInfo 中没有群昵称，尝试从 groupNicknamesMap 获取
        const groupNickname = memberInfo.groupNickname
          || (isGroup ? this.resolveGroupNicknameByCandidates(groupNicknamesMap, [msg.senderUsername]) : '')
          || ''
        const senderProfile = isGroup
          ? await this.resolveExportDisplayProfile(
            msg.senderUsername || cleanedMyWxid,
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            msg.isSend ? (myInfo.displayName || cleanedMyWxid) : (memberInfo.accountName || msg.senderUsername || ''),
            msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
          )
          : {
            wxid: msg.senderUsername || cleanedMyWxid,
            nickname: memberInfo.accountName || msg.senderUsername || '',
            remark: '',
            alias: '',
            groupNickname,
            displayName: memberInfo.accountName || msg.senderUsername || ''
          }
        if (senderProfile.wxid && !senderProfileMap.has(senderProfile.wxid)) {
          senderProfileMap.set(senderProfile.wxid, senderProfile)
        }

        // 确定消息内容
        let content: string | null
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)
        if (msg.localType === 34 && options.exportVoiceAsText) {
          // 使用预先转写的文字
          content = voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]'
        } else if (mediaItem && msg.localType === 3) {
          content = mediaItem.relativePath
        } else {
          content = this.parseMessageContent(
            msg.content,
            msg.localType,
            sessionId,
            msg.createTime,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend
          )
        }

        // 转账消息：追加 "谁转账给谁" 信息
        if (content && this.isTransferExportContent(content) && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            content = this.appendTransferDesc(content, transferDesc)
          }
        }

        const message: ChatLabMessage = {
          sender: msg.senderUsername,
          accountName: senderProfile.displayName || memberInfo.accountName,
          groupNickname: (senderProfile.groupNickname || groupNickname) || undefined,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: content
        }

        // 如果有聊天记录，添加为嵌套字段
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const chatRecords: any[] = []

          for (const record of msg.chatRecordList) {
            // 解析时间戳 (格式: "YYYY-MM-DD HH:MM:SS")
            let recordTimestamp = msg.createTime
            if (record.sourcetime) {
              try {
                const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
                if (timeParts) {
                  const date = new Date(
                    parseInt(timeParts[1]),
                    parseInt(timeParts[2]) - 1,
                    parseInt(timeParts[3]),
                    parseInt(timeParts[4]),
                    parseInt(timeParts[5]),
                    parseInt(timeParts[6])
                  )
                  recordTimestamp = Math.floor(date.getTime() / 1000)
                }
              } catch (e) {
                console.error('解析聊天记录时间失败:', e)
              }
            }

            // 转换消息类型
            let recordType = 0 // TEXT
            let recordContent = record.datadesc || record.datatitle || ''

            switch (record.datatype) {
              case 1:
                recordType = 0 // TEXT
                break
              case 3:
                recordType = 1 // IMAGE
                recordContent = '[图片]'
                break
              case 8:
              case 49:
                recordType = 4 // FILE
                recordContent = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
                break
              case 34:
                recordType = 2 // VOICE
                recordContent = '[语音消息]'
                break
              case 43:
                recordType = 3 // VIDEO
                recordContent = '[视频]'
                break
              case 47:
                recordType = 5 // EMOJI
                recordContent = '[动画表情]'
                break
              default:
                recordType = 0
                recordContent = record.datadesc || record.datatitle || '[消息]'
            }

            const chatRecord: any = {
              sender: record.sourcename || 'unknown',
              accountName: record.sourcename || 'unknown',
              timestamp: recordTimestamp,
              type: recordType,
              content: recordContent
            }

            // 添加头像（如果启用导出头像）
            if (options.exportAvatars && record.sourceheadurl) {
              chatRecord.avatar = record.sourceheadurl
            }

            chatRecords.push(chatRecord)

            // 添加成员信息到 memberSet
            if (record.sourcename && !collected.memberSet.has(record.sourcename)) {
              const newMember: ChatLabMember = {
                platformId: record.sourcename,
                accountName: record.sourcename
              }
              if (options.exportAvatars && record.sourceheadurl) {
                newMember.avatar = record.sourceheadurl
              }
              collected.memberSet.set(record.sourcename, {
                member: newMember,
                avatarUrl: record.sourceheadurl
              })
            }
          }

          message.chatRecords = chatRecords
        }

        chatLabMessages.push(message)
      }

      const avatarMap = options.exportAvatars
        ? await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl }
          ]
        )
        : new Map<string, string>()

      const sessionAvatar = avatarMap.get(sessionId)
      const members = await Promise.all(Array.from(collected.memberSet.values()).map(async (info) => {
        const profile = isGroup
          ? (senderProfileMap.get(info.member.platformId) || await this.resolveExportDisplayProfile(
            info.member.platformId,
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            info.member.accountName || info.member.platformId,
            this.isSameWxid(info.member.platformId, cleanedMyWxid) ? [rawMyWxid, cleanedMyWxid] : []
          ))
          : null
        const member = profile
          ? {
            ...info.member,
            accountName: profile.displayName || info.member.accountName,
            groupNickname: profile.groupNickname || info.member.groupNickname
          }
          : info.member
        const avatar = avatarMap.get(info.member.platformId)
        return avatar ? { ...member, avatar } : member
      }))

      const { chatlab, meta } = this.getExportMeta(sessionId, sessionInfo, isGroup, sessionAvatar)

      const chatLabExport: ChatLabExport = {
        chatlab,
        meta,
        members,
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      if (options.format === 'chatlab-jsonl') {
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          this.throwIfStopRequested(control)
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          this.throwIfStopRequested(control)
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        this.throwIfStopRequested(control)
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        this.throwIfStopRequested(control)
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      if (this.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）- 并行优化版本
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = String(this.configService.get('myWxid') || '').trim()

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)
      const senderInfoMap = await this.preloadContactInfos([
        ...Array.from(senderUsernames.values()),
        cleanedMyWxid
      ])

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 阶段1：并行导出媒体文件 ==========
      const mediaMessages = exportMediaEnabled
        ? collected.rows.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 15,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: `导出媒体 0/${mediaMessages.length}`
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 15,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: `导出媒体 ${mediaExported}/${mediaMessages.length}`
            })
          }
        })
      }

      // ========== 阶段2：并行语音转文字 ==========
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 35,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`
        })

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
          voiceTranscribed++
          onProgress?.({
            current: 35,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      // ========== 预加载群昵称（用于名称显示偏好） ==========
      const groupNicknameCandidates = isGroup
        ? this.buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      // ========== 阶段3：构建消息列表 ==========
      onProgress?.({
        current: 55,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const allMessages: any[] = []
      const senderProfileMap = new Map<string, {
        displayName: string
        nickname: string
        remark: string
        groupNickname: string
      }>()
      const transferCandidates: Array<{ xml: string; messageRef: any }> = []
      let needSort = false
      let lastCreateTime = Number.NEGATIVE_INFINITY
      let messageIndex = 0
      for (const msg of collected.rows) {
        if ((messageIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const senderInfo = senderInfoMap.get(msg.senderUsername) || { displayName: msg.senderUsername || '' }
        const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
        const source = sourceMatch ? sourceMatch[0] : ''

        let content: string | null
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)

        if (msg.localType === 34 && options.exportVoiceAsText) {
          content = voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]'
        } else if (mediaItem) {
          content = mediaItem.relativePath
        } else {
          content = this.parseMessageContent(
            msg.content,
            msg.localType,
            undefined,
            undefined,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend
          )
        }

        // 获取发送者信息用于名称显示
        const senderWxid = msg.senderUsername
        const contact = senderWxid
          ? (contactCache.get(senderWxid) ?? { success: false as const })
          : { success: false as const }
        const senderNickname = contact.success && contact.contact?.nickName
          ? contact.contact.nickName
          : (senderInfo.displayName || senderWxid)
        const senderRemark = contact.success && contact.contact?.remark ? contact.contact.remark : ''
        const senderGroupNickname = this.resolveGroupNicknameByCandidates(groupNicknamesMap, [senderWxid])

        // 使用用户偏好的显示名称
        const senderDisplayName = this.getPreferredDisplayName(
          senderWxid,
          senderNickname,
          senderRemark,
          senderGroupNickname,
          options.displayNamePreference || 'remark'
        )
        const existingSenderProfile = senderProfileMap.get(senderWxid)
        if (!existingSenderProfile) {
          senderProfileMap.set(senderWxid, {
            displayName: senderDisplayName,
            nickname: senderNickname,
            remark: senderRemark,
            groupNickname: senderGroupNickname
          })
        }

        const msgObj: any = {
          localId: allMessages.length + 1,
          createTime: msg.createTime,
          formattedTime: this.formatTimestamp(msg.createTime),
          type: this.getMessageTypeName(msg.localType),
          localType: msg.localType,
          content,
          isSend: msg.isSend ? 1 : 0,
          senderUsername: msg.senderUsername,
          senderDisplayName,
          source,
          senderAvatarKey: msg.senderUsername
        }

        const appMsgMeta = this.extractArkmeAppMessageMeta(msg.content, msg.localType)
        if (appMsgMeta) {
          if (
            options.format === 'arkme-json' ||
            (options.format === 'json' && (
              appMsgMeta.appMsgKind === 'quote' ||
              appMsgMeta.appMsgKind === 'link' ||
              appMsgMeta.appMsgKind === 'chat-record'
            ))
          ) {
            Object.assign(msgObj, appMsgMeta)
          }
        }

        if (msg.chatRecordTitle) msgObj.chatRecordTitle = msg.chatRecordTitle
        if (msg.chatRecordList && msg.chatRecordList.length > 0) msgObj.chatRecordList = msg.chatRecordList

        if (options.format === 'arkme-json') {
          const contactCardMeta = this.extractArkmeContactCardMeta(msg.content, msg.localType)
          if (contactCardMeta) {
            Object.assign(msgObj, contactCardMeta)
          }
        }

        if (content && this.isTransferExportContent(content) && msg.content) {
          transferCandidates.push({ xml: msg.content, messageRef: msgObj })
        }

        // 位置消息：附加结构化位置字段
        if (msg.localType === 48) {
          if (msg.locationLat != null) msgObj.locationLat = msg.locationLat
          if (msg.locationLng != null) msgObj.locationLng = msg.locationLng
          if (msg.locationPoiname) msgObj.locationPoiname = msg.locationPoiname
          if (msg.locationLabel) msgObj.locationLabel = msg.locationLabel
        }

        allMessages.push(msgObj)
        if (msg.createTime < lastCreateTime) needSort = true
        lastCreateTime = msg.createTime
      }

      if (transferCandidates.length > 0) {
        const transferNameCache = new Map<string, string>()
        const transferNamePromiseCache = new Map<string, Promise<string>>()
        const resolveDisplayNameByUsername = async (username: string): Promise<string> => {
          if (!username) return username
          const cachedName = transferNameCache.get(username)
          if (cachedName) return cachedName
          const pending = transferNamePromiseCache.get(username)
          if (pending) return pending
          const task = (async () => {
            const contactResult = contactCache.get(username) ?? await getContactCached(username)
            if (contactResult.success && contactResult.contact) {
              return contactResult.contact.remark || contactResult.contact.nickName || contactResult.contact.alias || username
            }
            return username
          })()
          transferNamePromiseCache.set(username, task)
          const resolved = await task
          transferNamePromiseCache.delete(username)
          transferNameCache.set(username, resolved)
          return resolved
        }

        const transferConcurrency = this.getClampedConcurrency(options.exportConcurrency, 4, 8)
        await parallelLimit(transferCandidates, transferConcurrency, async (item) => {
          this.throwIfStopRequested(control)
          const transferDesc = await this.resolveTransferDesc(
            item.xml,
            cleanedMyWxid,
            groupNicknamesMap,
            resolveDisplayNameByUsername
          )
          if (transferDesc && typeof item.messageRef.content === 'string') {
            item.messageRef.content = this.appendTransferDesc(item.messageRef.content, transferDesc)
          }
        })
      }

      if (needSort) {
        allMessages.sort((a, b) => a.createTime - b.createTime)
      }

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      // 获取会话的昵称和备注信息
      const sessionContact = contactCache.get(sessionId) ?? await getContactCached(sessionId)
      const sessionNickname = sessionContact.success && sessionContact.contact?.nickName
        ? sessionContact.contact.nickName
        : sessionInfo.displayName
      const sessionRemark = sessionContact.success && sessionContact.contact?.remark
        ? sessionContact.contact.remark
        : ''
      const sessionGroupNickname = isGroup
        ? this.resolveGroupNicknameByCandidates(groupNicknamesMap, [sessionId])
        : ''

      // 使用用户偏好的显示名称
      const sessionDisplayName = this.getPreferredDisplayName(
        sessionId,
        sessionNickname,
        sessionRemark,
        sessionGroupNickname,
        options.displayNamePreference || 'remark'
      )

      const weflow = this.getWeflowHeader()
      if (options.format === 'arkme-json' && isGroup) {
        this.throwIfStopRequested(control)
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }

      const avatarMap = options.exportAvatars
        ? await this.exportAvatars(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl },
            { username: cleanedMyWxid, avatarUrl: myInfo.avatarUrl }
          ]
        )
        : new Map<string, string>()

      const sessionPayload: any = {
        wxid: sessionId,
        nickname: sessionNickname,
        remark: sessionRemark,
        displayName: sessionDisplayName,
        type: isGroup ? '群聊' : '私聊',
        lastTimestamp: collected.lastTime,
        messageCount: allMessages.length,
        avatar: avatarMap.get(sessionId)
      }

      if (options.format === 'arkme-json') {
        const senderIdMap = new Map<string, number>()
        const senders: Array<{
          senderID: number
          wxid: string
          displayName: string
          nickname: string
          remark?: string
          groupNickname?: string
          avatar?: string
        }> = []
        const ensureSenderId = (senderWxidRaw: string): number => {
          const senderWxid = String(senderWxidRaw || '').trim() || 'unknown'
          const existed = senderIdMap.get(senderWxid)
          if (existed) return existed

          const senderID = senders.length + 1
          senderIdMap.set(senderWxid, senderID)

          const profile = senderProfileMap.get(senderWxid)
          const senderItem: {
            senderID: number
            wxid: string
            displayName: string
            nickname: string
            remark?: string
            groupNickname?: string
            avatar?: string
          } = {
            senderID,
            wxid: senderWxid,
            displayName: profile?.displayName || senderWxid,
            nickname: profile?.nickname || profile?.displayName || senderWxid
          }
          if (profile?.remark) senderItem.remark = profile.remark
          if (profile?.groupNickname) senderItem.groupNickname = profile.groupNickname
          const avatar = avatarMap.get(senderWxid)
          if (avatar) senderItem.avatar = avatar

          senders.push(senderItem)
          return senderID
        }

        const compactMessages = allMessages.map((message) => {
          this.throwIfStopRequested(control)
          const senderID = ensureSenderId(String(message.senderUsername || ''))
          const compactMessage: any = {
            localId: message.localId,
            createTime: message.createTime,
            formattedTime: message.formattedTime,
            type: message.type,
            localType: message.localType,
            content: message.content,
            isSend: message.isSend,
            senderID,
            source: message.source
          }
          if (message.locationLat != null) compactMessage.locationLat = message.locationLat
          if (message.locationLng != null) compactMessage.locationLng = message.locationLng
          if (message.locationPoiname) compactMessage.locationPoiname = message.locationPoiname
          if (message.locationLabel) compactMessage.locationLabel = message.locationLabel
          if (message.appMsgType) compactMessage.appMsgType = message.appMsgType
          if (message.appMsgKind) compactMessage.appMsgKind = message.appMsgKind
          if (message.appMsgDesc) compactMessage.appMsgDesc = message.appMsgDesc
          if (message.appMsgAppName) compactMessage.appMsgAppName = message.appMsgAppName
          if (message.appMsgSourceName) compactMessage.appMsgSourceName = message.appMsgSourceName
          if (message.appMsgSourceUsername) compactMessage.appMsgSourceUsername = message.appMsgSourceUsername
          if (message.appMsgThumbUrl) compactMessage.appMsgThumbUrl = message.appMsgThumbUrl
          if (message.quotedContent) compactMessage.quotedContent = message.quotedContent
          if (message.quotedSender) compactMessage.quotedSender = message.quotedSender
          if (message.quotedType) compactMessage.quotedType = message.quotedType
          if (message.linkTitle) compactMessage.linkTitle = message.linkTitle
          if (message.linkUrl) compactMessage.linkUrl = message.linkUrl
          if (message.linkThumb) compactMessage.linkThumb = message.linkThumb
          if (message.finderTitle) compactMessage.finderTitle = message.finderTitle
          if (message.finderDesc) compactMessage.finderDesc = message.finderDesc
          if (message.finderUsername) compactMessage.finderUsername = message.finderUsername
          if (message.finderNickname) compactMessage.finderNickname = message.finderNickname
          if (message.finderCoverUrl) compactMessage.finderCoverUrl = message.finderCoverUrl
          if (message.finderAvatar) compactMessage.finderAvatar = message.finderAvatar
          if (message.finderDuration != null) compactMessage.finderDuration = message.finderDuration
          if (message.finderObjectId) compactMessage.finderObjectId = message.finderObjectId
          if (message.finderUrl) compactMessage.finderUrl = message.finderUrl
          if (message.musicTitle) compactMessage.musicTitle = message.musicTitle
          if (message.musicUrl) compactMessage.musicUrl = message.musicUrl
          if (message.musicDataUrl) compactMessage.musicDataUrl = message.musicDataUrl
          if (message.musicAlbumUrl) compactMessage.musicAlbumUrl = message.musicAlbumUrl
          if (message.musicCoverUrl) compactMessage.musicCoverUrl = message.musicCoverUrl
          if (message.musicSinger) compactMessage.musicSinger = message.musicSinger
          if (message.musicAppName) compactMessage.musicAppName = message.musicAppName
          if (message.musicSourceName) compactMessage.musicSourceName = message.musicSourceName
          if (message.musicDuration != null) compactMessage.musicDuration = message.musicDuration
          if (message.cardKind) compactMessage.cardKind = message.cardKind
          if (message.contactCardWxid) compactMessage.contactCardWxid = message.contactCardWxid
          if (message.contactCardNickname) compactMessage.contactCardNickname = message.contactCardNickname
          if (message.contactCardAlias) compactMessage.contactCardAlias = message.contactCardAlias
          if (message.contactCardRemark) compactMessage.contactCardRemark = message.contactCardRemark
          if (message.contactCardGender != null) compactMessage.contactCardGender = message.contactCardGender
          if (message.contactCardProvince) compactMessage.contactCardProvince = message.contactCardProvince
          if (message.contactCardCity) compactMessage.contactCardCity = message.contactCardCity
          if (message.contactCardSignature) compactMessage.contactCardSignature = message.contactCardSignature
          if (message.contactCardAvatar) compactMessage.contactCardAvatar = message.contactCardAvatar
          if (message.chatRecordTitle) compactMessage.chatRecordTitle = message.chatRecordTitle
          if (message.chatRecordList) compactMessage.chatRecordList = message.chatRecordList
          return compactMessage
        })

        const arkmeSession: any = {
          ...sessionPayload
        }
        let groupMembers: Array<{
          wxid: string
          displayName: string
          nickname: string
          remark: string
          alias: string
          groupNickname?: string
          isFriend: boolean
          messageCount: number
          avatar?: string
        }> | undefined

        if (isGroup) {
          const memberUsernames = Array.from(collected.memberSet.keys()).filter(Boolean)
          await this.preloadContacts(memberUsernames, contactCache)
          const friendLookupUsernames = this.buildGroupNicknameIdCandidates(memberUsernames)
          const friendFlagMap = await this.queryFriendFlagMap(friendLookupUsernames)
          const groupStatsResult = await wcdbService.getGroupStats(sessionId, 0, 0)
          const groupSenderCountMap = groupStatsResult.success && groupStatsResult.data
            ? this.extractGroupSenderCountMap(groupStatsResult.data, sessionId)
            : new Map<string, number>()

          groupMembers = []
          for (const memberWxid of memberUsernames) {
            this.throwIfStopRequested(control)
            const member = collected.memberSet.get(memberWxid)?.member
            const contactResult = await getContactCached(memberWxid)
            const contact = contactResult.success ? contactResult.contact : null
            const nickname = String(contact?.nickName || contact?.nick_name || member?.accountName || memberWxid)
            const remark = String(contact?.remark || '')
            const alias = String(contact?.alias || '')
            const groupNickname = member?.groupNickname || this.resolveGroupNicknameByCandidates(
              groupNicknamesMap,
              [memberWxid, contact?.username, contact?.userName, contact?.encryptUsername, contact?.encryptUserName, alias]
            ) || ''
            const displayName = this.getPreferredDisplayName(
              memberWxid,
              nickname,
              remark,
              groupNickname,
              options.displayNamePreference || 'remark'
            )

            const groupMember: {
              wxid: string
              displayName: string
              nickname: string
              remark: string
              alias: string
              groupNickname?: string
              isFriend: boolean
              messageCount: number
              avatar?: string
            } = {
              wxid: memberWxid,
              displayName,
              nickname,
              remark,
              alias,
              isFriend: this.buildGroupNicknameIdCandidates([memberWxid]).some((candidate) => friendFlagMap.get(candidate) === true),
              messageCount: this.sumSenderCountsByIdentity(groupSenderCountMap, memberWxid)
            }
            if (groupNickname) groupMember.groupNickname = groupNickname
            const avatar = avatarMap.get(memberWxid)
            if (avatar) groupMember.avatar = avatar
            groupMembers.push(groupMember)
          }
          groupMembers.sort((a, b) => {
            if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount
            return String(a.displayName || a.wxid).localeCompare(String(b.displayName || b.wxid), 'zh-CN')
          })
        }

        const arkmeExport: any = {
          weflow: {
            ...weflow,
            format: 'arkme-json'
          },
          session: arkmeSession,
          senders,
          messages: compactMessages
        }
        if (groupMembers) {
          arkmeExport.groupMembers = groupMembers
        }

        this.throwIfStopRequested(control)
        fs.writeFileSync(outputPath, JSON.stringify(arkmeExport, null, 2), 'utf-8')
      } else {
        const detailedExport: any = {
          weflow,
          session: sessionPayload,
          messages: allMessages
        }

        if (options.exportAvatars) {
          const avatars: Record<string, string> = {}
          for (const [username, relPath] of avatarMap.entries()) {
            avatars[username] = relPath
          }
          if (Object.keys(avatars).length > 0) {
            detailedExport.session = {
              ...detailedExport.session,
              avatar: avatars[sessionId]
            }
            ; (detailedExport as any).avatars = avatars
          }
        }

        this.throwIfStopRequested(control)
        fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      if (this.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 Excel 格式（参考 echotrace 格式）
   */
  async exportSessionToExcel(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = String(this.configService.get('myWxid') || '').trim()

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      // 获取会话的备注信息
      const sessionContact = await getContactCached(sessionId)
      const sessionRemark = sessionContact.success && sessionContact.contact?.remark ? sessionContact.contact.remark : ''
      const sessionNickname = sessionContact.success && sessionContact.contact?.nickName ? sessionContact.contact.nickName : sessionId

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      onProgress?.({
        current: 30,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      // 创建 Excel 工作簿
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'WeFlow'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('聊天记录')

      let currentRow = 1

      const useCompactColumns = options.excelCompactColumns === true

      // 第一行：会话信息标题
      const titleCell = worksheet.getCell(currentRow, 1)
      titleCell.value = '会话信息'
      titleCell.font = { name: 'Calibri', bold: true, size: 11 }
      titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
      worksheet.getRow(currentRow).height = 25
      currentRow++

      // 第二行：会话详细信息
      worksheet.getCell(currentRow, 1).value = '微信ID'
      worksheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.mergeCells(currentRow, 2, currentRow, 3)
      worksheet.getCell(currentRow, 2).value = sessionId
      worksheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 11 }

      worksheet.getCell(currentRow, 4).value = '昵称'
      worksheet.getCell(currentRow, 4).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 5).value = sessionNickname
      worksheet.getCell(currentRow, 5).font = { name: 'Calibri', size: 11 }

      if (isGroup) {
        worksheet.getCell(currentRow, 6).value = '备注'
        worksheet.getCell(currentRow, 6).font = { name: 'Calibri', bold: true, size: 11 }
        worksheet.mergeCells(currentRow, 7, currentRow, 8)
        worksheet.getCell(currentRow, 7).value = sessionRemark
        worksheet.getCell(currentRow, 7).font = { name: 'Calibri', size: 11 }
      }
      worksheet.getRow(currentRow).height = 20
      currentRow++

      // 第三行：导出元数据
      const { chatlab, meta: exportMeta } = this.getExportMeta(sessionId, sessionInfo, isGroup)
      worksheet.getCell(currentRow, 1).value = '导出工具'
      worksheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 2).value = chatlab.generator
      worksheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 10 }

      worksheet.getCell(currentRow, 3).value = '导出版本'
      worksheet.getCell(currentRow, 3).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 4).value = chatlab.version
      worksheet.getCell(currentRow, 4).font = { name: 'Calibri', size: 10 }

      worksheet.getCell(currentRow, 5).value = '平台'
      worksheet.getCell(currentRow, 5).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 6).value = exportMeta.platform
      worksheet.getCell(currentRow, 6).font = { name: 'Calibri', size: 10 }

      worksheet.getCell(currentRow, 7).value = '导出时间'
      worksheet.getCell(currentRow, 7).font = { name: 'Calibri', bold: true, size: 11 }
      worksheet.getCell(currentRow, 8).value = this.formatTimestamp(chatlab.exportedAt)
      worksheet.getCell(currentRow, 8).font = { name: 'Calibri', size: 10 }

      worksheet.getRow(currentRow).height = 20
      currentRow++

      // 表头行
      const headers = useCompactColumns
        ? ['序号', '时间', '发送者身份', '消息类型', '内容']
        : ['序号', '时间', '发送者昵称', '发送者微信ID', '发送者备注', '群昵称', '发送者身份', '消息类型', '内容']
      const headerRow = worksheet.getRow(currentRow)
      headerRow.height = 22

      headers.forEach((header, index) => {
        const cell = headerRow.getCell(index + 1)
        cell.value = header
        cell.font = { name: 'Calibri', bold: true, size: 11 }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE8F5E9' }
        }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
      })
      currentRow++

      // 设置列宽
      worksheet.getColumn(1).width = 8   // 序号
      worksheet.getColumn(2).width = 20  // 时间
      if (useCompactColumns) {
        worksheet.getColumn(3).width = 18  // 发送者身份
        worksheet.getColumn(4).width = 12  // 消息类型
        worksheet.getColumn(5).width = 50  // 内容
      } else {
        worksheet.getColumn(3).width = 18  // 发送者昵称
        worksheet.getColumn(4).width = 25  // 发送者微信ID
        worksheet.getColumn(5).width = 18  // 发送者备注
        worksheet.getColumn(6).width = 18  // 群昵称
        worksheet.getColumn(7).width = 15  // 发送者身份
        worksheet.getColumn(8).width = 12  // 消息类型
        worksheet.getColumn(9).width = 50  // 内容
      }

      // 预加载群昵称 (仅群聊且完整列模式)
      const groupNicknameCandidates = isGroup
        ? this.buildGroupNicknameIdCandidates([
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()


      // 填充数据
      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      // 媒体导出设置
      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)

      // ========== 并行预处理：媒体文件 ==========
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 35,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: `导出媒体 0/${mediaMessages.length}`
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 35,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: `导出媒体 ${mediaExported}/${mediaMessages.length}`
            })
          }
        })
      }

      // ========== 并行预处理：语音转文字 ==========
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 50,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`
        })

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
          voiceTranscribed++
          onProgress?.({
            current: 50,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      onProgress?.({
        current: 65,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      // ========== 写入 Excel 行 ==========
      for (let i = 0; i < sortedMessages.length; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]

        // 确定发送者信息
        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark: string = ''
        let senderGroupNickname: string = ''  // 群昵称

        if (isGroup) {
          const senderProfile = await this.resolveExportDisplayProfile(
            msg.isSend ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid),
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            msg.isSend ? (myInfo.displayName || cleanedMyWxid) : (msg.senderUsername || ''),
            msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
          )
          senderWxid = senderProfile.wxid
          senderNickname = senderProfile.nickname
          senderRemark = senderProfile.remark
          senderGroupNickname = senderProfile.groupNickname
          senderRole = senderProfile.displayName
        } else if (msg.isSend) {
          // 我发送的消息
          senderRole = '我'
          senderWxid = cleanedMyWxid
          senderNickname = myInfo.displayName || cleanedMyWxid
          senderRemark = ''
        } else {
          // 单聊对方消息 - 用 getContact 获取联系人详情
          senderWxid = sessionId
          const contactDetail = await getContactCached(sessionId)
          if (contactDetail.success && contactDetail.contact) {
            senderNickname = contactDetail.contact.nickName || sessionId
            senderRemark = contactDetail.contact.remark || ''
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = sessionInfo.displayName || sessionId
            senderRemark = ''
            senderRole = senderNickname
          }
        }

        const row = worksheet.getRow(currentRow)
        row.height = 24

        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const contentValue = shouldUseTranscript
          ? this.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(msg.localId),
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend
          )
          : (mediaItem?.relativePath
            || this.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(msg.localId),
              cleanedMyWxid,
              msg.senderUsername,
              msg.isSend
            ))

        // 转账消息：追加 "谁转账给谁" 信息
        let enrichedContentValue = contentValue
        if (this.isTransferExportContent(contentValue) && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username) => {
              const c = await getContactCached(username)
              if (c.success && c.contact) {
                return c.contact.remark || c.contact.nickName || c.contact.alias || username
              }
              return username
            }
          )
          if (transferDesc) {
            enrichedContentValue = this.appendTransferDesc(contentValue, transferDesc)
          }
        }
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          enrichedContentValue = this.formatChatRecordPlainText({
            title: msg.chatRecordTitle,
            records: msg.chatRecordList
          })
        }

        // 调试日志
        if (msg.localType === 3 || msg.localType === 47) {
        }

        worksheet.getCell(currentRow, 1).value = i + 1
        worksheet.getCell(currentRow, 2).value = this.formatTimestamp(msg.createTime)
        if (useCompactColumns) {
          worksheet.getCell(currentRow, 3).value = senderRole
          worksheet.getCell(currentRow, 4).value = this.getMessageTypeName(msg.localType)
          worksheet.getCell(currentRow, 5).value = enrichedContentValue
        } else {
          worksheet.getCell(currentRow, 3).value = senderNickname
          worksheet.getCell(currentRow, 4).value = senderWxid
          worksheet.getCell(currentRow, 5).value = senderRemark
          worksheet.getCell(currentRow, 6).value = senderGroupNickname
          worksheet.getCell(currentRow, 7).value = senderRole
          worksheet.getCell(currentRow, 8).value = this.getMessageTypeName(msg.localType)
          worksheet.getCell(currentRow, 9).value = enrichedContentValue
        }

        // 设置每个单元格的样式
        const maxColumns = useCompactColumns ? 5 : 9
        for (let col = 1; col <= maxColumns; col++) {
          const cell = worksheet.getCell(currentRow, col)
          cell.font = { name: 'Calibri', size: 11 }
          const hasMultiline = typeof cell.value === 'string' && String(cell.value).includes('\n')
          cell.alignment = { vertical: 'middle', wrapText: hasMultiline }
        }

        currentRow++

        // 每处理 100 条消息报告一次进度
        if ((i + 1) % 100 === 0) {
          const progress = 30 + Math.floor((i + 1) / sortedMessages.length * 50)
          onProgress?.({
            current: progress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({
        current: 90,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      // 写入文件
      this.throwIfStopRequested(control)
      await workbook.xlsx.writeFile(outputPath)

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      if (this.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      // 处理文件被占用的错误
      if (e instanceof Error) {
        if (e.message.includes('EBUSY') || e.message.includes('resource busy') || e.message.includes('locked')) {
          return { success: false, error: '文件已经打开，请关闭后再导出' }
        }
      }

      return { success: false, error: String(e) }
    }
  }

  /**
    * 确保语音转写模型已下载
    */
  private async ensureVoiceModel(onProgress?: (progress: ExportProgress) => void): Promise<boolean> {
    try {
      const status = await voiceTranscribeService.getModelStatus()
      if (status.success && status.exists) {
        return true
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: '正在下载 AI 模型',
        phase: 'preparing'
      })

      const downloadResult = await voiceTranscribeService.downloadModel((progress: any) => {
        if (progress.percent !== undefined) {
          onProgress?.({
            current: progress.percent,
            total: 100,
            currentSession: `正在下载 AI 模型 (${progress.percent.toFixed(0)}%)`,
            phase: 'preparing'
          })
        }
      })

      return downloadResult.success
    } catch (e) {
      console.error('Auto download model failed:', e)
      return false
    }
  }

  /**
   * 导出单个会话为 TXT 格式（默认与 Excel 精简列一致）
   */
  async exportSessionToTxt(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = String(this.configService.get('myWxid') || '').trim()
      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const voiceMessages = options.exportVoiceAsText
        ? collected.rows.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      // 获取群昵称（用于转账描述等）
      const groupNicknameCandidates = isGroup
        ? this.buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 25,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: `导出媒体 0/${mediaMessages.length}`
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 25,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: `导出媒体 ${mediaExported}/${mediaMessages.length}`
            })
          }
        })
      }

      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 45,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`
        })

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
          voiceTranscribed++
          onProgress?.({
            current: 45,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const lines: string[] = []

      for (let i = 0; i < sortedMessages.length; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const contentValue = shouldUseTranscript
          ? this.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(msg.localId),
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend
          )
          : (mediaItem?.relativePath
            || this.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(msg.localId),
              cleanedMyWxid,
              msg.senderUsername,
              msg.isSend
            ))

        // 转账消息：追加 "谁转账给谁" 信息
        let enrichedContentValue = contentValue
        if (this.isTransferExportContent(contentValue) && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username) => {
              const c = await getContactCached(username)
              if (c.success && c.contact) {
                return c.contact.remark || c.contact.nickName || c.contact.alias || username
              }
              return username
            }
          )
          if (transferDesc) {
            enrichedContentValue = this.appendTransferDesc(contentValue, transferDesc)
          }
        }
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          enrichedContentValue = this.formatChatRecordPlainText({
            title: msg.chatRecordTitle,
            records: msg.chatRecordList
          })
        }

        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark = ''

        if (isGroup) {
          const senderProfile = await this.resolveExportDisplayProfile(
            msg.isSend ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid),
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            msg.isSend ? (myInfo.displayName || cleanedMyWxid) : (msg.senderUsername || ''),
            msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
          )
          senderWxid = senderProfile.wxid
          senderNickname = senderProfile.nickname
          senderRemark = senderProfile.remark
          senderRole = senderProfile.displayName
        } else if (msg.isSend) {
          senderRole = '我'
          senderWxid = cleanedMyWxid
          senderNickname = myInfo.displayName || cleanedMyWxid
        } else {
          senderWxid = sessionId
          const contactDetail = await getContactCached(sessionId)
          if (contactDetail.success && contactDetail.contact) {
            senderNickname = contactDetail.contact.nickName || sessionId
            senderRemark = contactDetail.contact.remark || ''
            senderRole = senderRemark || senderNickname
          } else {
            senderNickname = sessionInfo.displayName || sessionId
            senderRole = senderNickname
          }
        }

        lines.push(`${this.formatTimestamp(msg.createTime)} '${senderRole}'`)
        lines.push(enrichedContentValue)
        lines.push('')

        if ((i + 1) % 200 === 0) {
          const progress = 60 + Math.floor((i + 1) / sortedMessages.length * 30)
          onProgress?.({
            current: progress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({
        current: 92,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      this.throwIfStopRequested(control)
      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      if (this.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 WeClone CSV 格式
   */
  async exportSessionToWeCloneCsv(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = String(this.configService.get('myWxid') || '').trim()
      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      const groupNicknameCandidates = isGroup
        ? this.buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      const voiceMessages = options.exportVoiceAsText
        ? sortedMessages.filter(msg => msg.localType === 34)
        : []

      if (options.exportVoiceAsText && voiceMessages.length > 0) {
        await this.ensureVoiceModel(onProgress)
      }

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 43 && options.exportVideos) ||
            (t === 34 && options.exportVoices)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 25,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: `导出媒体 0/${mediaMessages.length}`
        })

        const mediaConcurrency = this.getClampedConcurrency(options.exportConcurrency)
        let mediaExported = 0
        await parallelLimit(mediaMessages, mediaConcurrency, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportVideos: options.exportVideos,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 25,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: `导出媒体 ${mediaExported}/${mediaMessages.length}`
            })
          }
        })
      }

      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 45,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`
        })

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
          voiceTranscribed++
          onProgress?.({
            current: 45,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const lines: string[] = []
      lines.push('id,MsgSvrID,type_name,is_sender,talker,msg,src,CreateTime')

      for (let i = 0; i < sortedMessages.length; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey) || null

        const typeName = this.getWeCloneTypeName(msg.localType, msg.content || '')
        let senderWxid = cleanedMyWxid
        if (!msg.isSend) {
          senderWxid = isGroup && msg.senderUsername
            ? msg.senderUsername
            : sessionId
        }

        let talker = myInfo.displayName || '我'
        if (isGroup) {
          const senderProfile = await this.resolveExportDisplayProfile(
            msg.isSend ? cleanedMyWxid : senderWxid,
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            msg.isSend ? (myInfo.displayName || cleanedMyWxid) : senderWxid,
            msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
          )
          talker = senderProfile.displayName
        } else if (!msg.isSend) {
          const contactDetail = await getContactCached(senderWxid)
          const senderNickname = contactDetail.success && contactDetail.contact
            ? (contactDetail.contact.nickName || senderWxid)
            : senderWxid
          const senderRemark = contactDetail.success && contactDetail.contact
            ? (contactDetail.contact.remark || '')
            : ''
          const senderGroupNickname = isGroup
            ? this.resolveGroupNicknameByCandidates(groupNicknamesMap, [senderWxid])
            : ''
          talker = this.getPreferredDisplayName(
            senderWxid,
            senderNickname,
            senderRemark,
            senderGroupNickname,
            options.displayNamePreference || 'remark'
          )
        }

        const msgText = msg.localType === 34 && options.exportVoiceAsText
          ? (voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]')
          : (this.parseMessageContent(
            msg.content,
            msg.localType,
            sessionId,
            msg.createTime,
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend
          ) || '')
        const enrichedMsgText = msg.chatRecordList && msg.chatRecordList.length > 0
          ? this.formatChatRecordPlainText({
            title: msg.chatRecordTitle,
            records: msg.chatRecordList
          })
          : msgText
        const src = this.getWeCloneSource(msg, typeName, mediaItem)

        const row = [
          i + 1,
          i + 1,
          typeName,
          msg.isSend ? 1 : 0,
          talker,
          enrichedMsgText,
          src,
          this.formatIsoTimestamp(msg.createTime)
        ]

        lines.push(row.map((value) => this.escapeCsvCell(value)).join(','))

        if ((i + 1) % 200 === 0) {
          const progress = 60 + Math.floor((i + 1) / sortedMessages.length * 30)
          onProgress?.({
            current: progress,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({
        current: 92,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      this.throwIfStopRequested(control)
      fs.writeFileSync(outputPath, `\uFEFF${lines.join('\r\n')}`, 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      if (this.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      return { success: false, error: String(e) }
    }
  }

  private getVirtualScrollScript(): string {
    return `
      class ChunkedRenderer {
        constructor(container, data, renderItem) {
          this.container = container;
          this.data = data;
          this.renderItem = renderItem;
          this.batchSize = 100;
          this.rendered = 0;
          this.loading = false;

          this.list = document.createElement('div');
          this.list.className = 'message-list';
          this.container.appendChild(this.list);

          this.sentinel = document.createElement('div');
          this.sentinel.className = 'load-sentinel';
          this.container.appendChild(this.sentinel);

          this.renderBatch();

          this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.loading) {
              this.renderBatch();
            }
          }, { root: this.container, rootMargin: '600px' });
          this.observer.observe(this.sentinel);
        }

        renderBatch() {
          if (this.rendered >= this.data.length) return;
          this.loading = true;
          const end = Math.min(this.rendered + this.batchSize, this.data.length);
          const fragment = document.createDocumentFragment();
          for (let i = this.rendered; i < end; i++) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = this.renderItem(this.data[i], i);
            if (wrapper.firstElementChild) fragment.appendChild(wrapper.firstElementChild);
          }
          this.list.appendChild(fragment);
          this.rendered = end;
          this.loading = false;
        }

        setData(newData) {
          this.data = newData;
          this.rendered = 0;
          this.list.innerHTML = '';
          this.container.scrollTop = 0;
          if (this.data.length === 0) {
            this.list.innerHTML = '<div class="empty">暂无消息</div>';
            return;
          }
          this.renderBatch();
        }

        scrollToTime(timestamp) {
          const idx = this.data.findIndex(item => item.t >= timestamp);
          if (idx === -1) return;
          // Ensure all messages up to target are rendered
          while (this.rendered <= idx) {
            this.renderBatch();
          }
          const el = this.list.children[idx];
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('highlight');
            setTimeout(() => el.classList.remove('highlight'), 2500);
          }
        }

        scrollToIndex(index) {
          while (this.rendered <= index) {
            this.renderBatch();
          }
          const el = this.list.children[index];
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
    `;
  }

  /**
   * 导出单个会话为 HTML 格式
   */
  async exportSessionToHtml(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.throwIfStopRequested(control)
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')
      const rawMyWxid = String(this.configService.get('myWxid') || '').trim()
      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)
      const contactCache = new Map<string, { success: boolean; contact?: any; error?: string }>()
      const getContactCached = async (username: string) => {
        if (contactCache.has(username)) {
          return contactCache.get(username)!
        }
        const result = await wcdbService.getContact(username)
        contactCache.set(username, result)
        return result
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      if (options.exportVoiceAsText) {
        await this.ensureVoiceModel(onProgress)
      }

      const collectParams = this.resolveCollectParams(options)
      const collectProgressReporter = this.createCollectProgressReporter(sessionInfo.displayName, onProgress, 5)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        collectParams.mode,
        collectParams.targetMediaTypes,
        control,
        collectProgressReporter
      )

      // 如果没有消息,不创建文件
      if (collected.rows.length === 0) {
        return { success: false, error: '该会话在指定时间范围内没有消息' }
      }

      const senderUsernames = new Set<string>()
      let senderScanIndex = 0
      for (const msg of collected.rows) {
        if ((senderScanIndex++ & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        if (msg.senderUsername) senderUsernames.add(msg.senderUsername)
      }
      senderUsernames.add(sessionId)
      await this.preloadContacts(senderUsernames, contactCache)

      const groupNicknameCandidates = isGroup
        ? this.buildGroupNicknameIdCandidates([
          ...Array.from(senderUsernames.values()),
          ...collected.rows.map(msg => msg.senderUsername),
          cleanedMyWxid,
          rawMyWxid
        ])
        : []
      const groupNicknamesMap = isGroup
        ? await this.getGroupNicknamesForRoom(sessionId, groupNicknameCandidates)
        : new Map<string, string>()

      if (isGroup) {
        this.throwIfStopRequested(control)
        await this.mergeGroupMembers(sessionId, collected.memberSet, options.exportAvatars === true)
      }
      const sortedMessages = collected.rows.sort((a, b) => a.createTime - b.createTime)

      const { exportMediaEnabled, mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
      const mediaMessages = exportMediaEnabled
        ? sortedMessages.filter(msg => {
          const t = msg.localType
          return (t === 3 && options.exportImages) ||
            (t === 47 && options.exportEmojis) ||
            (t === 34 && options.exportVoices) ||
            (t === 43 && options.exportVideos)
        })
        : []

      const mediaCache = new Map<string, MediaExportItem | null>()

      if (mediaMessages.length > 0) {
        onProgress?.({
          current: 20,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-media',
          phaseProgress: 0,
          phaseTotal: mediaMessages.length,
          phaseLabel: `导出媒体 0/${mediaMessages.length}`
        })

        const MEDIA_CONCURRENCY = 6
        let mediaExported = 0
        await parallelLimit(mediaMessages, MEDIA_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const mediaKey = `${msg.localType}_${msg.localId}`
          if (!mediaCache.has(mediaKey)) {
            const mediaItem = await this.exportMediaForMessage(msg, sessionId, mediaRootDir, mediaRelativePrefix, {
              exportImages: options.exportImages,
              exportVoices: options.exportVoices,
              exportEmojis: options.exportEmojis,
              exportVoiceAsText: options.exportVoiceAsText,
              includeVoiceWithTranscript: true,
              exportVideos: options.exportVideos
            })
            mediaCache.set(mediaKey, mediaItem)
          }
          mediaExported++
          if (mediaExported % 5 === 0 || mediaExported === mediaMessages.length) {
            onProgress?.({
              current: 20,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'exporting-media',
              phaseProgress: mediaExported,
              phaseTotal: mediaMessages.length,
              phaseLabel: `导出媒体 ${mediaExported}/${mediaMessages.length}`
            })
          }
        })
      }

      const useVoiceTranscript = options.exportVoiceAsText === true
      const voiceMessages = useVoiceTranscript
        ? sortedMessages.filter(msg => msg.localType === 34)
        : []
      const voiceTranscriptMap = new Map<number, string>()

      if (voiceMessages.length > 0) {
        onProgress?.({
          current: 40,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting-voice',
          phaseProgress: 0,
          phaseTotal: voiceMessages.length,
          phaseLabel: `语音转文字 0/${voiceMessages.length}`
        })

        const VOICE_CONCURRENCY = 4
        let voiceTranscribed = 0
        await parallelLimit(voiceMessages, VOICE_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const transcript = await this.transcribeVoice(sessionId, String(msg.localId), msg.createTime, msg.senderUsername)
          voiceTranscriptMap.set(msg.localId, transcript)
          voiceTranscribed++
          onProgress?.({
            current: 40,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'exporting-voice',
            phaseProgress: voiceTranscribed,
            phaseTotal: voiceMessages.length,
            phaseLabel: `语音转文字 ${voiceTranscribed}/${voiceMessages.length}`
          })
        })
      }

      const avatarMap = options.exportAvatars
        ? await this.exportAvatarsToFiles(
          [
            ...Array.from(collected.memberSet.entries()).map(([username, info]) => ({
              username,
              avatarUrl: info.avatarUrl
            })),
            { username: sessionId, avatarUrl: sessionInfo.avatarUrl },
            { username: cleanedMyWxid, avatarUrl: myInfo.avatarUrl }
          ],
          path.dirname(outputPath)
        )
        : new Map<string, string>()

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      // ================= BEGIN STREAM WRITING =================
      const exportMeta = this.getExportMeta(sessionId, sessionInfo, isGroup)
      const htmlStyles = this.loadExportHtmlStyles()
      const stream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })

      const writePromise = (str: string) => {
        return new Promise<void>((resolve, reject) => {
          this.throwIfStopRequested(control)
          if (!stream.write(str)) {
            stream.once('drain', resolve)
          } else {
            resolve()
          }
        })
      }

      await writePromise(`<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${this.escapeHtml(sessionInfo.displayName)} - 聊天记录</title>
    <style>${htmlStyles}</style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <h1 class="title">${this.escapeHtml(sessionInfo.displayName)}</h1>
        <div class="meta">
          <span>${sortedMessages.length} 条消息</span>
          <span>${isGroup ? '群聊' : '私聊'}</span>
          <span>${this.escapeHtml(this.formatTimestamp(exportMeta.chatlab.exportedAt))}</span>
        </div>
        <div class="controls">
          <input id="searchInput" type="search" placeholder="搜索消息..." />
          <input id="timeInput" type="datetime-local" />
          <button id="jumpBtn" type="button">跳转</button>
          <div class="stats">
            <span id="resultCount">共 ${sortedMessages.length} 条</span>
          </div>
        </div>
      </div>
      
      <div id="scrollContainer" class="scroll-container"></div>
      
    </div>
    
    <div class="image-preview" id="imagePreview">
      <img id="imagePreviewTarget" alt="预览" />
    </div>

    <!-- Data Injection -->
    <script>
      window.WEFLOW_DATA = [
`);

      // Pre-build avatar HTML lookup to avoid per-message rebuilds
      const avatarHtmlCache = new Map<string, string>()
      const getAvatarHtml = (username: string, name: string): string => {
        const cached = avatarHtmlCache.get(username)
        if (cached !== undefined) return cached
        const avatarData = avatarMap.get(username)
        const html = avatarData
          ? `<img src="${this.escapeAttribute(encodeURI(avatarData))}" alt="${this.escapeAttribute(name)}" />`
          : `<span>${this.escapeHtml(this.getAvatarFallback(name))}</span>`
        avatarHtmlCache.set(username, html)
        return html
      }

      // Write messages in buffered chunks
      const WRITE_BATCH = 100
      let writeBuf: string[] = []

      for (let i = 0; i < sortedMessages.length; i++) {
        if ((i & 0x7f) === 0) {
          this.throwIfStopRequested(control)
        }
        const msg = sortedMessages[i]
        const mediaKey = `${msg.localType}_${msg.localId}`
        const mediaItem = mediaCache.get(mediaKey) || null

        const isSenderMe = msg.isSend
        const senderInfo = collected.memberSet.get(msg.senderUsername)?.member
        const senderName = isGroup
          ? (await this.resolveExportDisplayProfile(
            isSenderMe ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid),
            options.displayNamePreference,
            getContactCached,
            groupNicknamesMap,
            isSenderMe ? (myInfo.displayName || cleanedMyWxid) : (senderInfo?.accountName || msg.senderUsername || ''),
            isSenderMe ? [rawMyWxid, cleanedMyWxid] : []
          )).displayName
          : (isSenderMe ? (myInfo.displayName || '我') : (sessionInfo.displayName || sessionId))

        const avatarHtml = getAvatarHtml(isSenderMe ? cleanedMyWxid : msg.senderUsername, senderName)

        const timeText = this.formatTimestamp(msg.createTime)
        const typeName = this.getMessageTypeName(msg.localType)

        let textContent = this.formatHtmlMessageText(
          msg.content,
          msg.localType,
          cleanedMyWxid,
          msg.senderUsername,
          msg.isSend
        )
        if (msg.localType === 34 && useVoiceTranscript) {
          textContent = voiceTranscriptMap.get(msg.localId) || '[语音消息 - 转文字失败]'
        }
        if (mediaItem && (msg.localType === 3 || msg.localType === 47)) {
          textContent = ''
        }
        if (this.isTransferExportContent(textContent) && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            cleanedMyWxid,
            groupNicknamesMap,
            async (username) => {
              const c = await getContactCached(username)
              if (c.success && c.contact) {
                return c.contact.remark || c.contact.nickName || c.contact.alias || username
              }
              return username
            }
          )
          if (transferDesc) {
            textContent = this.appendTransferDesc(textContent, transferDesc)
          }
        }

        const linkCard = this.extractHtmlLinkCard(msg.content, msg.localType)
        const chatRecordHtml = msg.chatRecordList && msg.chatRecordList.length > 0
          ? this.renderHtmlChatRecordCard({
            title: msg.chatRecordTitle,
            records: msg.chatRecordList
          })
          : ''

        let mediaHtml = ''
        if (mediaItem?.kind === 'image') {
          const mediaPath = this.escapeAttribute(encodeURI(mediaItem.relativePath))
          mediaHtml = `<img class="message-media image previewable" src="${mediaPath}" data-full="${mediaPath}" alt="${this.escapeAttribute(typeName)}" />`
        } else if (mediaItem?.kind === 'emoji') {
          const mediaPath = this.escapeAttribute(encodeURI(mediaItem.relativePath))
          mediaHtml = `<img class="message-media emoji previewable" src="${mediaPath}" data-full="${mediaPath}" alt="${this.escapeAttribute(typeName)}" />`
        } else if (mediaItem?.kind === 'voice') {
          mediaHtml = `<audio class="message-media audio" controls src="${this.escapeAttribute(encodeURI(mediaItem.relativePath))}"></audio>`
        } else if (mediaItem?.kind === 'video') {
          const posterAttr = mediaItem.posterDataUrl ? ` poster="${this.escapeAttribute(mediaItem.posterDataUrl)}"` : ''
          mediaHtml = `<video class="message-media video" controls preload="metadata"${posterAttr} src="${this.escapeAttribute(encodeURI(mediaItem.relativePath))}"></video>`
        }

        const textHtml = chatRecordHtml
          ? chatRecordHtml
          : linkCard
          ? `<div class="message-text"><a class="message-link-card" href="${this.escapeAttribute(linkCard.url)}" target="_blank" rel="noopener noreferrer">${this.renderTextWithEmoji(linkCard.title).replace(/\r?\n/g, '<br />')}</a></div>`
          : (textContent
            ? `<div class="message-text">${this.renderTextWithEmoji(textContent).replace(/\r?\n/g, '<br />')}</div>`
            : '')
        const senderNameHtml = isGroup
          ? `<div class="sender-name">${this.escapeHtml(senderName)}</div>`
          : ''
        const timeHtml = `<div class="message-time">${this.escapeHtml(timeText)}</div>`
        const messageBody = `${timeHtml}${senderNameHtml}<div class="message-content">${mediaHtml}${textHtml}</div>`

        // Compact JSON object
        const itemObj = {
          i: i + 1, // index
          t: msg.createTime, // timestamp
          s: isSenderMe ? 1 : 0, // isSend
          a: avatarHtml, // avatar HTML
          b: messageBody // body HTML
        }

        writeBuf.push(JSON.stringify(itemObj))

        // Flush buffer periodically
        if (writeBuf.length >= WRITE_BATCH || i === sortedMessages.length - 1) {
          const isLast = i === sortedMessages.length - 1
          const chunk = writeBuf.join(',\n') + (isLast ? '\n' : ',\n')
          await writePromise(chunk)
          writeBuf = []
        }

        // Report progress occasionally
        if ((i + 1) % 500 === 0) {
          onProgress?.({
            current: 60 + Math.floor((i + 1) / sortedMessages.length * 30),
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'writing'
          })
        }
      }

      await writePromise(`];
    </script>

    <script>
       ${this.getVirtualScrollScript()}

      const searchInput = document.getElementById('searchInput')
      const timeInput = document.getElementById('timeInput')
      const jumpBtn = document.getElementById('jumpBtn')
      const resultCount = document.getElementById('resultCount')
      const imagePreview = document.getElementById('imagePreview')
      const imagePreviewTarget = document.getElementById('imagePreviewTarget')
      const container = document.getElementById('scrollContainer')
      let imageZoom = 1

      // Initial Data
      let allData = window.WEFLOW_DATA || [];
      let currentList = allData;

      // Render Item Function
      const renderItem = (item, index) => {
         const isSenderMe = item.s === 1;
         return \`
          <div class="message \${isSenderMe ? 'sent' : 'received'}" data-index="\${item.i}">
            <div class="message-row">
              <div class="avatar">\${item.a}</div>
              <div class="bubble">
                \${item.b}
              </div>
            </div>
          </div>
         \`;
      };
      
      const renderer = new ChunkedRenderer(container, currentList, renderItem);

      const updateCount = () => {
        resultCount.textContent = \`共 \${currentList.length} 条\`
      }

      // Search Logic
      let searchTimeout;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const keyword = searchInput.value.trim().toLowerCase();
          if (!keyword) {
            currentList = allData;
          } else {
            currentList = allData.filter(item => {
               return item.b.toLowerCase().includes(keyword); 
            });
          }
          renderer.setData(currentList);
          updateCount();
        }, 300);
      })

      // Jump Logic
      jumpBtn.addEventListener('click', () => {
        const value = timeInput.value
        if (!value) return
        const target = Math.floor(new Date(value).getTime() / 1000)
        renderer.scrollToTime(target);
      })

      // Image Preview (Delegation)
      container.addEventListener('click', (e) => {
        const target = e.target;
        if (target.classList.contains('previewable')) {
           const full = target.getAttribute('data-full')
           if (!full) return
           imagePreviewTarget.src = full
           imageZoom = 1
           imagePreviewTarget.style.transform = 'scale(1)'
           imagePreview.classList.add('active')
        }
      });

      imagePreviewTarget.addEventListener('click', (event) => {
        event.stopPropagation()
      })

      imagePreviewTarget.addEventListener('dblclick', (event) => {
        event.stopPropagation()
        imageZoom = 1
        imagePreviewTarget.style.transform = 'scale(1)'
      })

      imagePreviewTarget.addEventListener('wheel', (event) => {
        event.preventDefault()
        const delta = event.deltaY > 0 ? -0.1 : 0.1
        imageZoom = Math.min(3, Math.max(0.5, imageZoom + delta))
        imagePreviewTarget.style.transform = \`scale(\${imageZoom})\`
      }, { passive: false })

      imagePreview.addEventListener('click', () => {
        imagePreview.classList.remove('active')
        imagePreviewTarget.src = ''
        imageZoom = 1
        imagePreviewTarget.style.transform = 'scale(1)'
      })

      updateCount()
    </script>
  </body>
</html>`);

      return new Promise((resolve, reject) => {
        stream.on('error', (err) => {
          // 确保在流错误时销毁流，释放文件句柄
          stream.destroy()
          reject(err)
        })
        
        stream.end(() => {
          onProgress?.({
            current: 100,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'complete'
          })
          resolve({ success: true })
        })
        stream.on('error', reject)
      })

    } catch (e) {
      if (this.isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取导出前的预估统计信息
   */
  async getExportStats(
    sessionIds: string[],
    options: ExportOptions
  ): Promise<ExportStatsResult> {
    const conn = await this.ensureConnected()
    if (!conn.success || !conn.cleanedWxid) {
      return { totalMessages: 0, voiceMessages: 0, cachedVoiceCount: 0, needTranscribeCount: 0, mediaMessages: 0, estimatedSeconds: 0, sessions: [] }
    }
    const normalizedSessionIds = this.normalizeSessionIds(sessionIds)
    if (normalizedSessionIds.length === 0) {
      return { totalMessages: 0, voiceMessages: 0, cachedVoiceCount: 0, needTranscribeCount: 0, mediaMessages: 0, estimatedSeconds: 0, sessions: [] }
    }
    const cacheKey = this.buildExportStatsCacheKey(normalizedSessionIds, options, conn.cleanedWxid)
    const cachedStats = this.getExportStatsCacheEntry(cacheKey)
    if (cachedStats) {
      const cachedResult = this.cloneExportStatsResult(cachedStats.result)
      const orderedSessions: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }> = []
      const sessionMap = new Map(cachedResult.sessions.map((item) => [item.sessionId, item] as const))
      for (const sessionId of normalizedSessionIds) {
        const cachedSession = sessionMap.get(sessionId)
        if (cachedSession) orderedSessions.push(cachedSession)
      }
      if (orderedSessions.length === cachedResult.sessions.length) {
        cachedResult.sessions = orderedSessions
      }
      return cachedResult
    }

    const cleanedMyWxid = conn.cleanedWxid
    const sessionsStats: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }> = []
    const sessionSnapshotMap: Record<string, ExportStatsSessionSnapshot> = {}
    let totalMessages = 0
    let voiceMessages = 0
    let cachedVoiceCount = 0
    let mediaMessages = 0

    const hasSenderFilter = Boolean(String(options.senderUsername || '').trim())
    const canUseAggregatedStats = this.isUnboundedDateRange(options.dateRange) && !hasSenderFilter

    // 快速路径：直接复用 ChatService 聚合统计，避免逐会话 collectMessages 扫全量消息。
    if (canUseAggregatedStats) {
      try {
        let aggregatedData = this.getAggregatedSessionStatsCache(cacheKey)
        if (!aggregatedData) {
          const statsResult = await chatService.getExportSessionStats(normalizedSessionIds, {
            includeRelations: false,
            allowStaleCache: true
          })
          if (statsResult.success && statsResult.data) {
            aggregatedData = statsResult.data as Record<string, ExportAggregatedSessionMetric>
            this.setAggregatedSessionStatsCache(cacheKey, aggregatedData)
          }
        }
        if (aggregatedData) {
          const cachedVoiceCountMap = chatService.getCachedVoiceTranscriptCountMap(normalizedSessionIds)
          const fastRows = await parallelLimit(
            normalizedSessionIds,
            8,
            async (sessionId): Promise<{
              sessionId: string
              displayName: string
              totalCount: number
              voiceCount: number
              cachedVoiceCount: number
              mediaCount: number
            }> => {
              let displayName = sessionId
              try {
                const sessionInfo = await this.getContactInfo(sessionId)
                displayName = sessionInfo.displayName || sessionId
              } catch {
                // 预估阶段显示名获取失败不阻塞统计
              }

              const metric = aggregatedData?.[sessionId]
              const totalCount = Number.isFinite(metric?.totalMessages)
                ? Math.max(0, Math.floor(metric!.totalMessages))
                : 0
              const voiceCount = Number.isFinite(metric?.voiceMessages)
                ? Math.max(0, Math.floor(metric!.voiceMessages))
                : 0
              const imageCount = Number.isFinite(metric?.imageMessages)
                ? Math.max(0, Math.floor(metric!.imageMessages))
                : 0
              const videoCount = Number.isFinite(metric?.videoMessages)
                ? Math.max(0, Math.floor(metric!.videoMessages))
                : 0
              const emojiCount = Number.isFinite(metric?.emojiMessages)
                ? Math.max(0, Math.floor(metric!.emojiMessages))
                : 0
              const lastTimestamp = Number.isFinite(metric?.lastTimestamp)
                ? Math.max(0, Math.floor(metric!.lastTimestamp))
                : undefined
              const cachedCountRaw = Number(cachedVoiceCountMap[sessionId] || 0)
              const sessionCachedVoiceCount = Math.min(
                voiceCount,
                Number.isFinite(cachedCountRaw) ? Math.max(0, Math.floor(cachedCountRaw)) : 0
              )

              sessionSnapshotMap[sessionId] = {
                totalCount,
                voiceCount,
                imageCount,
                videoCount,
                emojiCount,
                cachedVoiceCount: sessionCachedVoiceCount,
                lastTimestamp
              }

              return {
                sessionId,
                displayName,
                totalCount,
                voiceCount,
                cachedVoiceCount: sessionCachedVoiceCount,
                mediaCount: voiceCount + imageCount + videoCount + emojiCount
              }
            }
          )

          for (const row of fastRows) {
            totalMessages += row.totalCount
            voiceMessages += row.voiceCount
            cachedVoiceCount += row.cachedVoiceCount
            mediaMessages += row.mediaCount
            sessionsStats.push({
              sessionId: row.sessionId,
              displayName: row.displayName,
              totalCount: row.totalCount,
              voiceCount: row.voiceCount
            })
          }

          const needTranscribeCount = Math.max(0, voiceMessages - cachedVoiceCount)
          const estimatedSeconds = needTranscribeCount * 2
          const result: ExportStatsResult = {
            totalMessages,
            voiceMessages,
            cachedVoiceCount,
            needTranscribeCount,
            mediaMessages,
            estimatedSeconds,
            sessions: sessionsStats
          }
          this.setExportStatsCacheEntry(cacheKey, {
            createdAt: Date.now(),
            result: this.cloneExportStatsResult(result),
            sessions: { ...sessionSnapshotMap }
          })
          return result
        }
      } catch (error) {
        // 聚合统计失败时自动回退到慢路径，保证功能正确。
      }
    }

    // 回退路径：保留旧逻辑，支持有时间范围/发送者过滤等需要精确筛选的场景。
    for (const sessionId of normalizedSessionIds) {
      const sessionInfo = await this.getContactInfo(sessionId)
      const collected = await this.collectMessages(
        sessionId,
        cleanedMyWxid,
        options.dateRange,
        options.senderUsername,
        'text-fast'
      )
      const msgs = collected.rows
      let voiceCount = 0
      let imageCount = 0
      let videoCount = 0
      let emojiCount = 0
      let latestTimestamp = 0
      let cached = 0
      for (const msg of msgs) {
        if (msg.createTime > latestTimestamp) {
          latestTimestamp = msg.createTime
        }
        const localType = msg.localType
        if (localType === 34) {
          voiceCount++
          if (chatService.hasTranscriptCache(sessionId, String(msg.localId), msg.createTime)) {
            cached++
          }
          continue
        }
        if (localType === 3) imageCount++
        if (localType === 43) videoCount++
        if (localType === 47) emojiCount++
      }
      const mediaCount = voiceCount + imageCount + videoCount + emojiCount

      totalMessages += msgs.length
      voiceMessages += voiceCount
      cachedVoiceCount += cached
      mediaMessages += mediaCount
      sessionSnapshotMap[sessionId] = {
        totalCount: msgs.length,
        voiceCount,
        imageCount,
        videoCount,
        emojiCount,
        cachedVoiceCount: cached,
        lastTimestamp: latestTimestamp > 0 ? latestTimestamp : undefined
      }
      sessionsStats.push({
        sessionId,
        displayName: sessionInfo.displayName,
        totalCount: msgs.length,
        voiceCount
      })
    }

    const needTranscribeCount = Math.max(0, voiceMessages - cachedVoiceCount)
    // 预估：每条语音转文字约 2 秒
    const estimatedSeconds = needTranscribeCount * 2

    const result: ExportStatsResult = {
      totalMessages,
      voiceMessages,
      cachedVoiceCount,
      needTranscribeCount,
      mediaMessages,
      estimatedSeconds,
      sessions: sessionsStats
    }
    this.setExportStatsCacheEntry(cacheKey, {
      createdAt: Date.now(),
      result: this.cloneExportStatsResult(result),
      sessions: { ...sessionSnapshotMap }
    })
    return result
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ): Promise<{
    success: boolean
    successCount: number
    failCount: number
    paused?: boolean
    stopped?: boolean
    pendingSessionIds?: string[]
    successSessionIds?: string[]
    failedSessionIds?: string[]
    error?: string
  }> {
    let successCount = 0
    let failCount = 0
    const successSessionIds: string[] = []
    const failedSessionIds: string[] = []

    try {
      const conn = await this.ensureConnected()
      if (!conn.success) {
        return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
      }

      const effectiveOptions: ExportOptions = this.isMediaContentBatchExport(options)
        ? { ...options, exportVoiceAsText: false }
        : options

      const exportMediaEnabled = effectiveOptions.exportMedia === true &&
        Boolean(effectiveOptions.exportImages || effectiveOptions.exportVoices || effectiveOptions.exportVideos || effectiveOptions.exportEmojis)
      const rawWriteLayout = this.configService.get('exportWriteLayout')
      const writeLayout = rawWriteLayout === 'A' || rawWriteLayout === 'B' || rawWriteLayout === 'C'
        ? rawWriteLayout
        : 'A'
      const exportBaseDir = writeLayout === 'A'
        ? path.join(outputDir, 'texts')
        : outputDir
      if (!fs.existsSync(exportBaseDir)) {
        fs.mkdirSync(exportBaseDir, { recursive: true })
      }
      const sessionLayout = exportMediaEnabled
        ? (effectiveOptions.sessionLayout ?? 'per-session')
        : 'shared'
      let completedCount = 0
      const activeSessionRatios = new Map<string, number>()
      const computeAggregateCurrent = () => {
        let activeRatioSum = 0
        for (const ratio of activeSessionRatios.values()) {
          activeRatioSum += Math.max(0, Math.min(1, ratio))
        }
        return Math.min(sessionIds.length, completedCount + activeRatioSum)
      }
      const isTextContentBatchExport = effectiveOptions.contentType === 'text' && !exportMediaEnabled
      const defaultConcurrency = exportMediaEnabled ? 2 : (isTextContentBatchExport ? 1 : 4)
      const rawConcurrency = typeof effectiveOptions.exportConcurrency === 'number'
        ? Math.floor(effectiveOptions.exportConcurrency)
        : defaultConcurrency
      const maxSessionConcurrency = isTextContentBatchExport ? 1 : 6
      const clampedConcurrency = Math.max(1, Math.min(rawConcurrency, maxSessionConcurrency))
      const sessionConcurrency = clampedConcurrency
      const queue = [...sessionIds]
      let pauseRequested = false
      let stopRequested = false
      const emptySessionIds = new Set<string>()
      const sessionMessageCountHints = new Map<string, number>()
      const sessionLatestTimestampHints = new Map<string, number>()
      const exportStatsCacheKey = this.buildExportStatsCacheKey(sessionIds, effectiveOptions, conn.cleanedWxid)
      const cachedStatsEntry = this.getExportStatsCacheEntry(exportStatsCacheKey)
      if (cachedStatsEntry?.sessions) {
        for (const sessionId of sessionIds) {
          const snapshot = cachedStatsEntry.sessions[sessionId]
          if (!snapshot) continue
          sessionMessageCountHints.set(sessionId, Math.max(0, Math.floor(snapshot.totalCount || 0)))
          if (Number.isFinite(snapshot.lastTimestamp) && Number(snapshot.lastTimestamp) > 0) {
            sessionLatestTimestampHints.set(sessionId, Math.floor(Number(snapshot.lastTimestamp)))
          }
          if (snapshot.totalCount <= 0) {
            emptySessionIds.add(sessionId)
          }
        }
      }
      const canUseSessionSnapshotHints = isTextContentBatchExport &&
        this.isUnboundedDateRange(effectiveOptions.dateRange) &&
        !String(effectiveOptions.senderUsername || '').trim()
      const canFastSkipEmptySessions = !isTextContentBatchExport &&
        this.isUnboundedDateRange(effectiveOptions.dateRange) &&
        !String(effectiveOptions.senderUsername || '').trim()
      const canTrySkipUnchangedTextSessions = canUseSessionSnapshotHints
      const precheckSessionIds = canFastSkipEmptySessions
        ? sessionIds.filter((sessionId) => !sessionMessageCountHints.has(sessionId))
        : []
      if (canFastSkipEmptySessions && precheckSessionIds.length > 0) {
        const EMPTY_SESSION_PRECHECK_LIMIT = 1200
        if (precheckSessionIds.length <= EMPTY_SESSION_PRECHECK_LIMIT) {
          let checkedCount = 0
          onProgress?.({
            current: computeAggregateCurrent(),
            total: sessionIds.length,
            currentSession: '',
            currentSessionId: '',
            phase: 'preparing',
            phaseProgress: 0,
            phaseTotal: precheckSessionIds.length,
            phaseLabel: `预检查空会话 0/${precheckSessionIds.length}`
          })

          const PRECHECK_BATCH_SIZE = 160
          for (let i = 0; i < precheckSessionIds.length; i += PRECHECK_BATCH_SIZE) {
            if (control?.shouldStop?.()) {
              stopRequested = true
              break
            }
            if (control?.shouldPause?.()) {
              pauseRequested = true
              break
            }

            const batchSessionIds = precheckSessionIds.slice(i, i + PRECHECK_BATCH_SIZE)
            const countsResult = await wcdbService.getMessageCounts(batchSessionIds)
            if (countsResult.success && countsResult.counts) {
              for (const batchSessionId of batchSessionIds) {
                const count = countsResult.counts[batchSessionId]
                if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
                  sessionMessageCountHints.set(batchSessionId, Math.max(0, Math.floor(count)))
                }
                if (typeof count === 'number' && Number.isFinite(count) && count <= 0) {
                  emptySessionIds.add(batchSessionId)
                }
              }
            }

            checkedCount = Math.min(precheckSessionIds.length, checkedCount + batchSessionIds.length)
            onProgress?.({
              current: computeAggregateCurrent(),
              total: sessionIds.length,
              currentSession: '',
              currentSessionId: '',
              phase: 'preparing',
              phaseProgress: checkedCount,
              phaseTotal: precheckSessionIds.length,
              phaseLabel: `预检查空会话 ${checkedCount}/${precheckSessionIds.length}`
            })
          }
        } else {
          onProgress?.({
            current: computeAggregateCurrent(),
            total: sessionIds.length,
            currentSession: '',
            currentSessionId: '',
            phase: 'preparing',
            phaseLabel: `会话较多，已跳过空会话预检查（${precheckSessionIds.length} 个）`
          })
        }
      }

      if (canUseSessionSnapshotHints && sessionIds.length > 0) {
        const missingHintSessionIds = sessionIds.filter((sessionId) => (
          !sessionMessageCountHints.has(sessionId) || !sessionLatestTimestampHints.has(sessionId)
        ))
        if (missingHintSessionIds.length > 0) {
          const sessionSet = new Set(missingHintSessionIds)
          const sessionsResult = await chatService.getSessions()
          if (sessionsResult.success && Array.isArray(sessionsResult.sessions)) {
            for (const item of sessionsResult.sessions) {
              const username = String(item?.username || '').trim()
              if (!username) continue
              if (!sessionSet.has(username)) continue
              const messageCountHint = Number(item?.messageCountHint)
              if (
                !sessionMessageCountHints.has(username) &&
                Number.isFinite(messageCountHint) &&
                messageCountHint >= 0
              ) {
                sessionMessageCountHints.set(username, Math.floor(messageCountHint))
              }
              const lastTimestamp = Number(item?.lastTimestamp)
              if (
                !sessionLatestTimestampHints.has(username) &&
                Number.isFinite(lastTimestamp) &&
                lastTimestamp > 0
              ) {
                sessionLatestTimestampHints.set(username, Math.floor(lastTimestamp))
              }
            }
          }
        }
      }

      if (stopRequested) {
        return {
          success: true,
          successCount,
          failCount,
          stopped: true,
          pendingSessionIds: [...queue],
          successSessionIds,
          failedSessionIds
        }
      }
      if (pauseRequested) {
        return {
          success: true,
          successCount,
          failCount,
          paused: true,
          pendingSessionIds: [...queue],
          successSessionIds,
          failedSessionIds
        }
      }

      const runOne = async (sessionId: string): Promise<'done' | 'stopped'> => {
        try {
          this.throwIfStopRequested(control)
          const sessionInfo = await this.getContactInfo(sessionId)
          const messageCountHint = sessionMessageCountHints.get(sessionId)
          const latestTimestampHint = sessionLatestTimestampHints.get(sessionId)

          if (
            isTextContentBatchExport &&
            typeof messageCountHint === 'number' &&
            messageCountHint <= 0
          ) {
            successCount++
            successSessionIds.push(sessionId)
            activeSessionRatios.delete(sessionId)
            completedCount++
            onProgress?.({
              current: computeAggregateCurrent(),
              total: sessionIds.length,
              currentSession: sessionInfo.displayName,
              currentSessionId: sessionId,
              phase: 'complete',
              phaseLabel: '该会话没有消息，已跳过'
            })
            return 'done'
          }

          if (emptySessionIds.has(sessionId)) {
            successCount++
            successSessionIds.push(sessionId)
            activeSessionRatios.delete(sessionId)
            completedCount++
            onProgress?.({
              current: computeAggregateCurrent(),
              total: sessionIds.length,
              currentSession: sessionInfo.displayName,
              currentSessionId: sessionId,
              phase: 'complete',
              phaseLabel: '该会话没有消息，已跳过'
            })
            return 'done'
          }

          const sessionProgress = (progress: ExportProgress) => {
            const phaseTotal = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 100
            const phaseCurrent = Number.isFinite(progress.current) ? progress.current : 0
            const ratio = progress.phase === 'complete'
              ? 1
              : Math.max(0, Math.min(1, phaseCurrent / phaseTotal))
            activeSessionRatios.set(sessionId, ratio)
            onProgress?.({
              ...progress,
              current: computeAggregateCurrent(),
              total: sessionIds.length,
              currentSession: sessionInfo.displayName,
              currentSessionId: sessionId
            })
          }

          sessionProgress({
            current: 0,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'preparing',
            phaseLabel: '准备导出'
          })

          const sanitizeName = (value: string) => value.replace(/[<>:"\/\\|?*]/g, '_').replace(/\.+$/, '').trim()
          const baseName = sanitizeName(sessionInfo.displayName || sessionId) || sanitizeName(sessionId) || 'session'
          const suffix = sanitizeName(effectiveOptions.fileNameSuffix || '')
          const safeName = suffix ? `${baseName}_${suffix}` : baseName
          const sessionNameWithTypePrefix = effectiveOptions.sessionNameWithTypePrefix !== false
          const sessionTypePrefix = sessionNameWithTypePrefix ? await this.getSessionFilePrefix(sessionId) : ''
          const fileNameWithPrefix = `${sessionTypePrefix}${safeName}`
          const useSessionFolder = sessionLayout === 'per-session'
          const sessionDirName = sessionNameWithTypePrefix ? `${sessionTypePrefix}${safeName}` : safeName
          const sessionDir = useSessionFolder ? path.join(exportBaseDir, sessionDirName) : exportBaseDir

          if (useSessionFolder && !fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true })
          }

          let ext = '.json'
          if (effectiveOptions.format === 'chatlab-jsonl') ext = '.jsonl'
          else if (effectiveOptions.format === 'excel') ext = '.xlsx'
          else if (effectiveOptions.format === 'txt') ext = '.txt'
          else if (effectiveOptions.format === 'weclone') ext = '.csv'
          else if (effectiveOptions.format === 'html') ext = '.html'
          const outputPath = path.join(sessionDir, `${fileNameWithPrefix}${ext}`)
          const canTrySkipUnchanged = canTrySkipUnchangedTextSessions &&
            typeof messageCountHint === 'number' &&
            messageCountHint >= 0 &&
            typeof latestTimestampHint === 'number' &&
            latestTimestampHint > 0 &&
            fs.existsSync(outputPath)
          if (canTrySkipUnchanged) {
            const latestRecord = exportRecordService.getLatestRecord(sessionId, effectiveOptions.format)
            const hasNoDataChange = Boolean(
              latestRecord &&
              latestRecord.messageCount === messageCountHint &&
              Number(latestRecord.sourceLatestMessageTimestamp || 0) >= latestTimestampHint
            )
            if (hasNoDataChange) {
              successCount++
              successSessionIds.push(sessionId)
              activeSessionRatios.delete(sessionId)
              completedCount++
              onProgress?.({
                current: computeAggregateCurrent(),
                total: sessionIds.length,
                currentSession: sessionInfo.displayName,
                currentSessionId: sessionId,
                phase: 'complete',
                phaseLabel: '无变化，已跳过'
              })
              return 'done'
            }
          }

          let result: { success: boolean; error?: string }
          if (effectiveOptions.format === 'json' || effectiveOptions.format === 'arkme-json') {
            result = await this.exportSessionToDetailedJson(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'chatlab' || effectiveOptions.format === 'chatlab-jsonl') {
            result = await this.exportSessionToChatLab(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'excel') {
            result = await this.exportSessionToExcel(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'txt') {
            result = await this.exportSessionToTxt(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'weclone') {
            result = await this.exportSessionToWeCloneCsv(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else if (effectiveOptions.format === 'html') {
            result = await this.exportSessionToHtml(sessionId, outputPath, effectiveOptions, sessionProgress, control)
          } else {
            result = { success: false, error: `不支持的格式: ${effectiveOptions.format}` }
          }

          if (!result.success && this.isStopError(result.error)) {
            activeSessionRatios.delete(sessionId)
            return 'stopped'
          }

          if (result.success) {
            successCount++
            successSessionIds.push(sessionId)
            if (typeof messageCountHint === 'number' && messageCountHint >= 0) {
              exportRecordService.saveRecord(sessionId, effectiveOptions.format, messageCountHint, {
                sourceLatestMessageTimestamp: typeof latestTimestampHint === 'number' && latestTimestampHint > 0
                  ? latestTimestampHint
                  : undefined,
                outputPath
              })
            }
          } else {
            failCount++
            failedSessionIds.push(sessionId)
            console.error(`导出 ${sessionId} 失败:`, result.error)
          }

          activeSessionRatios.delete(sessionId)
          completedCount++
          onProgress?.({
            current: computeAggregateCurrent(),
            total: sessionIds.length,
            currentSession: sessionInfo.displayName,
            currentSessionId: sessionId,
            phase: 'complete',
            phaseLabel: result.success ? '完成' : '导出失败'
          })
          return 'done'
        } catch (error) {
          if (this.isStopError(error)) {
            activeSessionRatios.delete(sessionId)
            return 'stopped'
          }
          throw error
        }
      }

      if (isTextContentBatchExport) {
        // 文本内容批量导出使用串行调度，降低数据库与文件系统抢占，行为更贴近 wxdaochu。
        while (queue.length > 0) {
          if (control?.shouldStop?.()) {
            stopRequested = true
            break
          }
          if (control?.shouldPause?.()) {
            pauseRequested = true
            break
          }

          const sessionId = queue.shift()
          if (!sessionId) break
          const runState = await runOne(sessionId)
          await new Promise(resolve => setImmediate(resolve))
          if (runState === 'stopped') {
            stopRequested = true
            queue.unshift(sessionId)
            break
          }
        }
      } else {
        const workers = Array.from({ length: Math.min(sessionConcurrency, queue.length) }, async () => {
          while (queue.length > 0) {
            if (control?.shouldStop?.()) {
              stopRequested = true
              break
            }
            if (control?.shouldPause?.()) {
              pauseRequested = true
              break
            }

            const sessionId = queue.shift()
            if (!sessionId) break
            const runState = await runOne(sessionId)
            if (runState === 'stopped') {
              stopRequested = true
              queue.unshift(sessionId)
              break
            }
          }
        })
        await Promise.all(workers)
      }

      const pendingSessionIds = [...queue]
      if (stopRequested && pendingSessionIds.length > 0) {
        return {
          success: true,
          successCount,
          failCount,
          stopped: true,
          pendingSessionIds,
          successSessionIds,
          failedSessionIds
        }
      }
      if (pauseRequested && pendingSessionIds.length > 0) {
        return {
          success: true,
          successCount,
          failCount,
          paused: true,
          pendingSessionIds,
          successSessionIds,
          failedSessionIds
        }
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        currentSessionId: '',
        phase: 'complete'
      })

      return { success: true, successCount, failCount, successSessionIds, failedSessionIds }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e) }
    }
  }
}

export const exportService = new ExportService()
