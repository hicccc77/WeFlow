import { basename } from 'path'
import { wcdbService } from '../wcdbService'
import { getRowInt } from './messageRowUtils'
import type { ChatSession } from './types'
import type { SessionDetail, SessionDetailExtra, SessionDetailFast } from './types'
import type { SessionDetailHost } from './sessionDetailHost'

export class SessionDetailService {
  private sessionMessageCountCache = new Map<string, { count: number; updatedAt: number }>()
  private sessionMessageCountHintCache = new Map<string, number>()
  private sessionMessageCountBatchCache: {
    dbSignature: string
    sessionIdsKey: string
    counts: Record<string, number>
    updatedAt: number
  } | null = null
  private sessionMessageCountCacheScope = ''
  private readonly sessionMessageCountCacheTtlMs = 10 * 60 * 1000
  private readonly sessionMessageCountBatchCacheTtlMs = 5 * 60 * 1000
  private sessionDetailFastCache = new Map<string, { detail: SessionDetailFast; updatedAt: number }>()
  private sessionDetailExtraCache = new Map<string, { detail: SessionDetailExtra; updatedAt: number }>()
  private readonly sessionDetailFastCacheTtlMs = 60 * 1000
  private readonly sessionDetailExtraCacheTtlMs = 5 * 60 * 1000
  private sessionStatusCache = new Map<string, { isFolded?: boolean; isMuted?: boolean; updatedAt: number }>()
  private readonly sessionStatusCacheTtlMs = 10 * 60 * 1000

  constructor(private readonly host: SessionDetailHost) {}

  onAccountScopeChanged(scope: string): boolean {
    if (scope === this.sessionMessageCountCacheScope) {
      return false
    }
    this.sessionMessageCountCacheScope = scope
    this.clearSessionCaches()
    return true
  }

  clearSessionCaches(): void {
    this.sessionMessageCountCache.clear()
    this.sessionMessageCountHintCache.clear()
    this.sessionMessageCountBatchCache = null
    this.sessionDetailFastCache.clear()
    this.sessionDetailExtraCache.clear()
    this.sessionStatusCache.clear()
  }

  private ensureCacheScopeRefreshed(): void {
    const scope = this.host.getCacheScope()
    if (scope !== this.sessionMessageCountCacheScope) {
      this.sessionMessageCountCacheScope = scope
      this.clearSessionCaches()
    }
  }

  applyCachedStatusToSession(session: ChatSession, username: string, now: number = Date.now()): void {
    const cachedStatus = this.sessionStatusCache.get(username)
    if (cachedStatus && now - cachedStatus.updatedAt <= this.sessionStatusCacheTtlMs) {
      session.isFolded = cachedStatus.isFolded
      session.isMuted = cachedStatus.isMuted
    }
  }

  seedMessageCountHint(username: string, messageCountHint: number | undefined): void {
    if (typeof messageCountHint !== 'number') return
    this.sessionMessageCountHintCache.set(username, messageCountHint)
    this.sessionMessageCountCache.set(username, {
      count: messageCountHint,
      updatedAt: Date.now()
    })
  }

  setMessageCountHint(username: string, count: number): void {
    this.sessionMessageCountHintCache.set(username, count)
  }

