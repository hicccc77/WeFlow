import { imageDecryptService } from './imageDecryptService'

type PreloadImagePayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

type PreloadOptions = {
  allowDecrypt?: boolean
  allowCacheIndex?: boolean
  allowFilesystemScan?: boolean
  emitResolved?: boolean
  scope?: string
  priority?: 'high' | 'normal' | 'low'
}

type PreloadEnqueueResult = {
  success: true
  requested: number
  accepted: number
  mergedQueued: number
  skippedActive: number
  skippedPending: number
  ignoredCanceled: number
  rejectedCapacity: number
  deferred: number
  handledIdentities: string[]
  acceptedIdentities: string[]
  mergedQueuedIdentities: string[]
  skippedActiveIdentities: string[]
  skippedPendingIdentities: string[]
  rejectedIdentities: string[]
  deferredIdentities: string[]
}

type PreloadTask = PreloadImagePayload & {
  key: string
  identity: string
  allowDecrypt: boolean
  allowCacheIndex: boolean
  allowFilesystemScan: boolean
  scopes: Set<string>
  emitResolvedScopes: Set<string>
  priority: 'high' | 'normal' | 'low'
}

type PreloadHighWaterStats = {
  queued: number
  pending: number
  queuedCache: number
  queuedDecrypt: number
  queuedHigh: number
  queuedNormal: number
  queuedLow: number
  activeCache: number
  activeDecrypt: number
  activeIdentities: number
}

const isLikelyThumbnailCachePath = (localPath?: string): boolean => {
  const normalized = String(localPath || '').trim().toLowerCase()
  if (!normalized) return false
  return (
    normalized.includes('_thumb') ||
    normalized.includes('.thumb') ||
    normalized.includes('_t.') ||
    normalized.includes('.t.')
  )
}

export class ImagePreloadService {
  private queue: PreloadTask[] = []
  private pending = new Set<string>()
  private queuedCacheByIdentity = new Map<string, PreloadTask>()
  private queuedDecryptByIdentity = new Map<string, PreloadTask>()
  private activeByIdentity = new Map<string, PreloadTask>()
  private canceledScopes = new Map<string, number>()
  private totals = {
    accepted: 0,
    mergedQueued: 0,
    skippedActive: 0,
    ignoredCanceled: 0,
    droppedQueued: 0,
    canceledQueued: 0,
    canceledActive: 0,
    promotedActive: 0,
    rejectedCapacity: 0,
    deferredLowPriority: 0,
    lowPriorityIdleDeferrals: 0,
    skippedPending: 0,
    forcedThumbnailRefreshes: 0,
    forcedThumbnailRefreshFailures: 0,
    lowPriorityRejected: 0,
    activeCacheSnapshots: 0,
    activeCacheSnapshotSkipped: 0,
    activeCacheSnapshotCanceled: 0,
    started: 0,
    completed: 0
  }
  private activeCache = 0
  private activeDecrypt = 0
  private queuedPriorityCounts: Record<PreloadTask['priority'], number> = {
    high: 0,
    normal: 0,
    low: 0
  }
  private activeCacheSnapshotPending = new Set<string>()
  private activeCacheSnapshotLastAt = new Map<string, number>()
  private lastForegroundActivityAt = Date.now()
  private lowPriorityWakeTimer: ReturnType<typeof setTimeout> | null = null
  private highWater: PreloadHighWaterStats = {
    queued: 0,
    pending: 0,
    queuedCache: 0,
    queuedDecrypt: 0,
    queuedHigh: 0,
    queuedNormal: 0,
    queuedLow: 0,
    activeCache: 0,
    activeDecrypt: 0,
    activeIdentities: 0
  }
  private readonly maxCacheConcurrent = 4
  private readonly maxDecryptConcurrent = 2
  private readonly maxQueueSize = 320
  private readonly maxLowPriorityQueueSize = 160
  private readonly lowPrioritySoftQueueSize = 240
  private readonly canceledScopeTtlMs = 2 * 60 * 1000
  private readonly activeCacheSnapshotCooldownMs = 1800
  private readonly lowPriorityIdleDelayMs = 1500

