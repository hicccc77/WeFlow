import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'

export interface SessionMessageCacheEntry {
  updatedAt: number
  messages: any[]
}

export class MessageCacheService {
  private readonly cacheFilePath: string
  private cache: Record<string, SessionMessageCacheEntry> = {}
  private readonly sessionLimit = 150

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
        this.cache = parsed
      }
    } catch (error) {
      console.error('MessageCacheService: 载入缓存失败', error)
      this.cache = {}
    }
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
      updatedAt: Date.now(),
      messages: trimmed
    }
    this.persist()
  }

  private persist() {
    try {
      writeFileSync(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
    } catch (error) {
      console.error('MessageCacheService: 保存缓存失败', error)
    }
  }

  clear(): void {
    this.cache = {}
    try {
      rmSync(this.cacheFilePath, { force: true })
    } catch (error) {
      console.error('MessageCacheService: 清理缓存失败', error)
    }
  }
}
