import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { rename, rm, writeFile } from 'fs/promises'
import { app } from 'electron'
import { ConfigService } from './config'

/** 缓存版本号。增加/修改 SessionStatsCacheStats 字段后必须提升，避免旧缓存被误用。 */
const CACHE_VERSION = 5
const MAX_SESSION_ENTRIES_PER_SCOPE = 2000
const MAX_SCOPE_ENTRIES = 12
const CACHE_REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800]

function isRetryableCacheReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST'
}

function waitForCacheReplaceRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export interface SessionStatsCacheStats {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  /** 文件类消息数量（对应 ExportSessionStats.fileMessages） */
  fileMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
  /** 请求聚合日期统计时返回；空对象也表示当前缓存具备该能力。 */
  messageDateCounts?: Record<string, number>
  firstTimestamp?: number
  lastTimestamp?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
}

export interface SessionStatsCacheEntry {
  updatedAt: number
  includeRelations: boolean
  stats: SessionStatsCacheStats
}

interface SessionStatsScopeMap {
  [sessionId: string]: SessionStatsCacheEntry
}

interface SessionStatsCacheStore {
  version: number
  scopes: Record<string, SessionStatsScopeMap>
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

function normalizeMessageDateCounts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const normalized: Record<string, number> = {}
  for (const [dateKey, rawCount] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue
    const count = toNonNegativeInt(rawCount)
    if (count === undefined || count <= 0) continue
    normalized[dateKey] = count
  }
  return normalized
}

function normalizeStats(raw: unknown): SessionStatsCacheStats | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>

  const totalMessages = toNonNegativeInt(source.totalMessages)
  const voiceMessages = toNonNegativeInt(source.voiceMessages)
  const imageMessages = toNonNegativeInt(source.imageMessages)
  const videoMessages = toNonNegativeInt(source.videoMessages)
  const emojiMessages = toNonNegativeInt(source.emojiMessages)
  const fileMessages = toNonNegativeInt(source.fileMessages)
  const transferMessages = toNonNegativeInt(source.transferMessages)
  const redPacketMessages = toNonNegativeInt(source.redPacketMessages)
  const callMessages = toNonNegativeInt(source.callMessages)

  if (
    totalMessages === undefined ||
    voiceMessages === undefined ||
    imageMessages === undefined ||
    videoMessages === undefined ||
    emojiMessages === undefined ||
    fileMessages === undefined ||
    transferMessages === undefined ||
    redPacketMessages === undefined ||
    callMessages === undefined
  ) {
    return null
  }

  const normalized: SessionStatsCacheStats = {
    totalMessages,
    voiceMessages,
    imageMessages,
    videoMessages,
    emojiMessages,
    fileMessages,
    transferMessages,
    redPacketMessages,
    callMessages
  }

  const messageDateCounts = normalizeMessageDateCounts(source.messageDateCounts)
  if (messageDateCounts !== undefined) normalized.messageDateCounts = messageDateCounts

  const firstTimestamp = toNonNegativeInt(source.firstTimestamp)
  if (firstTimestamp !== undefined) normalized.firstTimestamp = firstTimestamp

  const lastTimestamp = toNonNegativeInt(source.lastTimestamp)
  if (lastTimestamp !== undefined) normalized.lastTimestamp = lastTimestamp

  const privateMutualGroups = toNonNegativeInt(source.privateMutualGroups)
  if (privateMutualGroups !== undefined) normalized.privateMutualGroups = privateMutualGroups

  const groupMemberCount = toNonNegativeInt(source.groupMemberCount)
  if (groupMemberCount !== undefined) normalized.groupMemberCount = groupMemberCount

  const groupMyMessages = toNonNegativeInt(source.groupMyMessages)
  if (groupMyMessages !== undefined) normalized.groupMyMessages = groupMyMessages

  const groupActiveSpeakers = toNonNegativeInt(source.groupActiveSpeakers)
  if (groupActiveSpeakers !== undefined) normalized.groupActiveSpeakers = groupActiveSpeakers

  const groupMutualFriends = toNonNegativeInt(source.groupMutualFriends)
  if (groupMutualFriends !== undefined) normalized.groupMutualFriends = groupMutualFriends

  return normalized
}

