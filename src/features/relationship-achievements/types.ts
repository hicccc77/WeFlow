export type RelationshipAchievementStatus = 'loading' | 'error' | 'locked' | 'unlocked'

export type RelationshipAchievementCollectionStatus = 'loading' | 'error' | 'ready'

export type RelationshipAchievementCategory =
  | 'beginning'
  | 'conversation'
  | 'presence'
  | 'continuity'
  | 'keepsake'
  | 'connection'
  | 'time'

export type RelationshipAchievementMetric =
  | 'firstMessage'
  | 'totalMessages'
  | 'activeDays'
  | 'longestStreakDays'
  | 'imageMessages'
  | 'voiceMessages'
  | 'videoMessages'
  | 'emojiMessages'
  | 'fileMessages'
  | 'callMessages'
  | 'privateMutualGroups'
  | 'conversationSpanDays'
  | 'activeYears'

export type RelationshipAchievementDataSource = 'sessionStats' | 'messageDateCounts'

export type RelationshipAchievementBadgePalette =
  | 'dawn'
  | 'apricot'
  | 'coral'
  | 'rose'
  | 'berry'
  | 'butter'
  | 'tangerine'
  | 'amber'
  | 'amber-sky'
  | 'mint'
  | 'jade'
  | 'jade-indigo'
  | 'sky'
  | 'periwinkle'
  | 'lavender'
  | 'lemon-rose'
  | 'slate-blue'
  | 'deep-cyan'
  | 'soft-violet'
  | 'blue-violet'
  | 'amber-navy'
  | 'winter-blue-peach'
  | 'forest-gold'
  | 'twilight-navy-gold'

export interface RelationshipAchievementBadge {
  /** Stable semantic token. The renderer owns the SVG implementation. */
  motif: string
  /** Stable palette token. It deliberately does not imply rarity or rank. */
  palette: RelationshipAchievementBadgePalette
  /** Short text that may be engraved into compact/fallback badge renderers. */
  engraving: string
}

export interface RelationshipAchievementDefinition {
  id: string
  category: RelationshipAchievementCategory
  metric: RelationshipAchievementMetric
  source: RelationshipAchievementDataSource
  threshold: number
  title: string
  goalCopy: string
  unlockedCopy: string
  lockedCopy: string
  badge: RelationshipAchievementBadge
}

export interface ExportSessionAchievementStats {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  fileMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
  messageDateCounts?: Record<string, number>
  firstTimestamp?: number
  lastTimestamp?: number
  privateMutualGroups?: number
}

export interface MessageDateCountsSummary {
  activeDayCount: number
  activeYears: number[]
  firstActiveDate?: string
  lastActiveDate?: string
  longestStreakDays: number
  longestStreakStartDate?: string
  longestStreakEndDate?: string
}

export type AchievementDataState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; value: T }

export interface RelationshipAchievementSources {
  sessionStats: AchievementDataState<ExportSessionAchievementStats>
  messageDateCounts: AchievementDataState<Record<string, number>>
}

export interface RelationshipAchievementEvidence {
  current: number
  threshold: number
  /** Clamped to 0..1. It is progress toward this independent achievement, never a badge level. */
  progress: number
  currentLabel: string
  conditionLabel: string
  basis: string
  firstDate?: string
  lastDate?: string
  yearSummary?: string
}

export interface RelationshipAchievementItem {
  definition: RelationshipAchievementDefinition
  status: RelationshipAchievementStatus
  copy: string
  evidence?: RelationshipAchievementEvidence
  error?: string
}

export interface RelationshipAchievementSummary {
  total: number
  loading: number
  error: number
  locked: number
  unlocked: number
}

export interface RelationshipAchievementCollection {
  /** Only eligible one-to-one friend session IDs can reach the loader. */
  scope: 'private-friend'
  sessionId: string
  status: RelationshipAchievementCollectionStatus
  achievements: RelationshipAchievementItem[]
  summary: RelationshipAchievementSummary
  evaluatedAt?: number
  errors: string[]
  dataQuality?: {
    statsUpdatedAt?: number
    statsStale?: boolean
    statsNeedsRefresh?: boolean
  }
}

export interface RelationshipAchievementTarget {
  sessionId: string
  /** Optional current account ID; when supplied, a self-chat is rejected. */
  selfAccountId?: string
}

export interface ExportSessionStatsResponse {
  success: boolean
  data?: Record<string, ExportSessionAchievementStats>
  cache?: Record<string, {
    updatedAt: number
    stale: boolean
    includeRelations: boolean
    source: 'memory' | 'disk' | 'fresh'
    rangeFiltered?: boolean
  }>
  needsRefresh?: string[]
  error?: string
}

export interface MessageDateCountsResponse {
  success: boolean
  counts?: Record<string, number>
  error?: string
}

export interface RelationshipJourneyMessage {
  localId: number
  localType: number
  createTime: number
  isSend: number | null
  /** Main-process visibility guard; false rows count toward raw totals but never semantic moments. */
  isVisibleForJourney?: boolean
  parsedContent?: string
  rawContent?: string
  content?: string
  xmlType?: string
  appMsgKind?: string
  voiceDurationSeconds?: number
}

export interface RelationshipJourneyMessagesResponse {
  success: boolean
  messages?: RelationshipJourneyMessage[]
  hasMore?: boolean
  nextOffset?: number
  error?: string
}

export interface RelationshipJourneyAnalysisResponse {
  success: boolean
  data?: unknown
  error?: string
}

/** Renderer-facing subset of window.electronAPI.chat used by this feature. */
export interface RelationshipAchievementChatApi {
  getExportSessionStats: (
    sessionIds: string[],
    options?: {
      includeRelations?: boolean
      forceRefresh?: boolean
      allowStaleCache?: boolean
      preferAccurateSpecialTypes?: boolean
      cacheOnly?: boolean
      beginTimestamp?: number
      endTimestamp?: number
      includeMessageDateCounts?: boolean
    }
  ) => Promise<ExportSessionStatsResponse>
  getMessageDateCounts?: (sessionId: string) => Promise<MessageDateCountsResponse>
  getMessages?: (
    sessionId: string,
    offset?: number,
    limit?: number,
    startTime?: number,
    endTime?: number,
    ascending?: boolean
  ) => Promise<RelationshipJourneyMessagesResponse>
  getRelationshipJourneyMoments?: (
    sessionId: string,
    maxMessages?: number,
    forceRefresh?: boolean
  ) => Promise<RelationshipJourneyAnalysisResponse>
  cancelRelationshipJourneyMoments?: (sessionId: string) => Promise<{
    success: boolean
    cancelled?: number
    error?: string
  }>
}

export interface LoadRelationshipAchievementsOptions {
  api?: RelationshipAchievementChatApi
  allowStaleCache?: boolean
  forceRefresh?: boolean
  preferAccurateSpecialTypes?: boolean
}
