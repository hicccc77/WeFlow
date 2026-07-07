import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, promises as fsPromises } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'

export interface SessionMessageCacheEntry {
  version?: number
  updatedAt: number
  messages: any[]
}

export class MessageCacheService {
  private static readonly CACHE_VERSION = 3
  private readonly cacheFilePath: string
  private cache: Record<string, SessionMessageCacheEntry> = {}
  // 每会话 80 条已覆盖首屏渲染（DB 拉取会随后补全），48→24 个会话、150→80 条
  // 可把该缓存的常驻内存压到原来的 1/4 左右
  private readonly sessionLimit = 80
  private readonly maxSessionEntries = 24
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistInFlight = false
  private persistQueued = false

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'session-messages.json')
    this.ensureCacheDir()
    this.loadCache()
  }

  private ensureCacheDir() {
    const dir = dirname(this.cacheFilePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private loadCache() {
    if (!existsSync(this.cacheFilePath)) return
    try {
      const raw = readFileSync(this.cacheFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.cache = Object.fromEntries(
          Object.entries(parsed as Record<string, SessionMessageCacheEntry>)
            .filter(([, entry]) => entry?.version === MessageCacheService.CACHE_VERSION)
        )
        this.pruneSessionEntries()
      }
    } catch (error) {
      console.error('MessageCacheService: 载入缓存失败', error)
      this.cache = {}
    }
  }

  private pruneSessionEntries(): void {
    const entries = Object.entries(this.cache || {})
    if (entries.length <= this.maxSessionEntries) return

    entries.sort((left, right) => {
      const leftAt = Number(left[1]?.updatedAt || 0)
      const rightAt = Number(right[1]?.updatedAt || 0)
      return rightAt - leftAt
    })

    this.cache = Object.fromEntries(entries.slice(0, this.maxSessionEntries))
  }

  get(sessionId: string): SessionMessageCacheEntry | undefined {
    return this.cache[sessionId]
  }

  set(sessionId: string, messages: any[]): void {
    if (!sessionId) return
    const trimmed = messages.length > this.sessionLimit
      ? messages.slice(-this.sessionLimit)
      : messages.slice()
    this.cache[sessionId] = {
      version: MessageCacheService.CACHE_VERSION,
      updatedAt: Date.now(),
      messages: trimmed
    }
    this.pruneSessionEntries()
    this.schedulePersist()
  }

  private schedulePersist(): void {
    this.persistQueued = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 250)
  }

  private async persist() {
    if (this.persistInFlight) {
      this.schedulePersist()
      return
    }
    if (!this.persistQueued) return
    this.persistQueued = false
    this.persistInFlight = true
    try {
      await fsPromises.writeFile(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
    } catch (error) {
      console.error('MessageCacheService: 保存缓存失败', error)
    } finally {
      this.persistInFlight = false
      if (this.persistQueued) {
        this.schedulePersist()
      }
    }
  }

  clear(): void {
    this.cache = {}
    this.persistQueued = false
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      rmSync(this.cacheFilePath, { force: true })
    } catch (error) {
      console.error('MessageCacheService: 清理缓存失败', error)
    }
  }
}
