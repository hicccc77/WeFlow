import {
  createRelationshipAchievementsErrorState,
  evaluateRelationshipAchievements
} from './evaluator'
import type {
  AchievementDataState,
  ExportSessionAchievementStats,
  ExportSessionStatsResponse,
  LoadRelationshipAchievementsOptions,
  MessageDateCountsResponse,
  RelationshipAchievementChatApi,
  RelationshipAchievementCollection,
  RelationshipAchievementTarget
} from './types'

const EXCLUDED_PRIVATE_SESSION_PREFIXES = [
  'qmessage',
  'qqmail',
  'fmessage',
  'medianote',
  'floatbottle',
  'newsapp',
  'brandsessionholder',
  'brandservicesessionholder',
  'notifymessage',
  'opencustomerservicemsg',
  'notification_messages',
  'userexperience_alarm',
  'helper_folders',
  'placeholder_foldgroup',
  '@helper_folders',
  '@placeholder_foldgroup'
] as const

const toNonNegativeInteger = (value: unknown): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0
}

const normalizeOptionalTimestamp = (value: unknown): number | undefined => {
  let numeric = Math.floor(Number(value || 0))
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  while (numeric > 10_000_000_000) numeric = Math.floor(numeric / 1_000)
  return numeric
}

const normalizeMessageDateCounts = (counts: unknown): Record<string, number> => {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return {}
  const normalized: Record<string, number> = {}
  for (const [dateKey, count] of Object.entries(counts as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue
    const value = toNonNegativeInteger(count)
    if (value > 0) normalized[dateKey] = value
  }
  return normalized
}

const normalizeStats = (stats: ExportSessionAchievementStats): ExportSessionAchievementStats => {
  const normalized: ExportSessionAchievementStats = {
    totalMessages: toNonNegativeInteger(stats.totalMessages),
    voiceMessages: toNonNegativeInteger(stats.voiceMessages),
    imageMessages: toNonNegativeInteger(stats.imageMessages),
    videoMessages: toNonNegativeInteger(stats.videoMessages),
    emojiMessages: toNonNegativeInteger(stats.emojiMessages),
    fileMessages: toNonNegativeInteger(stats.fileMessages),
    transferMessages: toNonNegativeInteger(stats.transferMessages),
    redPacketMessages: toNonNegativeInteger(stats.redPacketMessages),
    callMessages: toNonNegativeInteger(stats.callMessages),
    firstTimestamp: normalizeOptionalTimestamp(stats.firstTimestamp),
    lastTimestamp: normalizeOptionalTimestamp(stats.lastTimestamp),
    privateMutualGroups: Number.isFinite(Number(stats.privateMutualGroups))
      ? toNonNegativeInteger(stats.privateMutualGroups)
      : undefined
  }
  if (stats.messageDateCounts !== undefined) {
    normalized.messageDateCounts = normalizeMessageDateCounts(stats.messageDateCounts)
  }
  return normalized
}

export const getPrivateFriendSessionIneligibilityReason = (
  target: RelationshipAchievementTarget
): string | null => {
  const sessionId = String(target.sessionId || '').trim()
  const lowered = sessionId.toLowerCase()
  const selfAccountId = String(target.selfAccountId || '').trim().toLowerCase()

  if (!sessionId) return '缺少好友会话 ID'
  if (selfAccountId && lowered === selfAccountId) return '共同记忆只用于与好友的私聊，不包含与自己的会话'
  if (lowered.includes('@chatroom')) return '共同记忆目前只用于单个好友私聊，不包含群聊'
  if (lowered.startsWith('gh_') || lowered === 'official_accounts_virtual') {
    return '共同记忆目前不用于公众号会话'
  }
  if (lowered === 'filehelper') {
    return '共同记忆目前不用于系统会话'
  }
  if (lowered.includes('@placeholder') || lowered.includes('placeholder_foldgroup')) {
    return '共同记忆不能用于会话列表占位项'
  }
  if (
    lowered.includes('@kefu.openim') ||
    lowered.includes('service_')
  ) {
    return '共同记忆目前不用于客服或企业服务会话'
  }
  if (EXCLUDED_PRIVATE_SESSION_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return '共同记忆目前不用于系统会话'
  }

  return null
}

export const isEligiblePrivateFriendSession = (
  target: RelationshipAchievementTarget
): boolean => getPrivateFriendSessionIneligibilityReason(target) === null

const getDefaultChatApi = (): RelationshipAchievementChatApi | null => {
  if (typeof window === 'undefined') return null
  const chatApi = window.electronAPI?.chat
  if (!chatApi?.getExportSessionStats) return null
  return chatApi as RelationshipAchievementChatApi
}

const statsStateFromResult = (
  sessionId: string,
  settled: PromiseSettledResult<ExportSessionStatsResponse>
): AchievementDataState<ExportSessionAchievementStats> => {
  if (settled.status === 'rejected') {
    return { status: 'error', error: `读取会话统计失败：${String(settled.reason)}` }
  }
  if (!settled.value?.success) {
    return { status: 'error', error: settled.value?.error || '读取会话统计失败' }
  }
  const stats = settled.value.data?.[sessionId]
  if (!stats) return { status: 'error', error: '会话统计没有返回当前好友的数据' }
  return { status: 'ready', value: normalizeStats(stats) }
}

const dateCountsStateFromResult = (
  settled: PromiseSettledResult<MessageDateCountsResponse>
): AchievementDataState<Record<string, number>> => {
  if (settled.status === 'rejected') {
    return { status: 'error', error: `读取每日消息统计失败：${String(settled.reason)}` }
  }
  if (!settled.value?.success) {
    return { status: 'error', error: settled.value?.error || '读取每日消息统计失败' }
  }
  if (!settled.value.counts) return { status: 'error', error: '每日消息统计没有返回日期数据' }
  return { status: 'ready', value: settled.value.counts }
}

/**
 * Loads the combined session/date aggregate first. The legacy date-count API is
 * used only when an older native layer does not expose the integrated field.
 * Call createRelationshipAchievementsLoadingState before awaiting this function
 * when the UI needs an immediate skeleton state.
 */
export const loadRelationshipAchievements = async (
  target: RelationshipAchievementTarget,
  options: LoadRelationshipAchievementsOptions = {}
): Promise<RelationshipAchievementCollection> => {
  const normalizedSessionId = String(target.sessionId || '').trim()
  const ineligibilityReason = getPrivateFriendSessionIneligibilityReason({
    ...target,
    sessionId: normalizedSessionId
  })
  if (ineligibilityReason) {
    return createRelationshipAchievementsErrorState(normalizedSessionId, ineligibilityReason)
  }

  const api = options.api || getDefaultChatApi()
  if (!api) {
    return createRelationshipAchievementsErrorState(normalizedSessionId, '当前环境无法访问聊天统计接口')
  }

  const requestStats = (forceRefresh: boolean, allowStaleCache: boolean) =>
    api.getExportSessionStats([normalizedSessionId], {
      includeRelations: true,
      allowStaleCache,
      forceRefresh,
      preferAccurateSpecialTypes: options.preferAccurateSpecialTypes === true,
      includeMessageDateCounts: true
    })

  const [initialStatsSettled] = await Promise.allSettled([
    requestStats(options.forceRefresh === true, options.forceRefresh === true
      ? false
      : options.allowStaleCache ?? true)
  ])

  const initialStatsResponse = initialStatsSettled.status === 'fulfilled'
    ? initialStatsSettled.value
    : undefined
  const initialStats = initialStatsResponse?.data?.[normalizedSessionId]
  const initialCache = initialStatsResponse?.cache?.[normalizedSessionId]
  const initialNeedsRefresh = initialStatsResponse?.needsRefresh?.includes(normalizedSessionId) ?? false
  const shouldAutoRefresh = options.forceRefresh !== true &&
    initialStatsResponse?.success === true &&
    (!initialStats || initialNeedsRefresh || initialCache?.stale === true)

  let statsSettled: PromiseSettledResult<ExportSessionStatsResponse> = initialStatsSettled
  let autoRefreshSatisfied = false
  if (shouldAutoRefresh) {
    const [refreshedStatsSettled] = await Promise.allSettled([requestStats(true, false)])
    const refreshedStats = refreshedStatsSettled.status === 'fulfilled' && refreshedStatsSettled.value.success
      ? refreshedStatsSettled.value.data?.[normalizedSessionId]
      : undefined

    if (refreshedStats) {
      statsSettled = refreshedStatsSettled
      autoRefreshSatisfied = true
    } else if (!initialStats) {
      // No usable fallback exists; surface the refresh failure instead of the cache miss.
      statsSettled = refreshedStatsSettled
    }
  }

  const sessionStats = statsStateFromResult(normalizedSessionId, statsSettled)
  const integratedStats = statsSettled.status === 'fulfilled'
    ? statsSettled.value.data?.[normalizedSessionId]
    : undefined
  let datesSettled: PromiseSettledResult<MessageDateCountsResponse>
  if (integratedStats && integratedStats.messageDateCounts !== undefined) {
    datesSettled = {
      status: 'fulfilled',
      value: {
        success: true,
        counts: normalizeMessageDateCounts(integratedStats.messageDateCounts)
      }
    }
  } else if (api.getMessageDateCounts) {
    // 仅兼容旧版 DLL/预加载层；新版数据已由上面的同一次统计查询返回。
    const [legacyDatesSettled] = await Promise.allSettled([
      api.getMessageDateCounts(normalizedSessionId)
    ])
    datesSettled = legacyDatesSettled
  } else {
    datesSettled = {
      status: 'fulfilled',
      value: { success: false, error: '当前版本没有返回每日消息统计' }
    }
  }
  const messageDateCounts = dateCountsStateFromResult(datesSettled)
  const statsResponse = statsSettled.status === 'fulfilled' ? statsSettled.value : undefined
  const cache = statsResponse?.cache?.[normalizedSessionId]

  return evaluateRelationshipAchievements(normalizedSessionId, {
    sessionStats,
    messageDateCounts
  }, {
    evaluatedAt: Date.now(),
    dataQuality: {
      statsUpdatedAt: cache?.updatedAt,
      statsStale: cache?.stale,
      statsNeedsRefresh: (statsResponse?.needsRefresh?.includes(normalizedSessionId) ?? false) ||
        (shouldAutoRefresh && !autoRefreshSatisfied)
    }
  })
}
