import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import { getEmojiPath } from 'wechat-emojis'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { imageDecryptService } from './imageDecryptService'
import { runHardlinkPreloadIfNeeded } from '../utils/runHardlinkPreload'
import { collectImageHardlinkMd5s } from '../utils/collectImageHardlinkMd5s'
import { logOptionalError } from '../utils/logOptionalError'
import { chatService } from './chatService'
import { videoService } from './videoService'
import { voiceTranscribeService } from './voiceTranscribeService'
import { exportRecordService } from './exportRecordService'
import { EXPORT_HTML_STYLES } from './exportHtmlStyles'
import { LRUCache } from '../utils/LRUCache.js'

import {
  ExportOptions,
  ExportProgress,
  MESSAGE_TYPE_MAP,
  FILE_APP_LOCAL_TYPE_SET,
  FILE_APP_LOCAL_TYPES,
  TXT_COLUMN_DEFINITIONS,
  parallelLimit,
  type ChatLabExport,
  type ChatLabHeader,
  type ChatLabMember,
  type ChatLabMessage,
  type ChatLabMeta,
  type ExportAggregatedSessionMetric,
  type ExportAggregatedSessionStatsCacheEntry,
  type ExportDisplayProfile,
  type ExportStatsCacheEntry,
  type ExportStatsResult,
  type ExportStatsSessionSnapshot,
  type ExportTaskControl,
  type FileAttachmentSearchRoot,
  type FileExportCandidate,
  type ForwardChatRecordItem,
  type MediaContentType,
  type MediaExportItem,
  type MediaExportTelemetry,
  type MediaSourceResolution,
  type MessageCollectMode
} from './exportServiceTypes'
import { ExportStatsCacheManager } from './exportStatsCache'
import { ExportMediaRuntime } from './exportMediaRuntime'
import {
  STOP_ERROR_CODE,
  PAUSE_ERROR_CODE,
  normalizeSessionIds,
  normalizeTimestampSeconds,
  normalizeExportDateRange,
  normalizeMaxFileSizeMb,
  getExportStatsDateRangeToken,
  sanitizeExportFileNamePart,
  resolveFileAttachmentExtensionDir,
  normalizeFileNamingMode,
  formatDateTokenBySeconds,
  buildDateRangeFileNamePart,
  buildSessionExportBaseName,
  isCloneUnsupportedError,
  isHardlinkFallbackError,
  cleanAccountDirName,
  getIntFromRow,
  parseCompactDateTimeDigitsToSeconds,
  parseDateTimeTextToSeconds,
  normalizeRowTimestampSeconds,
  getTimestampSecondsFromRow,
  getRowField,
  normalizeUnsignedIntToken,
  getStableMessageKey,
  getMediaCacheKey,
  getImageMissingRunCacheKey,
  normalizeEmojiMd5,
  normalizeEmojiCaption,
  formatEmojiSemanticText,
  extractLooseHexMd5,
  normalizeEmojiCdnUrl,
  isFileAppLocalType,
  getFileAppMessageHints,
  hasFileAppMessageHints,
  decodeExtBuffer,
  readVarint,
  isLikelyGroupMemberId,
  parseGroupNicknamesFromExtBuffer,
  looksLikeHex,
  normalizeGroupNickname,
  buildGroupNicknameIdCandidates,
  escapeHtml,
  getVirtualScrollScript,
  getClampedConcurrency,
  createProgressEmitter,
  isStopError,
  isPauseError,
  pathExists,
  copyFileOptimized
} from './exportServiceUtils'
import { exportChatLabMixin } from './exportChatLabWriter'
import { exportJsonMixin } from './exportJsonWriter'
import { exportExcelMixin } from './exportExcelWriter'
import { exportTxtMixin } from './exportTxtWriter'
import { exportWeCloneMixin } from './exportWeCloneWriter'
import { exportHtmlMixin } from './exportHtmlWriter'
import { exportSessionsMixin } from './exportSessionsWriter'
export type { ExportOptions, ExportProgress } from './exportServiceTypes'

export class ExportService {
  private configService: ConfigService
  private exportStatsCacheManager: ExportStatsCacheManager
  private mediaRuntime: ExportMediaRuntime
  private runtimeConfig: { dbPath?: string; decryptKey?: string; myWxid?: string; imageXorKey?: unknown; imageAesKey?: string } | null = null
  private contactCache: LRUCache<string, { displayName: string; avatarUrl?: string }>
  private inlineEmojiCache: LRUCache<string, string>
  private htmlStyleCache: string | null = null
  private emojiCaptionCache = new Map<string, string | null>()
  private emojiCaptionPending = new Map<string, Promise<string | null>>()
  private emojiMd5ByCdnCache = new Map<string, string | null>()
  private emojiMd5ByCdnPending = new Map<string, Promise<string | null>>()
  private emoticonDbPathCache: string | null = null
  private emoticonDbPathCacheToken = ''
  private readonly emojiCaptionLookupConcurrency = 8

  constructor() {
    this.configService = new ConfigService()
    this.exportStatsCacheManager = new ExportStatsCacheManager({
      getConfiguredDbPath: () => this.getConfiguredDbPath(),
      getConfiguredMyWxid: () => this.getConfiguredMyWxid(),
    })
    this.mediaRuntime = new ExportMediaRuntime(this.configService)
    // 限制缓存大小，防止内存泄漏
    this.contactCache = new LRUCache(500) // 最多缓存500个联系人
    this.inlineEmojiCache = new LRUCache(100) // 最多缓存100个表情
  }

  private createStopError(): Error {
    const error = new Error('导出任务已停止')
    ;(error as Error & { code?: string }).code = STOP_ERROR_CODE
    return error
  }

  private createPauseError(): Error {
    const error = new Error('导出任务已暂停')
    ;(error as Error & { code?: string }).code = PAUSE_ERROR_CODE
    return error
  }

  setRuntimeConfig(config: { dbPath?: string; decryptKey?: string; myWxid?: string; imageXorKey?: unknown; imageAesKey?: string } | null): void {
    this.runtimeConfig = config
    imageDecryptService.setRuntimeConfig({
      dbPath: config?.dbPath,
      myWxid: config?.myWxid,
      imageXorKey: config?.imageXorKey,
      imageAesKey: config?.imageAesKey
    })
  }

  private getConfiguredDbPath(): string {
    return String(this.runtimeConfig?.dbPath || this.configService.get('dbPath') || '').trim()
  }

  private getConfiguredMyWxid(): string {
    return String(this.runtimeConfig?.myWxid || this.configService.getMyWxidCleaned() || '').trim()
  }

  private normalizeExportOptionsForRun(options: ExportOptions): ExportOptions {
    const normalizedDateRange = normalizeExportDateRange(options.dateRange)
    const normalizedMaxFileSizeMb = normalizeMaxFileSizeMb(options.maxFileSizeMb)
    const normalizedWriteLayout = this.resolveExportWriteLayout(options)
    return {
      ...options,
      dateRange: normalizedDateRange,
      maxFileSizeMb: normalizedMaxFileSizeMb,
      exportWriteLayout: normalizedWriteLayout
    }
  }

  private resolveExportWriteLayout(options?: Pick<ExportOptions, 'exportWriteLayout'> | null): 'A' | 'B' | 'C' {
    const optionLayout = options?.exportWriteLayout
    if (optionLayout === 'A' || optionLayout === 'B' || optionLayout === 'C') return optionLayout
    const rawWriteLayout = this.configService.get('exportWriteLayout')
    return rawWriteLayout === 'A' || rawWriteLayout === 'B' || rawWriteLayout === 'C'
      ? rawWriteLayout
      : 'B'
  }

  private throwIfStopRequested(control?: ExportTaskControl): void {
    if (control?.shouldStop?.()) {
      throw this.createStopError()
    }
    if (control?.shouldPause?.()) {
      throw this.createPauseError()
    }
  }

  private async ensureExportDir(dirPath: string, control?: ExportTaskControl, dirCache?: Set<string>): Promise<void> {
    if (dirCache?.has(dirPath)) return
    const existed = await pathExists(dirPath)
    await fs.promises.mkdir(dirPath, { recursive: true })
    dirCache?.add(dirPath)
    if (!existed) {
      control?.recordCreatedDir?.(dirPath)
    }
  }

  private async recordCreatedFileBeforeWrite(filePath: string, control?: ExportTaskControl): Promise<void> {
    if (!control?.recordCreatedFile) return
    if (!await pathExists(filePath)) {
      control.recordCreatedFile(filePath)
    }
  }

  private async reserveUniqueOutputPath(preferredPath: string, reservedPaths: Set<string>): Promise<string> {
    const dir = path.dirname(preferredPath)
    const ext = path.extname(preferredPath)
    const base = path.basename(preferredPath, ext)

    for (let attempt = 0; attempt < 10000; attempt += 1) {
      const candidate = attempt === 0
        ? preferredPath
        : path.join(dir, `${base}_${attempt + 1}${ext}`)

      if (reservedPaths.has(candidate)) continue

      const exists = await pathExists(candidate)
      if (reservedPaths.has(candidate)) continue
      if (exists) continue

      reservedPaths.add(candidate)
      return candidate
    }

    const fallback = path.join(dir, `${base}_${Date.now()}${ext}`)
    reservedPaths.add(fallback)
    return fallback
  }

