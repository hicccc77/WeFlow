import { join, dirname, resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { writeFile, rename, rm } from 'fs/promises'
import { app } from 'electron'
import { createHash } from 'crypto'
import { ConfigService } from './config'

export interface ContactCacheEntry {
  displayName?: string
  avatarUrl?: string
  updatedAt: number
}

/**
 * Persistent caches belong to the physical account, not to a particular
 * decrypt key.  Keeping this derivation in one place prevents Chat/SNS from
 * silently creating different namespaces for the same account.
 */
export function buildStableAccountCacheScope(accountDir: string, accountId: string): string {
  const rawAccountDir = String(accountDir || '').trim()
  const normalizedAccountId = String(accountId || '').trim().toLowerCase()
  if (!rawAccountDir || !normalizedAccountId) return ''
  const absolute = resolve(rawAccountDir)
  const normalizedPath = (process.platform === 'win32' ? absolute.toLowerCase() : absolute)
    .replace(/[\\/]+$/, '')
  if (!normalizedPath) return ''
  return createHash('sha256')
    .update(`${normalizedPath}\u0000${normalizedAccountId}`)
    .digest('hex')
}

export class ContactCacheService {
  // v2 used the decrypt-key-bearing connection identity as its account scope.
  // It cannot be mapped safely after a key change, so v3 deliberately drops it.
  private static readonly CACHE_VERSION = 3
  private static readonly instances = new Map<string, ContactCacheService>()
  private readonly cacheFilePath: string
  private cache: Record<string, Record<string, ContactCacheEntry>> = {}
  private persistTimer: NodeJS.Timeout | null = null
  private persistInFlight = false
  private persistDirty = false
  private persistGeneration = 0

  static getInstance(cacheBasePath?: string): ContactCacheService {
    const basePath = cacheBasePath && cacheBasePath.trim().length > 0
      ? cacheBasePath
      : ConfigService.getInstance().getCacheBasePath()
    const absolute = resolve(basePath)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    const existing = ContactCacheService.instances.get(key)
    if (existing) return existing
    const created = new ContactCacheService(basePath)
    ContactCacheService.instances.set(key, created)
    return created
  }

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
      if (parsed?.version === ContactCacheService.CACHE_VERSION && parsed.accounts && typeof parsed.accounts === 'object') {
        const accounts = parsed.accounts as Record<string, Record<string, ContactCacheEntry>>
        // 清除无效的头像数据（hex 格式而非正确的 base64）
        for (const entries of Object.values(accounts)) {
          for (const entry of Object.values(entries || {})) {
            if (entry?.avatarUrl && entry.avatarUrl.includes('base64,ffd8')) {
              entry.avatarUrl = undefined
            }
          }
        }
        this.cache = accounts
      } else {
        // Old unscoped/key-scoped files are privacy-sensitive cache only.  Do
        // not leave them on disk after deciding they are incompatible.
        this.cache = {}
        rmSync(this.cacheFilePath, { force: true })
      }
    } catch (error) {
      console.error('ContactCacheService: 载入缓存失败', error)
      this.cache = {}
      try { rmSync(this.cacheFilePath, { force: true }) } catch {}
    }
  }

  get(accountScope: string, username: string): ContactCacheEntry | undefined {
    if (!accountScope || !username) return undefined
    return this.cache[accountScope]?.[username]
  }

  getAllEntries(accountScope: string): Record<string, ContactCacheEntry> {
    return accountScope ? { ...(this.cache[accountScope] || {}) } : {}
  }

  setEntries(accountScope: string, entries: Record<string, ContactCacheEntry>): void {
    if (!accountScope || Object.keys(entries).length === 0) return
    const scoped = this.cache[accountScope] || {}
    let changed = false
    for (const [username, entry] of Object.entries(entries)) {
      const existing = scoped[username]
      if (!existing || entry.updatedAt >= existing.updatedAt) {
        scoped[username] = entry
        changed = true
      }
    }
    if (changed) {
      this.cache[accountScope] = scoped
      this.persist()
    }
  }

  clearScope(accountScope: string): void {
    if (!accountScope) return
    // Prevent an older in-flight JSON snapshot from restoring the removed
    // account once the scoped clear has completed in memory.
    this.persistGeneration += 1
    delete this.cache[accountScope]
    if (this.persistInFlight) this.persistDirty = true
    this.persist()
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
    const generation = this.persistGeneration
    const payload = JSON.stringify({ version: ContactCacheService.CACHE_VERSION, accounts: this.cache })
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${generation}.tmp`
    try {
      await writeFile(temporaryPath, payload, 'utf8')
      if (generation !== this.persistGeneration) {
        await rm(temporaryPath, { force: true })
        return
      }
      await rename(temporaryPath, this.cacheFilePath)
      if (generation !== this.persistGeneration) {
        await rm(this.cacheFilePath, { force: true })
      }
    } catch (error) {
      console.error('ContactCacheService: 保存缓存失败', error)
      await rm(temporaryPath, { force: true }).catch(() => {})
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
      writeFileSync(this.cacheFilePath, JSON.stringify({ version: ContactCacheService.CACHE_VERSION, accounts: this.cache }), 'utf8')
    } catch (error) {
      console.error('ContactCacheService: 保存缓存失败', error)
    }
  }

  clear(): void {
    this.persistGeneration += 1
    this.cache = {}
    this.persistDirty = false
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
