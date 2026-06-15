import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { ConfigService } from './config'

const CACHE_VERSION = 1
const MAX_SCOPE_ENTRIES = 12
const MAX_SESSION_ENTRIES_PER_SCOPE = 6000

export interface ExportContentSessionStatsEntry {
  updatedAt: number
  hasAny: boolean
  hasVoice: boolean
  hasImage: boolean
  hasVideo: boolean
  hasEmoji: boolean
  mediaReady: boolean
}

export interface ExportContentScopeStatsEntry {
  updatedAt: number
  sessions: Record<string, ExportContentSessionStatsEntry>
}

interface ExportContentStatsStore {
  version: number
  scopes: Record<string, ExportContentScopeStatsEntry>
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

function normalizeSessionStatsEntry(raw: unknown): ExportContentSessionStatsEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const updatedAt = toNonNegativeInt(source.updatedAt)
  if (updatedAt === undefined) return null
  return {
    updatedAt,
    hasAny: toBoolean(source.hasAny, false),
    hasVoice: toBoolean(source.hasVoice, false),
    hasImage: toBoolean(source.hasImage, false),
    hasVideo: toBoolean(source.hasVideo, false),
    hasEmoji: toBoolean(source.hasEmoji, false),
    mediaReady: toBoolean(source.mediaReady, false)
  }
}

function normalizeScopeStatsEntry(raw: unknown): ExportContentScopeStatsEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const updatedAt = toNonNegativeInt(source.updatedAt)
  if (updatedAt === undefined) return null

  const sessionsRaw = source.sessions
  if (!sessionsRaw || typeof sessionsRaw !== 'object') {
    return {
      updatedAt,
      sessions: {}
    }
  }

  const sessions: Record<string, ExportContentSessionStatsEntry> = {}
  for (const [sessionId, entryRaw] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    const normalized = normalizeSessionStatsEntry(entryRaw)
    if (!normalized) continue
    sessions[sessionId] = normalized
  }

  return {
    updatedAt,
    sessions
  }
}

function cloneScope(scope: ExportContentScopeStatsEntry): ExportContentScopeStatsEntry {
  return {
    updatedAt: scope.updatedAt,
    sessions: Object.fromEntries(
      Object.entries(scope.sessions).map(([sessionId, entry]) => [sessionId, { ...entry }])
    )
  }
}

export class ExportContentStatsCacheService {
  private readonly cacheFilePath: string
  private store: ExportContentStatsStore = {
    version: CACHE_VERSION,
    scopes: {}
  }

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'export-content-stats.json')
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

      const scopes: Record<string, ExportContentScopeStatsEntry> = {}
      for (const [scopeKey, scopeRaw] of Object.entries(scopesRaw as Record<string, unknown>)) {
        const normalizedScope = normalizeScopeStatsEntry(scopeRaw)
        if (!normalizedScope) continue
        scopes[scopeKey] = normalizedScope
      }

      this.store = {
        version: CACHE_VERSION,
        scopes
      }
    } catch (error) {
      console.error('ExportContentStatsCacheService: 载入缓存失败', error)
      this.store = { version: CACHE_VERSION, scopes: {} }
    }
  }

  getScope(scopeKey: string): ExportContentScopeStatsEntry | undefined {
    if (!scopeKey) return undefined
    const rawScope = this.store.scopes[scopeKey]
    if (!rawScope) return undefined
    const normalizedScope = normalizeScopeStatsEntry(rawScope)
    if (!normalizedScope) {
      delete this.store.scopes[scopeKey]
      this.persist()
      return undefined
    }
    this.store.scopes[scopeKey] = normalizedScope
    return cloneScope(normalizedScope)
  }

  setScope(scopeKey: string, scope: ExportContentScopeStatsEntry): void {
    if (!scopeKey) return
    const normalized = normalizeScopeStatsEntry(scope)
    if (!normalized) return
    this.store.scopes[scopeKey] = normalized
    this.trimScope(scopeKey)
    this.trimScopes()
    this.persist()
  }

  deleteSession(scopeKey: string, sessionId: string): void {
    if (!scopeKey || !sessionId) return
    const scope = this.store.scopes[scopeKey]
    if (!scope) return
    if (!(sessionId in scope.sessions)) return
    delete scope.sessions[sessionId]
    if (Object.keys(scope.sessions).length === 0) {
      delete this.store.scopes[scopeKey]
    } else {
      scope.updatedAt = Date.now()
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
      console.error('ExportContentStatsCacheService: 清理缓存失败', error)
    }
  }

  private trimScope(scopeKey: string): void {
    const scope = this.store.scopes[scopeKey]
    if (!scope) return

    const entries = Object.entries(scope.sessions)
    if (entries.length <= MAX_SESSION_ENTRIES_PER_SCOPE) return

    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    scope.sessions = Object.fromEntries(entries.slice(0, MAX_SESSION_ENTRIES_PER_SCOPE))
  }

  private trimScopes(): void {
    const scopeEntries = Object.entries(this.store.scopes)
    if (scopeEntries.length <= MAX_SCOPE_ENTRIES) return

    scopeEntries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    this.store.scopes = Object.fromEntries(scopeEntries.slice(0, MAX_SCOPE_ENTRIES))
  }

  private persist(): void {
    try {
      this.ensureCacheDir()
      writeFileSync(this.cacheFilePath, JSON.stringify(this.store), 'utf8')
    } catch (error) {
      console.error('ExportContentStatsCacheService: 持久化缓存失败', error)
    }
  }
}