function normalizeEntry(raw: unknown): SessionStatsCacheEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const updatedAt = toNonNegativeInt(source.updatedAt)
  const includeRelations = typeof source.includeRelations === 'boolean' ? source.includeRelations : false
  const stats = normalizeStats(source.stats)

  if (updatedAt === undefined || !stats) {
    return null
  }

  return {
    updatedAt,
    includeRelations,
    stats
  }
}

export class SessionStatsCacheService {
  private readonly cacheFilePath: string
  private persistTimer: NodeJS.Timeout | null = null
  private persistInFlight = false
  private persistDirty = false
  private persistGeneration = 0
  private store: SessionStatsCacheStore = {
    version: CACHE_VERSION,
    scopes: {}
  }

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'session-stats.json')
    this.ensureCacheDir()
    this.load()
    app?.once('will-quit', () => this.flushSync())
  }

  private ensureCacheDir(): void {
    const dir = dirname(this.cacheFilePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private load(): void {
    if (!existsSync(this.cacheFilePath)) return
    try {
      const raw = readFileSync(this.cacheFilePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') {
        this.store = { version: CACHE_VERSION, scopes: {} }
        rmSync(this.cacheFilePath, { force: true })
        return
      }

      const payload = parsed as Record<string, unknown>
      const version = Number(payload.version)
      if (!Number.isFinite(version) || version !== CACHE_VERSION) {
        this.store = { version: CACHE_VERSION, scopes: {} }
        rmSync(this.cacheFilePath, { force: true })
        return
      }
      const scopesRaw = payload.scopes
      if (!scopesRaw || typeof scopesRaw !== 'object') {
        this.store = { version: CACHE_VERSION, scopes: {} }
        rmSync(this.cacheFilePath, { force: true })
        return
      }

      const scopes: Record<string, SessionStatsScopeMap> = {}
      for (const [scopeKey, scopeValue] of Object.entries(scopesRaw as Record<string, unknown>)) {
        if (!scopeValue || typeof scopeValue !== 'object') continue
        const normalizedScope: SessionStatsScopeMap = {}
        for (const [sessionId, entryRaw] of Object.entries(scopeValue as Record<string, unknown>)) {
          const entry = normalizeEntry(entryRaw)
          if (!entry) continue
          normalizedScope[sessionId] = entry
        }
        if (Object.keys(normalizedScope).length > 0) {
          scopes[scopeKey] = normalizedScope
        }
      }

      this.store = {
        version: CACHE_VERSION,
        scopes
      }
    } catch (error) {
      console.error('SessionStatsCacheService: 载入缓存失败', error)
      this.store = { version: CACHE_VERSION, scopes: {} }
      try { rmSync(this.cacheFilePath, { force: true }) } catch {}
    }
  }

  get(scopeKey: string, sessionId: string): SessionStatsCacheEntry | undefined {
    if (!scopeKey || !sessionId) return undefined
    const scope = this.store.scopes[scopeKey]
    if (!scope) return undefined
    const entry = normalizeEntry(scope[sessionId])
    if (!entry) {
      delete scope[sessionId]
      if (Object.keys(scope).length === 0) {
        delete this.store.scopes[scopeKey]
      }
      this.persist()
      return undefined
    }
    return entry
  }

  set(scopeKey: string, sessionId: string, entry: SessionStatsCacheEntry): void {
    if (!scopeKey || !sessionId) return
    const normalized = normalizeEntry(entry)
    if (!normalized) return

    if (!this.store.scopes[scopeKey]) {
      this.store.scopes[scopeKey] = {}
    }
    this.store.scopes[scopeKey][sessionId] = normalized

    this.trimScope(scopeKey)
    this.trimScopes()
    this.persist()
  }

  delete(scopeKey: string, sessionId: string): void {
    if (!scopeKey || !sessionId) return
    this.persistGeneration += 1
    const scope = this.store.scopes[scopeKey]
    if (scope) {
      delete scope[sessionId]
      if (Object.keys(scope).length === 0) {
        delete this.store.scopes[scopeKey]
      }
    }
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  clearScope(scopeKey: string): void {
    if (!scopeKey) return
    this.persistGeneration += 1
    delete this.store.scopes[scopeKey]
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
  }

  clearAll(): void {
    this.persistGeneration += 1
    this.store = { version: CACHE_VERSION, scopes: {} }
    this.persistDirty = false
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      rmSync(this.cacheFilePath, { force: true })
    } catch (error) {
      console.error('SessionStatsCacheService: 清理缓存失败', error)
    }
  }

  private trimScope(scopeKey: string): void {
    const scope = this.store.scopes[scopeKey]
    if (!scope) return
    const entries = Object.entries(scope)
    if (entries.length <= MAX_SESSION_ENTRIES_PER_SCOPE) return

    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    const trimmed: SessionStatsScopeMap = {}
    for (const [sessionId, entry] of entries.slice(0, MAX_SESSION_ENTRIES_PER_SCOPE)) {
      trimmed[sessionId] = entry
    }
    this.store.scopes[scopeKey] = trimmed
  }

  private trimScopes(): void {
    const scopeEntries = Object.entries(this.store.scopes)
    if (scopeEntries.length <= MAX_SCOPE_ENTRIES) return

    scopeEntries.sort((a, b) => {
      const aUpdatedAt = Math.max(...Object.values(a[1]).map((entry) => entry.updatedAt), 0)
      const bUpdatedAt = Math.max(...Object.values(b[1]).map((entry) => entry.updatedAt), 0)
      return bUpdatedAt - aUpdatedAt
    })

    const trimmedScopes: Record<string, SessionStatsScopeMap> = {}
    for (const [scopeKey, scopeMap] of scopeEntries.slice(0, MAX_SCOPE_ENTRIES)) {
      trimmedScopes[scopeKey] = scopeMap
    }
    this.store.scopes = trimmedScopes
  }

  /**
   * 防抖异步落盘：批量刷新会话统计时 set() 会被连续调用，
   * 同步写盘会反复阻塞主线程（文件可达数百 KB）
   */
  private persist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, 1000)
    this.persistTimer.unref?.()
  }

  private async replaceCacheFileWithRetry(temporaryPath: string, generation: number): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (generation !== this.persistGeneration) return false
      try {
        await rename(temporaryPath, this.cacheFilePath)
        return true
      } catch (error) {
        const retryDelay = CACHE_REPLACE_RETRY_DELAYS_MS[attempt]
        if (!isRetryableCacheReplaceError(error) || retryDelay === undefined) throw error
        await waitForCacheReplaceRetry(retryDelay)
      }
    }
  }

  private async persistNow(): Promise<void> {
    if (this.persistInFlight) {
      this.persistDirty = true
      return
    }
    this.persistInFlight = true
    const generation = this.persistGeneration
    const payload = JSON.stringify(this.store)
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${generation}.tmp`
    try {
      await writeFile(temporaryPath, payload, 'utf8')
      if (generation !== this.persistGeneration) {
        await rm(temporaryPath, { force: true })
        return
      }
      const replaced = await this.replaceCacheFileWithRetry(temporaryPath, generation)
      if (!replaced) {
        await rm(temporaryPath, { force: true })
        return
      }
      if (generation !== this.persistGeneration) {
        await rm(this.cacheFilePath, { force: true })
      }
    } catch (error) {
      console.error('SessionStatsCacheService: 保存缓存失败', error)
      await rm(temporaryPath, { force: true }).catch(() => {})
    } finally {
      this.persistInFlight = false
      if (this.persistDirty) {
        this.persistDirty = false
        void this.persistNow()
      }
    }
  }

  /** 退出前把尚未落盘的改动同步写入 */
  private flushSync(): void {
    if (!this.persistTimer) return
    clearTimeout(this.persistTimer)
    this.persistTimer = null
    try {
      writeFileSync(this.cacheFilePath, JSON.stringify(this.store), 'utf8')
    } catch (error) {
      console.error('SessionStatsCacheService: 保存缓存失败', error)
    }
  }
}