  private isMediaExportEnabled(options: ExportOptions): boolean {
    return options.exportMedia === true &&
      Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis || options.exportFiles)
  }

  private isUnboundedDateRange(dateRange?: { start: number; end: number } | null): boolean {
    return normalizeExportDateRange(dateRange) === null
  }

  private shouldUseFastTextCollection(options: ExportOptions): boolean {
    // 文本批量导出优先走轻量采集：不做媒体字段预提取，减少 CPU 与内存占用
    return !this.isMediaExportEnabled(options)
  }

  private getMediaContentType(options: ExportOptions): MediaContentType | null {
    const value = options.contentType
    if (value === 'voice' || value === 'image' || value === 'video' || value === 'emoji' || value === 'file') {
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
    if (mediaContentType === 'file') return new Set(FILE_APP_LOCAL_TYPES)

    const selected = new Set<number>()
    if (options.exportImages) selected.add(3)
    if (options.exportVoices) selected.add(34)
    if (options.exportVideos) selected.add(43)
    if (options.exportFiles) {
      for (const fileType of FILE_APP_LOCAL_TYPES) {
        selected.add(fileType)
      }
    }
    return selected
  }

  private isFileOnlyMediaFilter(targetMediaTypes: Set<number> | null): boolean {
    return Boolean(
      targetMediaTypes &&
      targetMediaTypes.size === FILE_APP_LOCAL_TYPES.length &&
      FILE_APP_LOCAL_TYPES.every((fileType) => targetMediaTypes.has(fileType))
    )
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

  private resolveFastMediaStreamType(
    collectMode: MessageCollectMode,
    targetMediaTypes: Set<number> | null
  ): 'image' | 'video' | null {
    if (collectMode !== 'media-fast' || !targetMediaTypes || targetMediaTypes.size !== 1) return null
    if (targetMediaTypes.has(3)) return 'image'
    if (targetMediaTypes.has(43)) return 'video'
    return null
  }

  private async collectMessagesByFastMediaStream(
    sessionId: string,
    cleanedMyWxid: string,
    normalizedDateRange: { start: number; end: number } | null,
    useCursorTimeRange: boolean,
    normalizedSenderUsernameFilter: string,
    mediaType: 'image' | 'video',
    onCollectProgress?: (payload: { fetched: number }) => void,
    control?: ExportTaskControl
  ): Promise<{
    success: boolean
    rows: any[]
    senderUsernames: string[]
    firstTime: number | null
    lastTime: number | null
    error?: string
  }> {
    const rows: any[] = []
    const senderSet = new Set<string>()
    let firstTime: number | null = null
    let lastTime: number | null = null
    let offset = 0
    let hasMore = true
    const PAGE_LIMIT = 480

    while (hasMore) {
      this.throwIfStopRequested(control)
      const streamResult = await wcdbService.getMediaStream({
        sessionId,
        mediaType,
        beginTimestamp: useCursorTimeRange ? (normalizedDateRange?.start || 0) : 0,
        endTimestamp: useCursorTimeRange ? (normalizedDateRange?.end || 0) : 0,
        limit: PAGE_LIMIT,
        offset
      })
      if (!streamResult.success) {
        return {
          success: false,
          rows,
          senderUsernames: Array.from(senderSet),
          firstTime,
          lastTime,
          error: streamResult.error || '媒体快速流读取失败'
        }
      }

      const items = Array.isArray(streamResult.items) ? streamResult.items : []
      if (items.length === 0) {
        hasMore = false
        break
      }

      for (const item of items) {
        const createTime = normalizeRowTimestampSeconds(item?.createTime)
        if (normalizedDateRange) {
          if (createTime > 0 && normalizedDateRange.start > 0 && createTime < normalizedDateRange.start) continue
          if (createTime > 0 && normalizedDateRange.end > 0 && createTime > normalizedDateRange.end) continue
        }

        const localTypeRaw = Number(item?.localType || 0)
        let localType = Number.isFinite(localTypeRaw) ? Math.floor(localTypeRaw) : 0
        if (localType <= 0) {
          localType = mediaType === 'video' ? 43 : 3
        }
        const isSend = Number(item?.isSend) === 1
        const senderUsernameRaw = String(item?.senderUsername || '').trim()
        const actualSender = isSend ? cleanedMyWxid : (senderUsernameRaw || sessionId)
        if (normalizedSenderUsernameFilter && !this.isSameWxid(actualSender, normalizedSenderUsernameFilter)) {
          continue
        }
        senderSet.add(actualSender)

        const localIdRaw = Number(item?.localId || 0)
        const localId = Number.isFinite(localIdRaw) ? Math.floor(localIdRaw) : 0
        const serverIdRawToken = normalizeUnsignedIntToken(item?.serverId)
        const serverIdValue = Number.parseInt(serverIdRawToken, 10)

        const imageMd5 = String(item?.imageMd5 || '').trim().toLowerCase()
        const imageDatName = String(item?.imageDatName || '').trim().toLowerCase()
        const videoMd5 = String(item?.videoMd5 || '').trim().toLowerCase()

        rows.push({
          localId,
          serverId: Number.isFinite(serverIdValue) ? serverIdValue : 0,
          serverIdRaw: serverIdRawToken !== '0' ? serverIdRawToken : undefined,
          createTime,
          localType,
          content: String(item?.content || ''),
          senderUsername: actualSender,
          isSend,
          imageMd5: imageMd5 || undefined,
          imageDatName: imageDatName || undefined,
          videoMd5: videoMd5 || undefined
        })

        if (createTime > 0) {
          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
        }
      }

      onCollectProgress?.({ fetched: rows.length })
      const nextOffset = Number(streamResult.nextOffset)
      const safeNextOffset = Number.isFinite(nextOffset) && nextOffset > offset
        ? Math.floor(nextOffset)
        : offset + items.length
      offset = safeNextOffset
      hasMore = Boolean(streamResult.hasMore) && items.length > 0
    }

    return {
      success: true,
      rows,
      senderUsernames: Array.from(senderSet),
      firstTime,
      lastTime
    }
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
        phaseLabel: `收集消息 ${fetched.toLocaleString()} 条`,
        collectedMessages: fetched
      })
    }
  }

  private shouldDecodeMessageContentInFastMode(localType: number): boolean {
    // 这些类型在文本导出里只需要占位符，无需解码完整 XML / 压缩内容
    if (localType === 3 || localType === 34 || localType === 42 || localType === 43) {
      return false
    }
    return true
  }

  private shouldDecodeMessageContentInMediaMode(
    localType: number,
    targetMediaTypes: Set<number> | null,
    options?: { allowFileProbe?: boolean }
  ): boolean {
    const allowFileProbe = options?.allowFileProbe === true
    if (!targetMediaTypes || (!targetMediaTypes.has(localType) && !allowFileProbe)) return false
    // 语音导出仅需要 localId 读取音频数据，不依赖 XML 内容
    if (localType === 34) return false
    // 图片/视频/表情/文件可能需要从 XML 提取 md5/datName/附件信息
    if (localType === 3 || localType === 43 || localType === 47 || isFileAppLocalType(localType) || allowFileProbe) return true
    return false
  }

  private resolveStrictEmoticonDbPath(): string | null {
    const dbPath = this.getConfiguredDbPath()
    const rawWxid = this.getConfiguredMyWxid()
    const cleanedWxid = cleanAccountDirName(rawWxid)
    const token = `${dbPath}::${rawWxid}::${cleanedWxid}`
    if (token === this.emoticonDbPathCacheToken) {
      return this.emoticonDbPathCache
    }
    this.emoticonDbPathCacheToken = token
    this.emoticonDbPathCache = null

    const dbStoragePath =
      this.resolveDbStoragePathForExport(dbPath, cleanedWxid) ||
      this.resolveDbStoragePathForExport(dbPath, rawWxid)
    if (!dbStoragePath) return null

    const strictPath = path.join(dbStoragePath, 'emoticon', 'emoticon.db')
    if (fs.existsSync(strictPath)) {
      this.emoticonDbPathCache = strictPath
      return strictPath
    }
    return null
  }

  private resolveDbStoragePathForExport(basePath: string, wxid: string): string | null {
    if (!basePath) return null
    const normalized = basePath.replace(/[\\/]+$/, '')
    if (normalized.toLowerCase().endsWith('db_storage') && fs.existsSync(normalized)) {
      return normalized
    }
    const direct = path.join(normalized, 'db_storage')
    if (fs.existsSync(direct)) {
      return direct
    }
    if (!wxid) return null

    const viaWxid = path.join(normalized, wxid, 'db_storage')
    if (fs.existsSync(viaWxid)) {
      return viaWxid
    }

    try {
      const entries = fs.readdirSync(normalized)
      const lowerWxid = wxid.toLowerCase()
      const candidates = entries.filter((entry) => {
        const entryPath = path.join(normalized, entry)
        try {
          if (!fs.statSync(entryPath).isDirectory()) return false
        } catch {
          return false
        }
        const lowerEntry = entry.toLowerCase()
        return lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`)
      })
      for (const entry of candidates) {
        const candidate = path.join(normalized, entry, 'db_storage')
        if (fs.existsSync(candidate)) {
          return candidate
        }
      }
    } catch {
      // keep null
    }

    return null
  }

  private async queryEmojiMd5ByCdnUrlFallback(cdnUrlRaw: string): Promise<string | null> {
    const cdnUrl = normalizeEmojiCdnUrl(cdnUrlRaw)
    if (!cdnUrl) return null
    const emoticonDbPath = this.resolveStrictEmoticonDbPath()
    if (!emoticonDbPath) return null

    const candidates = Array.from(new Set([
      cdnUrl,
      cdnUrl.replace(/&/g, '&amp;')
    ]))

    for (const candidate of candidates) {
      const escaped = candidate.replace(/'/g, "''")
      const result = await wcdbService.execQuery(
        'message',
        emoticonDbPath,
        `SELECT md5, lower(hex(md5)) AS md5_hex FROM kNonStoreEmoticonTable WHERE cdn_url = '${escaped}' COLLATE NOCASE LIMIT 1`
      )
      const row = result.success && Array.isArray(result.rows) ? result.rows[0] : null
      const md5 = normalizeEmojiMd5(getRowField(row || {}, ['md5', 'md5_hex']))
      if (md5) return md5
    }

    return null
  }

  private async getEmojiMd5ByCdnUrl(cdnUrlRaw: string): Promise<string | null> {
    const cdnUrl = normalizeEmojiCdnUrl(cdnUrlRaw)
    if (!cdnUrl) return null

    if (this.emojiMd5ByCdnCache.has(cdnUrl)) {
      return this.emojiMd5ByCdnCache.get(cdnUrl) ?? null
    }

    const pending = this.emojiMd5ByCdnPending.get(cdnUrl)
    if (pending) return pending

    const task = (async (): Promise<string | null> => {
      try {
        return await this.queryEmojiMd5ByCdnUrlFallback(cdnUrl)
      } catch {
        return null
      }
    })()

    this.emojiMd5ByCdnPending.set(cdnUrl, task)
    try {
      const md5 = await task
      this.emojiMd5ByCdnCache.set(cdnUrl, md5)
      return md5
    } finally {
      this.emojiMd5ByCdnPending.delete(cdnUrl)
    }
  }

  private async getEmojiCaptionByMd5(md5Raw: string): Promise<string | null> {
    const md5 = normalizeEmojiMd5(md5Raw)
    if (!md5) return null

    if (this.emojiCaptionCache.has(md5)) {
      return this.emojiCaptionCache.get(md5) ?? null
    }

    const pending = this.emojiCaptionPending.get(md5)
    if (pending) return pending

    const task = (async (): Promise<string | null> => {
      try {
        const nativeResult = await wcdbService.getEmoticonCaptionStrict(md5)
        if (nativeResult.success) {
          const nativeCaption = normalizeEmojiCaption(nativeResult.caption)
          if (nativeCaption) return nativeCaption
        }
      } catch {
        // ignore and return null
      }
      return null
    })()

    this.emojiCaptionPending.set(md5, task)
    try {
      const caption = await task
      if (caption) {
        this.emojiCaptionCache.set(md5, caption)
      } else {
        this.emojiCaptionCache.delete(md5)
      }
      return caption
    } finally {
      this.emojiCaptionPending.delete(md5)
    }
  }

  private async hydrateEmojiCaptionsForMessages(
    sessionId: string,
    messages: any[],
    control?: ExportTaskControl
  ): Promise<void> {
    if (!Array.isArray(messages) || messages.length === 0) return

    // 某些环境下游标行缺失 47 的 md5，先按 localId 回填详情再做 caption 查询。
    await this.backfillMediaFieldsFromMessageDetail(sessionId, messages, new Set([47]), control)

    const unresolvedByUrl = new Map<string, any[]>()

    const uniqueMd5s = new Set<string>()
    let scanIndex = 0
    for (const msg of messages) {
      if ((scanIndex++ & 0x7f) === 0) {
        this.throwIfStopRequested(control)
      }
      if (Number(msg?.localType) !== 47) continue

      const content = String(msg?.content || '')
      const normalizedMd5 = normalizeEmojiMd5(msg?.emojiMd5)
        || this.extractEmojiMd5(content)
        || extractLooseHexMd5(content)
      const normalizedCdnUrl = normalizeEmojiCdnUrl(msg?.emojiCdnUrl || this.extractEmojiUrl(content))
      if (normalizedCdnUrl) {
        msg.emojiCdnUrl = normalizedCdnUrl
      }
      if (!normalizedMd5) {
        if (normalizedCdnUrl) {
          const bucket = unresolvedByUrl.get(normalizedCdnUrl) || []
          bucket.push(msg)
          unresolvedByUrl.set(normalizedCdnUrl, bucket)
        } else {
          msg.emojiMd5 = undefined
          msg.emojiCaption = undefined
        }
        continue
      }

      msg.emojiMd5 = normalizedMd5
      uniqueMd5s.add(normalizedMd5)
    }

    const unresolvedUrls = Array.from(unresolvedByUrl.keys())
    if (unresolvedUrls.length > 0) {
      await parallelLimit(unresolvedUrls, this.emojiCaptionLookupConcurrency, async (url, index) => {
        if ((index & 0x0f) === 0) {
          this.throwIfStopRequested(control)
        }
        const resolvedMd5 = await this.getEmojiMd5ByCdnUrl(url)
        if (!resolvedMd5) return
        const attached = unresolvedByUrl.get(url) || []
        for (const msg of attached) {
          msg.emojiMd5 = resolvedMd5
          uniqueMd5s.add(resolvedMd5)
        }
      })
    }

    const md5List = Array.from(uniqueMd5s)
    if (md5List.length > 0) {
      await parallelLimit(md5List, this.emojiCaptionLookupConcurrency, async (md5, index) => {
        if ((index & 0x0f) === 0) {
          this.throwIfStopRequested(control)
        }
        await this.getEmojiCaptionByMd5(md5)
      })
    }

    let assignIndex = 0
    for (const msg of messages) {
      if ((assignIndex++ & 0x7f) === 0) {
        this.throwIfStopRequested(control)
      }
      if (Number(msg?.localType) !== 47) continue
      const md5 = normalizeEmojiMd5(msg?.emojiMd5)
      if (!md5) {
        msg.emojiCaption = undefined
        continue
      }
      const caption = this.emojiCaptionCache.get(md5) ?? null
      msg.emojiCaption = caption || undefined
    }
  }

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
    const wxid = this.getConfiguredMyWxid()
    const dbPath = this.getConfiguredDbPath()
    const decryptKey = String(this.runtimeConfig?.decryptKey || this.configService.get('decryptKey') || '').trim()
    if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
    if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }
    if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }

    const cleanedWxid = cleanAccountDirName(wxid)
    const accountDir = this.configService.getAccountDir(dbPath, wxid)
    if (!accountDir) return { success: false, error: '无法找到账号目录' }
    const ok = await wcdbService.open(accountDir, decryptKey)
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
   * 获取群成员群昵称。后端结果为唯一业务真值，前端仅做冲突净化防串号。
   */
  async getGroupNicknamesForRoom(chatroomId: string, candidates: string[] = []): Promise<Map<string, string>> {
    try {
      const dllResult = await wcdbService.getGroupNicknames(chatroomId)
      if (!dllResult.success || !dllResult.nicknames) {
        return new Map<string, string>()
      }
      return this.buildTrustedGroupNicknameMap(Object.entries(dllResult.nicknames), candidates)
    } catch (e) {
      console.error('getGroupNicknamesForRoom service error:', e)
      return new Map<string, string>()
    }
  }

  private normalizeGroupNicknameIdentity(value: string): string {
    const raw = String(value || '').trim()
    if (!raw) return ''
    return raw.toLowerCase()
  }

  private buildTrustedGroupNicknameMap(
    entries: Iterable<[string, string]>,
    candidates: string[] = []
  ): Map<string, string> {
    const candidateSet = new Set(
      buildGroupNicknameIdCandidates(candidates)
        .map((id) => this.normalizeGroupNicknameIdentity(id))
        .filter(Boolean)
    )

    const buckets = new Map<string, Set<string>>()
    for (const [memberIdRaw, nicknameRaw] of entries) {
      const identity = this.normalizeGroupNicknameIdentity(memberIdRaw || '')
      if (!identity) continue
      if (candidateSet.size > 0 && !candidateSet.has(identity)) continue

      const nickname = normalizeGroupNickname(nicknameRaw || '')
      if (!nickname) continue

      const slot = buckets.get(identity)
      if (slot) {
        slot.add(nickname)
      } else {
        buckets.set(identity, new Set([nickname]))
      }
    }

    const trusted = new Map<string, string>()
    for (const [identity, nicknameSet] of buckets.entries()) {
      if (nicknameSet.size !== 1) continue
      trusted.set(identity, Array.from(nicknameSet)[0])
    }
    return trusted
  }

  private mergeGroupNicknameEntries(
    target: Map<string, string>,
    entries: Iterable<[string, string]>
  ): void {
    for (const [memberIdRaw, nicknameRaw] of entries) {
      const nickname = normalizeGroupNickname(nicknameRaw || '')
      if (!nickname) continue
      for (const alias of buildGroupNicknameIdCandidates([memberIdRaw])) {
        if (!alias) continue
        if (!target.has(alias)) target.set(alias, nickname)
        const lower = alias.toLowerCase()
        if (!target.has(lower)) target.set(lower, nickname)
      }
    }
  }

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

    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

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
    const left = new Set(buildGroupNicknameIdCandidates([lhs]).map((id) => id.toLowerCase()))
    if (left.size === 0) return false
    const right = buildGroupNicknameIdCandidates([rhs]).map((id) => id.toLowerCase())
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
    isSend?: boolean,
    emojiCaption?: string
  ): string | null {
    if (!content && localType === 47) {
      return formatEmojiSemanticText(emojiCaption)
    }
    if (!content) return null

    const normalizedContent = this.normalizeAppMessageContent(content)
    const xmlType = this.extractAppMessageType(normalizedContent)

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
      case 47: return formatEmojiSemanticText(emojiCaption)
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
        const title = this.extractXmlValue(normalizedContent, 'title')
        const type = this.extractAppMessageType(normalizedContent)
        const songName = this.extractXmlValue(normalizedContent, 'songname')

        // 转账消息特殊处理
        if (type === '2000') {
          const feedesc = this.extractXmlValue(normalizedContent, 'feedesc')
          const payMemo = this.extractXmlValue(normalizedContent, 'pay_memo')
          const transferPrefix = this.getTransferPrefix(normalizedContent, myWxid, senderWxid, isSend)
          if (feedesc) {
            return payMemo ? `${transferPrefix} ${feedesc} ${payMemo}` : `${transferPrefix} ${feedesc}`
          }
          return transferPrefix
        }

        if (type === '3') return songName ? `[音乐] ${songName}` : (title ? `[音乐] ${title}` : '[音乐]')
        if (type === '6') return title ? `[文件] ${title}` : '[文件]'
        if (type === '19') return this.formatForwardChatRecordContent(normalizedContent)
        if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]'
        if (type === '57') {
          const quoteDisplay = this.extractQuotedReplyDisplay(content)
          if (quoteDisplay) {
            return this.buildQuotedReplyText(quoteDisplay)
          }
          return title || '[引用消息]'
        }
        if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]'
        return title ? `[链接] ${title}` : '[链接]'
      }
      case 50: return this.parseVoipMessage(content)
      case 10000: return this.cleanSystemMessage(content)
      case 266287972401: return this.cleanSystemMessage(content)  // 拍一拍
      case 244813135921: {
        // 引用消息
        const quoteDisplay = this.extractQuotedReplyDisplay(content)
        if (quoteDisplay) {
          return this.buildQuotedReplyText(quoteDisplay)
        }
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
          if (xmlType === '19') return this.formatForwardChatRecordContent(normalizedContent)
          if (xmlType === '33' || xmlType === '36') return title ? `[小程序] ${title}` : '[小程序]'
          if (xmlType === '57') {
            const quoteDisplay = this.extractQuotedReplyDisplay(content)
            if (quoteDisplay) {
              return this.buildQuotedReplyText(quoteDisplay)
            }
            return title || '[引用消息]'
          }
          if (xmlType === '53') return title ? `[接龙] ${title.split(/\r?\n/).map(line => line.trim()).find(Boolean) || title}` : '[接龙]'
          if (xmlType === '5' || xmlType === '49') return title ? `[链接] ${title}` : '[链接]'

          // 有 title 就返回 title
          if (title) return title
        }

        // 最后尝试提取文本内容
        return this.stripSenderPrefix(normalizedContent) || null
    }
  }

  private formatPlainExportContent(
    content: string,
    localType: number,
    options: { exportVoiceAsText?: boolean },
    voiceTranscript?: string,
    myWxid?: string,
    senderWxid?: string,
    isSend?: boolean,
    emojiCaption?: string
  ): string {
    const safeContent = content || ''
    const readableSystemText = this.extractReadableSystemMessageText(safeContent)
    if (readableSystemText && this.isReadableSystemMessage(localType, safeContent)) {
      return readableSystemText
    }

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
    if (localType === 47) {
      return formatEmojiSemanticText(emojiCaption)
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
      const subTypeRaw = this.extractAppMessageType(normalized)
      const subType = subTypeRaw ? parseInt(subTypeRaw, 10) : 0
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
        return this.formatForwardChatRecordContent(normalized)
      }
      if (subType === 33 || subType === 36) {
        const appName = this.extractXmlValue(normalized, 'appname') || title || '小程序'
        return `[小程序]${appName}`
      }
      if (subType === 57) {
        const quoteDisplay = this.extractQuotedReplyDisplay(safeContent)
        if (quoteDisplay) {
          return this.buildQuotedReplyText(quoteDisplay)
        }
        return title || '[引用消息]'
      }
      if (title) {
        return `[链接]${title}`
      }
      return '[其他消息]'
    }

    return '[其他消息]'
  }

  private formatQuotedReferencePreview(content: string, type?: string): string {
    const safeContent = content || ''
    const referType = Number.parseInt(String(type || ''), 10)
    if (!Number.isFinite(referType)) {
      const sanitized = this.sanitizeQuotedContent(safeContent)
      return sanitized || '[消息]'
    }

    if (referType === 49) {
      const normalized = this.normalizeAppMessageContent(safeContent)
      const title =
        this.extractXmlValue(normalized, 'title') ||
        this.extractXmlValue(normalized, 'filename') ||
        this.extractXmlValue(normalized, 'appname')
      if (title) return this.stripSenderPrefix(title)

      const subTypeRaw = this.extractAppMessageType(normalized)
      const subType = subTypeRaw ? parseInt(subTypeRaw, 10) : 0
      if (subType === 6) return '[文件]'
      if (subType === 19) return '[聊天记录]'
      if (subType === 33 || subType === 36) return '[小程序]'
      return '[链接]'
    }

    return this.formatPlainExportContent(safeContent, referType, { exportVoiceAsText: false }) || '[消息]'
  }

  private resolveQuotedSenderUsername(fromusr?: string, chatusr?: string): string {
    const normalizedChatUsr = String(chatusr || '').trim()
    const normalizedFromUsr = String(fromusr || '').trim()

    if (normalizedChatUsr) {
      return normalizedChatUsr
    }

    if (normalizedFromUsr.endsWith('@chatroom')) {
      return ''
    }

    return normalizedFromUsr
  }

  private buildQuotedReplyText(display: {
    replyText: string
    quotedSender?: string
    quotedPreview: string
  }): string {
    const quoteLabel = display.quotedSender
      ? `${display.quotedSender}：${display.quotedPreview}`
      : display.quotedPreview
    if (display.replyText) {
      return `${display.replyText}[引用 ${quoteLabel}]`
    }
    return `[引用 ${quoteLabel}]`
  }

  private extractQuotedReplyDisplay(content: string): {
    replyText: string
    quotedSender?: string
    quotedPreview: string
  } | null {
    try {
      const normalized = this.normalizeAppMessageContent(content || '')
      const referMsgStart = normalized.indexOf('<refermsg>')
      const referMsgEnd = normalized.indexOf('</refermsg>')
      if (referMsgStart === -1 || referMsgEnd === -1) {
        return null
      }

      const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
      const quoteInfo = this.parseQuoteMessage(normalized)
      const replyText = this.stripSenderPrefix(this.extractXmlValue(normalized, 'title') || '')
      const quotedPreview = quoteInfo.content || this.formatQuotedReferencePreview(
        this.extractXmlValue(referMsgXml, 'content'),
        this.extractXmlValue(referMsgXml, 'type')
      )

      if (!replyText && !quotedPreview) {
        return null
      }

      return {
        replyText,
        quotedSender: quoteInfo.sender || undefined,
        quotedPreview: quotedPreview || '[消息]'
      }
    } catch {
      return null
    }
  }

  private isQuotedReplyMessage(localType: number, content: string): boolean {
    if (localType === 244813135921) return true
    const normalized = this.normalizeAppMessageContent(content || '')
    if (!(localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>'))) {
      return false
    }
    const subType = this.extractAppMessageType(normalized)
    return subType === '57' || normalized.includes('<refermsg>')
  }

  private async resolveQuotedReplyDisplayWithNames(args: {
    content: string
    isGroup: boolean
    displayNamePreference: ExportOptions['displayNamePreference']
    getContact: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>
    groupNicknamesMap: Map<string, string>
    cleanedMyWxid: string
    rawMyWxid?: string
    myDisplayName?: string
  }): Promise<{
    replyText: string
    quotedSender?: string
    quotedPreview: string
  } | null> {
    const base = this.extractQuotedReplyDisplay(args.content)
    if (!base) return null
    if (base.quotedSender) return base

    const normalized = this.normalizeAppMessageContent(args.content || '')
    const referMsgStart = normalized.indexOf('<refermsg>')
    const referMsgEnd = normalized.indexOf('</refermsg>')
    if (referMsgStart === -1 || referMsgEnd === -1) {
      return base
    }

    const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
    const quotedSenderUsername = this.resolveQuotedSenderUsername(
      this.extractXmlValue(referMsgXml, 'fromusr'),
      this.extractXmlValue(referMsgXml, 'chatusr')
    )
    if (!quotedSenderUsername) {
      return base
    }

    const isQuotedSelf = this.isSameWxid(quotedSenderUsername, args.cleanedMyWxid)
    const fallbackDisplayName = isQuotedSelf
      ? (args.myDisplayName || quotedSenderUsername)
      : quotedSenderUsername

    const profile = await this.resolveExportDisplayProfile(
      quotedSenderUsername,
      args.displayNamePreference,
      args.getContact,
      args.groupNicknamesMap,
      fallbackDisplayName,
      isQuotedSelf ? [args.rawMyWxid, args.cleanedMyWxid] : []
    )

    return {
      ...base,
      quotedSender: profile.displayName || fallbackDisplayName || base.quotedSender
    }
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
    const normalized = this.normalizeAppMessageContent(content || '')
    const xmlType = this.extractAppMessageType(normalized)
    if (localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>')) {
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

  private extractReadableSystemMessageText(content: string): string {
    if (!content) return ''
    const normalized = this.normalizeAppMessageContent(content)
    const sysmsgMatch = /<sysmsg\b[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(this.stripSenderPrefix(normalized))
    const source = sysmsgMatch?.[1] || normalized
    const text =
      this.extractXmlValue(source, 'plain') ||
      this.extractXmlValue(source, 'text') ||
      ''
    return this.stripSenderPrefix(text).replace(/\s+/g, ' ').trim()
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
      const normalized = this.normalizeAppMessageContent(content)
      if (this.isReadableSystemMessage(localType, normalized)) {
        return '系统消息'
      }
      const xmlType = this.extractAppMessageType(normalized)

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
    return escapeHtml(value).replace(/\r?\n/g, '<br />')
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
  private parseChatHistory(content: string): ForwardChatRecordItem[] | undefined {
    try {
      const normalized = this.normalizeAppMessageContent(content || '')
      const appMsgType = this.extractAppMessageType(normalized)
      if (appMsgType !== '19' && !normalized.includes('<recorditem')) {
        return undefined
      }

      const items: ForwardChatRecordItem[] = []
      const dedupe = new Set<string>()
      const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
      let recordItemMatch: RegExpExecArray | null
      while ((recordItemMatch = recordItemRegex.exec(normalized)) !== null) {
        const parsedItems = this.parseForwardChatRecordContainer(recordItemMatch[1] || '')
        for (const item of parsedItems) {
          const dedupeKey = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}`
          if (!dedupe.has(dedupeKey)) {
            dedupe.add(dedupeKey)
            items.push(item)
          }
        }
      }

      if (items.length === 0 && normalized.includes('<dataitem')) {
        const fallbackItems = this.parseForwardChatRecordContainer(normalized)
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

  private parseForwardChatRecordContainer(containerXml: string): ForwardChatRecordItem[] {
    const source = containerXml || ''
    if (!source) return []

    const segments: string[] = [source]
    const decodedContainer = this.decodeHtmlEntities(source)
    if (decodedContainer !== source) {
      segments.push(decodedContainer)
    }

    const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g
    let cdataMatch: RegExpExecArray | null
    while ((cdataMatch = cdataRegex.exec(source)) !== null) {
      const cdataInner = cdataMatch[1] || ''
      if (cdataInner) {
        segments.push(cdataInner)
        const decodedInner = this.decodeHtmlEntities(cdataInner)
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
        const parsed = this.parseForwardChatRecordDataItem(dataItemMatch[2] || '', dataItemMatch[1] || '')
        if (!parsed) continue
        const key = `${parsed.datatype}|${parsed.sourcename}|${parsed.sourcetime}|${parsed.datadesc || ''}|${parsed.datatitle || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          items.push(parsed)
        }
      }
    }

    if (items.length > 0) return items
    const fallback = this.parseForwardChatRecordDataItem(source, '')
    return fallback ? [fallback] : []
  }

  private parseForwardChatRecordDataItem(body: string, attrs: string): ForwardChatRecordItem | null {
    const datatypeByAttr = /datatype\s*=\s*["']?(\d+)["']?/i.exec(attrs || '')
    const datatypeRaw = datatypeByAttr?.[1] || this.extractXmlValue(body, 'datatype') || '0'
    const datatype = Number.parseInt(datatypeRaw, 10)
    const sourcename = this.decodeHtmlEntities(this.extractXmlValue(body, 'sourcename'))
    const sourcetime = this.extractXmlValue(body, 'sourcetime')
    const sourceheadurl = this.extractXmlValue(body, 'sourceheadurl')
    const datadesc = this.decodeHtmlEntities(this.extractXmlValue(body, 'datadesc') || this.extractXmlValue(body, 'content'))
    const datatitle = this.decodeHtmlEntities(this.extractXmlValue(body, 'datatitle'))
    const fileext = this.extractXmlValue(body, 'fileext')
    const datasizeRaw = this.extractXmlValue(body, 'datasize')
    const datasize = datasizeRaw ? Number.parseInt(datasizeRaw, 10) : 0
    const nestedRecordXml = this.extractXmlValue(body, 'recordxml') || ''
    const nestedRecordList =
      datatype === 17 && nestedRecordXml
        ? this.parseForwardChatRecordContainer(nestedRecordXml)
        : undefined
    const chatRecordTitle = this.decodeHtmlEntities(
      (nestedRecordXml && this.extractXmlValue(nestedRecordXml, 'title')) || datatitle || ''
    )
    const chatRecordDesc = this.decodeHtmlEntities(
      (nestedRecordXml && this.extractXmlValue(nestedRecordXml, 'desc')) || datadesc || ''
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

  private formatForwardChatRecordItemText(item: ForwardChatRecordItem): string {
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

  private buildForwardChatRecordLines(record: ForwardChatRecordItem, depth = 0): string[] {
    const indent = depth > 0 ? `${'  '.repeat(Math.min(depth, 8))}` : ''
    const senderPrefix = record.sourcename ? `${record.sourcename}: ` : ''
    if (record.chatRecordList && record.chatRecordList.length > 0) {
      const nestedTitle = record.chatRecordTitle || record.datatitle || record.chatRecordDesc || '聊天记录'
      const header = `${indent}${senderPrefix}[转发的聊天记录]${nestedTitle}`
      const nestedLines = record.chatRecordList.flatMap((item) => this.buildForwardChatRecordLines(item, depth + 1))
      return [header, ...nestedLines]
    }
    const text = this.formatForwardChatRecordItemText(record)
    return [`${indent}${senderPrefix}${text}`]
  }

  private formatForwardChatRecordContent(content: string): string {
    const normalized = this.normalizeAppMessageContent(content || '')
    const forwardName =
      this.extractXmlValue(normalized, 'nickname') ||
      this.extractXmlValue(normalized, 'title') ||
      this.extractXmlValue(normalized, 'des') ||
      this.extractXmlValue(normalized, 'displayname') ||
      '聊天记录'
    const records = this.parseChatHistory(normalized)
    if (!records || records.length === 0) {
      return forwardName ? `[转发的聊天记录]${forwardName}` : '[转发的聊天记录]'
    }

    const lines = records.flatMap((record) => this.buildForwardChatRecordLines(record))
    return `${forwardName ? `[转发的聊天记录]${forwardName}` : '[转发的聊天记录]'}\n${lines.join('\n')}`
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
    const normalized = this.normalizeAppMessageContent(content)
    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(normalized)
    if (appmsgMatch) {
      const appmsgInner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
      if (typeMatch) return typeMatch[1].trim()
    }
    if (!normalized.includes('<appmsg') && !normalized.includes('<msg>')) {
      return ''
    }
    const fallbackTypeMatch = /<type>(\d+)<\/type>/i.exec(normalized)
    return fallbackTypeMatch ? fallbackTypeMatch[1] : ''
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

  private async resolveQuotedMessagesForExport(messages: any[], sessionId: string): Promise<void> {
    const svridsToResolve: Array<{ msg: any; svrid: string }> = []

    for (const msg of messages) {
      if (msg.replyToMessageId && msg.quotedContent === '[消息]') {
        svridsToResolve.push({ msg, svrid: msg.replyToMessageId })
      }
    }

    if (svridsToResolve.length === 0) return

    const results = await Promise.allSettled(
      svridsToResolve.map(({ svrid }) => wcdbService.getMessageByServerId(sessionId, svrid))
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const { msg } = svridsToResolve[i]

      if (result.status === 'fulfilled' && result.value.success && result.value.row) {
        const localType = parseInt(result.value.row.local_type || '0', 10)
        const rawMessageContent = result.value.row.message_content
        const rawCompressContent = result.value.row.compress_content
        const content = chatService['decodeMessageContent'](rawMessageContent, rawCompressContent)

        if (localType === 1) {
          msg.quotedContent = chatService['sanitizeQuotedContent'](content)
        } else if (localType === 3) {
          msg.quotedContent = '[图片]'
        } else if (localType === 34) {
          msg.quotedContent = '[语音]'
        } else if (localType === 43) {
          msg.quotedContent = '[视频]'
        } else if (localType === 47) {
          msg.quotedContent = '[动画表情]'
        } else if (localType === 49) {
          msg.quotedContent = '[链接]'
        }
      }
    }
  }

  private parseQuoteMessage(content: string): { content?: string; sender?: string; type?: string; svrid?: string } {
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
      const svrid = this.extractXmlValue(referMsgXml, 'svrid')
      let displayContent = referContent

      switch (referType) {
        case '1':
          displayContent = this.extractPreferredQuotedText(referMsgXml)
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

  private extractPreferredQuotedText(referMsgXml: string): string {
    if (!referMsgXml) return ''

    const sources = [this.decodeHtmlEntities(referMsgXml)]
    const rawMsgSource = this.extractXmlValue(referMsgXml, 'msgsource')
    if (rawMsgSource) {
      const decodedMsgSource = this.decodeHtmlEntities(rawMsgSource)
      if (decodedMsgSource) {
        sources.push(decodedMsgSource)
      }
    }

    const fullContent = this.sanitizeQuotedContent(this.extractXmlValue(sources[0] || referMsgXml, 'content'))
    const partialText = this.extractPartialQuotedText(sources[0] || referMsgXml, fullContent)
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
        const value = this.sanitizeQuotedContent(this.extractXmlValue(source, tag))
        if (value) return value
      }
    }

    return fullContent
  }

  private extractPartialQuotedText(xml: string, fullContent: string): string {
    if (!xml || !fullContent) return ''

    const startChar = this.extractXmlValue(xml, 'start')
    const endChar = this.extractXmlValue(xml, 'end')
    const startIndexRaw = this.extractXmlValue(xml, 'startindex')
    const endIndexRaw = this.extractXmlValue(xml, 'endindex')
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

  private extractChatLabReplyToMessageId(content: string): string | undefined {
    try {
      const normalized = this.normalizeAppMessageContent(content || '')
      const referMsgStart = normalized.indexOf('<refermsg>')
      const referMsgEnd = normalized.indexOf('</refermsg>')
      if (referMsgStart === -1 || referMsgEnd === -1) {
        return undefined
      }

      const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
      const replyToMessageIdRaw = normalizeUnsignedIntToken(this.extractXmlValue(referMsgXml, 'svrid'))
      return replyToMessageIdRaw !== '0' ? replyToMessageIdRaw : undefined
    } catch {
      return undefined
    }
  }

  private getExportPlatformMessageId(msg: { serverIdRaw?: unknown; serverId?: unknown }): string | undefined {
    const value = normalizeUnsignedIntToken(msg.serverIdRaw ?? msg.serverId)
    return value !== '0' ? value : undefined
  }

  private getExportReplyToMessageId(content: string): string | undefined {
    return this.extractChatLabReplyToMessageId(content)
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
    } else if (xmlType === '53') {
      appMsgKind = 'solitaire'
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
      if (quoteInfo.svrid) meta.quotedSvrid = quoteInfo.svrid
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
        return escapeHtml(`[${part}]`)
      }
      return escapeHtml(part)
    })
    return rendered.join('')
  }

  private extractHtmlLinkCard(content: string, localType: number): { title: string; url: string } | null {
    if (!content) return null

    const normalized = this.normalizeAppMessageContent(content)
    const isAppMessage = localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>')
    if (!isAppMessage) return null

    const subType = this.extractAppMessageType(normalized)
    if (subType && subType !== '5' && subType !== '49') return null

    const url = [
      this.extractXmlValue(normalized, 'url'),
      this.extractXmlValue(normalized, 'shareurlopen'),
      this.extractXmlValue(normalized, 'shareurloriginal'),
      this.extractXmlValue(normalized, 'shareurl'),
      this.extractXmlValue(normalized, 'shorturl'),
      this.extractXmlValue(normalized, 'dataurl'),
      this.extractXmlValue(normalized, 'lowurl'),
      this.extractXmlValue(normalized, 'streamvideoweburl'),
      this.extractXmlValue(normalized, 'weburl')
    ]
      .map(candidate => this.normalizeHtmlLinkUrl(candidate))
      .find(Boolean) || ''
    if (!url) return null

    const title = this.stripSenderPrefix(
      this.extractXmlValue(normalized, 'title') || this.extractXmlValue(normalized, 'des') || url
    ) || url
    return { title, url }
  }

  private normalizeHtmlLinkUrl(rawUrl: string): string {
    const value = (rawUrl || '').trim().replace(/&amp;/gi, '&')
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

  private getLinkCardDisplayTitle(linkCard: { title: string; url: string }): string {
    const normalizedTitle = this.stripSenderPrefix(String(linkCard.title || '').trim())
    return normalizedTitle || linkCard.url || '链接'
  }

  private formatLinkCardExportText(
    content: string,
    localType: number,
    style: 'markdown' | 'append-url'
  ): string | null {
    const linkCard = this.extractHtmlLinkCard(content, localType)
    if (!linkCard?.url) return null

    const title = this.getLinkCardDisplayTitle(linkCard)
    if (style === 'markdown') {
      return `[${title}](${linkCard.url})`
    }

    const prefix = title && title !== linkCard.url ? `[链接] ${title}` : '[链接]'
    return `${prefix}\n${linkCard.url}`
  }

  private applyExcelLinkCardCell(cell: ExcelJS.Cell, content: string, localType: number): boolean {
    const linkCard = this.extractHtmlLinkCard(content, localType)
    if (!linkCard?.url) return false

    const title = this.getLinkCardDisplayTitle(linkCard)
    cell.value = {
      text: title,
      hyperlink: linkCard.url,
      tooltip: linkCard.url
    } as any
    cell.font = {
      ...(cell.font || {}),
      color: { argb: 'FF0563C1' },
      underline: true
    }
    return true
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
      exportFiles?: boolean
      maxFileSizeMb?: number
      exportVoiceAsText?: boolean
      includeVideoPoster?: boolean
      includeVoiceWithTranscript?: boolean
      dirCache?: Set<string>
      control?: ExportTaskControl
    }
  ): Promise<MediaExportItem | null> {
    const localType = msg.localType

    // 图片消息
    if (localType === 3 && options.exportImages) {
      const result = await this.exportImage(
        msg,
        sessionId,
        mediaRootDir,
        mediaRelativePrefix,
        options.dirCache,
        options.control
      )
      if (result) {
      }
      return result
    }

    // 语音消息
    if (localType === 34) {
      if (options.exportVoices) {
        return this.exportVoice(msg, sessionId, mediaRootDir, mediaRelativePrefix, options.dirCache, options.control)
      }
      if (options.exportVoiceAsText) {
        return null
      }
    }

    // 动画表情
    if (localType === 47 && options.exportEmojis) {
      const result = await this.exportEmoji(msg, sessionId, mediaRootDir, mediaRelativePrefix, options.dirCache, options.control)
      if (result) {
      }
      return result
    }

    if (localType === 43 && options.exportVideos) {
      return this.exportVideo(
        msg,
        sessionId,
        mediaRootDir,
        mediaRelativePrefix,
        options.dirCache,
        options.includeVideoPoster === true,
        options.control
      )
    }

    if (options.exportFiles && this.isFileAppMessage(msg)) {
      return this.exportFileAttachment(
        msg,
        mediaRootDir,
        mediaRelativePrefix,
        options.maxFileSizeMb,
        options.dirCache,
        options.control
      )
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
    mediaRelativePrefix: string,
    dirCache?: Set<string>,
    control?: ExportTaskControl
  ): Promise<MediaExportItem | null> {
    try {
      const imagesDir = path.join(mediaRootDir, mediaRelativePrefix, 'images')
      await this.ensureExportDir(imagesDir, control, dirCache)

      const tryResolveImagePath = async (
        imageMd5?: string,
        imageDatName?: string,
        imageOriginSourceMd5?: string
      ): Promise<string | null> => {
        if (!imageMd5 && !imageOriginSourceMd5 && !imageDatName) return null
        return this.runWithChatImagePipelineLimit(async () => {
          const pickResolvedImagePath = (result: any): string | null => {
            if (!result?.success) return null
            const resolved = String(result.localPath || '').trim()
            return resolved || null
          }

          const resolveCachedPath = async (
            candidateMd5?: string,
            candidateDatName?: string,
            candidateOriginSourceMd5?: string
          ): Promise<string | null> => {
            const cachedResult = await imageDecryptService.resolveCachedImage({
              sessionId,
              imageMd5: candidateMd5,
              imageOriginSourceMd5: candidateOriginSourceMd5,
              imageDatName: candidateDatName,
              createTime: msg.createTime,
              preferFilePath: true,
              hardlinkOnly: true,
              disableUpdateCheck: true,
              allowCacheIndex: true,
              suppressEvents: true
            })
            return pickResolvedImagePath(cachedResult)
          }

          const cachedPath = await resolveCachedPath(imageMd5, imageDatName, imageOriginSourceMd5)
          if (cachedPath) {
            return cachedPath
          }

          const decryptResult = await imageDecryptService.decryptImage({
            sessionId,
            imageMd5,
            imageOriginSourceMd5,
            imageDatName,
            createTime: msg.createTime,
            force: false,
            preferFilePath: true,
            hardlinkOnly: true,
            allowCacheIndex: true
          })
          const decryptedPath = pickResolvedImagePath(decryptResult)
          if (decryptedPath) return decryptedPath

          const localId = Number(msg?.localId || 0)
          if (Number.isFinite(localId) && localId > 0) {
            const fallback = await chatService.getImageData(sessionId, String(localId))
            if (fallback.success && fallback.data) {
              const buffer = Buffer.from(fallback.data, 'base64')
              const mime = this.detectMimeType(buffer) || 'image/jpeg'
              return `data:${mime};base64,${fallback.data}`
            }
          }

          if (decryptResult.failureKind === 'decrypt_failed') {
            console.log(`[Export] 图片解密失败 (localId=${msg.localId}): imageMd5=${imageMd5 || ''}, imageDatName=${imageDatName || ''}, error=${decryptResult.error || '未知'}`)
          } else {
            console.log(`[Export] 图片本地无数据 (localId=${msg.localId}): imageMd5=${imageMd5 || ''}, imageDatName=${imageDatName || ''}, error=${decryptResult.error || '未知'}`)
          }

          const thumbResult = await imageDecryptService.resolveCachedImage({
            sessionId,
            imageMd5,
            imageOriginSourceMd5,
            imageDatName,
            createTime: msg.createTime,
            preferFilePath: true,
            hardlinkOnly: true,
            disableUpdateCheck: true,
            allowCacheIndex: true,
            suppressEvents: true
          })
          if (thumbResult.success && thumbResult.localPath) {
            console.log(`[Export] 使用缩略图替代 (localId=${msg.localId}): ${thumbResult.localPath}`)
            return thumbResult.localPath
          }
          return null
        })
      }

      // 使用消息对象中已提取的字段，先尝试快速导出。
      let imageMd5 = String(msg.imageMd5 || '').trim().toLowerCase() || undefined
      let imageOriginSourceMd5 = String(msg.imageOriginSourceMd5 || '').trim().toLowerCase() || undefined
      let imageDatName = String(msg.imageDatName || '').trim().toLowerCase() || undefined
      const initialMissingRunCacheKey = getImageMissingRunCacheKey(sessionId, imageMd5, imageDatName)
      if (initialMissingRunCacheKey && this.mediaRuntime.hasMissingImageRunCacheKey(initialMissingRunCacheKey)) {
        return null
      }
      let sourcePath = await tryResolveImagePath(imageMd5, imageDatName, imageOriginSourceMd5)

      // 快速流字段存在偏差时，按 localId 强制回填再重试一次，避免“导出进度前进但写入 0”。
      if (!sourcePath) {
        const localId = Number(msg?.localId || 0)
        if (Number.isFinite(localId) && localId > 0) {
          await this.backfillMediaFieldsFromMessageDetail(sessionId, [msg], new Set([3]), undefined, { force: true })
          imageMd5 = String(msg.imageMd5 || '').trim().toLowerCase() || undefined
          imageOriginSourceMd5 = String(msg.imageOriginSourceMd5 || '').trim().toLowerCase() || undefined
          imageDatName = String(msg.imageDatName || '').trim().toLowerCase() || undefined
          sourcePath = await tryResolveImagePath(imageMd5, imageDatName, imageOriginSourceMd5)
        }
      }

      if (!sourcePath) {
        const missingRunCacheKey = getImageMissingRunCacheKey(sessionId, imageMd5, imageDatName)
        console.log(`[Export] 缩略图也获取失败，所有方式均失败 → 将显示 [图片] 占位符`)
        if (missingRunCacheKey) {
          this.mediaRuntime.addMissingImageRunCacheKey(missingRunCacheKey)
        }
        return null
      }

      // 为每条消息生成稳定且唯一的文件名前缀，避免跨日期/消息发生同名覆盖
      const messageId = String(msg.localId || Date.now())
      const imageKey = (imageMd5 || imageDatName || 'image').replace(/[^a-zA-Z0-9_-]/g, '')

      // 从 data URL 或 file URL 获取实际路径
      if (sourcePath.startsWith('data:')) {
        // 是 data URL，需要保存为文件
        const base64Data = sourcePath.split(',')[1]
        const ext = this.getExtFromDataUrl(sourcePath)
        const fileName = `${messageId}_${imageKey}${ext}`
        const destPath = path.join(imagesDir, fileName)

        const buffer = Buffer.from(base64Data, 'base64')
        await this.recordCreatedFileBeforeWrite(destPath, control)
        await fs.promises.writeFile(destPath, buffer)
        this.noteMediaTelemetry({
          doneFiles: 1,
          cacheMissFiles: 1,
          bytesWritten: buffer.length
        })

        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'images', fileName),
          kind: 'image'
        }
      } else if (sourcePath.startsWith('file://')) {
        sourcePath = fileURLToPath(sourcePath)
      }

      // 复制文件
      const ext = path.extname(sourcePath) || '.jpg'
      const fileName = `${messageId}_${imageKey}${ext}`
      const destPath = path.join(imagesDir, fileName)
      const copied = await this.copyMediaWithCacheAndDedup('image', sourcePath, destPath, control)
      if (!copied.success) {
        if (copied.code === 'ENOENT') {
          console.log(`[Export] 源图片文件不存在 (localId=${msg.localId}): ${sourcePath} → 将显示 [图片] 占位符`)
        } else {
          console.log(`[Export] 复制图片失败 (localId=${msg.localId}): ${sourcePath}, code=${copied.code || 'UNKNOWN'} → 将显示 [图片] 占位符`)
        }
        return null
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

  private async preloadMediaLookupCaches(
    _sessionId: string,
    messages: any[],
    options: { exportImages?: boolean; exportVideos?: boolean },
    control?: ExportTaskControl
  ): Promise<void> {
    if (!Array.isArray(messages) || messages.length === 0) return

    const imageSources: any[] = []
    let scanIndex = 0
    for (const msg of messages) {
      if ((scanIndex++ & 0x7f) === 0) {
        this.throwIfStopRequested(control)
      }
      if (options.exportImages && msg?.localType === 3) {
        imageSources.push(msg)
      }
    }

    const imageMd5List = collectImageHardlinkMd5s(imageSources)
    if (imageMd5List.length > 0) {
      await runHardlinkPreloadIfNeeded(imageMd5List).catch((error) => {
        logOptionalError('ExportService.preloadHardlink', error)
      })
    }
    this.throwIfStopRequested(control)
  }

  /**
   * 导出语音文件
   */
  private async preloadVoiceWavCache(
    sessionId: string,
    messages: any[],
    control?: ExportTaskControl
  ): Promise<void> {
    if (!Array.isArray(messages) || messages.length === 0) return

    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return

    const normalized: Array<{
      localId: number
      createTime: number
      serverId?: string | number
      senderWxid?: string | null
    }> = []
    const seen = new Set<string>()

    for (const msg of messages) {
      const localIdRaw = Number(msg?.localId)
      const createTimeRaw = Number(msg?.createTime)
      const localId = Number.isFinite(localIdRaw) ? Math.max(0, Math.floor(localIdRaw)) : 0
      const createTime = Number.isFinite(createTimeRaw) ? Math.max(0, Math.floor(createTimeRaw)) : 0
      if (!localId || !createTime) continue
      const dedupeKey = getStableMessageKey(msg)
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      normalized.push({
        localId,
        createTime,
        serverId: msg?.serverId,
        senderWxid: msg?.senderUsername || null
      })
    }
    if (normalized.length === 0) return

    const chunkSize = 120
    for (let i = 0; i < normalized.length; i += chunkSize) {
      this.throwIfStopRequested(control)
      const chunk = normalized.slice(i, i + chunkSize)
      await chatService.preloadVoiceDataBatch(normalizedSessionId, chunk, {
        chunkSize: 48,
        decodeConcurrency: 3
      })
    }
  }

  /**
   * 导出语音文件
   */
  private async exportVoice(
    msg: any,
    sessionId: string,
    mediaRootDir: string,
    mediaRelativePrefix: string,
    dirCache?: Set<string>,
    control?: ExportTaskControl
  ): Promise<MediaExportItem | null> {
    try {
      const voicesDir = path.join(mediaRootDir, mediaRelativePrefix, 'voices')
      await this.ensureExportDir(voicesDir, control, dirCache)

      const msgId = String(msg.localId)
      const safeSession = cleanAccountDirName(sessionId)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 48) || 'session'
      const stableKey = getStableMessageKey(msg).replace(/:/g, '_')
      const fileName = `voice_${safeSession}_${stableKey || msgId}.wav`
      const destPath = path.join(voicesDir, fileName)

      // 如果已存在则跳过
      if (await pathExists(destPath)) {
        return {
          relativePath: path.posix.join(mediaRelativePrefix, 'voices', fileName),
          kind: 'voice'
        }
      }

      // 调用 chatService 获取语音数据
      const voiceResult = await chatService.getVoiceData(
        sessionId,
        msgId,
        Number.isFinite(Number(msg?.createTime)) ? Number(msg.createTime) : undefined,
        msg?.serverId,
        msg?.senderUsername || undefined
      )
      if (!voiceResult.success || !voiceResult.data) {
        return null
      }

      // voiceResult.data 是 base64 编码的 wav 数据
      const wavBuffer = Buffer.from(voiceResult.data, 'base64')
      await this.recordCreatedFileBeforeWrite(destPath, control)
      await fs.promises.writeFile(destPath, wavBuffer)
      this.noteMediaTelemetry({
        doneFiles: 1,
        bytesWritten: wavBuffer.length
      })

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
    mediaRelativePrefix: string,
    dirCache?: Set<string>,
    control?: ExportTaskControl
  ): Promise<MediaExportItem | null> {
    try {
      const emojisDir = path.join(mediaRootDir, mediaRelativePrefix, 'emojis')
      await this.ensureExportDir(emojisDir, control, dirCache)

      // 使用 chatService 下载表情包 (利用其重试和 fallback 逻辑)
      const localPath = await chatService.downloadEmojiFile(msg)

      if (!localPath) {
        return null
      }

      // 确定目标文件名
      const ext = path.extname(localPath) || '.gif'
      const key = msg.emojiMd5 || String(msg.localId)
      const fileName = `${key}${ext}`
      const destPath = path.join(emojisDir, fileName)
      const copied = await this.copyMediaWithCacheAndDedup('emoji', localPath, destPath, control)
      if (!copied.success) return null

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
    mediaRelativePrefix: string,
    dirCache?: Set<string>,
    includePoster = false,
    control?: ExportTaskControl
  ): Promise<MediaExportItem | null> {
    try {
      let videoMd5 = String(msg.videoMd5 || '').trim().toLowerCase()
      const resolveVideoInfo = async (token: string) => {
        if (!token) return null
        const videoInfo = await videoService.getVideoInfo(token, { includePoster })
        if (!videoInfo.exists || !videoInfo.videoUrl) return null
        return videoInfo
      }

      let videoInfo = await resolveVideoInfo(videoMd5)
      if (!videoInfo) {
        const localId = Number(msg?.localId || 0)
        if (Number.isFinite(localId) && localId > 0) {
          await this.backfillMediaFieldsFromMessageDetail(sessionId, [msg], new Set([43]), undefined, { force: true })
          videoMd5 = String(msg.videoMd5 || '').trim().toLowerCase()
          videoInfo = await resolveVideoInfo(videoMd5)
        }
      }
      if (!videoInfo) return null

      const videosDir = path.join(mediaRootDir, mediaRelativePrefix, 'videos')
      await this.ensureExportDir(videosDir, control, dirCache)

      const sourcePath = videoInfo.videoUrl
      const fileName = path.basename(sourcePath)
      const destPath = path.join(videosDir, fileName)

      const copied = await this.copyMediaWithCacheAndDedup('video', sourcePath, destPath, control)
      if (!copied.success) return null

      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'videos', fileName),
        kind: 'video',
        posterDataUrl: includePoster ? (videoInfo.coverUrl || videoInfo.thumbUrl) : undefined
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

  private extractImageOriginSourceMd5(content: string): string | undefined {
    if (!content) return undefined
    const match = /originsourcemd5="([^"]+)"/i.exec(content)
    const value = match?.[1]?.trim().toLowerCase()
    if (!value) return undefined
    const displayMd5 = this.extractImageMd5(content)?.trim().toLowerCase()
    return value !== displayMd5 ? value : undefined
  }

  /**
   * 从消息内容提取图片 DAT 文件名
   */
  private extractImageDatName(content: string): string | undefined {
    if (!content) return undefined
    const candidate =
      this.extractXmlValue(content, 'imgname') ||
      this.extractXmlValue(content, 'cdnmidimgurl') ||
      this.extractXmlValue(content, 'cdnthumburl') ||
      this.extractXmlAttribute(content, 'img', 'imgname') ||
      this.extractXmlAttribute(content, 'img', 'cdnmidimgurl') ||
      this.extractXmlAttribute(content, 'img', 'cdnthumburl')
    return this.normalizeImageDatNameToken(candidate)
  }

  private normalizeImageDatNameToken(value: unknown): string | undefined {
    let text = String(value ?? '').trim()
    if (!text) return undefined
    text = text.replace(/&amp;/g, '&')
    try {
      if (text.includes('%')) text = decodeURIComponent(text)
    } catch { }

    const datLike = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/i.exec(text)
    if (datLike?.[1]) return datLike[1].toLowerCase()

    const base = text
      .split(/[?#]/, 1)[0]
      .replace(/^.*[\\/]/, '')
      .replace(/\.(?:t\.)?dat$/i, '')
      .trim()
    if (!base) return undefined

    const cdnToken = base.includes('_') ? base.split('_')[0] : base
    const exact = /^([a-fA-F0-9]{16,64})$/.exec(cdnToken)
    if (exact?.[1]) return exact[1].toLowerCase()

    const preferred32 = /([a-fA-F0-9]{32})(?![a-fA-F0-9])/i.exec(cdnToken)
    if (preferred32?.[1]) return preferred32[1].toLowerCase()
    const fallback = /([a-fA-F0-9]{16,64})(?![a-fA-F0-9])/i.exec(cdnToken)
    return fallback?.[1]?.toLowerCase()
  }

  private extractImageDatNameFromPackedRaw(raw: unknown): string | undefined {
    const buffer = this.decodePackedInfoBuffer(raw)
    if (!buffer || buffer.length === 0) return undefined
    const printable: number[] = []
    for (const byte of buffer) {
      printable.push(byte >= 0x20 && byte <= 0x7e ? byte : 0x20)
    }
    const text = Buffer.from(printable).toString('utf-8')
    const datLike = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/i.exec(text)
    if (datLike?.[1]) return datLike[1].toLowerCase()
    const fallback = /([0-9a-fA-F]{16,})/.exec(text)
    return fallback?.[1]?.toLowerCase()
  }

  private extractImageDatNameFromRow(row: Record<string, any>, content?: string): string | undefined {
    const byColumn = this.normalizeImageDatNameToken(getRowField(row, [
      'image_path',
      'imagePath',
      'image_dat_name',
      'imageDatName',
      'img_path',
      'imgPath',
      'img_name',
      'imgName'
    ]))
    if (byColumn) return byColumn

    const packedRaw = getRowField(row, [
      'packed_info_data',
      'packedInfoData',
      'packed_info_blob',
      'packedInfoBlob',
      'packed_info',
      'packedInfo',
      'BytesExtra',
      'bytes_extra',
      'WCDB_CT_packed_info',
      'reserved0',
      'Reserved0',
      'WCDB_CT_Reserved0'
    ])
    const byPacked = this.extractImageDatNameFromPackedRaw(packedRaw)
    if (byPacked) return byPacked

    return this.extractImageDatName(content || '')
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
    const match =
      /md5\s*=\s*['"]([a-fA-F0-9]{32})['"]/i.exec(content) ||
      /md5\s*=\s*([a-fA-F0-9]{32})/i.exec(content) ||
      /<md5>([a-fA-F0-9]{32})<\/md5>/i.exec(content)
    return normalizeEmojiMd5(match?.[1]) || extractLooseHexMd5(content)
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

  private decodePackedInfoBuffer(raw: unknown): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) return null
      const compactHex = trimmed.replace(/\s+/g, '')
      if (/^[a-fA-F0-9]+$/.test(compactHex) && compactHex.length % 2 === 0) {
        try {
          return Buffer.from(compactHex, 'hex')
        } catch { }
      }
      try {
        const decoded = Buffer.from(trimmed, 'base64')
        if (decoded.length > 0) return decoded
      } catch { }
      return null
    }
    if (typeof raw === 'object' && raw !== null && Array.isArray((raw as any).data)) {
      return Buffer.from((raw as any).data)
    }
    return null
  }

  private normalizeVideoFileToken(value: unknown): string | undefined {
    let text = String(value || '').trim().toLowerCase()
    if (!text) return undefined
    text = text.replace(/^.*[\\/]/, '')
    text = text.replace(/\.(?:mp4|mov|m4v|avi|mkv|flv|jpg|jpeg|png|gif|dat)$/i, '')
    text = text.replace(/_thumb$/, '')
    const direct = /^([a-f0-9]{16,64})(?:_raw)?$/i.exec(text)
    if (direct) {
      const suffix = /_raw$/i.test(text) ? '_raw' : ''
      return `${direct[1].toLowerCase()}${suffix}`
    }
    const preferred32 = /([a-f0-9]{32})(?![a-f0-9])/i.exec(text)
    if (preferred32?.[1]) return preferred32[1].toLowerCase()
    const fallback = /([a-f0-9]{16,64})(?![a-f0-9])/i.exec(text)
    return fallback?.[1]?.toLowerCase()
  }

  private extractVideoFileNameFromPackedRaw(raw: unknown): string | undefined {
    const buffer = this.decodePackedInfoBuffer(raw)
    if (!buffer || buffer.length === 0) return undefined
    const candidates: string[] = []
    let current = ''
    for (const byte of buffer) {
      const isHex =
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x46) ||
        (byte >= 0x61 && byte <= 0x66)
      if (isHex) {
        current += String.fromCharCode(byte)
        continue
      }
      if (current.length >= 16) candidates.push(current)
      current = ''
    }
    if (current.length >= 16) candidates.push(current)
    if (candidates.length === 0) return undefined

    const exact32 = candidates.find((item) => item.length === 32)
    if (exact32) return exact32.toLowerCase()
    const fallback = candidates.find((item) => item.length >= 16 && item.length <= 64)
    return fallback?.toLowerCase()
  }

  private extractVideoFileNameFromRow(row: Record<string, any>, content?: string): string | undefined {
    const packedRaw = getRowField(row, [
      'packed_info_data', 'packedInfoData',
      'packed_info_blob', 'packedInfoBlob',
      'packed_info', 'packedInfo',
      'BytesExtra', 'bytes_extra',
      'WCDB_CT_packed_info',
      'reserved0', 'Reserved0', 'WCDB_CT_Reserved0'
    ])
    const byPacked = this.extractVideoFileNameFromPackedRaw(packedRaw)
    if (byPacked) return byPacked

    const byColumn = this.normalizeVideoFileToken(getRowField(row, [
      'video_md5', 'videoMd5', 'raw_md5', 'rawMd5', 'video_file_name', 'videoFileName'
    ]))
    if (byColumn) return byColumn

    return this.normalizeVideoFileToken(this.extractVideoMd5(content || ''))
  }

  private isFileAttachmentAccountDir(dirPath: string): boolean {
    if (!dirPath) return false
    return fs.existsSync(path.join(dirPath, 'db_storage')) ||
      fs.existsSync(path.join(dirPath, 'msg', 'file')) ||
      fs.existsSync(path.join(dirPath, 'FileStorage', 'File')) ||
      fs.existsSync(path.join(dirPath, 'FileStorage', 'Image')) ||
      fs.existsSync(path.join(dirPath, 'FileStorage', 'Image2'))
  }

  private resolveAccountDirForFileExport(basePath: string, wxid: string): string | null {
    const cleanedWxid = cleanAccountDirName(wxid)
    if (!basePath || !cleanedWxid) return null

    const normalized = path.resolve(basePath.replace(/[\\/]+$/, ''))
    const parentDir = path.dirname(normalized)
    const dbStorageParent = path.basename(normalized).toLowerCase() === 'db_storage'
      ? path.dirname(normalized)
      : ''
    const fileInsideDbStorageParent = path.basename(parentDir).toLowerCase() === 'db_storage'
      ? path.dirname(parentDir)
      : ''
    const candidateBases = Array.from(new Set([
      normalized,
      parentDir,
      path.join(normalized, 'WeChat Files'),
      path.join(parentDir, 'WeChat Files'),
      dbStorageParent,
      fileInsideDbStorageParent
    ].filter(Boolean)))

    const lowerWxid = cleanedWxid.toLowerCase()
    const tryResolveBase = (candidateBase: string): string | null => {
      if (!candidateBase || !fs.existsSync(candidateBase)) return null
      if (this.isFileAttachmentAccountDir(candidateBase)) return candidateBase

      const direct = path.join(candidateBase, cleanedWxid)
      if (this.isFileAttachmentAccountDir(direct)) return direct

      try {
        const entries = fs.readdirSync(candidateBase, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const lowerEntry = entry.name.toLowerCase()
          if (lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`)) {
            const entryPath = path.join(candidateBase, entry.name)
            if (this.isFileAttachmentAccountDir(entryPath)) {
              return entryPath
            }
          }
        }
      } catch {
        return null
      }

      return null
    }

    for (const candidateBase of candidateBases) {
      const resolved = tryResolveBase(candidateBase)
      if (resolved) return resolved
    }

    return null
  }

  private resolveFileAttachmentSearchRoots(): FileAttachmentSearchRoot[] {
    const dbPath = this.getConfiguredDbPath()
    const rawWxid = this.getConfiguredMyWxid()
    const cleanedWxid = cleanAccountDirName(rawWxid)
    if (!dbPath) return []

    const normalized = path.resolve(dbPath.replace(/[\\/]+$/, ''))
    const accountDirs = new Set<string>()
    const maybeAddAccountDir = (candidate: string | null | undefined) => {
      if (!candidate) return
      const resolved = path.resolve(candidate)
      if (this.isFileAttachmentAccountDir(resolved)) {
        accountDirs.add(resolved)
      }
    }

    maybeAddAccountDir(normalized)
    maybeAddAccountDir(path.dirname(normalized))

    const wxidCandidates = Array.from(new Set([cleanedWxid, rawWxid].filter(Boolean)))
    for (const wxid of wxidCandidates) {
      maybeAddAccountDir(this.resolveAccountDirForFileExport(normalized, wxid))
    }

    return Array.from(accountDirs).map((accountDir) => {
      const msgFileRoot = path.join(accountDir, 'msg', 'file')
      const fileStorageRoot = path.join(accountDir, 'FileStorage', 'File')
      return {
        accountDir,
        msgFileRoot: fs.existsSync(msgFileRoot) ? msgFileRoot : undefined,
        fileStorageRoot: fs.existsSync(fileStorageRoot) ? fileStorageRoot : undefined
      }
    }).filter((root) => Boolean(root.msgFileRoot || root.fileStorageRoot))
  }

  private buildPreferredFileYearMonths(createTime?: unknown): string[] {
    const raw = Number(createTime)
    if (!Number.isFinite(raw) || raw <= 0) return []
    const ts = raw > 1e12 ? raw : raw * 1000
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return []
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    return [`${y}-${m}`]
  }

  private async verifyFileHash(sourcePath: string, expectedMd5?: string): Promise<boolean> {
    const normalizedExpected = String(expectedMd5 || '').trim().toLowerCase()
    if (!normalizedExpected) return true
    if (!/^[a-f0-9]{32}$/i.test(normalizedExpected)) return true
    try {
      const hash = crypto.createHash('md5')
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(sourcePath)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', () => resolve())
        stream.on('error', reject)
      })
      return hash.digest('hex').toLowerCase() === normalizedExpected
    } catch {
      return false
    }
  }

  private collectFileStorageCandidatesByName(rootDir: string, fileName: string, maxDepth = 3): string[] {
    const normalizedName = String(fileName || '').trim().toLowerCase()
    if (!rootDir || !normalizedName) return []

    const matches: string[] = []
    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]

    while (stack.length > 0) {
      const current = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryPath = path.join(current.dir, entry.name)
        if (entry.isFile() && entry.name.toLowerCase() === normalizedName) {
          matches.push(entryPath)
          continue
        }
        if (entry.isDirectory() && current.depth < maxDepth) {
          stack.push({ dir: entryPath, depth: current.depth + 1 })
        }
      }
    }

    return matches
  }

  private getFileAttachmentLogContext(msg: any): Record<string, unknown> {
    return {
      localId: msg?.localId,
      createTime: msg?.createTime,
      localType: msg?.localType,
      xmlType: msg?.xmlType,
      fileName: msg?.fileName,
      fileMd5: msg?.fileMd5
    }
  }

  private logFileAttachmentEvent(
    level: 'warn' | 'error',
    action: string,
    msg: any,
    extra: Record<string, unknown> = {}
  ): void {
    const logger = level === 'error' ? console.error : console.warn
    logger(`[Export][File] ${action}`, {
      ...this.getFileAttachmentLogContext(msg),
      ...extra
    })
  }

  private recordFileAttachmentMiss(msg: any, action: string, extra: Record<string, unknown> = {}): void {
    this.logFileAttachmentEvent('warn', action, msg, extra)
    this.noteMediaTelemetry({ cacheMissFiles: 1 })
  }

  private async resolveFileAttachmentCandidates(msg: any): Promise<FileExportCandidate[]> {
    const fileName = String(msg?.fileName || '').trim()
    if (!fileName) return []

    const roots = this.resolveFileAttachmentSearchRoots()
    if (roots.length === 0) return []

    const normalizedMd5 = String(msg?.fileMd5 || '').trim().toLowerCase()
    const preferredMonths = new Set(this.buildPreferredFileYearMonths(msg?.createTime))
    const candidates: FileExportCandidate[] = []
    const seen = new Set<string>()
    let searchOrder = 0

    const appendCandidate = async (sourcePath: string, yearMonth?: string) => {
      if (!sourcePath || !fs.existsSync(sourcePath)) return

      const resolvedPath = path.resolve(sourcePath)
      if (seen.has(resolvedPath)) return

      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(resolvedPath)
      } catch {
        return
      }
      if (!stat.isFile()) return

      seen.add(resolvedPath)
      const matchedBy = normalizedMd5 && await this.verifyFileHash(resolvedPath, normalizedMd5) ? 'md5' : 'name'
      candidates.push({
        sourcePath: resolvedPath,
        matchedBy,
        yearMonth,
        preferredMonth: Boolean(yearMonth && preferredMonths.has(yearMonth)),
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
        searchOrder: searchOrder++
      })
    }

    for (const root of roots) {
      if (root.msgFileRoot) {
        for (const month of preferredMonths) {
          await appendCandidate(path.join(root.msgFileRoot, month, fileName), month)
        }

        let monthDirs: string[] = []
        try {
          monthDirs = fs.readdirSync(root.msgFileRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name) && !preferredMonths.has(entry.name))
            .map(entry => entry.name)
            .sort()
        } catch {
          monthDirs = []
        }

        for (const month of monthDirs) {
          await appendCandidate(path.join(root.msgFileRoot, month, fileName), month)
        }
        await appendCandidate(path.join(root.msgFileRoot, fileName))
      }

      if (root.fileStorageRoot) {
        for (const candidatePath of this.collectFileStorageCandidatesByName(root.fileStorageRoot, fileName, 3)) {
          await appendCandidate(candidatePath)
        }
      }
    }

    candidates.sort((left, right) => {
      if (left.matchedBy !== right.matchedBy) {
        return left.matchedBy === 'md5' ? -1 : 1
      }
      if (left.preferredMonth !== right.preferredMonth) {
        return left.preferredMonth ? -1 : 1
      }
      if (left.mtimeMs !== right.mtimeMs) {
        return right.mtimeMs - left.mtimeMs
      }
      return left.searchOrder - right.searchOrder
    })

    return candidates
  }

  private async exportFileAttachment(
    msg: any,
    mediaRootDir: string,
    mediaRelativePrefix: string,
    maxFileSizeMb?: number,
    dirCache?: Set<string>,
    control?: ExportTaskControl
  ): Promise<MediaExportItem | null> {
    try {
      const fileNameRaw = String(msg?.fileName || '').trim()
      if (!fileNameRaw) return null

      const fileExtDir = resolveFileAttachmentExtensionDir(msg, fileNameRaw)
      const fileDir = path.join(mediaRootDir, mediaRelativePrefix, 'file', fileExtDir)
      await this.ensureExportDir(fileDir, control, dirCache)

      const candidates = await this.resolveFileAttachmentCandidates(msg)
      if (candidates.length === 0) {
        this.recordFileAttachmentMiss(msg, '附件候选未命中', {
          searchRoots: this.resolveFileAttachmentSearchRoots().map(root => root.accountDir)
        })
        return null
      }

      const maxBytes = Number.isFinite(maxFileSizeMb)
        ? Math.max(0, Math.floor(Number(maxFileSizeMb) * 1024 * 1024))
        : 0

      const selected = candidates[0]
      const stat = await fs.promises.stat(selected.sourcePath)
      if (!stat.isFile()) {
        this.recordFileAttachmentMiss(msg, '附件候选不是普通文件', {
          sourcePath: selected.sourcePath
        })
        return null
      }
      if (maxBytes > 0 && stat.size > maxBytes) {
        this.recordFileAttachmentMiss(msg, '附件超过大小限制', {
          sourcePath: selected.sourcePath,
          size: stat.size,
          maxBytes
        })
        return null
      }

      const normalizedMd5 = String(msg?.fileMd5 || '').trim().toLowerCase()
      if (normalizedMd5 && selected.matchedBy !== 'md5') {
        this.recordFileAttachmentMiss(msg, '附件哈希校验失败', {
          sourcePath: selected.sourcePath,
          expectedMd5: normalizedMd5
        })
        return null
      }

      const safeBaseName = path.basename(fileNameRaw).replace(/[\\/:*?"<>|]/g, '_') || 'file'
      const messageId = String(msg?.localId || Date.now())
      const destFileName = `${messageId}_${safeBaseName}`
      const destPath = path.join(fileDir, destFileName)
      const existedBeforeCopy = await pathExists(destPath)
      const copied = await copyFileOptimized(selected.sourcePath, destPath)
      if (!copied.success) {
        this.recordFileAttachmentMiss(msg, '附件复制失败', {
          sourcePath: selected.sourcePath,
          destPath,
          code: copied.code
        })
        return null
      }

      if (!existedBeforeCopy) {
        control?.recordCreatedFile?.(destPath)
      }
      this.noteMediaTelemetry({ doneFiles: 1, bytesWritten: stat.size })
      return {
        relativePath: path.posix.join(mediaRelativePrefix, 'file', fileExtDir, destFileName),
        kind: 'file'
      }
    } catch (error) {
      this.logFileAttachmentEvent('error', '附件导出异常', msg, {
        error: error instanceof Error ? error.message : String(error || 'unknown')
      })
      this.noteMediaTelemetry({ cacheMissFiles: 1 })
      return null
    }
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
      Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis || options.exportFiles)
    const outputDir = path.dirname(outputPath)
    const writeLayout = this.resolveExportWriteLayout(options)
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

  private collectMediaMessagesForExport(messages: any[], options: ExportOptions): any[] {
    if (!this.isMediaExportEnabled(options)) return []

    return messages.filter((msg) => {
      const localType = Number(msg?.localType || 0)
      return (localType === 3 && options.exportImages) ||
        (localType === 47 && options.exportEmojis) ||
        (localType === 43 && options.exportVideos) ||
        (localType === 34 && options.exportVoices) ||
        (options.exportFiles === true && this.isFileAppMessage(msg))
    })
  }

  private getMediaDoneFilesCount(): number {
    return this.mediaRuntime.getMediaDoneFilesCount()
  }

  private formatMediaPhaseLabel(processed: number, total: number, beforeDoneFiles: number): string {
    const safeProcessed = Math.max(0, Math.floor(processed || 0))
    const safeTotal = Math.max(0, Math.floor(total || 0))
    const writtenNow = Math.max(0, this.getMediaDoneFilesCount() - Math.max(0, Math.floor(beforeDoneFiles || 0)))
    return `导出媒体 ${Math.min(safeProcessed, safeTotal)}/${safeTotal}（已写入 ${writtenNow}）`
  }

  private buildFileOnlyExportFailure(
    options: ExportOptions,
    mediaMessages: any[],
    beforeDoneFiles: number
  ): { success: boolean; error?: string } | null {
    if (options.contentType !== 'file') return null
    if (!mediaMessages.some(msg => this.isFileAppMessage(msg))) return null
    if (this.getMediaDoneFilesCount() > beforeDoneFiles) return null

    return {
      success: false,
      error: '检测到文件消息，但未找到可导出的源文件，请检查数据库路径或文件存储目录配置'
    }
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
    onCollectProgress?: (payload: { fetched: number }) => void,
    allowLiteFallback = true,
    allowRangeFallback = true,
    useCursorTimeRange = true,
    allowModeFallback = true
  ): Promise<{ rows: any[]; memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>; firstTime: number | null; lastTime: number | null; error?: string }> {
    const rows: any[] = []
    const memberSet = new Map<string, { member: ChatLabMember; avatarUrl?: string }>()
    const senderSet = new Set<string>()
    let firstTime: number | null = null
    let lastTime: number | null = null
    const mediaTypeFilter = targetMediaTypes && targetMediaTypes.size > 0
      ? targetMediaTypes
      : null
    const fileOnlyMediaFilter = this.isFileOnlyMediaFilter(mediaTypeFilter)

    const normalizedDateRange = normalizeExportDateRange(dateRange)
    const normalizedSenderUsernameFilter = String(senderUsernameFilter || '').trim()
    const beginTime = useCursorTimeRange ? (normalizedDateRange?.start || 0) : 0
    const endTime = useCursorTimeRange ? (normalizedDateRange?.end || 0) : 0
    
    const batchSize = (collectMode === 'text-fast' || collectMode === 'media-fast') ? 2000 : 500
    this.throwIfStopRequested(control)
    const fastMediaType = this.resolveFastMediaStreamType(collectMode, mediaTypeFilter)
    let usedFastMediaStream = false
    let usedLiteCursor = false
    if (fastMediaType) {
      const streamCollected = await this.collectMessagesByFastMediaStream(
        sessionId,
        cleanedMyWxid,
        normalizedDateRange,
        useCursorTimeRange,
        normalizedSenderUsernameFilter,
        fastMediaType,
        onCollectProgress,
        control
      )
      if (streamCollected.success) {
        usedFastMediaStream = true
        rows.push(...streamCollected.rows)
        for (const username of streamCollected.senderUsernames) {
          senderSet.add(username)
        }
        firstTime = streamCollected.firstTime
        lastTime = streamCollected.lastTime
      } else {
        console.warn(`[Export] 媒体快速流读取失败，回退游标链路: session=${sessionId}, type=${fastMediaType}, error=${streamCollected.error || 'unknown'}`)
      }
    }

    if (!usedFastMediaStream) {
      // 媒体导出链路必须优先保证字段完整性，否则会出现“进度前进但无文件写出”。
      // 轻量游标仅用于文本快路径；媒体快路径保留标准游标。
      usedLiteCursor = allowLiteFallback && collectMode === 'text-fast'
      let cursor = usedLiteCursor
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
          false,
          beginTime,
          endTime
        )
      if (!cursor.success || !cursor.cursor) {
        if (usedLiteCursor && allowLiteFallback) {
          console.warn(`[Export] 轻量游标打开失败，回退标准游标重试: ${cursor.error || '未知错误'}`)
          return this.collectMessages(
            sessionId,
            cleanedMyWxid,
            normalizedDateRange,
            senderUsernameFilter,
            collectMode,
            targetMediaTypes,
            control,
            onCollectProgress,
            false,
            allowRangeFallback,
            useCursorTimeRange,
            allowModeFallback
          )
        }
        console.error(`[Export] 打开游标失败: ${cursor.error || '未知错误'}`)
        return {
          rows,
          memberSet,
          firstTime,
          lastTime,
          error: cursor.error || '打开消息游标失败'
        }
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
          const createTime = getTimestampSecondsFromRow(row)
          if (normalizedDateRange) {
            if (createTime > 0 && normalizedDateRange.start > 0 && createTime < normalizedDateRange.start) continue
            if (createTime > 0 && normalizedDateRange.end > 0 && createTime > normalizedDateRange.end) continue
          }

          const localType = getIntFromRow(row, [
            'local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'
          ], 1)
          const rowFileHints = collectMode === 'text-fast'
            ? {}
            : getFileAppMessageHints(row)
          const allowFileProbe = collectMode !== 'text-fast' && fileOnlyMediaFilter && hasFileAppMessageHints(row)
          if (mediaTypeFilter && !mediaTypeFilter.has(localType) && !allowFileProbe) {
            continue
          }
          const shouldDecodeContent = collectMode === 'full'
            || (collectMode === 'text-fast' && this.shouldDecodeMessageContentInFastMode(localType))
            || (collectMode === 'media-fast' && this.shouldDecodeMessageContentInMediaMode(localType, mediaTypeFilter, { allowFileProbe }))
          const content = shouldDecodeContent
            ? this.decodeMessageContent(row.message_content, row.compress_content)
            : ''
          const senderUsername = row.sender_username || ''
          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10) === 1
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

          if (normalizedSenderUsernameFilter && !this.isSameWxid(actualSender, normalizedSenderUsernameFilter)) {
            continue
          }
          senderSet.add(actualSender)

          if (collectMode === 'text-fast') {
            rows.push({
              localId,
              serverId,
              serverIdRaw: serverIdRaw !== '0' ? serverIdRaw : undefined,
              createTime,
              localType,
              content,
              senderUsername: actualSender,
              isSend
            })
            if (firstTime === null || createTime < firstTime) firstTime = createTime
            if (lastTime === null || createTime > lastTime) lastTime = createTime
            continue
          }

          // 提取媒体相关字段（轻量模式下跳过）
          let imageMd5: string | undefined
          let imageOriginSourceMd5: string | undefined
          let imageDatName: string | undefined
          let emojiCdnUrl: string | undefined
          let emojiMd5: string | undefined
          let videoMd5: string | undefined
          let locationLat: number | undefined
          let locationLng: number | undefined
          let locationPoiname: string | undefined
          let locationLabel: string | undefined
          let chatRecordList: any[] | undefined
          let emojiCaption: string | undefined
          let xmlType: string | undefined
          let fileName: string | undefined
          let fileSize: number | undefined
          let fileExt: string | undefined
          let fileMd5: string | undefined

          if (localType === 48 && content) {
            const locationMeta = this.extractLocationMeta(content, localType)
            if (locationMeta) {
              locationLat = locationMeta.locationLat
              locationLng = locationMeta.locationLng
              locationPoiname = locationMeta.locationPoiname
              locationLabel = locationMeta.locationLabel
            }
          }

          if (localType === 47) {
            emojiCdnUrl = String(row.emoji_cdn_url || row.emojiCdnUrl || '').trim() || undefined
            emojiMd5 = normalizeEmojiMd5(row.emoji_md5 || row.emojiMd5) || undefined
            const packedInfoRaw = String(row.packed_info || row.packedInfo || row.PackedInfo || '')
            const reserved0Raw = String(row.reserved0 || row.Reserved0 || '')
            const supplementalPayload = `${decodeMaybeCompressed(packedInfoRaw)}\n${decodeMaybeCompressed(reserved0Raw)}`
            if (content) {
              emojiCdnUrl = emojiCdnUrl || this.extractEmojiUrl(content)
              emojiMd5 = emojiMd5 || normalizeEmojiMd5(this.extractEmojiMd5(content))
            }
            emojiCdnUrl = emojiCdnUrl || this.extractEmojiUrl(supplementalPayload)
            emojiMd5 = emojiMd5 || this.extractEmojiMd5(supplementalPayload) || extractLooseHexMd5(supplementalPayload)
          }

          if (collectMode === 'full' || collectMode === 'media-fast') {
            // 优先复用游标返回的字段，缺失时再回退到 XML 解析。
            imageMd5 = String(row.image_md5 || row.imageMd5 || '').trim() || undefined
            imageDatName = localType === 3 ? this.extractImageDatNameFromRow(row, content) : undefined
            videoMd5 = this.extractVideoFileNameFromRow(row, content)
            xmlType = rowFileHints.xmlType
            fileName = rowFileHints.fileName
            fileExt = rowFileHints.fileExt
            fileSize = rowFileHints.fileSize
            fileMd5 = rowFileHints.fileMd5

            if (content && (isFileAppLocalType(localType) || allowFileProbe || hasFileAppMessageHints({ xmlType, fileName, fileSize, fileExt, fileMd5 }))) {
              const fileMeta = extractFileAppMessageMeta(content)
              if (fileMeta) {
                xmlType = fileMeta.xmlType || xmlType
                fileName = fileMeta.fileName || fileName
                fileSize = fileMeta.fileSize || fileSize
                fileExt = fileMeta.fileExt || fileExt
                fileMd5 = fileMeta.fileMd5 || fileMd5
              }
            }

            if (localType === 3 && content) {
              // 图片消息
              imageMd5 = imageMd5 || this.extractImageMd5(content)
              imageOriginSourceMd5 = this.extractImageOriginSourceMd5(content)
              imageDatName = imageDatName || this.extractImageDatNameFromRow(row, content)
            } else if (localType === 43 && content) {
              // 视频消息
              videoMd5 = videoMd5 || this.extractVideoFileNameFromRow(row, content)
            } else if (collectMode === 'full' && content && (localType === 49 || content.includes('<appmsg') || content.includes('&lt;appmsg'))) {
              // 检查是否是聊天记录消息（type=19），兼容大 localType 的 appmsg
              const normalizedContent = this.normalizeAppMessageContent(content)
              const xmlType = this.extractAppMessageType(normalizedContent)
              if (xmlType === '19') {
                chatRecordList = this.parseChatHistory(normalizedContent)
              }
            }
          }

          if (fileOnlyMediaFilter && !this.isFileAppMessage({ localType, xmlType, content, fileName, fileExt, fileMd5, fileSize })) {
            continue
          }

          rows.push({
            localId,
            serverId,
            serverIdRaw: serverIdRaw !== '0' ? serverIdRaw : undefined,
            createTime,
            localType,
            content,
            senderUsername: actualSender,
            isSend,
            imageMd5,
            imageOriginSourceMd5,
            imageDatName,
            emojiCdnUrl,
            emojiMd5,
            emojiCaption,
            videoMd5,
            xmlType,
            fileName,
            fileSize,
            fileExt,
            fileMd5,
            locationLat,
            locationLng,
            locationPoiname,
            locationLabel,
            chatRecordList
          })

          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
          }
          onCollectProgress?.({ fetched: rows.length })
          hasMore = batch.hasMore === true
        }
        
      } catch (err) {
        if (isStopError(err)) throw err
        console.error(`[Export] 收集消息异常:`, err)
      } finally {
        try {
          await wcdbService.closeMessageCursor(cursor.cursor)
        } catch (err) {
          console.error(`[Export] 关闭游标失败:`, err)
        }
      }
    }

    if (rows.length === 0 && usedLiteCursor && allowLiteFallback) {
      console.warn(`[Export] 轻量游标返回 0 条，回退标准游标重试: session=${sessionId}, range=${beginTime}-${endTime}`)
      return this.collectMessages(
        sessionId,
        cleanedMyWxid,
        normalizedDateRange,
        senderUsernameFilter,
        collectMode,
        targetMediaTypes,
        control,
        onCollectProgress,
        false,
        allowRangeFallback,
        useCursorTimeRange,
        allowModeFallback
      )
    }

    if (rows.length === 0 && collectMode === 'media-fast' && allowModeFallback) {
      console.warn(`[Export] media-fast 返回 0 条，回退 full 模式重试: session=${sessionId}`)
      return this.collectMessages(
        sessionId,
        cleanedMyWxid,
        normalizedDateRange,
        senderUsernameFilter,
        'full',
        mediaTypeFilter || undefined,
        control,
        onCollectProgress,
        false,
        allowRangeFallback,
        useCursorTimeRange,
        false
      )
    }

    if (rows.length === 0 && allowRangeFallback && normalizedDateRange && useCursorTimeRange) {
      console.warn(`[Export] 时间范围游标返回 0 条，回退为全量游标+本地过滤重试: session=${sessionId}, range=${normalizedDateRange.start}-${normalizedDateRange.end}`)
      return this.collectMessages(
        sessionId,
        cleanedMyWxid,
        normalizedDateRange,
        senderUsernameFilter,
        collectMode,
        targetMediaTypes,
        control,
        onCollectProgress,
        allowLiteFallback,
        false,
        false,
        allowModeFallback
      )
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

    if (rows.length > 1) {
      rows.sort((a, b) => {
        const timeDelta = (a.createTime || 0) - (b.createTime || 0)
        if (timeDelta !== 0) return timeDelta
        return (a.localId || 0) - (b.localId || 0)
      })
    }

    return { rows, memberSet, firstTime, lastTime }
  }

  private async getRecentWcdbCursorLogSummary(sessionId: string): Promise<string | undefined> {
    try {
      const logResult = await wcdbService.getLogs()
      if (!logResult.success || !Array.isArray(logResult.logs)) return undefined
      const sid = String(sessionId || '').trim()
      const interesting = logResult.logs
        .filter((line) => {
          const text = String(line || '')
          if (sid && text.includes(sid)) return true
          return text.includes('QueryMessageBatch') ||
            text.includes('InitExportCursorHeap') ||
            text.includes('cursor_init') ||
            text.includes('fetch_message_batch') ||
            text.includes('open_message_cursor')
        })
        .slice(-8)
      if (interesting.length === 0) return undefined
      return interesting.join(' | ')
    } catch {
      return undefined
    }
  }

  private async buildNoMessagesError(
    sessionId: string,
    collected: { error?: string },
    fallback = '该会话在指定时间范围内没有消息'
  ): Promise<string> {
    if (collected.error) return collected.error
    const nativeLogSummary = await this.getRecentWcdbCursorLogSummary(sessionId)
    if (!nativeLogSummary) return fallback
    return `${fallback}；WCDB日志：${nativeLogSummary}`
  }

  private async backfillMediaFieldsFromMessageDetail(
    sessionId: string,
    rows: any[],
    targetMediaTypes: Set<number>,
    control?: ExportTaskControl,
    options?: { force?: boolean }
  ): Promise<void> {
    const force = options?.force === true
    const fileOnlyMediaFilter = this.isFileOnlyMediaFilter(targetMediaTypes)
    const needsBackfill = rows.filter((msg) => {
      if (force) {
        return Number(msg?.localId || 0) > 0
      }
      const isFileCandidate = isFileAppLocalType(Number(msg.localType || 0)) || (fileOnlyMediaFilter && hasFileAppMessageHints(msg))
      if (isFileCandidate) {
        return !msg.xmlType || !msg.fileName || !msg.fileMd5 || !msg.fileSize || !msg.fileExt
      }
      if (!targetMediaTypes.has(msg.localType)) return false
      if (msg.localType === 3) return !msg.imageMd5 || !msg.imageDatName
      if (msg.localType === 47) return !msg.emojiMd5
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
        const rawMessageContent = getRowField(row, [
          'message_content', 'messageContent', 'msg_content', 'msgContent', 'strContent', 'content', 'WCDB_CT_message_content'
        ]) ?? ''
        const rawCompressContent = getRowField(row, [
          'compress_content', 'compressContent', 'msg_compress_content', 'msgCompressContent', 'WCDB_CT_compress_content'
        ]) ?? ''
        const content = this.decodeMessageContent(rawMessageContent, rawCompressContent)
        const packedInfoRaw = getRowField(row, ['packed_info', 'packedInfo', 'PackedInfo', 'WCDB_CT_packed_info']) ?? ''
        const reserved0Raw = getRowField(row, ['reserved0', 'Reserved0', 'WCDB_CT_Reserved0']) ?? ''
        const supplementalPayload = `${decodeMaybeCompressed(String(packedInfoRaw || ''))}\n${decodeMaybeCompressed(String(reserved0Raw || ''))}`

        if (msg.localType === 3) {
          const imageMd5 = (String(row.image_md5 || row.imageMd5 || '').trim() || this.extractImageMd5(content) || '').toLowerCase()
          const imageOriginSourceMd5 = this.extractImageOriginSourceMd5(content)
          const imageDatName = this.extractImageDatNameFromRow(row, content) || ''
          if (imageMd5) msg.imageMd5 = imageMd5
          if (imageOriginSourceMd5) msg.imageOriginSourceMd5 = imageOriginSourceMd5
          if (imageDatName) msg.imageDatName = imageDatName
          return
        }

        if (msg.localType === 47) {
          const emojiMd5 =
            normalizeEmojiMd5(row.emoji_md5 || row.emojiMd5) ||
            this.extractEmojiMd5(content) ||
            this.extractEmojiMd5(supplementalPayload) ||
            extractLooseHexMd5(supplementalPayload)
          const emojiCdnUrl =
            String(row.emoji_cdn_url || row.emojiCdnUrl || '').trim() ||
            this.extractEmojiUrl(content) ||
            this.extractEmojiUrl(supplementalPayload)
          if (emojiMd5) msg.emojiMd5 = emojiMd5
          if (emojiCdnUrl) msg.emojiCdnUrl = emojiCdnUrl
          return
        }

        if (msg.localType === 43) {
          const videoMd5 = String(this.extractVideoFileNameFromRow(row, content) || '').trim().toLowerCase()
          if (videoMd5) msg.videoMd5 = videoMd5
          return
        }

        if (isFileAppLocalType(Number(msg.localType || 0)) || hasFileAppMessageHints(msg)) {
          const rowFileHints = getFileAppMessageHints(row)
          const fileMeta = extractFileAppMessageMeta(content)
          const mergedFileMeta = {
            xmlType: fileMeta?.xmlType || rowFileHints.xmlType,
            fileName: fileMeta?.fileName || rowFileHints.fileName,
            fileSize: fileMeta?.fileSize || rowFileHints.fileSize,
            fileExt: fileMeta?.fileExt || rowFileHints.fileExt,
            fileMd5: fileMeta?.fileMd5 || rowFileHints.fileMd5
          }
          if (mergedFileMeta.xmlType) msg.xmlType = mergedFileMeta.xmlType
          if (mergedFileMeta.fileName) msg.fileName = mergedFileMeta.fileName
          if (mergedFileMeta.fileSize) msg.fileSize = mergedFileMeta.fileSize
          if (mergedFileMeta.fileExt) msg.fileExt = mergedFileMeta.fileExt
          if (mergedFileMeta.fileMd5) msg.fileMd5 = mergedFileMeta.fileMd5
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
      const cleaned = cleanAccountDirName(username)
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

      const cleaned = cleanAccountDirName(username)
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

    const query = await wcdbService.getContactFriendFlags(unique)
    if (query.success && query.map) {
      for (const [username, isFriend] of Object.entries(query.map)) {
        const normalized = String(username || '').trim()
        if (!normalized) continue
        result.set(normalized, Boolean(isFriend))
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
    outputDir: string,
    control?: ExportTaskControl
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (members.length === 0) return result

    // 创建 avatars 子目录
    const avatarsDir = path.join(outputDir, 'avatars')
    await this.ensureExportDir(avatarsDir, control)

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
          await this.recordCreatedFileBeforeWrite(avatarPath, control)
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

  private async exportSessionToExcelStreaming(params: {
    outputPath: string
    options: ExportOptions
    sessionId: string
    sessionInfo: { displayName: string }
    myInfo: { displayName: string }
    cleanedMyWxid: string
    rawMyWxid: string
    isGroup: boolean
    sortedMessages: any[]
    mediaCache: Map<string, MediaExportItem | null>
    voiceTranscriptMap: Map<string, string>
    getContactCached: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>
    groupNicknamesMap: Map<string, string>
    onProgress?: (progress: ExportProgress) => void
    control?: ExportTaskControl
    totalMessages: number
  }): Promise<{ success: boolean; error?: string }> {
    const {
      outputPath,
      options,
      sessionId,
      sessionInfo,
      myInfo,
      cleanedMyWxid,
      rawMyWxid,
      isGroup,
      sortedMessages,
      mediaCache,
      voiceTranscriptMap,
      getContactCached,
      groupNicknamesMap,
      onProgress,
      control,
      totalMessages
    } = params

    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: outputPath,
        useStyles: true,
        useSharedStrings: false
      })
      const worksheet = workbook.addWorksheet('聊天记录')
      const useCompactColumns = options.excelCompactColumns === true
      const includeGroupNicknameColumn = !useCompactColumns && isGroup
      const senderProfileCache = new Map<string, ExportDisplayProfile>()

      worksheet.columns = useCompactColumns
        ? [
          { width: 8 },
          { width: 20 },
          { width: 18 },
          { width: 12 },
          { width: 50 }
        ]
        : includeGroupNicknameColumn
          ? [
            { width: 8 },
            { width: 20 },
            { width: 18 },
            { width: 25 },
            { width: 18 },
            { width: 18 },
            { width: 15 },
            { width: 12 },
            { width: 50 }
          ]
          : [
            { width: 8 },
            { width: 20 },
            { width: 18 },
            { width: 25 },
            { width: 18 },
            { width: 15 },
            { width: 12 },
            { width: 50 }
          ]

      const appendRow = (values: any[]) => {
        const row = worksheet.addRow(values)
        row.commit()
      }

      appendRow(['会话信息'])
      appendRow(['微信ID', sessionId, '昵称', sessionInfo.displayName || sessionId])
      appendRow(['导出工具', 'WeFlow', '导出时间', this.formatTimestamp(Math.floor(Date.now() / 1000))])
      appendRow([])
      appendRow(useCompactColumns
        ? ['序号', '时间', '发送者身份', '消息类型', '内容']
        : includeGroupNicknameColumn
          ? ['序号', '时间', '发送者昵称', '发送者微信ID', '发送者备注', '群昵称', '发送者身份', '消息类型', '内容']
          : ['序号', '时间', '发送者昵称', '发送者微信ID', '发送者备注', '发送者身份', '消息类型', '内容'])

      for (let i = 0; i < totalMessages; i++) {
        if ((i & 0x7f) === 0) this.throwIfStopRequested(control)
        const msg = sortedMessages[i]

        let senderRole: string
        let senderWxid: string
        let senderNickname: string
        let senderRemark = ''
        let senderGroupNickname = ''

        if (isGroup) {
          const senderProfileKey = `${msg.isSend ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid)}::${msg.isSend ? '1' : '0'}`
          let senderProfile = senderProfileCache.get(senderProfileKey)
          if (!senderProfile) {
            senderProfile = await this.resolveExportDisplayProfile(
              msg.isSend ? cleanedMyWxid : (msg.senderUsername || cleanedMyWxid),
              options.displayNamePreference,
              getContactCached,
              groupNicknamesMap,
              msg.isSend ? (myInfo.displayName || cleanedMyWxid) : (msg.senderUsername || ''),
              msg.isSend ? [rawMyWxid, cleanedMyWxid] : []
            )
            senderProfileCache.set(senderProfileKey, senderProfile)
          }
          senderWxid = senderProfile.wxid
          senderNickname = senderProfile.nickname
          senderRemark = senderProfile.remark
          senderGroupNickname = senderProfile.groupNickname
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

        const mediaKey = getMediaCacheKey(msg)
        const mediaItem = mediaCache.get(mediaKey)
        const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
        const contentValue = shouldUseTranscript
          ? this.formatPlainExportContent(
            msg.content,
            msg.localType,
            options,
            voiceTranscriptMap.get(getStableMessageKey(msg)),
            cleanedMyWxid,
            msg.senderUsername,
            msg.isSend,
            msg.emojiCaption
          )
          : ((msg.localType !== 47 ? mediaItem?.relativePath : undefined)
            || this.formatPlainExportContent(
              msg.content,
              msg.localType,
              options,
              voiceTranscriptMap.get(getStableMessageKey(msg)),
              cleanedMyWxid,
              msg.senderUsername,
              msg.isSend,
              msg.emojiCaption
            ))

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

        const quotedReplyDisplay = await this.resolveQuotedReplyDisplayWithNames({
          content: msg.content,
          isGroup,
          displayNamePreference: options.displayNamePreference,
          getContact: getContactCached,
          groupNicknamesMap,
          cleanedMyWxid,
          rawMyWxid,
          myDisplayName: myInfo.displayName || cleanedMyWxid
        })
        if (quotedReplyDisplay) {
          enrichedContentValue = this.buildQuotedReplyText(quotedReplyDisplay)
        }

        const row = worksheet.addRow(useCompactColumns
          ? [
            i + 1,
            this.formatTimestamp(msg.createTime),
            senderRole,
            this.getMessageTypeName(msg.localType, msg.content),
            enrichedContentValue
          ]
          : includeGroupNicknameColumn
            ? [
              i + 1,
              this.formatTimestamp(msg.createTime),
              senderNickname,
              senderWxid,
              senderRemark,
              senderGroupNickname,
              senderRole,
              this.getMessageTypeName(msg.localType, msg.content),
              enrichedContentValue
            ]
            : [
              i + 1,
              this.formatTimestamp(msg.createTime),
              senderNickname,
              senderWxid,
              senderRemark,
              senderRole,
              this.getMessageTypeName(msg.localType, msg.content),
              enrichedContentValue
            ])
        if (!quotedReplyDisplay) {
          this.applyExcelLinkCardCell(
            row.getCell(useCompactColumns ? 5 : (includeGroupNicknameColumn ? 9 : 8)),
            msg.content,
            msg.localType
          )
        }
        row.commit()

        if ((i + 1) % 200 === 0) {
          onProgress?.({
            current: 65 + Math.floor((i + 1) / totalMessages * 25),
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'writing',
            estimatedTotalMessages: totalMessages,
            collectedMessages: totalMessages,
            exportedMessages: i + 1
          })
        }
      }

      worksheet.commit()
      await workbook.commit()

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        estimatedTotalMessages: totalMessages,
        collectedMessages: totalMessages,
        exportedMessages: totalMessages,
        writtenFiles: 1
      })

      return { success: true }
    } catch (e) {
      if (isStopError(e)) {
        return { success: false, error: '导出任务已停止' }
      }
      if (isPauseError(e)) {
        return { success: false, error: '导出任务已暂停' }
      }
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

  private isFileAppMessage(msg: {
    localType?: unknown
    xmlType?: unknown
    xml_type?: unknown
    content?: unknown
    fileName?: unknown
    file_name?: unknown
    fileSize?: unknown
    file_size?: unknown
    fileExt?: unknown
    file_ext?: unknown
    fileMd5?: unknown
    file_md5?: unknown
  }): boolean {
    const { xmlType, fileName, fileExt, fileMd5, fileSize } = getFileAppMessageHints(msg as Record<string, any>)
    if (xmlType) return xmlType === '6'
    if (fileName || fileExt || fileMd5 || fileSize) return true

    const normalized = this.normalizeAppMessageContent(String(msg?.content || ''))
    if (!normalized || (!normalized.includes('<appmsg') && !normalized.includes('<msg>'))) {
      return false
    }
    return this.extractAppMessageType(normalized) === '6'
  }


  private extractFileAppMessageMeta(content: string): {
    xmlType?: string
    fileName?: string
    fileSize?: number
    fileExt?: string
    fileMd5?: string
  } | null {
    const normalized = this.normalizeAppMessageContent(content || '')
    if (!normalized || (!normalized.includes('<appmsg') && !normalized.includes('<msg>'))) {
      return null
    }

    const xmlType = this.extractAppMessageType(normalized)
    if (!xmlType) return null

    const rawFileName = this.extractXmlValue(normalized, 'filename') || this.extractXmlValue(normalized, 'title')
    const rawFileExt = this.extractXmlValue(normalized, 'fileext')
    const rawFileSize =
      this.extractXmlValue(normalized, 'totallen') ||
      this.extractXmlValue(normalized, 'datasize') ||
      this.extractXmlValue(normalized, 'filesize')
    const rawFileMd5 =
      this.extractXmlValue(normalized, 'md5') ||
      this.extractXmlAttribute(normalized, 'appattach', 'md5') ||
      extractLooseHexMd5(normalized)
    const fileSize = Number.parseInt(rawFileSize, 10)
    const fileMd5 = String(rawFileMd5 || '').trim()

    return {
      xmlType,
      fileName: this.decodeHtmlEntities(rawFileName).trim() || undefined,
      fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : undefined,
      fileExt: this.decodeHtmlEntities(rawFileExt).trim() || undefined,
      fileMd5: /^[a-f0-9]{32}$/i.test(fileMd5) ? fileMd5.toLowerCase() : undefined
    }
  }


  private convertMessageType(localType: number, content: string): number {
    const normalized = this.normalizeAppMessageContent(content || '')
    if (this.isReadableSystemMessage(localType, normalized)) {
      return 80
    }

    const xmlTypeRaw = this.extractAppMessageType(normalized)
    const xmlType = xmlTypeRaw ? Number.parseInt(xmlTypeRaw, 10) : null
    const looksLikeAppMessage = localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>')

    // 特殊处理 type 49 或 XML type
    if (looksLikeAppMessage || xmlType) {
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
          if (xmlType || looksLikeAppMessage) return 7 // 有 appmsg 但未知，默认为链接
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99 // 未知类型 -> OTHER
  }


  private isReadableSystemMessage(localType: number, content: string): boolean {
    if (localType === 10000) return true
    const normalized = this.normalizeAppMessageContent(content || '')
    return /<sysmsg\b/i.test(this.stripSenderPrefix(normalized))
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
      if (raw.length > 16 && looksLikeHex(raw)) {
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


  private resolveGroupNicknameByCandidates(groupNicknamesMap: Map<string, string>, candidates: Array<string | undefined | null>): string {
    const idCandidates = buildGroupNicknameIdCandidates(candidates)
    if (idCandidates.length === 0) return ''

    let resolved = ''
    for (const id of idCandidates) {
      const normalizedId = this.normalizeGroupNicknameIdentity(id)
      if (!normalizedId) continue
      const candidateNickname = normalizeGroupNickname(groupNicknamesMap.get(normalizedId) || '')
      if (!candidateNickname) continue
      if (!resolved) {
        resolved = candidateNickname
        continue
      }
      if (resolved !== candidateNickname) return ''
    }

    return resolved
  }

  /**
   * 根据用户偏好获取显示名称
   */

  formatHtmlMessageText(
    content: string,
    localType: number,
    myWxid?: string,
    senderWxid?: string,
    isSend?: boolean,
    emojiCaption?: string
  ): string {
    if (!content && localType === 47) {
      return this.formatEmojiSemanticText(emojiCaption)
    }
    if (!content) return ''

    const readableSystemText = this.extractReadableSystemMessageText(content)
    if (readableSystemText && this.isReadableSystemMessage(localType, content)) {
      return readableSystemText
    }

    if (localType === 1) {
      return this.stripSenderPrefix(content)
    }

    if (localType === 34) {
      return this.parseMessageContent(content, localType, undefined, undefined, myWxid, senderWxid, isSend, emojiCaption) || ''
    }

    return this.formatPlainExportContent(content, localType, { exportVoiceAsText: false }, undefined, myWxid, senderWxid, isSend, emojiCaption)
  }


  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析消息内容为可读文本
   * 注意：语音消息在这里返回占位符，实际转文字在导出时异步处理
   */

  private normalizeGroupNicknameIdentity(value: string): string {
    const raw = String(value || '').trim()
    if (!raw) return ''
    return raw.toLowerCase()
  }


  private buildExportStatsCacheKey(sessionIds: string[], options: Pick<ExportOptions, 'dateRange' | 'senderUsername'>, cleanedWxid?: string): string {
    return this.exportStatsCacheManager.buildExportStatsCacheKey(sessionIds, options, cleanedWxid)
  }

  private cloneExportStatsResult(result: ExportStatsResult): ExportStatsResult {
    return this.exportStatsCacheManager.cloneExportStatsResult(result)
  }

  private getExportStatsCacheEntry(key: string): ExportStatsCacheEntry | null {
    return this.exportStatsCacheManager.getExportStatsCacheEntry(key)
  }

  private setExportStatsCacheEntry(key: string, entry: ExportStatsCacheEntry): void {
    this.exportStatsCacheManager.setExportStatsCacheEntry(key, entry)
  }

  private getAggregatedSessionStatsCache(key: string): Record<string, ExportAggregatedSessionMetric> | null {
    return this.exportStatsCacheManager.getAggregatedSessionStatsCache(key)
  }

  private setAggregatedSessionStatsCache(key: string, data: Record<string, ExportAggregatedSessionMetric>): void {
    this.exportStatsCacheManager.setAggregatedSessionStatsCache(key, data)
  }

  private getMediaFileCacheRoot(): string { return this.mediaRuntime.getMediaFileCacheRoot() }
  private createEmptyMediaTelemetry(): MediaExportTelemetry { return this.mediaRuntime.createEmptyMediaTelemetry() }
  private resetMediaRuntimeState(): void { this.mediaRuntime.resetMediaRuntimeState() }
  private clearMediaRuntimeState(): void { this.mediaRuntime.clearMediaRuntimeState() }
  private async runWithChatImagePipelineLimit<T>(fn: () => Promise<T>): Promise<T> { return this.mediaRuntime.runWithChatImagePipelineLimit(fn) }
  private getMediaTelemetrySnapshot(): Partial<ExportProgress> { return this.mediaRuntime.getMediaTelemetrySnapshot() }
  private noteMediaTelemetry(delta: Partial<MediaExportTelemetry>): void { this.mediaRuntime.noteMediaTelemetry(delta) }
  private async ensureMediaFileCacheDir(dirPath: string): Promise<void> { return this.mediaRuntime.ensureMediaFileCacheDir(dirPath) }
  private async getMediaFileStat(sourcePath: string): Promise<{ size: number; mtimeMs: number } | null> { return this.mediaRuntime.getMediaFileStat(sourcePath) }
  private buildMediaFileCachePath(kind: 'image' | 'video' | 'emoji', sourcePath: string, fileStat: { size: number; mtimeMs: number }): string { return this.mediaRuntime.buildMediaFileCachePath(kind, sourcePath, fileStat) }
  private async resolveMediaFileCachePath(kind: 'image' | 'video' | 'emoji', sourcePath: string): Promise<{ cachePath: string; fileStat: { size: number; mtimeMs: number } } | null> { return this.mediaRuntime.resolveMediaFileCachePath(kind, sourcePath) }
  private async populateMediaFileCache(kind: 'image' | 'video' | 'emoji', sourcePath: string): Promise<string | null> { return this.mediaRuntime.populateMediaFileCache(kind, sourcePath) }
  private async resolvePreferredMediaSource(kind: 'image' | 'video' | 'emoji', sourcePath: string): Promise<MediaSourceResolution> { return this.mediaRuntime.resolvePreferredMediaSource(kind, sourcePath) }
  private async hardlinkOrCopyFile(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string; linked?: boolean }> { return this.mediaRuntime.hardlinkOrCopyFile(sourcePath, destPath) }
  private async copyMediaWithCacheAndDedup(kind: 'image' | 'video' | 'emoji', sourcePath: string, destPath: string, control?: ExportTaskControl): Promise<{ success: boolean; code?: string }> { return this.mediaRuntime.copyMediaWithCacheAndDedup(kind, sourcePath, destPath, control) }
  private triggerMediaFileCacheCleanup(force = false): void { this.mediaRuntime.triggerMediaFileCacheCleanup(force) }
  private async cleanupMediaFileCache(): Promise<void> { return this.mediaRuntime.cleanupMediaFileCache() }

  async exportSessionToChatLab(...args: Parameters<typeof exportChatLabMixin.exportSessionToChatLab>): ReturnType<typeof exportChatLabMixin.exportSessionToChatLab> {
    return exportChatLabMixin.exportSessionToChatLab.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async exportSessionToDetailedJson(...args: Parameters<typeof exportJsonMixin.exportSessionToDetailedJson>): ReturnType<typeof exportJsonMixin.exportSessionToDetailedJson> {
    return exportJsonMixin.exportSessionToDetailedJson.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async exportSessionToExcel(...args: Parameters<typeof exportExcelMixin.exportSessionToExcel>): ReturnType<typeof exportExcelMixin.exportSessionToExcel> {
    return exportExcelMixin.exportSessionToExcel.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async exportSessionToTxt(...args: Parameters<typeof exportTxtMixin.exportSessionToTxt>): ReturnType<typeof exportTxtMixin.exportSessionToTxt> {
    return exportTxtMixin.exportSessionToTxt.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async exportSessionToWeCloneCsv(...args: Parameters<typeof exportWeCloneMixin.exportSessionToWeCloneCsv>): ReturnType<typeof exportWeCloneMixin.exportSessionToWeCloneCsv> {
    return exportWeCloneMixin.exportSessionToWeCloneCsv.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async exportSessionToHtml(...args: Parameters<typeof exportHtmlMixin.exportSessionToHtml>): ReturnType<typeof exportHtmlMixin.exportSessionToHtml> {
    return exportHtmlMixin.exportSessionToHtml.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async exportSessions(...args: Parameters<typeof exportSessionsMixin.exportSessions>): ReturnType<typeof exportSessionsMixin.exportSessions> {
    return exportSessionsMixin.exportSessions.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }

  async getExportStats(...args: Parameters<typeof exportSessionsMixin.getExportStats>): ReturnType<typeof exportSessionsMixin.getExportStats> {
    return exportSessionsMixin.getExportStats.apply(this as unknown as import('./exportWriterContext').ExportWriterHost, args)
  }
}

export const exportService = new ExportService()