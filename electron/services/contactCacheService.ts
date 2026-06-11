import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
import { app } from 'electron'
import { ConfigService } from './config'

export interface ContactCacheEntry {
  displayName?: string
  avatarUrl?: string
  updatedAt: number
  lastAccessedAt?: number
}

export class ContactCacheService {
  private readonly cacheFilePath: string
  private cache: Record<string, ContactCacheEntry> = {}
  private readonly maxEntries = 1000
  private persistTimer: NodeJS.Timeout | null = null
  private isDirty = false

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'contacts.json')
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
        // 清除无效的头像数据（hex 格式而非正确的 base64）
        for (const key of Object.keys(parsed)) {
          const entry = parsed[key]
          if (entry?.avatarUrl && entry.avatarUrl.includes('base64,ffd8')) {
            // 这是错误的 hex 格式，清除它
            entry.avatarUrl = undefined
          }
        }
        this.cache = parsed
      }
    } catch (error) {
      console.error('ContactCacheService: 载入缓存失败', error)
      this.cache = {}
    }
  }

  get(username: string): ContactCacheEntry | undefined {
    const entry = this.cache[username]
    if (entry) {
      entry.lastAccessedAt = Date.now()
    }
    return entry
  }

  getAllEntries(): Record<string, ContactCacheEntry> {
    return { ...this.cache }
  }

  setEntries(entries: Record<string, ContactCacheEntry>): void {
    if (Object.keys(entries).length === 0) return
    let changed = false
    for (const [username, entry] of Object.entries(entries)) {
      const existing = this.cache[username]
      if (!existing || entry.updatedAt >= existing.updatedAt) {
        this.cache[username] = { ...entry, lastAccessedAt: Date.now() }
        changed = true
      }
    }
    if (changed) {
      this.enforceSizeLimit()
      this.schedulePersist()
    }
  }

  private enforceSizeLimit() {
    const entries = Object.entries(this.cache)
    if (entries.length <= this.maxEntries) return

    // LRU：按 lastAccessedAt 排序，删除最旧的
    const sorted = entries.sort((a, b) => {
      const aTime = a[1].lastAccessedAt || a[1].updatedAt
      const bTime = b[1].lastAccessedAt || b[1].updatedAt
      return bTime - aTime
    })

    const toKeep = sorted.slice(0, this.maxEntries)
    this.cache = Object.fromEntries(toKeep)
    console.log(`[ContactCache] LRU 淘汰 ${entries.length - this.maxEntries} 个联系人`)
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
      console.error('ContactCacheService: 保存缓存失败', error)
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
      console.error('ContactCacheService: 清理缓存失败', error)
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
