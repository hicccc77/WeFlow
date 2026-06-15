import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { ConfigService } from './config'

const CACHE_VERSION = 2
const MAX_SESSION_ENTRIES_PER_SCOPE = 2000
const MAX_SCOPE_ENTRIES = 12

export interface SessionStatsCacheStats {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
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

function normalizeStats(raw: unknown): SessionStatsCacheStats | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>

  const totalMessages = toNonNegativeInt(source.totalMessages)
  const voiceMessages = toNonNegativeInt(source.voiceMessages)
  const imageMessages = toNonNegativeInt(source.imageMessages)
  const videoMessages = toNonNegativeInt(source.videoMessages)
  const emojiMessages = toNonNegativeInt(source.emojiMessages)
  const transferMessages = toNonNegativeInt(source.transferMessages)
  const redPacketMessages = toNonNegativeInt(source.redPacketMessages)
  const callMessages = toNonNegativeInt(source.callMessages)

  if (
    totalMessages === undefined ||
    voiceMessages === undefined ||
    imageMessages === undefined ||
    videoMessages === undefined ||
    emojiMessages === undefined ||
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
    transferMessages,
    redPacketMessages,
    callMessages
  }

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
        return
      }

      const payload = parsed as Record<string, unknown>
      const version = Number(payload.version)
      if (!Number.isFinite(version) || version !== CACHE_VERSION) {
        this.store = { version: CACHE_VERSION, scopes: {} }
        return
      }
      const scopesRaw = payload.scopes
      if (!scopesRaw || typeof scopesRaw !== 'object') {
        this.store = { version: CACHE_VERSION, scopes: {} }
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
    const scope = this.store.scopes[scopeKey]
    if (!scope) return
    if (!(sessionId in scope)) return

    delete scope[sessionId]
    if (Object.keys(scope).length === 0) {
      delete this.store.scopes[scopeKey]
    }
    this.persist()
  }

  clearScope(scopeKey: string): void {
    if (!scopeKey) return
    if (!this.store.scopes[scopeKey]) return
    delete this.store.scopes[scopeKey]
    this.persist()
  }

  clearAll(): void {
    this.store = { version: CACHE_VERSION, scopes: {} }
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

  private persist(): void {
    try {
      writeFileSync(this.cacheFilePath, JSON.stringify(this.store), 'utf8')
    } catch (error) {
      console.error('SessionStatsCacheService: 保存缓存失败', error)
    }
  }
}
