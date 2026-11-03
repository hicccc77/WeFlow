import { app } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { join, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigService } from './config'
import { snsService, type SnsPost } from './snsService'
import { SnsRetentionStore, snsRetentionAccountHash, SNS_RETENTION_MAX_BYTES, type RetainedSnsPost, type SnsRetentionListOptions, type SnsMediaJob } from './snsRetentionStore'

export type { RetainedSnsPost, RetainedSnsMedia, SnsRetentionListOptions } from './snsRetentionStore'
export interface SnsRetentionStatus {
  enabled: boolean; running: boolean; totalPosts: number; totalSnapshots: number; savedMedia: number; pendingMedia: number; failedMedia: number
  lastScanAt: number | null; baselineComplete: boolean; baselineOffset: number; error?: string; archivePath?: string
}
/** Never fetch arbitrary URLs embedded in a post or follow link-card destinations. */
export function isTrustedSnsMediaUrl(value: string): boolean {
  if (!value || value.length > 32768) return false
  try {
    const url = new URL(value); const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      (host === 'qpic.cn' || host.endsWith('.qpic.cn') || host === 'qlogo.cn' || host.endsWith('.qlogo.cn') ||
        host === 'video.qq.com' || host.endsWith('.video.qq.com') || host === 'wxapp.tc.qq.com' || host.endsWith('.wxapp.tc.qq.com') ||
        host === 'vweixinthumb.tc.qq.com' || host.endsWith('.vweixinthumb.tc.qq.com'))
  } catch { return false }
}
export async function trustedSnsLocalPath(value: string, roots: string[]): Promise<string | null> {
  try {
    const path = value.startsWith('file:') ? fileURLToPath(value) : value
    if (!isAbsolute(path)) return null
    const real = await fs.realpath(path)
    for (const root of roots) {
      const realRoot = await fs.realpath(root).catch(() => '')
      if (!realRoot) continue
      const child = relative(realRoot, real)
      if (child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)) return real
    }
  } catch { /* Missing files and symlinks outside cache roots are not retained. */ }
  return null
}

