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

    if (typeof ffmpegStatic === 'string' && existsSync(ffmpegStatic)) {
      return ffmpegStatic
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

type HardlinkState = {
  imageTable?: string
  dirTable?: string
}

export class ImageDecryptService {
  private configService = new ConfigService()
  private hardlinkCache = new Map<string, HardlinkState>()
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

  async resolveCachedImage(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }): Promise<DecryptResult & { hasUpdate?: boolean }> {
    await this.ensureCacheIndexed()
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }
    for (const key of cacheKeys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        const dataUrl = this.fileToDataUrl(cached)
        const isThumb = this.isThumbnailPath(cached)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          this.triggerUpdateCheck(payload, key, cached)
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, dataUrl || this.filePathToUrl(cached))
        return { success: true, localPath: dataUrl || this.filePathToUrl(cached), hasUpdate }
      }
      if (cached && !this.isImageFile(cached)) {
        this.resolvedCache.delete(key)
      }
    }

    for (const key of cacheKeys) {
      const existing = this.findCachedOutput(key, false, payload.sessionId)
      if (existing) {
        this.cacheResolvedPaths(key, payload.imageMd5, payload.imageDatName, existing)
        const dataUrl = this.fileToDataUrl(existing)
        const isThumb = this.isThumbnailPath(existing)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          this.triggerUpdateCheck(payload, key, existing)
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, dataUrl || this.filePathToUrl(existing))
        return { success: true, localPath: dataUrl || this.filePathToUrl(existing), hasUpdate }
      }
    }
    this.logInfo('未找到缓存', { md5: payload.imageMd5, datName: payload.imageDatName })
    return { success: false, error: '未找到缓存图片' }
  }

  async decryptImage(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }): Promise<DecryptResult> {
    await this.ensureCacheIndexed()
    const cacheKey = payload.imageMd5 || payload.imageDatName
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }

    if (!payload.force) {
      const cached = this.resolvedCache.get(cacheKey)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        const dataUrl = this.fileToDataUrl(cached)
        const localPath = dataUrl || this.filePathToUrl(cached)
        this.emitCacheResolved(payload, cacheKey, localPath)
        return { success: true, localPath }
      }
      if (cached && !this.isImageFile(cached)) {
        this.resolvedCache.delete(cacheKey)
      }
    }

    const pending = this.pending.get(cacheKey)
    if (pending) return pending

    const task = this.decryptImageInternal(payload, cacheKey)
    this.pending.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.pending.delete(cacheKey)
    }
  }

  private async decryptImageInternal(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean },
    cacheKey: string
  ): Promise<DecryptResult> {
    this.logInfo('开始解密图片', { md5: payload.imageMd5, datName: payload.imageDatName, force: payload.force })
    try {
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!wxid || !dbPath) {
        this.logError('配置缺失', undefined, { wxid: !!wxid, dbPath: !!dbPath })
        return { success: false, error: '未配置账号或数据库路径' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
        this.logError('未找到账号目录', undefined, { dbPath, wxid })
        return { success: false, error: '未找到账号目录' }
      }

      const datPath = await this.resolveDatPath(
        accountDir,
        payload.imageMd5,
        payload.imageDatName,
        payload.sessionId,
        { allowThumbnail: !payload.force, skipResolvedCache: Boolean(payload.force) }
      )

      // 如果要求高清图但没找到，直接返回提示
      if (!datPath && payload.force) {
        this.logError('未找到高清图', undefined, { md5: payload.imageMd5, datName: payload.imageDatName })
        return { success: false, error: '未找到高清图，请在微信中点开该图片查看后重试' }
      }
      if (!datPath) {
        this.logError('未找到DAT文件', undefined, { md5: payload.imageMd5, datName: payload.imageDatName })
        return { success: false, error: '未找到图片文件' }
      }

      this.logInfo('找到DAT文件', { datPath })

      if (!extname(datPath).toLowerCase().includes('dat')) {
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, datPath)
        const dataUrl = this.fileToDataUrl(datPath)
        const localPath = dataUrl || this.filePathToUrl(datPath)
        const isThumb = this.isThumbnailPath(datPath)
        this.emitCacheResolved(payload, cacheKey, localPath)
        return { success: true, localPath, isThumb }
      }

      // 查找已缓存的解密文件
      const existing = this.findCachedOutput(cacheKey, payload.force, payload.sessionId)
      if (existing) {
        this.logInfo('找到已解密文件', { existing, isHd: this.isHdPath(existing) })
        const isHd = this.isHdPath(existing)
        // 如果要求高清但找到的是缩略图，继续解密高清图
        if (!(payload.force && !isHd)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
          const dataUrl = this.fileToDataUrl(existing)
          const localPath = dataUrl || this.filePathToUrl(existing)
          const isThumb = this.isThumbnailPath(existing)
          this.emitCacheResolved(payload, cacheKey, localPath)
          return { success: true, localPath, isThumb }
        }
      }

      const xorKeyRaw = this.configService.get('imageXorKey') as unknown
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
        return { success: false, error: '未配置图片解密密钥' }
      }

      const aesKeyRaw = this.configService.get('imageAesKey')
      const aesKey = this.resolveAesKey(aesKeyRaw)

      this.logInfo('开始解密DAT文件', { datPath, xorKey, hasAesKey: !!aesKey })
      let decrypted = await this.decryptDatAuto(datPath, xorKey, aesKey)

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
      await writeFile(outputPath, decrypted)
      this.logInfo('解密成功', { outputPath, size: decrypted.length })

      // 对于 hevc 格式，返回错误提示
      if (finalExt === '.hevc') {
        return {
          success: false,
          error: '此图片为微信新格式(wxgf)，需要安装 ffmpeg 才能显示',
          isThumb: this.isThumbnailPath(datPath)
        }
      }
      const isThumb = this.isThumbnailPath(datPath)
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
      if (!isThumb) {
        this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      }
      const dataUrl = this.bufferToDataUrl(decrypted, finalExt)
      const localPath = dataUrl || this.filePathToUrl(outputPath)
      this.emitCacheResolved(payload, cacheKey, localPath)
      return { success: true, localPath, isThumb }
    } catch (e) {
      this.logError('解密失败', e, { md5: payload.imageMd5, datName: payload.imageDatName })
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
    options?: { allowThumbnail?: boolean; skipResolvedCache?: boolean }
  ): Promise<string | null> {
    const allowThumbnail = options?.allowThumbnail ?? true
    const skipResolvedCache = options?.skipResolvedCache ?? false
    this.logInfo('[ImageDecrypt] resolveDatPath', {
      accountDir,
      imageMd5,
      imageDatName,
      sessionId,
      allowThumbnail,
      skipResolvedCache
    })

    // 优先通过 hardlink.db 查询
    if (imageMd5) {
      this.logInfo('[ImageDecrypt] hardlink lookup (md5)', { imageMd5, sessionId })
      const hardlinkPath = await this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath) {
        const isThumb = this.isThumbnailPath(hardlinkPath)
        if (allowThumbnail || !isThumb) {
          this.logInfo('[ImageDecrypt] hardlink hit', { imageMd5, path: hardlinkPath })
          this.cacheDatPath(accountDir, imageMd5, hardlinkPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        // 尝试在同一目录下查找高清图变体（快速查找，不遍历）
        const hdPath = this.findHdVariantInSameDir(hardlinkPath)
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
          const isThumb = this.isThumbnailPath(fallbackPath)
          if (allowThumbnail || !isThumb) {
            this.logInfo('[ImageDecrypt] hardlink hit (datName)', { imageMd5: imageDatName, path: fallbackPath })
            this.cacheDatPath(accountDir, imageDatName, fallbackPath)
            return fallbackPath
          }
          // 找到缩略图但要求高清图，尝试同目录查找高清图变体
          const hdPath = this.findHdVariantInSameDir(fallbackPath)
          if (hdPath) {
            this.cacheDatPath(accountDir, imageDatName, hdPath)
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
        const isThumb = this.isThumbnailPath(hardlinkPath)
        if (allowThumbnail || !isThumb) {
          this.logInfo('[ImageDecrypt] hardlink hit', { imageMd5: imageDatName, path: hardlinkPath })
          this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        const hdPath = this.findHdVariantInSameDir(hardlinkPath)
        if (hdPath) {
          this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        return null
      }
      this.logInfo('[ImageDecrypt] hardlink miss (datName)', { imageDatName })
    }

    // 如果要求高清图但 hardlink 没找到，也不要搜索了（搜索太慢）
    if (!allowThumbnail) {
      return null
    }

    if (!imageDatName) return null
    if (!skipResolvedCache) {
      const cached = this.resolvedCache.get(imageDatName)
      if (cached && existsSync(cached)) {
        if (allowThumbnail || !this.isThumbnailPath(cached)) return cached
        // 缓存的是缩略图，尝试找高清图
        const hdPath = this.findHdVariantInSameDir(cached)
        if (hdPath) return hdPath
      }
    }

    const datPath = await this.searchDatFile(accountDir, imageDatName, allowThumbnail)
    if (datPath) {
      this.logInfo('[ImageDecrypt] searchDatFile hit', { imageDatName, path: datPath })
      this.resolvedCache.set(imageDatName, datPath)
      this.cacheDatPath(accountDir, imageDatName, datPath)
      return datPath
    }
    const normalized = this.normalizeDatBase(imageDatName)
    if (normalized !== imageDatName.toLowerCase()) {
      const normalizedPath = await this.searchDatFile(accountDir, normalized, allowThumbnail)
      if (normalizedPath) {
        this.logInfo('[ImageDecrypt] searchDatFile hit (normalized)', { imageDatName, normalized, path: normalizedPath })
        this.resolvedCache.set(imageDatName, normalizedPath)
        this.cacheDatPath(accountDir, imageDatName, normalizedPath)
        return normalizedPath
      }
    }
    this.logInfo('[ImageDecrypt] resolveDatPath miss', { imageDatName, normalized })
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

  private looksLikeMd5(value: string): boolean {
    return /^[a-fA-F0-9]{16,32}$/.test(value)
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
      const hardlinkPath = this.resolveHardlinkDbPath(accountDir)
      if (!hardlinkPath) {
        return null
      }

      const ready = await this.ensureWcdbReady()
      if (!ready) {
        this.logInfo('[ImageDecrypt] hardlink db not ready')
        return null
      }

      const state = await this.getHardlinkState(accountDir, hardlinkPath)
      if (!state.imageTable) {
        this.logInfo('[ImageDecrypt] hardlink table missing', { hardlinkPath })
        return null
      }

      const escapedMd5 = this.escapeSqlString(md5)
      const rowResult = await wcdbService.execQuery(
        'media',
        hardlinkPath,
        `SELECT dir1, dir2, file_name FROM ${state.imageTable} WHERE lower(md5) = lower('${escapedMd5}') LIMIT 1`
      )
      const row = rowResult.success && rowResult.rows ? rowResult.rows[0] : null

      if (!row) {
        this.logInfo('[ImageDecrypt] hardlink row miss', { md5, table: state.imageTable })
        return null
      }

      const dir1 = this.getRowValue(row, 'dir1')
      const dir2 = this.getRowValue(row, 'dir2')
      const fileName = this.getRowValue(row, 'file_name') ?? this.getRowValue(row, 'fileName')
      if (dir1 === undefined || dir2 === undefined || !fileName) {
        this.logInfo('[ImageDecrypt] hardlink row incomplete', { row })
        return null
      }

      const lowerFileName = fileName.toLowerCase()
      if (lowerFileName.endsWith('.dat')) {
        const baseLower = lowerFileName.slice(0, -4)
        if (!this.isLikelyImageDatBase(baseLower) && !this.looksLikeMd5(baseLower)) {
          this.logInfo('[ImageDecrypt] hardlink fileName rejected', { fileName })
          return null
        }
      }

      // dir1 和 dir2 是 rowid，需要从 dir2id 表查询对应的目录名
      let dir1Name: string | null = null
      let dir2Name: string | null = null

      if (state.dirTable) {
        try {
          // 通过 rowid 查询目录名
          const dir1Result = await wcdbService.execQuery(
            'media',
            hardlinkPath,
            `SELECT username FROM ${state.dirTable} WHERE rowid = ${Number(dir1)} LIMIT 1`
          )
          if (dir1Result.success && dir1Result.rows && dir1Result.rows.length > 0) {
            const value = this.getRowValue(dir1Result.rows[0], 'username')
            if (value) dir1Name = String(value)
          }

          const dir2Result = await wcdbService.execQuery(
            'media',
            hardlinkPath,
            `SELECT username FROM ${state.dirTable} WHERE rowid = ${Number(dir2)} LIMIT 1`
          )
          if (dir2Result.success && dir2Result.rows && dir2Result.rows.length > 0) {
            const value = this.getRowValue(dir2Result.rows[0], 'username')
            if (value) dir2Name = String(value)
          }
        } catch {
          // ignore
        }
      }

      if (!dir1Name || !dir2Name) {
        this.logInfo('[ImageDecrypt] hardlink dir resolve miss', { dir1, dir2, dir1Name, dir2Name })
        return null
      }

      // 构建路径: msg/attach/{dir1Name}/{dir2Name}/Img/{fileName}
      const possiblePaths = [
        join(accountDir, 'msg', 'attach', dir1Name, dir2Name, 'Img', fileName),
        join(accountDir, 'msg', 'attach', dir1Name, dir2Name, 'mg', fileName),
        join(accountDir, 'msg', 'attach', dir1Name, dir2Name, fileName),
      ]

      for (const fullPath of possiblePaths) {
        if (existsSync(fullPath)) {
          this.logInfo('[ImageDecrypt] hardlink path hit', { fullPath })
          return fullPath
        }
      }

      this.logInfo('[ImageDecrypt] hardlink path miss', { possiblePaths })
      return null
    } catch {
      // ignore
    }
    return null
  }

  private async getHardlinkState(accountDir: string, hardlinkPath: string): Promise<HardlinkState> {
    const cached = this.hardlinkCache.get(hardlinkPath)
    if (cached) return cached

    const imageResult = await wcdbService.execQuery(
      'media',
      hardlinkPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'image_hardlink_info%' ORDER BY name DESC LIMIT 1"
    )
    const dirResult = await wcdbService.execQuery(
      'media',
      hardlinkPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1"
    )
    const imageTable = imageResult.success && imageResult.rows && imageResult.rows.length > 0
      ? this.getRowValue(imageResult.rows[0], 'name')
      : undefined
    const dirTable = dirResult.success && dirResult.rows && dirResult.rows.length > 0
      ? this.getRowValue(dirResult.rows[0], 'name')
      : undefined
    const state: HardlinkState = {
      imageTable: imageTable ? String(imageTable) : undefined,
      dirTable: dirTable ? String(dirTable) : undefined
    }
    this.logInfo('[ImageDecrypt] hardlink state', { hardlinkPath, imageTable: state.imageTable, dirTable: state.dirTable })
    this.hardlinkCache.set(hardlinkPath, state)
    return state
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
      if (allowThumbnail || !this.isThumbnailPath(cached)) return cached
    }

    const root = join(accountDir, 'msg', 'attach')
    if (!existsSync(root)) return null

    // 优化1：快速概率性查找
    // 包含：1. 基于文件名的前缀猜测 (旧版)
    //       2. 基于日期的最近月份扫描 (新版无索引时)
    const fastHit = await this.fastProbabilisticSearch(root, datName)
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
  private async fastProbabilisticSearch(root: string, datName: string): Promise<string | null> {
    const { promises: fs } = require('fs')
    const { join } = require('path')

    try {
      // --- 策略 A: 旧版路径猜测 (msg/attach/xx/yy/...) ---
      const lowerName = datName.toLowerCase()
      let baseName = lowerName
      if (baseName.endsWith('.dat')) {
        baseName = baseName.slice(0, -4)
        if (baseName.endsWith('_t') || baseName.endsWith('.t') || baseName.endsWith('_hd')) {
          baseName = baseName.slice(0, -3)
        } else if (baseName.endsWith('_thumb')) {
          baseName = baseName.slice(0, -6)
        }
      }

      const candidates: string[] = []
      if (/^[a-f0-9]{32}$/.test(baseName)) {
        const dir1 = baseName.substring(0, 2)
        const dir2 = baseName.substring(2, 4)
        candidates.push(
          join(root, dir1, dir2, datName),
          join(root, dir1, dir2, 'Img', datName),
          join(root, dir1, dir2, 'mg', datName),
          join(root, dir1, dir2, 'Image', datName)
        )
      }

      for (const path of candidates) {
        try {
          await fs.access(path)
          return path
        } catch { }
      }

      // --- 策略 B: 新版 Session 哈希路径猜测 ---
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        const sessionDirs = entries
          .filter((e: any) => e.isDirectory() && e.name.length === 32 && /^[a-f0-9]+$/i.test(e.name))
          .map((e: any) => e.name)

        if (sessionDirs.length === 0) return null

        const now = new Date()
        const months: string[] = []
        for (let i = 0; i < 2; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
          const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
          months.push(mStr)
        }

        const targetNames = [datName]
        if (baseName !== lowerName) {
          targetNames.push(`${baseName}.dat`)
          targetNames.push(`${baseName}_t.dat`)
          targetNames.push(`${baseName}_thumb.dat`)
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
   * 缩略图: xxx_t.dat -> 高清图: xxx_h.dat 或 xxx.dat
   */
  private findHdVariantInSameDir(thumbPath: string): string | null {
    try {
      const dir = dirname(thumbPath)
      const fileName = basename(thumbPath).toLowerCase()

      // 提取基础名称（去掉 _t.dat 或 .t.dat）
      let baseName = fileName
      if (baseName.endsWith('_t.dat')) {
        baseName = baseName.slice(0, -6)
      } else if (baseName.endsWith('.t.dat')) {
        baseName = baseName.slice(0, -6)
      } else {
        return null
      }

      // 尝试查找高清图变体
      const variants = [
        `${baseName}_h.dat`,
        `${baseName}.h.dat`,
        `${baseName}.dat`
      ]

      for (const variant of variants) {
        const variantPath = join(dir, variant)
        if (existsSync(variantPath)) {
          return variantPath
        }
      }
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

  private matchesDatName(fileName: string, datName: string): boolean {
    const lower = fileName.toLowerCase()
    const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const normalizedBase = this.normalizeDatBase(base)
    const normalizedTarget = this.normalizeDatBase(datName.toLowerCase())
    if (normalizedBase === normalizedTarget) return true
    const pattern = new RegExp(`^${datName}(?:[._][a-z])?\\.dat$`, 'i')
    if (pattern.test(lower)) return true
    return lower.endsWith('.dat') && lower.includes(datName)
  }

  private scoreDatName(fileName: string): number {
    if (fileName.includes('.t.dat') || fileName.includes('_t.dat')) return 1
    if (fileName.includes('.c.dat') || fileName.includes('_c.dat')) return 1
    return 2
  }

  private isThumbnailDat(fileName: string): boolean {
    return fileName.includes('.t.dat') || fileName.includes('_t.dat')
  }

  private hasXVariant(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private isThumbnailPath(filePath: string): boolean {
    const lower = basename(filePath).toLowerCase()
    if (this.isThumbnailDat(lower)) return true
    const ext = extname(lower)
    const base = ext ? lower.slice(0, -ext.length) : lower
    // 支持新命名 _thumb 和旧命名 _t
    return base.endsWith('_t') || base.endsWith('_thumb')
  }

  private isHdPath(filePath: string): boolean {
    const lower = basename(filePath).toLowerCase()
    const ext = extname(lower)
    const base = ext ? lower.slice(0, -ext.length) : lower
    return base.endsWith('_hd') || base.endsWith('_h')
  }

  private hasImageVariantSuffix(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private isLikelyImageDatBase(baseLower: string): boolean {
    return this.hasImageVariantSuffix(baseLower) || this.looksLikeMd5(baseLower)
  }

  private normalizeDatBase(name: string): string {
    let base = name.toLowerCase()
    if (base.endsWith('.dat') || base.endsWith('.jpg')) {
      base = base.slice(0, -4)
    }
    while (/[._][a-z]$/.test(base)) {
      base = base.slice(0, -2)
    }
    return base
  }

  private sanitizeDirName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return 'unknown'
    return trimmed.replace(/[<>:"/\\|?*]/g, '_')
  }

  private resolveTimeDir(datPath: string): string {
    const parts = datPath.split(/[\\/]+/)
    for (const part of parts) {
      if (/^\d{4}-\d{2}$/.test(part)) return part
    }
    try {
      const stat = statSync(datPath)
      const year = stat.mtime.getFullYear()
      const month = String(stat.mtime.getMonth() + 1).padStart(2, '0')
      return `${year}-${month}`
    } catch {
      return 'unknown-time'
    }
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
    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      return null
    }
    const target = this.normalizeDatBase(baseName.toLowerCase())
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      if (!lower.endsWith('.dat')) continue
      if (this.isThumbnailDat(lower)) continue
      const baseLower = lower.slice(0, -4)
      // 只排除没有 _x 变体后缀的文件（允许 _hd、_h 等所有带变体的）
      if (!this.hasXVariant(baseLower)) continue
      if (this.normalizeDatBase(baseLower) !== target) continue
      return join(dirPath, entry)
    }
    return null
  }

  private isNonThumbnailVariantDat(datPath: string): boolean {
    const lower = basename(datPath).toLowerCase()
    if (!lower.endsWith('.dat')) return false
    if (this.isThumbnailDat(lower)) return false
    const baseLower = lower.slice(0, -4)
    // 只检查是否有 _x 变体后缀（允许 _hd、_h 等所有带变体的）
    return this.hasXVariant(baseLower)
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

  private async ensureCacheIndexed(): Promise<void> {
    if (this.cacheIndexed) return
    if (this.cacheIndexing) return this.cacheIndexing
    this.cacheIndexing = new Promise((resolve) => {
      // 扫描所有可能的缓存根目录
      const allRoots = this.getAllCacheRoots()
      this.logInfo('开始索引缓存', { roots: allRoots.length })

      for (const root of allRoots) {
        try {
          this.indexCacheDir(root, 3, 0) // 增加深度到3，支持 sessionId/YYYY-MM 结构
        } catch (e) {
          this.logError('索引目录失败', e, { root })
        }
      }

      this.logInfo('缓存索引完成', { entries: this.resolvedCache.size })
      this.cacheIndexed = true
      this.cacheIndexing = null
      resolve()
    })
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
      throw new Error('需要4个字节')
    }
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  asciiKey16(keyString: string): Buffer {
    if (keyString.length < 16) {
      throw new Error('AES密钥至少需要16个字符')
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
    if (!hevcData || hevcData.length < 100) {
      return { data: buffer, isWxgf: true }
    }

    // 尝试用 ffmpeg 转换
    try {
      const jpgData = await this.convertHevcToJpg(hevcData)
      if (jpgData && jpgData.length > 0) {
        return { data: jpgData, isWxgf: false }
      }
    } catch {
      // ffmpeg 转换失败
    }

    return { data: hevcData, isWxgf: true }
  }

  /**
   * 从 wxgf 数据中提取 HEVC NALU 裸流
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
  private convertHevcToJpg(hevcData: Buffer): Promise<Buffer | null> {
    const ffmpeg = this.getFfmpegPath()
    this.logInfo('ffmpeg 转换开始', { ffmpegPath: ffmpeg, hevcSize: hevcData.length })

    return new Promise((resolve) => {
      const { spawn } = require('child_process')
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const proc = spawn(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'hevc',
        '-i', 'pipe:0',
        '-vframes', '1',
        '-q:v', '3',
        '-f', 'mjpeg',
        'pipe:1'
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

      proc.on('close', (code: number) => {
        if (code === 0 && chunks.length > 0) {
          this.logInfo('ffmpeg 转换成功', { outputSize: Buffer.concat(chunks).length })
          resolve(Buffer.concat(chunks))
        } else {
          const errMsg = Buffer.concat(errChunks).toString()
          this.logInfo('ffmpeg 转换失败', { code, error: errMsg })
          resolve(null)
        }
      })

      proc.on('error', (err: Error) => {
        this.logInfo('ffmpeg 进程错误', { error: err.message })
        resolve(null)
      })

      proc.stdin.write(hevcData)
      proc.stdin.end()
    })
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
        throw new Error('V4版本需要16字节AES密钥')
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
    this.hardlinkCache.clear()
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
