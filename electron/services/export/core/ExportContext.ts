import { ExportOptions, ExportProgress, ExportStatsResult, ExportStatsCacheEntry, ExportStatsSessionSnapshot, ExportAggregatedSessionStatsCacheEntry, MediaExportTelemetry, MediaSourceResolution, MessageCollectMode } from '../types';
import { parallelLimit } from '../utils/parallelLimit';
import { FILE_APP_LOCAL_TYPES, FILE_APP_LOCAL_TYPE_SET, MESSAGE_TYPE_MAP } from '../constants';
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import { getEmojiPath } from 'wechat-emojis'
import { ConfigService } from '../../config'
import { wcdbService } from '../../wcdbService'
import { imageDecryptService } from '../../imageDecryptService'
import { chatService } from '../../chatService'
import { videoService } from '../../videoService'
import { voiceTranscribeService } from '../../voiceTranscribeService'
import { exportRecordService } from '../../exportRecordService'
import { EXPORT_HTML_STYLES } from '../../exportHtmlStyles'
import { LRUCache } from '../../../utils/LRUCache.js'
import { normalizeTimestampSeconds, formatTimestamp, formatIsoTimestamp, parseCompactDateTimeDigitsToSeconds, parseDateTimeTextToSeconds, normalizeExportDateRange, normalizeRowTimestampSeconds, getTimestampSecondsFromRow } from '../../export/utils/timestamp';
import { escapeHtml, escapeAttribute, renderMultilineText, decodeHtmlEntities } from '../../export/utils/htmlEscape';
import { sanitizeExportFileNamePart, resolveFileAttachmentExtensionDir, normalizeFileNamingMode, normalizeExportConflictStrategy, formatDateTokenBySeconds, buildDateRangeFileNamePart, buildSessionExportBaseName, reserveUniqueOutputPath } from '../../export/utils/fileNaming';
import { extractXmlValue, extractXmlAttribute, extractAppMessageType, normalizeAppMessageContent } from '../../export/parsers/xmlExtractor';
import { decodeMessageContent, decodeMaybeCompressed, decodeBinaryContent, looksLikeHex, looksLikeBase64 } from '../../export/parsers/contentDecoder';
import { parseVoipMessage } from '../../export/parsers/voipParser';
import { resolveTransferDesc, getTransferPrefix, isTransferExportContent, appendTransferDesc, extractAmountFromText, isSameWxid } from '../../export/parsers/transferParser';
import { looksLikeWxid, sanitizeQuotedContent, parseQuoteMessage } from '../../export/parsers/quoteParser';
import { parseChatHistory, formatForwardChatRecordContent } from '../../export/parsers/forwardRecordParser';
import { formatEmojiSemanticText, extractLooseHexMd5, normalizeEmojiCaption } from '../../export/parsers/fileAppParser';
import { stripSenderPrefix, cleanSystemMessage, extractReadableSystemMessageText, parseDurationSeconds } from '../../export/parsers/messageParser';
import { getPreferredDisplayName, resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { resolveGroupNicknameByCandidates, buildGroupNicknameIdCandidates, normalizeGroupNicknameIdentity, normalizeGroupNickname } from '../../export/contacts/groupNickname';
import { getAvatarFallback } from '../../export/contacts/avatarHelper';
import { pathExists, ensureExportDir, copyFileOptimized, hardlinkOrCopyFile } from '../../export/media/fileCopy';
import { getMediaFileStat } from '../../export/media/attachmentResolver';

export class ExportContext {
    private configService: ConfigService;
    private runtimeConfig: { dbPath?: string; decryptKey?: string; myWxid?: string; accountDir?: string; imageXorKey?: unknown; imageAesKey?: string } | null = null;
    private contactCache: LRUCache<string, { displayName: string; avatarUrl?: string }>;
    private inlineEmojiCache: LRUCache<string, string>;
    private htmlStyleCache: string | null = null;
    public exportStatsCache = new Map<string, ExportStatsCacheEntry>();
    public exportAggregatedSessionStatsCache = new Map<string, ExportAggregatedSessionStatsCacheEntry>();
    public readonly exportStatsCacheTtlMs = 2 * 60 * 1000;
    public readonly exportAggregatedSessionStatsCacheTtlMs = 60 * 1000;
    public readonly exportStatsCacheMaxEntries = 16;
    private readonly STOP_ERROR_CODE = 'WEFLOW_EXPORT_STOP_REQUESTED';
    private readonly PAUSE_ERROR_CODE = 'WEFLOW_EXPORT_PAUSE_REQUESTED';
    private mediaFileCachePopulatePending = new Map<string, Promise<string | null>>();
    private mediaFileCacheReadyDirs = new Set<string>();
    private mediaExportTelemetry: MediaExportTelemetry | null = null;
    private mediaRunSourceDedupMap = new Map<string, string>();
    private mediaRunMissingImageKeys = new Set<string>();
    private activeChatImagePipelineCount = 0;
    private chatImagePipelineWaiters: Array<() => void> = [];
    private mediaFileCacheCleanupPending: Promise<void> | null = null;
    private mediaFileCacheLastCleanupAt = 0;
    private readonly mediaFileCacheCleanupIntervalMs = 30 * 60 * 1000;
    private readonly mediaFileCacheMaxBytes = 6 * 1024 * 1024 * 1024;
    private readonly mediaFileCacheMaxFiles = 120000;
    private readonly mediaFileCacheTtlMs = 45 * 24 * 60 * 60 * 1000;
    private emojiCaptionCache = new Map<string, string | null>();
    private emojiCaptionPending = new Map<string, Promise<string | null>>();
    private emojiMd5ByCdnCache = new Map<string, string | null>();
    private emojiMd5ByCdnPending = new Map<string, Promise<string | null>>();
    private emoticonDbPathCache: string | null = null;
    private emoticonDbPathCacheToken = '';
    private readonly emojiCaptionLookupConcurrency = 8;
    private weliveRawExportPaths = new Map<string, string>();
    private contactMetadataOpenPromise: Promise<boolean> | null = null;

    constructor() {
        this.configService = new ConfigService()
        this.contactCache = new LRUCache(500)
        this.inlineEmojiCache = new LRUCache(100)
    }

    private createStopError(): Error {
        const error = new Error('导出任务已停止');
        (error as Error & { code?: string }).code = this.STOP_ERROR_CODE
        return error
    }

    private createPauseError(): Error {
        const error = new Error('导出任务已暂停');
        (error as Error & { code?: string }).code = this.PAUSE_ERROR_CODE
        return error
    }

    setRuntimeConfig(config: { dbPath?: string; decryptKey?: string; myWxid?: string; accountDir?: string; imageXorKey?: unknown; imageAesKey?: string; resourcesPath?: string; appPath?: string; isPackaged?: boolean } | null): void {
        this.runtimeConfig = config
        this.contactMetadataOpenPromise = null
        imageDecryptService.setRuntimeConfig({
          dbPath: config?.dbPath,
          myWxid: config?.myWxid,
          imageXorKey: config?.imageXorKey,
          imageAesKey: config?.imageAesKey
        })
        chatService.setRuntimeConfig({
          dbPath: config?.dbPath,
          decryptKey: config?.decryptKey,
          myWxid: config?.myWxid,
          resourcesPath: config?.resourcesPath,
          appPath: config?.appPath,
          isPackaged: config?.isPackaged
        })
    }

    public getConfiguredDbPath(): string {
        return String(this.runtimeConfig?.dbPath || this.configService.get('dbPath') || '').trim()
    }

    public getConfiguredMyWxid(): string {
        return String(this.runtimeConfig?.myWxid || this.configService.getMyWxidCleaned() || '').trim()
    }

    private getConfiguredAccountDir(): string {
        const explicit = String(this.runtimeConfig?.accountDir || '').trim()
        if (explicit) return explicit
        const dbPath = this.getConfiguredDbPath()
        const rawWxid = String(this.runtimeConfig?.myWxid || this.configService.get('myWxid') || '').trim()
        return this.configService.getAccountDir(dbPath, rawWxid) || ''
    }

    private async ensureContactMetadataConnected(): Promise<boolean> {
        if (!this.isWeliveRawExportMode()) return true
        if (this.contactMetadataOpenPromise) return this.contactMetadataOpenPromise
        this.contactMetadataOpenPromise = (async () => {
          try {
            const accountDir = this.getConfiguredAccountDir()
            const decryptKey = String(this.runtimeConfig?.decryptKey || this.configService.get('decryptKey') || '').trim()
            if (!accountDir || !decryptKey) return false
            if (await wcdbService.isConnected().catch(() => false)) return true
            return await wcdbService.open(accountDir, decryptKey)
          } catch {
            return false
          }
        })()
        return this.contactMetadataOpenPromise
    }

    public normalizeSessionIds(sessionIds: string[]): string[] {
        return Array.from(
          new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))
        )
    }

    public setWeliveRawExportPaths(paths: Record<string, string> | null | undefined): void {
        this.weliveRawExportPaths.clear()
        if (!paths) return
        for (const [sessionId, filePath] of Object.entries(paths)) {
          const sid = String(sessionId || '').trim()
          const normalizedPath = String(filePath || '').trim()
          if (sid && normalizedPath) {
            this.weliveRawExportPaths.set(sid, normalizedPath)
          }
        }
    }

    public clearWeliveRawExportPaths(): void {
        this.weliveRawExportPaths.clear()
    }

    public isWeliveRawExportMode(): boolean {
        return this.weliveRawExportPaths.size > 0
    }

    private normalizeMaxFileSizeMb(value: unknown): number | undefined {
        const raw = Number(value);
        if (!Number.isFinite(raw) || raw <= 0) return undefined
        return Math.floor(raw)
    }

    public normalizeExportOptionsForRun(options: ExportOptions): ExportOptions {
        const normalizedDateRange = normalizeExportDateRange(options.dateRange);
        const normalizedMaxFileSizeMb = this.normalizeMaxFileSizeMb(options.maxFileSizeMb);
        const normalizedWriteLayout = this.resolveExportWriteLayout(options);
        const mediaContentType = this.getMediaContentType(options);
        const exportMedia = options.exportMedia === true || this.isMediaOptionSelected(options) || mediaContentType !== null;
        const resolveMediaOption = (key: keyof Pick<ExportOptions, 'exportImages' | 'exportVoices' | 'exportVideos' | 'exportEmojis' | 'exportFiles'>, type: MediaContentType): boolean | undefined => {
          if (mediaContentType) return mediaContentType === type
          return exportMedia ? options[key] !== false : options[key]
        }
        return {
          ...options,
          dateRange: normalizedDateRange,
          maxFileSizeMb: normalizedMaxFileSizeMb,
          exportConflictStrategy: this.resolveExportConflictStrategy(options),
          exportWriteLayout: normalizedWriteLayout,
          exportMedia,
          exportImages: resolveMediaOption('exportImages', 'image'),
          exportVoices: resolveMediaOption('exportVoices', 'voice'),
          exportVideos: resolveMediaOption('exportVideos', 'video'),
          exportEmojis: resolveMediaOption('exportEmojis', 'emoji'),
          exportFiles: resolveMediaOption('exportFiles', 'file')
        }
    }

    public resolveExportWriteLayout(options?: Pick<ExportOptions, 'exportWriteLayout'> | null): 'A' | 'B' | 'C' {
        const optionLayout = options?.exportWriteLayout;
        if (optionLayout === 'A' || optionLayout === 'B' || optionLayout === 'C') return optionLayout
        const rawWriteLayout = this.configService.get('exportWriteLayout');
        return rawWriteLayout === 'A' || rawWriteLayout === 'B' || rawWriteLayout === 'C'
        ? rawWriteLayout
        : 'B'
    }

    public resolveExportConflictStrategy(options?: Pick<ExportOptions, 'exportConflictStrategy'> | null): 'incremental' | 'overwrite' | 'rename' {
        return normalizeExportConflictStrategy(options?.exportConflictStrategy)
    }

    public shouldReuseExistingExportFile(options?: Pick<ExportOptions, 'exportConflictStrategy'> | null): boolean {
        return this.resolveExportConflictStrategy(options) === 'incremental'
    }

    public resolveExportPathStyle(options?: Pick<ExportOptions, 'exportPathStyle'> | null): 'posix' | 'windows' {
        const style = options?.exportPathStyle
        if (style === 'posix') return 'posix'
        if (style === 'windows') return 'windows'
        return process.platform === 'win32' ? 'windows' : 'posix'
    }

    public formatExportMediaPath(relativePath: string | undefined | null, options?: Pick<ExportOptions, 'exportPathStyle'> | null, target: 'text' | 'url' = 'text'): string {
        const value = String(relativePath || '').trim()
        if (!value) return ''
        if (/^(?:https?:|data:|blob:)/i.test(value)) return value

        const normalized = value.replace(/\\/g, '/')
        if (target === 'url') return normalized

        return this.resolveExportPathStyle(options) === 'windows'
          ? normalized.replace(/\//g, '\\')
          : normalized
    }

    public isStopError(error: unknown): boolean {
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

    public isPauseError(error: unknown): boolean {
        if (!error) return false
        if (typeof error === 'string') {
          return error.includes(this.PAUSE_ERROR_CODE) || error.includes('导出任务已暂停')
        }

        if (error instanceof Error) {
          const code = (error as Error & { code?: string }).code
          return code === this.PAUSE_ERROR_CODE || error.message.includes(this.PAUSE_ERROR_CODE) || error.message.includes('导出任务已暂停')
        }

        return false
    }

    public throwIfStopRequested(control?: ExportTaskControl): void {
        if (control?.shouldStop?.()) {
          throw this.createStopError()
        }

        if (control?.shouldPause?.()) {
          throw this.createPauseError()
        }
    }

    public async recordCreatedFileBeforeWrite(filePath: string, control?: ExportTaskControl): Promise<void> {
        if (!control?.recordCreatedFile) return
        if (!await pathExists(filePath)) {
          control.recordCreatedFile(filePath)
        }
    }

    public async createWeliveRawOutputPlaceholder(outputPath: string, control?: ExportTaskControl): Promise<void> {
        if (!this.isWeliveRawExportMode()) return
        const normalized = String(outputPath || '').trim()
        if (!normalized) return
        const parent = path.dirname(normalized)
        await fs.promises.mkdir(parent, { recursive: true })
        await this.recordCreatedFileBeforeWrite(normalized, control)
        if (await pathExists(normalized)) return
        await fs.promises.writeFile(normalized, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
          if (error?.code !== 'EEXIST') throw error
        })
    }

    public getClampedConcurrency(value: number | undefined, fallback = 2, max = 6): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
        const raw = Math.floor(value);
        return Math.max(1, Math.min(raw, max))
    }

    public createProgressEmitter(onProgress?: (progress: ExportProgress) => void): {
        emit: (progress: ExportProgress, options?: { force?: boolean }) => void
        flush: () => void
        } {
        if (!onProgress) {
          return {
            emit: () => { /* noop */ },
            flush: () => { /* noop */ }
          }
        }

        let pending: ExportProgress | null = null;
        let lastSentAt = 0;
        let lastPhase = '';
        let lastSessionId = '';
        let lastCollected = 0;
        let lastExported = 0;
        const MIN_PROGRESS_EMIT_INTERVAL_MS = 400;
        const MESSAGE_PROGRESS_DELTA_THRESHOLD = 1200;
        const commit = (progress: ExportProgress) => {
                  onProgress(progress)
                  pending = null
                  lastSentAt = Date.now()
                  lastPhase = String(progress.phase || '')
                  lastSessionId = String(progress.currentSessionId || '')
                  lastCollected = Number.isFinite(progress.collectedMessages) ? Math.max(0, Math.floor(progress.collectedMessages || 0)) : lastCollected
                  lastExported = Number.isFinite(progress.exportedMessages) ? Math.max(0, Math.floor(progress.exportedMessages || 0)) : lastExported
                };
        const emit = (progress: ExportProgress, options?: { force?: boolean }) => {
                  pending = progress
                  const force = options?.force === true
                  const now = Date.now()
                  const phase = String(progress.phase || '')
                  const sessionId = String(progress.currentSessionId || '')
                  const collected = Number.isFinite(progress.collectedMessages) ? Math.max(0, Math.floor(progress.collectedMessages || 0)) : lastCollected
                  const exported = Number.isFinite(progress.exportedMessages) ? Math.max(0, Math.floor(progress.exportedMessages || 0)) : lastExported
                  const collectedDelta = Math.abs(collected - lastCollected)
                  const exportedDelta = Math.abs(exported - lastExported)
                  const shouldEmit = force ||
                    phase !== lastPhase ||
                    sessionId !== lastSessionId ||
                    collectedDelta >= MESSAGE_PROGRESS_DELTA_THRESHOLD ||
                    exportedDelta >= MESSAGE_PROGRESS_DELTA_THRESHOLD ||
                    (now - lastSentAt >= MIN_PROGRESS_EMIT_INTERVAL_MS)

                  if (shouldEmit && pending) {
                    commit(pending)
                  }
                };
        const flush = () => {
                  if (!pending) return
                  commit(pending)
                };
        return { emit, flush }
    }

    private isCloneUnsupportedError(code: string | undefined): boolean {
        return code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EINVAL' || code === 'EXDEV' || code === 'ENOTTY'
    }

    private getMediaFileCacheRoot(): string {
        return path.join(this.configService.getCacheBasePath(), 'export-media-files')
    }

    private createEmptyMediaTelemetry(): MediaExportTelemetry {
        return {
          doneFiles: 0,
          cacheHitFiles: 0,
          cacheMissFiles: 0,
          cacheFillFiles: 0,
          dedupReuseFiles: 0,
          bytesWritten: 0
        }
    }

    public resetMediaRuntimeState(): void {
        this.mediaExportTelemetry = this.createEmptyMediaTelemetry()
        this.mediaRunSourceDedupMap.clear()
        this.mediaRunMissingImageKeys.clear()
    }

    public clearMediaRuntimeState(): void {
        this.mediaExportTelemetry = null
        this.mediaRunSourceDedupMap.clear()
        this.mediaRunMissingImageKeys.clear()
    }

    private async runWithChatImagePipelineLimit<T>(fn: () => Promise<T>): Promise<T> {
        while (this.activeChatImagePipelineCount >= 2) {
          await new Promise<void>((resolve) => this.chatImagePipelineWaiters.push(resolve))
        }

        this.activeChatImagePipelineCount += 1
        try {
          return await fn()
        } finally {
          this.activeChatImagePipelineCount = Math.max(0, this.activeChatImagePipelineCount - 1)
          const next = this.chatImagePipelineWaiters.shift()
          if (next) next()
        }
    }

    public getMediaTelemetrySnapshot(): Partial<ExportProgress> {
        const stats = this.mediaExportTelemetry;
        if (!stats) return {}

        return {
          mediaDoneFiles: stats.doneFiles,
          mediaCacheHitFiles: stats.cacheHitFiles,
          mediaCacheMissFiles: stats.cacheMissFiles,
          mediaCacheFillFiles: stats.cacheFillFiles,
          mediaDedupReuseFiles: stats.dedupReuseFiles,
          mediaBytesWritten: stats.bytesWritten
        }
    }

    private noteMediaTelemetry(delta: Partial<MediaExportTelemetry>): void {
        if (!this.mediaExportTelemetry) return
        if (Number.isFinite(delta.doneFiles)) {
          this.mediaExportTelemetry.doneFiles += Math.max(0, Math.floor(Number(delta.doneFiles || 0)))
        }

        if (Number.isFinite(delta.cacheHitFiles)) {
          this.mediaExportTelemetry.cacheHitFiles += Math.max(0, Math.floor(Number(delta.cacheHitFiles || 0)))
        }

        if (Number.isFinite(delta.cacheMissFiles)) {
          this.mediaExportTelemetry.cacheMissFiles += Math.max(0, Math.floor(Number(delta.cacheMissFiles || 0)))
        }

        if (Number.isFinite(delta.cacheFillFiles)) {
          this.mediaExportTelemetry.cacheFillFiles += Math.max(0, Math.floor(Number(delta.cacheFillFiles || 0)))
        }

        if (Number.isFinite(delta.dedupReuseFiles)) {
          this.mediaExportTelemetry.dedupReuseFiles += Math.max(0, Math.floor(Number(delta.dedupReuseFiles || 0)))
        }

        if (Number.isFinite(delta.bytesWritten)) {
          this.mediaExportTelemetry.bytesWritten += Math.max(0, Math.floor(Number(delta.bytesWritten || 0)))
        }
    }

    private async ensureMediaFileCacheDir(dirPath: string): Promise<void> {
        if (this.mediaFileCacheReadyDirs.has(dirPath)) return
        await fs.promises.mkdir(dirPath, { recursive: true })
        this.mediaFileCacheReadyDirs.add(dirPath)
    }

    private buildMediaFileCachePath(kind: 'image' | 'video' | 'emoji', sourcePath: string, fileStat: { size: number; mtimeMs: number }): string {
        const normalizedSource = path.resolve(sourcePath);
        const rawKey = `${kind}\u001f${normalizedSource}\u001f${fileStat.size}\u001f${fileStat.mtimeMs}`;
        const digest = crypto.createHash('sha1').update(rawKey).digest('hex');
        const ext = path.extname(normalizedSource) || '';
        return path.join(this.getMediaFileCacheRoot(), kind, digest.slice(0, 2), `${digest}${ext}`)
    }

    private async resolveMediaFileCachePath(kind: 'image' | 'video' | 'emoji', sourcePath: string): Promise<{ cachePath: string; fileStat: { size: number; mtimeMs: number } } | null> {
        const fileStat = await getMediaFileStat(sourcePath);
        if (!fileStat) return null
        const cachePath = this.buildMediaFileCachePath(kind, sourcePath, fileStat);
        return { cachePath, fileStat }
    }

    private async populateMediaFileCache(kind: 'image' | 'video' | 'emoji', sourcePath: string): Promise<string | null> {
        const resolved = await this.resolveMediaFileCachePath(kind, sourcePath);
        if (!resolved) return null
        const { cachePath } = resolved;
        if (await pathExists(cachePath)) return cachePath
        const pending = this.mediaFileCachePopulatePending.get(cachePath);
        if (pending) return pending
        const task = (async () => {
                  try {
                    await this.ensureMediaFileCacheDir(path.dirname(cachePath))
                    if (await pathExists(cachePath)) return cachePath

                    const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
                    const copied = await copyFileOptimized(sourcePath, tempPath)
                    if (!copied.success) {
                      await fs.promises.rm(tempPath, { force: true }).catch(() => { })
                      return null
                    }
                    await fs.promises.rename(tempPath, cachePath).catch(async (error) => {
                      const code = (error as NodeJS.ErrnoException | undefined)?.code
                      if (code === 'EEXIST') {
                        await fs.promises.rm(tempPath, { force: true }).catch(() => { })
                        return
                      }
                      await fs.promises.rm(tempPath, { force: true }).catch(() => { })
                      throw error
                    })
                    this.noteMediaTelemetry({ cacheFillFiles: 1 })
                    return cachePath
                  } catch {
                    return null
                  } finally {
                    this.mediaFileCachePopulatePending.delete(cachePath)
                  }
                })();
        this.mediaFileCachePopulatePending.set(cachePath, task)
        return task
    }

    private async resolvePreferredMediaSource(kind: 'image' | 'video' | 'emoji', sourcePath: string): Promise<MediaSourceResolution> {
        const resolved = await this.resolveMediaFileCachePath(kind, sourcePath);
        if (!resolved) {
          return {
            sourcePath,
            cacheHit: false
          }
        }

        const dedupeKey = `${kind}\u001f${resolved.cachePath}`;
        if (await pathExists(resolved.cachePath)) {
          return {
            sourcePath: resolved.cachePath,
            cacheHit: true,
            cachePath: resolved.cachePath,
            fileStat: resolved.fileStat,
            dedupeKey
          }
        }

        void this.populateMediaFileCache(kind, sourcePath)
        return {
          sourcePath,
          cacheHit: false,
          cachePath: resolved.cachePath,
          fileStat: resolved.fileStat,
          dedupeKey
        }
    }

    private isHardlinkFallbackError(code: string | undefined): boolean {
        return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'ENOSYS' || code === 'ENOTSUP'
    }

    private async copyMediaWithCacheAndDedup(kind: 'image' | 'video' | 'emoji', sourcePath: string, destPath: string, control?: ExportTaskControl, options?: Pick<ExportOptions, 'exportConflictStrategy'>): Promise<{ success: boolean; code?: string }> {
        const existedBeforeCopy = await pathExists(destPath);
        if (existedBeforeCopy && this.shouldReuseExistingExportFile(options)) {
          this.noteMediaTelemetry({
            doneFiles: 1,
            dedupReuseFiles: 1
          })
          return { success: true }
        }
        const resolved = await this.resolvePreferredMediaSource(kind, sourcePath);
        if (resolved.cacheHit) {
          this.noteMediaTelemetry({ cacheHitFiles: 1 })
        } else {
          this.noteMediaTelemetry({ cacheMissFiles: 1 })
        }

        const dedupeKey = resolved.dedupeKey;
        if (dedupeKey) {
          const reusedPath = this.mediaRunSourceDedupMap.get(dedupeKey)
          if (reusedPath && reusedPath !== destPath && await pathExists(reusedPath)) {
            const reused = await hardlinkOrCopyFile(reusedPath, destPath)
            if (!reused.success) return reused
            this.noteMediaTelemetry({
              doneFiles: 1,
              dedupReuseFiles: 1,
              bytesWritten: resolved.fileStat?.size || 0
            })
            if (!existedBeforeCopy) {
              control?.recordCreatedFile?.(destPath)
            }
            return { success: true }
          }
        }

        const copied = resolved.cacheHit
                  ? await hardlinkOrCopyFile(resolved.sourcePath, destPath)
                  : await copyFileOptimized(resolved.sourcePath, destPath);
        if (!copied.success) return copied
        if (dedupeKey) {
          this.mediaRunSourceDedupMap.set(dedupeKey, destPath)
        }

        this.noteMediaTelemetry({
          doneFiles: 1,
          bytesWritten: resolved.fileStat?.size || 0
        })
        if (!existedBeforeCopy) {
          control?.recordCreatedFile?.(destPath)
        }

        return { success: true }
    }

    public triggerMediaFileCacheCleanup(force = false): void {
        const now = Date.now();
        if (!force && now - this.mediaFileCacheLastCleanupAt < this.mediaFileCacheCleanupIntervalMs) return
        if (this.mediaFileCacheCleanupPending) return
        this.mediaFileCacheLastCleanupAt = now
        this.mediaFileCacheCleanupPending = this.cleanupMediaFileCache().finally(() => {
          this.mediaFileCacheCleanupPending = null
        })
    }

    private async cleanupMediaFileCache(): Promise<void> {
        const root = this.getMediaFileCacheRoot();
        if (!await pathExists(root)) return
        const now = Date.now();
        const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
        const dirs: string[] = [];
        const stack = [root];
        while (stack.length > 0) {
          const current = stack.pop() as string
          dirs.push(current)
          let entries: fs.Dirent[]
          try {
            entries = await fs.promises.readdir(current, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            const entryPath = path.join(current, entry.name)
            if (entry.isDirectory()) {
              stack.push(entryPath)
              continue
            }
            if (!entry.isFile()) continue
            try {
              const stat = await fs.promises.stat(entryPath)
              if (!stat.isFile()) continue
              files.push({
                filePath: entryPath,
                size: Number.isFinite(stat.size) ? Math.max(0, Math.floor(stat.size)) : 0,
                mtimeMs: Number.isFinite(stat.mtimeMs) ? Math.max(0, Math.floor(stat.mtimeMs)) : 0
              })
            } catch { }
          }
        }

        if (files.length === 0) return
        let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
        let totalFiles = files.length;
        const ttlThreshold = now - this.mediaFileCacheTtlMs;
        const removalSet = new Set<string>();
        for (const item of files) {
          if (item.mtimeMs > 0 && item.mtimeMs < ttlThreshold) {
            removalSet.add(item.filePath)
            totalBytes -= item.size
            totalFiles -= 1
          }
        }

        if (totalBytes > this.mediaFileCacheMaxBytes || totalFiles > this.mediaFileCacheMaxFiles) {
          const ordered = files
            .filter((item) => !removalSet.has(item.filePath))
            .sort((a, b) => a.mtimeMs - b.mtimeMs)
          for (const item of ordered) {
            if (totalBytes <= this.mediaFileCacheMaxBytes && totalFiles <= this.mediaFileCacheMaxFiles) break
            removalSet.add(item.filePath)
            totalBytes -= item.size
            totalFiles -= 1
          }
        }

        if (removalSet.size === 0) return
        for (const filePath of removalSet) {
          await fs.promises.rm(filePath, { force: true }).catch(() => { })
        }

        dirs.sort((a, b) => b.length - a.length)
        for (const dirPath of dirs) {
          if (dirPath === root) continue
          await fs.promises.rmdir(dirPath).catch(() => { })
        }
    }

    private isMediaOptionSelected(options: Pick<ExportOptions, 'exportImages' | 'exportVoices' | 'exportVideos' | 'exportEmojis' | 'exportFiles'>): boolean {
        return Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis || options.exportFiles)
    }

    public isMediaExportEnabled(options: ExportOptions): boolean {
        return this.getMediaContentType(options) !== null || this.isMediaOptionSelected(options)
    }

    public isUnboundedDateRange(dateRange?: { start: number; end: number } | null): boolean {
        return normalizeExportDateRange(dateRange) === null
    }

    private shouldUseFastTextCollection(options: ExportOptions): boolean {
        return !this.isMediaExportEnabled(options)
    }

    private getMediaContentType(options: ExportOptions): MediaContentType | null {
        const value = options.contentType;
        if (value === 'voice' || value === 'image' || value === 'video' || value === 'emoji' || value === 'file') {
          return value
        }

        return null
    }

    public isMediaContentBatchExport(options: ExportOptions): boolean {
        return this.getMediaContentType(options) !== null
    }

    private getTargetMediaLocalTypes(options: ExportOptions): Set<number> {
        const mediaContentType = this.getMediaContentType(options);
        if (mediaContentType === 'voice') return new Set([34])
        if (mediaContentType === 'image') return new Set([3])
        if (mediaContentType === 'video') return new Set([43])
        if (mediaContentType === 'emoji') return new Set([47])
        if (mediaContentType === 'file') return new Set(FILE_APP_LOCAL_TYPES)
        const selected = new Set<number>();
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

    private isFileAppLocalType(localType: number): boolean {
        return FILE_APP_LOCAL_TYPE_SET.has(localType)
    }

    private isFileOnlyMediaFilter(targetMediaTypes: Set<number> | null): boolean {
        return Boolean(
          targetMediaTypes &&
          targetMediaTypes.size === FILE_APP_LOCAL_TYPES.length &&
          FILE_APP_LOCAL_TYPES.every((fileType) => targetMediaTypes.has(fileType))
        )
    }

    private getFileAppMessageHints(message: Record<string, any> | null | undefined): {
        xmlType?: string
        fileName?: string
        fileSize?: number
        fileExt?: string
        fileMd5?: string
        } {
        const xmlType = String(message?.xmlType ?? message?.xml_type ?? '').trim() || undefined;
        const fileName = String(message?.fileName ?? message?.file_name ?? '').trim() || undefined;
        const fileExt = String(message?.fileExt ?? message?.file_ext ?? '').trim() || undefined;
        const fileSizeRaw = Number(message?.fileSize ?? message?.file_size ?? message?.total_len ?? message?.totalLen ?? message?.totallen ?? 0);
        const fileSize = Number.isFinite(fileSizeRaw) && fileSizeRaw > 0 ? Math.floor(fileSizeRaw) : undefined;
        const fileMd5Raw = String(message?.fileMd5 ?? message?.file_md5 ?? '').trim();
        const fileMd5 = /^[a-f0-9]{32}$/i.test(fileMd5Raw) ? fileMd5Raw.toLowerCase() : undefined;
        return { xmlType, fileName, fileSize, fileExt, fileMd5 }
    }

    private hasFileAppMessageHints(message: Record<string, any> | null | undefined): boolean {
        const hints = this.getFileAppMessageHints(message);
        if (hints.xmlType) return hints.xmlType === '6'
        return Boolean(hints.fileName || hints.fileExt || hints.fileMd5 || hints.fileSize)
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
        const { xmlType, fileName, fileExt, fileMd5, fileSize } = this.getFileAppMessageHints(msg as Record<string, any>);
        if (xmlType) return xmlType === '6'
        if (fileName || fileExt || fileMd5 || fileSize) return true
        const normalized = normalizeAppMessageContent(String(msg?.content || ''));
        if (!normalized || (!normalized.includes('<appmsg') && !normalized.includes('<msg>'))) {
          return false
        }

        return extractAppMessageType(normalized) === '6'
    }

    private extractFileAppMessageMeta(content: string): {
        xmlType?: string
        fileName?: string
        fileSize?: number
        fileExt?: string
        fileMd5?: string
        } | null {
        const normalized = normalizeAppMessageContent(content || '');
        if (!normalized || (!normalized.includes('<appmsg') && !normalized.includes('<msg>'))) {
          return null
        }

        const xmlType = extractAppMessageType(normalized);
        if (!xmlType) return null
        const rawFileName = extractXmlValue(normalized, 'filename') || extractXmlValue(normalized, 'title');
        const rawFileExt = extractXmlValue(normalized, 'fileext');
        const rawFileSize = extractXmlValue(normalized, 'totallen') ||
                  extractXmlValue(normalized, 'datasize') ||
                  extractXmlValue(normalized, 'filesize');
        const rawFileMd5 = extractXmlValue(normalized, 'md5') ||
                  extractXmlAttribute(normalized, 'appattach', 'md5') ||
                  extractLooseHexMd5(normalized);
        const fileSize = Number.parseInt(rawFileSize, 10);
        const fileMd5 = String(rawFileMd5 || '').trim();
        return {
          xmlType,
          fileName: decodeHtmlEntities(rawFileName).trim() || undefined,
          fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : undefined,
          fileExt: decodeHtmlEntities(rawFileExt).trim() || undefined,
          fileMd5: /^[a-f0-9]{32}$/i.test(fileMd5) ? fileMd5.toLowerCase() : undefined
        }
    }

    private resolveCollectMode(options: ExportOptions): MessageCollectMode {
        if (this.isMediaContentBatchExport(options)) {
          return 'media-fast'
        }

        return this.shouldUseFastTextCollection(options) ? 'text-fast' : 'full'
    }

    public resolveCollectParams(options: ExportOptions): { mode: MessageCollectMode; targetMediaTypes?: Set<number> } {
        const mode = this.resolveCollectMode(options);
        if (mode === 'media-fast') {
          const targetMediaTypes = this.getTargetMediaLocalTypes(options)
          if (targetMediaTypes.size > 0) {
            return { mode, targetMediaTypes }
          }
        }

        return { mode }
    }

    private resolveFastMediaStreamType(collectMode: MessageCollectMode, targetMediaTypes: Set<number> | null): 'image' | 'video' | null {
        if (collectMode !== 'media-fast' || !targetMediaTypes || targetMediaTypes.size !== 1) return null
        if (targetMediaTypes.has(3)) return 'image'
        if (targetMediaTypes.has(43)) return 'video'
        return null
    }

    private async collectMessagesByFastMediaStream(sessionId: string, cleanedMyWxid: string, normalizedDateRange: { start: number; end: number } | null, useCursorTimeRange: boolean, normalizedSenderUsernameFilter: string, mediaType: 'image' | 'video', onCollectProgress?: (payload: { fetched: number }) => void, control?: ExportTaskControl): Promise<{
        success: boolean
        rows: any[]
        senderUsernames: string[]
        firstTime: number | null
        lastTime: number | null
        error?: string
        }> {
        const rows: any[] = [];
        const senderSet = new Set<string>();
        let firstTime: number | null = null;
        let lastTime: number | null = null;
        let offset = 0;
        let hasMore = true;
        const PAGE_LIMIT = 480;
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
            if (normalizedSenderUsernameFilter && !isSameWxid(actualSender, normalizedSenderUsernameFilter)) {
              continue
            }
            senderSet.add(actualSender)

            const localIdRaw = Number(item?.localId || 0)
            const localId = Number.isFinite(localIdRaw) ? Math.floor(localIdRaw) : 0
            const serverIdRawToken = this.normalizeUnsignedIntToken(item?.serverId)
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

    public createCollectProgressReporter(sessionName: string, onProgress?: (progress: ExportProgress) => void, progressCurrent = 5): ((payload: { fetched: number; done?: boolean }) => void) | undefined {
        if (!onProgress) return undefined
        let lastReportAt = 0;
        const labelPrefix = this.weliveRawExportPaths.size > 0 ? '整理导出数据' : '收集消息';
        return ({ fetched, done }) => {
          const now = Date.now()
          if (!done && now - lastReportAt < 350) return
          lastReportAt = now
          onProgress({
            current: progressCurrent,
            total: 100,
            currentSession: sessionName,
            phase: 'preparing',
            phaseLabel: done && this.weliveRawExportPaths.size > 0
              ? `准备写入导出格式 ${fetched.toLocaleString()} 条`
              : `${labelPrefix} ${fetched.toLocaleString()} 条`,
            collectedMessages: fetched
          })
        }
    }

    private shouldDecodeMessageContentInFastMode(localType: number): boolean {
        if (localType === 3 || localType === 34 || localType === 42 || localType === 43) {
          return false
        }

        return true
    }

    private shouldDecodeMessageContentInMediaMode(localType: number, targetMediaTypes: Set<number> | null, options?: { allowFileProbe?: boolean }): boolean {
        const allowFileProbe = options?.allowFileProbe === true;
        if (!targetMediaTypes || (!targetMediaTypes.has(localType) && !allowFileProbe)) return false
        if (localType === 34) return false
        if (localType === 3 || localType === 43 || localType === 47 || this.isFileAppLocalType(localType) || allowFileProbe) return true
        return false
    }

    public cleanAccountDirName(dirName: string): string {
        const trimmed = dirName.trim();
        if (!trimmed) return trimmed
        if (trimmed.toLowerCase().startsWith('wxid_')) {
          const match = trimmed.match(/^(wxid_[^_]+)/i)
          if (match) return match[1]
          return trimmed
        }

        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/);
        const cleaned = suffixMatch ? suffixMatch[1] : trimmed;
        return cleaned
    }

    private getIntFromRow(row: Record<string, any>, keys: string[], fallback = 0): number {
        for (const key of keys) {
          const raw = row?.[key]
          if (raw === undefined || raw === null || raw === '') continue
          const parsed = Number.parseInt(String(raw), 10)
          if (Number.isFinite(parsed)) return parsed
        }

        return fallback
    }

    private getRowField(row: Record<string, any>, keys: string[]): any {
        for (const key of keys) {
          if (row && Object.prototype.hasOwnProperty.call(row, key)) {
            const value = row[key]
            if (value !== undefined && value !== null && value !== '') {
              return value
            }
          }
        }

        return undefined
    }

    public normalizeUnsignedIntToken(value: unknown): string {
        const raw = String(value ?? '').trim();
        if (!raw) return '0'
        if (/^\d+$/.test(raw)) {
          return raw.replace(/^0+(?=\d)/, '')
        }

        const num = Number(raw);
        if (!Number.isFinite(num) || num <= 0) return '0'
        return String(Math.floor(num))
    }

    public getStableMessageKey(msg: { localId?: unknown; createTime?: unknown; serverId?: unknown; serverIdRaw?: unknown }): string {
        const localId = this.normalizeUnsignedIntToken(msg?.localId);
        const createTime = this.normalizeUnsignedIntToken(msg?.createTime);
        const serverId = this.normalizeUnsignedIntToken(msg?.serverIdRaw ?? msg?.serverId);
        return `${localId}:${createTime}:${serverId}`
    }

    public getMediaCacheKey(msg: { localType?: unknown; localId?: unknown; createTime?: unknown; serverId?: unknown; serverIdRaw?: unknown }): string {
        const localType = this.normalizeUnsignedIntToken(msg?.localType);
        return `${localType}_${this.getStableMessageKey(msg)}`
    }

    private getImageMissingRunCacheKey(sessionId: string, imageMd5?: unknown, imageDatName?: unknown): string | null {
        const normalizedSessionId = String(sessionId || '').trim();
        const normalizedImageMd5 = String(imageMd5 || '').trim().toLowerCase();
        const normalizedImageDatName = String(imageDatName || '').trim().toLowerCase();
        if (!normalizedSessionId) return null
        if (!normalizedImageMd5 && !normalizedImageDatName) return null
        const primaryToken = normalizedImageMd5 || normalizedImageDatName;
        const secondaryToken = normalizedImageMd5 && normalizedImageDatName && normalizedImageDatName !== normalizedImageMd5
                  ? normalizedImageDatName
                  : '';
        return `${normalizedSessionId}\u001f${primaryToken}\u001f${secondaryToken}`
    }

    private normalizeEmojiMd5(value: unknown): string | undefined {
        const md5 = String(value || '').trim().toLowerCase();
        if (!/^[a-f0-9]{32}$/.test(md5)) return undefined
        return md5
    }

    private normalizeEmojiCdnUrl(value: unknown): string | undefined {
        let url = String(value || '').trim();
        if (!url) return undefined
        url = url.replace(/&amp;/g, '&')
        try {
          if (url.includes('%')) {
            url = decodeURIComponent(url)
          }
        } catch {
          // keep original URL if decoding fails
        }

        return url.trim() || undefined
    }

    private resolveStrictEmoticonDbPath(): string | null {
        const dbPath = this.getConfiguredDbPath();
        const rawWxid = this.getConfiguredMyWxid();
        const cleanedWxid = this.cleanAccountDirName(rawWxid);
        const token = `${dbPath}::${rawWxid}::${cleanedWxid}`;
        if (token === this.emoticonDbPathCacheToken) {
          return this.emoticonDbPathCache
        }

        this.emoticonDbPathCacheToken = token
        this.emoticonDbPathCache = null
        const dbStoragePath = this.resolveDbStoragePathForExport(dbPath, cleanedWxid) ||
                  this.resolveDbStoragePathForExport(dbPath, rawWxid);
        if (!dbStoragePath) return null
        const strictPath = path.join(dbStoragePath, 'emoticon', 'emoticon.db');
        if (fs.existsSync(strictPath)) {
          this.emoticonDbPathCache = strictPath
          return strictPath
        }

        return null
    }

    private resolveDbStoragePathForExport(basePath: string, wxid: string): string | null {
        if (!basePath) return null
        const normalized = basePath.replace(/[\\/]+$/, '');
        if (normalized.toLowerCase().endsWith('db_storage') && fs.existsSync(normalized)) {
          return normalized
        }

        const direct = path.join(normalized, 'db_storage');
        if (fs.existsSync(direct)) {
          return direct
        }

        if (!wxid) return null
        const viaWxid = path.join(normalized, wxid, 'db_storage');
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
        const cdnUrl = this.normalizeEmojiCdnUrl(cdnUrlRaw);
        if (!cdnUrl) return null
        const emoticonDbPath = this.resolveStrictEmoticonDbPath();
        if (!emoticonDbPath) return null
        const candidates = Array.from(new Set([
                  cdnUrl,
                  cdnUrl.replace(/&/g, '&amp;')
                ]));
        for (const candidate of candidates) {
          const escaped = candidate.replace(/'/g, "''")
          const result = await wcdbService.execQuery(
            'message',
            emoticonDbPath,
            `SELECT md5, lower(hex(md5)) AS md5_hex FROM kNonStoreEmoticonTable WHERE cdn_url = '${escaped}' COLLATE NOCASE LIMIT 1`
          )
          const row = result.success && Array.isArray(result.rows) ? result.rows[0] : null
          const md5 = this.normalizeEmojiMd5(this.getRowField(row || {}, ['md5', 'md5_hex']))
          if (md5) return md5
        }

        return null
    }

    private async getEmojiMd5ByCdnUrl(cdnUrlRaw: string): Promise<string | null> {
        const cdnUrl = this.normalizeEmojiCdnUrl(cdnUrlRaw);
        if (!cdnUrl) return null
        if (this.emojiMd5ByCdnCache.has(cdnUrl)) {
          return this.emojiMd5ByCdnCache.get(cdnUrl) ?? null
        }

        const pending = this.emojiMd5ByCdnPending.get(cdnUrl);
        if (pending) return pending
        const task = (async (): Promise<string | null> => {
                  try {
                    return await this.queryEmojiMd5ByCdnUrlFallback(cdnUrl)
                  } catch {
                    return null
                  }
                })();
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
        const md5 = this.normalizeEmojiMd5(md5Raw);
        if (!md5) return null
        if (this.emojiCaptionCache.has(md5)) {
          return this.emojiCaptionCache.get(md5) ?? null
        }

        const pending = this.emojiCaptionPending.get(md5);
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
                })();
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

    public async hydrateEmojiCaptionsForMessages(sessionId: string, messages: any[], control?: ExportTaskControl): Promise<void> {
        if (!Array.isArray(messages) || messages.length === 0) return
        if (this.isWeliveRawExportMode()) {
          let scanIndex = 0
          for (const msg of messages) {
            if ((scanIndex++ & 0x7f) === 0) {
              this.throwIfStopRequested(control)
            }
            if (Number(msg?.localType) !== 47) continue
            const content = String(msg?.content || '')
            const normalizedMd5 = this.normalizeEmojiMd5(msg?.emojiMd5)
              || this.extractEmojiMd5(content)
              || extractLooseHexMd5(content)
            const normalizedCdnUrl = this.normalizeEmojiCdnUrl(msg?.emojiCdnUrl || this.extractEmojiUrl(content))
            msg.emojiMd5 = normalizedMd5 || undefined
            msg.emojiCdnUrl = normalizedCdnUrl || undefined
            msg.emojiCaption = undefined
          }
          return
        }
        await this.backfillMediaFieldsFromMessageDetail(sessionId, messages, new Set([47]), control)
        const unresolvedByUrl = new Map<string, any[]>();
        const uniqueMd5s = new Set<string>();
        let scanIndex = 0;
        for (const msg of messages) {
          if ((scanIndex++ & 0x7f) === 0) {
            this.throwIfStopRequested(control)
          }
          if (Number(msg?.localType) !== 47) continue

          const content = String(msg?.content || '')
          const normalizedMd5 = this.normalizeEmojiMd5(msg?.emojiMd5)
            || this.extractEmojiMd5(content)
            || extractLooseHexMd5(content)
          const normalizedCdnUrl = this.normalizeEmojiCdnUrl(msg?.emojiCdnUrl || this.extractEmojiUrl(content))
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

        const unresolvedUrls = Array.from(unresolvedByUrl.keys());
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

        const md5List = Array.from(uniqueMd5s);
        if (md5List.length > 0) {
          await parallelLimit(md5List, this.emojiCaptionLookupConcurrency, async (md5, index) => {
            if ((index & 0x0f) === 0) {
              this.throwIfStopRequested(control)
            }
            await this.getEmojiCaptionByMd5(md5)
          })
        }

        let assignIndex = 0;
        for (const msg of messages) {
          if ((assignIndex++ & 0x7f) === 0) {
            this.throwIfStopRequested(control)
          }
          if (Number(msg?.localType) !== 47) continue
          const md5 = this.normalizeEmojiMd5(msg?.emojiMd5)
          if (!md5) {
            msg.emojiCaption = undefined
            continue
          }
          const caption = this.emojiCaptionCache.get(md5) ?? null
          msg.emojiCaption = caption || undefined
        }
    }

    public async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
        const wxid = this.getConfiguredMyWxid();
        if (this.weliveRawExportPaths.size > 0) {
          if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
          return { success: true, cleanedWxid: this.cleanAccountDirName(wxid) }
        }
        const dbPath = this.getConfiguredDbPath();
        const decryptKey = String(this.runtimeConfig?.decryptKey || this.configService.get('decryptKey') || '').trim();
        if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }

        if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }

        if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }

        const cleanedWxid = this.cleanAccountDirName(wxid);
        const accountDir = this.configService.getAccountDir(dbPath, wxid);
        if (!accountDir) return { success: false, error: '无法找到账号目录' }

        const ok = await wcdbService.open(accountDir, decryptKey);
        if (!ok) return { success: false, error: 'WCDB 打开失败' }

        return { success: true, cleanedWxid }
    }

    public async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
        if (this.contactCache.has(username)) {
          return this.contactCache.get(username)!
        }
        if (!await this.ensureContactMetadataConnected()) {
          const info = { displayName: username, avatarUrl: undefined }
          this.contactCache.set(username, info)
          return info
        }

        try {
          const [nameResult, avatarResult] = await Promise.all([
                    wcdbService.getDisplayNames([username]),
                    wcdbService.getAvatarUrls([username])
                  ]);
          let displayName = (nameResult.success && nameResult.map ? nameResult.map[username] : null) || username;
          let avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined;
          if (!avatarUrl) {
            const fallback = await chatService.getContactAvatar(username).catch(() => null)
            if (fallback?.avatarUrl) avatarUrl = fallback.avatarUrl
            if (displayName === username && fallback?.displayName) displayName = fallback.displayName
          }
          const info = { displayName, avatarUrl };
          this.contactCache.set(username, info)
          return info
        } catch {
          const info = { displayName: username, avatarUrl: undefined }
          this.contactCache.set(username, info)
          return info
        }
    }

    private resolveSessionFilePrefix(sessionId: string, contact?: any): string {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return '私聊_'
        if (normalizedSessionId.endsWith('@chatroom')) return '群聊_'
        if (normalizedSessionId.startsWith('gh_')) return '公众号_'
        const rawLocalType = contact?.local_type ?? contact?.localType ?? contact?.WCDB_CT_local_type;
        const localType = Number.parseInt(String(rawLocalType ?? ''), 10);
        const rawFlag = contact?.flag ?? contact?.contact_flag ?? contact?.contactFlag ?? contact?.WCDB_CT_flag;
        const flag = Number.parseInt(String(rawFlag ?? '0'), 10);
        const quanPin = String(contact?.quan_pin ?? contact?.quanPin ?? contact?.WCDB_CT_quan_pin ?? '').trim();
        const alias = String(contact?.alias ?? contact?.WCDB_CT_alias ?? '').trim();
        const remark = String(contact?.remark ?? contact?.WCDB_CT_remark ?? '').trim();
        if (Number.isFinite(localType) && (
          (localType === 0 && quanPin) ||
          (localType === 3 && Number.isFinite(flag) && flag !== 4 && (quanPin || alias || remark))
        )) {
          return '曾经的好友_'
        }

        return '私聊_'
    }

    public async getSessionFilePrefix(sessionId: string): Promise<string> {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return '私聊_'
        if (normalizedSessionId.endsWith('@chatroom')) return '群聊_'
        if (normalizedSessionId.startsWith('gh_')) return '公众号_'
        if (!await this.ensureContactMetadataConnected()) return '私聊_'
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

    public async preloadContacts(usernames: Iterable<string>, cache: Map<string, { success: boolean; contact?: any; error?: string }>, limit = 8): Promise<void> {
        const unique = Array.from(new Set(Array.from(usernames).filter(Boolean)));
        if (unique.length === 0) return
        if (!await this.ensureContactMetadataConnected()) return
        await parallelLimit(unique, limit, async (username) => {
          if (cache.has(username)) return
          const result = await wcdbService.getContact(username).catch((error) => ({ success: false, error: String(error) }))
          cache.set(username, result)
        })
    }

    public async preloadContactInfos(usernames: Iterable<string>, limit = 8): Promise<Map<string, { displayName: string; avatarUrl?: string }>> {
        const infoMap = new Map<string, { displayName: string; avatarUrl?: string }>();
        const unique = Array.from(new Set(Array.from(usernames).filter(Boolean)));
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
        if (!await this.ensureContactMetadataConnected()) {
          return new Map<string, string>()
        }
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

    private buildTrustedGroupNicknameMap(entries: Iterable<[string, string]>, candidates: string[] = []): Map<string, string> {
        const candidateSet = new Set(
                  buildGroupNicknameIdCandidates(candidates)
                    .map((id) => normalizeGroupNicknameIdentity(id))
                    .filter(Boolean)
                );
        const buckets = new Map<string, Set<string>>();
        for (const [memberIdRaw, nicknameRaw] of entries) {
          const identity = normalizeGroupNicknameIdentity(memberIdRaw || '')
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

        const trusted = new Map<string, string>();
        for (const [identity, nicknameSet] of buckets.entries()) {
          if (nicknameSet.size !== 1) continue
          trusted.set(identity, Array.from(nicknameSet)[0])
        }

        return trusted
    }

    private mergeGroupNicknameEntries(target: Map<string, string>, entries: Iterable<[string, string]>): void {
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

    private decodeExtBuffer(value: unknown): Buffer | null {
        if (!value) return null
        if (Buffer.isBuffer(value)) return value
        if (value instanceof Uint8Array) return Buffer.from(value)
        if (typeof value === 'string') {
          const raw = value.trim()
          if (!raw) return null

          if (looksLikeHex(raw)) {
            try { return Buffer.from(raw, 'hex') } catch { }
          }
          if (looksLikeBase64(raw)) {
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
        let value = 0;
        let shift = 0;
        let pos = offset;
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
        const id = String(value || '').trim();
        if (!id) return false
        if (id.includes('@chatroom')) return false
        if (id.length < 4 || id.length > 80) return false
        return /^[A-Za-z][A-Za-z0-9_.@-]*$/.test(id)
    }

    private parseGroupNicknamesFromExtBuffer(buffer: Buffer, candidates: string[] = []): Map<string, string> {
        const nicknameMap = new Map<string, string>();
        if (!buffer || buffer.length === 0) return nicknameMap
        try {
          const candidateSet = new Set(buildGroupNicknameIdCandidates(candidates).map((id) => id.toLowerCase()))

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
            const nickname = normalizeGroupNickname(rawNick.replace(/[\x00-\x1F\x7F]/g, '').trim())
            if (!nickname) {
              i = nickEnd - 1
              continue
            }

            const aliases = buildGroupNicknameIdCandidates([memberId])
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
    public convertMessageType(localType: number, content: string): number {
        const normalized = normalizeAppMessageContent(content || '');
        if (this.isReadableSystemMessage(localType, normalized)) {
          return 80
        }

        const xmlTypeRaw = extractAppMessageType(normalized);
        const xmlType = xmlTypeRaw ? Number.parseInt(xmlTypeRaw, 10) : null;
        const looksLikeAppMessage = localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>');
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

        return MESSAGE_TYPE_MAP[localType] ?? 99
    }

    public isReadableSystemMessage(localType: number, content: string): boolean {
        if (localType === 10000) return true
        const normalized = normalizeAppMessageContent(content || '');
        return /<sysmsg\b/i.test(stripSenderPrefix(normalized))
    }

    /**
     * 解码消息内容
     */
    /**
     * 根据用户偏好获取显示名称
     */
    /**
     * 从转账消息 XML 中提取并解析 "谁转账给谁" 描述
     * @param content 原始消息内容 XML
     * @param myWxid 当前用户 wxid
     * @param groupNicknamesMap 群昵称映射
     * @param getContactName 联系人名称解析函数
     * @returns "A 转账给 B" 或 null
     */
    /**
     * 解析消息内容为可读文本
     * 注意：语音消息在这里返回占位符，实际转文字在导出时异步处理
     */
    public parseMessageContent(content: string, localType: number, sessionId?: string, createTime?: number, myWxid?: string, senderWxid?: string, isSend?: boolean, emojiCaption?: string): string | null {
        if (!content && localType === 47) {
          return formatEmojiSemanticText(emojiCaption)
        }

        if (!content) return null
        const normalizedContent = normalizeAppMessageContent(content);
        const xmlType = extractAppMessageType(normalizedContent);
        switch (localType) {
          case 1: // 文本
            return stripSenderPrefix(content)
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
            const normalized48 = normalizeAppMessageContent(content)
            const locPoiname = extractXmlAttribute(normalized48, 'location', 'poiname') || extractXmlValue(normalized48, 'poiname') || extractXmlValue(normalized48, 'poiName')
            const locLabel = extractXmlAttribute(normalized48, 'location', 'label') || extractXmlValue(normalized48, 'label')
            const locLat = extractXmlAttribute(normalized48, 'location', 'x') || extractXmlAttribute(normalized48, 'location', 'latitude')
            const locLng = extractXmlAttribute(normalized48, 'location', 'y') || extractXmlAttribute(normalized48, 'location', 'longitude')
            const locParts: string[] = []
            if (locPoiname) locParts.push(locPoiname)
            if (locLabel && locLabel !== locPoiname) locParts.push(locLabel)
            if (locLat && locLng) locParts.push(`(${locLat},${locLng})`)
            return locParts.length > 0 ? `[位置] ${locParts.join(' ')}` : '[位置]'
          }
          case 49: {
            const title = extractXmlValue(normalizedContent, 'title')
            const type = extractAppMessageType(normalizedContent)
            const songName = extractXmlValue(normalizedContent, 'songname')

            // 转账消息特殊处理
            if (type === '2000') {
              const feedesc = extractXmlValue(normalizedContent, 'feedesc')
              const payMemo = extractXmlValue(normalizedContent, 'pay_memo')
              const transferPrefix = getTransferPrefix(normalizedContent, myWxid, senderWxid, isSend)
              if (feedesc) {
                return payMemo ? `${transferPrefix} ${feedesc} ${payMemo}` : `${transferPrefix} ${feedesc}`
              }
              return transferPrefix
            }

            if (type === '3') return songName ? `[音乐] ${songName}` : (title ? `[音乐] ${title}` : '[音乐]')
            if (type === '6') return title ? `[文件] ${title}` : '[文件]'
            if (type === '19') return formatForwardChatRecordContent(normalizedContent)
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
          case 50: return parseVoipMessage(content)
          case 10000: return cleanSystemMessage(content)
          case 266287972401: return cleanSystemMessage(content)  // 拍一拍
          case 244813135921: {
            // 引用消息
            const quoteDisplay = this.extractQuotedReplyDisplay(content)
            if (quoteDisplay) {
              return this.buildQuotedReplyText(quoteDisplay)
            }
            const title = extractXmlValue(content, 'title')
            return title || '[引用消息]'
          }
          default:
            // 对于未知的 localType，检查 XML type 来判断消息类型
            if (xmlType) {
              const title = extractXmlValue(content, 'title')

              // 群公告消息（type 87）
              if (xmlType === '87') {
                const textAnnouncement = extractXmlValue(content, 'textannouncement')
                if (textAnnouncement) {
                  return `[群公告] ${textAnnouncement}`
                }
                return '[群公告]'
              }

              // 转账消息
              if (xmlType === '2000') {
                const feedesc = extractXmlValue(content, 'feedesc')
                const payMemo = extractXmlValue(content, 'pay_memo')
                const transferPrefix = getTransferPrefix(content, myWxid, senderWxid, isSend)
                if (feedesc) {
                  return payMemo ? `${transferPrefix} ${feedesc} ${payMemo}` : `${transferPrefix} ${feedesc}`
                }
                return transferPrefix
              }

              // 其他类型
              if (xmlType === '3') return title ? `[音乐] ${title}` : '[音乐]'
              if (xmlType === '6') return title ? `[文件] ${title}` : '[文件]'
              if (xmlType === '19') return formatForwardChatRecordContent(normalizedContent)
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
    return stripSenderPrefix(normalizedContent) || null
}
}

    public formatPlainExportContent(content: string, localType: number, options: { exportVoiceAsText?: boolean }, voiceTranscript?: string, myWxid?: string, senderWxid?: string, isSend?: boolean, emojiCaption?: string): string {
        const safeContent = content || '';
        const readableSystemText = extractReadableSystemMessageText(safeContent);
        if (readableSystemText && this.isReadableSystemMessage(localType, safeContent)) {
          return readableSystemText
        }

        if (localType === 3) return '[图片]'
        if (localType === 1) return stripSenderPrefix(safeContent)
        if (localType === 34) {
          if (options.exportVoiceAsText) {
            return voiceTranscript || '[语音消息 - 转文字失败]'
          }
          return '[其他消息]'
        }

        if (localType === 42) {
          const normalized = normalizeAppMessageContent(safeContent)
          const nickname =
            extractXmlValue(normalized, 'nickname') ||
            extractXmlValue(normalized, 'displayname') ||
            extractXmlValue(normalized, 'name')
          return nickname ? `[名片]${nickname}` : '[名片]'
        }

        if (localType === 43) {
          const normalized = normalizeAppMessageContent(safeContent)
          const lengthValue =
            extractXmlValue(normalized, 'playlength') ||
            extractXmlValue(normalized, 'playLength') ||
            extractXmlValue(normalized, 'length') ||
            extractXmlValue(normalized, 'duration')
          const seconds = lengthValue ? parseDurationSeconds(lengthValue) : null
          return seconds ? `[视频]${seconds}s` : '[视频]'
        }

        if (localType === 47) {
          return formatEmojiSemanticText(emojiCaption)
        }

        if (localType === 48) {
          const normalized = normalizeAppMessageContent(safeContent)
          const locPoiname = extractXmlAttribute(normalized, 'location', 'poiname') || extractXmlValue(normalized, 'poiname') || extractXmlValue(normalized, 'poiName')
          const locLabel = extractXmlAttribute(normalized, 'location', 'label') || extractXmlValue(normalized, 'label')
          const locLat = extractXmlAttribute(normalized, 'location', 'x') || extractXmlAttribute(normalized, 'location', 'latitude')
          const locLng = extractXmlAttribute(normalized, 'location', 'y') || extractXmlAttribute(normalized, 'location', 'longitude')
          const locParts: string[] = []
          if (locPoiname) locParts.push(locPoiname)
          if (locLabel && locLabel !== locPoiname) locParts.push(locLabel)
          if (locLat && locLng) locParts.push(`(${locLat},${locLng})`)
          return locParts.length > 0 ? `[位置] ${locParts.join(' ')}` : '[位置]'
        }

        if (localType === 50) {
          return parseVoipMessage(safeContent)
        }

        if (localType === 10000 || localType === 266287972401) {
          return cleanSystemMessage(safeContent)
        }

        const normalized = normalizeAppMessageContent(safeContent);
        const isAppMessage = normalized.includes('<appmsg') || normalized.includes('<msg>');
        if (localType === 49 || isAppMessage) {
          const subTypeRaw = extractAppMessageType(normalized)
          const subType = subTypeRaw ? parseInt(subTypeRaw, 10) : 0
          const title = extractXmlValue(normalized, 'title') || extractXmlValue(normalized, 'appname')

          // 群公告消息（type 87）
          if (subType === 87) {
            const textAnnouncement = extractXmlValue(normalized, 'textannouncement')
            if (textAnnouncement) {
              return `[群公告]${textAnnouncement}`
            }
            return '[群公告]'
          }

          // 转账消息特殊处理
          if (subType === 2000 || title.includes('转账') || normalized.includes('transfer')) {
            const feedesc = extractXmlValue(normalized, 'feedesc')
            const payMemo = extractXmlValue(normalized, 'pay_memo')
            const transferPrefix = getTransferPrefix(normalized, myWxid, senderWxid, isSend)
            if (feedesc) {
              return payMemo ? `${transferPrefix}${feedesc} ${payMemo}` : `${transferPrefix}${feedesc}`
            }
            const amount = extractAmountFromText(
              [
                title,
                extractXmlValue(normalized, 'des'),
                extractXmlValue(normalized, 'money'),
                extractXmlValue(normalized, 'amount'),
                extractXmlValue(normalized, 'fee')
              ]
                .filter(Boolean)
                .join(' ')
            )
            return amount ? `${transferPrefix}${amount}` : transferPrefix
          }

          if (subType === 3 || normalized.includes('<musicurl') || normalized.includes('<songname')) {
            const songName = extractXmlValue(normalized, 'songname') || title || '音乐'
            return `[音乐]${songName}`
          }
          if (subType === 6) {
            const fileName = extractXmlValue(normalized, 'filename') || title || '文件'
            return `[文件]${fileName}`
          }
          if (title.includes('红包') || normalized.includes('hongbao')) {
            return `[红包]${title || '微信红包'}`
          }
          if (subType === 19 || normalized.includes('<recorditem')) {
            return formatForwardChatRecordContent(normalized)
          }
          if (subType === 33 || subType === 36) {
            const appName = extractXmlValue(normalized, 'appname') || title || '小程序'
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
        const safeContent = content || '';
        const referType = Number.parseInt(String(type || ''), 10);
        if (!Number.isFinite(referType)) {
          const sanitized = sanitizeQuotedContent(safeContent)
          return sanitized || '[消息]'
        }

        if (referType === 49) {
          const normalized = normalizeAppMessageContent(safeContent)
          const title =
            extractXmlValue(normalized, 'title') ||
            extractXmlValue(normalized, 'filename') ||
            extractXmlValue(normalized, 'appname')
          if (title) return stripSenderPrefix(title)

          const subTypeRaw = extractAppMessageType(normalized)
          const subType = subTypeRaw ? parseInt(subTypeRaw, 10) : 0
          if (subType === 6) return '[文件]'
          if (subType === 19) return '[聊天记录]'
          if (subType === 33 || subType === 36) return '[小程序]'
          return '[链接]'
        }

        return this.formatPlainExportContent(safeContent, referType, { exportVoiceAsText: false }) || '[消息]'
    }

    private resolveQuotedSenderUsername(fromusr?: string, chatusr?: string): string {
        const normalizedChatUsr = String(chatusr || '').trim();
        const normalizedFromUsr = String(fromusr || '').trim();
        if (normalizedChatUsr) {
          return normalizedChatUsr
        }

        if (normalizedFromUsr.endsWith('@chatroom')) {
          return ''
        }

        return normalizedFromUsr
    }

    public buildQuotedReplyText(display: {
        replyText: string
        quotedSender?: string
        quotedPreview: string
        }): string {
        const quoteLabel = display.quotedSender
                  ? `${display.quotedSender}：${display.quotedPreview}`
                  : display.quotedPreview;
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
          const normalized = normalizeAppMessageContent(content || '')
          const referMsgStart = normalized.indexOf('<refermsg>')
          const referMsgEnd = normalized.indexOf('</refermsg>')
          if (referMsgStart === -1 || referMsgEnd === -1) {
            return null
          }

          const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
          const quoteInfo = parseQuoteMessage(normalized)
          const replyText = stripSenderPrefix(extractXmlValue(normalized, 'title') || '')
          const quotedPreview = quoteInfo.content || this.formatQuotedReferencePreview(
            extractXmlValue(referMsgXml, 'content'),
            extractXmlValue(referMsgXml, 'type')
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

    public isQuotedReplyMessage(localType: number, content: string): boolean {
        if (localType === 244813135921) return true
        const normalized = normalizeAppMessageContent(content || '');
        if (!(localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>'))) {
          return false
        }

        const subType = extractAppMessageType(normalized);
        return subType === '57' || normalized.includes('<refermsg>')
    }

    public async resolveQuotedReplyDisplayWithNames(args: {
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
        const base = this.extractQuotedReplyDisplay(args.content);
        if (!base) return null
        if (base.quotedSender) return base
        const normalized = normalizeAppMessageContent(args.content || '');
        const referMsgStart = normalized.indexOf('<refermsg>');
        const referMsgEnd = normalized.indexOf('</refermsg>');
        if (referMsgStart === -1 || referMsgEnd === -1) {
          return base
        }

        const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11);
        const quotedSenderUsername = this.resolveQuotedSenderUsername(
                  extractXmlValue(referMsgXml, 'fromusr'),
                  extractXmlValue(referMsgXml, 'chatusr')
                );
        if (!quotedSenderUsername) {
          return base
        }

        const isQuotedSelf = isSameWxid(quotedSenderUsername, args.cleanedMyWxid);
        const fallbackDisplayName = isQuotedSelf
                  ? (args.myDisplayName || quotedSenderUsername)
                  : quotedSenderUsername;
        const profile = await resolveExportDisplayProfile(
                  quotedSenderUsername,
                  args.displayNamePreference,
                  args.getContact,
                  args.groupNicknamesMap,
                  fallbackDisplayName,
                  isQuotedSelf ? [args.rawMyWxid, args.cleanedMyWxid] : []
                );
        return {
          ...base,
          quotedSender: profile.displayName || fallbackDisplayName || base.quotedSender
        }
    }

    public getWeCloneTypeName(localType: number, content: string): string {
        if (localType === 1) return 'text'
        if (localType === 3) return 'image'
        if (localType === 47) return 'sticker'
        if (localType === 43) return 'video'
        if (localType === 34) return 'voice'
        if (localType === 48) return 'location'
        const normalized = normalizeAppMessageContent(content || '');
        const xmlType = extractAppMessageType(normalized);
        if (localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>')) {
          if (xmlType === '6') return 'file'
          return 'text'
        }

        return 'text'
    }

    public getWeCloneSource(msg: any, typeName: string, mediaItem: MediaExportItem | null): string {
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
          return extractXmlValue(xml, 'filename') || extractXmlValue(xml, 'title') || ''
        }

        return ''
    }

    public escapeCsvCell(value: unknown): string {
        if (value === null || value === undefined) return ''
        const text = String(value);
        if (/[",\r\n]/.test(text)) {
          return `"${text.replace(/"/g, '""')}"`
        }

        return text
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

        if (!content.includes('revokemsg') && !content.includes('撤回')) {
          return { isRevoke: false }
        }

        if (content.includes('你撤回')) {
          return { isRevoke: true, isSelfRevoke: true }
        }

        const sessionMatch = /<session>([^<]+)<\/session>/i.exec(content);
        if (sessionMatch) {
          const session = sessionMatch[1].trim()
          // 如果 session 是 wxid 格式，返回它
          if (session.startsWith('wxid_') || /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(session)) {
            return { isRevoke: true, revokerWxid: session }
          }
        }

        const fromUserMatch = /<fromusername>([^<]+)<\/fromusername>/i.exec(content);
        if (fromUserMatch) {
          return { isRevoke: true, revokerWxid: fromUserMatch[1].trim() }
        }

        return { isRevoke: true }
    }

    /**
     * 解析通话消息
     * 格式: <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[...]]></msg><room_type>0/1</room_type>...</VoIPBubbleMsg></voipmsg>
     * room_type: 0 = 语音通话, 1 = 视频通话
     */
    /**
     * 获取消息类型名称
     */
    public getMessageTypeName(localType: number, content?: string): string {
        if (content) {
          const normalized = normalizeAppMessageContent(content)
          if (this.isReadableSystemMessage(localType, normalized)) {
            return '系统消息'
          }
          const xmlType = extractAppMessageType(normalized)

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
                };
        return typeNames[localType] || '其他消息'
    }

    /**
     * 格式化时间戳为可读字符串
     */
    private normalizeTxtColumns(columns?: string[] | null): string[] {
        const fallback = ['index', 'time', 'senderRole', 'messageType', 'content'];
        const selected = new Set((columns && columns.length > 0 ? columns : fallback).filter(Boolean));
        const ordered = TXT_COLUMN_DEFINITIONS.map((col) => col.id).filter((id) => selected.has(id));
        return ordered.length > 0 ? ordered : fallback
    }

    private sanitizeTxtValue(value: string): string {
        return value.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim()
    }

    public loadExportHtmlStyles(): string {
        if (this.htmlStyleCache !== null) {
          return this.htmlStyleCache
        }

        const candidates = [
                  path.join(__dirname, 'exportHtml.css'),
                  path.join(process.cwd(), 'electron', 'services', 'exportHtml.css')
                ];
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
    /**
     * 解码 HTML 实体
     */
    private extractFinderFeedDesc(content: string): string {
        if (!content) return ''
        const match = /<finderFeed[\s\S]*?<desc>([\s\S]*?)<\/desc>/i.exec(content);
        if (!match) return ''
        return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }

    public async resolveQuotedMessagesForExport(messages: any[], sessionId: string): Promise<void> {
        if (this.isWeliveRawExportMode()) return
        const svridsToResolve: Array<{ msg: any; svrid: string }> = [];
        for (const msg of messages) {
          if (msg.replyToMessageId && msg.quotedContent === '[消息]') {
            svridsToResolve.push({ msg, svrid: msg.replyToMessageId })
          }
        }

        if (svridsToResolve.length === 0) return
        const results = await Promise.allSettled(
                  svridsToResolve.map(({ svrid }) => wcdbService.getMessageByServerId(sessionId, svrid))
                );
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

    public extractChatLabReplyToMessageId(content: string): string | undefined {
        try {
          const normalized = normalizeAppMessageContent(content || '')
          const referMsgStart = normalized.indexOf('<refermsg>')
          const referMsgEnd = normalized.indexOf('</refermsg>')
          if (referMsgStart === -1 || referMsgEnd === -1) {
            return undefined
          }

          const referMsgXml = normalized.substring(referMsgStart, referMsgEnd + 11)
          const replyToMessageIdRaw = this.normalizeUnsignedIntToken(extractXmlValue(referMsgXml, 'svrid'))
          return replyToMessageIdRaw !== '0' ? replyToMessageIdRaw : undefined
        } catch {
          return undefined
        }
    }

    public getExportPlatformMessageId(msg: { serverIdRaw?: unknown; serverId?: unknown }): string | undefined {
        const value = this.normalizeUnsignedIntToken(msg.serverIdRaw ?? msg.serverId);
        return value !== '0' ? value : undefined
    }

    public getExportReplyToMessageId(content: string): string | undefined {
        return this.extractChatLabReplyToMessageId(content)
    }

    public extractArkmeAppMessageMeta(content: string, localType: number): Record<string, any> | null {
        if (!content) return null
        const normalized = normalizeAppMessageContent(content);
        const looksLikeAppMsg = localType === 49 ||
                  localType === 244813135921 ||
                  normalized.includes('<appmsg') ||
                  normalized.includes('<msg>');
        const hasReferMsg = normalized.includes('<refermsg>');
        const xmlType = extractAppMessageType(normalized);
        const isFinder = xmlType === '51' ||
                  normalized.includes('<finder') ||
                  normalized.includes('finderusername') ||
                  normalized.includes('finderobjectid');
        const isMusic = xmlType === '3' ||
                  normalized.includes('<musicurl') ||
                  normalized.includes('<playurl>') ||
                  normalized.includes('<dataurl>');
        if (!looksLikeAppMsg && !isFinder && !hasReferMsg) return null
        let appMsgKind: string | undefined;
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

        const meta: Record<string, any> = {};
        if (xmlType) meta.appMsgType = xmlType
        else if (appMsgKind === 'quote') meta.appMsgType = '57'
        if (appMsgKind) meta.appMsgKind = appMsgKind
        const appMsgDesc = extractXmlValue(normalized, 'des') || extractXmlValue(normalized, 'desc');
        const appMsgAppName = extractXmlValue(normalized, 'appname');
        const appMsgSourceName = extractXmlValue(normalized, 'sourcename') ||
                  extractXmlValue(normalized, 'sourcedisplayname');
        const appMsgSourceUsername = extractXmlValue(normalized, 'sourceusername');
        const appMsgThumbUrl = extractXmlValue(normalized, 'thumburl') ||
                  extractXmlValue(normalized, 'cdnthumburl') ||
                  extractXmlValue(normalized, 'cover') ||
                  extractXmlValue(normalized, 'coverurl') ||
                  extractXmlValue(normalized, 'thumbUrl') ||
                  extractXmlValue(normalized, 'coverUrl');
        if (appMsgDesc) meta.appMsgDesc = appMsgDesc
        if (appMsgAppName) meta.appMsgAppName = appMsgAppName
        if (appMsgSourceName) meta.appMsgSourceName = appMsgSourceName
        if (appMsgSourceUsername) meta.appMsgSourceUsername = appMsgSourceUsername
        if (appMsgThumbUrl) meta.appMsgThumbUrl = appMsgThumbUrl
        if (appMsgKind === 'quote') {
          const quoteInfo = parseQuoteMessage(normalized)
          if (quoteInfo.content) meta.quotedContent = quoteInfo.content
          if (quoteInfo.sender) meta.quotedSender = quoteInfo.sender
          if (quoteInfo.type) meta.quotedType = quoteInfo.type
          if (quoteInfo.svrid) meta.quotedSvrid = quoteInfo.svrid
        }

        if (appMsgKind === 'link') {
          const linkCard = this.extractHtmlLinkCard(normalized, localType)
          const linkUrl = linkCard?.url || this.normalizeHtmlLinkUrl(
            extractXmlValue(normalized, 'shareurl') ||
            extractXmlValue(normalized, 'shorturl') ||
            extractXmlValue(normalized, 'dataurl')
          )
          if (linkCard?.title) meta.linkTitle = linkCard.title
          if (linkUrl) meta.linkUrl = linkUrl
          if (appMsgThumbUrl) meta.linkThumb = appMsgThumbUrl
        }

        if (isMusic) {
          const musicTitle =
            extractXmlValue(normalized, 'songname') ||
            extractXmlValue(normalized, 'title')
          const musicUrl =
            extractXmlValue(normalized, 'musicurl') ||
            extractXmlValue(normalized, 'playurl') ||
            extractXmlValue(normalized, 'songalbumurl')
          const musicDataUrl =
            extractXmlValue(normalized, 'dataurl') ||
            extractXmlValue(normalized, 'lowurl')
          const musicAlbumUrl = extractXmlValue(normalized, 'songalbumurl')
          const musicCoverUrl =
            extractXmlValue(normalized, 'thumburl') ||
            extractXmlValue(normalized, 'cdnthumburl') ||
            extractXmlValue(normalized, 'coverurl') ||
            extractXmlValue(normalized, 'cover')
          const musicSinger =
            extractXmlValue(normalized, 'singername') ||
            extractXmlValue(normalized, 'artist') ||
            extractXmlValue(normalized, 'albumartist')
          const musicAppName = extractXmlValue(normalized, 'appname')
          const musicSourceName = extractXmlValue(normalized, 'sourcename')
          const durationRaw =
            extractXmlValue(normalized, 'playlength') ||
            extractXmlValue(normalized, 'play_length') ||
            extractXmlValue(normalized, 'duration')
          const musicDuration = durationRaw ? parseDurationSeconds(durationRaw) : null

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

        const rawTitle = extractXmlValue(normalized, 'title');
        const finderFeedDesc = this.extractFinderFeedDesc(normalized);
        const finderTitle = (!rawTitle || rawTitle.includes('不支持')) ? finderFeedDesc : rawTitle;
        const finderDesc = extractXmlValue(normalized, 'des') || extractXmlValue(normalized, 'desc');
        const finderUsername = extractXmlValue(normalized, 'finderusername') ||
                  extractXmlValue(normalized, 'finder_username') ||
                  extractXmlValue(normalized, 'finderuser');
        const finderNickname = extractXmlValue(normalized, 'findernickname') ||
                  extractXmlValue(normalized, 'finder_nickname');
        const finderCoverUrl = extractXmlValue(normalized, 'thumbUrl') ||
                  extractXmlValue(normalized, 'coverUrl') ||
                  extractXmlValue(normalized, 'thumburl') ||
                  extractXmlValue(normalized, 'coverurl');
        const finderAvatar = extractXmlValue(normalized, 'avatar');
        const durationRaw = extractXmlValue(normalized, 'videoPlayDuration') || extractXmlValue(normalized, 'duration');
        const finderDuration = durationRaw ? parseDurationSeconds(durationRaw) : null;
        const finderObjectId = extractXmlValue(normalized, 'finderobjectid') ||
                  extractXmlValue(normalized, 'finder_objectid') ||
                  extractXmlValue(normalized, 'objectid') ||
                  extractXmlValue(normalized, 'object_id');
        const finderUrl = extractXmlValue(normalized, 'url') ||
                  extractXmlValue(normalized, 'shareurl');
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

    public extractArkmeContactCardMeta(content: string, localType: number): Record<string, any> | null {
        if (!content || localType !== 42) return null
        const normalized = normalizeAppMessageContent(content);
        const readAttr = (attrName: string): string =>
                  extractXmlAttribute(normalized, 'msg', attrName) || extractXmlValue(normalized, attrName);
        const contactCardWxid = readAttr('username') ||
                  readAttr('encryptusername') ||
                  readAttr('encrypt_user_name');
        const contactCardNickname = readAttr('nickname');
        const contactCardAlias = readAttr('alias');
        const contactCardRemark = readAttr('remark');
        const contactCardProvince = readAttr('province');
        const contactCardCity = readAttr('city');
        const contactCardSignature = readAttr('sign') || readAttr('signature');
        const contactCardAvatar = readAttr('smallheadimgurl') ||
                  readAttr('bigheadimgurl') ||
                  readAttr('headimgurl') ||
                  readAttr('avatar');
        const sexRaw = readAttr('sex');
        const contactCardGender = sexRaw ? parseInt(sexRaw, 10) : NaN;
        const meta: Record<string, any> = {
                  cardKind: 'contact-card'
                };
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
        const cached = this.inlineEmojiCache.get(name);
        if (cached) return cached
        const emojiPath = getEmojiPath(name as any);
        if (!emojiPath) return null
        const baseDir = path.dirname(require.resolve('wechat-emojis'));
        const absolutePath = path.join(baseDir, emojiPath);
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

    public renderTextWithEmoji(text: string): string {
        if (!text) return ''
        const parts = text.split(/\[(.*?)\]/g);
        const rendered = parts.map((part, index) => {
                  if (index % 2 === 1) {
                    const emojiDataUrl = this.getInlineEmojiDataUrl(part)
                    if (emojiDataUrl) {
                      // Cache full <img> tag to avoid re-escaping data URL every time
                      const escapedName = escapeAttribute(part)
                      return `<img class="inline-emoji" src="${emojiDataUrl}" alt="[${escapedName}]" />`
                    }
                    return escapeHtml(`[${part}]`)
                  }
                  return escapeHtml(part)
                });
        return rendered.join('')
    }

    public formatHtmlMessageText(content: string, localType: number, myWxid?: string, senderWxid?: string, isSend?: boolean, emojiCaption?: string): string {
        if (!content && localType === 47) {
          return formatEmojiSemanticText(emojiCaption)
        }

        if (!content) return ''
        const readableSystemText = extractReadableSystemMessageText(content);
        if (readableSystemText && this.isReadableSystemMessage(localType, content)) {
          return readableSystemText
        }

        if (localType === 1) {
          return stripSenderPrefix(content)
        }

        if (localType === 34) {
          return this.parseMessageContent(content, localType, undefined, undefined, myWxid, senderWxid, isSend, emojiCaption) || ''
        }

        return this.formatPlainExportContent(content, localType, { exportVoiceAsText: false }, undefined, myWxid, senderWxid, isSend, emojiCaption)
    }

    public extractHtmlLinkCard(content: string, localType: number): { title: string; url: string } | null {
        if (!content) return null
        const normalized = normalizeAppMessageContent(content);
        const isAppMessage = localType === 49 || normalized.includes('<appmsg') || normalized.includes('<msg>');
        if (!isAppMessage) return null
        const subType = extractAppMessageType(normalized);
        if (subType && subType !== '5' && subType !== '49') return null
        const url = [
                  extractXmlValue(normalized, 'url'),
                  extractXmlValue(normalized, 'shareurlopen'),
                  extractXmlValue(normalized, 'shareurloriginal'),
                  extractXmlValue(normalized, 'shareurl'),
                  extractXmlValue(normalized, 'shorturl'),
                  extractXmlValue(normalized, 'dataurl'),
                  extractXmlValue(normalized, 'lowurl'),
                  extractXmlValue(normalized, 'streamvideoweburl'),
                  extractXmlValue(normalized, 'weburl')
                ]
                  .map(candidate => this.normalizeHtmlLinkUrl(candidate))
                  .find(Boolean) || '';
        if (!url) return null
        const title = stripSenderPrefix(
                  extractXmlValue(normalized, 'title') || extractXmlValue(normalized, 'des') || url
                ) || url;
        return { title, url }
    }

    private normalizeHtmlLinkUrl(rawUrl: string): string {
        const value = (rawUrl || '').trim().replace(/&amp;/gi, '&');
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
                };
        if (value.startsWith('//')) {
          return parseHttpUrl(`https:${value}`)
        }

        const direct = parseHttpUrl(value);
        if (direct) return direct
        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
        const isDomainLike = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:[/:?#].*)?$/.test(value);
        if (!hasScheme && isDomainLike) {
          return parseHttpUrl(`https://${value}`)
        }

        return ''
    }

    private getLinkCardDisplayTitle(linkCard: { title: string; url: string }): string {
        const normalizedTitle = stripSenderPrefix(String(linkCard.title || '').trim());
        return normalizedTitle || linkCard.url || '链接'
    }

    public formatLinkCardExportText(content: string, localType: number, style: 'markdown' | 'append-url'): string | null {
        const linkCard = this.extractHtmlLinkCard(content, localType);
        if (!linkCard?.url) return null
        const title = this.getLinkCardDisplayTitle(linkCard);
        if (style === 'markdown') {
          return `[${title}](${linkCard.url})`
        }

        const prefix = title && title !== linkCard.url ? `[链接] ${title}` : '[链接]';
        return `${prefix}\n${linkCard.url}`
    }

    public applyExcelLinkCardCell(cell: ExcelJS.Cell, content: string, localType: number): boolean {
        const linkCard = this.extractHtmlLinkCard(content, localType);
        if (!linkCard?.url) return false
        const title = this.getLinkCardDisplayTitle(linkCard);
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

    public applyExcelMediaLinkCell(cell: ExcelJS.Cell, mediaItem: MediaExportItem | null | undefined, options: Pick<ExportOptions, 'exportPathStyle'>): boolean {
        const relativePath = mediaItem?.relativePath
        if (!relativePath) return false

        const text = this.formatExportMediaPath(relativePath, options, 'text')
        const hyperlink = this.formatExportMediaPath(relativePath, { exportPathStyle: 'posix' }, 'url')
        if (!text || !hyperlink) return false

        cell.value = {
          text,
          hyperlink,
          tooltip: text
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
    private resolveWeliveMediaPath(msg: any): string {
        const nestedMedia = msg?.media && typeof msg.media === 'object' ? msg.media : null
        const candidates = [
          msg?.mediaPath,
          msg?.media_path,
          msg?.videoPath,
          msg?.video_path,
          msg?.imagePath,
          msg?.image_path,
          msg?.voicePath,
          msg?.voice_path,
          msg?.filePath,
          msg?.file_path,
          msg?.localPath,
          msg?.local_path,
          msg?.sourcePath,
          msg?.source_path,
          msg?.fullPath,
          msg?.full_path,
          msg?.absolutePath,
          msg?.absolute_path,
          nestedMedia?.path,
          nestedMedia?.mediaPath,
          nestedMedia?.media_path,
          nestedMedia?.videoPath,
          nestedMedia?.video_path,
          nestedMedia?.localPath,
          nestedMedia?.local_path,
          nestedMedia?.filePath,
          nestedMedia?.file_path
        ]

        for (const candidate of candidates) {
          const value = String(candidate || '').trim()
          if (value) return value
        }

        return ''
    }

    public async exportMediaForMessage(msg: any, sessionId: string, mediaRootDir: string, mediaRelativePrefix: string, options: {
          exportImages?: boolean
          exportVoices?: boolean
          exportVideos?: boolean
          exportEmojis?: boolean
          exportFiles?: boolean
          maxFileSizeMb?: number
          exportVoiceAsText?: boolean
          exportConflictStrategy?: ExportOptions['exportConflictStrategy']
          includeVideoPoster?: boolean
          includeVoiceWithTranscript?: boolean
          dirCache?: Set<string>
          control?: ExportTaskControl
        }): Promise<MediaExportItem | null> {
        const localType = msg.localType;
        const weliveMediaPath = this.resolveWeliveMediaPath(msg)
        if (weliveMediaPath) {
          const adopted = await this.adoptWeliveExportedMedia(msg, weliveMediaPath, mediaRootDir, mediaRelativePrefix, {
            exportImages: options.exportImages,
            exportVoices: options.exportVoices,
            exportVideos: options.exportVideos,
            exportEmojis: options.exportEmojis,
            exportFiles: options.exportFiles,
            maxFileSizeMb: options.maxFileSizeMb,
            exportConflictStrategy: options.exportConflictStrategy,
            dirCache: options.dirCache,
            control: options.control
          })
          if (adopted) return adopted
        }

        if (localType === 3 && options.exportImages) {
          const result = await this.exportImage(
            msg,
            sessionId,
            mediaRootDir,
            mediaRelativePrefix,
            options.dirCache,
            options.control,
            options
          )
          if (result) {
          }
          return result
        }

        if (localType === 34) {
          if (options.exportVoices) {
            return this.exportVoice(msg, sessionId, mediaRootDir, mediaRelativePrefix, options.dirCache, options.control, options)
          }
          if (options.exportVoiceAsText) {
            return null
          }
        }

        if (localType === 47 && options.exportEmojis) {
          const result = await this.exportEmoji(msg, sessionId, mediaRootDir, mediaRelativePrefix, options.dirCache, options.control, options)
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
            options.control,
            options
          )
        }

        if (options.exportFiles && this.isFileAppMessage(msg)) {
          return this.exportFileAttachment(
            msg,
            mediaRootDir,
            mediaRelativePrefix,
            options.maxFileSizeMb,
            options.dirCache,
            options.control,
            options
          )
        }

        return null
    }

    private async adoptWeliveExportedMedia(msg: any, sourcePath: string, mediaRootDir: string, mediaRelativePrefix: string, options: {
          exportImages?: boolean
          exportVoices?: boolean
          exportVideos?: boolean
          exportEmojis?: boolean
          exportFiles?: boolean
          maxFileSizeMb?: number
          exportConflictStrategy?: ExportOptions['exportConflictStrategy']
          dirCache?: Set<string>
          control?: ExportTaskControl
        }): Promise<MediaExportItem | null> {
        try {
          if (!sourcePath || !await pathExists(sourcePath)) return null
          const localType = Number(msg?.localType || 0)
          let kind: MediaExportItem['kind'] | null = null
          let dirName = ''
          if (localType === 3 && options.exportImages) {
            kind = 'image'
            dirName = 'images'
          } else if (localType === 34 && options.exportVoices) {
            kind = 'voice'
            dirName = 'voices'
          } else if (localType === 47 && options.exportEmojis) {
            kind = 'emoji'
            dirName = 'emojis'
          } else if (localType === 43 && options.exportVideos) {
            kind = 'video'
            dirName = 'videos'
          } else if (options.exportFiles && this.isFileAppMessage(msg)) {
            kind = 'file'
            const fileNameRaw = String(msg?.fileName || path.basename(sourcePath) || '').trim()
            dirName = path.posix.join('file', resolveFileAttachmentExtensionDir(msg, fileNameRaw || sourcePath))
          }
          if (!kind || !dirName) return null

          const stat = await fs.promises.stat(sourcePath)
          if (!stat.isFile()) return null
          const maxBytes = Number.isFinite(options.maxFileSizeMb)
            ? Math.max(0, Math.floor(Number(options.maxFileSizeMb) * 1024 * 1024))
            : 0
          if (kind === 'file' && maxBytes > 0 && stat.size > maxBytes) return null

          const targetDir = path.join(mediaRootDir, mediaRelativePrefix, ...dirName.split('/'))
          await ensureExportDir(targetDir, options.control, options.dirCache)
          const ext = path.extname(sourcePath) || (kind === 'emoji' ? '.gif' : '')
          let destFileName = path.basename(sourcePath)
          if (kind === 'emoji') {
            const md5 = this.normalizeEmojiMd5(msg?.emojiMd5) || path.basename(sourcePath, path.extname(sourcePath))
            destFileName = `${md5}${ext || '.gif'}`
          } else if (kind === 'file') {
            const safeBaseName = path.basename(String(msg?.fileName || path.basename(sourcePath))).replace(/[\\/:*?"<>|]/g, '_') || path.basename(sourcePath)
            destFileName = safeBaseName
          }
          let destPath = path.join(targetDir, destFileName)
          if (kind === 'file' && this.resolveExportConflictStrategy(options) === 'rename') {
            destPath = await reserveUniqueOutputPath(destPath, new Set<string>())
            destFileName = path.basename(destPath)
          }
          if (path.resolve(sourcePath) !== path.resolve(destPath)) {
            if (kind === 'image' || kind === 'emoji' || kind === 'video') {
              const copied = await this.copyMediaWithCacheAndDedup(kind, sourcePath, destPath, options.control, options)
              if (!copied.success) return null
            } else {
              const existedBeforeCopy = await pathExists(destPath)
              if (existedBeforeCopy && this.shouldReuseExistingExportFile(options)) {
                this.noteMediaTelemetry({ doneFiles: 1, dedupReuseFiles: 1 })
              } else {
                const copied = await copyFileOptimized(sourcePath, destPath)
                if (!copied.success) return null
                if (!existedBeforeCopy) options.control?.recordCreatedFile?.(destPath)
                this.noteMediaTelemetry({ doneFiles: 1, bytesWritten: stat.size })
              }
            }
          }

          return {
            relativePath: path.posix.join(mediaRelativePrefix, dirName, destFileName),
            kind
          }
        } catch {
          return null
        }
    }

    /**
     * 导出图片文件
     */
    private async exportImage(msg: any, sessionId: string, mediaRootDir: string, mediaRelativePrefix: string, dirCache?: Set<string>, control?: ExportTaskControl, options?: Pick<ExportOptions, 'exportConflictStrategy'>): Promise<MediaExportItem | null> {
        try {
          const imagesDir = path.join(mediaRootDir, mediaRelativePrefix, 'images')
          await ensureExportDir(imagesDir, control, dirCache)

          const tryResolveImagePath = async (imageMd5?: string, imageDatName?: string): Promise<string | null> => {
            if (!imageMd5 && !imageDatName) return null
            return this.runWithChatImagePipelineLimit(async () => {
              const pickResolvedImagePath = (result: any): string | null => {
                if (!result?.success) return null
                const resolved = String(result.localPath || '').trim()
                return resolved || null
              }

              const resolveCachedPath = async (candidateMd5?: string, candidateDatName?: string): Promise<string | null> => {
                const cachedResult = await imageDecryptService.resolveCachedImage({
                  sessionId,
                  imageMd5: candidateMd5,
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

              const cachedPath = await resolveCachedPath(imageMd5, imageDatName)
              if (cachedPath) {
                return cachedPath
              }

              const decryptResult = await imageDecryptService.decryptImage({
                sessionId,
                imageMd5,
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
          let imageDatName = String(msg.imageDatName || '').trim().toLowerCase() || undefined
          const initialMissingRunCacheKey = this.getImageMissingRunCacheKey(sessionId, imageMd5, imageDatName)
          if (initialMissingRunCacheKey && this.mediaRunMissingImageKeys.has(initialMissingRunCacheKey)) {
            return null
          }
          let sourcePath = await tryResolveImagePath(imageMd5, imageDatName)

          // 快速流字段存在偏差时，按 localId 强制回填再重试一次，避免“导出进度前进但写入 0”。
          if (!sourcePath) {
            const localId = Number(msg?.localId || 0)
            if (Number.isFinite(localId) && localId > 0) {
              await this.backfillMediaFieldsFromMessageDetail(sessionId, [msg], new Set([3]), undefined, { force: true })
              imageMd5 = String(msg.imageMd5 || '').trim().toLowerCase() || undefined
              imageDatName = String(msg.imageDatName || '').trim().toLowerCase() || undefined
              sourcePath = await tryResolveImagePath(imageMd5, imageDatName)
            }
          }

          if (!sourcePath) {
            const missingRunCacheKey = this.getImageMissingRunCacheKey(sessionId, imageMd5, imageDatName)
            console.log(`[Export] 缩略图也获取失败，所有方式均失败 → 将显示 [图片] 占位符`)
            if (missingRunCacheKey) {
              this.mediaRunMissingImageKeys.add(missingRunCacheKey)
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

            if (await pathExists(destPath) && this.shouldReuseExistingExportFile(options)) {
              this.noteMediaTelemetry({ doneFiles: 1, dedupReuseFiles: 1 })
              return {
                relativePath: path.posix.join(mediaRelativePrefix, 'images', fileName),
                kind: 'image'
              }
            }

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
          const copied = await this.copyMediaWithCacheAndDedup('image', sourcePath, destPath, control, options)
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

    public async preloadMediaLookupCaches(sessionId: string, messages: any[], options: { exportImages?: boolean; exportVideos?: boolean }, control?: ExportTaskControl): Promise<void> {
        if (!Array.isArray(messages) || messages.length === 0) return
        const md5Pattern = /^[a-f0-9]{32}$/i;
        const imageMd5Set = new Set<string>();
        const videoTokenSet = new Set<string>();

        if (options.exportVideos) {
          const videoMessages = messages.filter((msg) => Number(msg?.localType || 0) === 43)
          if (videoMessages.length > 0) {
            await this.backfillMediaFieldsFromMessageDetail(sessionId, videoMessages, new Set([43]), control)
          }
        }

        let scanIndex = 0;
        for (const msg of messages) {
          if ((scanIndex++ & 0x7f) === 0) {
            this.throwIfStopRequested(control)
          }

          if (options.exportImages && msg?.localType === 3) {
            const imageMd5 = String(msg?.imageMd5 || '').trim().toLowerCase()
            if (imageMd5) {
              imageMd5Set.add(imageMd5)
            }
            const imageDatName = String(msg?.imageDatName || '').trim().toLowerCase()
            if (md5Pattern.test(imageDatName)) {
              imageMd5Set.add(imageDatName)
            }
          }

          if (options.exportVideos && msg?.localType === 43) {
            const videoMd5 = String(msg?.videoMd5 || '').trim().toLowerCase()
            if (videoMd5) {
              videoTokenSet.add(videoMd5)
              continue
            }
            const parsedVideoMd5 = String(videoService.parseVideoMd5(String(msg?.content || '')) || '').trim().toLowerCase()
            if (parsedVideoMd5) {
              videoTokenSet.add(parsedVideoMd5)
            }
          }

        }

        const preloadTasks: Array<Promise<void>> = [];
        if (imageMd5Set.size > 0) {
          preloadTasks.push(imageDecryptService.preloadImageHardlinkMd5s(Array.from(imageMd5Set)))
        }
        if (videoTokenSet.size > 0) {
          preloadTasks.push(videoService.getVideoInfoBatch(Array.from(videoTokenSet), { includePoster: false }).then(() => undefined))
        }

        if (preloadTasks.length === 0) return
        await Promise.all(preloadTasks.map((task) => task.catch(() => { })))
        this.throwIfStopRequested(control)
    }

    /**
     * 导出语音文件
     */
    public async preloadVoiceWavCache(sessionId: string, messages: any[], control?: ExportTaskControl): Promise<void> {
        if (!Array.isArray(messages) || messages.length === 0) return
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return
        const normalized: Array<{
              localId: number
              createTime: number
              serverId?: string | number
              senderWxid?: string | null
            }> = [];
        const seen = new Set<string>();
        for (const msg of messages) {
          const localIdRaw = Number(msg?.localId)
          const createTimeRaw = Number(msg?.createTime)
          const localId = Number.isFinite(localIdRaw) ? Math.max(0, Math.floor(localIdRaw)) : 0
          const createTime = Number.isFinite(createTimeRaw) ? Math.max(0, Math.floor(createTimeRaw)) : 0
          if (!localId || !createTime) continue
          const dedupeKey = this.getStableMessageKey(msg)
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          normalized.push({
            localId,
            createTime,
            serverId: msg?.serverIdRaw || msg?.serverId,
            senderWxid: msg?.senderUsername || null
          })
        }

        if (normalized.length === 0) return
        const chunkSize = 120;
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
    private async exportVoice(msg: any, sessionId: string, mediaRootDir: string, mediaRelativePrefix: string, dirCache?: Set<string>, control?: ExportTaskControl, options?: Pick<ExportOptions, 'exportConflictStrategy'>): Promise<MediaExportItem | null> {
        try {
          const voicesDir = path.join(mediaRootDir, mediaRelativePrefix, 'voices')
          await ensureExportDir(voicesDir, control, dirCache)

          const msgId = String(msg.localId)
          const safeSession = this.cleanAccountDirName(sessionId)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 48) || 'session'
          const stableKey = this.getStableMessageKey(msg).replace(/:/g, '_')
          const fileName = `voice_${safeSession}_${stableKey || msgId}.wav`
          const destPath = path.join(voicesDir, fileName)

          if (await pathExists(destPath) && this.shouldReuseExistingExportFile(options)) {
            this.noteMediaTelemetry({ doneFiles: 1, dedupReuseFiles: 1 })
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
            msg?.serverIdRaw || msg?.serverId,
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
    public async transcribeVoice(sessionId: string, msgId: string, createTime: number, senderWxid: string | null, serverId?: string | number): Promise<string> {
        try {
          const transcript = await chatService.getVoiceTranscript(sessionId, msgId, createTime, undefined, senderWxid || undefined, serverId)
          if (transcript.success) {
            const text = String(transcript.transcript || '').trim()
            return text ? `[语音转文字] ${text}` : '[语音消息 - 未识别到文字]'
          }
          return `[语音消息 - 转文字失败: ${transcript.error || '未知错误'}]`
        } catch (e) {
          return `[语音消息 - 转文字失败: ${String(e)}]`
        }
    }

    /**
     * 导出表情文件
     */
    private async exportEmoji(msg: any, sessionId: string, mediaRootDir: string, mediaRelativePrefix: string, dirCache?: Set<string>, control?: ExportTaskControl, options?: Pick<ExportOptions, 'exportConflictStrategy'>): Promise<MediaExportItem | null> {
        try {
          const emojisDir = path.join(mediaRootDir, mediaRelativePrefix, 'emojis')
          await ensureExportDir(emojisDir, control, dirCache)

          const emojiMd5 = this.normalizeEmojiMd5(msg?.emojiMd5 || msg?.emoji_md5)
          const emojiUrl = this.normalizeEmojiCdnUrl(msg?.emojiCdnUrl || msg?.emoji_cdn_url || this.extractEmojiUrl(String(msg?.content || '')))
          let localPath: string | null = null
          if (emojiUrl) {
            const downloaded = await chatService.downloadEmoji(emojiUrl, emojiMd5)
            localPath = downloaded.success && downloaded.localPath ? downloaded.localPath : null
          }
          if (!localPath) {
            // 使用 chatService 下载表情包 (利用其重试和 fallback 逻辑)
            localPath = await chatService.downloadEmojiFile({
              ...msg,
              emojiMd5: emojiMd5 || msg?.emojiMd5,
              emojiCdnUrl: emojiUrl || msg?.emojiCdnUrl
            })
          }

          if (!localPath) {
            return null
          }

          // 确定目标文件名
          const ext = path.extname(localPath) || '.gif'
          const key = emojiMd5 || crypto.createHash('md5').update(emojiUrl || localPath || String(msg.localId || '')).digest('hex')
          const fileName = `${key}${ext}`
          const destPath = path.join(emojisDir, fileName)
          const copied = await this.copyMediaWithCacheAndDedup('emoji', localPath, destPath, control, options)
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
    private async exportVideo(msg: any, sessionId: string, mediaRootDir: string, mediaRelativePrefix: string, dirCache?: Set<string>, includePoster = false, control?: ExportTaskControl, options?: Pick<ExportOptions, 'exportConflictStrategy'>): Promise<MediaExportItem | null> {
        try {
          const collectLookupTokens = () => {
            const contents = [
              msg?.content,
              msg?.messageContent,
              msg?.message_content,
              msg?.rawContent,
              msg?.raw_content,
              msg?.parsedContent,
              msg?.parsed_content
            ].map((item) => String(item || '')).filter(Boolean)
            const tokens = [
              msg?.videoMd5,
              msg?.video_md5,
              msg?.rawMd5,
              msg?.raw_md5,
              this.extractVideoFileNameFromRow(msg, contents[0] || ''),
              this.normalizeVideoFileToken(this.resolveWeliveMediaPath(msg))
            ]
            for (const content of contents) {
              tokens.push(videoService.parseVideoMd5(content))
              tokens.push(this.extractVideoMd5(content))
            }
            return Array.from(new Set(tokens
              .map((token) => this.normalizeVideoFileToken(token))
              .filter((token): token is string => Boolean(token))))
          }
          const resolveVideoInfo = async (token: string) => {
            if (!token) return null
            const videoInfo = await videoService.getVideoInfo(token, { includePoster })
            if (!videoInfo.exists || !videoInfo.videoUrl) return null
            return videoInfo
          }

          let videoInfo = null
          for (const token of collectLookupTokens()) {
            videoInfo = await resolveVideoInfo(token)
            if (videoInfo) break
          }
          if (!videoInfo) {
            const localId = Number(msg?.localId || 0)
            if (Number.isFinite(localId) && localId > 0) {
              await this.backfillMediaFieldsFromMessageDetail(sessionId, [msg], new Set([43]), undefined, { force: true })
              for (const token of collectLookupTokens()) {
                videoInfo = await resolveVideoInfo(token)
                if (videoInfo) break
              }
            }
          }
          if (!videoInfo) return null

          const videosDir = path.join(mediaRootDir, mediaRelativePrefix, 'videos')
          await ensureExportDir(videosDir, control, dirCache)

          const sourcePath = videoInfo.videoUrl
          if (!sourcePath) return null
          const fileName = path.basename(sourcePath)
          const destPath = path.join(videosDir, fileName)

          const copied = await this.copyMediaWithCacheAndDedup('video', sourcePath, destPath, control, options)
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
        const match = /md5="([^"]+)"/i.exec(content);
        return match?.[1]
    }

    /**
     * 从消息内容提取图片 DAT 文件名
     */
    private extractImageDatName(content: string): string | undefined {
        if (!content) return undefined
        const candidate = extractXmlValue(content, 'imgname') ||
                  extractXmlValue(content, 'cdnmidimgurl') ||
                  extractXmlValue(content, 'cdnthumburl') ||
                  extractXmlAttribute(content, 'img', 'imgname') ||
                  extractXmlAttribute(content, 'img', 'cdnmidimgurl') ||
                  extractXmlAttribute(content, 'img', 'cdnthumburl');
        return this.normalizeImageDatNameToken(candidate)
    }

    private normalizeImageDatNameToken(value: unknown): string | undefined {
        let text = String(value ?? '').trim();
        if (!text) return undefined
        text = text.replace(/&amp;/g, '&')
        try {
          if (text.includes('%')) text = decodeURIComponent(text)
        } catch { }

        const datLike = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/i.exec(text);
        if (datLike?.[1]) return datLike[1].toLowerCase()
        const base = text
                  .split(/[?#]/, 1)[0]
                  .replace(/^.*[\\/]/, '')
                  .replace(/\.(?:t\.)?dat$/i, '')
                  .trim();
        if (!base) return undefined
        const cdnToken = base.includes('_') ? base.split('_')[0] : base;
        const exact = /^([a-fA-F0-9]{16,64})$/.exec(cdnToken);
        if (exact?.[1]) return exact[1].toLowerCase()
        const preferred32 = /([a-fA-F0-9]{32})(?![a-fA-F0-9])/i.exec(cdnToken);
        if (preferred32?.[1]) return preferred32[1].toLowerCase()
        const fallback = /([a-fA-F0-9]{16,64})(?![a-fA-F0-9])/i.exec(cdnToken);
        return fallback?.[1]?.toLowerCase()
    }

    private extractImageDatNameFromPackedRaw(raw: unknown): string | undefined {
        const buffer = this.decodePackedInfoBuffer(raw);
        if (!buffer || buffer.length === 0) return undefined
        const printable: number[] = [];
        for (const byte of buffer) {
          printable.push(byte >= 0x20 && byte <= 0x7e ? byte : 0x20)
        }

        const text = Buffer.from(printable).toString('utf-8');
        const datLike = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/i.exec(text);
        if (datLike?.[1]) return datLike[1].toLowerCase()
        const fallback = /([0-9a-fA-F]{16,})/.exec(text);
        return fallback?.[1]?.toLowerCase()
    }

    private extractImageDatNameFromRow(row: Record<string, any>, content?: string): string | undefined {
        const byColumn = this.normalizeImageDatNameToken(this.getRowField(row, [
                  'image_path',
                  'imagePath',
                  'image_dat_name',
                  'imageDatName',
                  'img_path',
                  'imgPath',
                  'img_name',
                  'imgName'
                ]));
        if (byColumn) return byColumn
        const packedRaw = this.getRowField(row, [
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
                ]);
        const byPacked = this.extractImageDatNameFromPackedRaw(packedRaw);
        if (byPacked) return byPacked
        return this.extractImageDatName(content || '')
    }

    /**
     * 从消息内容提取表情 URL
     */
    private extractEmojiUrl(content: string): string | undefined {
        if (!content) return undefined
        const attrMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content);
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

        const tagMatch = /cdnurl[^>]*>([^<]+)/i.exec(content);
        return tagMatch?.[1]
    }

    /**
     * 从消息内容提取表情 MD5
     */
    private extractEmojiMd5(content: string): string | undefined {
        if (!content) return undefined
        const match = /md5\s*=\s*['"]([a-fA-F0-9]{32})['"]/i.exec(content) ||
                  /md5\s*=\s*([a-fA-F0-9]{32})/i.exec(content) ||
                  /<md5>([a-fA-F0-9]{32})<\/md5>/i.exec(content);
        return this.normalizeEmojiMd5(match?.[1]) || extractLooseHexMd5(content)
    }

    private extractVideoMd5(content: string): string | undefined {
        if (!content) return undefined
        const attrPatterns = [
          /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
          /<videomsg[^>]*\srawmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
          /<videomsg[^>]*\snewmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
          /<videomsg[^>]*\soriginsourcemd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
          /(?:^|\s)(?:md5|rawmd5|newmd5|originsourcemd5)\s*=\s*['"]([a-fA-F0-9]+)['"]/i
        ]
        for (const pattern of attrPatterns) {
          const match = pattern.exec(content)
          if (match?.[1]) return match[1].toLowerCase()
        }

        const tagMatch = /<(?:md5|rawmd5|newmd5|originsourcemd5)>([a-fA-F0-9]+)<\/(?:md5|rawmd5|newmd5|originsourcemd5)>/i.exec(content);
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
        let text = String(value || '').trim().toLowerCase();
        if (!text) return undefined
        text = text.replace(/^.*[\\/]/, '')
        text = text.replace(/\.(?:mp4|mov|m4v|avi|mkv|flv|jpg|jpeg|png|gif|dat)$/i, '')
        text = text.replace(/_thumb$/, '')
        const direct = /^([a-f0-9]{16,64})(?:_raw)?$/i.exec(text);
        if (direct) {
          const suffix = /_raw$/i.test(text) ? '_raw' : ''
          return `${direct[1].toLowerCase()}${suffix}`
        }

        const preferred32 = /([a-f0-9]{32})(?![a-f0-9])/i.exec(text);
        if (preferred32?.[1]) return preferred32[1].toLowerCase()
        const fallback = /([a-f0-9]{16,64})(?![a-f0-9])/i.exec(text);
        return fallback?.[1]?.toLowerCase()
    }

    private extractVideoFileNameFromPackedRaw(raw: unknown): string | undefined {
        const buffer = this.decodePackedInfoBuffer(raw);
        if (!buffer || buffer.length === 0) return undefined
        const candidates: string[] = [];
        let current = '';
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
        const exact32 = candidates.find((item) => item.length === 32);
        if (exact32) return exact32.toLowerCase()
        const fallback = candidates.find((item) => item.length >= 16 && item.length <= 64);
        return fallback?.toLowerCase()
    }

    private extractVideoFileNameFromRow(row: Record<string, any>, content?: string): string | undefined {
        const packedRaw = this.getRowField(row, [
                  'packed_info_data', 'packedInfoData',
                  'packed_info_blob', 'packedInfoBlob',
                  'packed_info', 'packedInfo',
                  'BytesExtra', 'bytes_extra',
                  'WCDB_CT_packed_info',
                  'reserved0', 'Reserved0', 'WCDB_CT_Reserved0'
                ]);
        const byPacked = this.extractVideoFileNameFromPackedRaw(packedRaw);
        if (byPacked) return byPacked
        const byColumn = this.normalizeVideoFileToken(this.getRowField(row, [
                  'video_md5', 'videoMd5', 'raw_md5', 'rawMd5', 'video_file_name', 'videoFileName'
                ]));
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
        const cleanedWxid = this.cleanAccountDirName(wxid);
        if (!basePath || !cleanedWxid) return null
        const normalized = path.resolve(basePath.replace(/[\\/]+$/, ''));
        const parentDir = path.dirname(normalized);
        const dbStorageParent = path.basename(normalized).toLowerCase() === 'db_storage'
                  ? path.dirname(normalized)
                  : '';
        const fileInsideDbStorageParent = path.basename(parentDir).toLowerCase() === 'db_storage'
                  ? path.dirname(parentDir)
                  : '';
        const candidateBases = Array.from(new Set([
                  normalized,
                  parentDir,
                  path.join(normalized, 'WeChat Files'),
                  path.join(parentDir, 'WeChat Files'),
                  dbStorageParent,
                  fileInsideDbStorageParent
                ].filter(Boolean)));
        const lowerWxid = cleanedWxid.toLowerCase();
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
                };
        for (const candidateBase of candidateBases) {
          const resolved = tryResolveBase(candidateBase)
          if (resolved) return resolved
        }

        return null
    }

    private resolveFileAttachmentSearchRoots(): FileAttachmentSearchRoot[] {
        const dbPath = this.getConfiguredDbPath();
        const rawWxid = this.getConfiguredMyWxid();
        const cleanedWxid = this.cleanAccountDirName(rawWxid);
        if (!dbPath) return []
        const normalized = path.resolve(dbPath.replace(/[\\/]+$/, ''));
        const accountDirs = new Set<string>();
        const maybeAddAccountDir = (candidate: string | null | undefined) => {
                  if (!candidate) return
                  const resolved = path.resolve(candidate)
                  if (this.isFileAttachmentAccountDir(resolved)) {
                    accountDirs.add(resolved)
                  }
                };
        maybeAddAccountDir(normalized)
        maybeAddAccountDir(path.dirname(normalized))
        const wxidCandidates = Array.from(new Set([cleanedWxid, rawWxid].filter(Boolean)));
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
        const raw = Number(createTime);
        if (!Number.isFinite(raw) || raw <= 0) return []
        const ts = raw > 1e12 ? raw : raw * 1000;
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) return []
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        return [`${y}-${m}`]
    }

    private async verifyFileHash(sourcePath: string, expectedMd5?: string): Promise<boolean> {
        const normalizedExpected = String(expectedMd5 || '').trim().toLowerCase();
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
        const normalizedName = String(fileName || '').trim().toLowerCase();
        if (!rootDir || !normalizedName) return []
        const matches: string[] = [];
        const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
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

    private logFileAttachmentEvent(level: 'warn' | 'error', action: string, msg: any, extra: Record<string, unknown> = {}): void {
        const logger = level === 'error' ? console.error : console.warn;
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
        const fileName = String(msg?.fileName || '').trim();
        if (!fileName) return []
        const roots = this.resolveFileAttachmentSearchRoots();
        if (roots.length === 0) return []
        const normalizedMd5 = String(msg?.fileMd5 || '').trim().toLowerCase();
        const preferredMonths = new Set(this.buildPreferredFileYearMonths(msg?.createTime));
        const candidates: FileExportCandidate[] = [];
        const seen = new Set<string>();
        let searchOrder = 0;
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
                };
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

    private async exportFileAttachment(msg: any, mediaRootDir: string, mediaRelativePrefix: string, maxFileSizeMb?: number, dirCache?: Set<string>, control?: ExportTaskControl, options?: Pick<ExportOptions, 'exportConflictStrategy'>): Promise<MediaExportItem | null> {
        try {
          const fileNameRaw = String(msg?.fileName || '').trim()
          if (!fileNameRaw) return null

          const fileExtDir = resolveFileAttachmentExtensionDir(msg, fileNameRaw)
          const fileDir = path.join(mediaRootDir, mediaRelativePrefix, 'file', fileExtDir)
          await ensureExportDir(fileDir, control, dirCache)

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

          let destFileName = path.basename(fileNameRaw).replace(/[\\/:*?"<>|]/g, '_') || 'file'
          let destPath = path.join(fileDir, destFileName)
          if (this.resolveExportConflictStrategy(options) === 'rename') {
            destPath = await reserveUniqueOutputPath(destPath, new Set<string>())
            destFileName = path.basename(destPath)
          }
          const existedBeforeCopy = await pathExists(destPath)
          if (existedBeforeCopy && this.shouldReuseExistingExportFile(options)) {
            this.noteMediaTelemetry({ doneFiles: 1, dedupReuseFiles: 1 })
            return {
              relativePath: path.posix.join(mediaRelativePrefix, 'file', fileExtDir, destFileName),
              kind: 'file'
            }
          }

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
        const normalized = normalizeAppMessageContent(content);
        const rawLat = extractXmlAttribute(normalized, 'location', 'x') || extractXmlAttribute(normalized, 'location', 'latitude');
        const rawLng = extractXmlAttribute(normalized, 'location', 'y') || extractXmlAttribute(normalized, 'location', 'longitude');
        const locationPoiname = extractXmlAttribute(normalized, 'location', 'poiname') ||
                  extractXmlValue(normalized, 'poiname') ||
                  extractXmlValue(normalized, 'poiName');
        const locationLabel = extractXmlAttribute(normalized, 'location', 'label') ||
                  extractXmlValue(normalized, 'label');
        const meta: {
              locationLat?: number
              locationLng?: number
              locationPoiname?: string
              locationLabel?: string
            } = {};
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

    public getMediaLayout(outputPath: string, options: ExportOptions): {
        exportMediaEnabled: boolean
        mediaRootDir: string
        mediaRelativePrefix: string
        } {
        const exportMediaEnabled = this.isMediaExportEnabled(options);
        const outputDir = path.dirname(outputPath);
        const writeLayout = this.resolveExportWriteLayout(options);
        if (writeLayout === 'A' && path.basename(outputDir) === 'texts') {
          return {
            exportMediaEnabled,
            mediaRootDir: outputDir,
            mediaRelativePrefix: '..'
          }
        }

        const outputBaseName = path.basename(outputPath, path.extname(outputPath));
        const useSharedMediaLayout = options.sessionLayout === 'shared';
        const mediaRelativePrefix = useSharedMediaLayout
                  ? path.posix.join('media', outputBaseName)
                  : 'media';
        return { exportMediaEnabled, mediaRootDir: outputDir, mediaRelativePrefix }
    }

    public async resolveWeliveRawMediaItem(msg: any, mediaRootDir: string, mediaRelativePrefix: string, options: ExportOptions, control?: ExportTaskControl): Promise<MediaExportItem | null> {
        if (!this.isWeliveRawExportMode()) return null
        const sourcePathRaw = this.resolveWeliveMediaPath(msg)
        const localType = Number(msg?.localType || msg?.local_type || 0)
        const mediaType = String(msg?.mediaType || msg?.media_type || '').trim().toLowerCase()

        let kind: MediaExportItem['kind'] | null = null
        if ((mediaType === 'image' || localType === 3) && options.exportImages) {
          kind = 'image'
        } else if ((mediaType === 'voice' || localType === 34) && options.exportVoices) {
          kind = 'voice'
        } else if ((mediaType === 'emoji' || localType === 47) && options.exportEmojis) {
          kind = 'emoji'
        } else if ((mediaType === 'video' || localType === 43) && options.exportVideos) {
          kind = 'video'
        } else if ((mediaType === 'file' || this.isFileAppMessage(msg)) && options.exportFiles) {
          kind = 'file'
        }
        if (!kind) return null
        if (!sourcePathRaw) {
          return null
        }
        if (/^https?:\/\//i.test(sourcePathRaw)) {
          return { relativePath: sourcePathRaw, kind }
        }

        const sourcePath = path.resolve(sourcePathRaw)
        const mediaBaseDir = path.resolve(path.join(mediaRootDir, mediaRelativePrefix))
        const relativeFromBase = path.relative(mediaBaseDir, sourcePath)
        if (relativeFromBase.startsWith('..') || path.isAbsolute(relativeFromBase)) return null
        const relativePath = path.relative(mediaRootDir, sourcePath).split(path.sep).join('/')
        return relativePath ? { relativePath, kind } : null
    }

    public async preloadWeliveRawEmojiMedia(
      _messages: any[],
      _mediaCache: Map<string, MediaExportItem | null>,
      _mediaRootDir: string,
      _mediaRelativePrefix: string,
      _options: ExportOptions,
      _control?: ExportTaskControl,
      _onProgress?: (progress: ExportProgress) => void,
      _sessionName = '',
      _progressCurrent = 25
    ): Promise<void> {
        // WeLive raw export owns media resolution. Weflow must not scan/copy original media here.
    }

    public collectMediaMessagesForExport(messages: any[], options: ExportOptions): any[] {
        if (!this.isMediaExportEnabled(options)) return []
        if (this.isWeliveRawExportMode()) return []
        return messages.filter((msg) => {
          const localType = Number(msg?.localType || 0)
          return (localType === 3 && options.exportImages) ||
            (localType === 47 && options.exportEmojis) ||
            (localType === 43 && options.exportVideos) ||
            (localType === 34 && options.exportVoices) ||
            (options.exportFiles === true && this.isFileAppMessage(msg))
        })
    }

    public getMediaDoneFilesCount(): number {
        return this.mediaExportTelemetry?.doneFiles ?? 0
    }

    public formatMediaPhaseLabel(processed: number, total: number, beforeDoneFiles: number): string {
        const safeProcessed = Math.max(0, Math.floor(processed || 0));
        const safeTotal = Math.max(0, Math.floor(total || 0));
        const writtenNow = Math.max(0, this.getMediaDoneFilesCount() - Math.max(0, Math.floor(beforeDoneFiles || 0)));
        return `导出媒体 ${Math.min(safeProcessed, safeTotal)}/${safeTotal}（已写入 ${writtenNow}）`
    }

    public buildFileOnlyExportFailure(options: ExportOptions, mediaMessages: any[], beforeDoneFiles: number): { success: boolean; error?: string } | null {
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

    private async collectMessagesFromWeliveRaw(sessionId: string, cleanedMyWxid: string, dateRange?: { start: number; end: number } | null, senderUsernameFilter?: string, targetMediaTypes?: Set<number>, control?: ExportTaskControl, onCollectProgress?: (payload: { fetched: number; done?: boolean }) => void): Promise<{ rows: any[]; memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>; firstTime: number | null; lastTime: number | null; error?: string } | null> {
        const rawPath = this.weliveRawExportPaths.get(sessionId)
        if (!rawPath) return null
        if (!await pathExists(rawPath)) {
          return {
            rows: [],
            memberSet: new Map(),
            firstTime: null,
            lastTime: null,
            error: `WeLive 原始导出文件不存在: ${rawPath}`
          }
        }

        const readline = await import('readline')
        const rows: any[] = []
        const senderSet = new Set<string>()
        let firstTime: number | null = null
        let lastTime: number | null = null
        const normalizedDateRange = normalizeExportDateRange(dateRange)
        const normalizedSenderUsernameFilter = String(senderUsernameFilter || '').trim()
        const mediaTypeFilter = targetMediaTypes && targetMediaTypes.size > 0 ? targetMediaTypes : null
        const fileOnlyMediaFilter = this.isFileOnlyMediaFilter(mediaTypeFilter)
        const input = fs.createReadStream(rawPath, { encoding: 'utf8' })
        const rl = readline.createInterface({ input, crlfDelay: Infinity })
        let lineIndex = 0

        try {
          for await (const line of rl) {
            if ((lineIndex++ & 0x7f) === 0) this.throwIfStopRequested(control)
            const text = String(line || '').trim()
            if (!text) continue

            let row: any
            try {
              row = JSON.parse(text)
            } catch (error) {
              return {
                rows,
                memberSet: new Map(),
                firstTime,
                lastTime,
                error: `WeLive 原始导出第 ${lineIndex} 行 JSON 解析失败: ${String(error)}`
              }
            }

            const createTime = getTimestampSecondsFromRow(row)
            if (normalizedDateRange) {
              if (createTime > 0 && normalizedDateRange.start > 0 && createTime < normalizedDateRange.start) continue
              if (createTime > 0 && normalizedDateRange.end > 0 && createTime > normalizedDateRange.end) continue
            }

            const localType = this.getIntFromRow(row, [
              'local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'
            ], 1)
            const content = this.getRowField(row, [
              'message_content', 'messageContent', 'msg_content', 'msgContent', 'strContent', 'content', 'WCDB_CT_message_content'
            ]) ?? ''
            const rowFileHints = this.getFileAppMessageHints(row)
            const allowFileProbe = fileOnlyMediaFilter && this.hasFileAppMessageHints(row)
            if (mediaTypeFilter && !mediaTypeFilter.has(localType) && !allowFileProbe) continue

            const isSendRaw = row.computed_is_send ?? row.is_send ?? row.isSend ?? '0'
            const isSend = parseInt(String(isSendRaw), 10) === 1 || isSendRaw === true
            const senderUsername = String(row.sender_username ?? row.senderUsername ?? row.talker ?? '').trim()
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              const revokeInfo = this.extractRevokerInfo(String(content || ''))
              if (revokeInfo.isRevoke) {
                actualSender = revokeInfo.isSelfRevoke
                  ? cleanedMyWxid
                  : (revokeInfo.revokerWxid || sessionId)
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }

            if (normalizedSenderUsernameFilter && !isSameWxid(actualSender, normalizedSenderUsernameFilter)) continue

            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let videoMd5: string | undefined
            let locationLat: number | undefined
            let locationLng: number | undefined
            let locationPoiname: string | undefined
            let locationLabel: string | undefined
            let chatRecordList: any[] | undefined
            let xmlType = rowFileHints.xmlType
            let fileName = rowFileHints.fileName
            let fileSize = rowFileHints.fileSize
            let fileExt = rowFileHints.fileExt
            let fileMd5 = rowFileHints.fileMd5

            if (localType === 48 && content) {
              const locationMeta = this.extractLocationMeta(String(content), localType)
              if (locationMeta) {
                locationLat = locationMeta.locationLat
                locationLng = locationMeta.locationLng
                locationPoiname = locationMeta.locationPoiname
                locationLabel = locationMeta.locationLabel
              }
            }

            if (localType === 47) {
              emojiCdnUrl = String(row.emoji_cdn_url || row.emojiCdnUrl || '').trim() || undefined
              emojiMd5 = this.normalizeEmojiMd5(row.emoji_md5 || row.emojiMd5) || undefined
              if (content) {
                emojiCdnUrl = emojiCdnUrl || this.extractEmojiUrl(String(content))
                emojiMd5 = emojiMd5 || this.normalizeEmojiMd5(this.extractEmojiMd5(String(content)))
              }
            }

            imageMd5 = String(row.image_md5 || row.imageMd5 || '').trim() || undefined
            imageDatName = localType === 3 ? this.extractImageDatNameFromRow(row, String(content || '')) : undefined
            videoMd5 = this.extractVideoFileNameFromRow(row, String(content || ''))
            if (content && (this.isFileAppLocalType(localType) || allowFileProbe || this.hasFileAppMessageHints({ xmlType, fileName, fileSize, fileExt, fileMd5 }))) {
              const fileMeta = this.extractFileAppMessageMeta(String(content))
              if (fileMeta) {
                xmlType = fileMeta.xmlType || xmlType
                fileName = fileMeta.fileName || fileName
                fileSize = fileMeta.fileSize || fileSize
                fileExt = fileMeta.fileExt || fileExt
                fileMd5 = fileMeta.fileMd5 || fileMd5
              }
            }
            if (localType === 3 && content) {
              imageMd5 = imageMd5 || this.extractImageMd5(String(content))
              imageDatName = imageDatName || this.extractImageDatNameFromRow(row, String(content))
            } else if (localType === 43 && content) {
              videoMd5 = videoMd5 || this.extractVideoFileNameFromRow(row, String(content))
            } else if (content && (localType === 49 || String(content).includes('<appmsg') || String(content).includes('&lt;appmsg'))) {
              const normalizedContent = normalizeAppMessageContent(String(content))
              const appType = extractAppMessageType(normalizedContent)
              if (appType === '19') chatRecordList = parseChatHistory(normalizedContent)
            }

            if (fileOnlyMediaFilter && !this.isFileAppMessage({ localType, xmlType, content, fileName, fileExt, fileMd5, fileSize })) continue

            senderSet.add(actualSender)
            rows.push({
              sessionId,
              session_id: sessionId,
              localId: this.getIntFromRow(row, ['local_id', 'localId', 'LocalId', 'msg_local_id', 'msgLocalId', 'MsgLocalId', 'msg_id', 'msgId', 'MsgId', 'id', 'WCDB_CT_local_id'], 0),
              serverId: this.getIntFromRow(row, ['server_id', 'serverId', 'ServerId', 'msg_server_id', 'msgServerId', 'MsgServerId', 'svr_id', 'svrId', 'msg_svr_id', 'msgSvrId', 'MsgSvrId', 'WCDB_CT_server_id'], 0),
              serverIdRaw: this.normalizeUnsignedIntToken(this.getRowField(row, ['server_id', 'serverId', 'ServerId', 'msg_server_id', 'msgServerId', 'MsgServerId', 'svr_id', 'svrId', 'msg_svr_id', 'msgSvrId', 'MsgSvrId', 'WCDB_CT_server_id'])) || undefined,
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
              xmlType,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              mediaPath: this.resolveWeliveMediaPath(row) || undefined,
              mediaType: String(row.media_type || row.mediaType || '').trim() || undefined,
              mediaError: String(row.media_error || row.mediaError || '').trim() || undefined,
              locationLat,
              locationLng,
              locationPoiname,
              locationLabel,
              chatRecordList
            })
            if (firstTime === null || createTime < firstTime) firstTime = createTime
            if (lastTime === null || createTime > lastTime) lastTime = createTime
            if (rows.length % 1000 === 0) {
              onCollectProgress?.({ fetched: rows.length })
            }
          }
          onCollectProgress?.({ fetched: rows.length, done: true })
        } finally {
          rl.close()
          input.destroy()
        }

        const memberSet = new Map<string, { member: ChatLabMember; avatarUrl?: string }>()
        if (senderSet.size > 0) {
          const usernames = Array.from(senderSet)
          for (const username of usernames) {
            const displayName = username
            const avatarUrl = undefined
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

    public async collectMessages(sessionId: string, cleanedMyWxid: string, dateRange?: { start: number; end: number } | null, senderUsernameFilter?: string, collectMode: MessageCollectMode = 'full', targetMediaTypes?: Set<number>, control?: ExportTaskControl, onCollectProgress?: (payload: { fetched: number; done?: boolean }) => void, _legacyCursorFallbackFlag = true, allowRangeFallback = true, useCursorTimeRange = true, allowModeFallback = true): Promise<{ rows: any[]; memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>; firstTime: number | null; lastTime: number | null; error?: string }> {
        const weliveCollected = await this.collectMessagesFromWeliveRaw(
          sessionId,
          cleanedMyWxid,
          dateRange,
          senderUsernameFilter,
          targetMediaTypes,
          control,
          onCollectProgress
        )
        if (weliveCollected) {
          // WeLive 原始数据收集报错（文件缺失 / JSONL 解析失败）意味着数据不完整。
          // 调用方（各 formatter）不会检查 error 字段，这里必须直接抛错让会话导出失败，
          // 禁止把截断或空结果当作成功输出（issue #1129 的 WeFlow 侧防线）。
          if (weliveCollected.error) {
            throw new Error(`WeLive 原始导出数据不完整: ${weliveCollected.error}`)
          }
          return weliveCollected
        }

        const rows: any[] = [];
        const memberSet = new Map<string, { member: ChatLabMember; avatarUrl?: string }>();
        const senderSet = new Set<string>();
        let firstTime: number | null = null;
        let lastTime: number | null = null;
        const mediaTypeFilter = targetMediaTypes && targetMediaTypes.size > 0
                  ? targetMediaTypes
                  : null;
        const fileOnlyMediaFilter = this.isFileOnlyMediaFilter(mediaTypeFilter);
        const normalizedDateRange = normalizeExportDateRange(dateRange);
        const normalizedSenderUsernameFilter = String(senderUsernameFilter || '').trim();
        const beginTime = useCursorTimeRange ? (normalizedDateRange?.start || 0) : 0;
        const endTime = useCursorTimeRange ? (normalizedDateRange?.end || 0) : 0;
        const batchSize = (collectMode === 'text-fast' || collectMode === 'media-fast') ? 2000 : 500;
        this.throwIfStopRequested(control)
        const fastMediaType = this.resolveFastMediaStreamType(collectMode, mediaTypeFilter);
        let usedFastMediaStream = false;
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
          const cursor = await wcdbService.openMessageCursor(
            sessionId,
            batchSize,
            false,
            beginTime,
            endTime
          )
          if (!cursor.success || !cursor.cursor) {
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

              const localType = this.getIntFromRow(row, [
                'local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'
              ], 1)
              const rowFileHints = collectMode === 'text-fast'
                ? {}
                : this.getFileAppMessageHints(row)
              const allowFileProbe = collectMode !== 'text-fast' && fileOnlyMediaFilter && this.hasFileAppMessageHints(row)
              if (mediaTypeFilter && !mediaTypeFilter.has(localType) && !allowFileProbe) {
                continue
              }
              const shouldDecodeContent = collectMode === 'full'
                || (collectMode === 'text-fast' && this.shouldDecodeMessageContentInFastMode(localType))
                || (collectMode === 'media-fast' && this.shouldDecodeMessageContentInMediaMode(localType, mediaTypeFilter, { allowFileProbe }))
              const content = shouldDecodeContent
                ? decodeMessageContent(row.message_content, row.compress_content)
                : ''
              const senderUsername = row.sender_username || ''
              const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
              const isSend = parseInt(isSendRaw, 10) === 1
              const localId = this.getIntFromRow(row, [
                'local_id', 'localId', 'LocalId',
                'msg_local_id', 'msgLocalId', 'MsgLocalId',
                'msg_id', 'msgId', 'MsgId', 'id',
                'WCDB_CT_local_id'
              ], 0)
              const rawServerIdValue = this.getRowField(row, [
                'server_id', 'serverId', 'ServerId',
                'msg_server_id', 'msgServerId', 'MsgServerId',
                'svr_id', 'svrId', 'msg_svr_id', 'msgSvrId', 'MsgSvrId',
                'WCDB_CT_server_id'
              ])
              const serverIdRaw = this.normalizeUnsignedIntToken(rawServerIdValue)
              const serverId = this.getIntFromRow(row, [
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

              if (normalizedSenderUsernameFilter && !isSameWxid(actualSender, normalizedSenderUsernameFilter)) {
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
                emojiMd5 = this.normalizeEmojiMd5(row.emoji_md5 || row.emojiMd5) || undefined
                const packedInfoRaw = String(row.packed_info || row.packedInfo || row.PackedInfo || '')
                const reserved0Raw = String(row.reserved0 || row.Reserved0 || '')
                const supplementalPayload = `${decodeMaybeCompressed(packedInfoRaw)}\n${decodeMaybeCompressed(reserved0Raw)}`
                if (content) {
                  emojiCdnUrl = emojiCdnUrl || this.extractEmojiUrl(content)
                  emojiMd5 = emojiMd5 || this.normalizeEmojiMd5(this.extractEmojiMd5(content))
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

                if (content && (this.isFileAppLocalType(localType) || allowFileProbe || this.hasFileAppMessageHints({ xmlType, fileName, fileSize, fileExt, fileMd5 }))) {
                  const fileMeta = this.extractFileAppMessageMeta(content)
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
                  imageDatName = imageDatName || this.extractImageDatNameFromRow(row, content)
                } else if (localType === 43 && content) {
                  // 视频消息
                  videoMd5 = videoMd5 || this.extractVideoFileNameFromRow(row, content)
                } else if (collectMode === 'full' && content && (localType === 49 || content.includes('<appmsg') || content.includes('&lt;appmsg'))) {
                  // 检查是否是聊天记录消息（type=19），兼容大 localType 的 appmsg
                  const normalizedContent = normalizeAppMessageContent(content)
                  const xmlType = extractAppMessageType(normalizedContent)
                  if (xmlType === '19') {
                    chatRecordList = parseChatHistory(normalizedContent)
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
            if (this.isStopError(err)) throw err
            console.error(`[Export] 收集消息异常:`, err)
          } finally {
            try {
              await wcdbService.closeMessageCursor(cursor.cursor)
            } catch (err) {
              console.error(`[Export] 关闭游标失败:`, err)
            }
          }
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
            _legacyCursorFallbackFlag,
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

    public async buildNoMessagesError(sessionId: string, collected: { error?: string }, fallback = '该会话在指定时间范围内没有消息'): Promise<string> {
        if (collected.error) return collected.error
        const nativeLogSummary = await this.getRecentWcdbCursorLogSummary(sessionId);
        if (!nativeLogSummary) return fallback
        return `${fallback}；WCDB日志：${nativeLogSummary}`
    }

    private async backfillMediaFieldsFromMessageDetail(sessionId: string, rows: any[], targetMediaTypes: Set<number>, control?: ExportTaskControl, options?: { force?: boolean }): Promise<void> {
        const force = options?.force === true;
        const fileOnlyMediaFilter = this.isFileOnlyMediaFilter(targetMediaTypes);
        const needsBackfill = rows.filter((msg) => {
                  if (force) {
                    return Number(msg?.localId || 0) > 0
                  }
                  const isFileCandidate = this.isFileAppLocalType(Number(msg.localType || 0)) || (fileOnlyMediaFilter && this.hasFileAppMessageHints(msg))
                  if (isFileCandidate) {
                    return !msg.xmlType || !msg.fileName || !msg.fileMd5 || !msg.fileSize || !msg.fileExt
                  }
                  if (!targetMediaTypes.has(msg.localType)) return false
                  if (msg.localType === 3) return !msg.imageMd5 || !msg.imageDatName
                  if (msg.localType === 47) return !msg.emojiMd5
                  if (msg.localType === 43) return !msg.videoMd5
                  return false
                });
        if (needsBackfill.length === 0) return
        const DETAIL_CONCURRENCY = 6;
        await parallelLimit(needsBackfill, DETAIL_CONCURRENCY, async (msg) => {
          this.throwIfStopRequested(control)
          const localId = Number(msg.localId || 0)
          if (!Number.isFinite(localId) || localId <= 0) return

          try {
            const detail = await wcdbService.getMessageById(sessionId, localId)
            if (!detail.success || !detail.message) return

            const row = detail.message as any
            const rawMessageContent = this.getRowField(row, [
              'message_content', 'messageContent', 'msg_content', 'msgContent', 'strContent', 'content', 'WCDB_CT_message_content'
            ]) ?? ''
            const rawCompressContent = this.getRowField(row, [
              'compress_content', 'compressContent', 'msg_compress_content', 'msgCompressContent', 'WCDB_CT_compress_content'
            ]) ?? ''
            const content = decodeMessageContent(rawMessageContent, rawCompressContent)
            const packedInfoRaw = this.getRowField(row, ['packed_info', 'packedInfo', 'PackedInfo', 'WCDB_CT_packed_info']) ?? ''
            const reserved0Raw = this.getRowField(row, ['reserved0', 'Reserved0', 'WCDB_CT_Reserved0']) ?? ''
            const supplementalPayload = `${decodeMaybeCompressed(String(packedInfoRaw || ''))}\n${decodeMaybeCompressed(String(reserved0Raw || ''))}`

            if (msg.localType === 3) {
              const imageMd5 = (String(row.image_md5 || row.imageMd5 || '').trim() || this.extractImageMd5(content) || '').toLowerCase()
              const imageDatName = this.extractImageDatNameFromRow(row, content) || ''
              if (imageMd5) msg.imageMd5 = imageMd5
              if (imageDatName) msg.imageDatName = imageDatName
              return
            }

            if (msg.localType === 47) {
              const emojiMd5 =
                this.normalizeEmojiMd5(row.emoji_md5 || row.emojiMd5) ||
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

            if (this.isFileAppLocalType(Number(msg.localType || 0)) || this.hasFileAppMessageHints(msg)) {
              const rowFileHints = this.getFileAppMessageHints(row)
              const fileMeta = this.extractFileAppMessageMeta(content)
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

    public async mergeGroupMembers(chatroomId: string, memberSet: Map<string, { member: ChatLabMember; avatarUrl?: string }>, includeAvatars: boolean): Promise<void> {
        if (!await this.ensureContactMetadataConnected()) return
        const result = await wcdbService.getGroupMembers(chatroomId);
        if (!result.success || !result.members || result.members.length === 0) return
        const rawMembers = result.members as Array<{
                  username?: string
                  avatarUrl?: string
                  nickname?: string
                  displayName?: string
                  remark?: string
                  originalName?: string
                }>;
        const usernames = rawMembers
                  .map((member) => member.username)
                  .filter((username): username is string => Boolean(username));
        if (usernames.length === 0) return
        const lookupUsernames = new Set<string>();
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
                ]);
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

    public extractGroupSenderCountMap(groupStats: any, sessionId: string): Map<string, number> {
        const senderCountMap = new Map<string, number>();
        if (!groupStats || typeof groupStats !== 'object') return senderCountMap
        const sessions = (groupStats as any).sessions;
        const sessionStats = sessions && typeof sessions === 'object'
                  ? (sessions[sessionId] || sessions[String(sessionId)] || null)
                  : null;
        const senderRaw = (sessionStats && typeof sessionStats === 'object' && (sessionStats as any).senders && typeof (sessionStats as any).senders === 'object')
                  ? (sessionStats as any).senders
                  : ((groupStats as any).senders && typeof (groupStats as any).senders === 'object' ? (groupStats as any).senders : {});
        const idMap = (groupStats as any).idMap && typeof (groupStats as any).idMap === 'object'
                  ? (groupStats as any).idMap
                  : ((sessionStats && typeof sessionStats === 'object' && (sessionStats as any).idMap && typeof (sessionStats as any).idMap === 'object')
                    ? (sessionStats as any).idMap
                    : {});
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

    public sumSenderCountsByIdentity(senderCountMap: Map<string, number>, wxid: string): number {
        const target = String(wxid || '').trim();
        if (!target) return 0
        let total = 0;
        for (const [senderWxid, count] of senderCountMap.entries()) {
          if (!Number.isFinite(count) || count <= 0) continue
          if (isSameWxid(senderWxid, target)) {
            total += count
          }
        }

        return total
    }

    public async queryFriendFlagMap(usernames: string[]): Promise<Map<string, boolean>> {
        const result = new Map<string, boolean>();
        const unique = Array.from(
                  new Set((usernames || []).map((username) => String(username || '').trim()).filter(Boolean))
                );
        if (unique.length === 0) return result
        const query = await wcdbService.getContactFriendFlags(unique);
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

        const sourcePath = avatarUrl;
        const ext = path.extname(sourcePath) || '.jpg';
        return { sourcePath, ext }
    }

    private async downloadToBuffer(url: string, remainingRedirects = 2): Promise<{ data: Buffer; mime?: string } | null> {
        const client = url.startsWith('https:') ? https : http;
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

    public async exportAvatars(members: Array<{ username: string; avatarUrl?: string }>): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        if (members.length === 0) return result
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
    public async exportAvatarsToFiles(members: Array<{ username: string; avatarUrl?: string }>, outputDir: string, control?: ExportTaskControl): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        if (members.length === 0) return result
        const avatarsDir = path.join(outputDir, 'avatars');
        await ensureExportDir(avatarsDir, control)
        const AVATAR_CONCURRENCY = 8;
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
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
          return 'image/png'
        }

        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
          return 'image/jpeg'
        }

        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
          return 'image/gif'
        }

        if (buffer.length >= 12 &&
          buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
          buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
          return 'image/webp'
        }

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

    public getWeflowHeader(): { version: string; exportedAt: number; generator: string } {
        return {
          version: '1.0.3',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'WeFlow'
        }
    }

    /**
     * 生成通用的导出元数据 (参考 ChatLab 格式)
     */
    public getExportMeta(sessionId: string, sessionInfo: { displayName: string }, isGroup: boolean, sessionAvatar?: string): { chatlab: ChatLabHeader; meta: ChatLabMeta } {
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

    public async exportSessionToExcelStreaming(params: {
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
                } = params;
        try {
          const { mediaRootDir, mediaRelativePrefix } = this.getMediaLayout(outputPath, options)
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
          appendRow(['导出工具', 'WeFlow', '导出时间', formatTimestamp(Math.floor(Date.now() / 1000))])
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
                senderProfile = await resolveExportDisplayProfile(
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

            const mediaKey = this.getMediaCacheKey(msg)
            const mediaItem = mediaCache.has(mediaKey)
              ? mediaCache.get(mediaKey)
              : await this.resolveWeliveRawMediaItem(msg, mediaRootDir, mediaRelativePrefix, options, control)
            const shouldUseTranscript = msg.localType === 34 && options.exportVoiceAsText
            const mediaPathValue = !shouldUseTranscript && mediaItem?.relativePath
              ? this.formatExportMediaPath(mediaItem.relativePath, options, 'text')
              : undefined
            const contentValue = shouldUseTranscript
              ? this.formatPlainExportContent(
                msg.content,
                msg.localType,
                options,
                voiceTranscriptMap.get(this.getStableMessageKey(msg)),
                cleanedMyWxid,
                msg.senderUsername,
                msg.isSend,
                msg.emojiCaption
              )
              : (mediaPathValue
                || this.formatPlainExportContent(
                  msg.content,
                  msg.localType,
                  options,
                  voiceTranscriptMap.get(this.getStableMessageKey(msg)),
                  cleanedMyWxid,
                  msg.senderUsername,
                  msg.isSend,
                  msg.emojiCaption
                ))

            let enrichedContentValue = contentValue
            if (isTransferExportContent(contentValue) && msg.content) {
              const transferDesc = await resolveTransferDesc(
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
                enrichedContentValue = appendTransferDesc(contentValue, transferDesc)
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
                formatTimestamp(msg.createTime),
                senderRole,
                this.getMessageTypeName(msg.localType, msg.content),
                enrichedContentValue
              ]
              : includeGroupNicknameColumn
                ? [
                  i + 1,
                  formatTimestamp(msg.createTime),
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
                  formatTimestamp(msg.createTime),
                  senderNickname,
                  senderWxid,
                  senderRemark,
                  senderRole,
                  this.getMessageTypeName(msg.localType, msg.content),
                  enrichedContentValue
                ])
            if (!quotedReplyDisplay) {
              const contentCell = row.getCell(useCompactColumns ? 5 : (includeGroupNicknameColumn ? 9 : 8))
              const appliedMediaLink = mediaPathValue && enrichedContentValue === mediaPathValue
                ? this.applyExcelMediaLinkCell(contentCell, mediaItem, options)
                : false
              if (!appliedMediaLink) {
                this.applyExcelLinkCardCell(
                  contentCell,
                  msg.content,
                  msg.localType
                )
              }
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
          if (this.isStopError(e)) {
            return { success: false, error: '导出任务已停止' }
          }
          if (this.isPauseError(e)) {
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
    public async ensureVoiceModel(onProgress?: (progress: ExportProgress) => void): Promise<boolean> {
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

    public getVirtualScrollScript(): string {
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

    public getExportStatsDateRangeToken(dateRange?: { start: number; end: number } | null): string {
        const normalized = normalizeExportDateRange(dateRange);
        if (!normalized) return 'all'
        const start = normalized.start;
        const end = normalized.end;
        return `${start}-${end}`
    }

    public buildExportStatsCacheKey(sessionIds: string[], options: Pick<ExportOptions, 'dateRange' | 'senderUsername'>, cleanedWxid?: string): string {
        const normalizedIds = this.normalizeSessionIds(sessionIds).sort();
        const senderToken = String(options.senderUsername || '').trim();
        const dateToken = this.getExportStatsDateRangeToken(options.dateRange);
        const dbPath = this.getConfiguredDbPath();
        const wxidToken = String(cleanedWxid || this.cleanAccountDirName(this.getConfiguredMyWxid()) || '').trim();
        return `${dbPath}::${wxidToken}::${dateToken}::${senderToken}::${normalizedIds.join('\u001f')}`
    }

    public cloneExportStatsResult(result: ExportStatsResult): ExportStatsResult {
        return {
          ...result,
          sessions: result.sessions.map((item) => ({ ...item }))
        }
    }

    public pruneExportStatsCaches(): void {
        const now = Date.now();
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

    public getExportStatsCacheEntry(key: string): ExportStatsCacheEntry | null {
        this.pruneExportStatsCaches()
        const entry = this.exportStatsCache.get(key);
        if (!entry) return null
        if (Date.now() - entry.createdAt > this.exportStatsCacheTtlMs) {
          this.exportStatsCache.delete(key)
          return null
        }

        return entry
    }

    public setExportStatsCacheEntry(key: string, entry: ExportStatsCacheEntry): void {
        this.pruneExportStatsCaches()
        this.exportStatsCache.set(key, entry)
        if (this.exportStatsCache.size <= this.exportStatsCacheMaxEntries) return
        const staleKeys = Array.from(this.exportStatsCache.entries())
                  .sort((a, b) => a[1].createdAt - b[1].createdAt)
                  .slice(0, Math.max(0, this.exportStatsCache.size - this.exportStatsCacheMaxEntries))
                  .map(([cacheKey]) => cacheKey);
        for (const staleKey of staleKeys) {
          this.exportStatsCache.delete(staleKey)
        }
    }

    public getAggregatedSessionStatsCache(key: string): Record<string, ExportAggregatedSessionMetric> | null {
        this.pruneExportStatsCaches()
        const entry = this.exportAggregatedSessionStatsCache.get(key);
        if (!entry) return null
        if (Date.now() - entry.createdAt > this.exportAggregatedSessionStatsCacheTtlMs) {
          this.exportAggregatedSessionStatsCache.delete(key)
          return null
        }

        return entry.data
    }

    public setAggregatedSessionStatsCache(key: string, data: Record<string, ExportAggregatedSessionMetric>): void {
        this.pruneExportStatsCaches()
        this.exportAggregatedSessionStatsCache.set(key, {
          createdAt: Date.now(),
          data
        })
        if (this.exportAggregatedSessionStatsCache.size <= this.exportStatsCacheMaxEntries) return
        const staleKeys = Array.from(this.exportAggregatedSessionStatsCache.entries())
                  .sort((a, b) => a[1].createdAt - b[1].createdAt)
                  .slice(0, Math.max(0, this.exportAggregatedSessionStatsCache.size - this.exportStatsCacheMaxEntries))
                  .map(([cacheKey]) => cacheKey);
        for (const staleKey of staleKeys) {
          this.exportAggregatedSessionStatsCache.delete(staleKey)
        }
    }

    
}