  private async countSessionMessageCountsByTableScan(
    sessionIds: string[],
    traceId?: string
  ): Promise<{
    success: boolean
    counts?: Record<string, number>
    error?: string
    dbSignature?: string
  }> {
    const normalizedSessionIds = Array.from(new Set(
      (sessionIds || [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    ))
    if (normalizedSessionIds.length === 0) {
      return { success: true, counts: {}, dbSignature: 'empty' }
    }

    const snapshotResult = await this.host.getMessageDbCountSnapshot()
    const dbPaths = snapshotResult.success ? (snapshotResult.dbPaths || []) : []
    const dbSignature = snapshotResult.success
      ? (snapshotResult.dbSignature || this.host.buildMessageDbSignature(dbPaths))
      : this.host.buildMessageDbSignature(dbPaths)
    const nativeResult = await wcdbService.getSessionMessageCounts(normalizedSessionIds)
    if (!nativeResult.success || !nativeResult.counts) {
      return { success: false, error: nativeResult.error || '获取会话消息总数失败', dbSignature }
    }
    const counts = normalizedSessionIds.reduce<Record<string, number>>((acc, sid) => {
      const raw = nativeResult.counts?.[sid]
      acc[sid] = Number.isFinite(raw) ? Math.max(0, Math.floor(Number(raw))) : 0
      return acc
    }, {})

    this.host.logExportDiag({
      traceId,
      level: 'debug',
      source: 'backend',
      stepId: 'backend-get-session-message-counts-table-scan',
      stepName: '会话消息总数表扫描',
      status: 'done',
      message: '按 Msg 表聚合统计完成',
      data: {
        dbCount: dbPaths.length,
        requestedSessions: normalizedSessionIds.length
      }
    })

    return { success: true, counts, dbSignature }
  }

  /**
   * 批量获取会话消息总数（轻量接口，用于列表优先排序）
   */
  async getSessionMessageCounts(
    sessionIds: string[],
    options?: { preferHintCache?: boolean; bypassSessionCache?: boolean; traceId?: string }
  ): Promise<{
    success: boolean
    counts?: Record<string, number>
    error?: string
  }> {
    const traceId = this.host.normalizeExportDiagTraceId(options?.traceId)
    const stepStartedAt = this.host.startExportDiagStep({
      traceId,
      stepId: 'backend-get-session-message-counts',
      stepName: 'ChatService.getSessionMessageCounts',
      message: '开始批量读取会话消息总数',
      data: {
        requestedSessions: Array.isArray(sessionIds) ? sessionIds.length : 0,
        preferHintCache: options?.preferHintCache !== false,
        bypassSessionCache: options?.bypassSessionCache === true
      }
    })
    let success = false
    let errorMessage = ''
    let returnedCounts = 0

    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        errorMessage = connectResult.error || '数据库未连接'
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const normalizedSessionIds = Array.from(
        new Set(
          (sessionIds || [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedSessionIds.length === 0) {
        success = true
        return { success: true, counts: {} }
      }

      const preferHintCache = options?.preferHintCache !== false
      const bypassSessionCache = options?.bypassSessionCache === true

      this.ensureCacheScopeRefreshed()
      const counts: Record<string, number> = {}
      const now = Date.now()
      const pendingSessionIds: string[] = []
      const sessionIdsKey = [...normalizedSessionIds].sort().join('\u0001')

      for (const sessionId of normalizedSessionIds) {
        if (!bypassSessionCache) {
          const cached = this.sessionMessageCountCache.get(sessionId)
          if (cached && now - cached.updatedAt <= this.sessionMessageCountCacheTtlMs) {
            counts[sessionId] = cached.count
            continue
          }
        }

        if (preferHintCache) {
          const hintCount = this.sessionMessageCountHintCache.get(sessionId)
          if (typeof hintCount === 'number' && Number.isFinite(hintCount) && hintCount >= 0) {
            counts[sessionId] = Math.floor(hintCount)
            this.sessionMessageCountCache.set(sessionId, {
              count: Math.floor(hintCount),
              updatedAt: now
            })
            continue
          }
        }

        pendingSessionIds.push(sessionId)
      }

      if (pendingSessionIds.length > 0) {
        let tableScanSucceeded = false
        const cachedBatch = this.sessionMessageCountBatchCache
        const cachedBatchFresh = cachedBatch &&
          now - cachedBatch.updatedAt <= this.sessionMessageCountBatchCacheTtlMs

        if (cachedBatchFresh && cachedBatch.sessionIdsKey === sessionIdsKey) {
          const snapshot = await this.host.getMessageDbCountSnapshot()
          if (snapshot.success && snapshot.dbSignature === cachedBatch.dbSignature) {
            for (const sessionId of pendingSessionIds) {
              const nextCountRaw = cachedBatch.counts[sessionId]
              const nextCount = Number.isFinite(nextCountRaw) ? Math.max(0, Math.floor(nextCountRaw)) : 0
              counts[sessionId] = nextCount
              this.sessionMessageCountCache.set(sessionId, {
                count: nextCount,
                updatedAt: now
              })
            }
            tableScanSucceeded = true
          }
        }

        if (!tableScanSucceeded) {
          const tableScanResult = await this.countSessionMessageCountsByTableScan(pendingSessionIds, traceId)
          if (tableScanResult.success && tableScanResult.counts) {
            const nowTs = Date.now()
            for (const sessionId of pendingSessionIds) {
              const nextCountRaw = tableScanResult.counts[sessionId]
              const nextCount = Number.isFinite(nextCountRaw) ? Math.max(0, Math.floor(nextCountRaw)) : 0
              counts[sessionId] = nextCount
              this.sessionMessageCountCache.set(sessionId, {
                count: nextCount,
                updatedAt: nowTs
              })
            }
            if (tableScanResult.dbSignature) {
              this.sessionMessageCountBatchCache = {
                dbSignature: tableScanResult.dbSignature,
                sessionIdsKey,
                counts: { ...counts },
                updatedAt: nowTs
              }
            }
            tableScanSucceeded = true
          } else {
            this.host.logExportDiag({
              traceId,
              level: 'warn',
              source: 'backend',
              stepId: 'backend-get-session-message-counts-table-scan',
              stepName: '会话消息总数表扫描',
              status: 'failed',
              message: '按 Msg 表聚合统计失败，回退逐会话统计',
              data: {
                error: tableScanResult.error || '未知错误'
              }
            })
          }
        }

        if (!tableScanSucceeded) {
          const batchSize = 320
          for (let i = 0; i < pendingSessionIds.length; i += batchSize) {
            const batch = pendingSessionIds.slice(i, i + batchSize)
            this.host.logExportDiag({
              traceId,
              level: 'debug',
              source: 'backend',
              stepId: 'backend-get-session-message-counts-batch',
              stepName: '会话消息总数批次查询',
              status: 'running',
              message: `开始查询批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(pendingSessionIds.length / batchSize) || 1}`,
              data: {
                batchSize: batch.length
              }
            })
            let batchCounts: Record<string, number> = {}
            try {
              const result = await wcdbService.getMessageCounts(batch)
              if (result.success && result.counts) {
                batchCounts = result.counts
              }
            } catch {
              // noop
            }

            const nowTs = Date.now()
            for (const sessionId of batch) {
              const nextCountRaw = batchCounts[sessionId]
              const nextCount = Number.isFinite(nextCountRaw) ? Math.max(0, Math.floor(nextCountRaw)) : 0
              counts[sessionId] = nextCount
              this.sessionMessageCountCache.set(sessionId, {
                count: nextCount,
                updatedAt: nowTs
              })
            }
          }
        }
      }

      returnedCounts = Object.keys(counts).length
      success = true
      return { success: true, counts }
    } catch (e) {
      console.error('ChatService: 批量获取会话消息总数失败:', e)
      errorMessage = String(e)
      return { success: false, error: String(e) }
    } finally {
      this.host.endExportDiagStep({
        traceId,
        stepId: 'backend-get-session-message-counts',
        stepName: 'ChatService.getSessionMessageCounts',
        startedAt: stepStartedAt,
        success,
        message: success ? '批量会话消息总数读取完成' : '批量会话消息总数读取失败',
        data: success ? { returnedCounts } : { error: errorMessage || '未知错误' }
      })
    }
  }
  async getSessionStatuses(usernames: string[]): Promise<{
    success: boolean
    map?: Record<string, { isFolded?: boolean; isMuted?: boolean }>
    error?: string
  }> {
    try {
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return { success: true, map: {} }
      }

      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const result = await wcdbService.getContactStatus(usernames)
      if (!result.success || !result.map) {
        return { success: false, error: result.error || '获取会话状态失败' }
      }

      const now = Date.now()
      for (const username of usernames) {
        const state = result.map[username] || { isFolded: false, isMuted: false }
        this.sessionStatusCache.set(username, {
          isFolded: Boolean(state.isFolded),
          isMuted: Boolean(state.isMuted),
          updatedAt: now
        })
      }

      return {
        success: true,
        map: result.map as Record<string, { isFolded?: boolean; isMuted?: boolean }>
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
  async getSessionDetailFast(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailFast
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      this.ensureCacheScopeRefreshed()

      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) {
        return { success: false, error: '会话ID不能为空' }
      }

      const now = Date.now()
      const cachedDetail = this.sessionDetailFastCache.get(normalizedSessionId)
      if (cachedDetail && now - cachedDetail.updatedAt <= this.sessionDetailFastCacheTtlMs) {
        return { success: true, detail: cachedDetail.detail }
      }

      let displayName = normalizedSessionId
      let remark: string | undefined
      let nickName: string | undefined
      let alias: string | undefined
      let avatarUrl: string | undefined
      const cachedContact = this.host.getAvatarCacheEntry(normalizedSessionId)
      if (cachedContact) {
        displayName = cachedContact.displayName || normalizedSessionId
        if (this.host.isValidAvatarUrl(cachedContact.avatarUrl)) {
          avatarUrl = cachedContact.avatarUrl
        }
      }

      const contactPromise = wcdbService.getContact(normalizedSessionId)
      const avatarPromise = avatarUrl
        ? Promise.resolve({ success: true, map: { [normalizedSessionId]: avatarUrl } })
        : wcdbService.getAvatarUrls([normalizedSessionId])

      let messageCount: number | undefined
      const cachedCount = this.sessionMessageCountCache.get(normalizedSessionId)
      if (cachedCount && now - cachedCount.updatedAt <= this.sessionMessageCountCacheTtlMs) {
        messageCount = cachedCount.count
      } else {
        const hintCount = this.sessionMessageCountHintCache.get(normalizedSessionId)
        if (typeof hintCount === 'number' && Number.isFinite(hintCount) && hintCount >= 0) {
          messageCount = Math.floor(hintCount)
          this.sessionMessageCountCache.set(normalizedSessionId, {
            count: messageCount,
            updatedAt: now
          })
        }
      }

      const messageCountPromise = Number.isFinite(messageCount)
        ? Promise.resolve<{ success: boolean; count?: number }>({
          success: true,
          count: Math.max(0, Math.floor(messageCount as number))
        })
        : wcdbService.getMessageCount(normalizedSessionId)

      const [contactResult, avatarResult, messageCountResult] = await Promise.allSettled([
        contactPromise,
        avatarPromise,
        messageCountPromise
      ])

      if (contactResult.status === 'fulfilled' && contactResult.value.success && contactResult.value.contact) {
        remark = contactResult.value.contact.remark || undefined
        nickName = contactResult.value.contact.nickName || undefined
        alias = contactResult.value.contact.alias || undefined
        displayName = remark || nickName || alias || displayName
      }

      if (avatarResult.status === 'fulfilled' && avatarResult.value.success && avatarResult.value.map) {
        const avatarCandidate = avatarResult.value.map[normalizedSessionId]
        if (this.host.isValidAvatarUrl(avatarCandidate)) {
          avatarUrl = avatarCandidate
        }
      }
      if (!avatarUrl) {
        const headImageAvatars = await this.host.getAvatarsFromHeadImageDb([normalizedSessionId])
        const fallbackAvatarUrl = headImageAvatars[normalizedSessionId]
        if (this.host.isValidAvatarUrl(fallbackAvatarUrl)) {
          avatarUrl = fallbackAvatarUrl
        }
      }

      if (!Number.isFinite(messageCount)) {
        messageCount = messageCountResult.status === 'fulfilled' &&
          messageCountResult.value.success &&
          Number.isFinite(messageCountResult.value.count)
          ? Math.max(0, Math.floor(messageCountResult.value.count || 0))
          : 0
        this.sessionMessageCountCache.set(normalizedSessionId, {
          count: messageCount,
          updatedAt: Date.now()
        })
      }

      const detail: SessionDetailFast = {
        wxid: normalizedSessionId,
        displayName,
        remark,
        nickName,
        alias,
        avatarUrl,
        messageCount: Math.max(0, Math.floor(messageCount || 0))
      }

      this.sessionDetailFastCache.set(normalizedSessionId, {
        detail,
        updatedAt: Date.now()
      })

      return { success: true, detail }
    } catch (e) {
      console.error('ChatService: 获取会话详情快速信息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getSessionDetailExtra(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailExtra
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      this.ensureCacheScopeRefreshed()

      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) {
        return { success: false, error: '会话ID不能为空' }
      }

      const now = Date.now()
      const cachedDetail = this.sessionDetailExtraCache.get(normalizedSessionId)
      if (cachedDetail && now - cachedDetail.updatedAt <= this.sessionDetailExtraCacheTtlMs) {
        return { success: true, detail: cachedDetail.detail }
      }

      const tableStatsResult = await wcdbService.getMessageTableStats(normalizedSessionId)

      const messageTables: { dbName: string; tableName: string; count: number }[] = []
      let firstMessageTime: number | undefined
      let latestMessageTime: number | undefined
      if (tableStatsResult.success && tableStatsResult.tables) {
        for (const row of tableStatsResult.tables) {
          messageTables.push({
            dbName: basename(row.db_path || ''),
            tableName: row.table_name || '',
            count: parseInt(row.count || '0', 10)
          })

          const firstTs = getRowInt(
            row,
            ['first_timestamp', 'firstTimestamp', 'first_time', 'firstTime', 'min_create_time', 'minCreateTime'],
            0
          )
          if (firstTs > 0 && (firstMessageTime === undefined || firstTs < firstMessageTime)) {
            firstMessageTime = firstTs
          }

          const lastTs = getRowInt(
            row,
            ['last_timestamp', 'lastTimestamp', 'last_time', 'lastTime', 'max_create_time', 'maxCreateTime'],
            0
          )
          if (lastTs > 0 && (latestMessageTime === undefined || lastTs > latestMessageTime)) {
            latestMessageTime = lastTs
          }
        }
      }

      const detail: SessionDetailExtra = {
        firstMessageTime,
        latestMessageTime,
        messageTables
      }

      this.sessionDetailExtraCache.set(normalizedSessionId, {
        detail,
        updatedAt: Date.now()
      })

      return {
        success: true,
        detail
      }
    } catch (e) {
      console.error('ChatService: 获取会话详情补充统计失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetail
    error?: string
  }> {
    try {
      const fastResult = await this.getSessionDetailFast(sessionId)
      if (!fastResult.success || !fastResult.detail) {
        return { success: false, error: fastResult.error || '获取会话详情失败' }
      }

      const extraResult = await this.getSessionDetailExtra(sessionId)
      const detail: SessionDetail = {
        ...fastResult.detail,
        firstMessageTime: extraResult.success ? extraResult.detail?.firstMessageTime : undefined,
        latestMessageTime: extraResult.success ? extraResult.detail?.latestMessageTime : undefined,
        messageTables: extraResult.success && extraResult.detail?.messageTables
          ? extraResult.detail.messageTables
          : []
      }

      return { success: true, detail }
    } catch (e) {
      console.error('ChatService: 获取会话详情失败:', e)
      return { success: false, error: String(e) }
    }
  }

}
