import { join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync, appendFileSync, mkdirSync, unlinkSync } from 'fs'
import { spawn } from 'child_process'
import { pathToFileURL } from 'url'
import crypto from 'crypto'
import { app } from 'electron'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

export interface VideoInfo {
  videoUrl?: string       // 视频文件路径（用于 readFile）
  coverUrl?: string       // 封面 data URL
  thumbUrl?: string       // 缩略图 data URL
  exists: boolean
}

interface TimedCacheEntry<T> {
  value: T
  expiresAt: number
}

interface VideoIndexEntry {
  videoPath?: string
  coverPath?: string
  thumbPath?: string
}

type PosterFormat = 'dataUrl' | 'fileUrl'

function getStaticFfmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static')
    if (typeof ffmpegStatic === 'string') {
      let fixedPath = ffmpegStatic
      if (fixedPath.includes('app.asar') && !fixedPath.includes('app.asar.unpacked')) {
        fixedPath = fixedPath.replace('app.asar', 'app.asar.unpacked')
      }
      if (existsSync(fixedPath)) return fixedPath
    }
  } catch {
    // ignore
  }

  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const devPath = join(process.cwd(), 'node_modules', 'ffmpeg-static', ffmpegName)
  if (existsSync(devPath)) return devPath

  if (app.isPackaged) {
    const packedPath = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', ffmpegName)
    if (existsSync(packedPath)) return packedPath
  }

  return null
}

class VideoService {
  private configService: ConfigService
  private hardlinkResolveCache = new Map<string, TimedCacheEntry<string | null>>()
  private videoInfoCache = new Map<string, TimedCacheEntry<VideoInfo>>()
  private videoDirIndexCache = new Map<string, TimedCacheEntry<Map<string, VideoIndexEntry>>>()
  private pendingVideoInfo = new Map<string, Promise<VideoInfo>>()
  private pendingPosterExtract = new Map<string, Promise<string | null>>()
  private extractedPosterCache = new Map<string, TimedCacheEntry<string | null>>()
  private posterExtractRunning = 0
  private posterExtractQueue: Array<() => void> = []
  private readonly hardlinkCacheTtlMs = 10 * 60 * 1000
  private readonly videoInfoCacheTtlMs = 2 * 60 * 1000
  private readonly videoIndexCacheTtlMs = 90 * 1000
  private readonly extractedPosterCacheTtlMs = 15 * 60 * 1000
  private readonly maxPosterExtractConcurrency = 1
  private readonly maxCacheEntries = 2000
  private readonly maxIndexEntries = 6

  constructor() {
    this.configService = new ConfigService()
  }

  private log(message: string, meta?: Record<string, unknown>): void {
    try {
      const timestamp = new Date().toISOString()
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
      const logDir = join(app.getPath('userData'), 'logs')
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
      appendFileSync(join(logDir, 'wcdb.log'), `[${timestamp}] [VideoService] ${message}${metaStr}\n`, 'utf8')
    } catch { }
  }