  enqueue(payloads: PreloadImagePayload[], options?: PreloadOptions): PreloadEnqueueResult {
    const result = this.createEnqueueResult(Array.isArray(payloads) ? payloads.length : 0)
    if (!Array.isArray(payloads) || payloads.length === 0) return result
    this.pruneCanceledScopes()
    const allowDecrypt = options?.allowDecrypt !== false
    const allowCacheIndex = options?.allowCacheIndex !== false
    const allowFilesystemScan = options?.allowFilesystemScan !== false
    const emitResolved = options?.emitResolved === true
    const scope = String(options?.scope || 'global').trim() || 'global'
    const priority = options?.priority || (allowDecrypt ? 'low' : 'normal')
    this.noteForegroundActivity(allowDecrypt, priority)
    if (this.isScopeCanceled(scope)) {
      this.totals.ignoredCanceled += payloads.length
      result.ignoredCanceled += payloads.length
      return result
    }
    for (const payload of payloads) {
      const identity = this.getTaskIdentity(payload)
      if (!identity) continue
      const activeTask = this.activeByIdentity.get(identity)
      if (activeTask && (!allowDecrypt || activeTask.allowDecrypt)) {
        activeTask.scopes.add(scope)
        activeTask.allowCacheIndex = activeTask.allowCacheIndex || allowCacheIndex
        activeTask.allowFilesystemScan = activeTask.allowFilesystemScan || allowFilesystemScan
        if (this.priorityScore(priority) < this.priorityScore(activeTask.priority)) {
          activeTask.priority = priority
          this.totals.promotedActive += 1
        }
        if (emitResolved) {
          activeTask.emitResolvedScopes.add(scope)
        }
        if (!allowDecrypt && activeTask.allowDecrypt && emitResolved) {
          this.emitActiveCacheSnapshot(payload, identity, allowCacheIndex, scope)
        }
        this.totals.skippedActive += 1
        result.skippedActive += 1
        result.handledIdentities.push(identity)
        result.skippedActiveIdentities.push(identity)
        continue
      }

      const mode = allowDecrypt ? 'decrypt' : 'cache'
      const key = `${mode}|${identity}`
      const queuedMap = this.getQueuedMap(allowDecrypt)
      const queuedTask = queuedMap.get(identity)
      if (queuedTask) {
        this.totals.mergedQueued += 1
        result.mergedQueued += 1
        result.handledIdentities.push(identity)
        result.mergedQueuedIdentities.push(identity)
        this.mergeQueuedTaskPayload(queuedTask, payload)
        queuedTask.allowCacheIndex = queuedTask.allowCacheIndex || allowCacheIndex
        queuedTask.allowFilesystemScan = queuedTask.allowFilesystemScan || allowFilesystemScan
        queuedTask.scopes.add(scope)
        if (emitResolved) queuedTask.emitResolvedScopes.add(scope)
        if (this.priorityScore(priority) < this.priorityScore(queuedTask.priority)) {
          this.updateQueuedPriority(queuedTask, priority)
        }
        continue
      }
      if (this.shouldDeferLowPriorityDecrypt(allowDecrypt, priority)) {
        this.deferLowPriority(result, identity)
        continue
      }
      const queuedPeerTask = this.getQueuedMap(!allowDecrypt).get(identity)
      const shouldKeepIncomingCacheSeparate = !allowDecrypt && queuedPeerTask?.allowDecrypt === true
      if (queuedPeerTask && !shouldKeepIncomingCacheSeparate) {
        if (this.shouldDeferPeerUpgrade(queuedPeerTask, allowDecrypt, priority)) {
          this.deferLowPriority(result, identity)
          continue
        }
        this.totals.mergedQueued += 1
        result.mergedQueued += 1
        result.handledIdentities.push(identity)
        result.mergedQueuedIdentities.push(identity)
        this.mergeQueuedTaskPayload(queuedPeerTask, payload)
        queuedPeerTask.allowCacheIndex = queuedPeerTask.allowCacheIndex || allowCacheIndex
        queuedPeerTask.allowFilesystemScan = queuedPeerTask.allowFilesystemScan || allowFilesystemScan
        queuedPeerTask.scopes.add(scope)
        if (emitResolved) queuedPeerTask.emitResolvedScopes.add(scope)
        if (allowDecrypt && !queuedPeerTask.allowDecrypt) {
          this.updateQueuedMode(queuedPeerTask, true)
        }
        if (this.priorityScore(priority) < this.priorityScore(queuedPeerTask.priority)) {
          this.updateQueuedPriority(queuedPeerTask, priority)
        }
        continue
      }
      if (this.pending.has(key)) {
        this.totals.skippedPending += 1
        result.skippedPending += 1
        result.handledIdentities.push(identity)
        result.skippedPendingIdentities.push(identity)
        continue
      }
      if (!this.ensureQueueCapacity(priority)) {
        this.totals.rejectedCapacity += 1
        if (this.isLowPrioritySoftLimitExceeded(priority)) {
          this.totals.lowPriorityRejected += 1
        }
        result.rejectedCapacity += 1
        result.rejectedIdentities.push(identity)
        continue
      }
      this.pending.add(key)
      const task = {
        ...payload,
        key,
        identity,
        allowDecrypt,
        allowCacheIndex,
        allowFilesystemScan,
        scopes: new Set([scope]),
        emitResolvedScopes: emitResolved ? new Set([scope]) : new Set<string>(),
        priority
      }
      this.addQueuedTask(task)
      this.totals.accepted += 1
      result.accepted += 1
      result.handledIdentities.push(identity)
      result.acceptedIdentities.push(identity)
      this.recordHighWater()
    }
    this.sortQueue()
    this.processQueue()
    return result
  }

