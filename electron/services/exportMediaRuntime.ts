import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'
import { copyFileOptimized, isHardlinkFallbackError, pathExists } from './exportServiceUtils'
import type { ConfigService } from './config'
import type { ExportProgress, ExportTaskControl, MediaExportTelemetry, MediaSourceResolution } from './exportServiceTypes'

export class ExportMediaRuntime {
  private mediaFileCachePopulatePending = new Map<string, Promise<string | null>>()
  private mediaFileCacheReadyDirs = new Set<string>()
  private mediaExportTelemetry: MediaExportTelemetry | null = null
  private mediaRunSourceDedupMap = new Map<string, string>()
  private mediaRunMissingImageKeys = new Set<string>()
  private activeChatImagePipelineCount = 0
  private chatImagePipelineWaiters: Array<() => void> = []
  private mediaFileCacheCleanupPending: Promise<void> | null = null
  private mediaFileCacheLastCleanupAt = 0
  private readonly mediaFileCacheCleanupIntervalMs = 30 * 60 * 1000
  private readonly mediaFileCacheMaxBytes = 6 * 1024 * 1024 * 1024
  private readonly mediaFileCacheMaxFiles = 120000
  private readonly mediaFileCacheTtlMs = 45 * 24 * 60 * 60 * 1000

  constructor(private readonly configService: ConfigService) {}

  hasMissingImageRunCacheKey(key: string): boolean {
    return this.mediaRunMissingImageKeys.has(key)
  }

  addMissingImageRunCacheKey(key: string): void {
    this.mediaRunMissingImageKeys.add(key)
  }

  getMediaDoneFilesCount(): number {
    return this.mediaExportTelemetry?.doneFiles ?? 0
  }

  getMediaFileCacheRoot(): string {
    return path.join(this.configService.getCacheBasePath(), 'export-media-files')
  }


  createEmptyMediaTelemetry(): MediaExportTelemetry {
    return {
      doneFiles: 0,
      cacheHitFiles: 0,
      cacheMissFiles: 0,
      cacheFillFiles: 0,
      dedupReuseFiles: 0,
      bytesWritten: 0
    }
  }


  resetMediaRuntimeState(): void {
    this.mediaExportTelemetry = this.createEmptyMediaTelemetry()
    this.mediaRunSourceDedupMap.clear()
    this.mediaRunMissingImageKeys.clear()
  }


  clearMediaRuntimeState(): void {
    this.mediaExportTelemetry = null
    this.mediaRunSourceDedupMap.clear()
    this.mediaRunMissingImageKeys.clear()
  }


  async runWithChatImagePipelineLimit<T>(fn: () => Promise<T>): Promise<T> {
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


  getMediaTelemetrySnapshot(): Partial<ExportProgress> {
    const stats = this.mediaExportTelemetry
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


  noteMediaTelemetry(delta: Partial<MediaExportTelemetry>): void {
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


  async ensureMediaFileCacheDir(dirPath: string): Promise<void> {
    if (this.mediaFileCacheReadyDirs.has(dirPath)) return
    await fs.promises.mkdir(dirPath, { recursive: true })
    this.mediaFileCacheReadyDirs.add(dirPath)
  }


  async getMediaFileStat(sourcePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const stat = await fs.promises.stat(sourcePath)
      if (!stat.isFile()) return null
      return {
        size: Number.isFinite(stat.size) ? Math.max(0, Math.floor(stat.size)) : 0,
        mtimeMs: Number.isFinite(stat.mtimeMs) ? Math.max(0, Math.floor(stat.mtimeMs)) : 0
      }
    } catch {
      return null
    }
  }


  buildMediaFileCachePath(
    kind: 'image' | 'video' | 'emoji',
    sourcePath: string,
    fileStat: { size: number; mtimeMs: number }
  ): string {
    const normalizedSource = path.resolve(sourcePath)
    const rawKey = `${kind}\u001f${normalizedSource}\u001f${fileStat.size}\u001f${fileStat.mtimeMs}`
    const digest = crypto.createHash('sha1').update(rawKey).digest('hex')
    const ext = path.extname(normalizedSource) || ''
    return path.join(this.getMediaFileCacheRoot(), kind, digest.slice(0, 2), `${digest}${ext}`)
  }


  async resolveMediaFileCachePath(
    kind: 'image' | 'video' | 'emoji',
    sourcePath: string
  ): Promise<{ cachePath: string; fileStat: { size: number; mtimeMs: number } } | null> {
    const fileStat = await this.getMediaFileStat(sourcePath)
    if (!fileStat) return null
    const cachePath = this.buildMediaFileCachePath(kind, sourcePath, fileStat)
    return { cachePath, fileStat }
  }


  async populateMediaFileCache(
    kind: 'image' | 'video' | 'emoji',
    sourcePath: string
  ): Promise<string | null> {
    const resolved = await this.resolveMediaFileCachePath(kind, sourcePath)
    if (!resolved) return null
    const { cachePath } = resolved
    if (await pathExists(cachePath)) return cachePath

    const pending = this.mediaFileCachePopulatePending.get(cachePath)
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
    })()

    this.mediaFileCachePopulatePending.set(cachePath, task)
    return task
  }


