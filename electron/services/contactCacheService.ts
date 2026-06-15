import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'

export interface ContactCacheEntry {
  displayName?: string
  avatarUrl?: string
  updatedAt: number
}

export class ContactCacheService {
  private readonly cacheFilePath: string
  private cache: Record<string, ContactCacheEntry> = {}

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
    return this.cache[username]
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
        this.cache[username] = entry
        changed = true
      }
    }
    if (changed) {
      this.persist()
    }
  }

  private persist() {
    try {
      writeFileSync(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
    } catch (error) {
      console.error('ContactCacheService: 保存缓存失败', error)
    }
  }

  clear(): void {
    this.cache = {}
    try {
      rmSync(this.cacheFilePath, { force: true })
    } catch (error) {
      console.error('ContactCacheService: 清理缓存失败', error)
    }
  }
}
