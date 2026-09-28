import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, promises as fsPromises } from 'fs'
import { ConfigService } from './config'

export interface SessionMessageCacheEntry {
  version?: number
  accountScope?: string
  sessionId?: string
  updatedAt: number
  messages: any[]
}

export interface MessageCacheWriteToken {
  clearGeneration: number
  scopeGeneration: number
  sessionGeneration: number
}

export class MessageCacheService {
  // v4 used the decrypt-key-bearing connection identity as account scope.
  // The stable physical-account scope introduced in v5 cannot safely migrate it.
  // v6 adds the raw database status field to cached message objects.
  private static readonly CACHE_VERSION = 6
  private readonly cacheFilePath: string
  private cache: Record<string, SessionMessageCacheEntry> = {}
  // 每会话 80 条已覆盖首屏渲染（DB 拉取会随后补全），48→24 个会话、150→80 条
  // 可把该缓存的常驻内存压到原来的 1/4 左右
  private readonly sessionLimit = 80
  private readonly maxSessionEntries = 24
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistQueued = false
  private persistGeneration = 0
  private persistSequence = 0
  private persistQueue: Promise<void> = Promise.resolve()
  private clearGeneration = 0
  private scopeGenerations = new Map<string, number>()
  private sessionGenerations = new Map<string, number>()

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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('消息缓存格式无效')
      }
      const entries = Object.entries(parsed as Record<string, SessionMessageCacheEntry>)
      const compatible = entries.every(([, entry]) => (
        entry?.version === MessageCacheService.CACHE_VERSION &&
        typeof entry.accountScope === 'string' && Boolean(entry.accountScope) &&
        typeof entry.sessionId === 'string' && Boolean(entry.sessionId)
      ))
      if (!compatible) {
        this.cache = {}
        rmSync(this.cacheFilePath, { force: true })
        return
      }
      this.cache = Object.fromEntries(entries)
      this.pruneSessionEntries()
    } catch (error) {
      console.error('MessageCacheService: 载入缓存失败', error)
      this.cache = {}
      try { rmSync(this.cacheFilePath, { force: true }) } catch {}
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

  private buildKey(accountScope: string, sessionId: string): string {
    return `${accountScope}\u0000${sessionId}`
  }

  get(accountScope: string, sessionId: string): SessionMessageCacheEntry | undefined {
    if (!accountScope || !sessionId) return undefined
    const entry = this.cache[this.buildKey(accountScope, sessionId)]
    return entry?.accountScope === accountScope && entry?.sessionId === sessionId ? entry : undefined
  }

  captureWriteToken(accountScope: string, sessionId: string): MessageCacheWriteToken {
    const key = this.buildKey(accountScope, sessionId)
    return {
      clearGeneration: this.clearGeneration,
      scopeGeneration: this.scopeGenerations.get(accountScope) || 0,
      sessionGeneration: this.sessionGenerations.get(key) || 0
    }
  }

  private isWriteTokenCurrent(accountScope: string, sessionId: string, token: MessageCacheWriteToken): boolean {
    const current = this.captureWriteToken(accountScope, sessionId)
    return current.clearGeneration === token.clearGeneration &&
      current.scopeGeneration === token.scopeGeneration &&
      current.sessionGeneration === token.sessionGeneration
  }

  set(accountScope: string, sessionId: string, messages: any[], token?: MessageCacheWriteToken): void {
    if (!accountScope || !sessionId) return
    if (token && !this.isWriteTokenCurrent(accountScope, sessionId, token)) return
    const trimmed = messages.length > this.sessionLimit
      ? messages.slice(-this.sessionLimit)
      : messages.slice()
    this.cache[this.buildKey(accountScope, sessionId)] = {
      version: MessageCacheService.CACHE_VERSION,
      accountScope,
      sessionId,
      updatedAt: Date.now(),
      messages: trimmed
    }
    this.pruneSessionEntries()
    this.schedulePersist()
  }

  async delete(accountScope: string, sessionId: string): Promise<void> {
    if (!accountScope || !sessionId) return
    // Bump even when the key is absent in memory: an older queued snapshot may
    // still contain it and must not be allowed to resurrect the session.
    this.persistGeneration += 1
    const key = this.buildKey(accountScope, sessionId)
    this.sessionGenerations.set(key, (this.sessionGenerations.get(key) || 0) + 1)
    delete this.cache[key]
    await this.persistDestructiveMutation()
  }

  async clearScope(accountScope: string): Promise<void> {
    if (!accountScope) return
    const remaining = Object.entries(this.cache)
      .filter(([, entry]) => entry?.accountScope !== accountScope)
    // Invalidate a snapshot already being written so it cannot resurrect the
    // removed account after this scoped clear.
    this.persistGeneration += 1
    this.scopeGenerations.set(accountScope, (this.scopeGenerations.get(accountScope) || 0) + 1)
    this.cache = Object.fromEntries(remaining)
    await this.persistDestructiveMutation()
  }

  private schedulePersist(): void {
    this.persistQueued = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.enqueuePersist(false)
    }, 250)
    this.persistTimer.unref?.()
  }

  private enqueuePersist(force: boolean): Promise<void> {
    if (!force && !this.persistQueued) return this.persistQueue
    this.persistQueued = false
    const generation = this.persistGeneration
    const payload = JSON.stringify(this.cache)
    const sequence = ++this.persistSequence
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${generation}.${sequence}.tmp`
    const operation = async () => {
      if (generation !== this.persistGeneration) return
      try {
        await fsPromises.writeFile(temporaryPath, payload, 'utf8')
        if (generation !== this.persistGeneration) {
          await fsPromises.rm(temporaryPath, { force: true })
          return
        }
        await fsPromises.rename(temporaryPath, this.cacheFilePath)
      } catch (error) {
        console.error('MessageCacheService: 保存缓存失败', error)
        await fsPromises.rm(temporaryPath, { force: true }).catch(() => {})
        if (generation === this.persistGeneration) {
          // A stale preview is worse than a cache miss, especially for a
          // destructive mutation.  If replacement fails, drop the cache file.
          await fsPromises.rm(this.cacheFilePath, { force: true }).catch(() => {})
        }
      }
    }
    const result = this.persistQueue.then(operation, operation)
    this.persistQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async persistDestructiveMutation(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistQueued = false
    // Queue behind a write that may already have passed its generation check.
    // The destructive snapshot is therefore always the final durable write.
    await this.enqueuePersist(true)
  }

  async clear(): Promise<void> {
    this.persistGeneration += 1
    this.clearGeneration += 1
    this.scopeGenerations.clear()
    this.sessionGenerations.clear()
    this.cache = {}
    this.persistQueued = false
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const generation = this.persistGeneration
    const operation = async () => {
      if (generation !== this.persistGeneration) return
      try {
        await fsPromises.rm(this.cacheFilePath, { force: true })
      } catch (error) {
        console.error('MessageCacheService: 清理缓存失败', error)
      }
    }
    const result = this.persistQueue.then(operation, operation)
    this.persistQueue = result.then(() => undefined, () => undefined)
    await result
  }
}
