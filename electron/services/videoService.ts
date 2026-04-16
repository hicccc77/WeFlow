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

interface FileMd5CacheEntry {
  md5: string
  mtimeMs: number
  size: number
}

type VideoLookupContext = {
  sessionId?: string
  localId?: number
  createTime?: number
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
  private videoContentMd5Cache = new Map<string, TimedCacheEntry<FileMd5CacheEntry>>()
  private posterExtractRunning = 0
  private posterExtractQueue: Array<() => void> = []
  private readonly hardlinkCacheTtlMs = 10 * 60 * 1000
  private readonly videoInfoCacheTtlMs = 2 * 60 * 1000
  private readonly videoIndexCacheTtlMs = 90 * 1000
  private readonly extractedPosterCacheTtlMs = 15 * 60 * 1000
  private readonly maxPosterExtractConcurrency = 1
  private readonly maxCacheEntries = 2000
  private readonly maxIndexEntries = 6
  private readonly contentHashCacheTtlMs = 10 * 60 * 1000

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

  private debugTrace(message: string, meta?: Record<string, unknown>): void {
    try {
      const ts = new Date().toISOString()
      if (meta) console.log(`[VideoTrace ${ts}] ${message}`, meta)
      else console.log(`[VideoTrace ${ts}] ${message}`)
    } catch { /* ignore */ }
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

  private getMessageResourceDbPaths(dbPath: string, wxid: string, cleanedWxid: string): string[] {
    const dbPathLower = dbPath.toLowerCase()
    const wxidLower = wxid.toLowerCase()
    const cleanedWxidLower = cleanedWxid.toLowerCase()
    const dbPathContainsWxid = dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxidLower)
    if (dbPathContainsWxid) {
      return [
        join(dbPath, 'db_storage', 'message', 'message_resource.db'),
        join(dbPath, 'db_storage', 'message_resource.db')
      ]
    }
    return [
      join(dbPath, wxid, 'db_storage', 'message', 'message_resource.db'),
      join(dbPath, wxid, 'db_storage', 'message_resource.db')
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

  private normalizeVideoToken(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^.*[\\/]/, '')
      .replace(/\.(?:mp4|mov|m4v|hevc|jpg|jpeg|png)$/i, '')
  }

  private extractVideoNameCandidates(textRaw: string): string[] {
    const text = String(textRaw || '')
    if (!text) return []
    const set = new Set<string>()
    const push = (v?: string) => {
      const n = this.normalizeVideoToken(String(v || ''))
      if (n) set.add(n)
    }
    const fileRegex = /([a-zA-Z0-9_-]{8,})\.(?:mp4|mov|m4v|hevc|jpg|jpeg|png)\b/gi
    let m: RegExpExecArray | null
    while ((m = fileRegex.exec(text)) !== null) push(m[1])
    const kvRegex = /(?:videoname|video_name|filename|file_name)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{8,})['"]?/gi
    while ((m = kvRegex.exec(text)) !== null) push(m[1])
    const hexRegex = /\b([a-fA-F0-9]{32})\b/g
    while ((m = hexRegex.exec(text)) !== null) push(m[1])
    return Array.from(set)
  }

  private pickBestVideoCandidate(candidates: string[], sourceToken: string): string | undefined {
    const source = this.normalizeVideoToken(sourceToken)
    const uniq = Array.from(new Set((candidates || []).map((x) => this.normalizeVideoToken(x)).filter(Boolean)))
    const alt = uniq.find((x) => /^[a-f0-9]{32}$/.test(x) && x !== source)
    if (alt) return alt
    const strong = uniq.find((x) => x.includes(source) || source.includes(x))
    return strong || uniq[0]
  }

  private toPrintableText(raw: unknown): string {
    try {
      if (raw === null || raw === undefined) return ''
      if (typeof raw === 'string') return raw
      let buf: Buffer | null = null
      if (Buffer.isBuffer(raw)) buf = raw
      else if (raw instanceof Uint8Array) buf = Buffer.from(raw)
      else if (typeof raw === 'object' && Array.isArray((raw as any).data)) buf = Buffer.from((raw as any).data)
      if (!buf || buf.length === 0) return ''
      const sanitize = (v: string): string => String(v || '').replace(/\u0000/g, '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim()
      const utf8 = sanitize(buf.toString('utf8'))
      const utf16 = sanitize(buf.toString('utf16le'))
      if (utf8 && utf16 && utf8 !== utf16) return `${utf8}\n${utf16}`
      return utf8 || utf16
    } catch {
      return ''
    }
  }

  private extractVideoNameFromPackedRaw(raw: unknown): string | undefined {
    try {
      const extractFromBuffer = (buf: Buffer): string | undefined => {
        const text = buf.toString('latin1')
        const strict = /([a-fA-F0-9]{32})\.mp4\b/.exec(text)
        if (strict?.[1]) return strict[1].toLowerCase()
        const all = text.match(/[a-fA-F0-9]{32}/g) || []
        const preferred = all.find((item) => /[a-f]/i.test(item) && !/^08011002/i.test(item))
        if (preferred) return preferred.toLowerCase()
        const first = all.find((item) => !/^08011002/i.test(item))
        return (first || all[0])?.toLowerCase()
      }
      if (raw === null || raw === undefined) return undefined
      let buf: Buffer | null = null
      if (Buffer.isBuffer(raw)) buf = raw
      else if (raw instanceof Uint8Array) buf = Buffer.from(raw)
      else if (typeof raw === 'object' && Array.isArray((raw as any).data)) buf = Buffer.from((raw as any).data)
      else if (typeof raw === 'string') {
        const s = raw
        const numeric = s.match(/\d{1,3}/g)
        if (numeric && numeric.length >= 8) {
          const bytes = numeric.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 255)
          if (bytes.length >= 8) {
            const byNums = extractFromBuffer(Buffer.from(bytes))
            if (byNums) return byNums
          }
        }
        const hexOnly = s.replace(/[^a-fA-F0-9]/g, '')
        if (hexOnly.length >= 64 && hexOnly.length % 2 === 0) {
          try {
            const byHex = extractFromBuffer(Buffer.from(hexOnly, 'hex'))
            if (byHex) return byHex
          } catch { /* ignore */ }
        }
        return /([a-fA-F0-9]{32})(?:\.mp4)?/.exec(s)?.[1]?.toLowerCase()
      }
      if (!buf || buf.length === 0) return undefined
      const fromBinary = extractFromBuffer(buf)
      if (fromBinary) return fromBinary
      let run = ''
      const isHexByte = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46)
      for (const b of buf) {
        if (!isHexByte(b)) { run = ''; continue }
        run += String.fromCharCode(b).toLowerCase()
        if (run.length > 32) run = run.slice(-32)
        if (run.length === 32) return run
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async queryVideoFileName(md5: string, context?: VideoLookupContext): Promise<string | undefined> {
    const normalizedMd5 = this.normalizeVideoToken(md5)
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()
    const cleanedWxid = this.cleanWxid(wxid)
    this.log('queryVideoFileName 开始', { md5: normalizedMd5, wxid, cleanedWxid, dbPath })
    this.debugTrace('queryVideoFileName 开始', { input: md5, normalized: normalizedMd5, dbPath, wxid, cleanedWxid, context })
    if (!normalizedMd5 || !wxid || !dbPath) {
      this.log('queryVideoFileName: 参数缺失', { hasMd5: !!normalizedMd5, hasWxid: !!wxid, hasDbPath: !!dbPath })
      return undefined
    }
    const resolvedMap = await this.resolveVideoHardlinks([normalizedMd5], dbPath, wxid, cleanedWxid)
    const hardlinkResolved = resolvedMap.get(normalizedMd5)
    if (hardlinkResolved) {
      this.log('queryVideoFileName 命中', { input: normalizedMd5, resolved: hardlinkResolved })
      this.debugTrace('queryVideoFileName hardlink 命中', { input: normalizedMd5, resolved: hardlinkResolved })
      return hardlinkResolved
    }
    const packedResolved = await this.resolveVideoNameFromMessagePackedInfo(normalizedMd5, context)
    if (packedResolved) {
      this.debugTrace('queryVideoFileName resource 命中', { input: normalizedMd5, resolved: packedResolved })
      return packedResolved
    }
    this.debugTrace('queryVideoFileName 未命中', { input: normalizedMd5 })
    return undefined
  }

  private async resolveVideoNameFromMessagePackedInfo(token: string, context?: VideoLookupContext): Promise<string | undefined> {
    const normalizedToken = this.normalizeVideoToken(token)
    if (!normalizedToken) return undefined
    this.debugTrace('开始 message packed_info 解析', { token: normalizedToken, context })
    const messageDbRes = await wcdbService.listMessageDbs()
    const dbPaths = messageDbRes.success && Array.isArray(messageDbRes.data) ? messageDbRes.data : []
    if (dbPaths.length === 0) return undefined
    this.debugTrace('message 库列表', { dbPaths })
    const localIdCandidates = new Set<number>()

    for (const dbPath of dbPaths) {
      let preferredTables: string[] = []
      const sessionId = String(context?.sessionId || '').trim()
      if (sessionId) {
        const escapedSessionId = sessionId.replace(/'/g, "''")
        const chatMap = await wcdbService.execQuery('message', dbPath, `SELECT ChatName, ChatTableName FROM ChatName2Id WHERE ChatName = '${escapedSessionId}' LIMIT 3`)
        if (chatMap.success && Array.isArray(chatMap.rows) && chatMap.rows.length > 0) {
          preferredTables = chatMap.rows.map((r: any) => String(r.ChatTableName || '')).filter((x) => /^Msg_[a-fA-F0-9]{32}$/.test(x))
        } else {
          this.debugTrace('会话未命中 ChatName2Id', { dbPath, sessionId })
        }
      }

      const tableRes = await wcdbService.execQuery('message', dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
      const allMsgTables = tableRes.success && Array.isArray(tableRes.rows)
        ? tableRes.rows.map((r: any) => String(r.name || '')).filter(Boolean)
        : []
      if (allMsgTables.length === 0) continue
      const orderedTables = [...preferredTables, ...allMsgTables.filter((x) => !preferredTables.includes(x))]
      this.debugTrace('message 候选表', { dbPath, tableCount: allMsgTables.length, preferredTables, firstTables: orderedTables.slice(0, 4) })

      for (const tableName of orderedTables) {
        const escapedTable = tableName.replace(/'/g, "''")
        const pragmaRes = await wcdbService.execQuery('message', dbPath, `PRAGMA table_info("${escapedTable}")`)
        if (!pragmaRes.success || !Array.isArray(pragmaRes.rows)) continue
        const columns = new Set(pragmaRes.rows.map((item: any) => String(item?.name || '').trim().toLowerCase()).filter(Boolean))
        if (!columns.has('local_type')) continue
        const packedColumns = ['packed_info_data', 'packed_info_blob', 'packed_info', 'bytesextra', 'bytes_extra', 'reserved0', 'wcdb_ct_packed_info', 'wcdb_ct_reserved0']
          .filter((c) => columns.has(c))
        if (packedColumns.length === 0) continue
        const sessionColumns = ['talker', 'session_id', 'sessionid', 'chat_name', 'chatname', 'chat_name_id', 'chatnameid']
          .filter((c) => columns.has(c))

        const localIdFilter = Number.isFinite(Number(context?.localId)) ? Math.max(0, Math.floor(Number(context?.localId))) : 0
        const escapedToken = normalizedToken.replace(/'/g, "''")
        const whereFragments = localIdFilter > 0
          ? [`local_id = ${localIdFilter}`]
          : [`CAST(message_content AS TEXT) LIKE '%${escapedToken}%'`, `CAST(compress_content AS TEXT) LIKE '%${escapedToken}%'`]
        const selectFields = Array.from(new Set(['local_id', 'create_time', ...packedColumns, ...sessionColumns]))
        const rowsRes = await wcdbService.execQuery(
          'message',
          dbPath,
          `SELECT ${selectFields.join(', ')} FROM "${escapedTable}" WHERE local_type = 43 AND (${whereFragments.join(' OR ')}) ORDER BY create_time DESC LIMIT ${localIdFilter > 0 ? 8 : 80}`
        )
        if (!rowsRes.success || !Array.isArray(rowsRes.rows)) continue
        if (rowsRes.rows.length > 0) this.debugTrace('message 行查询命中', { dbPath, tableName, localIdFilter, rowCount: rowsRes.rows.length })

        for (const row of rowsRes.rows as Array<Record<string, unknown>>) {
          const localId = Number(row.local_id || 0)
          if (Number.isFinite(localId) && localId > 0) localIdCandidates.add(Math.floor(localId))
          const rowSession = sessionColumns.map((c) => String((row as any)?.[c] || '').trim()).find(Boolean) || ''
          const expectedSession = String(context?.sessionId || '').trim()
          if (expectedSession && rowSession && rowSession !== expectedSession) {
            this.debugTrace('message 行命中但会话不匹配', { dbPath, tableName, localId, rowSession, expectedSession })
            continue
          }

          for (const col of packedColumns) {
            const rawResolved = this.extractVideoNameFromPackedRaw((row as any)?.[col])
            if (!rawResolved) continue
            this.debugTrace('packed_info 原始二进制命中', { token: normalizedToken, resolved: rawResolved, sourceColumn: col, dbPath, tableName, localId: localId || row.local_id, createTime: row.create_time })
            return rawResolved
          }

          const packedTexts = packedColumns.map((col) => ({ col, text: this.toPrintableText((row as any)?.[col]) })).filter((x) => x.text.length > 0)
          if (packedTexts.length === 0) {
            this.debugTrace('message 行命中但 packed 列为空', { dbPath, tableName, localId, packedColumns })
            continue
          }
          for (const item of packedTexts) {
            const strictMp4 = /([a-fA-F0-9]{32})\.mp4\b/.exec(item.text)
            if (strictMp4?.[1]) {
              const resolved = strictMp4[1].toLowerCase()
              this.debugTrace('packed_info 严格命中 32hex.mp4', { token: normalizedToken, resolved, sourceColumn: item.col, dbPath, tableName, localId: localId || row.local_id, createTime: row.create_time })
              return resolved
            }
          }
          const candidates = packedTexts.flatMap((item) => this.extractVideoNameCandidates(item.text))
          const best = this.pickBestVideoCandidate(candidates, normalizedToken)
          if (best) {
            this.debugTrace('packed_info 候选命中', { token: normalizedToken, resolved: best, candidates, dbPath, tableName, localId: localId || row.local_id, createTime: row.create_time })
            return best
          }
        }
      }
    }

    if (localIdCandidates.size > 0 || Number(context?.localId) > 0) {
      if (Number(context?.localId) > 0) localIdCandidates.add(Math.max(0, Math.floor(Number(context?.localId))))
      const dbPath = this.getDbPath()
      const wxid = this.getMyWxid()
      const cleanedWxid = this.cleanWxid(wxid)
      const resourceDbPaths = this.getMessageResourceDbPaths(dbPath, wxid, cleanedWxid)
      this.debugTrace('message_resource 兜底候选', { localIds: Array.from(localIdCandidates).slice(0, 20), resourceDbPaths })
      for (const resourceDbPath of resourceDbPaths) {
        if (!existsSync(resourceDbPath)) {
          this.debugTrace('message_resource.db 不存在', { resourceDbPath })
          continue
        }
        this.debugTrace('message_resource.db 开始查询', { resourceDbPath })
        for (const localId of localIdCandidates) {
          const query = `
            SELECT d.packed_info AS packed_info
            FROM MessageResourceInfo i
            LEFT JOIN MessageResourceDetail d ON i.message_id = d.message_id
            WHERE i.message_local_id = ${localId}
            ORDER BY i.message_id DESC
            LIMIT 8
          `
          const result = await wcdbService.execQuery('message', resourceDbPath, query)
          if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) continue
          let hit = false
          for (const row of result.rows as Array<Record<string, unknown>>) {
            const packedInfo = row.packed_info
            const raw = this.extractVideoNameFromPackedRaw(packedInfo)
            if (raw) {
              this.debugTrace('message_resource packed_info 命中', { token: normalizedToken, resolved: raw, resourceDbPath, localId })
              return raw
            }
            const packedText = this.toPrintableText(packedInfo)
            const candidates = this.extractVideoNameCandidates(packedText)
            const best = this.pickBestVideoCandidate(candidates, normalizedToken)
            if (best) {
              this.debugTrace('message_resource packed_info 命中', { token: normalizedToken, resolved: best, candidates, resourceDbPath, localId })
              return best
            }
            if (packedText) hit = true
          }
          if (!hit) this.debugTrace('message_resource packed_info 为空', { resourceDbPath, localId })
        }
      }
    }

    this.debugTrace('message packed_info 未命中', { token: normalizedToken })
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

  private resolveByKnownVideoName(
    videoBaseDir: string,
    videoName: string,
    context?: VideoLookupContext,
    includePoster = true,
    posterFormat: PosterFormat = 'dataUrl'
  ): VideoInfo | null {
    const normalizedName = this.normalizeVideoToken(videoName)
    if (!normalizedName) return null
    const month = this.toYearMonthFromUnix(context?.createTime)
    if (!month) return null
    const monthDir = join(videoBaseDir, month)
    const videoPath = join(monthDir, `${normalizedName}.mp4`)
    if (!existsSync(videoPath)) {
      this.debugTrace('已知文件名直达未命中', { videoName: normalizedName, monthDir, videoPath })
      return null
    }
    if (!includePoster) return { exists: true, videoUrl: videoPath }
    const base = normalizedName.replace(/_raw$/i, '')
    return {
      exists: true,
      videoUrl: videoPath,
      coverUrl: this.fileToPosterUrl(join(monthDir, `${base}.jpg`), 'image/jpeg', posterFormat),
      thumbUrl: this.fileToPosterUrl(join(monthDir, `${base}_thumb.jpg`), 'image/jpeg', posterFormat)
    }
  }

  private toYearMonthFromUnix(createTime?: number): string {
    const ts = Number(createTime || 0)
    if (!Number.isFinite(ts) || ts <= 0) return ''
    const d = new Date(ts * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  private async calculateFileMd5(filePath: string): Promise<string | null> {
    try {
      if (!existsSync(filePath)) return null
      const stat = statSync(filePath)
      if (!stat.isFile()) return null
      const cached = this.readTimedCache(this.videoContentMd5Cache, filePath)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.md5
      const buf = readFileSync(filePath)
      if (!buf || buf.length === 0) return null
      const md5 = crypto.createHash('md5').update(buf).digest('hex').toLowerCase()
      this.writeTimedCache(this.videoContentMd5Cache, filePath, { md5, mtimeMs: stat.mtimeMs, size: stat.size }, this.contentHashCacheTtlMs, this.maxCacheEntries)
      return md5
    } catch {
      return null
    }
  }

  private async resolveByContentHash(
    videoBaseDir: string,
    targetMd5: string,
    context?: VideoLookupContext,
    includePoster = true,
    posterFormat: PosterFormat = 'dataUrl'
  ): Promise<VideoInfo | null> {
    const normalizedTarget = this.normalizeVideoToken(targetMd5)
    if (!normalizedTarget || !/^[a-f0-9]{32}$/.test(normalizedTarget)) return null
    if (!existsSync(videoBaseDir)) return null
    const preferredMonth = this.toYearMonthFromUnix(context?.createTime)
    const allMonthDirs = readdirSync(videoBaseDir)
      .filter((dir) => {
        try { return statSync(join(videoBaseDir, dir)).isDirectory() } catch { return false }
      })
      .sort((a, b) => b.localeCompare(a))
    const monthDirs = preferredMonth ? allMonthDirs.filter((d) => d === preferredMonth) : allMonthDirs.slice(0, 1)
    if (monthDirs.length === 0) {
      this.debugTrace('内容哈希扫描跳过：无可用月份目录', { targetMd5: normalizedTarget, preferredMonth, monthDirCount: allMonthDirs.length })
      return null
    }
    for (const month of monthDirs) {
      const monthDir = join(videoBaseDir, month)
      let files: string[] = []
      try { files = readdirSync(monthDir).filter((name) => name.toLowerCase().endsWith('.mp4')) } catch { continue }
      if (files.length > 120) files = files.slice(0, 120)
      this.debugTrace('内容哈希扫描目录', { targetMd5: normalizedTarget, monthDir, fileCount: files.length })
      for (const file of files) {
        const fullPath = join(monthDir, file)
        const fileMd5 = await this.calculateFileMd5(fullPath)
        if (fileMd5 !== normalizedTarget) continue
        const base = file.toLowerCase().replace(/\.mp4$/i, '').replace(/_raw$/i, '')
        this.debugTrace('内容哈希命中视频文件', { targetMd5: normalizedTarget, file, fullPath, monthDir })
        if (!includePoster) return { exists: true, videoUrl: fullPath }
        return {
          exists: true,
          videoUrl: fullPath,
          coverUrl: this.fileToPosterUrl(join(monthDir, `${base}.jpg`), 'image/jpeg', posterFormat),
          thumbUrl: this.fileToPosterUrl(join(monthDir, `${base}_thumb.jpg`), 'image/jpeg', posterFormat)
        }
      }
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
  async getVideoInfo(
    videoMd5: string,
    options?: { includePoster?: boolean; posterFormat?: PosterFormat; lookupContext?: VideoLookupContext }
  ): Promise<VideoInfo> {
    const normalizedMd5 = this.normalizeVideoToken(videoMd5)
    const includePoster = options?.includePoster !== false
    const posterFormat: PosterFormat = options?.posterFormat === 'fileUrl' ? 'fileUrl' : 'dataUrl'
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()

    this.log('getVideoInfo 开始', { videoMd5: normalizedMd5, dbPath, wxid })
    this.debugTrace('getVideoInfo 输入', {
      input: videoMd5,
      normalized: normalizedMd5,
      includePoster,
      posterFormat,
      dbPath,
      wxid,
      lookupContext: options?.lookupContext
    })

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
      const realVideoMd5 = await this.queryVideoFileName(normalizedMd5, options?.lookupContext) || normalizedMd5
      const videoBaseDir = this.resolveVideoBaseDir(dbPath, wxid)
      this.debugTrace('getVideoInfo 定位参数', {
        requestedId: normalizedMd5,
        resolvedId: realVideoMd5,
        videoBaseDir
      })

      if (!existsSync(videoBaseDir)) {
        this.debugTrace('视频目录不存在', { videoBaseDir })
        const miss = { exists: false }
        this.writeTimedCache(this.videoInfoCache, cacheKey, miss, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return miss
      }

      const direct = this.resolveByKnownVideoName(videoBaseDir, realVideoMd5, options?.lookupContext, includePoster, posterFormat)
      if (direct) {
        this.debugTrace('已知文件名直达命中', { resolvedId: realVideoMd5, videoUrl: direct.videoUrl })
        const withPoster = await this.ensurePoster(direct, includePoster, posterFormat)
        this.writeTimedCache(this.videoInfoCache, cacheKey, withPoster, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return withPoster
      }

      const index = this.getOrBuildVideoIndex(videoBaseDir)
      const indexed = this.getVideoInfoFromIndex(index, realVideoMd5, includePoster, posterFormat)
      if (indexed) {
        this.debugTrace('视频索引命中', {
          resolvedId: realVideoMd5,
          videoUrl: indexed.videoUrl,
          coverUrl: indexed.coverUrl,
          thumbUrl: indexed.thumbUrl
        })
        const withPoster = await this.ensurePoster(indexed, includePoster, posterFormat)
        this.writeTimedCache(this.videoInfoCache, cacheKey, withPoster, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return withPoster
      }

      const fallback = this.fallbackScanVideo(videoBaseDir, realVideoMd5, includePoster, posterFormat)
      if (fallback) {
        this.debugTrace('视频目录扫描命中', {
          resolvedId: realVideoMd5,
          videoUrl: fallback.videoUrl,
          coverUrl: fallback.coverUrl,
          thumbUrl: fallback.thumbUrl
        })
        const withPoster = await this.ensurePoster(fallback, includePoster, posterFormat)
        this.writeTimedCache(this.videoInfoCache, cacheKey, withPoster, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return withPoster
      }

      const hashMatched = await this.resolveByContentHash(
        videoBaseDir,
        normalizedMd5,
        options?.lookupContext,
        includePoster,
        posterFormat
      )
      if (hashMatched) {
        this.debugTrace('内容MD5兜底命中', { inputMd5: normalizedMd5, videoUrl: hashMatched.videoUrl })
        const withPoster = await this.ensurePoster(hashMatched, includePoster, posterFormat)
        this.writeTimedCache(this.videoInfoCache, cacheKey, withPoster, this.videoInfoCacheTtlMs, this.maxCacheEntries)
        return withPoster
      }

      const miss = { exists: false }
      this.writeTimedCache(this.videoInfoCache, cacheKey, miss, this.videoInfoCacheTtlMs, this.maxCacheEntries)
      this.log('getVideoInfo: 未找到视频', { inputMd5: normalizedMd5, resolvedMd5: realVideoMd5 })
      this.debugTrace('视频查找失败', {
        inputId: normalizedMd5,
        resolvedId: realVideoMd5,
        videoBaseDir,
        tip: '请检查 message_resource/hardlink 与本地 msg/video 是否一致'
      })
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