  cancelScope(scope: string): void {
    const normalizedScope = String(scope || '').trim()
    if (!normalizedScope) return
    this.canceledScopes.set(normalizedScope, Date.now())
    this.dropActiveCacheSnapshotsForScope(normalizedScope)
    const kept: PreloadTask[] = []
    for (const task of this.queue) {
      task.scopes.delete(normalizedScope)
      task.emitResolvedScopes.delete(normalizedScope)
      if (this.isCanceled(task)) {
        this.pending.delete(task.key)
        this.removeQueuedTask(task)
        this.totals.canceledQueued += 1
      } else {
        kept.push(task)
      }
    }
    this.queue = kept
    for (const task of this.activeByIdentity.values()) {
      const hadScope = task.scopes.delete(normalizedScope)
      task.emitResolvedScopes.delete(normalizedScope)
      if (!hadScope) continue
      if (this.isCanceled(task)) {
        this.totals.canceledActive += 1
      }
    }
    this.pruneCanceledScopes()
    this.clearLowPriorityWakeIfUnneeded()
  }

  getStats(): {
    queued: number
    pending: number
    activeCache: number
    activeDecrypt: number
    queuedIdentities: number
    queuedCache: number
    queuedDecrypt: number
    queuedHigh: number
    queuedNormal: number
    queuedLow: number
    activeIdentities: number
    queuedScopes: number
    activeScopes: number
    canceledScopes: number
    highWater: PreloadHighWaterStats
    totals: {
      accepted: number
      mergedQueued: number
      skippedActive: number
      ignoredCanceled: number
      droppedQueued: number
      canceledQueued: number
      canceledActive: number
      promotedActive: number
      rejectedCapacity: number
      deferredLowPriority: number
      lowPriorityIdleDeferrals: number
      skippedPending: number
      forcedThumbnailRefreshes: number
      forcedThumbnailRefreshFailures: number
      lowPriorityRejected: number
      activeCacheSnapshots: number
      activeCacheSnapshotSkipped: number
      activeCacheSnapshotCanceled: number
      started: number
      completed: number
    }
  } {
    this.recordHighWater()
    const queuedIdentities = new Set([
      ...this.queuedCacheByIdentity.keys(),
      ...this.queuedDecryptByIdentity.keys()
    ]).size
    const priorityCounts = this.countQueuedPriorities()
    const highWater = { ...this.highWater }
    this.resetHighWater()
    return {
      queued: this.queue.length,
      pending: this.pending.size,
      activeCache: this.activeCache,
      activeDecrypt: this.activeDecrypt,
      queuedIdentities,
      queuedCache: this.queuedCacheByIdentity.size,
      queuedDecrypt: this.queuedDecryptByIdentity.size,
      queuedHigh: priorityCounts.high,
      queuedNormal: priorityCounts.normal,
      queuedLow: priorityCounts.low,
      activeIdentities: this.activeByIdentity.size,
      queuedScopes: this.countTaskScopes(this.queue),
      activeScopes: this.countTaskScopes(this.activeByIdentity.values()),
      canceledScopes: this.canceledScopes.size,
      highWater,
      totals: { ...this.totals }
    }
  }

