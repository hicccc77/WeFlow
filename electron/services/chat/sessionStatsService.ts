import { wcdbService } from '../wcdbService'
import { SessionStatsCacheService, SessionStatsCacheEntry, SessionStatsCacheStats } from '../sessionStatsCacheService'
import { GroupMyMessageCountCacheService, GroupMyMessageCountCacheEntry } from '../groupMyMessageCountCacheService'
import { FRIEND_EXCLUDE_USERNAMES } from './constants'
import { buildIdentityKeys, coerceRowNumber, getRowInt } from './messageRowUtils'
import { decodeMessageContent, extractType49XmlTypeForStats } from './messageParsing'
import { normalizeTimestampSeconds } from './timeUtils'
import type {
  ExportSessionStats,
  ExportSessionStatsCacheMeta,
  ExportSessionStatsOptions
} from './types'
import type { SessionStatsHost } from './sessionStatsHost'

export class SessionStatsService {
  private sessionStatsCacheScope = ''
  private sessionStatsMemoryCache = new Map<string, SessionStatsCacheEntry>()
  private sessionStatsPendingBasic = new Map<string, Promise<ExportSessionStats>>()
  private sessionStatsPendingFull = new Map<string, Promise<ExportSessionStats>>()
  private allGroupSessionIdsCache: { ids: string[]; updatedAt: number } | null = null
  private readonly sessionStatsCacheTtlMs = 10 * 60 * 1000
  private readonly allGroupSessionIdsCacheTtlMs = 5 * 60 * 1000
  private groupMyMessageCountCacheScope = ''
  private groupMyMessageCountMemoryCache = new Map<string, GroupMyMessageCountCacheEntry>()
  private readonly sessionStatsCacheService: SessionStatsCacheService
  private readonly groupMyMessageCountCacheService: GroupMyMessageCountCacheService

  constructor(
    private readonly host: SessionStatsHost,
    cacheBasePath: string
  ) {
    this.sessionStatsCacheService = new SessionStatsCacheService(cacheBasePath)
    this.groupMyMessageCountCacheService = new GroupMyMessageCountCacheService(cacheBasePath)
  }

  ensureCacheScope(): void {
    this.refreshCacheScope(this.host.getCacheScope())
  }

  clearCaches(): void {
    this.sessionStatsMemoryCache.clear()
    this.sessionStatsPendingBasic.clear()
    this.sessionStatsPendingFull.clear()
    this.allGroupSessionIdsCache = null
    this.sessionStatsCacheService.clearAll()
    this.groupMyMessageCountMemoryCache.clear()
    this.groupMyMessageCountCacheService.clearAll()
  }

  private extractGroupMemberUsername(member: any): string {
    if (!member) return ''
    if (typeof member === 'string') return member.trim()
    return String(
      member.username ||
      member.userName ||
      member.user_name ||
      member.encryptUsername ||
      member.encryptUserName ||
      member.encrypt_username ||
      member.originalName ||
      ''
    ).trim()
  }

  private async getFriendIdentitySet(): Promise<Set<string>> {
    const identities = new Set<string>()
    const contactResult = await wcdbService.getContactsCompact()
    if (!contactResult.success || !contactResult.contacts) {
      return identities
    }

    for (const rowAny of contactResult.contacts) {
      const row = rowAny as Record<string, any>
      const username = String(row.username || '').trim()
      if (!username || username.includes('@chatroom') || username.startsWith('gh_')) continue
      if (FRIEND_EXCLUDE_USERNAMES.has(username)) continue

      const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], 0)
      if (localType !== 1) continue

