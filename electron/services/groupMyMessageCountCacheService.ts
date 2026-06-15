import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { ConfigService } from './config'

const CACHE_VERSION = 1
const MAX_GROUP_ENTRIES_PER_SCOPE = 3000
const MAX_SCOPE_ENTRIES = 12

export interface GroupMyMessageCountCacheEntry {
  updatedAt: number
  messageCount: number
}

interface GroupMyMessageCountScopeMap {
  [chatroomId: string]: GroupMyMessageCountCacheEntry
}

interface GroupMyMessageCountCacheStore {
  version: number
  scopes: Record<string, GroupMyMessageCountScopeMap>
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

function normalizeEntry(raw: unknown): GroupMyMessageCountCacheEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const updatedAt = toNonNegativeInt(source.updatedAt)
  const messageCount = toNonNegativeInt(source.messageCount)
  if (updatedAt === undefined || messageCount === undefined) return null
  return {
    updatedAt,
    messageCount
  }
}

export class GroupMyMessageCountCacheService {
  private readonly cacheFilePath: string
  private store: GroupMyMessageCountCacheStore = {
    version: CACHE_VERSION,
    scopes: {}
  }

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'group-my-message-counts.json')
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
      const scopesRaw = payload.scopes
      if (!scopesRaw || typeof scopesRaw !== 'object') {
        this.store = { version: CACHE_VERSION, scopes: {} }
        return
      }

      const scopes: Record<string, GroupMyMessageCountScopeMap> = {}
      for (const [scopeKey, scopeValue] of Object.entries(scopesRaw as Record<string, unknown>)) {
        if (!scopeValue || typeof scopeValue !== 'object') continue
        const normalizedScope: GroupMyMessageCountScopeMap = {}
        for (const [chatroomId, entryRaw] of Object.entries(scopeValue as Record<string, unknown>)) {
          const entry = normalizeEntry(entryRaw)
          if (!entry) continue
          normalizedScope[chatroomId] = entry
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
      console.error('GroupMyMessageCountCacheService: 载入缓存失败', error)
      this.store = { version: CACHE_VERSION, scopes: {} }
    }
  }

  get(scopeKey: string, chatroomId: string): GroupMyMessageCountCacheEntry | undefined {
    if (!scopeKey || !chatroomId) return undefined
    const scope = this.store.scopes[scopeKey]
    if (!scope) return undefined
    const entry = normalizeEntry(scope[chatroomId])
    if (!entry) {
      delete scope[chatroomId]
      if (Object.keys(scope).length === 0) {
        delete this.store.scopes[scopeKey]
      }
      this.persist()
      return undefined
    }
    return entry
  }

  set(scopeKey: string, chatroomId: string, entry: GroupMyMessageCountCacheEntry): void {
    if (!scopeKey || !chatroomId) return
    const normalized = normalizeEntry(entry)
    if (!normalized) return

    if (!this.store.scopes[scopeKey]) {
      this.store.scopes[scopeKey] = {}
    }

    const existing = this.store.scopes[scopeKey][chatroomId]
    if (existing && existing.updatedAt > normalized.updatedAt) {
      return
    }

    this.store.scopes[scopeKey][chatroomId] = normalized
    this.trimScope(scopeKey)
    this.trimScopes()
    this.persist()
  }

  delete(scopeKey: string, chatroomId: string): void {
    if (!scopeKey || !chatroomId) return
    const scope = this.store.scopes[scopeKey]
    if (!scope) return
    if (!(chatroomId in scope)) return
    delete scope[chatroomId]
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
      console.error('GroupMyMessageCountCacheService: 清理缓存失败', error)
    }
  }

  private trimScope(scopeKey: string): void {
    const scope = this.store.scopes[scopeKey]
    if (!scope) return
    const entries = Object.entries(scope)
    if (entries.length <= MAX_GROUP_ENTRIES_PER_SCOPE) return
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    const trimmed: GroupMyMessageCountScopeMap = {}
    for (const [chatroomId, entry] of entries.slice(0, MAX_GROUP_ENTRIES_PER_SCOPE)) {
      trimmed[chatroomId] = entry
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

    const trimmedScopes: Record<string, GroupMyMessageCountScopeMap> = {}
    for (const [scopeKey, scopeMap] of scopeEntries.slice(0, MAX_SCOPE_ENTRIES)) {
      trimmedScopes[scopeKey] = scopeMap
    }
    this.store.scopes = trimmedScopes
  }

  private persist(): void {
    try {
      writeFileSync(this.cacheFilePath, JSON.stringify(this.store), 'utf8')
    } catch (error) {
      console.error('GroupMyMessageCountCacheService: 保存缓存失败', error)
    }
  }
}