  private readTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | undefined {
    const hit = cache.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      cache.delete(key)
      return undefined
    }
    return hit.value
  }

  private writeTimedCache<T>(
    cache: Map<string, TimedCacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
    maxEntries: number
  ): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs })
    if (cache.size <= maxEntries) return

    const now = Date.now()
    for (const [cacheKey, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(cacheKey)
      }
    }

    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined
      if (!oldestKey) break
      cache.delete(oldestKey)
    }
  }

  /**
   * 获取数据库根目录
   */
  private getDbPath(): string {
    return this.configService.get('dbPath') || ''
  }

  /**
   * 获取当前用户的wxid
   */
  private getMyWxid(): string {
    return this.configService.get('myWxid') || ''
  }

  /**
   * 清理 wxid 目录名（去掉后缀）
   */
  private cleanWxid(wxid: string): string {
    const trimmed = wxid.trim()
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

  private getScopeKey(dbPath: string, wxid: string): string {
    return `${dbPath}::${this.cleanWxid(wxid)}`.toLowerCase()
  }

  private resolveVideoBaseDir(dbPath: string, wxid: string): string {
    const cleanedWxid = this.cleanWxid(wxid)
    const dbPathLower = dbPath.toLowerCase()
    const wxidLower = wxid.toLowerCase()
    const cleanedWxidLower = cleanedWxid.toLowerCase()
    const dbPathContainsWxid = dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxidLower)
    if (dbPathContainsWxid) {
      return join(dbPath, 'msg', 'video')
    }
    return join(dbPath, wxid, 'msg', 'video')
  }

  private getHardlinkDbPaths(dbPath: string, wxid: string, cleanedWxid: string): string[] {
    const dbPathLower = dbPath.toLowerCase()
    const wxidLower = wxid.toLowerCase()
    const cleanedWxidLower = cleanedWxid.toLowerCase()
    const dbPathContainsWxid = dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxidLower)

    if (dbPathContainsWxid) {
      return [join(dbPath, 'db_storage', 'hardlink', 'hardlink.db')]
    }

    return [
      join(dbPath, wxid, 'db_storage', 'hardlink', 'hardlink.db'),
      join(dbPath, cleanedWxid, 'db_storage', 'hardlink', 'hardlink.db')
    ]
  }

  /**
   * 从 video_hardlink_info_v4 表查询视频文件名
   * 使用 wcdb 专属接口查询加密的 hardlink.db
   */
  private async resolveVideoHardlinks(
    md5List: string[],
    dbPath: string,
    wxid: string,
    cleanedWxid: string
  ): Promise<Map<string, string>> {
    const scopeKey = this.getScopeKey(dbPath, wxid)
    const normalizedList = Array.from(
      new Set((md5List || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))
    )
    const resolvedMap = new Map<string, string>()
    const unresolvedSet = new Set(normalizedList)

    for (const md5 of normalizedList) {
      const cacheKey = `${scopeKey}|${md5}`
      const cached = this.readTimedCache(this.hardlinkResolveCache, cacheKey)
      if (cached === undefined) continue
      if (cached) resolvedMap.set(md5, cached)
      unresolvedSet.delete(md5)
    }

    if (unresolvedSet.size === 0) return resolvedMap

    const encryptedDbPaths = this.getHardlinkDbPaths(dbPath, wxid, cleanedWxid)
    for (const p of encryptedDbPaths) {
      if (!existsSync(p) || unresolvedSet.size === 0) continue
      const unresolved = Array.from(unresolvedSet)
      const requests = unresolved.map((md5) => ({ md5, dbPath: p }))
      try {
        const batchResult = await wcdbService.resolveVideoHardlinkMd5Batch(requests)
        if (batchResult.success && Array.isArray(batchResult.rows)) {
          for (const row of batchResult.rows) {
            const index = Number.isFinite(Number(row?.index)) ? Math.floor(Number(row?.index)) : -1
            const inputMd5 = index >= 0 && index < requests.length
              ? requests[index].md5
              : String(row?.md5 || '').trim().toLowerCase()
            if (!inputMd5) continue
            const resolvedMd5 = row?.success && row?.data?.resolved_md5
              ? String(row.data.resolved_md5).trim().toLowerCase()
              : ''
            if (!resolvedMd5) continue
            const cacheKey = `${scopeKey}|${inputMd5}`
            this.writeTimedCache(this.hardlinkResolveCache, cacheKey, resolvedMd5, this.hardlinkCacheTtlMs, this.maxCacheEntries)
            resolvedMap.set(inputMd5, resolvedMd5)
            unresolvedSet.delete(inputMd5)
          }
        } else {
          // 兼容不支持批量接口的版本，回退单条请求。
          for (const req of requests) {
            try {
              const single = await wcdbService.resolveVideoHardlinkMd5(req.md5, req.dbPath)
              const resolvedMd5 = single.success && single.data?.resolved_md5
                ? String(single.data.resolved_md5).trim().toLowerCase()
                : ''
              if (!resolvedMd5) continue
              const cacheKey = `${scopeKey}|${req.md5}`
              this.writeTimedCache(this.hardlinkResolveCache, cacheKey, resolvedMd5, this.hardlinkCacheTtlMs, this.maxCacheEntries)
              resolvedMap.set(req.md5, resolvedMd5)
              unresolvedSet.delete(req.md5)
            } catch { }
          }
        }
      } catch (e) {
        this.log('resolveVideoHardlinks 批量查询失败', { path: p, error: String(e) })
      }
    }

    for (const md5 of unresolvedSet) {
      const cacheKey = `${scopeKey}|${md5}`
      this.writeTimedCache(this.hardlinkResolveCache, cacheKey, null, this.hardlinkCacheTtlMs, this.maxCacheEntries)
    }

    return resolvedMap
  }

  private async queryVideoFileName(md5: string): Promise<string | undefined> {
    const normalizedMd5 = String(md5 || '').trim().toLowerCase()
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()
    const cleanedWxid = this.cleanWxid(wxid)

    this.log('queryVideoFileName 开始', { md5: normalizedMd5, wxid, cleanedWxid, dbPath })

    if (!normalizedMd5 || !wxid || !dbPath) {
      this.log('queryVideoFileName: 参数缺失', { hasMd5: !!normalizedMd5, hasWxid: !!wxid, hasDbPath: !!dbPath })
      return undefined
    }

    const resolvedMap = await this.resolveVideoHardlinks([normalizedMd5], dbPath, wxid, cleanedWxid)
    const resolved = resolvedMap.get(normalizedMd5)
    if (resolved) {
      this.log('queryVideoFileName 命中', { input: normalizedMd5, resolved })
      return resolved
    }
    return undefined
  }

  async preloadVideoHardlinkMd5s(md5List: string[]): Promise<void> {
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()
    const cleanedWxid = this.cleanWxid(wxid)
    if (!dbPath || !wxid) return
    await this.resolveVideoHardlinks(md5List, dbPath, wxid, cleanedWxid)
  }

  private fileToPosterUrl(filePath: string | undefined, mimeType: string, posterFormat: PosterFormat): string | undefined {
    try {
      if (!filePath || !existsSync(filePath)) return undefined
      if (posterFormat === 'fileUrl') return pathToFileURL(filePath).toString()
      const buffer = readFileSync(filePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      return undefined
    }
  }

  private getOrBuildVideoIndex(videoBaseDir: string): Map<string, VideoIndexEntry> {
    const cached = this.readTimedCache(this.videoDirIndexCache, videoBaseDir)
    if (cached) return cached

    const index = new Map<string, VideoIndexEntry>()
    const ensureEntry = (key: string): VideoIndexEntry => {
      let entry = index.get(key)
      if (!entry) {
        entry = {}
        index.set(key, entry)
      }
      return entry
    }

    try {
      const yearMonthDirs = readdirSync(videoBaseDir)
        .filter((dir) => {
          const dirPath = join(videoBaseDir, dir)
          try {
            return statSync(dirPath).isDirectory()
          } catch {
            return false
          }
        })
        .sort((a, b) => b.localeCompare(a))

      for (const yearMonth of yearMonthDirs) {
        const dirPath = join(videoBaseDir, yearMonth)
        let files: string[] = []
        try {
          files = readdirSync(dirPath)
        } catch {
          continue
        }

        for (const file of files) {
          const lower = file.toLowerCase()
          const fullPath = join(dirPath, file)

          if (lower.endsWith('.mp4')) {
            const md5 = lower.slice(0, -4)
            const entry = ensureEntry(md5)
            if (!entry.videoPath) entry.videoPath = fullPath
            if (md5.endsWith('_raw')) {
              const baseMd5 = md5.replace(/_raw$/, '')
              const baseEntry = ensureEntry(baseMd5)
              if (!baseEntry.videoPath) baseEntry.videoPath = fullPath
            }
            continue
          }

          if (!lower.endsWith('.jpg')) continue
          const jpgBase = lower.slice(0, -4)
          if (jpgBase.endsWith('_thumb')) {
            const baseMd5 = jpgBase.slice(0, -6)
            const entry = ensureEntry(baseMd5)
            if (!entry.thumbPath) entry.thumbPath = fullPath
          } else {
            const entry = ensureEntry(jpgBase)
            if (!entry.coverPath) entry.coverPath = fullPath
          }
        }
      }

      for (const [key, entry] of index) {
        if (!key.endsWith('_raw')) continue
        const baseKey = key.replace(/_raw$/, '')
        const baseEntry = index.get(baseKey)
        if (!baseEntry) continue
        if (!entry.coverPath) entry.coverPath = baseEntry.coverPath
        if (!entry.thumbPath) entry.thumbPath = baseEntry.thumbPath
      }
    } catch (e) {
      this.log('构建视频索引失败', { videoBaseDir, error: String(e) })
    }

    this.writeTimedCache(
      this.videoDirIndexCache,
      videoBaseDir,
      index,
      this.videoIndexCacheTtlMs,
      this.maxIndexEntries
    )
    return index
  }

  private getVideoInfoFromIndex(
    index: Map<string, VideoIndexEntry>,
    md5: string,
    includePoster = true,
    posterFormat: PosterFormat = 'dataUrl'
  ): VideoInfo | null {
    const normalizedMd5 = String(md5 || '').trim().toLowerCase()
    if (!normalizedMd5) return null

    const candidates = [normalizedMd5]
    const baseMd5 = normalizedMd5.replace(/_raw$/, '')
    if (baseMd5 !== normalizedMd5) {
      candidates.push(baseMd5)
    } else {
      candidates.push(`${normalizedMd5}_raw`)
    }

    for (const key of candidates) {
      const entry = index.get(key)
      if (!entry?.videoPath) continue
      if (!existsSync(entry.videoPath)) continue
      if (!includePoster) {
        return {
          videoUrl: entry.videoPath,
          exists: true
        }
      }
      return {
        videoUrl: entry.videoPath,
        coverUrl: this.fileToPosterUrl(entry.coverPath, 'image/jpeg', posterFormat),
        thumbUrl: this.fileToPosterUrl(entry.thumbPath, 'image/jpeg', posterFormat),
        exists: true
      }
    }

    return null
  }

  private fallbackScanVideo(
    videoBaseDir: string,
    realVideoMd5: string,
    includePoster = true,
    posterFormat: PosterFormat = 'dataUrl'
  ): VideoInfo | null {
    try {
      const yearMonthDirs = readdirSync(videoBaseDir)
        .filter((dir) => {
          const dirPath = join(videoBaseDir, dir)
          try {
            return statSync(dirPath).isDirectory()
          } catch {
            return false
          }
        })
        .sort((a, b) => b.localeCompare(a))

      for (const yearMonth of yearMonthDirs) {
        const dirPath = join(videoBaseDir, yearMonth)
        const videoPath = join(dirPath, `${realVideoMd5}.mp4`)
        if (!existsSync(videoPath)) continue
        if (!includePoster) {
          return {
            videoUrl: videoPath,
            exists: true
          }
        }
        const baseMd5 = realVideoMd5.replace(/_raw$/, '')
        const coverPath = join(dirPath, `${baseMd5}.jpg`)
        const thumbPath = join(dirPath, `${baseMd5}_thumb.jpg`)
        return {
          videoUrl: videoPath,
          coverUrl: this.fileToPosterUrl(coverPath, 'image/jpeg', posterFormat),
          thumbUrl: this.fileToPosterUrl(thumbPath, 'image/jpeg', posterFormat),
          exists: true
        }
      }
    } catch (e) {
      this.log('fallback 扫描视频目录失败', { error: String(e) })
    }
    return null
  }

  private getFfmpegPath(): string {
    const staticPath = getStaticFfmpegPath()
    if (staticPath) return staticPath
    return 'ffmpeg'
  }

  private async withPosterExtractSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.posterExtractRunning >= this.maxPosterExtractConcurrency) {
      await new Promise<void>((resolve) => {
        this.posterExtractQueue.push(resolve)
      })
    }
    this.posterExtractRunning += 1
    try {
      return await run()
    } finally {
      this.posterExtractRunning = Math.max(0, this.posterExtractRunning - 1)
      const next = this.posterExtractQueue.shift()
      if (next) next()
    }
  }

  private async extractFirstFramePoster(videoPath: string, posterFormat: PosterFormat): Promise<string | null> {
    const normalizedPath = String(videoPath || '').trim()
    if (!normalizedPath || !existsSync(normalizedPath)) return null

    const cacheKey = `${normalizedPath}|format=${posterFormat}`
    const cached = this.readTimedCache(this.extractedPosterCache, cacheKey)
    if (cached !== undefined) return cached

    const pending = this.pendingPosterExtract.get(cacheKey)
    if (pending) return pending

    const task = this.withPosterExtractSlot(() => new Promise<string | null>((resolve) => {
      const tmpDir = join(app.getPath('temp'), 'weflow_video_frames')
      try {
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
      } catch {
        resolve(null)
        return
      }

      const stableHash = crypto.createHash('sha1').update(normalizedPath).digest('hex').slice(0, 24)
      const outputPath = join(tmpDir, `frame_${stableHash}.jpg`)
      if (posterFormat === 'fileUrl' && existsSync(outputPath)) {
        resolve(pathToFileURL(outputPath).toString())
        return
      }

      const ffmpegPath = this.getFfmpegPath()
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', '0',
        '-i', normalizedPath,
        '-frames:v', '1',
        '-q:v', '3',
        outputPath
      ]

      const errChunks: Buffer[] = []
      let done = false
      const finish = (value: string | null) => {
        if (done) return
        done = true
        if (posterFormat === 'dataUrl') {
          try {
            if (existsSync(outputPath)) unlinkSync(outputPath)
          } catch {
            // ignore
          }
        }
        resolve(value)
      }

      const proc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
        finish(null)
      }, 12000)

      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

      proc.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })

      proc.on('close', (code: number) => {
        clearTimeout(timer)
        if (code !== 0 || !existsSync(outputPath)) {
          if (errChunks.length > 0) {
            this.log('extractFirstFrameDataUrl failed', {
              videoPath: normalizedPath,
              error: Buffer.concat(errChunks).toString().slice(0, 240)
            })
          }
          finish(null)
          return
        }
        try {
          const jpgBuf = readFileSync(outputPath)
          if (!jpgBuf.length) {
            finish(null)
            return
          }
          if (posterFormat === 'fileUrl') {
            finish(pathToFileURL(outputPath).toString())
            return
          }
          finish(`data:image/jpeg;base64,${jpgBuf.toString('base64')}`)
        } catch {
          finish(null)
        }
      })
    }))

    this.pendingPosterExtract.set(cacheKey, task)
    try {
      const result = await task
      this.writeTimedCache(
        this.extractedPosterCache,
        cacheKey,
        result,
        this.extractedPosterCacheTtlMs,
        this.maxCacheEntries
      )
      return result
    } finally {
      this.pendingPosterExtract.delete(cacheKey)
    }
  }

  private async ensurePoster(info: VideoInfo, includePoster: boolean, posterFormat: PosterFormat): Promise<VideoInfo> {
    if (!includePoster) return info
    if (!info.exists || !info.videoUrl) return info
    if (info.coverUrl || info.thumbUrl) return info

    const extracted = await this.extractFirstFramePoster(info.videoUrl, posterFormat)
    if (!extracted) return info
    return {
      ...info,
      coverUrl: extracted,
      thumbUrl: extracted
    }
  }

  /**
   * 根据视频MD5获取视频文件信息
   * 视频存放在: {数据库根目录}/{用户wxid}/msg/video/{年月}/
   * 文件命名: {md5}.mp4, {md5}.jpg, {md5}_thumb.jpg
   */
  async getVideoInfo(videoMd5: string, options?: { includePoster?: boolean; posterFormat?: PosterFormat }): Promise<VideoInfo> {
    const normalizedMd5 = String(videoMd5 || '').trim().toLowerCase()
    const includePoster = options?.includePoster !== false
    const posterFormat: PosterFormat = options?.posterFormat === 'fileUrl' ? 'fileUrl' : 'dataUrl'
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()

    this.log('getVideoInfo 开始', { videoMd5: normalizedMd5, dbPath, wxid })

    if (!dbPath || !wxid || !normalizedMd5) {
      this.log('getVideoInfo: 参数缺失', { hasDbPath: !!dbPath, hasWxid: !!wxid, hasVideoMd5: !!normalizedMd5 })
      return { exists: false }
    }

    const scopeKey = this.getScopeKey(dbPath, wxid)
    const cacheKey = `${scopeKey}|${normalizedMd5}|poster=${includePoster ? 1 : 0}|format=${posterFormat}`

    const cachedInfo = this.readTimedCache(this.videoInfoCache, cacheKey)
    if (cachedInfo) return cachedInfo

    const pending = this.pendingVideoInfo.get(cacheKey)
    if (pending) return pending

    const task = (async (): Promise<VideoInfo> => {
      const realVideoMd5 = await this.queryVideoFileName(normalizedMd5) || normalizedMd5
      const videoBaseDir = this.resolveVideoBaseDir(dbPath, wxid)

      if (!existsSync(videoBaseDir)) {
        const miss = { exists: false }
        this.writeTimedCache(this.videoInfoCache, cacheKey, miss, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return miss
      }

      const index = this.getOrBuildVideoIndex(videoBaseDir)
      const indexed = this.getVideoInfoFromIndex(index, realVideoMd5, includePoster, posterFormat)
      if (indexed) {
        const withPoster = await this.ensurePoster(indexed, includePoster, posterFormat)
        this.writeTimedCache(this.videoInfoCache, cacheKey, withPoster, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return withPoster
      }

      const fallback = this.fallbackScanVideo(videoBaseDir, realVideoMd5, includePoster, posterFormat)
      if (fallback) {
        const withPoster = await this.ensurePoster(fallback, includePoster, posterFormat)
        this.writeTimedCache(this.videoInfoCache, cacheKey, withPoster, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return withPoster
      }

      const miss = { exists: false }
      this.writeTimedCache(this.videoInfoCache, cacheKey, miss, this.videoInfoCacheTtlMs, this.maxCacheEntries)
      this.log('getVideoInfo: 未找到视频', { inputMd5: normalizedMd5, resolvedMd5: realVideoMd5 })
      return miss
    })()

    this.pendingVideoInfo.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.pendingVideoInfo.delete(cacheKey)
    }
  }

  /**
   * 根据消息内容解析视频MD5
   */
  parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    // 打印原始 XML 前 800 字符，帮助排查自己发的视频结构
    this.log('parseVideoMd5 原始内容', { preview: content.slice(0, 800) })

    try {
      // 收集所有 md5 相关属性，方便对比
      const allMd5Attrs: string[] = []
      const md5Regex = /(?:md5|rawmd5|newmd5|originsourcemd5)\s*=\s*['"]([a-fA-F0-9]*)['"]/gi
      let match
      while ((match = md5Regex.exec(content)) !== null) {
        allMd5Attrs.push(match[0])
      }
      this.log('parseVideoMd5 所有 md5 属性', { attrs: allMd5Attrs })

      // 方法1：从 <videomsg md5="..."> 提取（收到的视频）
      const videoMsgMd5Match = /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (videoMsgMd5Match) {
        this.log('parseVideoMd5 命中 videomsg md5 属性', { md5: videoMsgMd5Match[1] })
        return videoMsgMd5Match[1].toLowerCase()
      }

      // 方法2：从 <videomsg rawmd5="..."> 提取（自己发的视频，没有 md5 只有 rawmd5）
      const rawMd5Match = /<videomsg[^>]*\srawmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (rawMd5Match) {
        this.log('parseVideoMd5 命中 videomsg rawmd5 属性（自发视频）', { rawmd5: rawMd5Match[1] })
        return rawMd5Match[1].toLowerCase()
      }

      // 方法3：任意属性 md5="..."（非 rawmd5/cdnthumbaeskey 等）
      const attrMatch = /(?<![a-z])md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (attrMatch) {
        this.log('parseVideoMd5 命中通用 md5 属性', { md5: attrMatch[1] })
        return attrMatch[1].toLowerCase()
      }

      // 方法4：<md5>...</md5> 标签
      const md5TagMatch = /<md5>([a-fA-F0-9]+)<\/md5>/i.exec(content)
      if (md5TagMatch) {
        this.log('parseVideoMd5 命中 md5 标签', { md5: md5TagMatch[1] })
        return md5TagMatch[1].toLowerCase()
      }

      // 方法5：兜底取 rawmd5 属性（任意位置）
      const rawMd5Fallback = /\srawmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (rawMd5Fallback) {
        this.log('parseVideoMd5 兜底命中 rawmd5', { rawmd5: rawMd5Fallback[1] })
        return rawMd5Fallback[1].toLowerCase()
      }

      this.log('parseVideoMd5 未提取到任何 md5', { contentLength: content.length })
    } catch (e) {
      this.log('parseVideoMd5 异常', { error: String(e) })
    }

    return undefined
  }
}

export const videoService = new VideoService()
