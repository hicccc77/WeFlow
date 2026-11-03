import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigService } from './config'
import { chatService, type ChatSession, type Message } from './chatService'
import { imageDecryptService } from './imageDecryptService'
import { MessageRetentionStore, retentionAccountHash, type RetainedMessage, type RetentionListOptions } from './messageRetentionStore'

export type { RetainedMessage, RetentionListOptions } from './messageRetentionStore'
export interface RetentionStatus {
  enabled: boolean; running: boolean; totalMessages: number; revokedMessages: number
  lastScanAt: number | null; error?: string; archivePath?: string
}
type MessagePosition = { createTime?: number; localId?: number; sortSeq?: number; serverIdRaw?: string }
type SessionState = { signature: string; scannedAt: number; highWater: number; pendingMin?: number; pendingCursor?: MessagePosition }
type MediaJob = { generation: number; store: MessageRetentionStore; item: RetainedMessage; message: Message; sessionId: string }

/** Best-effort capture of locally visible messages while WeFlow is running. */
class MessageRetentionService {
  private config: ConfigService | null = null
  private store: MessageRetentionStore | null = null
  private identity = ''
  private started = false
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDueAt = 0
  private busy = false
  private wakeRequested = false
  private error: string | undefined
  private sessions = new Map<string, SessionState>()
  private mediaQueue: MediaJob[] = []
  private mediaRunning = false
  private mediaAttempts = new Map<string, number>()