class SnsRetentionService {
  private config: ConfigService | null = null
  private store: SnsRetentionStore | null = null
  private identity = ''
  private generation = 0
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt = 0
  private scanPromise: Promise<void> | null = null
  private wakeRequested = false
  private lastRecentScan = 0
  private lastFullScan = 0
  private workers = 0
  private error: string | undefined
  private cfg(): ConfigService { return this.config || (this.config = new ConfigService()) }
  private enabled(): boolean { return Boolean(this.cfg().get('snsRetentionEnabled')) }
  private accountIdentity(): string {
    const account = String(this.cfg().get('myAccountId') || '').trim(); const path = String(this.cfg().get('dbPath') || '').trim()
    const directory = account && path ? this.cfg().getAccountDir(path, account) : null
    return directory ? account + '\0' + directory : ''
  }
  private ensureStore(create: boolean): SnsRetentionStore | null {
    const identity = this.accountIdentity()
    if (identity !== this.identity) { this.generation++; this.store?.close(); this.store = null; this.identity = identity; this.lastRecentScan = 0; this.lastFullScan = 0 }
    if (!identity) return null
    if (!this.store) {
      const userData = app.getPath('userData')
      if (!create && !existsSync(join(userData, 'SnsRetention', snsRetentionAccountHash(identity), 'posts.sqlite'))) return null
      this.store = new SnsRetentionStore(userData, identity)
    }
    return this.store
  }
  private current(store: SnsRetentionStore, generation: number): boolean {
    return this.started && this.enabled() && this.store === store && this.generation === generation && this.accountIdentity() === this.identity
  }
  start(): void {
    if (!this.enabled() || this.started) return
    this.started = true
    try {
      const store = this.ensureStore(true)
      // Resume incomplete baselines; rescan completed baselines once per new start.
      if (store?.stats().baselineComplete) store.setBaseline(0, false)
    } catch { this.error = '无法打开朋友圈留存库，将自动重试' }
    this.schedule(0)
  }
  stop(): void {
    this.started = false; this.generation++; this.wakeRequested = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.dueAt = 0; this.lastRecentScan = 0; this.lastFullScan = 0
    this.store?.close(); this.store = null
  }
  setEnabled(enabled: boolean): SnsRetentionStatus {
    this.cfg().set('snsRetentionEnabled', Boolean(enabled))
    if (enabled) this.start(); else this.stop()
    return this.status()
  }
  handleConfigChanged(key: string): void {
    if (key === 'snsRetentionEnabled') { if (this.enabled()) this.start(); else this.stop(); return }
    if (['myAccountId', 'dbPath', 'decryptKey', 'accountConfigs'].includes(key)) {
      this.stop(); this.identity = ''; this.error = undefined; if (this.enabled()) this.start()
    }
  }
  handleDbMonitorChange(type: string, json: string): void {
    if (!this.started) return
    try {
      const event = JSON.parse(json || '{}')
      if (/sns|moments/i.test(`${type} ${event.action || ''} ${event.table || ''} ${event.dbPath || ''}`)) {
        // Restart only a completed sweep. Repeated events must not reset a sweep
        // that is already progressing through older locally fetched posts.
        if (this.store?.stats().baselineComplete) this.store.setBaseline(0, false)
        this.lastRecentScan = 0; this.schedule(500)
      }
    } catch { /* The regular sweep remains active for unknown monitor protocols. */ }
  }
  captureVisible(posts: SnsPost[]): void {
    if (!this.enabled()) return
    try {
      const store = this.ensureStore(true)
      if (store && Array.isArray(posts)) { store.capturePosts(posts); this.kickMedia() }
    } catch { this.error = '朋友圈已读取，但本地留存写入失败；原浏览功能不受影响' }
  }
  status(): SnsRetentionStatus {
    const base: SnsRetentionStatus = { enabled: this.enabled(), running: Boolean(this.scanPromise) && this.enabled(), totalPosts: 0, totalSnapshots: 0,
      savedMedia: 0, pendingMedia: 0, failedMedia: 0, lastScanAt: null, baselineComplete: false, baselineOffset: 0 }
    try { const store = this.ensureStore(false); return { ...base, ...store?.stats(), archivePath: store?.directory, error: this.error } }
    catch { return { ...base, running: false, error: '无法读取朋友圈留存库' } }
  }
  list(options: SnsRetentionListOptions = {}): { items: RetainedSnsPost[]; total: number } {
    const store = this.ensureStore(false)
    const result = store?.list(options) || { items: [], total: 0 }
    if (store && this.enabled()) {
      store.prioritizePostIds(result.items.map(post => post.id))
      this.kickMedia()
    }
    return result
  }
  async scanNow(): Promise<SnsRetentionStatus> {
    if (!this.enabled()) return this.status()
    if (!this.started) this.start()
    if (this.scanPromise) await this.scanPromise
    const store = this.ensureStore(true); store?.setBaseline(0, false); store?.retryFailed()
    this.lastRecentScan = 0
    await this.runScan()
    return this.status()
  }
  private schedule(delay: number): void {
    if (!this.started) return
    if (this.scanPromise) { this.wakeRequested = true; return }
    const due = Date.now() + delay
    if (this.timer && this.dueAt <= due) return
    if (this.timer) clearTimeout(this.timer)
    this.dueAt = due
    this.timer = setTimeout(() => { this.timer = null; this.dueAt = 0; void this.runScan() }, delay)
    this.timer.unref?.()
  }
  private runScan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise
    if (!this.started || !this.enabled()) return Promise.resolve()
    this.wakeRequested = false
    this.scanPromise = this.scan().finally(() => {
      this.scanPromise = null
      if (this.started && this.enabled()) this.schedule(this.wakeRequested ? 500 : this.store?.stats().baselineComplete ? 30_000 : 5000)
    })
    return this.scanPromise
  }
  private async scan(): Promise<void> {
    try {
      const store = this.ensureStore(true); if (!store) { this.error = '请先连接微信数据库并选择账号'; return }
      const generation = this.generation
      if (Date.now() - this.lastRecentScan >= 30_000) {
        const recent = await snsService.getTimeline(100, 0)
        if (!this.current(store, generation)) return
        if (!recent.success || !recent.timeline) { this.error = '本机朋友圈数据库暂不可读，将自动重试'; return }
        store.capturePosts(recent.timeline); this.lastRecentScan = Date.now(); this.kickMedia()
      }
      let state = store.stats()
      // Some backends do not emit SNS notifications. Periodic full sweeps also
      // discover historical posts fetched into the local cache below the top 100.
      if (state.baselineComplete && Date.now() - this.lastFullScan >= 30 * 60_000) {
        store.setBaseline(0, false); state = store.stats()
      }
      if (!state.baselineComplete) {
        const page = await snsService.getTimeline(100, state.baselineOffset)
        if (!this.current(store, generation)) return
        if (!page.success || !page.timeline) { this.error = '历史朋友圈分页暂不可读，将从当前位置重试'; return }
        store.capturePosts(page.timeline)
        // Small overlap absorbs new rows inserted while the baseline is paged.
        store.setBaseline(state.baselineOffset + Math.max(1, page.timeline.length - 10), page.timeline.length < 100)
        if (page.timeline.length < 100) this.lastFullScan = Date.now()
      }
      store.markScanned(); this.error = undefined; this.kickMedia()
    } catch { this.error = '朋友圈留存扫描暂时失败，将自动重试' }
  }
  private cacheRoots(store: SnsRetentionStore): string[] {
    const cache = String(this.cfg().get('cachePath') || '').trim() || join(app.getPath('documents'), 'WeFlow')
    return [join(cache, 'sns_cache'), store.directory]
  }
  private async obtain(source: string, key: string, store: SnsRetentionStore, kind: 'image' | 'video'): Promise<{ data?: Buffer; path?: string }> {
    const local = source.startsWith('file:') || isAbsolute(source)
    if (local) {
      const path = await trustedSnsLocalPath(source, this.cacheRoots(store))
      if (!path) throw new Error('blocked')
      return { path }
    }
    if (!isTrustedSnsMediaUrl(source)) throw new Error('blocked')
    // The SNS downloader rejects redirects, caps decoded bytes and enforces a deadline.
    const result = await snsService.downloadImage(source, key || undefined, { maxBytes: SNS_RETENTION_MAX_BYTES, timeoutMs: 30_000, kind })
    if (!result.success) throw new Error('unavailable')
    if (result.cachePath) {
      const path = await trustedSnsLocalPath(result.cachePath, this.cacheRoots(store))
      if (path) return { path }
    }
    if (result.data && result.data.length <= SNS_RETENTION_MAX_BYTES) return { data: result.data }
    throw new Error('unavailable')
  }
  private kickMedia(): void {
    if (!this.started || !this.enabled()) return
    const available = Math.max(0, 2 - this.workers)
    for (let index = 0; index < available; index++) { this.workers++; void this.drainMedia() }
  }
  private async drainMedia(): Promise<void> {
    try {
      while (this.started && this.enabled()) {
        const store = this.store; if (!store) break
        const generation = this.generation; const job: SnsMediaJob | null = store.nextMedia(); if (!job) break
        let blocked = false
        try {
          const original = await this.obtain(job.sourceUrl, job.key, store, job.kind === 'image' ? 'image' : 'video')
          if (!this.current(store, generation)) continue
          await store.saveMedia(job.id, original, 'original')
          continue
        } catch (error) { blocked = error instanceof Error && error.message === 'blocked' }
        if (!this.current(store, generation)) continue
        store.deferMedia(job.id, blocked ? '来源不在微信媒体白名单或本地缓存范围内' : '原媒体暂不可读取，稍后可重试', blocked)
        if (job.thumbUrl && job.thumbUrl !== job.sourceUrl) {
          try {
            const thumbnail = await this.obtain(job.thumbUrl, job.key, store, 'image')
            if (this.current(store, generation)) await store.saveMedia(job.id, thumbnail, 'thumbnail')
          } catch { /* Text, snapshots and any previously retained media stay intact. */ }
        }
      }
    } catch { this.error = '部分朋友圈媒体暂不可留存，文字与已保存副本仍保留' }
    finally { this.workers-- }
  }
}
export const snsRetentionService = new SnsRetentionService()