  private priorityScore(priority: PreloadTask['priority']): number {
    if (priority === 'high') return 0
    if (priority === 'normal') return 1
    return 2
  }

  private noteForegroundActivity(allowDecrypt: boolean, priority: PreloadTask['priority']): void {
    if (allowDecrypt && priority === 'low') return
    this.lastForegroundActivityAt = Date.now()
  }

  private createEnqueueResult(requested: number): PreloadEnqueueResult {
    return {
      success: true,
      requested,
      accepted: 0,
      mergedQueued: 0,
      skippedActive: 0,
      skippedPending: 0,
      ignoredCanceled: 0,
      rejectedCapacity: 0,
      deferred: 0,
      handledIdentities: [],
      acceptedIdentities: [],
      mergedQueuedIdentities: [],
      skippedActiveIdentities: [],
      skippedPendingIdentities: [],
      rejectedIdentities: [],
      deferredIdentities: []
    }
  }

  private getTaskIdentity(payload: PreloadImagePayload): string {
    const imageMd5 = String(payload.imageMd5 || '').trim().toLowerCase()
    if (imageMd5) return `md5:${imageMd5}`
    const imageDatName = String(payload.imageDatName || '').trim().toLowerCase()
    if (imageDatName) {
      const sessionId = String(payload.sessionId || '').trim().toLowerCase()
      const createTime = Number(payload.createTime || 0) || 0
      return `dat:${sessionId}|${createTime}|${imageDatName}`
    }
    return ''
  }

  private getQueuedMap(allowDecrypt: boolean): Map<string, PreloadTask> {
    return allowDecrypt ? this.queuedDecryptByIdentity : this.queuedCacheByIdentity
  }

  private deferLowPriority(result: PreloadEnqueueResult, identity: string): void {
    this.totals.deferredLowPriority += 1
    result.deferred += 1
    result.deferredIdentities.push(identity)
  }

  private shouldDeferLowPriorityDecrypt(allowDecrypt: boolean, priority: PreloadTask['priority']): boolean {
    if (!allowDecrypt || priority !== 'low') return false
    return (
      this.queuedPriorityCounts.high > 0 ||
      this.queuedPriorityCounts.normal > 0 ||
      this.activeCache >= this.maxCacheConcurrent ||
      (this.activeCache > 0 && this.queuedCacheByIdentity.size > 0)
    )
  }

  private shouldDeferPeerUpgrade(
    peerTask: PreloadTask,
    allowDecrypt: boolean,
    priority: PreloadTask['priority']
  ): boolean {
    return allowDecrypt && !peerTask.allowDecrypt && priority === 'low' && (
      peerTask.priority !== 'low' ||
      peerTask.emitResolvedScopes.size > 0
    )
  }

