import { app, BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, appendFileSync } from 'fs'
import { writeFile, rm, readdir } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import crypto from 'crypto'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { decryptDatViaNative, nativeAddonLocation } from './nativeImageDecrypt'

// 获取 ffmpeg-static 的路径
function getStaticFfmpegPath(): string | null {
  try {
    // 方法1: 直接 require ffmpeg-static
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static')

    if (typeof ffmpegStatic === 'string') {
      // 修复：如果路径包含 app.asar（打包后），自动替换为 app.asar.unpacked
      let fixedPath = ffmpegStatic
      if (fixedPath.includes('app.asar') && !fixedPath.includes('app.asar.unpacked')) {
        fixedPath = fixedPath.replace('app.asar', 'app.asar.unpacked')
      }

      if (existsSync(fixedPath)) {
        return fixedPath
      }
    }

    // 方法2: 手动构建路径（开发环境）
    const devPath = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
    if (existsSync(devPath)) {
      return devPath
    }

    // 方法3: 打包后的路径
    if (app?.isPackaged) {
      const resourcesPath = process.resourcesPath
      const packedPath = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
      if (existsSync(packedPath)) {
        return packedPath
      }
    }

    return null
  } catch {
    return null
  }
}

type DecryptResult = {
  success: boolean
  localPath?: string
  error?: string
  failureKind?: 'not_found' | 'decrypt_failed'
  isThumb?: boolean  // 是否是缩略图（没有高清图时返回缩略图）
}

type DecryptProgressStage = 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'

type CachedImagePayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number
  preferFilePath?: boolean
  hardlinkOnly?: boolean
  disableUpdateCheck?: boolean
  allowCacheIndex?: boolean
  suppressEvents?: boolean
}

type DecryptImagePayload = CachedImagePayload & {
  force?: boolean
}

export class ImageDecryptService {
  private configService = new ConfigService()
  private resolvedCache = new Map<string, string>()
  private pending = new Map<string, Promise<DecryptResult>>()
  private updateFlags = new Map<string, boolean>()
  private nativeLogged = false
  private runtimeConfig: { dbPath?: string; myWxid?: string; imageXorKey?: unknown; imageAesKey?: string } | null = null
  private datNameScanMissAt = new Map<string, number>()
  private readonly datNameScanMissTtlMs = 1200
  private readonly accountDirCache = new Map<string, string>()
  private cacheRootPath: string | null = null
  private readonly ensuredDirs = new Set<string>()

  private shouldEmitImageEvents(payload?: { suppressEvents?: boolean }): boolean {
    if (payload?.suppressEvents === true) return false
    // 导出 worker 场景不需要向渲染层广播逐条图片事件，避免事件风暴拖慢主界面。
    if (process.env.WEFLOW_WORKER === '1') return false
    return true
  }

  private shouldCheckImageUpdate(payload?: { disableUpdateCheck?: boolean; suppressEvents?: boolean }): boolean {
    if (payload?.disableUpdateCheck === true) return false
    return this.shouldEmitImageEvents(payload)
  }

  setRuntimeConfig(config: { dbPath?: string; myWxid?: string; imageXorKey?: unknown; imageAesKey?: string } | null): void {
    this.runtimeConfig = config
  }

  private getConfiguredDbPath(): string {
    return String(this.runtimeConfig?.dbPath || this.configService.get('dbPath') || '').trim()
  }

  private getConfiguredMyWxid(): string {
    return String(this.runtimeConfig?.myWxid || this.configService.get('myWxid') || '').trim()
  }

