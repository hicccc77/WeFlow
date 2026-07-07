import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { writeFile } from 'fs/promises'
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
  private persistTimer: NodeJS.Timeout | null = null
  private persistInFlight = false
  private persistDirty = false

  constructor(cacheBasePath?: string) {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    this.cacheFilePath = join(basePath, 'contacts.json')
    this.ensureCacheDir()
    this.loadCache()
    app?.once('will-quit', () => this.flushSync())
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

  /** 防抖异步落盘：启动阶段批量补全联系人时避免连续同步写盘阻塞主线程 */
  private persist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, 1000)
    this.persistTimer.unref?.()
  }

  private async persistNow(): Promise<void> {
    if (this.persistInFlight) {
      this.persistDirty = true
      return
    }
    this.persistInFlight = true
    try {
      await writeFile(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
    } catch (error) {
      console.error('ContactCacheService: 保存缓存失败', error)
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
      writeFileSync(this.cacheFilePath, JSON.stringify(this.cache), 'utf8')
    } catch (error) {
      console.error('ContactCacheService: 保存缓存失败', error)
    }
  }

  clear(): void {
    this.cache = {}
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
}