  private emitActiveCacheSnapshot(
    payload: PreloadImagePayload,
    identity: string,
    allowCacheIndex: boolean,
    scope: string
  ): void {
    if (this.isScopeCanceled(scope)) return
    const now = Date.now()
    this.pruneActiveCacheSnapshotCooldowns(now)
    const snapshotKey = `${scope}|${identity}`
    if (this.activeCacheSnapshotPending.has(snapshotKey)) {
      this.totals.activeCacheSnapshotSkipped += 1
      return
    }
    const lastSnapshotAt = this.activeCacheSnapshotLastAt.get(snapshotKey) || 0
    if (lastSnapshotAt && now - lastSnapshotAt < this.activeCacheSnapshotCooldownMs) {
      this.totals.activeCacheSnapshotSkipped += 1
      return
    }
    this.activeCacheSnapshotPending.add(snapshotKey)
    this.activeCacheSnapshotLastAt.set(snapshotKey, now)
    this.totals.activeCacheSnapshots += 1
    const cacheKey = this.getSnapshotCacheKey(payload)
    void imageDecryptService.resolveCachedImage({
      sessionId: payload.sessionId,
      imageMd5: payload.imageMd5,
      imageDatName: payload.imageDatName,
      createTime: payload.createTime,
      preferFilePath: true,
      hardlinkOnly: true,
      disableUpdateCheck: true,
      allowCacheIndex,
      allowCachePromotion: false,
      suppressEvents: true
    }).then((result) => {
      if (this.isScopeCanceled(scope)) {
        this.totals.activeCacheSnapshotCanceled += 1
        return
      }
      if (!result?.success || !result.localPath || !cacheKey) return
      imageDecryptService.emitCacheResolvedPath({
        sessionId: payload.sessionId,
        imageMd5: payload.imageMd5,
        imageDatName: payload.imageDatName,
        createTime: payload.createTime
      }, cacheKey, result.localPath)
    }).catch(() => {
      // Visible cache snapshots are best-effort; the active decrypt will still finish normally.
    }).finally(() => {
      this.activeCacheSnapshotPending.delete(snapshotKey)
    })
  }

  private getSnapshotCacheKey(payload: PreloadImagePayload): string {
    return String(payload.imageMd5 || payload.imageDatName || '').trim().toLowerCase()
  }

  private pruneActiveCacheSnapshotCooldowns(now = Date.now()): void {
    const expiresBefore = now - this.activeCacheSnapshotCooldownMs
    for (const [key, timestamp] of this.activeCacheSnapshotLastAt.entries()) {
      if (timestamp >= expiresBefore) continue
      this.activeCacheSnapshotLastAt.delete(key)
    }
  }

  private dropActiveCacheSnapshotsForScope(scope: string): void {
    const prefix = `${scope}|`
    for (const key of Array.from(this.activeCacheSnapshotPending)) {
      if (key.startsWith(prefix)) this.activeCacheSnapshotPending.delete(key)
    }
    for (const key of Array.from(this.activeCacheSnapshotLastAt.keys())) {
      if (key.startsWith(prefix)) this.activeCacheSnapshotLastAt.delete(key)
    }
  }

  private mergeQueuedTaskPayload(task: PreloadTask, payload: PreloadImagePayload): void {
    const incomingSessionId = String(payload.sessionId || '').trim()
    if (!task.sessionId && incomingSessionId) {
      task.sessionId = incomingSessionId
    }

    const incomingCreateTime = Number(payload.createTime || 0) || 0
    const currentCreateTime = Number(task.createTime || 0) || 0
    if (!currentCreateTime && incomingCreateTime) {
      task.createTime = incomingCreateTime
    }

    const incomingImageMd5 = String(payload.imageMd5 || '').trim().toLowerCase()
    if (!task.imageMd5 && incomingImageMd5) {
      task.imageMd5 = incomingImageMd5
    }

    const incomingDatName = String(payload.imageDatName || '').trim().toLowerCase()
    if (!task.imageDatName && incomingDatName) {
      task.imageDatName = incomingDatName
    }
  }

  private addQueuedTask(task: PreloadTask): void {
    this.queue.push(task)
    this.getQueuedMap(task.allowDecrypt).set(task.identity, task)
    this.queuedPriorityCounts[task.priority] += 1
  }

  private updateQueuedPriority(task: PreloadTask, priority: PreloadTask['priority']): void {
    if (task.priority === priority) return
    this.queuedPriorityCounts[task.priority] = Math.max(0, this.queuedPriorityCounts[task.priority] - 1)
    task.priority = priority
    this.queuedPriorityCounts[priority] += 1
  }

