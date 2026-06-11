import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
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
  private readonly maxSessionEntries = 48
  private persistTimer: NodeJS.Timeout | null = null
  private isDirty = false

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
      updatedAt: Date.now(),
      messages: trimmed
    }
    this.pruneSessionEntries()
    this.schedulePersist()
  }

  private schedulePersist() {
    this.isDirty = true
    if (this.persistTimer) return

    // 防抖 3 秒：3 秒内无新写入则持久化
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (this.isDirty) {
        this.persist()
        this.isDirty = false
      }
    }, 3000)
  }

  private persist() {
    writeFile(this.cacheFilePath, JSON.stringify(this.cache), 'utf8').catch(error => {
      console.error('MessageCacheService: 保存缓存失败', error)
    })
  }

  clear(): void {
    this.cache = {}
    this.isDirty = false
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

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.isDirty) {
      await writeFile(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
      this.isDirty = false
    }
  }
}