  private getConfiguredImageKeys(): { xorKey: unknown; aesKey: string } {
    const runtimeImageXorKey = this.runtimeConfig?.imageXorKey
    const hasRuntimeXorKey = runtimeImageXorKey !== undefined && runtimeImageXorKey !== null && String(runtimeImageXorKey).trim() !== ''
    const runtimeAesKey = String(this.runtimeConfig?.imageAesKey || '').trim()
    if (hasRuntimeXorKey || runtimeAesKey) {
      const fallback = this.configService.getImageKeysForCurrentWxid()
      return {
        xorKey: hasRuntimeXorKey ? runtimeImageXorKey : fallback.xorKey,
        aesKey: runtimeAesKey || fallback.aesKey
      }
    }
    return this.configService.getImageKeysForCurrentWxid()
  }

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (!this.configService.get('logEnabled')) return
    const timestamp = new Date().toISOString()
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
    const logLine = `[${timestamp}] [ImageDecrypt] ${message}${metaStr}\n`
    this.writeLog(logLine)
  }

  private logError(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    if (!this.configService.get('logEnabled')) return
    const timestamp = new Date().toISOString()
    const errorStr = error ? ` Error: ${String(error)}` : ''
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
    const logLine = `[${timestamp}] [ImageDecrypt] ERROR: ${message}${errorStr}${metaStr}\n`
    console.error(message, error, meta)
    this.writeLog(logLine)
  }

  private writeLog(line: string): void {
    try {
      const logDir = join(this.getUserDataPath(), 'logs')
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true })
      }
      appendFileSync(join(logDir, 'wcdb.log'), line, { encoding: 'utf8' })
    } catch (err) {
      console.error('写入日志失败:', err)
    }
  }

  async resolveCachedImage(payload: CachedImagePayload): Promise<DecryptResult & { hasUpdate?: boolean }> {
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识', failureKind: 'not_found' }
    }
    for (const key of cacheKeys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached) && this.isUsableImageCacheFile(cached)) {
        const upgraded = !this.isHdPath(cached)
          ? await this.tryPromoteThumbnailCache(payload, key, cached)
          : null
        const finalPath = upgraded || cached
        const localPath = this.resolveLocalPathForPayload(finalPath, payload.preferFilePath)
        const isNonHd = !this.isHdPath(finalPath)
        const hasUpdate = isNonHd ? (this.updateFlags.get(key) ?? false) : false
        if (isNonHd) {
          if (this.shouldCheckImageUpdate(payload)) {
            this.triggerUpdateCheck(payload, key, finalPath)
          }
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, this.resolveEmitPath(finalPath, payload.preferFilePath))
        return { success: true, localPath, hasUpdate }
      }
      if (cached && !this.isUsableImageCacheFile(cached)) {
        this.resolvedCache.delete(key)
      }
    }

    const accountDir = this.resolveCurrentAccountDir()
    if (accountDir) {
      const datPath = await this.resolveDatPath(
        accountDir,
        payload.imageMd5,
        payload.imageDatName,
        payload.sessionId,
        payload.createTime,
        {
          allowThumbnail: true,
          skipResolvedCache: false,
          hardlinkOnly: true,
          allowDatNameScanFallback: payload.allowCacheIndex !== false
        }
      )
      if (datPath) {
        const existing = this.findCachedOutputByDatPath(datPath, payload.sessionId, false)
        if (existing) {
          const upgraded = !this.isHdPath(existing)
            ? await this.tryPromoteThumbnailCache(payload, cacheKey, existing)
            : null
          const finalPath = upgraded || existing
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, finalPath)
          const localPath = this.resolveLocalPathForPayload(finalPath, payload.preferFilePath)
          const isNonHd = !this.isHdPath(finalPath)
          const hasUpdate = isNonHd ? (this.updateFlags.get(cacheKey) ?? false) : false
          if (isNonHd) {
            if (this.shouldCheckImageUpdate(payload)) {
              this.triggerUpdateCheck(payload, cacheKey, finalPath)
            }
          } else {
            this.updateFlags.delete(cacheKey)
          }
          this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(finalPath, payload.preferFilePath))
          return { success: true, localPath, hasUpdate }
        }
      }
    }
    this.logInfo('未找到缓存', { md5: payload.imageMd5, datName: payload.imageDatName })
    return { success: false, error: '未找到缓存图片', failureKind: 'not_found' }
  }

  async decryptImage(payload: DecryptImagePayload): Promise<DecryptResult> {
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识', failureKind: 'not_found' }
    }
    this.emitDecryptProgress(payload, cacheKey, 'queued', 4, 'running')

    if (payload.force) {
      for (const key of cacheKeys) {
        const cached = this.resolvedCache.get(key)
        if (cached && existsSync(cached) && this.isUsableImageCacheFile(cached) && this.isHdPath(cached)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, cached)
          this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
          const localPath = this.resolveLocalPathForPayload(cached, payload.preferFilePath)
          this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(cached, payload.preferFilePath))
          this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
          return { success: true, localPath }
        }
        if (cached && !this.isUsableImageCacheFile(cached)) {
          this.resolvedCache.delete(key)
        }
      }

    }

    if (!payload.force) {
      const cached = this.resolvedCache.get(cacheKey)
      if (cached && existsSync(cached) && this.isUsableImageCacheFile(cached)) {
        const upgraded = !this.isHdPath(cached)
          ? await this.tryPromoteThumbnailCache(payload, cacheKey, cached)
          : null
        const finalPath = upgraded || cached
        const localPath = this.resolveLocalPathForPayload(finalPath, payload.preferFilePath)
        this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(finalPath, payload.preferFilePath))
        this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
        return { success: true, localPath }
      }
      if (cached && !this.isUsableImageCacheFile(cached)) {
        this.resolvedCache.delete(cacheKey)
      }
    }

    const pending = this.pending.get(cacheKey)
    if (pending) {
      this.emitDecryptProgress(payload, cacheKey, 'queued', 8, 'running')
      return pending
    }

    const task = this.decryptImageInternal(payload, cacheKey)
    this.pending.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.pending.delete(cacheKey)
    }
  }

  async preloadImageHardlinkMd5s(md5List: string[]): Promise<void> {
    const normalizedList = Array.from(
      new Set((md5List || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))
    )
    if (normalizedList.length === 0) return

    const wxid = this.getConfiguredMyWxid()
    const dbPath = this.getConfiguredDbPath()
    if (!wxid || !dbPath) return

    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return

    try {
      for (const md5 of normalizedList) {
        if (!this.looksLikeMd5(md5)) continue
        const selectedPath = this.selectBestDatPathByBase(accountDir, md5, undefined, undefined, true)
        if (!selectedPath) continue
        this.cacheDatPath(accountDir, md5, selectedPath)
        const fileName = basename(selectedPath).toLowerCase()
        if (fileName) this.cacheDatPath(accountDir, fileName, selectedPath)
      }
    } catch {
      // ignore preload failures
    }
  }

  private async decryptImageInternal(
    payload: DecryptImagePayload,
    cacheKey: string
  ): Promise<DecryptResult> {
    this.logInfo('开始解密图片', { md5: payload.imageMd5, datName: payload.imageDatName, force: payload.force, hardlinkOnly: payload.hardlinkOnly === true })
    this.emitDecryptProgress(payload, cacheKey, 'locating', 14, 'running')
    try {
      const wxid = this.getConfiguredMyWxid()
      const dbPath = this.getConfiguredDbPath()
      if (!wxid || !dbPath) {
        this.logError('配置缺失', undefined, { wxid: !!wxid, dbPath: !!dbPath })
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '配置缺失')
        return { success: false, error: '未配置账号或数据库路径', failureKind: 'not_found' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
        this.logError('未找到账号目录', undefined, { dbPath, wxid })
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '账号目录缺失')
        return { success: false, error: '未找到账号目录', failureKind: 'not_found' }
      }

      let datPath: string | null = null
      let usedHdAttempt = false
      let fallbackToThumbnail = false

      // force=true 时先尝试高清；若高清缺失则回退到缩略图，避免直接失败。
      if (payload.force) {
        usedHdAttempt = true
        datPath = await this.resolveDatPath(
          accountDir,
          payload.imageMd5,
          payload.imageDatName,
          payload.sessionId,
          payload.createTime,
          {
            allowThumbnail: false,
            skipResolvedCache: false,
            hardlinkOnly: payload.hardlinkOnly === true,
            allowDatNameScanFallback: payload.allowCacheIndex !== false
          }
        )
        if (!datPath) {
          datPath = await this.resolveDatPath(
            accountDir,
            payload.imageMd5,
            payload.imageDatName,
            payload.sessionId,
            payload.createTime,
            {
              allowThumbnail: true,
              skipResolvedCache: false,
              hardlinkOnly: payload.hardlinkOnly === true,
              allowDatNameScanFallback: payload.allowCacheIndex !== false
            }
          )
          fallbackToThumbnail = Boolean(datPath)
          if (fallbackToThumbnail) {
            this.logInfo('高清缺失，回退解密缩略图', {
              md5: payload.imageMd5,
              datName: payload.imageDatName
            })
          }
        }
      } else {
        datPath = await this.resolveDatPath(
          accountDir,
          payload.imageMd5,
          payload.imageDatName,
          payload.sessionId,
          payload.createTime,
          {
            allowThumbnail: true,
            skipResolvedCache: false,
            hardlinkOnly: payload.hardlinkOnly === true,
            allowDatNameScanFallback: payload.allowCacheIndex !== false
          }
        )
      }

      if (!datPath) {
        this.logError('未找到DAT文件', undefined, { md5: payload.imageMd5, datName: payload.imageDatName })
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '未找到DAT文件')
        if (usedHdAttempt) {
          return { success: false, error: '未找到图片文件，请在微信中点开该图片后重试', failureKind: 'not_found' }
        }
        return { success: false, error: '未找到图片文件', failureKind: 'not_found' }
      }

      this.logInfo('找到DAT文件', { datPath })
      this.emitDecryptProgress(payload, cacheKey, 'locating', 34, 'running')

      if (!extname(datPath).toLowerCase().includes('dat')) {
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, datPath)
        const localPath = this.resolveLocalPathForPayload(datPath, payload.preferFilePath)
        const isThumb = this.isThumbnailPath(datPath)
        this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(datPath, payload.preferFilePath))
        this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
        return { success: true, localPath, isThumb }
      }

      const preferHdCache = Boolean(payload.force && !fallbackToThumbnail)
      const existingFast = this.findCachedOutputByDatPath(datPath, payload.sessionId, preferHdCache)
      if (existingFast) {
        this.logInfo('找到已解密文件(按DAT快速命中)', { existing: existingFast, isHd: this.isHdPath(existingFast) })
        const isHd = this.isHdPath(existingFast)
        if (!(payload.force && !isHd)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existingFast)
          const localPath = this.resolveLocalPathForPayload(existingFast, payload.preferFilePath)
          const isThumb = this.isThumbnailPath(existingFast)
          this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(existingFast, payload.preferFilePath))
          this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
          return { success: true, localPath, isThumb }
        }
      }

      // 优先使用当前 wxid 对应的密钥，找不到则回退到全局配置
      const imageKeys = this.getConfiguredImageKeys()
      const xorKeyRaw = imageKeys.xorKey
      // 支持十六进制格式（如 0x53）和十进制格式
      let xorKey: number
      if (typeof xorKeyRaw === 'number') {
        xorKey = xorKeyRaw
      } else {
        const trimmed = String(xorKeyRaw ?? '').trim()
        if (trimmed.toLowerCase().startsWith('0x')) {
          xorKey = parseInt(trimmed, 16)
        } else {
          xorKey = parseInt(trimmed, 10)
        }
      }
      if (Number.isNaN(xorKey) || (!xorKey && xorKey !== 0)) {
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '缺少解密密钥')
        return { success: false, error: '未配置图片解密密钥', failureKind: 'not_found' }
      }

      const aesKeyRaw = imageKeys.aesKey
      const aesKeyText = typeof aesKeyRaw === 'string' ? aesKeyRaw.trim() : ''
      const aesKeyForNative = aesKeyText || undefined

      this.logInfo('开始解密DAT文件', { datPath, xorKey, hasAesKey: Boolean(aesKeyForNative) })
      this.emitDecryptProgress(payload, cacheKey, 'decrypting', 58, 'running')
      const nativeResult = this.tryDecryptDatWithNative(datPath, xorKey, aesKeyForNative)
      if (!nativeResult) {
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', 'Rust原生解密不可用')
        return { success: false, error: 'Rust原生解密不可用或解密失败，请检查 native 模块与密钥配置', failureKind: 'not_found' }
      }
      let decrypted: Buffer = nativeResult.data
      this.emitDecryptProgress(payload, cacheKey, 'decrypting', 78, 'running')

      // 统一走原有 wxgf/ffmpeg 流程，确保行为与历史版本一致
      const wxgfResult = await this.unwrapWxgf(decrypted)
      decrypted = wxgfResult.data

      const detectedExt = this.detectImageExtension(decrypted)

      // 如果解密产物无法识别为图片，归类为“解密失败”。
      if (!detectedExt) {
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '解密后不是有效图片')
        return {
          success: false,
          error: '解密后不是有效图片',
          failureKind: 'decrypt_failed',
          isThumb: this.isThumbnailPath(datPath)
        }
      }

      const finalExt = detectedExt

      const outputPath = this.getCacheOutputPathFromDat(datPath, finalExt, payload.sessionId)
      this.emitDecryptProgress(payload, cacheKey, 'writing', 90, 'running')
      await writeFile(outputPath, decrypted)
      this.logInfo('解密成功', { outputPath, size: decrypted.length })

      const isThumb = this.isThumbnailPath(datPath)
      const isHdCache = this.isHdPath(outputPath)
      this.removeDuplicateCacheCandidates(datPath, payload.sessionId, outputPath)
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
      if (isHdCache) {
        this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      } else {
        if (this.shouldCheckImageUpdate(payload)) {
          this.triggerUpdateCheck(payload, cacheKey, outputPath)
        }
      }
      const localPath = payload.preferFilePath
        ? outputPath
        : (this.bufferToDataUrl(decrypted, finalExt) || this.filePathToUrl(outputPath))
      const emitPath = this.resolveEmitPath(outputPath, payload.preferFilePath)
      this.emitCacheResolved(payload, cacheKey, emitPath)
      this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
      return { success: true, localPath, isThumb }
    } catch (e) {
      this.logError('解密失败', e, { md5: payload.imageMd5, datName: payload.imageDatName })
      this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', String(e))
      return { success: false, error: String(e), failureKind: 'not_found' }
    }
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const cleanedWxid = this.cleanAccountDirName(wxid)
    const normalized = dbPath.replace(/[\\/]+$/, '')
    const cacheKey = `${normalized}|${cleanedWxid.toLowerCase()}`
    const cached = this.accountDirCache.get(cacheKey)
    if (cached && existsSync(cached)) return cached
    if (cached && !existsSync(cached)) {
      this.accountDirCache.delete(cacheKey)
    }

    const direct = join(normalized, cleanedWxid)
    if (existsSync(direct)) {
      this.accountDirCache.set(cacheKey, direct)
      return direct
    }

    if (this.isAccountDir(normalized)) {
      this.accountDirCache.set(cacheKey, normalized)
      return normalized
    }

    try {
      const entries = readdirSync(normalized)
      const lowerWxid = cleanedWxid.toLowerCase()
      for (const entry of entries) {
        const entryPath = join(normalized, entry)
        if (!this.isDirectory(entryPath)) continue
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`)) {
          if (this.isAccountDir(entryPath)) {
            this.accountDirCache.set(cacheKey, entryPath)
            return entryPath
          }
        }
      }
    } catch { }

    return null
  }

  private resolveCurrentAccountDir(): string | null {
    const wxid = this.getConfiguredMyWxid()
    const dbPath = this.getConfiguredDbPath()
    if (!wxid || !dbPath) return null
    return this.resolveAccountDir(dbPath, wxid)
  }

  /**
   * 获取解密后的缓存目录（用于查找 hardlink.db）
   */
  private getDecryptedCacheDir(wxid: string): string | null {
    const cachePath = this.configService.get('cachePath')
    if (!cachePath) return null

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const cacheAccountDir = join(cachePath, cleanedWxid)

    // 检查缓存目录下是否有 hardlink.db
    if (existsSync(join(cacheAccountDir, 'hardlink.db'))) {
      return cacheAccountDir
    }
    if (existsSync(join(cachePath, 'hardlink.db'))) {
      return cachePath
    }
    const cacheHardlinkDir = join(cacheAccountDir, 'db_storage', 'hardlink')
    if (existsSync(join(cacheHardlinkDir, 'hardlink.db'))) {
      return cacheHardlinkDir
    }
    return null
  }

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'hardlink.db')) ||
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image2'))
    )
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
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

  private async resolveDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string,
    createTime?: number,
    options?: { allowThumbnail?: boolean; skipResolvedCache?: boolean; hardlinkOnly?: boolean; allowDatNameScanFallback?: boolean }
  ): Promise<string | null> {
    const allowThumbnail = options?.allowThumbnail ?? true
    const skipResolvedCache = options?.skipResolvedCache ?? false
    const hardlinkOnly = options?.hardlinkOnly ?? false
    const allowDatNameScanFallback = options?.allowDatNameScanFallback ?? true
    this.logInfo('[ImageDecrypt] resolveDatPath', {
      imageMd5,
      imageDatName,
      createTime,
      allowThumbnail,
      skipResolvedCache,
      hardlinkOnly,
      allowDatNameScanFallback
    })

    const lookupBases = this.collectLookupBasesForScan(imageMd5, imageDatName, allowDatNameScanFallback)
    if (lookupBases.length === 0) {
      this.logInfo('[ImageDecrypt] resolveDatPath miss (no lookup base)', { imageMd5, imageDatName })
      return null
    }

    if (!skipResolvedCache) {
      const cacheCandidates = Array.from(new Set([
        ...lookupBases,
        String(imageMd5 || '').trim().toLowerCase(),
        String(imageDatName || '').trim().toLowerCase()
      ].filter(Boolean)))
      for (const cacheKey of cacheCandidates) {
        const scopedKey = `${accountDir}|${cacheKey}`
        const cached = this.resolvedCache.get(scopedKey)
        if (!cached || !existsSync(cached)) continue
        if (!allowThumbnail && !this.isHdDatPath(cached)) continue
        return cached
      }
    }

    for (const baseMd5 of lookupBases) {
      const selectedPath = this.selectBestDatPathByBase(accountDir, baseMd5, sessionId, createTime, allowThumbnail)
      if (!selectedPath) continue

      this.cacheDatPath(accountDir, baseMd5, selectedPath)
      if (imageMd5) this.cacheDatPath(accountDir, imageMd5, selectedPath)
      if (imageDatName) this.cacheDatPath(accountDir, imageDatName, selectedPath)
      const normalizedFileName = basename(selectedPath).toLowerCase()
      if (normalizedFileName) this.cacheDatPath(accountDir, normalizedFileName, selectedPath)
      this.logInfo('[ImageDecrypt] dat scan selected', {
        baseMd5,
        selectedPath,
        allowThumbnail
      })
      return selectedPath
    }

    this.logInfo('[ImageDecrypt] resolveDatPath miss (dat scan)', {
      imageMd5,
      imageDatName,
      lookupBases,
      allowThumbnail
    })
    return null
  }

  private async checkHasUpdate(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number },
    _cacheKey: string,
    cachedPath: string
  ): Promise<boolean> {
    if (!cachedPath || !existsSync(cachedPath)) return false
    if (this.isHdPath(cachedPath)) return false
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    if (!wxid || !dbPath) return false
    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return false

    const lookupBases = this.collectLookupBasesForScan(payload.imageMd5, payload.imageDatName, true)
    if (lookupBases.length === 0) return false

    let currentTier = this.getCachedPathTier(cachedPath)
    let bestDatPath: string | null = null
    let bestDatTier = -1
    for (const baseMd5 of lookupBases) {
      const candidate = this.selectBestDatPathByBase(accountDir, baseMd5, payload.sessionId, payload.createTime, true)
      if (!candidate) continue
      const candidateTier = this.getDatTier(candidate, baseMd5)
      if (candidateTier <= 0) continue
      if (!bestDatPath) {
        bestDatPath = candidate
        bestDatTier = candidateTier
        continue
      }
      if (candidateTier > bestDatTier) {
        bestDatPath = candidate
        bestDatTier = candidateTier
        continue
      }
      if (candidateTier === bestDatTier) {
        const candidateSize = this.fileSizeSafe(candidate)
        const bestSize = this.fileSizeSafe(bestDatPath)
        if (candidateSize > bestSize) {
          bestDatPath = candidate
          bestDatTier = candidateTier
        }
      }
    }
    if (!bestDatPath || bestDatTier <= 0) return false
    if (currentTier < 0) currentTier = 1
    return bestDatTier > currentTier
  }

  private async tryPromoteThumbnailCache(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; preferFilePath?: boolean },
    cacheKey: string,
    cachedPath: string
  ): Promise<string | null> {
    if (!cachedPath || !existsSync(cachedPath)) return null
    if (!this.isImageFile(cachedPath)) return null
    if (this.isHdPath(cachedPath)) return null

    const accountDir = this.resolveCurrentAccountDir()
    if (!accountDir) return null

    const hdDatPath = await this.resolveDatPath(
      accountDir,
      payload.imageMd5,
      payload.imageDatName,
      payload.sessionId,
      payload.createTime,
      { allowThumbnail: false, skipResolvedCache: true, hardlinkOnly: true, allowDatNameScanFallback: false }
    )
    if (!hdDatPath) return null

    const existingHd = this.findCachedOutputByDatPath(hdDatPath, payload.sessionId, true)
    if (existingHd && existsSync(existingHd) && this.isImageFile(existingHd) && this.isHdPath(existingHd)) {
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existingHd)
      this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      this.removeThumbnailCacheFile(cachedPath, existingHd)
      this.logInfo('[ImageDecrypt] thumbnail cache upgraded', {
        cacheKey,
        oldPath: cachedPath,
        newPath: existingHd,
        mode: 'existing'
      })
      return existingHd
    }

    const upgraded = await this.decryptImage({
      sessionId: payload.sessionId,
      imageMd5: payload.imageMd5,
      imageDatName: payload.imageDatName,
      createTime: payload.createTime,
      preferFilePath: true,
      force: true,
      hardlinkOnly: true,
      disableUpdateCheck: true
    })
    if (!upgraded.success) return null

    const cachedResult = this.resolvedCache.get(cacheKey)
    const upgradedPath = (cachedResult && existsSync(cachedResult))
      ? cachedResult
      : String(upgraded.localPath || '').trim()
    if (!upgradedPath || !existsSync(upgradedPath)) return null
    if (!this.isImageFile(upgradedPath) || !this.isHdPath(upgradedPath)) return null

    this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, upgradedPath)
    this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
    this.removeThumbnailCacheFile(cachedPath, upgradedPath)
    this.logInfo('[ImageDecrypt] thumbnail cache upgraded', {
      cacheKey,
      oldPath: cachedPath,
      newPath: upgradedPath,
      mode: 're-decrypt'
    })
    return upgradedPath
  }

  private removeThumbnailCacheFile(oldPath: string, keepPath?: string): void {
    if (!oldPath) return
    if (keepPath && oldPath === keepPath) return
    if (!existsSync(oldPath)) return
    if (this.isHdPath(oldPath)) return
    void rm(oldPath, { force: true }).catch(() => { })
  }

  private triggerUpdateCheck(
    payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      preferFilePath?: boolean
      disableUpdateCheck?: boolean
      suppressEvents?: boolean
    },
    cacheKey: string,
    cachedPath: string
  ): void {
    if (!this.shouldCheckImageUpdate(payload)) return
    if (this.updateFlags.get(cacheKey)) return
    void this.checkHasUpdate(payload, cacheKey, cachedPath).then(async (hasUpdate) => {
      if (!hasUpdate) return
      this.updateFlags.set(cacheKey, true)
      const upgradedPath = await this.tryAutoRefreshBetterCache(payload, cacheKey, cachedPath)
      if (upgradedPath) {
        this.updateFlags.delete(cacheKey)
        this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(upgradedPath, payload.preferFilePath))
        return
      }
      this.emitImageUpdate(payload, cacheKey)
    }).catch(() => { })
  }

  private async tryAutoRefreshBetterCache(
    payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      preferFilePath?: boolean
      disableUpdateCheck?: boolean
      suppressEvents?: boolean
    },
    cacheKey: string,
    cachedPath: string
  ): Promise<string | null> {
    if (!cachedPath || !existsSync(cachedPath)) return null
    if (this.isHdPath(cachedPath)) return null
    const refreshed = await this.decryptImage({
      sessionId: payload.sessionId,
      imageMd5: payload.imageMd5,
      imageDatName: payload.imageDatName,
      createTime: payload.createTime,
      preferFilePath: true,
      force: true,
      hardlinkOnly: true,
      disableUpdateCheck: true,
      suppressEvents: true
    })
    if (!refreshed.success || !refreshed.localPath) return null
    const refreshedPath = String(refreshed.localPath || '').trim()
    if (!refreshedPath || !existsSync(refreshedPath)) return null
    if (!this.isImageFile(refreshedPath)) return null
    this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, refreshedPath)
    this.removeThumbnailCacheFile(cachedPath, refreshedPath)
    return refreshedPath
  }



  private collectHardlinkLookupMd5s(imageMd5?: string, imageDatName?: string): string[] {
    const keys: string[] = []
    const pushMd5 = (value?: string) => {
      const normalized = String(value || '').trim().toLowerCase()
      if (!normalized) return
      if (!this.looksLikeMd5(normalized)) return
      if (!keys.includes(normalized)) keys.push(normalized)
    }

    pushMd5(imageMd5)

    const datNameRaw = String(imageDatName || '').trim().toLowerCase()
    if (!datNameRaw) return keys
    pushMd5(datNameRaw)
    const datNameNoExt = datNameRaw.endsWith('.dat') ? datNameRaw.slice(0, -4) : datNameRaw
    pushMd5(datNameNoExt)
    pushMd5(this.normalizeDatBase(datNameNoExt))
    return keys
  }

  private collectLookupBasesForScan(imageMd5?: string, imageDatName?: string, allowDatNameScanFallback = true): string[] {
    const bases = this.collectHardlinkLookupMd5s(imageMd5, imageDatName)
    if (!allowDatNameScanFallback) return bases
    const fallbackRaw = String(imageDatName || imageMd5 || '').trim().toLowerCase()
    if (!fallbackRaw) return bases
    const fallbackNoExt = fallbackRaw.endsWith('.dat') ? fallbackRaw.slice(0, -4) : fallbackRaw
    const fallbackBase = this.normalizeDatBase(fallbackNoExt)
    if (this.looksLikeMd5(fallbackBase) && !bases.includes(fallbackBase)) {
      bases.push(fallbackBase)
    }
    return bases
  }

  private collectAllDatCandidatesForBase(
    accountDir: string,
    baseMd5: string,
    sessionId?: string,
    createTime?: number
  ): string[] {
    const sessionMonth = this.collectDatCandidatesFromSessionMonth(accountDir, baseMd5, sessionId, createTime)
    return Array.from(new Set(sessionMonth.filter((item) => {
      const path = String(item || '').trim()
      return path && existsSync(path) && path.toLowerCase().endsWith('.dat')
    })))
  }

  private isImgScopedDatPath(filePath: string): boolean {
    const lower = String(filePath || '').toLowerCase()
    return /[\\/](img|image|msgimg)[\\/]/.test(lower)
  }

  private fileSizeSafe(filePath: string): number {
    try {
      return statSync(filePath).size || 0
    } catch {
      return 0
    }
  }

  private fileMtimeSafe(filePath: string): number {
    try {
      return statSync(filePath).mtimeMs || 0
    } catch {
      return 0
    }
  }

  private pickLargestDatPath(paths: string[]): string | null {
    const list = Array.from(new Set(paths.filter(Boolean)))
    if (list.length === 0) return null
    list.sort((a, b) => {
      const sizeDiff = this.fileSizeSafe(b) - this.fileSizeSafe(a)
      if (sizeDiff !== 0) return sizeDiff
      const mtimeDiff = this.fileMtimeSafe(b) - this.fileMtimeSafe(a)
      if (mtimeDiff !== 0) return mtimeDiff
      return a.localeCompare(b)
    })
    return list[0] || null
  }

  private selectBestDatPathByBase(
    accountDir: string,
    baseMd5: string,
    sessionId?: string,
    createTime?: number,
    allowThumbnail = true
  ): string | null {
    const candidates = this.collectAllDatCandidatesForBase(accountDir, baseMd5, sessionId, createTime)
    if (candidates.length === 0) return null

    const imgCandidates = candidates.filter((item) => this.isImgScopedDatPath(item))
    const imgHdCandidates = imgCandidates.filter((item) => this.isHdDatPath(item))
    const hdInImg = this.pickLargestDatPath(imgHdCandidates)
    if (hdInImg) return hdInImg

    if (!allowThumbnail) {
      // 高清优先仅认 img/image/msgimg 路径中的 H 变体；
      // 若该范围没有，则交由 allowThumbnail=true 的回退分支按 base.dat/_t 继续挑选。
      return null
    }

    // 无 H 时，优先尝试原始无后缀 DAT（{md5}.dat）。
    const baseDatInImg = this.pickLargestDatPath(
      imgCandidates.filter((item) => this.isBaseDatPath(item, baseMd5))
    )
    if (baseDatInImg) return baseDatInImg

    const baseDatAny = this.pickLargestDatPath(
      candidates.filter((item) => this.isBaseDatPath(item, baseMd5))
    )
    if (baseDatAny) return baseDatAny

    const thumbDatInImg = this.pickLargestDatPath(
      imgCandidates.filter((item) => this.isTVariantDat(item))
    )
    if (thumbDatInImg) return thumbDatInImg

    const thumbDatAny = this.pickLargestDatPath(
      candidates.filter((item) => this.isTVariantDat(item))
    )
    if (thumbDatAny) return thumbDatAny

    return null
  }

  private resolveDatPathFromParsedDatName(
    accountDir: string,
    imageDatName?: string,
    sessionId?: string,
    createTime?: number,
    allowThumbnail = true
  ): string | null {
    const datNameRaw = String(imageDatName || '').trim().toLowerCase()
    if (!datNameRaw) return null
    const datNameNoExt = datNameRaw.endsWith('.dat') ? datNameRaw.slice(0, -4) : datNameRaw
    const baseMd5 = this.normalizeDatBase(datNameNoExt)
    if (!this.looksLikeMd5(baseMd5)) return null

    const monthKey = this.resolveYearMonthFromCreateTime(createTime)
    const missKey = `${accountDir}|scan|${String(sessionId || '').trim()}|${monthKey}|${baseMd5}|${allowThumbnail ? 'all' : 'hd'}`
    const lastMiss = this.datNameScanMissAt.get(missKey) || 0
    if (lastMiss && (Date.now() - lastMiss) < this.datNameScanMissTtlMs) {
      return null
    }

    const sessionMonthCandidates = this.collectDatCandidatesFromSessionMonth(accountDir, baseMd5, sessionId, createTime)
    if (sessionMonthCandidates.length > 0) {
      const orderedSessionMonth = this.sortDatCandidatePaths(sessionMonthCandidates, baseMd5)
      for (const candidatePath of orderedSessionMonth) {
        if (!allowThumbnail && !this.isHdDatPath(candidatePath)) continue
        this.datNameScanMissAt.delete(missKey)
        this.logInfo('[ImageDecrypt] datName fallback selected (session-month)', {
          accountDir,
          sessionId,
          imageDatName: datNameRaw,
          createTime,
          monthKey,
          baseMd5,
          allowThumbnail,
          selectedPath: candidatePath
        })
        return candidatePath
      }
    }

    // 新策略：只扫描会话月目录，不做 account-wide 根目录回退。
    this.datNameScanMissAt.set(missKey, Date.now())
    this.logInfo('[ImageDecrypt] datName fallback precise scan miss', {
      accountDir,
      sessionId,
      imageDatName: datNameRaw,
      createTime,
      monthKey,
      baseMd5,
      allowThumbnail
    })
    return null
  }

  private resolveYearMonthFromCreateTime(createTime?: number): string {
    const raw = Number(createTime)
    if (!Number.isFinite(raw) || raw <= 0) return ''
    const ts = raw > 1e12 ? raw : raw * 1000
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    return `${y}-${m}`
  }

  private collectDatCandidatesFromSessionMonth(
    accountDir: string,
    baseMd5: string,
    sessionId?: string,
    createTime?: number
  ): string[] {
    const normalizedSessionId = String(sessionId || '').trim()
    const monthKey = this.resolveYearMonthFromCreateTime(createTime)
    if (!normalizedSessionId || !monthKey) return []

    const sessionDir = this.resolveSessionDirForStorage(normalizedSessionId)
    if (!sessionDir) return []
    const candidates = new Set<string>()
    const budget = { remaining: 240 }
    const targetDirs: Array<{ dir: string; depth: number }> = [
      // 1) accountDir/msg/attach/{sessionMd5}/{yyyy-MM}/Img
      { dir: join(accountDir, 'msg', 'attach', sessionDir, monthKey, 'Img'), depth: 1 }
    ]

    for (const target of targetDirs) {
      if (budget.remaining <= 0) break
      this.scanDatCandidatesUnderRoot(target.dir, baseMd5, target.depth, candidates, budget)
    }

    return Array.from(candidates)
  }

  private resolveSessionDirForStorage(sessionId: string): string {
    const normalized = String(sessionId || '').trim().toLowerCase()
    if (!normalized) return ''
    if (this.looksLikeMd5(normalized)) return normalized
    const cleaned = this.cleanAccountDirName(normalized).toLowerCase()
    if (this.looksLikeMd5(cleaned)) return cleaned
    return crypto.createHash('md5').update(cleaned || normalized).digest('hex').toLowerCase()
  }

  private scanDatCandidatesUnderRoot(
    rootDir: string,
    baseMd5: string,
    maxDepth: number,
    out: Set<string>,
    budget: { remaining: number }
  ): void {
    if (!rootDir || maxDepth < 0 || budget.remaining <= 0) return
    if (!existsSync(rootDir) || !this.isDirectory(rootDir)) return

    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
    while (stack.length > 0 && budget.remaining > 0) {
      const current = stack.pop()
      if (!current) break
      budget.remaining -= 1

      let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>
      try {
        entries = readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue
        const name = String(entry.name || '')
        if (!this.isHardlinkCandidateName(name, baseMd5)) continue
        const fullPath = join(current.dir, name)
        if (existsSync(fullPath)) out.add(fullPath)
      }

      if (current.depth >= maxDepth) continue
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const name = String(entry.name || '')
        if (!name || name === '.' || name === '..') continue
        if (name.startsWith('.')) continue
        stack.push({ dir: join(current.dir, name), depth: current.depth + 1 })
      }
    }
  }

  private sortDatCandidatePaths(paths: string[], baseMd5: string): string[] {
    const list = Array.from(new Set(paths.filter(Boolean)))
    list.sort((a, b) => {
      const nameA = basename(a).toLowerCase()
      const nameB = basename(b).toLowerCase()
      const priorityA = this.getHardlinkCandidatePriority(nameA, baseMd5)
      const priorityB = this.getHardlinkCandidatePriority(nameB, baseMd5)
      if (priorityA !== priorityB) return priorityA - priorityB

      let sizeA = 0
      let sizeB = 0
      try {
        sizeA = statSync(a).size
      } catch { }
      try {
        sizeB = statSync(b).size
      } catch { }
      if (sizeA !== sizeB) return sizeB - sizeA

      let mtimeA = 0
      let mtimeB = 0
      try {
        mtimeA = statSync(a).mtimeMs
      } catch { }
      try {
        mtimeB = statSync(b).mtimeMs
      } catch { }
      if (mtimeA !== mtimeB) return mtimeB - mtimeA
      return nameA.localeCompare(nameB)
    })
    return list
  }

  private isHardlinkCandidateName(fileName: string, baseMd5: string): boolean {
    const lower = String(fileName || '').trim().toLowerCase()
    if (!lower.endsWith('.dat')) return false
    const base = lower.slice(0, -4)
    if (base === baseMd5) return true
    if (base.startsWith(`${baseMd5}_`) || base.startsWith(`${baseMd5}.`)) return true
    if (base.length === baseMd5.length + 1 && base.startsWith(baseMd5)) return true
    return this.normalizeDatBase(base) === baseMd5
  }

  private getHardlinkCandidatePriority(fileName: string, _baseMd5: string): number {
    const lower = String(fileName || '').trim().toLowerCase()
    if (!lower.endsWith('.dat')) return 999

    const base = lower.slice(0, -4)
    if (
      base.endsWith('_h') ||
      base.endsWith('.h') ||
      base.endsWith('_hd') ||
      base.endsWith('.hd')
    ) {
      return 0
    }
    if (base.endsWith('_b') || base.endsWith('.b')) return 1
    if (this.isThumbnailDat(lower)) return 3
    return 2
  }

  private normalizeHardlinkDatPathByFileName(fullPath: string, fileName: string): string {
    const normalizedPath = String(fullPath || '').trim()
    const normalizedFileName = String(fileName || '').trim().toLowerCase()
    if (!normalizedPath || !normalizedFileName) return normalizedPath
    if (!normalizedFileName.endsWith('.dat')) return normalizedPath
    const normalizedBase = this.normalizeDatBase(normalizedFileName.slice(0, -4))
    if (!this.looksLikeMd5(normalizedBase)) return ''

    // 最新策略：只要 hardlink 有记录，始终直接使用其记录路径（包括无后缀 DAT）。
    return normalizedPath
  }

  private async resolveHardlinkPath(accountDir: string, md5: string, _sessionId?: string): Promise<string | null> {
    try {
      const normalizedMd5 = String(md5 || '').trim().toLowerCase()
      if (!this.looksLikeMd5(normalizedMd5)) return null
      const ready = await this.ensureWcdbReady()
      if (!ready) {
        this.logInfo('[ImageDecrypt] hardlink db not ready')
        return null
      }

      const resolveResult = await wcdbService.resolveImageHardlink(normalizedMd5, accountDir)
      if (!resolveResult.success || !resolveResult.data) return null
      const fileName = String(resolveResult.data.file_name || '').trim()
      const fullPath = String(resolveResult.data.full_path || '').trim()
      if (!fileName || !fullPath) return null

      const lowerFileName = String(fileName).toLowerCase()
      if (lowerFileName.endsWith('.dat')) {
        const normalizedBase = this.normalizeDatBase(lowerFileName.slice(0, -4))
        if (!this.looksLikeMd5(normalizedBase)) {
          this.logInfo('[ImageDecrypt] hardlink fileName rejected', { fileName })
          return null
        }
      }

      const selectedPath = this.normalizeHardlinkDatPathByFileName(fullPath, fileName)
      if (existsSync(selectedPath)) {
        this.logInfo('[ImageDecrypt] hardlink path hit', { md5: normalizedMd5, fileName, fullPath, selectedPath })
        return selectedPath
      }

      this.logInfo('[ImageDecrypt] hardlink path miss', { md5: normalizedMd5, fileName, fullPath, selectedPath })
      return null
    } catch {
      // ignore
    }
    return null
  }

  private async ensureWcdbReady(): Promise<boolean> {
    if (wcdbService.isReady()) return true
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    const wxid = this.configService.get('myWxid')
    if (!dbPath || !decryptKey || !wxid) return false
    const cleanedWxid = this.cleanAccountDirName(wxid)
    return await wcdbService.open(dbPath, decryptKey, cleanedWxid)
  }

  private getRowValue(row: any, column: string): any {
    if (!row) return undefined
    if (Object.prototype.hasOwnProperty.call(row, column)) return row[column]
    const target = column.toLowerCase()
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === target) return row[key]
    }
    return undefined
  }

  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''")
  }

  private stripDatVariantSuffix(base: string): string {
    const lower = base.toLowerCase()
    const suffixes = ['_thumb', '.thumb', '_hd', '.hd', '_h', '.h', '_b', '.b', '_w', '.w', '_t', '.t', '_c', '.c']
    for (const suffix of suffixes) {
      if (lower.endsWith(suffix)) {
        return lower.slice(0, -suffix.length)
      }
    }
    if (/[._][a-z]$/.test(lower)) {
      return lower.slice(0, -2)
    }
    return lower
  }

  private normalizeDatBase(name: string): string {
    let base = name.toLowerCase()
    if (base.endsWith('.dat') || base.endsWith('.jpg')) {
      base = base.slice(0, -4)
    }
    for (;;) {
      const stripped = this.stripDatVariantSuffix(base)
      if (stripped === base) {
        return base
      }
      base = stripped
    }
  }

  private getCacheVariantSuffixFromDat(datPath: string): string {
    if (this.isHdDatPath(datPath)) return '_hd'
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const stem = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const base = this.normalizeDatBase(stem)
    const rawSuffix = stem.slice(base.length)
    if (!rawSuffix) return ''
    const safe = rawSuffix.replace(/[^a-z0-9._-]/g, '')
    if (!safe) return ''
    if (safe.startsWith('_') || safe.startsWith('.')) return safe
    return `_${safe}`
  }

  private getCacheVariantSuffixFromCachedPath(cachePath: string): string {
    const raw = String(cachePath || '').split('?')[0]
    const name = basename(raw)
    const ext = extname(name).toLowerCase()
    const stem = (ext ? name.slice(0, -ext.length) : name).toLowerCase()
    const base = this.normalizeDatBase(stem)
    const rawSuffix = stem.slice(base.length)
    if (!rawSuffix) return ''
    const safe = rawSuffix.replace(/[^a-z0-9._-]/g, '')
    if (!safe) return ''
    if (safe.startsWith('_') || safe.startsWith('.')) return safe
    return `_${safe}`
  }

  private buildCacheSuffixSearchOrder(primarySuffix: string, preferHd: boolean): string[] {
    const fallbackSuffixes = [
      '_hd',
      '_thumb',
      '_t',
      '.t',
      '_b',
      '.b',
      '_w',
      '.w',
      '_c',
      '.c',
      ''
    ]
    const ordered = preferHd
      ? ['_hd', primarySuffix, ...fallbackSuffixes]
      : [primarySuffix, '_hd', ...fallbackSuffixes]
    return Array.from(new Set(ordered.map((item) => String(item || '').trim()).filter((item) => item.length >= 0)))
  }

  private getCacheOutputPathFromDat(datPath: string, ext: string, sessionId?: string): string {
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const normalizedBase = this.normalizeDatBase(base)
    const suffix = this.getCacheVariantSuffixFromDat(datPath)

    const contactDir = this.sanitizeDirName(sessionId || 'unknown')
    const timeDir = this.resolveTimeDir(datPath)
    const outputDir = join(this.getCacheRoot(), contactDir, timeDir)
    this.ensureDir(outputDir)

    return join(outputDir, `${normalizedBase}${suffix}${ext}`)
  }

  private buildCacheOutputCandidatesFromDat(datPath: string, sessionId?: string, preferHd = false): string[] {
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const normalizedBase = this.normalizeDatBase(base)
    const primarySuffix = this.getCacheVariantSuffixFromDat(datPath)
    const suffixes = this.buildCacheSuffixSearchOrder(primarySuffix, preferHd)
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    const root = this.getCacheRoot()
    const contactDir = this.sanitizeDirName(sessionId || 'unknown')
    const timeDir = this.resolveTimeDir(datPath)
    const currentDir = join(root, contactDir, timeDir)
    const legacyDir = join(root, normalizedBase)
    const candidates: string[] = []

    for (const suffix of suffixes) {
      for (const ext of extensions) {
        candidates.push(join(currentDir, `${normalizedBase}${suffix}${ext}`))
      }
    }

    // 兼容旧目录结构
    for (const suffix of suffixes) {
      for (const ext of extensions) {
        candidates.push(join(legacyDir, `${normalizedBase}${suffix}${ext}`))
      }
    }

    // 兼容最旧平铺结构
    for (const ext of extensions) {
      candidates.push(join(root, `${normalizedBase}${ext}`))
      candidates.push(join(root, `${normalizedBase}_t${ext}`))
      candidates.push(join(root, `${normalizedBase}_hd${ext}`))
    }

    return candidates
  }

  private removeDuplicateCacheCandidates(datPath: string, sessionId: string | undefined, keepPath: string): void {
    const candidateSets = [
      ...this.buildCacheOutputCandidatesFromDat(datPath, sessionId, false),
      ...this.buildCacheOutputCandidatesFromDat(datPath, sessionId, true)
    ]
    const candidates = Array.from(new Set(candidateSets))
    for (const candidate of candidates) {
      if (!candidate || candidate === keepPath) continue
      if (!existsSync(candidate)) continue
      if (!this.isImageFile(candidate)) continue
      void rm(candidate, { force: true }).catch(() => { })
    }
  }

  private findCachedOutputByDatPath(datPath: string, sessionId?: string, preferHd = false): string | null {
    const candidates = this.buildCacheOutputCandidatesFromDat(datPath, sessionId, preferHd)
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      if (this.isUsableImageCacheFile(candidate)) return candidate
    }
    return null
  }

  private cacheResolvedPaths(cacheKey: string, imageMd5: string | undefined, imageDatName: string | undefined, outputPath: string): void {
    this.resolvedCache.set(cacheKey, outputPath)
    if (imageMd5 && imageMd5 !== cacheKey) {
      this.resolvedCache.set(imageMd5, outputPath)
    }
    if (imageDatName && imageDatName !== cacheKey && imageDatName !== imageMd5) {
      this.resolvedCache.set(imageDatName, outputPath)
    }
  }

  private getCacheKeys(payload: { imageMd5?: string; imageDatName?: string }): string[] {
    const keys: string[] = []
    const addKey = (value?: string) => {
      if (!value) return
      const lower = value.toLowerCase()
      if (!keys.includes(value)) keys.push(value)
      if (!keys.includes(lower)) keys.push(lower)
      const normalized = this.normalizeDatBase(lower)
      if (normalized && !keys.includes(normalized)) keys.push(normalized)
    }
    addKey(payload.imageMd5)
    if (payload.imageDatName && payload.imageDatName !== payload.imageMd5) {
      addKey(payload.imageDatName)
    }
    return keys
  }

  private cacheDatPath(accountDir: string, datName: string, datPath: string): void {
    const key = `${accountDir}|${datName}`
    this.resolvedCache.set(key, datPath)
    const normalized = this.normalizeDatBase(datName)
    if (normalized && normalized !== datName.toLowerCase()) {
      this.resolvedCache.set(`${accountDir}|${normalized}`, datPath)
    }
  }

  private clearUpdateFlags(cacheKey: string, imageMd5?: string, imageDatName?: string): void {
    this.updateFlags.delete(cacheKey)
    if (imageMd5) this.updateFlags.delete(imageMd5)
    if (imageDatName) this.updateFlags.delete(imageDatName)
  }

  private getActiveWindowsSafely(): Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }> {
    try {
      const getter = (BrowserWindow as unknown as { getAllWindows?: () => any[] } | undefined)?.getAllWindows
      if (typeof getter !== 'function') return []
      const windows = getter()
      if (!Array.isArray(windows)) return []
      return windows.filter((win) => (
        win &&
        typeof win.isDestroyed === 'function' &&
        win.webContents &&
        typeof win.webContents.send === 'function'
      ))
    } catch {
      return []
    }
  }

  private emitImageUpdate(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; suppressEvents?: boolean }, cacheKey: string): void {
    if (!this.shouldEmitImageEvents(payload)) return
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName }
    for (const win of this.getActiveWindowsSafely()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:updateAvailable', message)
      }
    }
  }

  private emitCacheResolved(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; suppressEvents?: boolean }, cacheKey: string, localPath: string): void {
    if (!this.shouldEmitImageEvents(payload)) return
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName, localPath }
    for (const win of this.getActiveWindowsSafely()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:cacheResolved', message)
      }
    }
  }

  private emitDecryptProgress(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; suppressEvents?: boolean },
    cacheKey: string,
    stage: DecryptProgressStage,
    progress: number,
    status: 'running' | 'done' | 'error',
    message?: string
  ): void {
    if (!this.shouldEmitImageEvents(payload)) return
    const safeProgress = Math.max(0, Math.min(100, Math.floor(progress)))
    const event = {
      cacheKey,
      imageMd5: payload.imageMd5,
      imageDatName: payload.imageDatName,
      stage,
      progress: safeProgress,
      status,
      message: message || ''
    }
    for (const win of this.getActiveWindowsSafely()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:decryptProgress', event)
      }
    }
  }

  private getCacheRoot(): string {
    let root = this.cacheRootPath
    if (!root) {
      const configured = this.configService.get('cachePath')
      root = configured
        ? join(configured, 'Images')
        : join(this.getDocumentsPath(), 'WeFlow', 'Images')
      this.cacheRootPath = root
    }
    this.ensureDir(root)
    return root
  }

  private ensureDir(dirPath: string): void {
    if (!dirPath) return
    if (this.ensuredDirs.has(dirPath) && existsSync(dirPath)) return
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }
    this.ensuredDirs.add(dirPath)
  }

  private tryDecryptDatWithNative(
    datPath: string,
    xorKey: number,
    aesKey?: string
  ): { data: Buffer; ext: string; isWxgf: boolean } | null {
    const result = decryptDatViaNative(datPath, xorKey, aesKey)
    if (!this.nativeLogged) {
      this.nativeLogged = true
      if (result) {
        this.logInfo('Rust 原生解密已启用', {
          addonPath: nativeAddonLocation(),
          source: 'native'
        })
      } else {
        this.logInfo('Rust 原生解密不可用', {
          addonPath: nativeAddonLocation(),
          source: 'native_unavailable'
        })
      }
    }
    if (result) return result
    const fallback = this.tryDecryptDatWithJs(datPath, xorKey, aesKey)
    if (fallback) {
      this.logInfo('JS DAT 解密 fallback 已启用', { datPath, ext: fallback.ext })
    }
    return fallback
  }

  private tryDecryptDatWithJs(
    datPath: string,
    xorKey: number,
    aesKey?: string
  ): { data: Buffer; ext: string; isWxgf: boolean } | null {
    try {
      const encrypted = readFileSync(datPath)
      const directExt = this.detectImageExtension(encrypted)
      if (directExt) return { data: encrypted, ext: directExt, isWxgf: false }

      const candidates: Buffer[] = []
      const aesKeyText = String(aesKey || '').trim()
      const datVersion = this.getDatVersion(encrypted)
      if (datVersion === 2 && aesKeyText.length >= 16) {
        try {
          candidates.push(this.decryptDatV4WithJs(encrypted, xorKey, Buffer.from(aesKeyText, 'ascii').subarray(0, 16)))
        } catch { }
      }
      if (datVersion !== 2) {
        candidates.push(this.decryptDatV3WithJs(encrypted, xorKey))
      }

      for (const candidate of candidates) {
        const ext = this.detectImageExtension(candidate)
        if (ext) return { data: candidate, ext, isWxgf: false }
      }
    } catch (error) {
      this.logError('JS DAT 解密 fallback 失败', error, { datPath })
    }
    return null
  }

  private decryptDatV3WithJs(data: Buffer, xorKey: number): Buffer {
    const output = Buffer.allocUnsafe(data.length)
    for (let i = 0; i < data.length; i += 1) {
      output[i] = data[i] ^ xorKey
    }
    return output
  }

  private decryptDatV4WithJs(data: Buffer, xorKey: number, aesKey: Buffer): Buffer {
    if (data.length < 0x0f) {
      throw new Error('dat file too small')
    }
    const header = data.subarray(0, 0x0f)
    const payload = data.subarray(0x0f)
    const aesSize = this.readInt32LeSafe(header, 6)
    const xorSize = this.readInt32LeSafe(header, 10)
    const remainder = ((aesSize % 16) + 16) % 16
    const alignedAesSize = aesSize + (16 - remainder)
    if (alignedAesSize > payload.length) throw new Error('invalid aes size')

    const aesData = payload.subarray(0, alignedAesSize)

    let plainAes = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, Buffer.alloc(0))
      decipher.setAutoPadding(false)
      plainAes = this.strictRemovePkcs7Padding(Buffer.concat([decipher.update(aesData), decipher.final()]))
    }

    const remaining = payload.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) throw new Error('invalid xor size')

    let rawData = Buffer.alloc(0)
    let decodedXor = Buffer.alloc(0)
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) throw new Error('invalid raw size')
      rawData = remaining.subarray(0, rawLength)
      const xorData = remaining.subarray(rawLength)
      decodedXor = Buffer.allocUnsafe(xorData.length)
      for (let i = 0; i < xorData.length; i += 1) {
        decodedXor[i] = xorData[i] ^ xorKey
      }
    } else {
      rawData = remaining
    }
    return Buffer.concat([plainAes, rawData, decodedXor])
  }

  private getDatVersion(data: Buffer): number {
    if (data.length < 6) return 0
    const sigV1 = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07])
    const sigV2 = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    if (data.subarray(0, 6).equals(sigV1)) return 1
    if (data.subarray(0, 6).equals(sigV2)) return 2
    return 0
  }

  private readInt32LeSafe(buffer: Buffer, offset: number): number {
    if (offset < 0 || offset + 4 > buffer.length) throw new Error('invalid int32 offset')
    return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)
  }

  private strictRemovePkcs7Padding(data: Buffer): Buffer {
    if (data.length === 0) throw new Error('empty decrypted data')
    const pad = data[data.length - 1]
    if (pad <= 0 || pad > 16 || pad > data.length) throw new Error('invalid pkcs7 padding')
    for (let i = data.length - pad; i < data.length; i += 1) {
      if (data[i] !== pad) throw new Error('invalid pkcs7 padding')
    }
    return data.subarray(0, data.length - pad)
  }

  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return '.webp'
    }
    return null
  }

  private bufferToDataUrl(buffer: Buffer, ext: string): string | null {
    const mimeType = this.mimeFromExtension(ext)
    if (!mimeType) return null
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  }

  private resolveLocalPathForPayload(filePath: string, preferFilePath?: boolean): string {
    if (preferFilePath) return filePath
    return this.resolveEmitPath(filePath, false)
  }

  private resolveEmitPath(filePath: string, preferFilePath?: boolean): string {
    if (preferFilePath) return this.filePathToUrl(filePath)
    return this.fileToDataUrl(filePath) || this.filePathToUrl(filePath)
  }

  private fileToDataUrl(filePath: string): string | null {
    try {
      const ext = extname(filePath).toLowerCase()
      const mimeType = this.mimeFromExtension(ext)
      if (!mimeType) return null
      const data = readFileSync(filePath)
      return `data:${mimeType};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  private mimeFromExtension(ext: string): string | null {
    switch (ext.toLowerCase()) {
      case '.gif':
        return 'image/gif'
      case '.png':
        return 'image/png'
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg'
      case '.webp':
        return 'image/webp'
      default:
        return null
    }
  }

  private filePathToUrl(filePath: string): string {
    const url = pathToFileURL(filePath).toString()
    try {
      const mtime = statSync(filePath).mtimeMs
      return `${url}?v=${Math.floor(mtime)}`
    } catch {
      return url
    }
  }

  private isImageFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return ext === '.gif' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp'
  }

  private isUsableImageCacheFile(filePath: string): boolean {
    if (!this.isImageFile(filePath)) return false
    if (!existsSync(filePath)) return false
    if (this.isLikelyCorruptedDecodedImage(filePath)) {
      this.logInfo('[ImageDecrypt] 跳过疑似损坏缓存文件', { filePath })
      void rm(filePath, { force: true }).catch(() => { })
      return false
    }
    return true
  }

  private isLikelyCorruptedDecodedImage(filePath: string): boolean {
    try {
      const ext = extname(filePath).toLowerCase()
      if (ext !== '.jpg' && ext !== '.jpeg') return false
      const data = readFileSync(filePath)
      return this.isLikelyCorruptedJpegBuffer(data)
    } catch {
      return false
    }
  }

  private isLikelyCorruptedJpegBuffer(data: Buffer): boolean {
    if (data.length < 4096) return false
    let zeroCount = 0
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] === 0x00) zeroCount += 1
    }
    const zeroRatio = zeroCount / data.length
    if (zeroRatio >= 0.985) return true

    const hasLavcTag = data.length >= 24 && data.subarray(0, 24).includes(Buffer.from('Lavc'))
    if (!hasLavcTag) return false

    // JPEG 扫描段若几乎全是 0，通常表示解码失败但被编码器强行输出。
    let sosPos = -1
    for (let i = 2; i < data.length - 1; i += 1) {
      if (data[i] === 0xff && data[i + 1] === 0xda) {
        sosPos = i
        break
      }
    }
    if (sosPos < 0 || sosPos + 4 >= data.length) return zeroRatio >= 0.95

    const sosLength = (data[sosPos + 2] << 8) | data[sosPos + 3]
    const scanStart = sosPos + 2 + sosLength
    if (scanStart >= data.length - 2) return zeroRatio >= 0.95

    let eoiPos = -1
    for (let i = data.length - 2; i >= scanStart; i -= 1) {
      if (data[i] === 0xff && data[i + 1] === 0xd9) {
        eoiPos = i
        break
      }
    }
    if (eoiPos < 0 || eoiPos <= scanStart) return zeroRatio >= 0.95

    const scanData = data.subarray(scanStart, eoiPos)
    if (scanData.length < 1024) return zeroRatio >= 0.95
    let scanZeroCount = 0
    for (let i = 0; i < scanData.length; i += 1) {
      if (scanData[i] === 0x00) scanZeroCount += 1
    }
    const scanZeroRatio = scanZeroCount / scanData.length
    return scanZeroRatio >= 0.985
  }

  /**
   * 解包 wxgf 格式
   * wxgf 是微信的图片格式，内部使用 HEVC 编码
   */
  private async unwrapWxgf(buffer: Buffer): Promise<{ data: Buffer; isWxgf: boolean }> {
    // 检查是否是 wxgf 格式 (77 78 67 66 = "wxgf")
    if (buffer.length < 20 ||
      buffer[0] !== 0x77 || buffer[1] !== 0x78 ||
      buffer[2] !== 0x67 || buffer[3] !== 0x66) {
      return { data: buffer, isWxgf: false }
    }

    // 先尝试搜索内嵌的传统图片签名
    for (let i = 4; i < Math.min(buffer.length - 12, 4096); i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
        return { data: buffer.subarray(i), isWxgf: false }
      }
      if (buffer[i] === 0x89 && buffer[i + 1] === 0x50 &&
        buffer[i + 2] === 0x4e && buffer[i + 3] === 0x47) {
        return { data: buffer.subarray(i), isWxgf: false }
      }
    }

    const hevcCandidates = this.buildWxgfHevcCandidates(buffer)
    this.logInfo('unwrapWxgf: 准备 ffmpeg 转换', {
      candidateCount: hevcCandidates.length,
      candidates: hevcCandidates.map((item) => `${item.name}:${item.data.length}`)
    })

    for (const candidate of hevcCandidates) {
      try {
        const jpgData = await this.convertHevcToJpg(candidate.data)
        if (!jpgData || jpgData.length === 0) continue
        return { data: jpgData, isWxgf: false }
      } catch (e) {
        this.logError('unwrapWxgf: 候选流转换失败', e, { candidate: candidate.name })
      }
    }

    const fallback = hevcCandidates[0]?.data || buffer.subarray(4)
    return { data: fallback, isWxgf: true }
  }

  private buildWxgfHevcCandidates(buffer: Buffer): Array<{ name: string; data: Buffer }> {
    const units = this.extractHevcNaluUnits(buffer)
    const candidates: Array<{ name: string; data: Buffer }> = []

    const addCandidate = (name: string, data: Buffer | null | undefined): void => {
      if (!data || data.length < 100) return
      if (candidates.some((item) => item.data.equals(data))) return
      candidates.push({ name, data })
    }

    // 1) 优先尝试按 VPS(32) 分组后的候选流
    const vpsStarts: number[] = []
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i]
      if (!unit || unit.length < 2) continue
      const type = (unit[0] >> 1) & 0x3f
      if (type === 32) vpsStarts.push(i)
    }
    const groups: Array<{ index: number; data: Buffer; size: number }> = []
    for (let i = 0; i < vpsStarts.length; i += 1) {
      const start = vpsStarts[i]
      const end = i + 1 < vpsStarts.length ? vpsStarts[i + 1] : units.length
      const groupUnits = units.slice(start, end)
      if (groupUnits.length === 0) continue
      let hasVcl = false
      for (const unit of groupUnits) {
        if (!unit || unit.length < 2) continue
        const type = (unit[0] >> 1) & 0x3f
        if (type === 19 || type === 20 || type === 1) {
          hasVcl = true
          break
        }
      }
      if (!hasVcl) continue
      const merged = this.mergeHevcNaluUnits(groupUnits)
      groups.push({ index: i, data: merged, size: merged.length })
    }
    groups.sort((a, b) => b.size - a.size)
    for (const group of groups) {
      addCandidate(`group_${group.index}`, group.data)
    }

    // 2) 全量扫描提取流
    addCandidate('scan_all_nalus', this.mergeHevcNaluUnits(units))

    // 3) 兜底：直接跳过 wxgf 头喂 ffmpeg
    addCandidate('raw_skip4', buffer.subarray(4))

    return candidates
  }

  private mergeHevcNaluUnits(units: Buffer[]): Buffer {
    if (!Array.isArray(units) || units.length === 0) return Buffer.alloc(0)
    const merged: Buffer[] = []
    for (const unit of units) {
      if (!unit || unit.length < 2) continue
      merged.push(Buffer.from([0x00, 0x00, 0x00, 0x01]))
      merged.push(unit)
    }
    return Buffer.concat(merged)
  }

  private extractHevcNaluUnits(buffer: Buffer): Buffer[] {
    const starts: number[] = []
    let i = 4
    while (i < buffer.length - 3) {
      const hasPrefix4 = buffer[i] === 0x00 && buffer[i + 1] === 0x00 &&
        buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01
      const hasPrefix3 = buffer[i] === 0x00 && buffer[i + 1] === 0x00 &&
        buffer[i + 2] === 0x01
      if (hasPrefix4 || hasPrefix3) {
        starts.push(i)
        i += hasPrefix4 ? 4 : 3
        continue
      }
      i += 1
    }
    if (starts.length === 0) return []

    const units: Buffer[] = []
    let keptUnits = 0
    let droppedUnits = 0
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index]
      const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
      const hasPrefix4 = buffer[start] === 0x00 && buffer[start + 1] === 0x00 &&
        buffer[start + 2] === 0x00 && buffer[start + 3] === 0x01
      const prefixLength = hasPrefix4 ? 4 : 3
      const payloadStart = start + prefixLength
      if (payloadStart >= end) continue
      const payload = buffer.subarray(payloadStart, end)
      if (payload.length < 2) {
        droppedUnits += 1
        continue
      }
      if ((payload[0] & 0x80) !== 0) {
        droppedUnits += 1
        continue
      }
      units.push(payload)
      keptUnits += 1
    }
    return units
  }

  /**
   * 从 wxgf 数据中提取 HEVC NALU 裸流
   */
  private extractHevcNalu(buffer: Buffer): Buffer | null {
    const units = this.extractHevcNaluUnits(buffer)
    if (units.length === 0) return null
    const merged = this.mergeHevcNaluUnits(units)
    return merged.length > 0 ? merged : null
  }

  /**
   * 获取 ffmpeg 可执行文件路径
   */
  private getFfmpegPath(): string {
    const staticPath = getStaticFfmpegPath()
    this.logInfo('ffmpeg 路径检测', { staticPath, exists: staticPath ? existsSync(staticPath) : false })

    if (staticPath) {
      return staticPath
    }

    // 回退到系统 ffmpeg
    return 'ffmpeg'
  }

  /**
   * 使用 ffmpeg 将 HEVC 裸流转换为 JPG
   */
  private async convertHevcToJpg(hevcData: Buffer): Promise<Buffer | null> {
    const ffmpeg = this.getFfmpegPath()
    this.logInfo('ffmpeg 转换开始', { ffmpegPath: ffmpeg, hevcSize: hevcData.length })

    const tmpDir = join(this.getTempPath(), 'weflow_hevc')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const uniqueId = `${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const tmpInput = join(tmpDir, `hevc_${uniqueId}.hevc`)
    const tmpOutput = join(tmpDir, `hevc_${uniqueId}.jpg`)

    try {
      await writeFile(tmpInput, hevcData)

      // 依次尝试: 1) -f hevc 裸流  2) 不指定格式让 ffmpeg 自动检测
      const attempts: { label: string; inputArgs: string[]; outputArgs?: string[] }[] = [
        { label: 'hevc raw frame0', inputArgs: ['-f', 'hevc', '-i', tmpInput] },
        { label: 'hevc raw frame1', inputArgs: ['-f', 'hevc', '-i', tmpInput], outputArgs: ['-vf', 'select=eq(n\\,1)'] },
        { label: 'hevc raw frame5', inputArgs: ['-f', 'hevc', '-i', tmpInput], outputArgs: ['-vf', 'select=eq(n\\,5)'] },
        { label: 'h265 raw frame0', inputArgs: ['-f', 'h265', '-i', tmpInput] },
        { label: 'h265 raw frame1', inputArgs: ['-f', 'h265', '-i', tmpInput], outputArgs: ['-vf', 'select=eq(n\\,1)'] },
        { label: 'h265 raw frame5', inputArgs: ['-f', 'h265', '-i', tmpInput], outputArgs: ['-vf', 'select=eq(n\\,5)'] },
        { label: 'auto detect frame0', inputArgs: ['-i', tmpInput] },
        { label: 'auto detect frame1', inputArgs: ['-i', tmpInput], outputArgs: ['-vf', 'select=eq(n\\,1)'] },
        { label: 'auto detect frame5', inputArgs: ['-i', tmpInput], outputArgs: ['-vf', 'select=eq(n\\,5)'] },
      ]

      for (const attempt of attempts) {
        // 清理上一轮的输出
        try { if (existsSync(tmpOutput)) require('fs').unlinkSync(tmpOutput) } catch {}

        const result = await this.runFfmpegConvert(ffmpeg, attempt.inputArgs, tmpOutput, attempt.label, attempt.outputArgs)
        if (!result) continue
        if (this.isLikelyCorruptedJpegBuffer(result)) continue
        return result
      }

      return null
    } catch (e) {
      this.logError('ffmpeg 转换异常', e)
      return null
    } finally {
      try { if (existsSync(tmpInput)) require('fs').unlinkSync(tmpInput) } catch {}
      try { if (existsSync(tmpOutput)) require('fs').unlinkSync(tmpOutput) } catch {}
    }
  }

  private runFfmpegConvert(
    ffmpeg: string,
    inputArgs: string[],
    tmpOutput: string,
    label: string,
    outputArgs?: string[]
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process')
      const errChunks: Buffer[] = []

      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-y',
        ...inputArgs,
        ...(outputArgs || []),
        '-vframes', '1', '-q:v', '2', '-f', 'image2', tmpOutput
      ]
      this.logInfo(`ffmpeg 尝试 [${label}]`, { args: args.join(' ') })

      const proc = spawn(ffmpeg, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })

      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        this.logError(`ffmpeg [${label}] 超时(15s)`)
        resolve(null)
      }, 15000)

      proc.on('close', (code: number) => {
        clearTimeout(timer)
        if (code === 0 && existsSync(tmpOutput)) {
          try {
            const jpgBuf = readFileSync(tmpOutput)
            if (jpgBuf.length > 0) {
              this.logInfo(`ffmpeg [${label}] 成功`, { outputSize: jpgBuf.length })
              resolve(jpgBuf)
              return
            }
          } catch (e) {
            this.logError(`ffmpeg [${label}] 读取输出失败`, e)
          }
        }
        const errMsg = Buffer.concat(errChunks).toString().trim()
        this.logInfo(`ffmpeg [${label}] 失败`, { code, error: errMsg })
        resolve(null)
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timer)
        this.logError(`ffmpeg [${label}] 进程错误`, err)
        resolve(null)
      })
    })
  }

  private looksLikeMd5(s: string): boolean {
    return /^[a-f0-9]{32}$/i.test(s)
  }

  private isThumbnailDat(name: string): boolean {
    const lower = name.toLowerCase()
    return lower.includes('_t.dat') || lower.includes('.t.dat') || lower.includes('_thumb.dat')
  }

  private isHdDatPath(datPath: string): boolean {
    const name = basename(String(datPath || '')).toLowerCase()
    if (!name.endsWith('.dat')) return false
    const stem = name.slice(0, -4)
    return (
      stem.endsWith('_h') ||
      stem.endsWith('.h') ||
      stem.endsWith('_hd') ||
      stem.endsWith('.hd')
    )
  }

  private isTVariantDat(datPath: string): boolean {
    const name = basename(String(datPath || '')).toLowerCase()
    return this.isThumbnailDat(name)
  }

  private isBaseDatPath(datPath: string, baseMd5: string): boolean {
    const normalizedBase = String(baseMd5 || '').trim().toLowerCase()
    if (!normalizedBase) return false
    const name = basename(String(datPath || '')).toLowerCase()
    return name === `${normalizedBase}.dat`
  }

  private getDatTier(datPath: string, baseMd5: string): number {
    if (this.isHdDatPath(datPath)) return 3
    if (this.isBaseDatPath(datPath, baseMd5)) return 2
    if (this.isTVariantDat(datPath)) return 1
    return 0
  }

  private getCachedPathTier(cachePath: string): number {
    if (this.isHdPath(cachePath)) return 3
    const suffix = this.getCacheVariantSuffixFromCachedPath(cachePath)
    if (!suffix) return 2
    const normalized = suffix.toLowerCase()
    if (normalized === '_t' || normalized === '.t' || normalized === '_thumb' || normalized === '.thumb') {
      return 1
    }
    return 1
  }

  private isHdPath(p: string): boolean {
    const raw = String(p || '').split('?')[0]
    const name = basename(raw).toLowerCase()
    const ext = extname(name).toLowerCase()
    const stem = ext ? name.slice(0, -ext.length) : name
    return stem.endsWith('_hd')
  }

  private isThumbnailPath(p: string): boolean {
    const lower = p.toLowerCase()
    return lower.includes('_thumb') || lower.includes('_t') || lower.includes('.t.')
  }

  private sanitizeDirName(s: string): string {
    return s.replace(/[<>:"/\\|?*]/g, '_').trim() || 'unknown'
  }

  private resolveTimeDir(filePath: string): string {
    try {
      const stats = statSync(filePath)
      const d = new Date(stats.mtime)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    } catch {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    }
  }

  private getElectronPath(name: 'userData' | 'documents' | 'temp'): string | null {
    try {
      const getter = (app as unknown as { getPath?: (n: string) => string } | undefined)?.getPath
      if (typeof getter !== 'function') return null
      const value = getter(name)
      return typeof value === 'string' && value.trim() ? value : null
    } catch {
      return null
    }
  }

  private getUserDataPath(): string {
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    if (workerUserDataPath) return workerUserDataPath
    return this.getElectronPath('userData') || process.cwd()
  }

  private getDocumentsPath(): string {
    return this.getElectronPath('documents') || join(homedir(), 'Documents')
  }

  private getTempPath(): string {
    return this.getElectronPath('temp') || tmpdir()
  }

  async clearCache(): Promise<{ success: boolean; error?: string }> {
    this.resolvedCache.clear()
    this.pending.clear()
    this.updateFlags.clear()
    this.accountDirCache.clear()
    this.ensuredDirs.clear()
    this.cacheRootPath = null

    const configured = this.configService.get('cachePath')
    const root = configured
      ? join(configured, 'Images')
      : join(this.getDocumentsPath(), 'WeFlow', 'Images')

    try {
      if (!existsSync(root)) {
        return { success: true }
      }
      const monthPattern = /^\d{4}-\d{2}$/
      const clearFilesInDir = async (dirPath: string): Promise<void> => {
        let entries: Array<{ name: string; isDirectory: () => boolean }>
        try {
          entries = await readdir(dirPath, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory()) {
            await clearFilesInDir(fullPath)
            continue
          }
          try {
            await rm(fullPath, { force: true })
          } catch { }
        }
      }
      const traverse = async (dirPath: string): Promise<void> => {
        let entries: Array<{ name: string; isDirectory: () => boolean }>
        try {
          entries = await readdir(dirPath, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory()) {
            if (monthPattern.test(entry.name)) {
              await clearFilesInDir(fullPath)
            } else {
              await traverse(fullPath)
            }
            continue
          }
          try {
            await rm(fullPath, { force: true })
          } catch { }
        }
      }
      await traverse(root)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const imageDecryptService = new ImageDecryptService()