      for (const key of buildIdentityKeys(username)) {
        identities.add(key)
      }
    }
    return identities
  }

  private async forEachWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    if (items.length === 0) return
    const concurrency = Math.max(1, Math.min(limit, items.length))
    let index = 0

    const runners = Array.from({ length: concurrency }, async () => {
      while (true) {
        const current = index
        index += 1
        if (current >= items.length) return
        await worker(items[current])
      }
    })

    await Promise.all(runners)
  }
  refreshCacheScope(scope: string): void {
    if (scope !== this.groupMyMessageCountCacheScope) {
      this.groupMyMessageCountCacheScope = scope
      this.groupMyMessageCountMemoryCache.clear()
    }
    if (scope === this.sessionStatsCacheScope) return
    this.sessionStatsCacheScope = scope
    this.sessionStatsMemoryCache.clear()
    this.sessionStatsPendingBasic.clear()
    this.sessionStatsPendingFull.clear()
    this.allGroupSessionIdsCache = null
  }

  private buildScopedSessionStatsKey(sessionId: string): string {
    return `${this.sessionStatsCacheScope}::${sessionId}`
  }

  private buildScopedGroupMyMessageCountKey(chatroomId: string): string {
    return `${this.groupMyMessageCountCacheScope}::${chatroomId}`
  }

  private getGroupMyMessageCountHintEntry(
    chatroomId: string
  ): { entry: GroupMyMessageCountCacheEntry; source: 'memory' | 'disk' } | null {
    const scopedKey = this.buildScopedGroupMyMessageCountKey(chatroomId)
    const inMemory = this.groupMyMessageCountMemoryCache.get(scopedKey)
    if (inMemory) {
      return { entry: inMemory, source: 'memory' }
    }

    const persisted = this.groupMyMessageCountCacheService.get(this.groupMyMessageCountCacheScope, chatroomId)
    if (!persisted) return null
    this.groupMyMessageCountMemoryCache.set(scopedKey, persisted)
    return { entry: persisted, source: 'disk' }
  }

  private setGroupMyMessageCountHintEntry(chatroomId: string, messageCount: number, updatedAt?: number): number {
    const nextCount = Number.isFinite(messageCount) ? Math.max(0, Math.floor(messageCount)) : 0
    const nextUpdatedAt = Number.isFinite(updatedAt) ? Math.max(0, Math.floor(updatedAt as number)) : Date.now()
    const scopedKey = this.buildScopedGroupMyMessageCountKey(chatroomId)
    const existing = this.groupMyMessageCountMemoryCache.get(scopedKey)
    if (existing && existing.updatedAt > nextUpdatedAt) {
      return existing.updatedAt
    }

    const entry: GroupMyMessageCountCacheEntry = {
      updatedAt: nextUpdatedAt,
      messageCount: nextCount
    }
    this.groupMyMessageCountMemoryCache.set(scopedKey, entry)
    this.groupMyMessageCountCacheService.set(this.groupMyMessageCountCacheScope, chatroomId, entry)
    return nextUpdatedAt
  }

  private toSessionStatsCacheStats(stats: ExportSessionStats): SessionStatsCacheStats {
    const normalized: SessionStatsCacheStats = {
      totalMessages: Number.isFinite(stats.totalMessages) ? Math.max(0, Math.floor(stats.totalMessages)) : 0,
      voiceMessages: Number.isFinite(stats.voiceMessages) ? Math.max(0, Math.floor(stats.voiceMessages)) : 0,
      imageMessages: Number.isFinite(stats.imageMessages) ? Math.max(0, Math.floor(stats.imageMessages)) : 0,
      videoMessages: Number.isFinite(stats.videoMessages) ? Math.max(0, Math.floor(stats.videoMessages)) : 0,
      emojiMessages: Number.isFinite(stats.emojiMessages) ? Math.max(0, Math.floor(stats.emojiMessages)) : 0,
      transferMessages: Number.isFinite(stats.transferMessages) ? Math.max(0, Math.floor(stats.transferMessages)) : 0,
      redPacketMessages: Number.isFinite(stats.redPacketMessages) ? Math.max(0, Math.floor(stats.redPacketMessages)) : 0,
      callMessages: Number.isFinite(stats.callMessages) ? Math.max(0, Math.floor(stats.callMessages)) : 0
    }

    if (Number.isFinite(stats.firstTimestamp)) normalized.firstTimestamp = Math.max(0, Math.floor(stats.firstTimestamp as number))
    if (Number.isFinite(stats.lastTimestamp)) normalized.lastTimestamp = Math.max(0, Math.floor(stats.lastTimestamp as number))
    if (Number.isFinite(stats.privateMutualGroups)) normalized.privateMutualGroups = Math.max(0, Math.floor(stats.privateMutualGroups as number))
    if (Number.isFinite(stats.groupMemberCount)) normalized.groupMemberCount = Math.max(0, Math.floor(stats.groupMemberCount as number))
    if (Number.isFinite(stats.groupMyMessages)) normalized.groupMyMessages = Math.max(0, Math.floor(stats.groupMyMessages as number))
    if (Number.isFinite(stats.groupActiveSpeakers)) normalized.groupActiveSpeakers = Math.max(0, Math.floor(stats.groupActiveSpeakers as number))
    if (Number.isFinite(stats.groupMutualFriends)) normalized.groupMutualFriends = Math.max(0, Math.floor(stats.groupMutualFriends as number))

    return normalized
  }

  private fromSessionStatsCacheStats(stats: SessionStatsCacheStats): ExportSessionStats {
    return {
      totalMessages: stats.totalMessages,
      voiceMessages: stats.voiceMessages,
      imageMessages: stats.imageMessages,
      videoMessages: stats.videoMessages,
      emojiMessages: stats.emojiMessages,
      transferMessages: stats.transferMessages,
      redPacketMessages: stats.redPacketMessages,
      callMessages: stats.callMessages,
      firstTimestamp: stats.firstTimestamp,
      lastTimestamp: stats.lastTimestamp,
      privateMutualGroups: stats.privateMutualGroups,
      groupMemberCount: stats.groupMemberCount,
      groupMyMessages: stats.groupMyMessages,
      groupActiveSpeakers: stats.groupActiveSpeakers,
      groupMutualFriends: stats.groupMutualFriends
    }
  }

  private supportsRequestedRelation(entry: SessionStatsCacheEntry, includeRelations: boolean): boolean {
    if (!includeRelations) return true
    return entry.includeRelations
  }

  private getSessionStatsCacheEntry(sessionId: string): { entry: SessionStatsCacheEntry; source: 'memory' | 'disk' } | null {
    const scopedKey = this.buildScopedSessionStatsKey(sessionId)
    const inMemory = this.sessionStatsMemoryCache.get(scopedKey)
    if (inMemory) {
      return { entry: inMemory, source: 'memory' }
    }

    const persisted = this.sessionStatsCacheService.get(this.sessionStatsCacheScope, sessionId)
    if (!persisted) return null
    this.sessionStatsMemoryCache.set(scopedKey, persisted)
    return { entry: persisted, source: 'disk' }
  }

  private setSessionStatsCacheEntry(sessionId: string, stats: ExportSessionStats, includeRelations: boolean): number {
    const updatedAt = Date.now()
    const normalizedStats = this.toSessionStatsCacheStats(stats)
    const entry: SessionStatsCacheEntry = {
      updatedAt,
      includeRelations,
      stats: normalizedStats
    }
    const scopedKey = this.buildScopedSessionStatsKey(sessionId)
    this.sessionStatsMemoryCache.set(scopedKey, entry)
    this.sessionStatsCacheService.set(this.sessionStatsCacheScope, sessionId, entry)
    if (sessionId.endsWith('@chatroom') && Number.isFinite(normalizedStats.groupMyMessages)) {
      this.setGroupMyMessageCountHintEntry(sessionId, normalizedStats.groupMyMessages as number, updatedAt)
    }
    return updatedAt
  }

  private deleteSessionStatsCacheEntry(sessionId: string): void {
    const scopedKey = this.buildScopedSessionStatsKey(sessionId)
    this.sessionStatsMemoryCache.delete(scopedKey)
    this.sessionStatsPendingBasic.delete(scopedKey)
    this.sessionStatsPendingFull.delete(scopedKey)
    this.sessionStatsCacheService.delete(this.sessionStatsCacheScope, sessionId)
  }

  private clearSessionStatsCacheForScope(): void {
    this.sessionStatsMemoryCache.clear()
    this.sessionStatsPendingBasic.clear()
    this.sessionStatsPendingFull.clear()
    this.allGroupSessionIdsCache = null
    this.sessionStatsCacheService.clearScope(this.sessionStatsCacheScope)
  }

  private collectSessionIdsFromPayload(payload: unknown): Set<string> {
    const ids = new Set<string>()
    const walk = (value: unknown, keyHint?: string) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, keyHint)
        return
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          walk(v, k)
        }
        return
      }
      if (typeof value !== 'string') return
      const normalized = value.trim()
      if (!normalized) return
      const lowerKey = String(keyHint || '').toLowerCase()
      const keyLooksLikeSession = (
        lowerKey.includes('session') ||
        lowerKey.includes('talker') ||
        lowerKey.includes('username') ||
        lowerKey.includes('chatroom')
      )
      if (!keyLooksLikeSession && !normalized.includes('@chatroom')) {
        return
      }
      ids.add(normalized)
    }
    walk(payload)
    return ids
  }

  handleDbMonitorChange(type: string, json: string): void {
    if (!this.sessionStatsCacheScope) return

    const normalizedType = String(type || '').toLowerCase()
    const maybeJson = String(json || '').trim()
    let ids = new Set<string>()
    if (maybeJson) {
      try {
        ids = this.collectSessionIdsFromPayload(JSON.parse(maybeJson))
      } catch {
        ids = this.collectSessionIdsFromPayload(maybeJson)
      }
    }

    if (ids.size > 0) {
      ids.forEach((sessionId) => this.deleteSessionStatsCacheEntry(sessionId))
      if (Array.from(ids).some((id) => id.includes('@chatroom'))) {
        this.allGroupSessionIdsCache = null
      }
      return
    }

    // 无法定位具体会话时，保守地仅在消息/群成员相关变更时清空当前 scope，避免展示过旧统计。
    if (
      normalizedType.includes('message') ||
      normalizedType.includes('session') ||
      normalizedType.includes('group') ||
      normalizedType.includes('member') ||
      normalizedType.includes('contact')
    ) {
      this.clearSessionStatsCacheForScope()
    }
  }

  private async listAllGroupSessionIds(): Promise<string[]> {
    const now = Date.now()
    if (
      this.allGroupSessionIdsCache &&
      now - this.allGroupSessionIdsCache.updatedAt <= this.allGroupSessionIdsCacheTtlMs
    ) {
      return this.allGroupSessionIdsCache.ids
    }

    const result = await wcdbService.getSessions()
    if (!result.success || !Array.isArray(result.sessions)) {
      return []
    }

    const ids = new Set<string>()
    for (const rowAny of result.sessions) {
      const row = rowAny as Record<string, unknown>
      const usernameRaw = row.username ?? row.userName ?? row.talker ?? row.sessionId
      const username = String(usernameRaw || '').trim()
      if (!username || !username.endsWith('@chatroom')) continue
      ids.add(username)
    }

    const list = Array.from(ids)
    this.allGroupSessionIdsCache = {
      ids: list,
      updatedAt: now
    }
    return list
  }
  private async collectSpecialMessageCountsByCursorScan(
    sessionId: string,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<{
    transferMessages: number
    redPacketMessages: number
    callMessages: number
  }> {
    const counters = {
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }

    const cursorResult = await wcdbService.openMessageCursorLite(sessionId, 500, false, beginTimestamp, endTimestamp)
    if (!cursorResult.success || !cursorResult.cursor) {
      return counters
    }

    const cursor = cursorResult.cursor
    try {
      while (true) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) break
        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        for (const row of rows) {
          const localType = getRowInt(row, ['local_type'], 1)
          if (localType === 50) {
            counters.callMessages += 1
            continue
          }
          if (localType === 8589934592049) {
            counters.transferMessages += 1
            continue
          }
          if (localType === 8594229559345) {
            counters.redPacketMessages += 1
            continue
          }
          if (localType !== 49) continue

          const rawMessageContent = row.message_content
          const rawCompressContent = row.compress_content
          const content = decodeMessageContent(rawMessageContent, rawCompressContent)
          const xmlType = extractType49XmlTypeForStats(content)
          if (xmlType === '2000') counters.transferMessages += 1
          if (xmlType === '2001') counters.redPacketMessages += 1
        }

        if (!batch.hasMore || rows.length === 0) break
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor)
    }

    return counters
  }

  private async collectSessionExportStatsByCursorScan(
    sessionId: string,
    selfIdentitySet: Set<string>,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<ExportSessionStats> {
    const stats: ExportSessionStats = {
      totalMessages: 0,
      voiceMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      emojiMessages: 0,
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }
    if (sessionId.endsWith('@chatroom')) {
      stats.groupMyMessages = 0
      stats.groupActiveSpeakers = 0
    }

    const senderIdentities = new Set<string>()
    const cursorResult = await wcdbService.openMessageCursorLite(sessionId, 500, false, beginTimestamp, endTimestamp)
    if (!cursorResult.success || !cursorResult.cursor) {
      return stats
    }

    const cursor = cursorResult.cursor
    try {
      while (true) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) {
          break
        }

        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        for (const row of rows) {
          stats.totalMessages += 1

          const localType = getRowInt(row, ['local_type'], 1)
          if (localType === 34) stats.voiceMessages += 1
          if (localType === 3) stats.imageMessages += 1
          if (localType === 43) stats.videoMessages += 1
          if (localType === 47) stats.emojiMessages += 1
          if (localType === 50) stats.callMessages += 1
          if (localType === 8589934592049) stats.transferMessages += 1
          if (localType === 8594229559345) stats.redPacketMessages += 1
          if (localType === 49) {
            const rawMessageContent = row.message_content
            const rawCompressContent = row.compress_content
            const content = decodeMessageContent(rawMessageContent, rawCompressContent)
            const xmlType = extractType49XmlTypeForStats(content)
            if (xmlType === '2000') stats.transferMessages += 1
            if (xmlType === '2001') stats.redPacketMessages += 1
          }

          const createTime = getRowInt(
            row,
            ['create_time'],
            0
          )
          if (createTime > 0) {
            if (stats.firstTimestamp === undefined || createTime < stats.firstTimestamp) {
              stats.firstTimestamp = createTime
            }
            if (stats.lastTimestamp === undefined || createTime > stats.lastTimestamp) {
              stats.lastTimestamp = createTime
            }
          }

          if (sessionId.endsWith('@chatroom')) {
            const sender = String(row.sender_username || '').trim()
            const senderKeys = buildIdentityKeys(sender)
            if (senderKeys.length > 0) {
              senderIdentities.add(senderKeys[0])
              if (senderKeys.some((key) => selfIdentitySet.has(key))) {
                stats.groupMyMessages = (stats.groupMyMessages || 0) + 1
              }
            } else {
              const isSend = coerceRowNumber(row.computed_is_send ?? row.is_send)
              if (Number.isFinite(isSend) && isSend === 1) {
                stats.groupMyMessages = (stats.groupMyMessages || 0) + 1
              }
            }
          }
        }

        if (!batch.hasMore || rows.length === 0) {
          break
        }
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor)
    }

    if (sessionId.endsWith('@chatroom')) {
      stats.groupActiveSpeakers = senderIdentities.size
      if ((beginTimestamp <= 0 && endTimestamp <= 0) && Number.isFinite(stats.groupMyMessages)) {
        this.setGroupMyMessageCountHintEntry(sessionId, stats.groupMyMessages as number)
      }
    }
    return stats
  }

  private async collectSessionExportStats(
    sessionId: string,
    selfIdentitySet: Set<string>,
    preferAccurateSpecialTypes: boolean = false,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<ExportSessionStats> {
    const stats: ExportSessionStats = {
      totalMessages: 0,
      voiceMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      emojiMessages: 0,
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }
    const isGroup = sessionId.endsWith('@chatroom')
    if (isGroup) {
      stats.groupMyMessages = 0
      stats.groupActiveSpeakers = 0
    }

    const nativeResult = await wcdbService.getSessionMessageTypeStats(sessionId, beginTimestamp, endTimestamp)
    if (!nativeResult.success || !nativeResult.data) {
      return this.collectSessionExportStatsByCursorScan(sessionId, selfIdentitySet, beginTimestamp, endTimestamp)
    }

    const data = nativeResult.data as Record<string, any>
    stats.totalMessages = Math.max(0, Math.floor(Number(data.total_messages || 0)))
    stats.voiceMessages = Math.max(0, Math.floor(Number(data.voice_messages || 0)))
    stats.imageMessages = Math.max(0, Math.floor(Number(data.image_messages || 0)))
    stats.videoMessages = Math.max(0, Math.floor(Number(data.video_messages || 0)))
    stats.emojiMessages = Math.max(0, Math.floor(Number(data.emoji_messages || 0)))
    stats.callMessages = Math.max(0, Math.floor(Number(data.call_messages || 0)))
    stats.transferMessages = Math.max(0, Math.floor(Number(data.transfer_messages || 0)))
    stats.redPacketMessages = Math.max(0, Math.floor(Number(data.red_packet_messages || 0)))

    const firstTs = Math.max(0, Math.floor(Number(data.first_timestamp || 0)))
    const lastTs = Math.max(0, Math.floor(Number(data.last_timestamp || 0)))
    if (firstTs > 0) stats.firstTimestamp = firstTs
    if (lastTs > 0) stats.lastTimestamp = lastTs

    if (preferAccurateSpecialTypes) {
      try {
        const preciseCounters = await this.collectSpecialMessageCountsByCursorScan(sessionId, beginTimestamp, endTimestamp)
        stats.transferMessages = preciseCounters.transferMessages
        stats.redPacketMessages = preciseCounters.redPacketMessages
        stats.callMessages = preciseCounters.callMessages
      } catch {
        // 保留 native 聚合结果作为兜底
      }
    }

    if (isGroup) {
      stats.groupMyMessages = Math.max(0, Math.floor(Number(data.group_my_messages || 0)))
      stats.groupActiveSpeakers = Math.max(0, Math.floor(Number(data.group_sender_count || 0)))
      if ((beginTimestamp <= 0 && endTimestamp <= 0) && Number.isFinite(stats.groupMyMessages)) {
        this.setGroupMyMessageCountHintEntry(sessionId, stats.groupMyMessages as number)
      }
    }
    return stats
  }

  private toExportSessionStatsFromNativeTypeRow(
    sessionId: string,
    row: Record<string, any>,
    options?: { updateGroupHint?: boolean }
  ): ExportSessionStats {
    const updateGroupHint = options?.updateGroupHint !== false
    const stats: ExportSessionStats = {
      totalMessages: Math.max(0, Math.floor(Number(row?.total_messages || 0))),
      voiceMessages: Math.max(0, Math.floor(Number(row?.voice_messages || 0))),
      imageMessages: Math.max(0, Math.floor(Number(row?.image_messages || 0))),
      videoMessages: Math.max(0, Math.floor(Number(row?.video_messages || 0))),
      emojiMessages: Math.max(0, Math.floor(Number(row?.emoji_messages || 0))),
      callMessages: Math.max(0, Math.floor(Number(row?.call_messages || 0))),
      transferMessages: Math.max(0, Math.floor(Number(row?.transfer_messages || 0))),
      redPacketMessages: Math.max(0, Math.floor(Number(row?.red_packet_messages || 0)))
    }

    const firstTs = Math.max(0, Math.floor(Number(row?.first_timestamp || 0)))
    const lastTs = Math.max(0, Math.floor(Number(row?.last_timestamp || 0)))
    if (firstTs > 0) stats.firstTimestamp = firstTs
    if (lastTs > 0) stats.lastTimestamp = lastTs

    if (sessionId.endsWith('@chatroom')) {
      stats.groupMyMessages = Math.max(0, Math.floor(Number(row?.group_my_messages || 0)))
      stats.groupActiveSpeakers = Math.max(0, Math.floor(Number(row?.group_sender_count || 0)))
      if (updateGroupHint && Number.isFinite(stats.groupMyMessages)) {
        this.setGroupMyMessageCountHintEntry(sessionId, stats.groupMyMessages as number)
      }
    }
    return stats
  }

  private async buildGroupRelationStats(
    groupSessionIds: string[],
    privateSessionIds: string[],
    selfIdentitySet: Set<string>
  ): Promise<{
    privateMutualGroupMap: Record<string, number>
    groupMutualFriendMap: Record<string, number>
  }> {
    const privateMutualGroupMap: Record<string, number> = {}
    const groupMutualFriendMap: Record<string, number> = {}
    if (groupSessionIds.length === 0) {
      return { privateMutualGroupMap, groupMutualFriendMap }
    }

    const privateIndex = new Map<string, Set<string>>()
    for (const sessionId of privateSessionIds) {
      for (const key of buildIdentityKeys(sessionId)) {
        const set = privateIndex.get(key) || new Set<string>()
        set.add(sessionId)
        privateIndex.set(key, set)
      }
      privateMutualGroupMap[sessionId] = 0
    }

    const friendIdentitySet = await this.getFriendIdentitySet()
    await this.forEachWithConcurrency(groupSessionIds, 4, async (groupId) => {
      const membersResult = await wcdbService.getGroupMembers(groupId)
      if (!membersResult.success || !membersResult.members) {
        groupMutualFriendMap[groupId] = 0
        return
      }

      const touchedPrivateSessions = new Set<string>()
      const friendMembers = new Set<string>()

      for (const member of membersResult.members) {
        const username = this.extractGroupMemberUsername(member)
        const identityKeys = buildIdentityKeys(username)
        if (identityKeys.length === 0) continue
        const canonical = identityKeys[0]

        if (!selfIdentitySet.has(canonical) && friendIdentitySet.has(canonical)) {
          friendMembers.add(canonical)
        }

        for (const key of identityKeys) {
          const linked = privateIndex.get(key)
          if (!linked) continue
          for (const sessionId of linked) {
            touchedPrivateSessions.add(sessionId)
          }
        }
      }

      groupMutualFriendMap[groupId] = friendMembers.size
      for (const sessionId of touchedPrivateSessions) {
        privateMutualGroupMap[sessionId] = (privateMutualGroupMap[sessionId] || 0) + 1
      }
    })

    return { privateMutualGroupMap, groupMutualFriendMap }
  }

  private buildEmptyExportSessionStats(sessionId: string, includeRelations: boolean): ExportSessionStats {
    const isGroup = sessionId.endsWith('@chatroom')
    const stats: ExportSessionStats = {
      totalMessages: 0,
      voiceMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      emojiMessages: 0,
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }
    if (isGroup) {
      stats.groupMyMessages = 0
      stats.groupActiveSpeakers = 0
      stats.groupMemberCount = 0
      if (includeRelations) {
        stats.groupMutualFriends = 0
      }
    } else if (includeRelations) {
      stats.privateMutualGroups = 0
    }
    return stats
  }

  private async computeSessionExportStats(
    sessionId: string,
    selfIdentitySet: Set<string>,
    includeRelations: boolean,
    preferAccurateSpecialTypes: boolean = false,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<ExportSessionStats> {
    const stats = await this.collectSessionExportStats(
      sessionId,
      selfIdentitySet,
      preferAccurateSpecialTypes,
      beginTimestamp,
      endTimestamp
    )
    const isGroup = sessionId.endsWith('@chatroom')

    if (isGroup) {
      const memberCountsResult = await wcdbService.getGroupMemberCounts([sessionId])
      const memberCountMap = memberCountsResult.success && memberCountsResult.map ? memberCountsResult.map : {}
      stats.groupMemberCount = typeof memberCountMap[sessionId] === 'number' ? Math.max(0, Math.floor(memberCountMap[sessionId])) : 0
    }

    if (includeRelations) {
      if (isGroup) {
        try {
          const { groupMutualFriendMap } = await this.buildGroupRelationStats([sessionId], [], selfIdentitySet)
          stats.groupMutualFriends = groupMutualFriendMap[sessionId] || 0
        } catch {
          stats.groupMutualFriends = 0
        }
      } else {
        const allGroups = await this.listAllGroupSessionIds()
        if (allGroups.length === 0) {
          stats.privateMutualGroups = 0
        } else {
          try {
            const { privateMutualGroupMap } = await this.buildGroupRelationStats(allGroups, [sessionId], selfIdentitySet)
            stats.privateMutualGroups = privateMutualGroupMap[sessionId] || 0
          } catch {
            stats.privateMutualGroups = 0
          }
        }
      }
    }

    return stats
  }

  private async computeSessionExportStatsBatch(
    sessionIds: string[],
    includeRelations: boolean,
    selfIdentitySet: Set<string>,
    preferAccurateSpecialTypes: boolean = false,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<Record<string, ExportSessionStats>> {
    const normalizedSessionIds = Array.from(
      new Set(
        (sessionIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    )
    const result: Record<string, ExportSessionStats> = {}
    if (normalizedSessionIds.length === 0) {
      return result
    }

    const groupSessionIds = normalizedSessionIds.filter(sessionId => sessionId.endsWith('@chatroom'))
    const privateSessionIds = normalizedSessionIds.filter(sessionId => !sessionId.endsWith('@chatroom'))

    let memberCountMap: Record<string, number> = {}
    const shouldLoadGroupMemberCount = groupSessionIds.length > 0 && (includeRelations || normalizedSessionIds.length === 1)
    if (shouldLoadGroupMemberCount) {
      try {
        const memberCountsResult = await wcdbService.getGroupMemberCounts(groupSessionIds)
        memberCountMap = memberCountsResult.success && memberCountsResult.map ? memberCountsResult.map : {}
      } catch {
        memberCountMap = {}
      }
    }

    let privateMutualGroupMap: Record<string, number> = {}
    let groupMutualFriendMap: Record<string, number> = {}
    if (includeRelations) {
      let relationGroupSessionIds: string[] = []
      if (privateSessionIds.length > 0) {
        const allGroups = await this.listAllGroupSessionIds()
        relationGroupSessionIds = Array.from(new Set([...allGroups, ...groupSessionIds]))
      } else if (groupSessionIds.length > 0) {
        relationGroupSessionIds = groupSessionIds
      }

      if (relationGroupSessionIds.length > 0) {
        try {
          const relation = await this.buildGroupRelationStats(
            relationGroupSessionIds,
            privateSessionIds,
            selfIdentitySet
          )
          privateMutualGroupMap = relation.privateMutualGroupMap || {}
          groupMutualFriendMap = relation.groupMutualFriendMap || {}
        } catch {
          privateMutualGroupMap = {}
          groupMutualFriendMap = {}
        }
      }
    }

    const nativeBatchStats: Record<string, ExportSessionStats> = {}
    let hasNativeBatchStats = false
    if (!preferAccurateSpecialTypes) {
      try {
        const quickMode = !includeRelations && normalizedSessionIds.length > 1
        const nativeBatch = await wcdbService.getSessionMessageTypeStatsBatch(normalizedSessionIds, {
          beginTimestamp,
          endTimestamp,
          quickMode,
          includeGroupSenderCount: true
        })
        if (nativeBatch.success && nativeBatch.data) {
          for (const sessionId of normalizedSessionIds) {
            const row = nativeBatch.data?.[sessionId] as Record<string, any> | undefined
            if (!row || typeof row !== 'object') continue
            nativeBatchStats[sessionId] = this.toExportSessionStatsFromNativeTypeRow(sessionId, row, {
              updateGroupHint: beginTimestamp <= 0 && endTimestamp <= 0
            })
          }
          hasNativeBatchStats = Object.keys(nativeBatchStats).length > 0
        } else {
          console.warn('[fallback-exec] getSessionMessageTypeStatsBatch failed, fallback to per-session stats path')
        }
      } catch (error) {
        console.warn('[fallback-exec] getSessionMessageTypeStatsBatch exception, fallback to per-session stats path:', error)
      }
    }

    await this.forEachWithConcurrency(normalizedSessionIds, 3, async (sessionId) => {
      try {
        const stats = hasNativeBatchStats && nativeBatchStats[sessionId]
          ? { ...nativeBatchStats[sessionId] }
          : await this.collectSessionExportStats(
            sessionId,
            selfIdentitySet,
            preferAccurateSpecialTypes,
            beginTimestamp,
            endTimestamp
          )
        if (sessionId.endsWith('@chatroom')) {
          if (shouldLoadGroupMemberCount) {
            stats.groupMemberCount = typeof memberCountMap[sessionId] === 'number'
              ? Math.max(0, Math.floor(memberCountMap[sessionId]))
              : 0
          }
          if (includeRelations) {
            stats.groupMutualFriends = typeof groupMutualFriendMap[sessionId] === 'number'
              ? Math.max(0, Math.floor(groupMutualFriendMap[sessionId]))
              : 0
          }
        } else if (includeRelations) {
          stats.privateMutualGroups = typeof privateMutualGroupMap[sessionId] === 'number'
            ? Math.max(0, Math.floor(privateMutualGroupMap[sessionId]))
            : 0
        }
        result[sessionId] = stats
      } catch {
        result[sessionId] = this.buildEmptyExportSessionStats(sessionId, includeRelations)
      }
    })

    return result
  }

  private async getOrComputeSessionExportStats(
    sessionId: string,
    includeRelations: boolean,
    selfIdentitySet: Set<string>,
    preferAccurateSpecialTypes: boolean = false,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<ExportSessionStats> {
    if (preferAccurateSpecialTypes) {
      return this.computeSessionExportStats(sessionId, selfIdentitySet, includeRelations, true, beginTimestamp, endTimestamp)
    }

    const scopedKey = this.buildScopedSessionStatsKey(sessionId)

    if (!includeRelations) {
      const pendingFull = this.sessionStatsPendingFull.get(scopedKey)
      if (pendingFull) return pendingFull
      const pendingBasic = this.sessionStatsPendingBasic.get(scopedKey)
      if (pendingBasic) return pendingBasic
    } else {
      const pendingFull = this.sessionStatsPendingFull.get(scopedKey)
      if (pendingFull) return pendingFull
    }

    const shouldUsePendingPool = beginTimestamp <= 0 && endTimestamp <= 0
    if (!shouldUsePendingPool) {
      return this.computeSessionExportStats(sessionId, selfIdentitySet, includeRelations, false, beginTimestamp, endTimestamp)
    }

    const targetMap = includeRelations ? this.sessionStatsPendingFull : this.sessionStatsPendingBasic
    const pending = this.computeSessionExportStats(sessionId, selfIdentitySet, includeRelations, false, beginTimestamp, endTimestamp)
    targetMap.set(scopedKey, pending)
    try {
      return await pending
    } finally {
      targetMap.delete(scopedKey)
    }
  }
  async getExportSessionStats(sessionIds: string[], options: ExportSessionStatsOptions = {}): Promise<{
    success: boolean
    data?: Record<string, ExportSessionStats>
    cache?: Record<string, ExportSessionStatsCacheMeta>
    needsRefresh?: string[]
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      this.ensureCacheScope()

      const includeRelations = options.includeRelations ?? true
      const forceRefresh = options.forceRefresh === true
      const allowStaleCache = options.allowStaleCache === true
      const preferAccurateSpecialTypes = options.preferAccurateSpecialTypes === true
      const cacheOnly = options.cacheOnly === true
      const beginTimestamp = normalizeTimestampSeconds(Number(options.beginTimestamp || 0))
      const endTimestamp = normalizeTimestampSeconds(Number(options.endTimestamp || 0))
      const useRangeFilter = beginTimestamp > 0 || endTimestamp > 0

      const normalizedSessionIds = Array.from(
        new Set(
          (sessionIds || [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedSessionIds.length === 0) {
        return { success: true, data: {}, cache: {} }
      }

      const resultMap: Record<string, ExportSessionStats> = {}
      const cacheMeta: Record<string, ExportSessionStatsCacheMeta> = {}
      const needsRefreshSet = new Set<string>()
      const pendingSessionIds: string[] = []
      const now = Date.now()

      for (const sessionId of normalizedSessionIds) {
        const groupMyMessagesHint = sessionId.endsWith('@chatroom')
          ? this.getGroupMyMessageCountHintEntry(sessionId)
          : null
        const cachedResult = this.getSessionStatsCacheEntry(sessionId)
        const canUseCache = !useRangeFilter && (cacheOnly || (!forceRefresh && !preferAccurateSpecialTypes))
        if (canUseCache && cachedResult && this.supportsRequestedRelation(cachedResult.entry, includeRelations)) {
          const stale = now - cachedResult.entry.updatedAt > this.sessionStatsCacheTtlMs
          if (!stale || allowStaleCache || cacheOnly) {
            resultMap[sessionId] = this.fromSessionStatsCacheStats(cachedResult.entry.stats)
            if (groupMyMessagesHint && Number.isFinite(groupMyMessagesHint.entry.messageCount)) {
              resultMap[sessionId].groupMyMessages = groupMyMessagesHint.entry.messageCount
            }
            cacheMeta[sessionId] = {
              updatedAt: cachedResult.entry.updatedAt,
              stale,
              includeRelations: cachedResult.entry.includeRelations,
              source: cachedResult.source
            }
            if (stale) {
              needsRefreshSet.add(sessionId)
            }
            continue
          }
        }
        // allowStaleCache/cacheOnly 仅对“已有缓存”生效；无缓存会话不会直接算重查询。
        if (canUseCache && allowStaleCache && cachedResult) {
          needsRefreshSet.add(sessionId)
          continue
        }
        if (cacheOnly) {
          continue
        }
        pendingSessionIds.push(sessionId)
      }

      if (pendingSessionIds.length > 0) {
        const myWxid = this.host.getMyWxidCleaned() || ''
        const selfIdentitySet = new Set<string>(buildIdentityKeys(myWxid))
        let usedBatchedCompute = false
        if (pendingSessionIds.length === 1) {
          const sessionId = pendingSessionIds[0]
          try {
            const stats = await this.getOrComputeSessionExportStats(
              sessionId,
              includeRelations,
              selfIdentitySet,
              preferAccurateSpecialTypes,
              beginTimestamp,
              endTimestamp
            )
            resultMap[sessionId] = stats
            if (!useRangeFilter) {
              const updatedAt = this.setSessionStatsCacheEntry(sessionId, stats, includeRelations)
              cacheMeta[sessionId] = {
                updatedAt,
                stale: false,
                includeRelations,
                source: 'fresh'
              }
            }
            usedBatchedCompute = true
          } catch {
            usedBatchedCompute = false
          }
        } else {
          try {
            const batchedStatsMap = await this.computeSessionExportStatsBatch(
              pendingSessionIds,
              includeRelations,
              selfIdentitySet,
              preferAccurateSpecialTypes,
              beginTimestamp,
              endTimestamp
            )
            for (const sessionId of pendingSessionIds) {
              const stats = batchedStatsMap[sessionId]
              if (!stats) continue
              resultMap[sessionId] = stats
              if (!useRangeFilter) {
                const updatedAt = this.setSessionStatsCacheEntry(sessionId, stats, includeRelations)
                cacheMeta[sessionId] = {
                  updatedAt,
                  stale: false,
                  includeRelations,
                  source: 'fresh'
                }
              }
            }
            usedBatchedCompute = true
          } catch {
            usedBatchedCompute = false
          }
        }

        if (!usedBatchedCompute) {
          await this.forEachWithConcurrency(pendingSessionIds, 3, async (sessionId) => {
            try {
              const stats = await this.getOrComputeSessionExportStats(
                sessionId,
                includeRelations,
                selfIdentitySet,
                preferAccurateSpecialTypes,
                beginTimestamp,
                endTimestamp
              )
              resultMap[sessionId] = stats
              if (!useRangeFilter) {
                const updatedAt = this.setSessionStatsCacheEntry(sessionId, stats, includeRelations)
                cacheMeta[sessionId] = {
                  updatedAt,
                  stale: false,
                  includeRelations,
                  source: 'fresh'
                }
              }
            } catch {
              resultMap[sessionId] = this.buildEmptyExportSessionStats(sessionId, includeRelations)
            }
          })
        }
      }

      const response: {
        success: boolean
        data?: Record<string, ExportSessionStats>
        cache?: Record<string, ExportSessionStatsCacheMeta>
        needsRefresh?: string[]
      } = {
        success: true,
        data: resultMap,
        cache: cacheMeta
      }
      if (needsRefreshSet.size > 0) {
        response.needsRefresh = Array.from(needsRefreshSet)
      }
      return response
    } catch (e) {
      console.error('ChatService: 获取导出会话统计失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getGroupMyMessageCountHint(chatroomId: string): Promise<{
    success: boolean
    count?: number
    updatedAt?: number
    source?: 'memory' | 'disk'
    error?: string
  }> {
    try {
      this.ensureCacheScope()
      const normalizedChatroomId = String(chatroomId || '').trim()
      if (!normalizedChatroomId || !normalizedChatroomId.endsWith('@chatroom')) {
        return { success: false, error: '群聊ID无效' }
      }

      const cached = this.getGroupMyMessageCountHintEntry(normalizedChatroomId)
      if (!cached) return { success: true }
      return {
        success: true,
        count: cached.entry.messageCount,
        updatedAt: cached.entry.updatedAt,
        source: cached.source
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async setGroupMyMessageCountHint(
    chatroomId: string,
    messageCount: number,
    updatedAt?: number
  ): Promise<{ success: boolean; updatedAt?: number; error?: string }> {
    try {
      this.ensureCacheScope()
      const normalizedChatroomId = String(chatroomId || '').trim()
      if (!normalizedChatroomId || !normalizedChatroomId.endsWith('@chatroom')) {
        return { success: false, error: '群聊ID无效' }
      }
      const savedAt = this.setGroupMyMessageCountHintEntry(normalizedChatroomId, messageCount, updatedAt)
      return { success: true, updatedAt: savedAt }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}