  async resolvePreferredMediaSource(
    kind: 'image' | 'video' | 'emoji',
    sourcePath: string
  ): Promise<MediaSourceResolution> {
    const resolved = await this.resolveMediaFileCachePath(kind, sourcePath)
    if (!resolved) {
      return {
        sourcePath,
        cacheHit: false
      }
    }
    const dedupeKey = `${kind}\u001f${resolved.cachePath}`
    if (await pathExists(resolved.cachePath)) {
      return {
        sourcePath: resolved.cachePath,
        cacheHit: true,
        cachePath: resolved.cachePath,
        fileStat: resolved.fileStat,
        dedupeKey
      }
    }
    // 未命中缓存时异步回填，不阻塞当前导出路径
    void this.populateMediaFileCache(kind, sourcePath)
    return {
      sourcePath,
      cacheHit: false,
      cachePath: resolved.cachePath,
      fileStat: resolved.fileStat,
      dedupeKey
    }
  }


  async hardlinkOrCopyFile(sourcePath: string, destPath: string): Promise<{ success: boolean; code?: string; linked?: boolean }> {
    try {
      await fs.promises.link(sourcePath, destPath)
      return { success: true, linked: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EEXIST') {
        return { success: true, linked: true }
      }
      if (!isHardlinkFallbackError(code)) {
        return { success: false, code }
      }
    }

    const copied = await copyFileOptimized(sourcePath, destPath)
    if (!copied.success) return copied
    return { success: true, linked: false }
  }


  async copyMediaWithCacheAndDedup(
    kind: 'image' | 'video' | 'emoji',
    sourcePath: string,
    destPath: string,
    control?: ExportTaskControl
  ): Promise<{ success: boolean; code?: string }> {
    const existedBeforeCopy = await pathExists(destPath)
    const resolved = await this.resolvePreferredMediaSource(kind, sourcePath)
    if (resolved.cacheHit) {
      this.noteMediaTelemetry({ cacheHitFiles: 1 })
    } else {
      this.noteMediaTelemetry({ cacheMissFiles: 1 })
    }

    const dedupeKey = resolved.dedupeKey
    if (dedupeKey) {
      const reusedPath = this.mediaRunSourceDedupMap.get(dedupeKey)
      if (reusedPath && reusedPath !== destPath && await pathExists(reusedPath)) {
        const reused = await this.hardlinkOrCopyFile(reusedPath, destPath)
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
      ? await this.hardlinkOrCopyFile(resolved.sourcePath, destPath)
      : await copyFileOptimized(resolved.sourcePath, destPath)
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


  triggerMediaFileCacheCleanup(force = false): void {
    const now = Date.now()
    if (!force && now - this.mediaFileCacheLastCleanupAt < this.mediaFileCacheCleanupIntervalMs) return
    if (this.mediaFileCacheCleanupPending) return
    this.mediaFileCacheLastCleanupAt = now

    this.mediaFileCacheCleanupPending = this.cleanupMediaFileCache().finally(() => {
      this.mediaFileCacheCleanupPending = null
    })
  }


  async cleanupMediaFileCache(): Promise<void> {
    const root = this.getMediaFileCacheRoot()
    if (!await pathExists(root)) return
    const now = Date.now()
    const files: Array<{ filePath: string; size: number; mtimeMs: number }> = []
    const dirs: string[] = []

    const stack = [root]
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

    let totalBytes = files.reduce((sum, item) => sum + item.size, 0)
    let totalFiles = files.length
    const ttlThreshold = now - this.mediaFileCacheTtlMs
    const removalSet = new Set<string>()

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


}
