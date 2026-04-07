import { app, BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, appendFileSync } from 'fs'
import { writeFile, rm, readdir } from 'fs/promises'
import crypto from 'crypto'
import { Worker } from 'worker_threads'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

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
    if (app.isPackaged) {
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
  isThumb?: boolean  // 是否是缩略图（没有高清图时返回缩略图）
}

type DecryptProgressStage = 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'

type CachedImagePayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
  preferFilePath?: boolean
  disableUpdateCheck?: boolean
  allowCacheIndex?: boolean
}

type DecryptImagePayload = CachedImagePayload & {
  force?: boolean
  hardlinkOnly?: boolean
}

export class ImageDecryptService {
  private configService = new ConfigService()
  private resolvedCache = new Map<string, string>()
  private pending = new Map<string, Promise<DecryptResult>>()
  private readonly defaultV1AesKey = 'cfcd208495d565ef'
  private cacheIndexed = false
  private cacheIndexing: Promise<void> | null = null
  private updateFlags = new Map<string, boolean>()

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (!this.configService.get('logEnabled')) return
    const timestamp = new Date().toISOString()
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
    const logLine = `[${timestamp}] [ImageDecrypt] ${message}${metaStr}\n`

    // 只写入文件，不输出到控制台
    this.writeLog(logLine)
  }

  private logError(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    if (!this.configService.get('logEnabled')) return
    const timestamp = new Date().toISOString()
    const errorStr = error ? ` Error: ${String(error)}` : ''
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
    const logLine = `[${timestamp}] [ImageDecrypt] ERROR: ${message}${errorStr}${metaStr}\n`

    // 同时输出到控制台
    console.error(message, error, meta)

    // 写入日志文件
    this.writeLog(logLine)
  }

  private writeLog(line: string): void {
    try {
      const logDir = join(app.getPath('userData'), 'logs')
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true })
      }
      appendFileSync(join(logDir, 'wcdb.log'), line, { encoding: 'utf8' })
    } catch (err) {
      console.error('写入日志失败:', err)
    }
  }

  async resolveCachedImage(payload: CachedImagePayload): Promise<DecryptResult & { hasUpdate?: boolean }> {
    if (payload.allowCacheIndex !== false) {
      await this.ensureCacheIndexed()
    }
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }
    for (const key of cacheKeys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        const localPath = this.resolveLocalPathForPayload(cached, payload.preferFilePath)
        const isThumb = this.isThumbnailPath(cached)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          if (!payload.disableUpdateCheck) {
            this.triggerUpdateCheck(payload, key, cached)
          }
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, this.resolveEmitPath(cached, payload.preferFilePath))
        return { success: true, localPath, hasUpdate }
      }
      if (cached && !this.isImageFile(cached)) {
        this.resolvedCache.delete(key)
      }
    }

    for (const key of cacheKeys) {
      const existing = this.findCachedOutput(key, false, payload.sessionId)
      if (existing) {
        this.cacheResolvedPaths(key, payload.imageMd5, payload.imageDatName, existing)
        const localPath = this.resolveLocalPathForPayload(existing, payload.preferFilePath)
        const isThumb = this.isThumbnailPath(existing)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          if (!payload.disableUpdateCheck) {
            this.triggerUpdateCheck(payload, key, existing)
          }
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, this.resolveEmitPath(existing, payload.preferFilePath))
        return { success: true, localPath, hasUpdate }
      }
    }
    this.logInfo('未找到缓存', { md5: payload.imageMd5, datName: payload.imageDatName })
    return { success: false, error: '未找到缓存图片' }
  }

  async decryptImage(payload: DecryptImagePayload): Promise<DecryptResult> {
    if (!payload.hardlinkOnly) {
      await this.ensureCacheIndexed()
    }
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }
    this.emitDecryptProgress(payload, cacheKey, 'queued', 4, 'running')

    if (payload.force) {
      for (const key of cacheKeys) {
        const cached = this.resolvedCache.get(key)
        if (cached && existsSync(cached) && this.isImageFile(cached) && !this.isThumbnailPath(cached)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, cached)
          this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
          const localPath = this.resolveLocalPathForPayload(cached, payload.preferFilePath)
          this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(cached, payload.preferFilePath))
          this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
          return { success: true, localPath }
        }
        if (cached && !this.isImageFile(cached)) {
          this.resolvedCache.delete(key)
        }
      }

      if (!payload.hardlinkOnly) {
        for (const key of cacheKeys) {
          const existingHd = this.findCachedOutput(key, true, payload.sessionId)
          if (!existingHd || this.isThumbnailPath(existingHd)) continue
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existingHd)
          this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
          const localPath = this.resolveLocalPathForPayload(existingHd, payload.preferFilePath)
          this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(existingHd, payload.preferFilePath))
          this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
          return { success: true, localPath }
        }
      }
    }

    if (!payload.force) {
      const cached = this.resolvedCache.get(cacheKey)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        const localPath = this.resolveLocalPathForPayload(cached, payload.preferFilePath)
        this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(cached, payload.preferFilePath))
        this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
        return { success: true, localPath }
      }
      if (cached && !this.isImageFile(cached)) {
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

    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    if (!wxid || !dbPath) return

    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return

    try {
      const ready = await this.ensureWcdbReady()
      if (!ready) return
      const requests = normalizedList.map((md5) => ({ md5, accountDir }))
      const result = await wcdbService.resolveImageHardlinkBatch(requests)
      if (!result.success || !Array.isArray(result.rows)) return

      for (const row of result.rows) {
        const md5 = String(row?.md5 || '').trim().toLowerCase()
        if (!md5) continue
        const fullPath = String(row?.data?.full_path || '').trim()
        if (!fullPath || !existsSync(fullPath)) continue
        this.cacheDatPath(accountDir, md5, fullPath)
        const fileName = String(row?.data?.file_name || '').trim().toLowerCase()
        if (fileName) {
          this.cacheDatPath(accountDir, fileName, fullPath)
        }
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
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!wxid || !dbPath) {
        this.logError('配置缺失', undefined, { wxid: !!wxid, dbPath: !!dbPath })
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '配置缺失')
        return { success: false, error: '未配置账号或数据库路径' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
        this.logError('未找到账号目录', undefined, { dbPath, wxid })
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '账号目录缺失')
        return { success: false, error: '未找到账号目录' }
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
          {
            allowThumbnail: false,
            skipResolvedCache: true,
            hardlinkOnly: payload.hardlinkOnly === true
          }
        )
        if (!datPath) {
          datPath = await this.resolveDatPath(
            accountDir,
            payload.imageMd5,
            payload.imageDatName,
            payload.sessionId,
            {
              allowThumbnail: true,
              skipResolvedCache: true,
              hardlinkOnly: payload.hardlinkOnly === true
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
          {
            allowThumbnail: true,
            skipResolvedCache: false,
            hardlinkOnly: payload.hardlinkOnly === true
          }
        )
      }

      if (!datPath) {
        this.logError('未找到DAT文件', undefined, { md5: payload.imageMd5, datName: payload.imageDatName })
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', '未找到DAT文件')
        if (usedHdAttempt) {
          return { success: false, error: '未找到图片文件，请在微信中点开该图片后重试' }
        }
        return { success: false, error: '未找到图片文件' }
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

      // 查找已缓存的解密文件（hardlink-only 模式下跳过全缓存目录扫描）
      if (!payload.hardlinkOnly) {
        const existing = this.findCachedOutput(cacheKey, payload.force, payload.sessionId)
        if (existing) {
          this.logInfo('找到已解密文件', { existing, isHd: this.isHdPath(existing) })
          const isHd = this.isHdPath(existing)
          // 如果要求高清但找到的是缩略图，继续解密高清图
          if (!(payload.force && !isHd)) {
            this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
            const localPath = this.resolveLocalPathForPayload(existing, payload.preferFilePath)
            const isThumb = this.isThumbnailPath(existing)
            this.emitCacheResolved(payload, cacheKey, this.resolveEmitPath(existing, payload.preferFilePath))
            this.emitDecryptProgress(payload, cacheKey, 'done', 100, 'done')
            return { success: true, localPath, isThumb }
          }
        }
      }

      // 优先使用当前 wxid 对应的密钥，找不到则回退到全局配置
      const imageKeys = this.configService.getImageKeysForCurrentWxid()
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
        return { success: false, error: '未配置图片解密密钥' }
      }

      const aesKeyRaw = imageKeys.aesKey
      const aesKey = this.resolveAesKey(aesKeyRaw)

      this.logInfo('开始解密DAT文件', { datPath, xorKey, hasAesKey: !!aesKey })
      this.emitDecryptProgress(payload, cacheKey, 'decrypting', 58, 'running')
      let decrypted = await this.decryptDatAuto(datPath, xorKey, aesKey)
      this.emitDecryptProgress(payload, cacheKey, 'decrypting', 78, 'running')

      // 检查是否是 wxgf 格式，如果是则尝试提取真实图片数据
      const wxgfResult = await this.unwrapWxgf(decrypted)
      decrypted = wxgfResult.data

      let ext = this.detectImageExtension(decrypted)

      // 如果是 wxgf 格式且没检测到扩展名
      if (wxgfResult.isWxgf && !ext) {
        ext = '.hevc'
      }

      const finalExt = ext || '.jpg'

      const outputPath = this.getCacheOutputPathFromDat(datPath, finalExt, payload.sessionId)
      this.emitDecryptProgress(payload, cacheKey, 'writing', 90, 'running')
      await writeFile(outputPath, decrypted)
      this.logInfo('解密成功', { outputPath, size: decrypted.length })

      if (finalExt === '.hevc') {
        this.emitDecryptProgress(payload, cacheKey, 'failed', 100, 'error', 'wxgf转换失败')
        return {
          success: false,
          error: '此图片为微信新格式(wxgf)，ffmpeg 转换失败，请检查日志',
          isThumb: this.isThumbnailPath(datPath)
        }
      }

      const isThumb = this.isThumbnailPath(datPath)
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
      if (!isThumb) {
        this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      } else {
        this.triggerUpdateCheck(payload, cacheKey, outputPath)
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
      return { success: false, error: String(e) }
    }
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const cleanedWxid = this.cleanAccountDirName(wxid)
    const normalized = dbPath.replace(/[\\/]+$/, '')

    const direct = join(normalized, cleanedWxid)
    if (existsSync(direct)) return direct

    if (this.isAccountDir(normalized)) return normalized

    try {
      const entries = readdirSync(normalized)
      const lowerWxid = cleanedWxid.toLowerCase()
      for (const entry of entries) {
        const entryPath = join(normalized, entry)
        if (!this.isDirectory(entryPath)) continue
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`)) {
          if (this.isAccountDir(entryPath)) return entryPath
        }
      }
    } catch { }

    return null
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
    options?: { allowThumbnail?: boolean; skipResolvedCache?: boolean; hardlinkOnly?: boolean }
  ): Promise<string | null> {
    const allowThumbnail = options?.allowThumbnail ?? true
    const skipResolvedCache = options?.skipResolvedCache ?? false
    const hardlinkOnly = options?.hardlinkOnly ?? false
    this.logInfo('[ImageDecrypt] resolveDatPath', {
      imageMd5,
      imageDatName,
      allowThumbnail,
      skipResolvedCache,
      hardlinkOnly
    })

    if (!skipResolvedCache) {
      if (imageMd5) {
        const cached = this.resolvedCache.get(imageMd5)
        if (cached && existsSync(cached)) {
          const preferred = this.getPreferredDatVariantPath(cached, allowThumbnail)
          this.cacheDatPath(accountDir, imageMd5, preferred)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, preferred)
          return preferred
        }
      }
      if (imageDatName) {
        const cached = this.resolvedCache.get(imageDatName)
        if (cached && existsSync(cached)) {
          const preferred = this.getPreferredDatVariantPath(cached, allowThumbnail)
          this.cacheDatPath(accountDir, imageDatName, preferred)
          if (imageMd5) this.cacheDatPath(accountDir, imageMd5, preferred)
          return preferred
        }
      }
    }

    // 1. 通过 MD5 快速定位 (MsgAttach 目录)
    if (!hardlinkOnly && allowThumbnail && imageMd5) {
      const res = await this.fastProbabilisticSearch(join(accountDir, 'msg', 'attach'), imageMd5, allowThumbnail)
      if (res) return res
      if (imageDatName && imageDatName !== imageMd5 && this.looksLikeMd5(imageDatName)) {
        const datNameRes = await this.fastProbabilisticSearch(join(accountDir, 'msg', 'attach'), imageDatName, allowThumbnail)
        if (datNameRes) return datNameRes
      }
    }

    // 2. 如果 imageDatName 看起来像 MD5，也尝试快速定位
    if (!hardlinkOnly && allowThumbnail && !imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const res = await this.fastProbabilisticSearch(join(accountDir, 'msg', 'attach'), imageDatName, allowThumbnail)
      if (res) return res
    }

    // 优先通过 hardlink.db 查询
    if (imageMd5) {
      this.logInfo('[ImageDecrypt] hardlink lookup (md5)', { imageMd5, sessionId })
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath) {
        const preferredPath = this.getPreferredDatVariantPath(hardlinkPath, allowThumbnail)
        const isThumb = this.isThumbnailPath(preferredPath)
        if (allowThumbnail || !isThumb) {
          this.logInfo('[ImageDecrypt] hardlink hit', { imageMd5, path: preferredPath })
          this.cacheDatPath(accountDir, imageMd5, preferredPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, preferredPath)
          return preferredPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        // 尝试在同一目录下查找高清图变体（快速查找，不遍历）
        const hdPath = this.findHdVariantInSameDir(preferredPath)
        if (hdPath) {
          this.cacheDatPath(accountDir, imageMd5, hdPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        // 没找到高清图，返回 null（不进行全局搜索）
        return null
      }
      this.logInfo('[ImageDecrypt] hardlink miss (md5)', { imageMd5 })
      if (imageDatName && this.looksLikeMd5(imageDatName) && imageDatName !== imageMd5) {
        this.logInfo('[ImageDecrypt] hardlink fallback (datName)', { imageDatName, sessionId })
        const fallbackPath = await this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
        if (fallbackPath) {
          const preferredPath = this.getPreferredDatVariantPath(fallbackPath, allowThumbnail)
          const isThumb = this.isThumbnailPath(preferredPath)
          if (allowThumbnail || !isThumb) {
            this.logInfo('[ImageDecrypt] hardlink hit (datName)', { imageMd5: imageDatName, path: preferredPath })
            this.cacheDatPath(accountDir, imageDatName, preferredPath)
            this.cacheDatPath(accountDir, imageMd5, preferredPath)
            return preferredPath
          }
          // 找到缩略图但要求高清图，尝试同目录查找高清图变体
          const hdPath = this.findHdVariantInSameDir(preferredPath)
          if (hdPath) {
            this.cacheDatPath(accountDir, imageDatName, hdPath)
            this.cacheDatPath(accountDir, imageMd5, hdPath)
            return hdPath
          }
          return null
        }
        this.logInfo('[ImageDecrypt] hardlink miss (datName)', { imageDatName })
      }
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      this.logInfo('[ImageDecrypt] hardlink lookup (datName)', { imageDatName, sessionId })
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath) {
        const preferredPath = this.getPreferredDatVariantPath(hardlinkPath, allowThumbnail)
        const isThumb = this.isThumbnailPath(preferredPath)
        if (allowThumbnail || !isThumb) {
          this.logInfo('[ImageDecrypt] hardlink hit', { imageMd5: imageDatName, path: preferredPath })
          this.cacheDatPath(accountDir, imageDatName, preferredPath)
          return preferredPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        const hdPath = this.findHdVariantInSameDir(preferredPath)
        if (hdPath) {
          this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        return null
      }
      this.logInfo('[ImageDecrypt] hardlink miss (datName)', { imageDatName })
    }

    if (hardlinkOnly) {
      this.logInfo('[ImageDecrypt] resolveDatPath miss (hardlink-only)', { imageMd5, imageDatName })
      return null
    }

    const searchNames = Array.from(
      new Set([imageDatName, imageMd5].map((item) => String(item || '').trim()).filter(Boolean))
    )
    if (searchNames.length === 0) return null

    if (!skipResolvedCache) {
      for (const searchName of searchNames) {
        const cached = this.resolvedCache.get(searchName)
        if (cached && existsSync(cached)) {
          const preferred = this.getPreferredDatVariantPath(cached, allowThumbnail)
          if (allowThumbnail || !this.isThumbnailPath(preferred)) return preferred
          // 缓存的是缩略图，尝试找高清图
          const hdPath = this.findHdVariantInSameDir(preferred)
          if (hdPath) return hdPath
        }
      }
    }

    for (const searchName of searchNames) {
      const datPath = await this.searchDatFile(accountDir, searchName, allowThumbnail)
      if (datPath) {
        this.logInfo('[ImageDecrypt] searchDatFile hit', { imageDatName, searchName, path: datPath })
        if (imageDatName) this.resolvedCache.set(imageDatName, datPath)
        if (imageMd5) this.resolvedCache.set(imageMd5, datPath)
        this.cacheDatPath(accountDir, searchName, datPath)
        if (imageDatName && imageDatName !== searchName) this.cacheDatPath(accountDir, imageDatName, datPath)
        if (imageMd5 && imageMd5 !== searchName) this.cacheDatPath(accountDir, imageMd5, datPath)
        return datPath
      }
    }

    for (const searchName of searchNames) {
      const normalized = this.normalizeDatBase(searchName)
      if (normalized !== searchName.toLowerCase()) {
        const normalizedPath = await this.searchDatFile(accountDir, normalized, allowThumbnail)
        if (normalizedPath) {
          this.logInfo('[ImageDecrypt] searchDatFile hit (normalized)', { imageDatName, searchName, normalized, path: normalizedPath })
          if (imageDatName) this.resolvedCache.set(imageDatName, normalizedPath)
          if (imageMd5) this.resolvedCache.set(imageMd5, normalizedPath)
          this.cacheDatPath(accountDir, searchName, normalizedPath)
          if (imageDatName && imageDatName !== searchName) this.cacheDatPath(accountDir, imageDatName, normalizedPath)
          if (imageMd5 && imageMd5 !== searchName) this.cacheDatPath(accountDir, imageMd5, normalizedPath)
          return normalizedPath
        }
      }
    }
    this.logInfo('[ImageDecrypt] resolveDatPath miss', { imageDatName, imageMd5, searchNames })
    return null
  }

  private async resolveThumbnailDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string
  ): Promise<string | null> {
    if (imageMd5) {
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageDatName) return null
    return this.searchDatFile(accountDir, imageDatName, true, true)
  }

  private async checkHasUpdate(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    cachedPath: string
  ): Promise<boolean> {
    if (!cachedPath || !existsSync(cachedPath)) return false
    const isThumbnail = this.isThumbnailPath(cachedPath)
    if (!isThumbnail) return false
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    if (!wxid || !dbPath) return false
    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return false

    const quickDir = this.getCachedDatDir(accountDir, payload.imageDatName, payload.imageMd5)
    if (quickDir) {
      const baseName = payload.imageDatName || payload.imageMd5 || cacheKey
      const candidate = this.findNonThumbnailVariantInDir(quickDir, baseName)
      if (candidate) {
        return true
      }
    }

    const thumbPath = await this.resolveThumbnailDatPath(
      accountDir,
      payload.imageMd5,
      payload.imageDatName,
      payload.sessionId
    )
    if (thumbPath) {
      const baseName = payload.imageDatName || payload.imageMd5 || cacheKey
      const candidate = this.findNonThumbnailVariantInDir(dirname(thumbPath), baseName)
      if (candidate) {
        return true
      }
      const searchHit = await this.searchDatFileInDir(dirname(thumbPath), baseName, false)
      if (searchHit && this.isNonThumbnailVariantDat(searchHit)) {
        return true
      }
    }
    return false
  }

  private triggerUpdateCheck(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    cachedPath: string
  ): void {
    if (this.updateFlags.get(cacheKey)) return
    void this.checkHasUpdate(payload, cacheKey, cachedPath).then((hasUpdate) => {
      if (!hasUpdate) return
      this.updateFlags.set(cacheKey, true)
      this.emitImageUpdate(payload, cacheKey)
    }).catch(() => { })
  }



  private resolveHardlinkDbPath(accountDir: string): string | null {
    const wxid = this.configService.get('myWxid')
    const cacheDir = wxid ? this.getDecryptedCacheDir(wxid) : null
    const candidates = [
      join(accountDir, 'db_storage', 'hardlink', 'hardlink.db'),
      join(accountDir, 'hardlink.db'),
      cacheDir ? join(cacheDir, 'hardlink.db') : null
    ].filter(Boolean) as string[]
    this.logInfo('[ImageDecrypt] hardlink db probe', { accountDir, cacheDir, candidates })
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    this.logInfo('[ImageDecrypt] hardlink db missing', { accountDir, cacheDir, candidates })
    return null
  }

  private async resolveHardlinkPath(accountDir: string, md5: string, _sessionId?: string): Promise<string | null> {
    try {
      const ready = await this.ensureWcdbReady()
      if (!ready) {
        this.logInfo('[ImageDecrypt] hardlink db not ready')
        return null
      }

      const resolveResult = await wcdbService.resolveImageHardlink(md5, accountDir)
      if (!resolveResult.success || !resolveResult.data) return null
      const fileName = String(resolveResult.data.file_name || '').trim()
      const fullPath = String(resolveResult.data.full_path || '').trim()
      if (!fileName) return null

      const lowerFileName = String(fileName).toLowerCase()
      if (lowerFileName.endsWith('.dat')) {
        const baseLower = lowerFileName.slice(0, -4)
        if (!this.isLikelyImageDatBase(baseLower) && !this.looksLikeMd5(baseLower)) {
          this.logInfo('[ImageDecrypt] hardlink fileName rejected', { fileName })
          return null
        }
      }

      if (fullPath && existsSync(fullPath)) {
        this.logInfo('[ImageDecrypt] hardlink path hit', { fullPath })
        return fullPath
      }
      this.logInfo('[ImageDecrypt] hardlink path miss', { fullPath, md5 })
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

  private async searchDatFile(
    accountDir: string,
    datName: string,
    allowThumbnail = true,
    thumbOnly = false
  ): Promise<string | null> {
    const key = `${accountDir}|${datName}`
    const cached = this.resolvedCache.get(key)
    if (cached && existsSync(cached)) {
      const preferred = this.getPreferredDatVariantPath(cached, allowThumbnail)
      if (allowThumbnail || !this.isThumbnailPath(preferred)) return preferred
    }

    const root = join(accountDir, 'msg', 'attach')
    if (!existsSync(root)) return null

    // 优化1：快速概率性查找
    // 包含：1. 基于文件名的前缀猜测 (旧版)
    //       2. 基于日期的最近月份扫描 (新版无索引时)
    const fastHit = await this.fastProbabilisticSearch(root, datName, allowThumbnail)
    if (fastHit) {
      this.resolvedCache.set(key, fastHit)
      return fastHit
    }

    // 优化2：兜底扫描 (异步非阻塞)
    const found = await this.walkForDatInWorker(root, datName.toLowerCase(), 8, allowThumbnail, thumbOnly)
    if (found) {
      this.resolvedCache.set(key, found)
      return found
    }
    return null
  }

  /**
   * 基于文件名的哈希特征猜测可能的路径
   * 包含：1. 微信旧版结构 filename.substr(0, 2)/...
   *       2. 微信新版结构 msg/attach/{hash}/{YYYY-MM}/Img/filename
   */
  private async fastProbabilisticSearch(root: string, datName: string, allowThumbnail = true): Promise<string | null> {
    const { promises: fs } = require('fs')
    const { join } = require('path')

    try {
      // --- 策略 A: 旧版路径猜测 (msg/attach/xx/yy/...) ---
      const lowerName = datName.toLowerCase()
      const baseName = this.normalizeDatBase(lowerName)
      const targetNames = this.buildPreferredDatNames(baseName, allowThumbnail)

      const candidates: string[] = []
      if (/^[a-f0-9]{32}$/.test(baseName)) {
        const dir1 = baseName.substring(0, 2)
        const dir2 = baseName.substring(2, 4)
        for (const targetName of targetNames) {
          candidates.push(
            join(root, dir1, dir2, targetName),
            join(root, dir1, dir2, 'Img', targetName),
            join(root, dir1, dir2, 'mg', targetName),
            join(root, dir1, dir2, 'Image', targetName)
          )
        }
      }

      for (const path of candidates) {
        try {
          await fs.access(path)
          return path
        } catch { }
      }

      // --- 绛栫暐 B: 鏂扮増 Session 鍝堝笇璺緞鐚滄祴 ---
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        const sessionDirs = entries
          .filter((e: any) => e.isDirectory() && e.name.length === 32 && /^[a-f0-9]+$/i.test(e.name))
          .map((e: any) => e.name)

        if (sessionDirs.length === 0) return null

        const now = new Date()
        const months: string[] = []
        // Imported mobile history can live in older YYYY-MM buckets; keep this bounded but wider than "recent 2 months".
        for (let i = 0; i < 24; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
          const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
          months.push(mStr)
        }

        const batchSize = 20
        for (let i = 0; i < sessionDirs.length; i += batchSize) {
          const batch = sessionDirs.slice(i, i + batchSize)
          const tasks = batch.map(async (sessDir: string) => {
            for (const month of months) {
              const subDirs = ['Img', 'Image']
              for (const sub of subDirs) {
                const dirPath = join(root, sessDir, month, sub)
                try { await fs.access(dirPath) } catch { continue }
                for (const name of targetNames) {
                  const p = join(dirPath, name)
                  try { await fs.access(p); return p } catch { }
                }
              }
            }
            return null
          })
          const results = await Promise.all(tasks)
          const hit = results.find(r => r !== null)
          if (hit) return hit
        }
      } catch { }

    } catch { }
    return null
  }

  /**
   * 在同一目录下查找高清图变体
   * 优先 `_h`，再回退其他非缩略图变体
   */
  private findHdVariantInSameDir(thumbPath: string): string | null {
    try {
      const dir = dirname(thumbPath)
      const fileName = basename(thumbPath)
      return this.findPreferredDatVariantInDir(dir, fileName, false)
    } catch { }
    return null
  }

  private async searchDatFileInDir(
    dirPath: string,
    datName: string,
    allowThumbnail = true
  ): Promise<string | null> {
    if (!existsSync(dirPath)) return null
    return await this.walkForDatInWorker(dirPath, datName.toLowerCase(), 3, allowThumbnail, false)
  }

  private async walkForDatInWorker(
    root: string,
    datName: string,
    maxDepth = 4,
    allowThumbnail = true,
    thumbOnly = false
  ): Promise<string | null> {
    const workerPath = join(__dirname, 'imageSearchWorker.js')
    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { root, datName, maxDepth, allowThumbnail, thumbOnly }
      })

      const cleanup = () => {
        worker.removeAllListeners()
      }

      worker.on('message', (msg: any) => {
        if (msg && msg.type === 'done') {
          cleanup()
          void worker.terminate()
          resolve(msg.path || null)
          return
        }
        if (msg && msg.type === 'error') {
          cleanup()
          void worker.terminate()
          resolve(null)
        }
      })

      worker.on('error', () => {
        cleanup()
        void worker.terminate()
        resolve(null)
      })
      })
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

  private getDatVariantPriority(name: string): number {
    const lower = name.toLowerCase()
    const baseLower = lower.endsWith('.dat') || lower.endsWith('.jpg') ? lower.slice(0, -4) : lower
    if (baseLower.endsWith('_h') || baseLower.endsWith('.h')) return 600
    if (baseLower.endsWith('_hd') || baseLower.endsWith('.hd')) return 550
    if (baseLower.endsWith('_b') || baseLower.endsWith('.b')) return 520
    if (baseLower.endsWith('_w') || baseLower.endsWith('.w')) return 510
    if (!this.hasXVariant(baseLower)) return 500
    if (baseLower.endsWith('_c') || baseLower.endsWith('.c')) return 400
    if (this.isThumbnailDat(lower)) return 100
    return 350
  }

  private buildPreferredDatNames(baseName: string, allowThumbnail: boolean): string[] {
    if (!baseName) return []
    const names = [
      `${baseName}_h.dat`,
      `${baseName}.h.dat`,
      `${baseName}_hd.dat`,
      `${baseName}.hd.dat`,
      `${baseName}_b.dat`,
      `${baseName}.b.dat`,
      `${baseName}_w.dat`,
      `${baseName}.w.dat`,
      `${baseName}.dat`,
      `${baseName}_c.dat`,
      `${baseName}.c.dat`
    ]
    if (allowThumbnail) {
      names.push(
        `${baseName}_thumb.dat`,
        `${baseName}.thumb.dat`,
        `${baseName}_t.dat`,
        `${baseName}.t.dat`
      )
    }
    return Array.from(new Set(names))
  }

  private findPreferredDatVariantInDir(dirPath: string, baseName: string, allowThumbnail: boolean): string | null {
    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      return null
    }
    const target = this.normalizeDatBase(baseName.toLowerCase())
    let bestPath: string | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      if (!lower.endsWith('.dat')) continue
      if (!allowThumbnail && this.isThumbnailDat(lower)) continue
      const baseLower = lower.slice(0, -4)
      if (this.normalizeDatBase(baseLower) !== target) continue
      const score = this.getDatVariantPriority(lower)
      if (score > bestScore) {
        bestScore = score
        bestPath = join(dirPath, entry)
      }
    }
    return bestPath
  }

  private getPreferredDatVariantPath(datPath: string, allowThumbnail: boolean): string {
    const lower = datPath.toLowerCase()
    if (!lower.endsWith('.dat')) return datPath
    const preferred = this.findPreferredDatVariantInDir(dirname(datPath), basename(datPath), allowThumbnail)
    return preferred || datPath
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

  private hasImageVariantSuffix(baseLower: string): boolean {
    return this.stripDatVariantSuffix(baseLower) !== baseLower
  }

  private isLikelyImageDatBase(baseLower: string): boolean {
    return this.hasImageVariantSuffix(baseLower) || this.looksLikeMd5(this.normalizeDatBase(baseLower))
  }



  private findCachedOutput(cacheKey: string, preferHd: boolean = false, sessionId?: string): string | null {
    const allRoots = this.getAllCacheRoots()
    const normalizedKey = this.normalizeDatBase(cacheKey.toLowerCase())
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    // 遍历所有可能的缓存根路径
    for (const root of allRoots) {
      // 策略1: 新目录结构 Images/{sessionId}/{YYYY-MM}/{file}_hd.jpg
      if (sessionId) {
        const sessionDir = join(root, this.sanitizeDirName(sessionId))
        if (existsSync(sessionDir)) {
          try {
            const dateDirs = readdirSync(sessionDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
              .map(d => d.name)
              .sort()
              .reverse() // 最新的日期优先

            for (const dateDir of dateDirs) {
              const imageDir = join(sessionDir, dateDir)
              const hit = this.findCachedOutputInDir(imageDir, normalizedKey, extensions, preferHd)
              if (hit) return hit
            }
          } catch { }
        }
      }

      // 策略2: 遍历所有 sessionId 目录查找（如果没有指定 sessionId）
      try {
        const sessionDirs = readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)

        for (const session of sessionDirs) {
          const sessionDir = join(root, session)
          // 检查是否是日期目录结构
          try {
            const subDirs = readdirSync(sessionDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
              .map(d => d.name)

            for (const dateDir of subDirs) {
              const imageDir = join(sessionDir, dateDir)
              const hit = this.findCachedOutputInDir(imageDir, normalizedKey, extensions, preferHd)
              if (hit) return hit
            }
          } catch { }
        }
      } catch { }

      // 策略3: 旧目录结构 Images/{normalizedKey}/{normalizedKey}_thumb.jpg
      const oldImageDir = join(root, normalizedKey)
      if (existsSync(oldImageDir)) {
        const hit = this.findCachedOutputInDir(oldImageDir, normalizedKey, extensions, preferHd)
        if (hit) return hit
      }

      // 策略4: 最旧的平铺结构 Images/{file}.jpg
      for (const ext of extensions) {
        const candidate = join(root, `${cacheKey}${ext}`)
        if (existsSync(candidate)) return candidate
      }
      for (const ext of extensions) {
        const candidate = join(root, `${cacheKey}_t${ext}`)
        if (existsSync(candidate)) return candidate
      }
    }

    return null
  }

  private findCachedOutputInDir(
    dirPath: string,
    normalizedKey: string,
    extensions: string[],
    preferHd: boolean
  ): string | null {
    // 先检查并删除旧的 .hevc 文件（ffmpeg 转换失败时遗留的）
    const hevcThumb = join(dirPath, `${normalizedKey}_thumb.hevc`)
    const hevcHd = join(dirPath, `${normalizedKey}_hd.hevc`)
    try {
      if (existsSync(hevcThumb)) {
        require('fs').unlinkSync(hevcThumb)
      }
      if (existsSync(hevcHd)) {
        require('fs').unlinkSync(hevcHd)
      }
    } catch { }

    for (const ext of extensions) {
      if (preferHd) {
        const hdPath = join(dirPath, `${normalizedKey}_hd${ext}`)
        if (existsSync(hdPath)) return hdPath
      }
      const thumbPath = join(dirPath, `${normalizedKey}_thumb${ext}`)
      if (existsSync(thumbPath)) return thumbPath

      // 允许返回 _hd 格式（因为它有 _hd 变体后缀）
      if (!preferHd) {
        const hdPath = join(dirPath, `${normalizedKey}_hd${ext}`)
        if (existsSync(hdPath)) return hdPath
      }
    }
    return null
  }

  private getCacheOutputPathFromDat(datPath: string, ext: string, sessionId?: string): string {
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? name.slice(0, -4) : name

    // 提取基础名称（去掉 _t, _h 等后缀）
    const normalizedBase = this.normalizeDatBase(base)

    // 判断是缩略图还是高清图
    const isThumb = this.isThumbnailDat(lower)
    const suffix = isThumb ? '_thumb' : '_hd'

    const contactDir = this.sanitizeDirName(sessionId || 'unknown')
    const timeDir = this.resolveTimeDir(datPath)
    const outputDir = join(this.getCacheRoot(), contactDir, timeDir)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    return join(outputDir, `${normalizedBase}${suffix}${ext}`)
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

  private getCachedDatDir(accountDir: string, imageDatName?: string, imageMd5?: string): string | null {
    const keys = [
      imageDatName ? `${accountDir}|${imageDatName}` : null,
      imageDatName ? `${accountDir}|${this.normalizeDatBase(imageDatName)}` : null,
      imageMd5 ? `${accountDir}|${imageMd5}` : null
    ].filter(Boolean) as string[]
    for (const key of keys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached)) return dirname(cached)
    }
    return null
  }

  private findNonThumbnailVariantInDir(dirPath: string, baseName: string): string | null {
    return this.findPreferredDatVariantInDir(dirPath, baseName, false)
  }

  private isNonThumbnailVariantDat(datPath: string): boolean {
    const lower = basename(datPath).toLowerCase()
    if (!lower.endsWith('.dat')) return false
    if (this.isThumbnailDat(lower)) return false
    const baseLower = lower.slice(0, -4)
    return this.isLikelyImageDatBase(baseLower)
  }

  private emitImageUpdate(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }, cacheKey: string): void {
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:updateAvailable', message)
      }
    }
  }

  private emitCacheResolved(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }, cacheKey: string, localPath: string): void {
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName, localPath }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:cacheResolved', message)
      }
    }
  }

  private emitDecryptProgress(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    stage: DecryptProgressStage,
    progress: number,
    status: 'running' | 'done' | 'error',
    message?: string
  ): void {
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
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:decryptProgress', event)
      }
    }
  }

  private async ensureCacheIndexed(): Promise<void> {
    if (this.cacheIndexed) return
    if (this.cacheIndexing) return this.cacheIndexing
    this.cacheIndexing = (async () => {
      // 扫描所有可能的缓存根目录
      const allRoots = this.getAllCacheRoots()
      this.logInfo('开始索引缓存', { roots: allRoots.length })

      for (const root of allRoots) {
        try {
          this.indexCacheDir(root, 3, 0) // 增加深度到 3，支持 sessionId/YYYY-MM 结构
        } catch (e) {
          this.logError('索引目录失败', e, { root })
        }
      }

      this.logInfo('缓存索引完成', { entries: this.resolvedCache.size })
      this.cacheIndexed = true
      this.cacheIndexing = null
    })()
    return this.cacheIndexing
  }

  /**
   * 获取所有可能的缓存根路径（用于查找已缓存的图片）
   * 包含当前路径、配置路径、旧版本路径
   */
  private getAllCacheRoots(): string[] {
    const roots: string[] = []
    const configured = this.configService.get('cachePath')
    const documentsPath = app.getPath('documents')

    // 主要路径（当前使用的）
    const mainRoot = this.getCacheRoot()
    roots.push(mainRoot)

    // 如果配置了自定义路径，也检查其下的 Images
    if (configured) {
      roots.push(join(configured, 'Images'))
      roots.push(join(configured, 'images'))
    }

    // 默认路径
    roots.push(join(documentsPath, 'WeFlow', 'Images'))
    roots.push(join(documentsPath, 'WeFlow', 'images'))

    // 兼容旧路径（如果有的话）
    roots.push(join(documentsPath, 'WeFlowData', 'Images'))

    // 去重并过滤存在的路径
    const uniqueRoots = Array.from(new Set(roots))
    const existingRoots = uniqueRoots.filter(r => existsSync(r))

    return existingRoots
  }

  private indexCacheDir(root: string, maxDepth: number, depth: number): void {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      return
    }
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    for (const entry of entries) {
      const fullPath = join(root, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth < maxDepth) {
          this.indexCacheDir(fullPath, maxDepth, depth + 1)
        }
        continue
      }
      if (!stat.isFile()) continue
      const lower = entry.toLowerCase()
      const ext = extensions.find((item) => lower.endsWith(item))
      if (!ext) continue
      const base = entry.slice(0, -ext.length)
      this.addCacheIndex(base, fullPath)
      const normalized = this.normalizeDatBase(base)
      if (normalized && normalized !== base.toLowerCase()) {
        this.addCacheIndex(normalized, fullPath)
      }
    }
  }

  private addCacheIndex(key: string, path: string): void {
    const normalizedKey = key.toLowerCase()
    const existing = this.resolvedCache.get(normalizedKey)
    if (existing) {
      const existingIsThumb = this.isThumbnailPath(existing)
      const candidateIsThumb = this.isThumbnailPath(path)
      if (!existingIsThumb && candidateIsThumb) return
    }
    this.resolvedCache.set(normalizedKey, path)
  }

  private getCacheRoot(): string {
    const configured = this.configService.get('cachePath')
    const root = configured
      ? join(configured, 'Images')
      : join(app.getPath('documents'), 'WeFlow', 'Images')
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true })
    }
    return root
  }

  private resolveAesKey(aesKeyRaw: string): Buffer | null {
    const trimmed = aesKeyRaw?.trim() ?? ''
    if (!trimmed) return null
    return this.asciiKey16(trimmed)
  }

  private async decryptDatAuto(datPath: string, xorKey: number, aesKey: Buffer | null): Promise<Buffer> {
    const version = this.getDatVersion(datPath)

    if (version === 0) {
      return this.decryptDatV3(datPath, xorKey)
    }
    if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      return this.decryptDatV4(datPath, xorKey, key)
    }
    // version === 2
    if (!aesKey || aesKey.length !== 16) {
      throw new Error('请到设置配置图片解密密钥')
    }
    return this.decryptDatV4(datPath, xorKey, aesKey)
  }

  private getDatVersion(inputPath: string): number {
    if (!existsSync(inputPath)) {
      throw new Error('文件不存在')
    }
    const bytes = readFileSync(inputPath)
    if (bytes.length < 6) {
      return 0
    }
    const signature = bytes.subarray(0, 6)
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]))) {
      return 1
    }
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]))) {
      return 2
    }
    return 0
  }

  private decryptDatV3(inputPath: string, xorKey: number): Buffer {
    const data = readFileSync(inputPath)
    const out = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i += 1) {
      out[i] = data[i] ^ xorKey
    }
    return out
  }

  private decryptDatV4(inputPath: string, xorKey: number, aesKey: Buffer): Buffer {
    const bytes = readFileSync(inputPath)
    if (bytes.length < 0x0f) {
      throw new Error('文件太小，无法解析')
    }

    const header = bytes.subarray(0, 0x0f)
    const data = bytes.subarray(0x0f)
    const aesSize = this.bytesToInt32(header.subarray(6, 10))
    const xorSize = this.bytesToInt32(header.subarray(10, 14))

    // AES 数据需要对齐到 16 字节（PKCS7 填充）
    // 当 aesSize % 16 === 0 时，仍需要额外 16 字节的填充
    const remainder = ((aesSize % 16) + 16) % 16
    const alignedAesSize = aesSize + (16 - remainder)

    if (alignedAesSize > data.length) {
      throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
    }

    const aesData = data.subarray(0, alignedAesSize)
    let unpadded: Buffer = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])

      // 使用 PKCS7 填充移除
      unpadded = this.strictRemovePadding(decrypted)
    }

    const remaining = data.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) {
      throw new Error('文件格式异常：XOR 数据长度不合法')
    }

    let rawData = Buffer.alloc(0)
    let xoredData = Buffer.alloc(0)
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) {
        throw new Error('文件格式异常：原始数据长度小于XOR长度')
      }
      rawData = remaining.subarray(0, rawLength)
      const xorData = remaining.subarray(rawLength)
      xoredData = Buffer.alloc(xorData.length)
      for (let i = 0; i < xorData.length; i += 1) {
        xoredData[i] = xorData[i] ^ xorKey
      }
    } else {
      rawData = remaining
      xoredData = Buffer.alloc(0)
    }

    return Buffer.concat([unpadded, rawData, xoredData])
  }

  private bytesToInt32(bytes: Buffer): number {
    if (bytes.length !== 4) {
      throw new Error('需要 4 个字节')
    }
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  asciiKey16(keyString: string): Buffer {
    if (keyString.length < 16) {
      throw new Error('AES密钥至少需要 16 个字符')
    }
    return Buffer.from(keyString, 'ascii').subarray(0, 16)
  }

  private strictRemovePadding(data: Buffer): Buffer {
    if (!data.length) {
      throw new Error('解密结果为空，填充非法')
    }
    const paddingLength = data[data.length - 1]
    if (paddingLength === 0 || paddingLength > 16 || paddingLength > data.length) {
      throw new Error('PKCS7 填充长度非法')
    }
    for (let i = data.length - paddingLength; i < data.length; i += 1) {
      if (data[i] !== paddingLength) {
        throw new Error('PKCS7 填充内容非法')
      }
    }
    return data.subarray(0, data.length - paddingLength)
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

  private compareBytes(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  // 保留原有的批量检测 XOR 密钥方法（用于兼容）
  async batchDetectXorKey(dirPath: string, maxFiles: number = 100): Promise<number | null> {
    const keyCount: Map<number, number> = new Map()
    let filesChecked = 0

    const V1_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07])
    const V2_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    const IMAGE_SIGNATURES: { [key: string]: Buffer } = {
      jpg: Buffer.from([0xFF, 0xD8, 0xFF]),
      png: Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      gif: Buffer.from([0x47, 0x49, 0x46, 0x38]),
      bmp: Buffer.from([0x42, 0x4D]),
      webp: Buffer.from([0x52, 0x49, 0x46, 0x46])
    }

    const detectXorKeyFromV3 = (header: Buffer): number | null => {
      for (const [, signature] of Object.entries(IMAGE_SIGNATURES)) {
        const xorKey = header[0] ^ signature[0]
        let valid = true
        for (let i = 0; i < signature.length && i < header.length; i++) {
          if ((header[i] ^ xorKey) !== signature[i]) {
            valid = false
            break
          }
        }
        if (valid) return xorKey
      }
      return null
    }

    const scanDir = (dir: string) => {
      if (filesChecked >= maxFiles) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (filesChecked >= maxFiles) return
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            scanDir(fullPath)
          } else if (entry.name.endsWith('.dat')) {
            try {
              const header = Buffer.alloc(16)
              const fd = require('fs').openSync(fullPath, 'r')
              require('fs').readSync(fd, header, 0, 16, 0)
              require('fs').closeSync(fd)

              if (header.subarray(0, 6).equals(V1_SIGNATURE) || header.subarray(0, 6).equals(V2_SIGNATURE)) {
                continue
              }

              const key = detectXorKeyFromV3(header)
              if (key !== null) {
                keyCount.set(key, (keyCount.get(key) || 0) + 1)
                filesChecked++
              }
            } catch { }
          }
        }
      } catch { }
    }

    scanDir(dirPath)

    if (keyCount.size === 0) return null

    let maxCount = 0
    let mostCommonKey: number | null = null
    keyCount.forEach((count, key) => {
      if (count > maxCount) {
        maxCount = count
        mostCommonKey = key
      }
    })

    return mostCommonKey
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

    // 提取 HEVC NALU 裸流
    const hevcData = this.extractHevcNalu(buffer)
    // 优先用提取的 NALU 裸流，提取失败则跳过 wxgf 头部直接用原始数据
    const feedData = (hevcData && hevcData.length >= 100) ? hevcData : buffer.subarray(4)
    this.logInfo('unwrapWxgf: 准备 ffmpeg 转换', {
      naluExtracted: !!(hevcData && hevcData.length >= 100),
      feedSize: feedData.length
    })

    // 尝试用 ffmpeg 转换
    try {
      const jpgData = await this.convertHevcToJpg(feedData)
      if (jpgData && jpgData.length > 0) {
        return { data: jpgData, isWxgf: false }
      }
    } catch (e) {
      this.logError('unwrapWxgf: ffmpeg 转换失败', e)
    }

    return { data: feedData, isWxgf: true }
  }

  /**
   * 浠?wxgf 鏁版嵁涓彁鍙?HEVC NALU 瑁告祦
   */
  private extractHevcNalu(buffer: Buffer): Buffer | null {
    const nalUnits: Buffer[] = []
    let i = 4

    while (i < buffer.length - 4) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 &&
        buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
        let nalStart = i
        let nalEnd = buffer.length

        for (let j = i + 4; j < buffer.length - 3; j++) {
          if (buffer[j] === 0x00 && buffer[j + 1] === 0x00) {
            if (buffer[j + 2] === 0x01 ||
              (buffer[j + 2] === 0x00 && j + 3 < buffer.length && buffer[j + 3] === 0x01)) {
              nalEnd = j
              break
            }
          }
        }

        const nalUnit = buffer.subarray(nalStart, nalEnd)
        if (nalUnit.length > 3) {
          nalUnits.push(nalUnit)
        }
        i = nalEnd
      } else {
        i++
      }
    }

    if (nalUnits.length === 0) {
      for (let j = 4; j < buffer.length - 4; j++) {
        if (buffer[j] === 0x00 && buffer[j + 1] === 0x00 &&
          buffer[j + 2] === 0x00 && buffer[j + 3] === 0x01) {
          return buffer.subarray(j)
        }
      }
      return null
    }

    return Buffer.concat(nalUnits)
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

    const tmpDir = join(app.getPath('temp'), 'weflow_hevc')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const ts = Date.now()
    const tmpInput = join(tmpDir, `hevc_${ts}.hevc`)
    const tmpOutput = join(tmpDir, `hevc_${ts}.jpg`)

    try {
      await writeFile(tmpInput, hevcData)

      // 依次尝试: 1) -f hevc 裸流  2) 不指定格式让 ffmpeg 自动检测
      const attempts: { label: string; inputArgs: string[] }[] = [
        { label: 'hevc raw', inputArgs: ['-f', 'hevc', '-i', tmpInput] },
        { label: 'auto detect', inputArgs: ['-i', tmpInput] },
      ]

      for (const attempt of attempts) {
        // 清理上一轮的输出
        try { if (existsSync(tmpOutput)) require('fs').unlinkSync(tmpOutput) } catch {}

        const result = await this.runFfmpegConvert(ffmpeg, attempt.inputArgs, tmpOutput, attempt.label)
        if (result) return result
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

  private runFfmpegConvert(ffmpeg: string, inputArgs: string[], tmpOutput: string, label: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process')
      const errChunks: Buffer[] = []

      const args = [
        '-hide_banner', '-loglevel', 'error',
        ...inputArgs,
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

  private hasXVariant(base: string): boolean {
    const lower = base.toLowerCase()
    return this.stripDatVariantSuffix(lower) !== lower
  }

  private isHdPath(p: string): boolean {
    return p.toLowerCase().includes('_hd') || p.toLowerCase().includes('_h')
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

  // 保留原有的解密到文件方法（用于兼容）
  async decryptToFile(inputPath: string, outputPath: string, xorKey: number, aesKey?: Buffer): Promise<void> {
    const version = this.getDatVersion(inputPath)
    let decrypted: Buffer

    if (version === 0) {
      decrypted = this.decryptDatV3(inputPath, xorKey)
    } else if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      decrypted = this.decryptDatV4(inputPath, xorKey, key)
    } else {
      if (!aesKey || aesKey.length !== 16) {
        throw new Error('V4版本需要 16 字节 AES 密钥')
      }
      decrypted = this.decryptDatV4(inputPath, xorKey, aesKey)
    }

    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    await writeFile(outputPath, decrypted)
  }

  async clearCache(): Promise<{ success: boolean; error?: string }> {
    this.resolvedCache.clear()
    this.pending.clear()
    this.updateFlags.clear()
    this.cacheIndexed = false
    this.cacheIndexing = null

    const configured = this.configService.get('cachePath')
    const root = configured
      ? join(configured, 'Images')
      : join(app.getPath('documents'), 'WeFlow', 'Images')

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
