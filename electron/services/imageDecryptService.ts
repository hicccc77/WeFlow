import { app, BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { Worker } from 'worker_threads'
import { ConfigService } from './config'

type DecryptResult = { success: boolean; localPath?: string; error?: string }

type HardlinkState = {
  db: Database.Database
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
      const existing = this.findCachedOutput(key)
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
    return { success: false, error: '未找到缓存图片' }
  }

  async decryptImage(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }): Promise<DecryptResult> {
    await this.ensureCacheIndexed()
    const cacheKey = payload.imageMd5 || payload.imageDatName
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }

    console.info('[ImageDecrypt] request', {
      sessionId: payload.sessionId,
      imageMd5: payload.imageMd5,
      imageDatName: payload.imageDatName
    })

    if (!payload.force) {
      const cached = this.resolvedCache.get(cacheKey)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        console.info('[ImageDecrypt] cache hit', cached)
        const dataUrl = this.fileToDataUrl(cached)
        return { success: true, localPath: dataUrl || this.filePathToUrl(cached) }
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
      if (!datPath && payload.force) {
        const fallback = await this.resolveDatPath(
          accountDir,
          payload.imageMd5,
          payload.imageDatName,
          payload.sessionId,
          { allowThumbnail: true, skipResolvedCache: true }
        )
        if (fallback) {
          console.info('[ImageDecrypt] fallback to thumbnail', { cacheKey, path: fallback })
          return this.decryptImageInternal({ ...payload, force: false }, cacheKey)
        }
      }
      if (!datPath) {
        console.warn('[ImageDecrypt] dat not found', { cacheKey, accountDir })
        return { success: false, error: '未找到图片文件' }
      }

      if (!extname(datPath).toLowerCase().includes('dat')) {
        console.info('[ImageDecrypt] direct image hit', datPath)
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, datPath)
        const dataUrl = this.fileToDataUrl(datPath)
        return { success: true, localPath: dataUrl || this.filePathToUrl(datPath) }
      }

      if (!payload.force) {
        const existing = this.findCachedOutput(cacheKey)
        if (existing) {
          console.info('[ImageDecrypt] cache file hit', existing)
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
          const dataUrl = this.fileToDataUrl(existing)
          return { success: true, localPath: dataUrl || this.filePathToUrl(existing) }
        }
      }

      const xorKey = this.configService.get('imageXorKey')
      if (!xorKey) {
        console.warn('[ImageDecrypt] missing xor key')
        return { success: false, error: '未配置图片 XOR 密钥' }
      }

      const aesKeyRaw = this.configService.get('imageAesKey')
      const aesKey = this.resolveAesKey(aesKeyRaw)

      const decrypted = await this.decryptDatAuto(datPath, xorKey, aesKey)
      const ext = this.detectImageExtension(decrypted) || '.jpg'

      const outputPath = this.getCacheOutputPathFromDat(datPath, ext)
      await writeFile(outputPath, decrypted)
      console.info('[ImageDecrypt] decrypted', outputPath)
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
      if (!this.isThumbnailPath(datPath)) {
        this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      }
      const dataUrl = this.bufferToDataUrl(decrypted, ext)
      return { success: true, localPath: dataUrl || this.filePathToUrl(outputPath) }
    } catch (e) {
      console.error('[ImageDecrypt] failed', e)
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
    if (imageMd5) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath) {
        if (allowThumbnail || !this.isThumbnailPath(hardlinkPath)) {
          console.info('[ImageDecrypt] hardlink hit', { imageMd5, path: hardlinkPath })
          this.cacheDatPath(accountDir, imageMd5, hardlinkPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
      }
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath) {
        if (allowThumbnail || !this.isThumbnailPath(hardlinkPath)) {
          console.info('[ImageDecrypt] hardlink hit', { imageMd5: imageDatName, path: hardlinkPath })
          this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
      }
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
      this.resolvedCache.set(imageDatName, datPath)
      this.cacheDatPath(accountDir, imageDatName, datPath)
      return datPath
    }
    const normalized = this.normalizeDatBase(imageDatName)
    if (normalized !== imageDatName.toLowerCase()) {
      const normalizedPath = await this.searchDatFile(accountDir, normalized, allowThumbnail)
      if (normalizedPath) {
        this.resolvedCache.set(imageDatName, normalizedPath)
        this.cacheDatPath(accountDir, imageDatName, normalizedPath)
        return normalizedPath
      }
    }
    return null
  }

  private async resolveThumbnailDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string
  ): Promise<string | null> {
    if (imageMd5) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
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

  private resolveHardlinkPath(accountDir: string, md5: string, sessionId?: string): string | null {
    try {
      const hardlinkPath = join(accountDir, 'hardlink.db')
      if (!existsSync(hardlinkPath)) return null

      const state = this.getHardlinkState(accountDir, hardlinkPath)
      if (!state.imageTable) return null

      const row = state.db
        .prepare(`SELECT dir1, dir2, file_name FROM ${state.imageTable} WHERE md5 = ? LIMIT 1`)
        .get(md5) as { dir1?: string; dir2?: string; file_name?: string } | undefined

      if (!row) return null
      const dir1 = row.dir1 as string | undefined
      const dir2 = row.dir2 as string | undefined
      const fileName = row.file_name as string | undefined
      if (!dir1 || !dir2 || !fileName) return null
      const lowerFileName = fileName.toLowerCase()
      if (lowerFileName.endsWith('.dat')) {
        const baseLower = lowerFileName.slice(0, -4)
        if (!this.isLikelyImageDatBase(baseLower)) return null
        if (!this.hasXVariant(baseLower)) return null
      }

      let dirName = dir2
      if (state.dirTable && sessionId) {
        try {
          const dirRow = state.db
            .prepare(`SELECT dir_name FROM ${state.dirTable} WHERE dir_id = ? AND username = ? LIMIT 1`)
            .get(dir2, sessionId) as { dir_name?: string } | undefined
          if (dirRow?.dir_name) dirName = dirRow.dir_name as string
        } catch {}
      }

      const fullPath = join(accountDir, dir1, dirName, fileName)
      if (existsSync(fullPath)) return fullPath

      const withDat = `${fullPath}.dat`
      if (existsSync(withDat)) return withDat
    } catch {}
    return null
  }

  private getHardlinkState(accountDir: string, hardlinkPath: string): HardlinkState {
    const cached = this.hardlinkCache.get(accountDir)
    if (cached) return cached

    const db = new Database(hardlinkPath, { readonly: true, fileMustExist: true })
    const imageRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'image_hardlink_info%' ORDER BY name DESC LIMIT 1")
      .get() as { name?: string } | undefined
    const dirRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1")
      .get() as { name?: string } | undefined
    const state: HardlinkState = {
      db,
      imageTable: imageRow?.name as string | undefined,
      dirTable: dirRow?.name as string | undefined
    }
    this.hardlinkCache.set(accountDir, state)
    return state
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

  private walkForDat(
    root: string,
    datName: string,
    maxDepth = 4,
    allowThumbnail = true,
    thumbOnly = false
  ): string | null {
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    const candidates: Array<{ score: number; path: string; isThumb: boolean; hasX: boolean }> = []

    while (stack.length) {
      const current = stack.pop() as { dir: string; depth: number }
      let entries: string[]
      try {
        entries = readdirSync(current.dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const entryPath = join(current.dir, entry)
        let stat
        try {
          stat = statSync(entryPath)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          if (current.depth < maxDepth) {
            stack.push({ dir: entryPath, depth: current.depth + 1 })
          }
          continue
        }
        const lower = entry.toLowerCase()
        if (!lower.endsWith('.dat')) continue
        const baseLower = lower.slice(0, -4)
        if (!this.isLikelyImageDatBase(baseLower)) continue
        if (!this.hasXVariant(baseLower)) continue
        if (!this.matchesDatName(lower, datName)) continue
        const isThumb = this.isThumbnailDat(lower)
        if (!allowThumbnail && isThumb) continue
        if (thumbOnly && !isThumb) continue
        const score = this.scoreDatName(lower)
        candidates.push({
          score,
          path: entryPath,
          isThumb,
          hasX: this.hasXVariant(baseLower)
        })
      }
    }
    if (!candidates.length) return null

    const withX = candidates.filter((item) => item.hasX)
    const basePool = withX.length ? withX : candidates
    const nonThumb = basePool.filter((item) => !item.isThumb)
    const finalPool = thumbOnly ? basePool : (nonThumb.length ? nonThumb : basePool)

    let best: { score: number; path: string } | null = null
    for (const item of finalPool) {
      if (!best || item.score > best.score) {
        best = { score: item.score, path: item.path }
      }
    }
    return best?.path ?? null
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

      worker.on('error', (err) => {
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
    const pattern = new RegExp(`^${datName}(?:[._][a-z])?\\.dat$`)
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
    return base.endsWith('_t')
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



  private findCachedOutput(cacheKey: string): string | null {
    const root = this.getCacheRoot()
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    for (const ext of extensions) {
      const candidate = join(root, `${cacheKey}${ext}`)
      if (existsSync(candidate)) return candidate
    }
    for (const ext of extensions) {
      const candidate = join(root, `${cacheKey}_t${ext}`)
      if (existsSync(candidate)) return candidate
    }
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      return null
    }
    const lowerKey = cacheKey.toLowerCase()
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      const ext = extensions.find((item) => lower.endsWith(item))
      if (!ext) continue
      const base = lower.slice(0, -ext.length)
      if (base === lowerKey) return join(root, entry)
      if (base.startsWith(`${lowerKey}_`) && /_[a-z]$/.test(base)) return join(root, entry)
      if (base.startsWith(`${lowerKey}.`) && /\.[a-z]$/.test(base)) return join(root, entry)
    }
    return null
  }

  private getCacheOutputPathFromDat(datPath: string, ext: string): string {
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? name.slice(0, -4) : name
    return join(this.getCacheRoot(), `${base}${ext}`)
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
      const root = this.getCacheRoot()
      let entries: string[]
      try {
        entries = readdirSync(root)
      } catch {
        this.cacheIndexed = true
        this.cacheIndexing = null
        resolve()
        return
      }
      const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
      for (const entry of entries) {
        const lower = entry.toLowerCase()
        const ext = extensions.find((item) => lower.endsWith(item))
        if (!ext) continue
        const fullPath = join(root, entry)
        try {
          if (!statSync(fullPath).isFile()) continue
        } catch {
          continue
        }
        const base = entry.slice(0, -ext.length)
        this.addCacheIndex(base, fullPath)
        const normalized = this.normalizeDatBase(base)
        if (normalized && normalized !== base.toLowerCase()) {
          this.addCacheIndex(normalized, fullPath)
        }
      }
      this.cacheIndexed = true
      this.cacheIndexing = null
      resolve()
    })
    return this.cacheIndexing
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
    if (version === 0) return this.decryptDatV3(datPath, xorKey)
    if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      return this.decryptDatV4(datPath, xorKey, key)
    }
    if (!aesKey || aesKey.length !== 16) {
      throw new Error('V4版本需要16字节AES密钥')
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

    const remainder = ((aesSize % 16) + 16) % 16
    const alignedAesSize = aesSize + (16 - remainder)
    if (alignedAesSize > data.length) {
      throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
    }

    const aesData = data.subarray(0, alignedAesSize)
    let unpadded = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()]) as Buffer
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

  private asciiKey16(keyString: string): Buffer {
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
}

export const imageDecryptService = new ImageDecryptService()