  private getConfig(): ConfigService { return this.config || (this.config = new ConfigService()) }
  private enabled(): boolean { return this.getConfig().get('messageRetentionEnabled') === true }
  private accountIdentity(): string {
    const cfg = this.getConfig()
    const account = String(cfg.get('myAccountId') || '').trim()
    const path = String(cfg.get('dbPath') || '').trim()
    if (!account || !path) return ''
    const directory = cfg.getAccountDir(path, account)
    return directory ? account + '\0' + directory : ''
  }
  private ensureStore(create: boolean): MessageRetentionStore | null {
    const identity = this.accountIdentity()
    if (identity !== this.identity) {
      this.generation++; this.store?.close(); this.store = null; this.identity = identity
      this.sessions.clear(); this.mediaQueue = []; this.mediaAttempts.clear()
    }
    if (!identity) return null
    if (!this.store) {
      const root = app.getPath('userData')
      if (!create && !existsSync(join(root, 'Retention', retentionAccountHash(identity), 'messages.sqlite'))) return null
      this.store = new MessageRetentionStore(root, identity)
    }
    return this.store
  }
  start(): void {
    if (!this.enabled()) return
    this.started = true
    this.schedule(0)
  }
  stop(): void {
    this.started = false; this.generation++; this.wakeRequested = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.timerDueAt = 0; this.mediaQueue = []
    this.store?.close(); this.store = null
    this.sessions.clear(); this.mediaAttempts.clear()
  }
  setEnabled(enabled: boolean): RetentionStatus {
    this.getConfig().set('messageRetentionEnabled', enabled === true)
    if (enabled === true) this.start(); else this.stop()
    return this.status()
  }
  handleConfigChanged(key: string): void {
    if (key === 'messageRetentionEnabled') { if (this.enabled()) this.start(); else this.stop(); return }
    if (['myAccountId', 'dbPath', 'decryptKey', 'accountConfigs'].includes(key)) {
      this.stop(); this.identity = ''; this.error = undefined
      if (this.enabled()) this.start()
    }
  }
  handleDbMonitorChange(type: string, json: string): void {
    if (!this.started || !this.enabled()) return
    try {
      const event = JSON.parse(json || '{}')
      const marker = `${type} ${event.action || ''} ${event.table || ''}`.toLowerCase()
      if (/message|msg|session/.test(marker)) this.schedule(150)
    } catch { this.schedule(150) }
  }
  status(): RetentionStatus {
    const enabled = this.enabled()
    try {
      const store = this.ensureStore(false)
      return { enabled, running: enabled && this.started, totalMessages: 0, revokedMessages: 0, lastScanAt: null,
        ...store?.stats(), error: this.error, archivePath: store?.directory }
    } catch {
      return { enabled, running: false, totalMessages: 0, revokedMessages: 0, lastScanAt: null, error: '无法读取本地消息留存库' }
    }
  }
  list(options: RetentionListOptions = {}): { items: RetainedMessage[]; total: number } {
    return this.ensureStore(false)?.list(options) || { items: [], total: 0 }
  }
  private schedule(delay: number): void {
    if (!this.started) return
    if (this.busy) { this.wakeRequested = true; return }
    const dueAt = Date.now() + delay
    // Coalesce events at the earliest deadline. A stream of writes must not keep
    // postponing capture until the database becomes quiet.
    if (this.timer && this.timerDueAt <= dueAt) return
    if (this.timer) clearTimeout(this.timer)
    this.timerDueAt = dueAt
    this.timer = setTimeout(() => { this.timer = null; this.timerDueAt = 0; void this.scan() }, delay)
    this.timer.unref?.()
  }
  private isCurrent(generation: number, store: MessageRetentionStore): boolean {
    return this.started && this.enabled() && generation === this.generation && this.store === store && this.accountIdentity() === this.identity
  }
  private async scan(): Promise<void> {
    if (!this.started || this.busy || !this.enabled()) return
    this.busy = true; this.wakeRequested = false
    try {
      const store = this.ensureStore(true)
      if (!store) { this.error = '请先连接微信数据库并选择账号'; return }
      const generation = this.generation
      const result = await chatService.getSessions()
      if (!this.isCurrent(generation, store)) return
      if (!result.success || !result.sessions) { this.error = '微信数据库暂不可读，等待下次重试'; return }
      const now = Date.now()
      const signature = (session: ChatSession) => [session.lastTimestamp, session.lastMsgType, session.lastMsgSender, session.summary, session.messageCountHint].join('|')
      // Poll recently active/changed conversations first, and rotate through the rest.
      const changed = result.sessions.filter(s => {
        const state = this.sessions.get(s.username)
        return state ? state.signature !== signature(s) || state.pendingMin !== undefined : now / 1000 - s.lastTimestamp < 300
      }).sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      const active = result.sessions.filter(s => now / 1000 - s.lastTimestamp < 180)
        .sort((a, b) => (this.sessions.get(a.username)?.scannedAt || 0) - (this.sessions.get(b.username)?.scannedAt || 0))
      const rotation = [...result.sessions].sort((a, b) => (this.sessions.get(a.username)?.scannedAt || 0) - (this.sessions.get(b.username)?.scannedAt || 0))
      const queue = [...new Map([...changed.slice(0, 12), ...active.slice(0, 8), ...rotation.slice(0, 8)].map(s => [s.username, s])).values()]
      let failed = false
      for (const session of queue) {
        if (!this.isCurrent(generation, store)) return
        const old = this.sessions.get(session.username)
        // Track attempts separately from successful signatures/watermarks. Failed
        // conversations must rotate out so they cannot monopolize the baseline.
        this.sessions.set(session.username, { signature: '', highWater: 0, ...old, scannedAt: now })
        // The independent latest-page query leaves the chat UI's paging cursor alone.
        const latest = await chatService.getLatestMessages(session.username, old ? 80 : 20)
        if (!this.isCurrent(generation, store)) return
        if (!latest.success || !latest.messages) { failed = true; continue }
        let highWater = old?.highWater || 0
        this.captureBatch(store, generation, session, latest.messages)
        for (const message of latest.messages) {
          highWater = Math.max(highWater, message.createTime)
        }
        let pendingMin: number | undefined
        let pendingCursor: MessagePosition | undefined
        if (old?.highWater && (highWater > old.highWater || old.pendingMin !== undefined)) {
          // Fill gaps in a busy conversation rather than only retaining its last 80 rows.
          const minTime = old.pendingMin ?? Math.max(0, old.highWater - 2)
          let cursor: MessagePosition = old.pendingCursor || { createTime: minTime, localId: 0, sortSeq: 0, serverIdRaw: '0' }
          pendingMin = minTime; pendingCursor = cursor
          for (let page = 0; page < 8; page++) {
            const batch = await chatService.getNewMessages(session.username, minTime, 200, cursor)
            if (!this.isCurrent(generation, store)) return
            if (!batch.success || !batch.messages) { failed = true; break }
            this.captureBatch(store, generation, session, batch.messages)
            if (batch.messages.length < 200) { pendingMin = undefined; pendingCursor = undefined; break }
            const next = batch.messages[batch.messages.length - 1]
            const position = { createTime: next.createTime, localId: next.localId, sortSeq: next.sortSeq, serverIdRaw: next.serverIdRaw }
            if (JSON.stringify(cursor) === JSON.stringify(position)) { failed = true; break }
            cursor = position; pendingCursor = position
          }
        }
        this.sessions.set(session.username, { signature: signature(session), scannedAt: now, highWater, pendingMin, pendingCursor })
        // Yield between conversations so capture cannot starve the desktop UI.
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      if (this.isCurrent(generation, store)) {
        store.markScanned(); this.error = failed ? '部分会话暂不可读，已保存可读取的消息并将自动重试' : undefined
      }
    } catch (error) {
      // Keep diagnostics useful without logging chat content or private database paths.
      console.warn('[MessageRetention] scan failed', { name: error instanceof Error ? error.name : typeof error })
      this.error = '消息留存扫描暂时失败，将自动重试'
    } finally {
      this.busy = false
      if (this.started && this.enabled()) this.schedule(this.wakeRequested ? 200 : 1500)
    }
  }
  private captureBatch(store: MessageRetentionStore, generation: number, session: ChatSession, messages: Message[]): void {
    const items = store.captureMany(session.username, session.displayName || session.username, messages.map(message => ({ ...message,
      senderDisplayName: message.isSend ? (message.senderDisplayName || '我')
        : !session.username.endsWith('@chatroom') ? (session.displayName || message.senderDisplayName || message.senderUsername || '')
          : (message.senderDisplayName || message.senderUsername || '') })))
    items.forEach((item, index) => this.queueMedia(store, generation, session.username, messages[index], item))
  }
  private queueMedia(store: MessageRetentionStore, generation: number, sessionId: string, message: Message, item: RetainedMessage | null): void {
    if (!item || item.originalMissing || item.mediaState === 'saved' || ![3, 47].includes(message.localType)) return
    const key = store.archivePath + ':' + item.id
    if (Date.now() - (this.mediaAttempts.get(key) || 0) < 60_000 || this.mediaQueue.length >= 300) return
    this.mediaAttempts.set(key, Date.now())
    this.mediaQueue.push({ generation, store, item, message, sessionId })
    void this.drainMedia()
  }
  private async drainMedia(): Promise<void> {
    if (this.mediaRunning) return
    this.mediaRunning = true
    try {
      while (this.mediaQueue.length) {
        const job = this.mediaQueue.shift()!
        if (!this.isCurrent(job.generation, job.store)) continue
        try {
          let source = job.message.emojiLocalPath
          if (job.message.localType === 3) {
            const result = await imageDecryptService.decryptImage({ sessionId: job.sessionId,
              imageMd5: job.message.imageMd5, imageDatName: job.message.imageDatName,
              createTime: job.message.createTime, preferFilePath: true, hardlinkOnly: true,
              allowFilesystemScan: false, suppressEvents: true })
            if (result.success) source = result.localPath
          }
          if (!this.isCurrent(job.generation, job.store)) continue
          if (source) await job.store.preserveMedia(job.item.id, source)
          else job.store.markMediaUnavailable(job.item.id)
        } catch { job.store.markMediaUnavailable(job.item.id) }
      }
    } finally { this.mediaRunning = false }
  }
}
export const messageRetentionService = new MessageRetentionService()
