import { RELATIONSHIP_ACHIEVEMENT_CATALOG } from './catalog'
import type {
  ExportSessionAchievementStats,
  MessageDateCountsSummary,
  RelationshipAchievementCollection,
  RelationshipAchievementDefinition,
  RelationshipAchievementEvidence,
  RelationshipAchievementItem,
  RelationshipAchievementSources,
  RelationshipAchievementSummary
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const LOADING_COPY = '正在翻阅本地留下的这段对话…'
const ERROR_COPY = '暂时无法核对这枚回忆的解锁依据。'

interface EvaluationMeta {
  evaluatedAt?: number
  dataQuality?: RelationshipAchievementCollection['dataQuality']
}

interface MetricContext {
  stats?: ExportSessionAchievementStats
  dates?: MessageDateCountsSummary
}

type MetricResult =
  | { value: number }
  | { error: string }

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })

export const formatAchievementNumber = (value: number): string =>
  numberFormatter.format(Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)))

const parseDateKey = (rawDate: string): { normalized: string; epochDay: number; year: number } | null => {
  const match = String(rawDate || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(timestamp)
  if (
    !Number.isFinite(timestamp) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }

  const normalized = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { normalized, epochDay: Math.floor(timestamp / DAY_MS), year }
}

export const formatAchievementDateKey = (dateKey?: string): string => {
  if (!dateKey) return ''
  const parsed = parseDateKey(dateKey)
  if (!parsed) return dateKey
  const [year, month, day] = parsed.normalized.split('-').map(Number)
  return `${year}年${month}月${day}日`
}

const normalizeTimestampSeconds = (value: unknown): number => {
  let normalized = Math.floor(Number(value || 0))
  if (!Number.isFinite(normalized) || normalized <= 0) return 0
  while (normalized > 10_000_000_000) normalized = Math.floor(normalized / 1_000)
  return normalized
}

export const formatAchievementTimestamp = (timestamp?: number): string => {
  const seconds = normalizeTimestampSeconds(timestamp)
  if (!seconds) return ''
  const date = new Date(seconds * 1_000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

const timestampCalendarDay = (timestamp?: number): number | null => {
  const seconds = normalizeTimestampSeconds(timestamp)
  if (!seconds) return null
  const date = new Date(seconds * 1_000)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/** Ignores malformed dates and non-positive counts before deriving calendar metrics. */
export const summarizeMessageDateCounts = (
  counts: Record<string, number>
): MessageDateCountsSummary => {
  const uniqueDates = new Map<string, { epochDay: number; year: number }>()

  Object.entries(counts || {}).forEach(([rawDate, rawCount]) => {
    const count = Number(rawCount)
    if (!Number.isFinite(count) || count <= 0) return
    const parsed = parseDateKey(rawDate)
    if (!parsed) return
    uniqueDates.set(parsed.normalized, { epochDay: parsed.epochDay, year: parsed.year })
  })

  const dates = Array.from(uniqueDates.entries())
    .map(([date, value]) => ({ date, ...value }))
    .sort((left, right) => left.epochDay - right.epochDay)

  let longestStreakDays = 0
  let longestStreakStartDate: string | undefined
  let longestStreakEndDate: string | undefined
  let currentStartIndex = 0

  dates.forEach((entry, index) => {
    if (index === 0 || entry.epochDay !== dates[index - 1].epochDay + 1) {
      currentStartIndex = index
    }
    const currentLength = index - currentStartIndex + 1
    if (currentLength > longestStreakDays) {
      longestStreakDays = currentLength
      longestStreakStartDate = dates[currentStartIndex].date
      longestStreakEndDate = entry.date
    }
  })

  return {
    activeDayCount: dates.length,
    activeYears: Array.from(new Set(dates.map((entry) => entry.year))).sort((a, b) => a - b),
    firstActiveDate: dates[0]?.date,
    lastActiveDate: dates[dates.length - 1]?.date,
    longestStreakDays,
    longestStreakStartDate,
    longestStreakEndDate
  }
}

const getConversationSpanDays = (stats: ExportSessionAchievementStats): MetricResult => {
  if (stats.totalMessages <= 0) return { value: 0 }
  const firstDay = timestampCalendarDay(stats.firstTimestamp)
  const lastDay = timestampCalendarDay(stats.lastTimestamp)
  if (firstDay === null || lastDay === null) {
    return { error: '消息统计缺少可识别的首末时间' }
  }
  if (lastDay < firstDay) return { error: '消息统计中的首末时间顺序无效' }
  return { value: lastDay - firstDay }
}

const readMetric = (
  definition: RelationshipAchievementDefinition,
  context: MetricContext
): MetricResult => {
  const { stats, dates } = context

  switch (definition.metric) {
    case 'firstMessage': {
      if (!stats) return { error: '缺少会话统计' }
      if (normalizeTimestampSeconds(stats.firstTimestamp) > 0) return { value: 1 }
      return stats.totalMessages > 0
        ? { error: '消息统计缺少可识别的最早时间' }
        : { value: 0 }
    }
    case 'totalMessages':
      return stats ? { value: stats.totalMessages } : { error: '缺少会话统计' }
    case 'imageMessages':
      return stats ? { value: stats.imageMessages } : { error: '缺少会话统计' }
    case 'voiceMessages':
      return stats ? { value: stats.voiceMessages } : { error: '缺少会话统计' }
    case 'videoMessages':
      return stats ? { value: stats.videoMessages } : { error: '缺少会话统计' }
    case 'emojiMessages':
      return stats ? { value: stats.emojiMessages } : { error: '缺少会话统计' }
    case 'fileMessages':
      return stats ? { value: stats.fileMessages } : { error: '缺少会话统计' }
    case 'callMessages':
      return stats ? { value: stats.callMessages } : { error: '缺少会话统计' }
    case 'privateMutualGroups':
      if (!stats) return { error: '缺少会话统计' }
      return Number.isFinite(stats.privateMutualGroups)
        ? { value: Math.max(0, Number(stats.privateMutualGroups)) }
        : { error: '共同群聊统计尚未完成' }
    case 'conversationSpanDays':
      return stats ? getConversationSpanDays(stats) : { error: '缺少会话统计' }
    case 'activeDays':
      return dates ? { value: dates.activeDayCount } : { error: '缺少每日消息统计' }
    case 'longestStreakDays':
      return dates ? { value: dates.longestStreakDays } : { error: '缺少每日消息统计' }
    case 'activeYears':
      return dates ? { value: dates.activeYears.length } : { error: '缺少每日消息统计' }
  }
}

const formatEvidence = (
  definition: RelationshipAchievementDefinition,
  value: number,
  context: MetricContext
): RelationshipAchievementEvidence => {
  const current = Math.max(0, Math.floor(value))
  const threshold = Math.max(1, Math.floor(definition.threshold))
  const progress = Math.max(0, Math.min(1, current / threshold))
  const count = formatAchievementNumber(current)
  const target = formatAchievementNumber(threshold)
  const base = { current, threshold, progress }

  switch (definition.metric) {
    case 'firstMessage': {
      const firstDate = formatAchievementTimestamp(context.stats?.firstTimestamp)
      return {
        ...base,
        currentLabel: firstDate ? `最早记录：${firstDate}` : '尚未找到可识别的最早消息',
        conditionLabel: '存在可识别的最早一条私聊消息',
        basis: firstDate
          ? `当前本地记录中，最早一条消息留在 ${firstDate}`
          : '当前本地记录中尚未找到可识别的最早一条消息',
        firstDate: firstDate || undefined
      }
    }
    case 'totalMessages':
      return {
        ...base,
        currentLabel: `${count} 条私聊消息`,
        conditionLabel: `达到 ${target} 条`,
        basis: `当前本地保留 ${count} 条私聊消息；解锁条件为 ${target} 条`
      }
    case 'activeDays':
      return {
        ...base,
        currentLabel: `${count} 个有消息的自然日`,
        conditionLabel: `达到 ${target} 日`,
        basis: `共有 ${count} 个自然日留下过消息；解锁条件为 ${target} 日`
      }
    case 'longestStreakDays': {
      const start = formatAchievementDateKey(context.dates?.longestStreakStartDate)
      const end = formatAchievementDateKey(context.dates?.longestStreakEndDate)
      const range = start && end ? `（${start}—${end}）` : ''
      return {
        ...base,
        currentLabel: `最长连续 ${count} 日`,
        conditionLabel: `达到连续 ${target} 日`,
        basis: `最长连续 ${count} 个自然日有记录${range}；解锁条件为 ${target} 日`,
        firstDate: start || undefined,
        lastDate: end || undefined
      }
    }
    case 'imageMessages':
      return {
        ...base,
        currentLabel: `${count} 张图片`,
        conditionLabel: `达到 ${target} 张`,
        basis: `本地保留记录中，共有 ${count} 张图片；解锁条件为 ${target} 张`
      }
    case 'voiceMessages':
      return {
        ...base,
        currentLabel: `${count} 条语音`,
        conditionLabel: `达到 ${target} 条`,
        basis: `本地保留记录中，共有 ${count} 条语音；解锁条件为 ${target} 条`
      }
    case 'videoMessages':
      return {
        ...base,
        currentLabel: `${count} 条视频`,
        conditionLabel: `达到 ${target} 条`,
        basis: `本地保留记录中，共有 ${count} 条视频；解锁条件为 ${target} 条`
      }
    case 'emojiMessages':
      return {
        ...base,
        currentLabel: `${count} 个表情`,
        conditionLabel: `达到 ${target} 个`,
        basis: `本地保留记录中，共有 ${count} 个表情；解锁条件为 ${target} 个`
      }
    case 'fileMessages':
      return {
        ...base,
        currentLabel: `${count} 个文件`,
        conditionLabel: `达到 ${target} 个`,
        basis: `本地保留记录中，共有 ${count} 个文件；解锁条件为 ${target} 个`
      }
    case 'callMessages':
      return {
        ...base,
        currentLabel: `${count} 次通话记录`,
        conditionLabel: `达到 ${target} 次`,
        basis: `本地保留记录中，共有 ${count} 次语音或视频通话记录；解锁条件为 ${target} 次`
      }
    case 'privateMutualGroups':
      return {
        ...base,
        currentLabel: `${count} 个双方共同群聊`,
        conditionLabel: `达到 ${target} 个`,
        basis: `当前识别到 ${count} 个双方共同群聊；解锁条件为 ${target} 个`
      }
    case 'conversationSpanDays': {
      const firstDate = formatAchievementTimestamp(context.stats?.firstTimestamp)
      const lastDate = formatAchievementTimestamp(context.stats?.lastTimestamp)
      return {
        ...base,
        currentLabel: `首末记录相隔 ${count} 个自然日`,
        conditionLabel: `达到 ${target} 日`,
        basis: firstDate && lastDate
          ? `从 ${firstDate} 到 ${lastDate}，相隔 ${count} 个自然日；解锁条件为 ${target} 日`
          : `首末记录相隔 ${count} 个自然日；解锁条件为 ${target} 日`,
        firstDate: firstDate || undefined,
        lastDate: lastDate || undefined
      }
    }
    case 'activeYears': {
      const years = context.dates?.activeYears || []
      const yearSummary = years.join('、')
      return {
        ...base,
        currentLabel: `${count} 个有消息的自然年`,
        conditionLabel: `达到 ${target} 个不同自然年`,
        basis: yearSummary
          ? `有消息的年份共 ${count} 个：${yearSummary}；解锁条件为 ${target} 个不同自然年`
          : `当前没有可识别的有消息年份；解锁条件为 ${target} 个不同自然年`,
        yearSummary: yearSummary || undefined
      }
    }
  }
}

const sourceError = (
  definition: RelationshipAchievementDefinition,
  sources: RelationshipAchievementSources
): string | null => {
  const source = sources[definition.source]
  return source.status === 'error' ? source.error : null
}

const evaluateItem = (
  definition: RelationshipAchievementDefinition,
  sources: RelationshipAchievementSources,
  context: MetricContext
): RelationshipAchievementItem => {
  const source = sources[definition.source]
  if (source.status === 'loading') {
    return { definition, status: 'loading', copy: LOADING_COPY }
  }

  const error = sourceError(definition, sources)
  if (error) {
    return { definition, status: 'error', copy: ERROR_COPY, error }
  }

  const metric = readMetric(definition, context)
  if ('error' in metric) {
    return { definition, status: 'error', copy: ERROR_COPY, error: metric.error }
  }

  const status = metric.value >= definition.threshold ? 'unlocked' : 'locked'
  return {
    definition,
    status,
    copy: status === 'unlocked' ? definition.unlockedCopy : definition.lockedCopy,
    evidence: formatEvidence(definition, metric.value, context)
  }
}

const summarizeItems = (items: RelationshipAchievementItem[]): RelationshipAchievementSummary => ({
  total: items.length,
  loading: items.filter((item) => item.status === 'loading').length,
  error: items.filter((item) => item.status === 'error').length,
  locked: items.filter((item) => item.status === 'locked').length,
  unlocked: items.filter((item) => item.status === 'unlocked').length
})

export const evaluateRelationshipAchievements = (
  sessionId: string,
  sources: RelationshipAchievementSources,
  meta: EvaluationMeta = {}
): RelationshipAchievementCollection => {
  const stats = sources.sessionStats.status === 'ready' ? sources.sessionStats.value : undefined
  const dates = sources.messageDateCounts.status === 'ready'
    ? summarizeMessageDateCounts(sources.messageDateCounts.value)
    : undefined
  const context = { stats, dates }
  const achievements = RELATIONSHIP_ACHIEVEMENT_CATALOG.map((definition) =>
    evaluateItem(definition, sources, context)
  )
  const summary = summarizeItems(achievements)
  const errors = Array.from(new Set(achievements.flatMap((item) => item.error ? [item.error] : [])))
  const status = summary.loading > 0 ? 'loading' : summary.error > 0 ? 'error' : 'ready'

  return {
    scope: 'private-friend',
    sessionId,
    status,
    achievements,
    summary,
    evaluatedAt: meta.evaluatedAt,
    errors,
    dataQuality: meta.dataQuality
  }
}

export const createRelationshipAchievementsLoadingState = (
  sessionId: string
): RelationshipAchievementCollection => evaluateRelationshipAchievements(sessionId, {
  sessionStats: { status: 'loading' },
  messageDateCounts: { status: 'loading' }
})

export const createRelationshipAchievementsErrorState = (
  sessionId: string,
  error: string
): RelationshipAchievementCollection => evaluateRelationshipAchievements(sessionId, {
  sessionStats: { status: 'error', error },
  messageDateCounts: { status: 'error', error }
}, { evaluatedAt: Date.now() })

/** A renderer-ready factual basis line; returns an empty string while loading. */
export const formatRelationshipAchievementEvidence = (
  item: RelationshipAchievementItem
): string => {
  if (item.evidence) return item.evidence.basis
  if (item.status === 'error') return item.error || '暂时无法读取解锁依据'
  return ''
}