  private updateQueuedMode(task: PreloadTask, allowDecrypt: boolean): void {
    if (task.allowDecrypt === allowDecrypt) return
    this.getQueuedMap(task.allowDecrypt).delete(task.identity)
    this.pending.delete(task.key)
    task.allowDecrypt = allowDecrypt
    task.key = `${allowDecrypt ? 'decrypt' : 'cache'}|${task.identity}`
    this.getQueuedMap(task.allowDecrypt).set(task.identity, task)
    this.pending.add(task.key)
  }

  private removeQueuedTask(task: PreloadTask): void {
    this.getQueuedMap(task.allowDecrypt).delete(task.identity)
    this.queuedPriorityCounts[task.priority] = Math.max(0, this.queuedPriorityCounts[task.priority] - 1)
  }

  private ensureQueueCapacity(priority: PreloadTask['priority']): boolean {
    if (this.isLowPrioritySoftLimitExceeded(priority)) {
      return false
    }
    if (this.queue.length < this.maxQueueSize) return true
    const incomingScore = this.priorityScore(priority)
    let dropIndex = -1
    let dropScore = incomingScore
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const score = this.priorityScore(this.queue[index].priority)
      if (score <= dropScore) continue
      dropScore = score
      dropIndex = index
    }
    if (dropIndex < 0) return false
    const [dropped] = this.queue.splice(dropIndex, 1)
    if (dropped) {
      this.pending.delete(dropped.key)
      this.removeQueuedTask(dropped)
      this.totals.droppedQueued += 1
    }
    return true
  }

  private isLowPrioritySoftLimitExceeded(priority: PreloadTask['priority']): boolean {
    return priority === 'low' && (
      this.queue.length >= this.lowPrioritySoftQueueSize ||
      this.queuedPriorityCounts.low >= this.maxLowPriorityQueueSize
    )
  }

  private isScopeCanceled(scope: string): boolean {
    return this.canceledScopes.has(scope)
  }

  private isCanceled(task: PreloadTask): boolean {
    if (task.scopes.size === 0) return true
    for (const scope of task.scopes) {
      if (!this.isScopeCanceled(scope)) return false
    }
    return true
  }

  private hasRunnableEmitScope(task: PreloadTask): boolean {
    for (const scope of Array.from(task.emitResolvedScopes)) {
      if (task.scopes.has(scope) && !this.isScopeCanceled(scope)) return true
      task.emitResolvedScopes.delete(scope)
    }
    return false
  }

  private emitTaskCacheResolved(task: PreloadTask, result?: { success?: boolean; localPath?: string }): void {
    if (!result?.success || !result.localPath) return
    if (!this.hasRunnableEmitScope(task)) return
    const cacheKey = this.getSnapshotCacheKey(task)
    if (!cacheKey) return
    imageDecryptService.emitCacheResolvedPath({
      sessionId: task.sessionId,
      imageMd5: task.imageMd5,
      imageDatName: task.imageDatName,
      createTime: task.createTime
    }, cacheKey, result.localPath)
  }

  private pruneCanceledScopes(): void {
    if (this.canceledScopes.size === 0) return
    const referencedScopes = new Set<string>()
    for (const task of this.queue) {
      for (const scope of task.scopes) referencedScopes.add(scope)
    }
    for (const task of this.activeByIdentity.values()) {
      for (const scope of task.scopes) referencedScopes.add(scope)
    }

    const expiresBefore = Date.now() - this.canceledScopeTtlMs
    for (const [scope, canceledAt] of this.canceledScopes.entries()) {
      if (referencedScopes.has(scope)) continue
      if (canceledAt >= expiresBefore) continue
      this.canceledScopes.delete(scope)
    }
  }

  private countTaskScopes(tasks: Iterable<PreloadTask>): number {
    const scopes = new Set<string>()
    for (const task of tasks) {
      for (const scope of task.scopes) {
        scopes.add(scope)
      }
    }
    return scopes.size
  }

  private countQueuedPriorities(): Record<PreloadTask['priority'], number> {
    return { ...this.queuedPriorityCounts }
  }

  private recordHighWater(): void {
    const priorityCounts = this.countQueuedPriorities()
    this.highWater.queued = Math.max(this.highWater.queued, this.queue.length)
    this.highWater.pending = Math.max(this.highWater.pending, this.pending.size)
    this.highWater.queuedCache = Math.max(this.highWater.queuedCache, this.queuedCacheByIdentity.size)
    this.highWater.queuedDecrypt = Math.max(this.highWater.queuedDecrypt, this.queuedDecryptByIdentity.size)
    this.highWater.queuedHigh = Math.max(this.highWater.queuedHigh, priorityCounts.high)
    this.highWater.queuedNormal = Math.max(this.highWater.queuedNormal, priorityCounts.normal)
    this.highWater.queuedLow = Math.max(this.highWater.queuedLow, priorityCounts.low)
    this.highWater.activeCache = Math.max(this.highWater.activeCache, this.activeCache)
    this.highWater.activeDecrypt = Math.max(this.highWater.activeDecrypt, this.activeDecrypt)
    this.highWater.activeIdentities = Math.max(this.highWater.activeIdentities, this.activeByIdentity.size)
  }

  private resetHighWater(): void {
    const priorityCounts = this.countQueuedPriorities()
    this.highWater = {
      queued: this.queue.length,
      pending: this.pending.size,
      queuedCache: this.queuedCacheByIdentity.size,
      queuedDecrypt: this.queuedDecryptByIdentity.size,
      queuedHigh: priorityCounts.high,
      queuedNormal: priorityCounts.normal,
      queuedLow: priorityCounts.low,
      activeCache: this.activeCache,
      activeDecrypt: this.activeDecrypt,
      activeIdentities: this.activeByIdentity.size
    }
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => this.priorityScore(a.priority) - this.priorityScore(b.priority))
  }

  private hasRunnableCapacity(): boolean {
    return this.activeCache < this.maxCacheConcurrent || this.activeDecrypt < this.maxDecryptConcurrent
  }

  private canRunTask(task: PreloadTask): boolean {
    if (this.activeByIdentity.has(task.identity)) return false
    if (task.allowDecrypt && task.priority === 'low' && !this.canRunLowPriorityDecrypt()) return false
    return task.allowDecrypt
      ? this.activeDecrypt < this.maxDecryptConcurrent
      : this.activeCache < this.maxCacheConcurrent
  }

  private canRunLowPriorityDecrypt(): boolean {
    if (this.activeDecrypt > 0) return false
    if (this.activeCache > 0) return false
    if (this.queuedCacheByIdentity.size > 0) return false
    if (this.queuedPriorityCounts.high > 0 || this.queuedPriorityCounts.normal > 0) return false
    return Date.now() - this.lastForegroundActivityAt >= this.lowPriorityIdleDelayMs
  }

  private hasQueuedLowPriorityDecrypt(): boolean {
    return this.queue.some((task) => task.allowDecrypt && task.priority === 'low')
  }

  private scheduleLowPriorityWakeIfNeeded(): void {
    if (this.lowPriorityWakeTimer !== null) return
    if (!this.hasQueuedLowPriorityDecrypt()) return
    if (this.activeDecrypt > 0 || this.activeCache > 0) return
    if (this.queuedCacheByIdentity.size > 0) return
    if (this.queuedPriorityCounts.high > 0 || this.queuedPriorityCounts.normal > 0) return
    const elapsed = Date.now() - this.lastForegroundActivityAt
    const delayMs = Math.max(20, this.lowPriorityIdleDelayMs - elapsed)
    this.totals.lowPriorityIdleDeferrals += 1
    this.lowPriorityWakeTimer = setTimeout(() => {
      this.lowPriorityWakeTimer = null
      this.processQueue()
    }, delayMs)
  }

  private clearLowPriorityWakeIfUnneeded(): void {
    if (this.lowPriorityWakeTimer === null) return
    if (this.hasQueuedLowPriorityDecrypt()) return
    clearTimeout(this.lowPriorityWakeTimer)
    this.lowPriorityWakeTimer = null
  }

  private takeNextRunnableTask(): PreloadTask | null {
    if (!this.hasRunnableCapacity()) return null
    const taskIndex = this.queue.findIndex((task) => this.canRunTask(task))
    if (taskIndex < 0) return null

    const task = this.queue.splice(taskIndex, 1)[0]
    if (!task) return null
    this.removeQueuedTask(task)
    return task
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const task = this.takeNextRunnableTask()
      if (!task) {
        this.scheduleLowPriorityWakeIfNeeded()
        return
      }
      this.activeByIdentity.set(task.identity, task)
      this.totals.started += 1

      if (task.allowDecrypt) this.activeDecrypt += 1
      else this.activeCache += 1
      this.recordHighWater()

      void this.handleTask(task).finally(() => {
        if (task.allowDecrypt) this.activeDecrypt = Math.max(0, this.activeDecrypt - 1)
        else this.activeCache = Math.max(0, this.activeCache - 1)
        this.activeByIdentity.delete(task.identity)
        this.pending.delete(task.key)
        this.totals.completed += 1
        this.pruneCanceledScopes()
        this.processQueue()
      })
    }
  }

  private async handleTask(task: PreloadTask): Promise<void> {
    const cacheKey = task.imageMd5 || task.imageDatName
    if (!cacheKey) return
    if (this.isCanceled(task)) return
    try {
      const cached = await imageDecryptService.resolveCachedImage({
        sessionId: task.sessionId,
        imageMd5: task.imageMd5,
        imageDatName: task.imageDatName,
        createTime: task.createTime,
        preferFilePath: true,
        hardlinkOnly: true,
        disableUpdateCheck: true,
        allowCacheIndex: task.allowCacheIndex,
        allowCachePromotion: false,
        allowFilesystemScan: task.allowFilesystemScan,
        suppressEvents: true
      })
      if (cached.success) {
        this.emitTaskCacheResolved(task, cached)
        if (!task.allowDecrypt || this.isCanceled(task)) return
        const shouldRefreshCachedPreview = cached.hasUpdate === true || isLikelyThumbnailCachePath(cached.localPath)
        if (!shouldRefreshCachedPreview) return
        this.totals.forcedThumbnailRefreshes += 1
        const refreshed = await imageDecryptService.decryptImage({
          sessionId: task.sessionId,
          imageMd5: task.imageMd5,
          imageDatName: task.imageDatName,
          createTime: task.createTime,
          preferFilePath: true,
          force: true,
          hardlinkOnly: true,
          disableUpdateCheck: true,
          allowFilesystemScan: task.allowFilesystemScan,
          suppressEvents: true
        })
        if (!refreshed.success) {
          this.totals.forcedThumbnailRefreshFailures += 1
        }
        if (this.isCanceled(task)) return
        const resolved = await imageDecryptService.resolveCachedImage({
          sessionId: task.sessionId,
          imageMd5: task.imageMd5,
          imageDatName: task.imageDatName,
          createTime: task.createTime,
          preferFilePath: true,
          hardlinkOnly: true,
          disableUpdateCheck: true,
          allowCacheIndex: task.allowCacheIndex,
          allowCachePromotion: false,
          allowFilesystemScan: task.allowFilesystemScan,
          suppressEvents: true
        })
        this.emitTaskCacheResolved(task, resolved)
        return
      }
      if (!task.allowDecrypt) return
      if (this.isCanceled(task)) return
      await imageDecryptService.decryptImage({
        sessionId: task.sessionId,
        imageMd5: task.imageMd5,
        imageDatName: task.imageDatName,
        createTime: task.createTime,
        preferFilePath: true,
        hardlinkOnly: true,
        disableUpdateCheck: true,
        allowFilesystemScan: task.allowFilesystemScan,
        suppressEvents: true
      })
      if (this.isCanceled(task)) return
      const resolved = await imageDecryptService.resolveCachedImage({
        sessionId: task.sessionId,
        imageMd5: task.imageMd5,
        imageDatName: task.imageDatName,
        createTime: task.createTime,
        preferFilePath: true,
        hardlinkOnly: true,
        disableUpdateCheck: true,
        allowCacheIndex: task.allowCacheIndex,
        allowCachePromotion: false,
        allowFilesystemScan: task.allowFilesystemScan,
        suppressEvents: true
      })
      this.emitTaskCacheResolved(task, resolved)
    } catch {
      // ignore preload failures
    }
  }
}

export const imagePreloadService = new ImagePreloadService()
