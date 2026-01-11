import { app, BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import crypto from 'crypto'
import { Worker } from 'worker_threads'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

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
    // 完全禁用ImageDecrypt的详细日志，只保留错误日志
    return
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
        const dataUrl = await this.fileToDataUrl(cached)
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
        const dataUrl = await this.fileToDataUrl(existing)
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
        const dataUrl = await this.fileToDataUrl(cached)
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
    try {
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!wxid || !dbPath) {
        return { success: false, error: '未配置账号或数据库路径' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
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
        return { success: false, error: '未找到高清图，请在微信中点开该图片查看后重试' }
      }
      if (!datPath) {
        return { success: false, error: '未找到图片文件' }
      }

      if (!extname(datPath).toLowerCase().includes('dat')) {
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, datPath)
        const dataUrl = await this.fileToDataUrl(datPath)
        const localPath = dataUrl || this.filePathToUrl(datPath)
        const isThumb = this.isThumbnailPath(datPath)
        this.emitCacheResolved(payload, cacheKey, localPath)
        return { success: true, localPath, isThumb }
      }

      // 查找已缓存的解密文件
      const existing = this.findCachedOutput(cacheKey, payload.force, payload.sessionId)
      if (existing) {
        const isHd = this.isHdPath(existing)
        // 如果要求高清但找到的是缩略图，继续解密高清图
        if (!(payload.force && !isHd)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
          const dataUrl = await this.fileToDataUrl(existing)
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

      const decrypted = await this.decryptDatAuto(datPath, xorKey, aesKey)
      
      const ext = this.detectImageExtension(decrypted) || '.jpg'

      const outputPath = this.getCacheOutputPathFromDat(datPath, ext, payload.sessionId)
      await writeFile(outputPath, decrypted)
      
      const isThumb = this.isThumbnailPath(datPath)
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
      if (!isThumb) {
        this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      }
      const dataUrl = this.bufferToDataUrl(decrypted, ext)
      const localPath = dataUrl || this.filePathToUrl(outputPath)
      this.emitCacheResolved(payload, cacheKey, localPath)
      return { success: true, localPath, isThumb }
    } catch (e) {
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
    } catch {}

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
    if (suffixMatch) return suffixMatch[1]

    return trimmed
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
        // hardlink 找到的是缩略图，但要求高清图，直接返回 null，不再搜索
        if (!allowThumbnail && isThumb) {
          return null
        }
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
          if (!allowThumbnail && isThumb) {
            return null
          }
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
        // hardlink 找到的是缩略图，但要求高清图，直接返回 null
        if (!allowThumbnail && isThumb) {
          return null
        }
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
    }).catch(() => {})
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
    const found = await this.walkForDatInWorker(root, datName.toLowerCase(), 8, allowThumbnail, thumbOnly)
    if (found) {
      this.resolvedCache.set(key, found)
      return found
    }
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
    const root = this.getCacheRoot()
    const normalizedKey = this.normalizeDatBase(cacheKey.toLowerCase())
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    if (sessionId) {
      const sessionDir = join(root, this.sanitizeDirName(sessionId))
      if (existsSync(sessionDir)) {
        try {
          const sessionEntries = readdirSync(sessionDir)
          for (const entry of sessionEntries) {
            const timeDir = join(sessionDir, entry)
            if (!this.isDirectory(timeDir)) continue
            const hit = this.findCachedOutputInDir(timeDir, normalizedKey, extensions, preferHd)
            if (hit) return hit
          }
        } catch {
          // ignore
        }
      }
    }
    
    // 新目录结构: Images/{normalizedKey}/{normalizedKey}_thumb.jpg 或 _hd.jpg
    const imageDir = join(root, normalizedKey)
    if (existsSync(imageDir)) {
      const hit = this.findCachedOutputInDir(imageDir, normalizedKey, extensions, preferHd)
      if (hit) return hit
    }
    
    // 兼容旧的平铺结构
    for (const ext of extensions) {
      const candidate = join(root, `${cacheKey}${ext}`)
      if (existsSync(candidate)) return candidate
    }
    for (const ext of extensions) {
      const candidate = join(root, `${cacheKey}_t${ext}`)
      if (existsSync(candidate)) return candidate
    }
    
    return null
  }

  private findCachedOutputInDir(
    dirPath: string,
    normalizedKey: string,
    extensions: string[],
    preferHd: boolean
  ): string | null {
    for (const ext of extensions) {
      if (preferHd) {
        const hdPath = join(dirPath, `${normalizedKey}_hd${ext}`)
        if (existsSync(hdPath)) return hdPath
      }
      const thumbPath = join(dirPath, `${normalizedKey}_thumb${ext}`)
      if (existsSync(thumbPath)) return thumbPath
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
      if (!this.hasXVariant(lower.slice(0, -4))) continue
      const baseLower = lower.slice(0, -4)
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
    // 确保只传递可序列化的数据
    const message = { 
      cacheKey: String(cacheKey), 
      imageMd5: payload.imageMd5 ? String(payload.imageMd5) : undefined, 
      imageDatName: payload.imageDatName ? String(payload.imageDatName) : undefined, 
      localPath: String(localPath) 
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('image:cacheResolved', message)
        } catch (e) {
          // 忽略序列化错误，避免阻塞
        }
      }
    }
  }

  private async ensureCacheIndexed(): Promise<void> {
    if (this.cacheIndexed) return
    if (this.cacheIndexing) return this.cacheIndexing
    this.cacheIndexing = new Promise((resolve) => {
      const root = this.getCacheRoot()
      try {
        this.indexCacheDir(root, 2, 0)
      } catch {
        this.cacheIndexed = true
        this.cacheIndexing = null
        resolve()
        return
      }
      this.cacheIndexed = true
      this.cacheIndexing = null
      resolve()
    })
    return this.cacheIndexing
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
    const version = await this.getDatVersion(datPath)
    
    if (version === 0) {
      return await this.decryptDatV3(datPath, xorKey)
    }
    if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      return await this.decryptDatV4(datPath, xorKey, key)
    }
    // version === 2
    if (!aesKey || aesKey.length !== 16) {
      throw new Error('请到设置配置图片解密密钥')
    }
    return await this.decryptDatV4(datPath, xorKey, aesKey)
  }

  private async getDatVersion(inputPath: string): Promise<number> {
    if (!existsSync(inputPath)) {
      throw new Error('文件不存在')
    }
    const bytes = await readFile(inputPath)
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

  private async decryptDatV3(inputPath: string, xorKey: number): Promise<Buffer> {
    const data = await readFile(inputPath)
    const out = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i += 1) {
      out[i] = data[i] ^ xorKey
    }
    return out
  }

  private async decryptDatV4(inputPath: string, xorKey: number, aesKey: Buffer): Promise<Buffer> {
    const bytes = await readFile(inputPath)
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

  private async fileToDataUrl(filePath: string): Promise<string | null> {
    try {
      const ext = extname(filePath).toLowerCase()
      const mimeType = this.mimeFromExtension(ext)
      if (!mimeType) return null
      const data = await readFile(filePath)
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
            } catch {}
          }
        }
      } catch {}
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
}

export const imageDecryptService = new ImageDecryptService()
