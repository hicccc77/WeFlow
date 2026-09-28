import { createHash } from 'crypto'
import { tag as tagJieba } from 'jieba-wasm/node'

export const AGENT_RAW_PAGE_FORMAT_VERSION = 1
export const AGENT_RAW_PAGE_MIN_TOKENS = 800
export const AGENT_RAW_PAGE_DEFAULT_TOKENS = 10_000
export const AGENT_RAW_PAGE_MAX_TOKENS = 16_000
export const AGENT_TIMELINE_WINDOW_DEFAULT_TOKENS = 1_200
export const AGENT_TIMELINE_WINDOW_MAX_TOKENS = 3_000

export type AgentRawPageDirection = 'forward' | 'backward'

export type AgentTimelineSampleSelectionMode = 'uniform' | 'mixed'

export type AgentManifestStructuralSession = {
  sessionId: string
  displayName?: string
  messageCount?: number
  activeDayCount?: number
  activeMonthCount?: number
  spanMonthCount?: number
  firstAt?: string
  lastAt?: string
}

export type AgentUnreadManifestStructuralAnchor = AgentManifestStructuralSession & {
  structuralDimensions: Array<'message_count' | 'active_months' | 'time_span' | 'recent_activity'>
  bestStructuralRank: number
}

function normalizedManifestSourceKey(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().toLocaleLowerCase()
}

/**
 * 返回确定性的导航盲区，而不是语义候选项。
 * 每个维度都会在完整的输入目录上排序，随后只保留接近结构极值的未读行。
 */
export function selectAgentUnreadManifestStructuralAnchors(
  sessions: readonly AgentManifestStructuralSession[],
  readSourceKeys: Iterable<string>,
  limit = 6,
): AgentUnreadManifestStructuralAnchor[] {
  const seenIds = new Set<string>()
  const rows = sessions.filter((session) => {
    const sessionId = normalizedManifestSourceKey(session.sessionId)
    if (!sessionId || seenIds.has(sessionId)) return false
    seenIds.add(sessionId)
    return true
  })
  if (rows.length === 0 || limit <= 0) return []

  const readKeys = new Set(Array.from(readSourceKeys, normalizedManifestSourceKey).filter(Boolean))
  const isRead = (session: AgentManifestStructuralSession) => (
    readKeys.has(normalizedManifestSourceKey(session.sessionId))
    || readKeys.has(normalizedManifestSourceKey(session.displayName))
  )
  const structuralWindow = Math.min(16, Math.max(8, Math.ceil(rows.length * 0.12)))
  const dimensions: Array<{
    name: AgentUnreadManifestStructuralAnchor['structuralDimensions'][number]
    value: (session: AgentManifestStructuralSession) => number
  }> = [
    { name: 'message_count', value: (session) => Math.max(0, Number(session.messageCount) || 0) },
    { name: 'active_months', value: (session) => Math.max(0, Number(session.activeMonthCount) || 0) },
    { name: 'time_span', value: (session) => Math.max(0, Number(session.spanMonthCount) || 0) },
    {
      name: 'recent_activity',
      value: (session) => {
        const timestamp = Date.parse(String(session.lastAt || '').replace(' ', 'T'))
        return Number.isFinite(timestamp) ? timestamp : 0
      },
    },
  ]
  const candidates = new Map<string, {
    session: AgentManifestStructuralSession
    ranks: Map<AgentUnreadManifestStructuralAnchor['structuralDimensions'][number], number>
  }>()

  for (const dimension of dimensions) {
    const ranked = [...rows]
      .filter((session) => dimension.value(session) > 0)
      .sort((left, right) => (
        dimension.value(right) - dimension.value(left)
        || normalizedManifestSourceKey(left.sessionId).localeCompare(normalizedManifestSourceKey(right.sessionId))
      ))
    ranked.slice(0, structuralWindow).forEach((session, index) => {
      if (isRead(session)) return
      const key = normalizedManifestSourceKey(session.sessionId)
      const candidate = candidates.get(key) || { session, ranks: new Map() }
      candidate.ranks.set(dimension.name, index + 1)
      candidates.set(key, candidate)
    })
  }

  return Array.from(candidates.values())
    .sort((left, right) => {
      const leftBestRank = Math.min(...left.ranks.values())
      const rightBestRank = Math.min(...right.ranks.values())
      const leftScore = Array.from(left.ranks.values()).reduce((sum, rank) => sum + (structuralWindow - rank + 1), 0)
      const rightScore = Array.from(right.ranks.values()).reduce((sum, rank) => sum + (structuralWindow - rank + 1), 0)
      return right.ranks.size - left.ranks.size
        || rightScore - leftScore
        || leftBestRank - rightBestRank
        || normalizedManifestSourceKey(left.session.sessionId).localeCompare(normalizedManifestSourceKey(right.session.sessionId))
    })
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(({ session, ranks }) => ({
      ...session,
      structuralDimensions: dimensions
        .map((dimension) => dimension.name)
        .filter((dimension) => ranks.has(dimension)),
      bestStructuralRank: Math.min(...ranks.values()),
    }))
}

export type AgentTimelineSampleDate = {
  date: string
  count: number
  reason: 'range-start' | 'range-end' | 'time-quantile' | 'segment-activity-peak' | 'activity-change-before' | 'activity-change-after' | 'trailing-change-before' | 'trailing-change-after'
}

export type AgentTimelineSamplePosition = AgentTimelineSampleDate & {
  position: 'start' | 'middle' | 'end'
  offset: number
}

export type AgentTimelineCoverageMonth = {
  month: string
  messageCount: number
  activeDays: number
  firstActiveDate: string
  lastActiveDate: string
  representativeDates: string[]
  rawPageCoverage: 'touched' | 'untouched'
}

export type AgentTimelineCoverageSpan = {
  startMonth: string
  endMonth: string
  monthCount: number
  messageCount: number
  activeDays: number
  firstActiveDate: string
  representativeDate: string
  lastActiveDate: string
}

export type AgentRawPageCursor = {
  version: 1
  sessionId: string
  startTime: number
  endTime: number
  direction: AgentRawPageDirection
  offset: number
}

export type AgentRawMessageRecord = {
  sessionId: string
  displayName: string
  localId: number
  messageKey?: string
  createTime: number
  sortSeq: number
  sender: string
  messageType: string
  content: string
  quotedSender?: string
  quotedContent?: string
  voiceRef?: string
  imageRef?: string
  /** false 表示消息存在，但原始记录没有 md5/datName，不能读取真实图片像素。 */
  imageLocatable?: boolean
}

export type AgentRawPageSelection = {
  records: AgentRawMessageRecord[]
  consumed: number
  estimatedTokens: number
}

export type AgentDistinctiveConversationSegment = {
  records: AgentRawMessageRecord[]
  score: number
  date: string
  alternations: number
  longTextCount: number
  authoredLongTextCount?: number
  authoredTextRatio?: number
  authoredLongTextBalance?: number
  quotedMessageCount: number
  messageTypeCount: number
  lexicalTerms?: string[]
}

export type AgentAnchoredConversationSegment = {
  records: AgentRawMessageRecord[]
  sourceWindowMessageCount: number
  segmentCount: number
  anchorSegmentIndex: number
  omittedBeforeMessageCount: number
  omittedAfterMessageCount: number
  largestWindowGapSeconds: number
  largestReturnedGapSeconds: number
  gapBeforeSeconds?: number
  gapAfterSeconds?: number
  touchesWindowStart: boolean
  touchesWindowEnd: boolean
}

export type AgentLexicalAnchorCandidate = {
  term: string
  messageCount: number
  totalMessageCount: number
  monthCount: number
  dates: Array<{ date: string; count: number }>
  navigationKinds?: AgentLexicalNavigationKind[]
}

export type AgentLexicalNavigationKind = 'location' | 'named-entity' | 'temporal'

export type AgentLexicalAnchor = {
  term: string
  messageCount: number
  dates: string[]
  navigationKinds?: AgentLexicalNavigationKind[]
  navigationScore?: number
}

export type AgentSemanticMonthNavigation = {
  messageCount: number
  lexicalAnchors?: AgentLexicalAnchor[]
}

export type AgentRawRangeBatchPage = {
  requestIndex: number
  success: boolean
  pageId?: unknown
  pageHash?: unknown
  conversation?: unknown
  range?: unknown
  requestedRange?: unknown
  coverageStatus?: unknown
  messageCount?: unknown
  estimatedTokens?: unknown
  cacheHit?: unknown
  pageText?: unknown
  mediaRefs?: unknown
  nextCursor?: unknown
  hasMore?: unknown
  noNewRangeRead?: unknown
  pages?: unknown[]
  error?: string
}

export function resolveAgentTimelineWindowCount(
  requestedWindowsValue: unknown,
  activeDateCountValue: unknown,
  activeMonthCountValue: unknown,
): number {
  const activeDateCount = Math.max(0, Math.floor(Number(activeDateCountValue) || 0))
  if (activeDateCount === 0) return 0
  const activeMonthCount = Math.max(0, Math.floor(Number(activeMonthCountValue) || 0))
  const requestedWindows = Math.max(2, Math.min(24, Math.floor(Number(requestedWindowsValue) || 8)))
  const rangeFloor = activeMonthCount >= 30
    ? 24
    : activeMonthCount >= 24
      ? 20
      : activeMonthCount >= 18
        ? 18
        : activeMonthCount >= 12
          ? 14
          : activeMonthCount >= 6
            ? 10
            : 2
  return Math.min(activeDateCount, Math.max(requestedWindows, rangeFloor))
}

export function resolveAgentTimelineDistinctDateCount(
  totalWindowCountValue: unknown,
  preserveRequestedWindows = false,
): number {
  const totalWindowCount = Math.max(2, Math.min(24, Math.floor(Number(totalWindowCountValue) || 8)))
  return preserveRequestedWindows
    ? totalWindowCount
    : Math.max(2, Math.ceil(totalWindowCount * 0.82))
}

function safeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

export function compactAgentTimelineWorkspacePage(
  value: unknown,
  options: { pageText?: unknown; note?: unknown } = {},
): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const pageText = safeText(options.pageText === undefined ? record.pageText : options.pageText)
  const note = safeText(options.note)
  const lexicalAnchors = Array.isArray(record.lexicalAnchors)
    ? record.lexicalAnchors.slice(0, 12).map((anchor) => {
        const item = anchor && typeof anchor === 'object' && !Array.isArray(anchor)
          ? anchor as Record<string, unknown>
          : {}
        return {
          term: safeText(item.term),
          messageCount: Math.max(0, Math.floor(Number(item.messageCount) || 0)),
          dates: Array.isArray(item.dates) ? item.dates.map(safeText).filter(Boolean).slice(0, 4) : [],
        }
      }).filter((anchor) => anchor.term)
    : []
  return {
    success: record.success,
    pageId: record.pageId,
    pageHash: record.pageHash,
    conversation: record.conversation,
    range: record.range,
    scanMonth: record.scanMonth,
    structuralDates: Array.isArray(record.scanAnchorDates)
      ? record.scanAnchorDates.map(safeText).filter(Boolean).slice(0, 8)
      : undefined,
    lexicalAnchors: lexicalAnchors.length > 0 ? lexicalAnchors : undefined,
    pageText: pageText || undefined,
    error: record.error,
    note: note || undefined,
  }
}

const AGENT_LEXICAL_NAVIGATION_STOP_TERMS = new Set([
  '一个', '一些', '一直', '不是', '不会', '不能', '不过', '为什么', '什么', '他们', '你们', '但是',
  '其实', '可以', '因为', '如果', '已经', '应该', '怎么', '感觉', '我们', '所以', '没有', '然后',
  '现在', '真的', '知道', '自己', '这个', '这么', '这里', '还是', '还有', '那个', '那么', '那里',
  '就是', '这样', '觉得', '图片', '动画表情', '文件', '视频', '语音', '表情',
  'attachment', 'attachments', 'cache', 'emojis', 'files', 'images', 'media', 'thumbs', 'voices',
  'html', 'jpeg', 'jpg', 'json', 'png', 'webp', 'wav', 'xml',
  '今天', '明天', '昨天', '前天', '后天', '这周', '本周', '上周', '下周', '今年', '明年', '去年',
  '早上', '上午', '中午', '下午', '晚上', '凌晨', '时候', '时间', '当时', '刚才', '刚刚', '本来',
  '以前', '以后', '过去', '未来', '目前', '平时', '最近', '现在', '正在', '上次', '下次', '这次',
  '今晚', '昨晚', '昨天晚上', '白天', '周末', '周一', '周二', '周三', '周四', '周五', '周六', '周日',
  '上来', '下来', '上去', '下去', '过来', '过去了',
  '东西', '南北', '上下', '左右', '东边', '西边', '南边', '北边',
])

const AGENT_NAMED_ENTITY_TAGS = new Set([
  'nr', 'nr1', 'nr2', 'nrj', 'nrf',
  'nt', 'nz',
])
const AGENT_LOCATION_TAGS = new Set(['ns', 'nsf'])

function normalizeAgentLexicalTerm(value: unknown): string {
  return safeText(value).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
}

function isAgentLexicalNavigationTerm(term: string): boolean {
  const length = Array.from(term).length
  if (length < 2 || length > 20 || AGENT_LEXICAL_NAVIGATION_STOP_TERMS.has(term)) return false
  if (!/^[\p{L}\p{N}]+$/u.test(term) || /^\p{N}+$/u.test(term)) return false
  if (/^(.)\1+$/u.test(term)) return false
  if (/^[a-z0-9]+$/i.test(term) && length < 3) return false
  return true
}

export function extractAgentLexicalTermSignals(value: unknown): Array<{
  term: string
  navigationKinds: AgentLexicalNavigationKind[]
}> {
  const source = safeText(value)
    .slice(0, 800)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>\n]{1,200}>/g, ' ')
    .replace(/\[[^\]\n]{1,40}\]/g, ' ')
    .replace(/\b(?:attachments?|cache|emojis?|files?|images?|media|thumbs?|voices?)[\\/][^\s<>"']*/gi, ' ')
    .replace(/\b[a-z0-9_-]+\.(?:gif|jpe?g|m4a|mov|mp3|mp4|ogg|png|silk|wav|webm|webp)\b/gi, ' ')
  if (!source) return []
  const signals = new Map<string, Set<AgentLexicalNavigationKind>>()
  for (const tagged of tagJieba(source, true)) {
    const term = normalizeAgentLexicalTerm(tagged.word)
    if (!isAgentLexicalNavigationTerm(term)) continue
    const kinds = signals.get(term) || new Set<AgentLexicalNavigationKind>()
    if (AGENT_LOCATION_TAGS.has(tagged.tag)) kinds.add('location')
    else if (AGENT_NAMED_ENTITY_TAGS.has(tagged.tag)) kinds.add('named-entity')
    if (tagged.tag === 't') kinds.add('temporal')
    signals.set(term, kinds)
  }
  return Array.from(signals, ([term, kinds]) => ({
    term,
    navigationKinds: Array.from(kinds),
  }))
}

export function extractAgentLexicalTerms(value: unknown): string[] {
  return extractAgentLexicalTermSignals(value).map((signal) => signal.term)
}

export async function executeAgentRawRangeBatch<TRequest>(
  requests: TRequest[],
  read: (request: TRequest, index: number) => Promise<unknown>,
): Promise<AgentRawRangeBatchPage[]> {
  return Promise.all(requests.map(async (request, requestIndex) => {
    const value = await read(request, requestIndex)
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
    return {
      requestIndex,
      success: record?.success === true,
      pageId: record?.pageId,
      pageHash: record?.pageHash,
      conversation: record?.conversation,
      range: record?.range,
      requestedRange: record?.requestedRange,
      coverageStatus: record?.coverageStatus,
      messageCount: record?.messageCount,
      estimatedTokens: record?.estimatedTokens,
      cacheHit: record?.cacheHit,
      pageText: record?.pageText,
      mediaRefs: record?.mediaRefs,
      nextCursor: record?.nextCursor,
      hasMore: record?.hasMore,
      noNewRangeRead: record?.noNewRangeRead,
      pages: Array.isArray(record?.pages) ? record.pages : undefined,
      error: record?.error ? safeText(record.error).slice(0, 300) : undefined,
    }
  }))
}

export function selectAgentLiteralMatchContexts<T extends {
  sentAt?: unknown
  conversation?: unknown
  messageRef?: unknown
}>(matches: T[], limitValue: number): T[] {
  const limit = Math.max(1, Math.floor(Number(limitValue) || 1))
  const clusters = new Map<string, T[]>()
  matches.forEach((match, index) => {
    const sentAt = safeText(match.sentAt)
    const date = /^\d{4}-\d{2}-\d{2}/.test(sentAt) ? sentAt.slice(0, 10) : `unknown-${index}`
    const key = `${safeText(match.conversation)}\u0001${date}`
    const cluster = clusters.get(key) || []
    cluster.push(match)
    clusters.set(key, cluster)
  })
  const ranked = Array.from(clusters.entries())
    .sort((left, right) => right[1].length - left[1].length || right[0].localeCompare(left[0], 'zh-CN'))
    .map(([key, cluster]) => ({
      key,
      date: key.split('\u0001').at(-1) || '',
      size: cluster.length,
      match: cluster[Math.floor((cluster.length - 1) / 2)],
    }))
    .filter((item) => Boolean(safeText(item.match.messageRef)))
  if (ranked.length <= limit) {
    return ranked
      .sort((left, right) => left.date.localeCompare(right.date) || right.size - left.size)
      .map((item) => item.match)
  }

  const chronological = [...ranked].sort((left, right) => left.date.localeCompare(right.date)
    || right.size - left.size || left.key.localeCompare(right.key, 'zh-CN'))
  const selected = new Map<string, (typeof ranked)[number]>()
  const add = (item: (typeof ranked)[number] | undefined) => {
    if (!item || selected.size >= limit || selected.has(item.key)) return
    selected.set(item.key, item)
  }
  add(ranked[0])
  if (limit >= 2) {
    const strongestDate = ranked[0].date
    const earliestDistance = Math.abs(Date.parse(chronological[0].date) - Date.parse(strongestDate))
    const latestDistance = Math.abs(Date.parse(chronological.at(-1)!.date) - Date.parse(strongestDate))
    add(latestDistance >= earliestDistance ? chronological.at(-1) : chronological[0])
  }
  if (limit >= 3) {
    add(chronological[0])
    add(chronological.at(-1))
  }
  for (let index = 1; selected.size < limit && index < limit * 2; index += 1) {
    add(chronological[Math.round((index * (chronological.length - 1)) / Math.max(1, limit - 1))])
  }
  for (const item of ranked) add(item)
  return Array.from(selected.values())
    .sort((left, right) => left.date.localeCompare(right.date) || right.size - left.size)
    .map((item) => item.match)
}

export function selectAgentDenseConversationSegment(
  recordsValue: AgentRawMessageRecord[],
  gapSecondsValue = 45 * 60,
): AgentRawMessageRecord[] {
  const records = [...recordsValue]
    .filter((record) => Number(record.createTime) > 0)
    .sort((left, right) => left.createTime - right.createTime || left.sortSeq - right.sortSeq || left.localId - right.localId)
  if (records.length <= 1) return records

  const gapSeconds = Math.max(5 * 60, Math.min(6 * 60 * 60, Math.floor(Number(gapSecondsValue) || 45 * 60)))
  const segments: AgentRawMessageRecord[][] = []
  for (const record of records) {
    const current = segments.at(-1)
    if (!current) {
      segments.push([record])
      continue
    }
    const previous = current.at(-1)!
    const previousSeconds = previous.createTime > 10_000_000_000 ? previous.createTime / 1000 : previous.createTime
    const currentSeconds = record.createTime > 10_000_000_000 ? record.createTime / 1000 : record.createTime
    if (currentSeconds - previousSeconds >= gapSeconds) segments.push([record])
    else current.push(record)
  }

  return segments
    .map((segment) => {
      let alternations = 0
      const senders = new Set<string>()
      for (let index = 0; index < segment.length; index += 1) {
        const sender = safeText(segment[index].sender)
        if (sender) senders.add(sender)
        if (index > 0 && sender && sender !== safeText(segment[index - 1].sender)) alternations += 1
      }
      const firstSeconds = segment[0].createTime > 10_000_000_000 ? segment[0].createTime / 1000 : segment[0].createTime
      const lastSeconds = segment.at(-1)!.createTime > 10_000_000_000 ? segment.at(-1)!.createTime / 1000 : segment.at(-1)!.createTime
      const activeMinutes = Math.max(1, (lastSeconds - firstSeconds) / 60)
      const density = Math.min(40, segment.length / activeMinutes)
      const score = segment.length + alternations * 2 + (senders.size >= 2 ? 30 : 0) + density
      return { segment, score, alternations, startAt: segment[0].createTime }
    })
    .sort((left, right) => right.score - left.score
      || right.alternations - left.alternations
      || right.segment.length - left.segment.length
    || left.startAt - right.startAt)[0]?.segment || []
}

/**
 * 只选择包含锚点、且在局部时间上连续的对话。
 * 数据库跳转通常返回固定数量的记录；在稀疏会话中，这些记录可能跨越互不相关的日期
 * 甚至月份。它们适合用于导航，但把整个窗口呈现为一个事件，会让模型误以为自己已经
 * 读到了连贯的开头和结尾。
 *
 * 此函数刻意不引入语义：只按时间间隔切分，并返回最接近请求锚点的片段。
 * 相邻片段仍会保留可供导航的度量信息，但不会混入返回的事件正文。
 */
export function selectAgentAnchoredConversationSegment(
  recordsValue: AgentRawMessageRecord[],
  anchorTimeValue: number,
  gapSecondsValue = 4 * 60 * 60,
): AgentAnchoredConversationSegment {
  const normalizeSeconds = (value: number) => value > 10_000_000_000 ? value / 1_000 : value
  const records = [...recordsValue]
    .filter((record) => Number(record.createTime) > 0)
    .sort((left, right) => left.createTime - right.createTime || left.sortSeq - right.sortSeq || left.localId - right.localId)
  if (records.length === 0) {
    return {
      records: [],
      sourceWindowMessageCount: 0,
      segmentCount: 0,
      anchorSegmentIndex: -1,
      omittedBeforeMessageCount: 0,
      omittedAfterMessageCount: 0,
      largestWindowGapSeconds: 0,
      largestReturnedGapSeconds: 0,
      touchesWindowStart: false,
      touchesWindowEnd: false,
    }
  }

  const gapSeconds = Math.max(5 * 60, Math.min(24 * 60 * 60, Math.floor(Number(gapSecondsValue) || 4 * 60 * 60)))
  const segments: AgentRawMessageRecord[][] = []
  let largestWindowGapSeconds = 0
  for (const record of records) {
    const current = segments.at(-1)
    if (!current) {
      segments.push([record])
      continue
    }
    const previous = current.at(-1)!
    const elapsed = Math.max(0, normalizeSeconds(record.createTime) - normalizeSeconds(previous.createTime))
    largestWindowGapSeconds = Math.max(largestWindowGapSeconds, elapsed)
    if (elapsed > gapSeconds) segments.push([record])
    else current.push(record)
  }

  const anchorSeconds = normalizeSeconds(Number(anchorTimeValue) || records[Math.floor(records.length / 2)].createTime)
  let anchorSegmentIndex = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  segments.forEach((segment, index) => {
    const distance = segment.reduce((minimum, record) => (
      Math.min(minimum, Math.abs(normalizeSeconds(record.createTime) - anchorSeconds))
    ), Number.POSITIVE_INFINITY)
    if (distance < nearestDistance) {
      nearestDistance = distance
      anchorSegmentIndex = index
    }
  })
  const selected = segments[anchorSegmentIndex]
  const beforeSegments = segments.slice(0, anchorSegmentIndex)
  const afterSegments = segments.slice(anchorSegmentIndex + 1)
  let largestReturnedGapSeconds = 0
  for (let index = 1; index < selected.length; index += 1) {
    largestReturnedGapSeconds = Math.max(
      largestReturnedGapSeconds,
      Math.max(0, normalizeSeconds(selected[index].createTime) - normalizeSeconds(selected[index - 1].createTime)),
    )
  }
  const previousRecord = beforeSegments.at(-1)?.at(-1)
  const nextRecord = afterSegments[0]?.[0]
  return {
    records: selected,
    sourceWindowMessageCount: records.length,
    segmentCount: segments.length,
    anchorSegmentIndex,
    omittedBeforeMessageCount: beforeSegments.reduce((sum, segment) => sum + segment.length, 0),
    omittedAfterMessageCount: afterSegments.reduce((sum, segment) => sum + segment.length, 0),
    largestWindowGapSeconds,
    largestReturnedGapSeconds,
    gapBeforeSeconds: previousRecord
      ? Math.max(0, normalizeSeconds(selected[0].createTime) - normalizeSeconds(previousRecord.createTime))
      : undefined,
    gapAfterSeconds: nextRecord
      ? Math.max(0, normalizeSeconds(nextRecord.createTime) - normalizeSeconds(selected.at(-1)!.createTime))
      : undefined,
    touchesWindowStart: anchorSegmentIndex === 0,
    touchesWindowEnd: anchorSegmentIndex === segments.length - 1,
  }
}

/**
 * 按结构独特性对局部连贯的对话簇排序。
 * 这只用于导航：刻意避开关系词汇和语义标签，模型仍须阅读并解释原文。
 */
export function selectAgentDistinctiveConversationSegments(
  recordsValue: AgentRawMessageRecord[],
  limitValue = 2,
  gapSecondsValue = 45 * 60,
): AgentDistinctiveConversationSegment[] {
  const records = [...recordsValue]
    .filter((record) => Number(record.createTime) > 0)
    .sort((left, right) => left.createTime - right.createTime || left.sortSeq - right.sortSeq || left.localId - right.localId)
  if (records.length === 0) return []

  const gapSeconds = Math.max(5 * 60, Math.min(6 * 60 * 60, Math.floor(Number(gapSecondsValue) || 45 * 60)))
  const localDate = (seconds: number) => {
    const date = new Date(seconds * 1000)
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
  }
  const segments: AgentRawMessageRecord[][] = []
  for (const record of records) {
    const current = segments.at(-1)
    if (!current) {
      segments.push([record])
      continue
    }
    const previous = current.at(-1)!
    const previousSeconds = previous.createTime > 10_000_000_000 ? previous.createTime / 1000 : previous.createTime
    const currentSeconds = record.createTime > 10_000_000_000 ? record.createTime / 1000 : record.createTime
    const previousDate = localDate(previousSeconds)
    const currentDate = localDate(currentSeconds)
    if (currentDate !== previousDate || currentSeconds - previousSeconds >= gapSeconds) segments.push([record])
    else current.push(record)
  }

  const ranked = segments.map((segment): AgentDistinctiveConversationSegment => {
    let alternations = 0
    let longTextCount = 0
    let quotedMessageCount = 0
    let totalTextLength = 0
    let longestTextLength = 0
    let authoredTextCount = 0
    let authoredTextLength = 0
    let authoredLongTextCount = 0
    let messageTypeChanges = 0
    const senders = new Map<string, number>()
    const authoredLongTextsBySender = new Map<string, number>()
    const messageTypes = new Set<string>()
    for (let index = 0; index < segment.length; index += 1) {
      const record = segment[index]
      const sender = safeText(record.sender)
      const content = safeText(record.content)
      const messageType = safeText(record.messageType) || 'unknown'
      if (sender) senders.set(sender, (senders.get(sender) || 0) + 1)
      messageTypes.add(messageType)
      totalTextLength += content.length
      longestTextLength = Math.max(longestTextLength, content.length)
      if (content.length >= 30) longTextCount += 1
      const structuredPayload = (
        /^(?:media[\\/]|\[(?:转发的聊天记录|聊天记录|链接|图片|视频|位置|文件|语音|小程序|音乐|消息)\])/u.test(content)
        || /(?:image|voice|video|file|link|location|emoji|图片|语音|视频|文件|链接|位置|表情|转发|聊天记录)/i.test(messageType)
      )
      if (content && !structuredPayload) {
        authoredTextCount += 1
        authoredTextLength += Math.min(content.length, 500)
        if (content.length >= 30) {
          authoredLongTextCount += 1
          if (sender) authoredLongTextsBySender.set(sender, (authoredLongTextsBySender.get(sender) || 0) + 1)
        }
      }
      if (record.quotedContent || record.quotedSender || /\[(?:引用|回复)\b/.test(content)) quotedMessageCount += 1
      if (index > 0) {
        if (sender && sender !== safeText(segment[index - 1].sender)) alternations += 1
        if (messageType !== (safeText(segment[index - 1].messageType) || 'unknown')) messageTypeChanges += 1
      }
    }
    const senderCounts = Array.from(senders.values()).sort((left, right) => right - left)
    const reciprocalBalance = senderCounts.length >= 2 && senderCounts[0] > 0
      ? Math.min(1, senderCounts[1] / senderCounts[0])
      : 0
    const firstSeconds = segment[0].createTime > 10_000_000_000 ? segment[0].createTime / 1000 : segment[0].createTime
    const lastSeconds = segment.at(-1)!.createTime > 10_000_000_000 ? segment.at(-1)!.createTime / 1000 : segment.at(-1)!.createTime
    const activeMinutes = Math.max(0, (lastSeconds - firstSeconds) / 60)
    const authoredTextRatio = authoredTextCount / Math.max(1, segment.length)
    const averageAuthoredTextLength = authoredTextLength / Math.max(1, authoredTextCount)
    const authoredLongTextCounts = Array.from(authoredLongTextsBySender.values())
      .sort((left, right) => right - left)
    const authoredLongTextBalance = authoredLongTextCounts.length >= 2 && authoredLongTextCounts[0] > 0
      ? Math.min(1, authoredLongTextCounts[1] / authoredLongTextCounts[0])
      : 0
    const authoredLongTextVolume = Math.min(1, authoredLongTextCount / 12)
    const score = (
      Math.min(1, alternations / 24) * 22
      + reciprocalBalance * 14
      + Math.min(1, segment.length / 90) * 10
      + Math.min(1, activeMinutes / 120) * 12
      + Math.min(1, longTextCount / 8) * 16
      + Math.min(1, totalTextLength / 2_400) * 8
      + Math.min(1, longestTextLength / 240) * 6
      + Math.min(1, quotedMessageCount / 8) * 7
      + Math.min(1, messageTypes.size / 4) * 3
      + Math.min(1, messageTypeChanges / 8) * 2
      // 大量多媒体或转发消息集中出现时，过去会占满所有结构项，掩盖双方往返的
      // 解释性交流。这里提高双方原创长文本轮次和文本连续性的权重；该导航仍然
      // 与内容含义无关，也不会赋予任何主题意义。
      + Math.min(1, authoredLongTextCount / 20) * 14
      // 只有在实际文本足够多时，往返平衡才具有信息量。
      // 不能只因为双方各一条长消息的比例恰好完全均衡，就让它排在规模大得多的
      // 解释性交流之前。
      + authoredLongTextBalance * authoredLongTextVolume * 10
      + Math.max(0, Math.min(1, (authoredTextRatio - 0.65) / 0.35)) * 5
      + Math.max(0, Math.min(1, (averageAuthoredTextLength - 8) / 10)) * 12
    )
    return {
      records: segment,
      score,
      date: localDate(firstSeconds),
      alternations,
      longTextCount,
      authoredLongTextCount,
      authoredTextRatio,
      authoredLongTextBalance,
      quotedMessageCount,
      messageTypeCount: messageTypes.size,
    }
  }).sort((left, right) => right.score - left.score
    || right.alternations - left.alternations
    || right.records.length - left.records.length
    || left.records[0].createTime - right.records[0].createTime)

  const limit = Math.max(1, Math.min(6, Math.floor(Number(limitValue) || 2)))
  const selected: AgentDistinctiveConversationSegment[] = []
  const selectedDates = new Set<string>()
  for (const candidate of ranked) {
    if (selectedDates.has(candidate.date)) continue
    selected.push(candidate)
    selectedDates.add(candidate.date)
    if (selected.length >= limit) break
  }
  return selected
}

/**
 * 保留结构性较强的事件，同时为时间边界和中间阶段预留空间。
 * 候选项应当是各自日期中最佳的局部对话簇，因此此函数既不会给消息正文赋予语义，
 * 也不会假定消息最多的日期就是重要日期。
 */
export function selectAgentDistributedConversationSegments(
  candidatesValue: AgentDistinctiveConversationSegment[],
  limitValue = 6,
): AgentDistinctiveConversationSegment[] {
  const bestByDate = new Map<string, AgentDistinctiveConversationSegment>()
  for (const candidate of candidatesValue) {
    if (!candidate?.records?.length || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) continue
    const previous = bestByDate.get(candidate.date)
    if (
      !previous
      || candidate.score > previous.score
      || (candidate.score === previous.score && candidate.alternations > previous.alternations)
    ) {
      bestByDate.set(candidate.date, candidate)
    }
  }
  const chronological = Array.from(bestByDate.values()).sort((left, right) => left.date.localeCompare(right.date))
  if (chronological.length === 0) return []
  const limit = Math.max(1, Math.min(8, Math.floor(Number(limitValue) || 6), chronological.length))
  if (chronological.length <= limit) return chronological

  const selected = new Map<string, AgentDistinctiveConversationSegment>()
  const add = (candidate: AgentDistinctiveConversationSegment | undefined) => {
    if (!candidate || selected.size >= limit || selected.has(candidate.date)) return
    selected.set(candidate.date, candidate)
  }
  const ranked = [...chronological].sort((left, right) => right.score - left.score
    || right.alternations - left.alternations
    || right.longTextCount - left.longTextCount
    || left.date.localeCompare(right.date))
  const structuralCount = Math.max(
    1,
    Math.min(limit >= 7 ? 3 : 2, limit - Math.min(2, chronological.length)),
  )
  ranked.slice(0, structuralCount).forEach(add)

  if (limit >= 3) add(chronological[0])
  if (limit >= 4) add(chronological.at(-1))

  for (const ratio of [0.15, 0.5, 0.85]) {
    if (selected.size >= limit) break
    add(chronological[Math.round((chronological.length - 1) * ratio)])
  }

  const featureRankings = [
    [...chronological].sort((left, right) => right.longTextCount - left.longTextCount || right.score - left.score),
    [...chronological].sort((left, right) => right.quotedMessageCount - left.quotedMessageCount || right.score - left.score),
    [...chronological].sort((left, right) => right.messageTypeCount - left.messageTypeCount || right.score - left.score),
  ]
  for (const ranking of featureRankings) {
    if (selected.size >= limit) break
    add(ranking[0])
  }
  for (const candidate of ranked) {
    if (selected.size >= limit) break
    add(candidate)
  }
  return Array.from(selected.values()).sort((left, right) => left.date.localeCompare(right.date))
}

/**
 * 在月份结构样本中，为精确词项导航发现的日期预留数量受限的一部分。
 * 词项仍不带语义标签：模型会收到对应的原始对话簇，并自行判断其是否重要。
 */
export function selectAgentLexicallyAugmentedConversationSegments(
  candidatesValue: AgentDistinctiveConversationSegment[],
  lexicalAnchorsValue: AgentLexicalAnchor[],
  limitValue = 6,
): AgentDistinctiveConversationSegment[] {
  const candidates = candidatesValue
    .filter((candidate) => candidate?.records?.length && /^\d{4}-\d{2}-\d{2}$/.test(candidate.date))
  if (candidates.length === 0) return []
  const limit = Math.max(1, Math.min(8, Math.floor(Number(limitValue) || 6), candidates.length))
  const untaggedCandidates = candidates.filter((candidate) => !candidate.lexicalTerms?.length)
  const structuralCandidates = untaggedCandidates.length > 0 ? untaggedCandidates : candidates
  const structural = selectAgentDistributedConversationSegments(structuralCandidates, limit)
  if (lexicalAnchorsValue.length === 0) return structural

  const bestByDate = new Map<string, AgentDistinctiveConversationSegment>()
  for (const candidate of structuralCandidates) {
    const previous = bestByDate.get(candidate.date)
    if (!previous || candidate.score > previous.score) bestByDate.set(candidate.date, candidate)
  }
  const lexicalPreferred: AgentDistinctiveConversationSegment[] = []
  const candidateKey = (candidate: AgentDistinctiveConversationSegment) => {
    const first = candidate.records[0]
    return `${candidate.date}\u0001${first?.createTime || 0}\u0001${first?.localId || 0}`
  }
  const lexicalKeys = new Set<string>()
  const anchorsByKind = (kind?: AgentLexicalNavigationKind) => lexicalAnchorsValue
    .filter((anchor) => kind
      ? anchor.navigationKinds?.includes(kind)
      : !anchor.navigationKinds?.length)
    .sort((left, right) => (right.navigationScore || 0) - (left.navigationScore || 0)
      || right.messageCount - left.messageCount
      || right.dates.length - left.dates.length
      || left.term.localeCompare(right.term, 'zh-CN'))
  const diversifiedAnchors: AgentLexicalAnchor[] = []
  const addAnchor = (anchor: AgentLexicalAnchor | undefined) => {
    if (!anchor || diversifiedAnchors.some((candidate) => candidate.term === anchor.term)) return
    diversifiedAnchors.push(anchor)
  }
  const locationAnchors = anchorsByKind('location')
  const temporalAnchors = anchorsByKind('temporal')
  const namedEntityAnchors = anchorsByKind('named-entity')
  addAnchor(locationAnchors[0])
  addAnchor(temporalAnchors[0])
  addAnchor(namedEntityAnchors[0])
  addAnchor(locationAnchors[1])
  addAnchor(temporalAnchors[1])
  addAnchor(namedEntityAnchors[1])
  addAnchor(anchorsByKind()[0])
  addAnchor(anchorsByKind()[1])
  lexicalAnchorsValue.forEach(addAnchor)
  for (const anchor of diversifiedAnchors) {
    const tagged = candidates
      .filter((candidate) => candidate.lexicalTerms?.includes(anchor.term))
      .sort((left, right) => right.score - left.score || left.date.localeCompare(right.date))[0]
    const preferred = tagged || (anchor.dates || [])
      .map((date) => bestByDate.get(date))
      .filter((candidate): candidate is AgentDistinctiveConversationSegment => Boolean(candidate))
      .sort((left, right) => right.score - left.score || left.date.localeCompare(right.date))[0]
    const key = preferred ? candidateKey(preferred) : ''
    if (!preferred || lexicalKeys.has(key)) continue
    lexicalKeys.add(key)
    lexicalPreferred.push(preferred)
  }

  const targetLexicalCount = Math.min(4, Math.max(1, Math.ceil(limit * 0.5)), lexicalPreferred.length)
  if (targetLexicalCount === 0) return structural
  const selected = new Map(structural.map((candidate) => [candidateKey(candidate), candidate]))
  const chronological = [...structuralCandidates].sort((left, right) => left.date.localeCompare(right.date))
  const structuralStrength = [...structuralCandidates].sort((left, right) => right.score - left.score
    || right.alternations - left.alternations
    || left.date.localeCompare(right.date))
  const protectedKeys = new Set([
    structuralStrength[0],
    limit >= 3 ? chronological[0] : undefined,
    limit >= 4 ? chronological.at(-1) : undefined,
    limit >= 6 && targetLexicalCount < 4 ? structuralStrength[1] : undefined,
  ].filter(Boolean).map((candidate) => candidateKey(candidate!)))
  const retainedLexicalKeys = new Set<string>()
  for (const preferred of lexicalPreferred) {
    if (retainedLexicalKeys.size >= targetLexicalCount) break
    const preferredKey = candidateKey(preferred)
    if (selected.has(preferredKey)) {
      retainedLexicalKeys.add(preferredKey)
      continue
    }
    const replacementEntry = Array.from(selected.entries())
      .filter(([key]) => !protectedKeys.has(key) && !retainedLexicalKeys.has(key))
      .sort(([, left], [, right]) => left.score - right.score || right.date.localeCompare(left.date))[0]
    const replacement = replacementEntry?.[1]
    if (!replacement) continue
    selected.delete(replacementEntry[0])
    selected.set(preferredKey, preferred)
    retainedLexicalKeys.add(preferredKey)
  }
  return Array.from(selected.values()).sort((left, right) => left.date.localeCompare(right.date)
    || left.records[0].createTime - right.records[0].createTime)
}

/**
 * 构建紧凑的发现页，同时避免时间顺序或自动提取的某个词项主导页面。
 * 大部分位置保留最强的往返交流，其余位置来自分布式/词项导航器。
 * 模型仍需阅读原文预览，并自行赋予全部含义。
 */
export function selectAgentDiscoveryConversationSegments(
  candidatesValue: AgentDistinctiveConversationSegment[],
  lexicalAnchorsValue: AgentLexicalAnchor[],
  limitValue = 6,
): AgentDistinctiveConversationSegment[] {
  const candidates = candidatesValue
    .filter((candidate) => candidate?.records?.length && /^\d{4}-\d{2}-\d{2}$/.test(candidate.date))
  if (candidates.length === 0) return []
  const limit = Math.max(1, Math.min(8, Math.floor(Number(limitValue) || 6), candidates.length))
  const candidateKey = (candidate: AgentDistinctiveConversationSegment) => {
    const first = candidate.records[0]
    const last = candidate.records.at(-1)
    return [
      candidate.date,
      first?.createTime || 0,
      first?.localId || 0,
      last?.createTime || 0,
      last?.localId || 0,
    ].join('\u0001')
  }
  const strongest = [...candidates].sort((left, right) => (
    right.score - left.score
    || right.alternations - left.alternations
    || right.longTextCount - left.longTextCount
    || right.records.length - left.records.length
    || left.records[0].createTime - right.records[0].createTime
  ))
  const strongestSlots = Math.max(1, Math.min(limit, Math.ceil(limit * 2 / 3)))
  const selected = new Map<string, AgentDistinctiveConversationSegment>()
  const add = (candidate: AgentDistinctiveConversationSegment | undefined) => {
    if (!candidate || selected.size >= limit) return
    const key = candidateKey(candidate)
    if (!selected.has(key)) selected.set(key, candidate)
  }
  strongest.slice(0, strongestSlots).forEach(add)
  selectAgentLexicallyAugmentedConversationSegments(
    candidates,
    lexicalAnchorsValue,
    limit,
  ).forEach(add)
  strongest.forEach(add)
  return Array.from(selected.values()).sort((left, right) => (
    left.date.localeCompare(right.date)
    || left.records[0].createTime - right.records[0].createTime
  ))
}

/**
 * 在不解释词义的前提下选择紧凑的词项导航锚点。一种视图侧重月份内频率，
 * 另一种视图保留使用时间集中在该月的词项，使反复出现的具体话题不会被通用的
 * 高频聊天词汇淹没。
 */
export function selectAgentLexicalAnchors(
  candidatesValue: AgentLexicalAnchorCandidate[],
  totalMonthCountValue: number,
  limitValue = 16,
): AgentLexicalAnchor[] {
  const totalMonthCount = Math.max(1, Math.floor(Number(totalMonthCountValue) || 1))
  const limit = Math.max(1, Math.min(24, Math.floor(Number(limitValue) || 16)))
  const candidates = candidatesValue
    .map((candidate) => {
      const term = safeText(candidate.term)
      const messageCount = Math.max(0, Math.floor(Number(candidate.messageCount) || 0))
      const totalMessageCount = Math.max(messageCount, Math.floor(Number(candidate.totalMessageCount) || 0))
      const monthCount = Math.max(1, Math.min(totalMonthCount, Math.floor(Number(candidate.monthCount) || 1)))
      const dates = (candidate.dates || [])
        .map((item) => ({ date: safeText(item.date), count: Math.max(0, Math.floor(Number(item.count) || 0)) }))
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.count > 0)
        .sort((left, right) => left.date.localeCompare(right.date))
      const dateCount = dates.length
      const idfWeight = Math.max(0, Math.log2((totalMonthCount + 1) / (monthCount + 0.5)))
      const idfScore = Math.log2(messageCount + 1)
        * idfWeight
        * (1 + Math.min(5, dateCount) * 0.08)
        * (1 + Math.min(4, Math.max(0, Array.from(term).length - 2)) * 0.08)
      const concentration = totalMessageCount > 0 ? messageCount / totalMessageCount : 0
      const concentrationScore = totalMessageCount > 0
        ? (messageCount / totalMessageCount) * Math.log2(messageCount + 1)
        : 0
      const temporalScore = dateCount * Math.log2(messageCount + 1) * (idfWeight + concentration)
      const navigationKinds = Array.from(new Set(candidate.navigationKinds || []))
        .filter((kind): kind is AgentLexicalNavigationKind => (
          kind === 'location' || kind === 'named-entity' || kind === 'temporal'
        ))
      const semanticNavigationScore = Math.log2(messageCount + 1)
        * (1 + Math.min(5, dateCount) * 0.18)
        * (1 + idfWeight + concentration)
      return {
        term,
        messageCount,
        dates,
        idfScore,
        concentration,
        concentrationScore,
        temporalScore,
        semanticNavigationScore,
        navigationKinds,
      }
    })
    .filter((candidate) => candidate.term.length >= 2 && candidate.messageCount >= 2 && candidate.dates.length > 0)
  const selected = new Map<string, (typeof candidates)[number]>()
  const add = (candidate: (typeof candidates)[number] | undefined) => {
    if (!candidate || selected.size >= limit || selected.has(candidate.term)) return
    selected.set(candidate.term, candidate)
  }
  const byIdf = [...candidates].sort((left, right) => right.idfScore - left.idfScore
    || right.messageCount - left.messageCount
    || left.term.localeCompare(right.term, 'zh-CN'))
  const byConcentration = [...candidates]
    .filter((candidate) => candidate.messageCount >= 3)
    .sort((left, right) => right.concentrationScore - left.concentrationScore
      || right.messageCount - left.messageCount
      || left.term.localeCompare(right.term, 'zh-CN'))
  const byTemporalBreadth = [...candidates]
    .filter((candidate) => candidate.idfScore >= 0.5 || candidate.concentration >= 0.15)
    .sort((left, right) => right.temporalScore - left.temporalScore
      || right.messageCount - left.messageCount
      || left.term.localeCompare(right.term, 'zh-CN'))
  const byNamedEntity = candidates
    .filter((candidate) => candidate.navigationKinds.includes('named-entity'))
    .sort((left, right) => right.semanticNavigationScore - left.semanticNavigationScore
      || right.messageCount - left.messageCount
      || left.term.localeCompare(right.term, 'zh-CN'))
  const byLocation = candidates
    .filter((candidate) => candidate.navigationKinds.includes('location'))
    .sort((left, right) => right.semanticNavigationScore - left.semanticNavigationScore
      || right.messageCount - left.messageCount
      || left.term.localeCompare(right.term, 'zh-CN'))
  const bySemanticTime = candidates
    .filter((candidate) => candidate.navigationKinds.includes('temporal'))
    .sort((left, right) => right.semanticNavigationScore - left.semanticNavigationScore
      || right.messageCount - left.messageCount
      || left.term.localeCompare(right.term, 'zh-CN'))
  const semanticKindLimit = Math.max(1, Math.ceil(limit * 0.125))
  byLocation.slice(0, semanticKindLimit).forEach(add)
  bySemanticTime.slice(0, semanticKindLimit).forEach(add)
  byNamedEntity.slice(0, semanticKindLimit).forEach(add)
  byIdf.slice(0, Math.ceil(limit * 0.4)).forEach(add)
  byConcentration.slice(0, Math.ceil(limit * 0.25)).forEach(add)
  for (const candidate of byTemporalBreadth) add(candidate)
  for (const candidate of byIdf) add(candidate)

  return Array.from(selected.values()).map((candidate) => {
    const byCount = [...candidate.dates].sort((left, right) => right.count - left.count || left.date.localeCompare(right.date))
    const selectedDates = new Set<string>()
    const addDate = (date: string | undefined) => {
      if (date && selectedDates.size < 4) selectedDates.add(date)
    }
    addDate(candidate.dates[0]?.date)
    addDate(candidate.dates.at(-1)?.date)
    for (const item of byCount) addDate(item.date)
    return {
      term: candidate.term,
      messageCount: candidate.messageCount,
      dates: Array.from(selectedDates).sort(),
      navigationKinds: candidate.navigationKinds.length > 0 ? candidate.navigationKinds : undefined,
      navigationScore: Math.max(
        candidate.idfScore,
        candidate.concentrationScore,
        candidate.semanticNavigationScore,
      ),
    }
  })
}

/**
 * 评估模型阅读前某个月份能够提供多少具体导航信息。这里不会解释任何词项，
 * 会优先考虑多样的地点、实体和时间表达标签，以及跨日期重复出现的锚点，
 * 同时削弱高消息量月份的天然优势。
 */
export function scoreAgentSemanticMonthNavigation(
  value: AgentSemanticMonthNavigation,
): number {
  const anchors = (value.lexicalAnchors || [])
    .filter((anchor) => safeText(anchor.term) && anchor.messageCount > 0 && anchor.dates.length > 0)
  if (anchors.length === 0) return 0

  const kinds = new Set<AgentLexicalNavigationKind>()
  let taggedAnchorCount = 0
  let rareTaggedAnchorCount = 0
  let multiDateAnchorCount = 0
  for (const anchor of anchors) {
    const anchorKinds = anchor.navigationKinds || []
    if (anchorKinds.length > 0) taggedAnchorCount += 1
    if (anchorKinds.length > 0 && anchor.messageCount <= 8) rareTaggedAnchorCount += 1
    if (anchor.dates.length >= 2) multiDateAnchorCount += 1
    anchorKinds.forEach((kind) => kinds.add(kind))
  }
  const strongestAnchorScores = anchors
    .map((anchor) => Math.max(0, Number(anchor.navigationScore) || 0))
    .sort((left, right) => right - left)
    .slice(0, 6)
  const anchorSignal = strongestAnchorScores.reduce((sum, score) => sum + Math.log2(score + 1), 0)
  const concreteSignal = (
    kinds.size * 4
    + taggedAnchorCount * 1.5
    + rareTaggedAnchorCount * 2
    + multiDateAnchorCount * 1.25
    + Math.log2(anchors.length + 1) * 2
    + anchorSignal
  )
  const volumeDampener = Math.sqrt(Math.max(1, Math.log2(Math.max(0, value.messageCount) + 2)))
  return concreteSignal / volumeDampener
}

/**
 * 从时间线的各个部分保留高信息量导航行。上限按结构而不是 token 计算：
 * 对于较长历史，会从每个时间带展示少量条目，而不是让某个密集阶段占据所有可见位置。
 */
export function selectAgentTemporallyDistributedRows<T>(
  values: T[],
  timeKey: (value: T) => string,
  score: (value: T) => number,
  bandCountValue = 4,
  rowsPerBandValue = 2,
): T[] {
  const chronological = [...values].sort((left, right) => (
    timeKey(left).localeCompare(timeKey(right))
  ))
  if (chronological.length <= 1) return chronological
  const bandCount = Math.max(1, Math.min(
    chronological.length,
    Math.floor(Number(bandCountValue) || 1),
  ))
  const rowsPerBand = Math.max(1, Math.floor(Number(rowsPerBandValue) || 1))
  if (chronological.length <= bandCount * rowsPerBand) return chronological

  const selected = new Set<T>()
  for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
    const startIndex = Math.floor((bandIndex * chronological.length) / bandCount)
    const endIndex = Math.floor(((bandIndex + 1) * chronological.length) / bandCount)
    chronological
      .slice(startIndex, Math.max(startIndex + 1, endIndex))
      .sort((left, right) => (
        Math.max(0, Number(score(right)) || 0) - Math.max(0, Number(score(left)) || 0)
        || timeKey(left).localeCompare(timeKey(right))
      ))
      .slice(0, rowsPerBand)
      .forEach((value) => selected.add(value))
  }
  return chronological.filter((value) => selected.has(value))
}

export function selectAgentStructuralScanMonths<T extends {
  month: string
  count: number
}>(
  values: T[],
  desiredCountValue: unknown,
  priority: (value: T) => number,
  strongestChanges: Array<{ from?: string; to?: string }> = [],
  distribution: 'structural' | 'chronological' = 'structural',
): T[] {
  const byMonth = new Map<string, T>()
  for (const value of values) {
    if (/^\d{4}-\d{2}$/.test(safeText(value.month))) byMonth.set(value.month, value)
  }
  const chronological = Array.from(byMonth.values())
    .sort((left, right) => left.month.localeCompare(right.month))
  const desiredCount = Math.max(1, Math.min(
    chronological.length,
    Math.floor(Number(desiredCountValue) || 1),
  ))
  if (chronological.length <= desiredCount) return chronological

  const selected = new Set<string>()
  const add = (value: T | undefined) => {
    if (value && selected.size < desiredCount) selected.add(value.month)
  }
  const addMonth = (month: unknown) => add(byMonth.get(safeText(month)))

  // 边界月份用于保留整体轨迹，其余位置分配给完整时间线和结构变化。
  // 曾经占主导的活跃连续段不能吞掉小型跨期预览的大部分位置，否则会让后期的
  // 密集阶段看起来像完整历史，并隐藏模型判断下一步阅读位置所需的中间阶段。
  if (desiredCount >= 4) {
    add(chronological[0])
    add(chronological.at(-1))
  }
  const peakCount = chronological.reduce(
    (maximum, month) => Math.max(maximum, Math.max(0, Number(month.count) || 0)),
    0,
  )
  const activeThreshold = Math.max(1, peakCount * 0.25)
  const monthOrdinal = (month: string) => {
    const [year, monthNumber] = month.split('-').map(Number)
    return year * 12 + monthNumber - 1
  }
  const activeRuns: T[][] = []
  let currentRun: T[] = []
  for (const month of chronological) {
    const continuesRun = currentRun.length === 0
      || monthOrdinal(month.month) === monthOrdinal(currentRun.at(-1)!.month) + 1
    if (Math.max(0, Number(month.count) || 0) >= activeThreshold) {
      if (!continuesRun) {
        if (currentRun.length > 0) activeRuns.push(currentRun)
        currentRun = []
      }
      currentRun.push(month)
    } else if (currentRun.length > 0) {
      activeRuns.push(currentRun)
      currentRun = []
    }
  }
  if (currentRun.length > 0) activeRuns.push(currentRun)
  const dominantRun = activeRuns
    .map((run) => ({
      run,
      score: run.reduce((sum, month) => sum + Math.max(0, Number(month.count) || 0), 0)
        * (1 + Math.log2(run.length + 1)),
    }))
    .sort((left, right) => right.score - left.score
      || right.run.length - left.run.length
      || left.run[0].month.localeCompare(right.run[0].month))[0]?.run || []
  const reservedStructuralSlots = Math.max(
    1,
    Math.min(desiredCount - selected.size, Math.ceil(desiredCount * 0.2)),
  )
  const distributedSlots = Math.max(
    1,
    desiredCount - selected.size - reservedStructuralSlots,
  )
  const distributedTarget = Math.min(desiredCount, selected.size + distributedSlots)
  if (distribution === 'chronological') {
    // 这些是时间顺序锚点，不是又一轮排序。使用内部分位点，避免宽时间带边缘附近
    // 的高分月份反复挤掉长历史的中间部分。结构变化和主要活跃连续段仍会在下方
    // 获得数量受限的位置。
    for (let index = 1; index <= distributedSlots; index += 1) {
      add(chronological[
        Math.round((index * (chronological.length - 1)) / (distributedSlots + 1))
      ])
      if (selected.size >= distributedTarget) break
    }
  } else {
    // 初次发现来源时，每个时间带中结构信息最丰富的月份更有帮助。
    // 一旦选中来源，聚焦阅读就切换到上方的时间顺序锚点，避免发现阶段的醒目程度
    // 抹去其余历史。
    for (const month of selectAgentTemporallyDistributedRows(
      chronological,
      (value) => value.month,
      priority,
      distributedSlots,
      1,
    )) {
      add(month)
      if (selected.size >= distributedTarget) break
    }
  }

  const transitionSlots = Math.max(1, Math.ceil(reservedStructuralSlots / 2))
  const transitionTarget = Math.min(desiredCount, selected.size + transitionSlots)
  for (const change of strongestChanges) {
    addMonth(change.from)
    if (selected.size >= transitionTarget) break
    addMonth(change.to)
    if (selected.size >= transitionTarget) break
  }

  const phaseTarget = Math.min(desiredCount, selected.size + Math.max(0, reservedStructuralSlots - transitionSlots))
  for (const month of selectAgentTemporallyDistributedRows(
    dominantRun,
    (value) => value.month,
    priority,
    Math.max(1, reservedStructuralSlots - transitionSlots),
    1,
  )) {
    add(month)
    if (selected.size >= phaseTarget) break
  }
  for (const month of selectAgentTemporallyDistributedRows(
    chronological,
    (value) => value.month,
    priority,
    desiredCount,
    1,
  )) add(month)
  for (const month of [...chronological].sort((left, right) => (
    Math.max(0, Number(priority(right)) || 0) - Math.max(0, Number(priority(left)) || 0)
    || left.month.localeCompare(right.month)
  ))) add(month)
  for (const month of chronological) add(month)
  return chronological.filter((month) => selected.has(month.month))
}

export function selectAgentDistributedRawPage(
  recordsValue: AgentRawMessageRecord[],
  tokenBudgetValue: unknown,
  minimumTokenBudgetValue = 160,
): AgentRawPageSelection {
  const records = [...recordsValue]
    .filter((record) => Number(record.createTime) > 0)
    .sort((left, right) => left.createTime - right.createTime || left.sortSeq - right.sortSeq || left.localId - right.localId)
  const minimumTokenBudget = Math.max(160, Math.min(
    AGENT_RAW_PAGE_MIN_TOKENS,
    Math.floor(Number(minimumTokenBudgetValue) || 160),
  ))
  const tokenBudget = Math.max(minimumTokenBudget, Math.min(
    AGENT_RAW_PAGE_MAX_TOKENS,
    Math.floor(Number(tokenBudgetValue) || minimumTokenBudget),
  ))
  if (records.length <= 1) return selectAgentRawPage(records, tokenBudget, minimumTokenBudget)

  const lineTokens = records.map((record) => estimateAgentRawTextTokens(formatAgentRawMessage(record)) + 6)
  const windowCount = records.length >= 12 && tokenBudget >= 240 ? 3 : 2
  const ratios = windowCount === 3 ? [0.15, 0.5, 0.85] : [0.25, 0.75]
  const selectedIndexes = new Set<number>()
  let estimatedTokens = 0

  for (const ratio of ratios) {
    const center = Math.round((records.length - 1) * ratio)
    const order: number[] = [center]
    for (let radius = 1; radius < records.length; radius += 1) {
      if (center - radius >= 0) order.push(center - radius)
      if (center + radius < records.length) order.push(center + radius)
    }
    const windowBudget = Math.max(60, Math.floor(tokenBudget / windowCount))
    let windowTokens = 0
    for (const index of order) {
      if (selectedIndexes.has(index)) continue
      const cost = lineTokens[index]
      if (selectedIndexes.size > 0 && estimatedTokens + cost > tokenBudget) continue
      if (windowTokens > 0 && windowTokens + cost > windowBudget) break
      selectedIndexes.add(index)
      estimatedTokens += cost
      windowTokens += cost
      if (estimatedTokens >= tokenBudget) break
    }
  }

  const neighbours = Array.from(selectedIndexes)
    .flatMap((index) => [index - 1, index + 1])
    .filter((index) => index >= 0 && index < records.length && !selectedIndexes.has(index))
  for (const index of Array.from(new Set(neighbours))) {
    const cost = lineTokens[index]
    if (estimatedTokens + cost > tokenBudget) continue
    selectedIndexes.add(index)
    estimatedTokens += cost
  }

  if (selectedIndexes.size === 0) return selectAgentRawPage(records, tokenBudget, minimumTokenBudget)
  const selectedRecords = Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => records[index])
  return {
    records: selectedRecords,
    consumed: selectedRecords.length,
    estimatedTokens,
  }
}

export function selectAgentTimelineSampleDates(
  rowsValue: Array<{ date: string; count: number }>,
  windowCountValue: number,
  mode: AgentTimelineSampleSelectionMode = 'mixed',
): AgentTimelineSampleDate[] {
  const rows = rowsValue
    .map((row) => ({ date: safeText(row.date), count: Math.max(0, Number(row.count) || 0) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.count > 0)
    .sort((left, right) => left.date.localeCompare(right.date))
    .filter((row, index, all) => index === 0 || row.date !== all[index - 1].date)
  if (rows.length === 0) return []
  const windowCount = Math.max(1, Math.min(rows.length, Math.floor(Number(windowCountValue) || 1)))
  if (windowCount === 1) return [{ ...rows[0], reason: 'range-start' }]

  const monthly = new Map<string, typeof rows>()
  for (const row of rows) {
    const month = row.date.slice(0, 7)
    const bucket = monthly.get(month) || []
    bucket.push(row)
    monthly.set(month, bucket)
  }
  const monthRows = Array.from(monthly, ([month, values]) => ({
    month,
    values,
    count: values.reduce((sum, row) => sum + row.count, 0),
    activeDays: values.length,
    peak: [...values].sort((left, right) => right.count - left.count || left.date.localeCompare(right.date))[0],
  }))

  if (mode === 'uniform') {
    if (monthRows.length >= windowCount) {
      return Array.from({ length: windowCount }, (_, index) => {
        const month = monthRows[Math.round((index * (monthRows.length - 1)) / (windowCount - 1))]
        const row = index === 0
          ? month.values[0]
          : index === windowCount - 1
            ? month.values.at(-1)!
            : month.values[Math.round((month.values.length - 1) / 2)]
        return {
          ...row,
          reason: index === 0 ? 'range-start' as const : index === windowCount - 1 ? 'range-end' as const : 'time-quantile' as const,
        }
      })
    }
    return Array.from({ length: windowCount }, (_, index) => {
      const row = rows[Math.round((index * (rows.length - 1)) / (windowCount - 1))]
      return {
        ...row,
        reason: index === 0 ? 'range-start' as const : index === windowCount - 1 ? 'range-end' as const : 'time-quantile' as const,
      }
    }).filter((row, index, all) => all.findIndex((candidate) => candidate.date === row.date) === index)
  }

  const baseline = Array.from({ length: windowCount }, (_, index) => {
    if (index === 0) return { ...rows[0], reason: 'range-start' as const }
    if (index === windowCount - 1) return { ...rows.at(-1)!, reason: 'range-end' as const }
    const segmentStart = Math.floor((index * rows.length) / windowCount)
    const segmentEnd = Math.max(segmentStart, Math.floor(((index + 1) * rows.length) / windowCount) - 1)
    const segment = rows.slice(segmentStart, segmentEnd + 1)
    if (index % 2 === 1) {
      const center = (segment.length - 1) / 2
      const peak = segment
        .map((row, segmentIndex) => ({ row, distance: Math.abs(segmentIndex - center) }))
        .sort((left, right) => right.row.count - left.row.count || left.distance - right.distance || left.row.date.localeCompare(right.row.date))[0].row
      return { ...peak, reason: 'segment-activity-peak' as const }
    }
    return { ...segment[Math.round((segment.length - 1) / 2)], reason: 'time-quantile' as const }
  }).filter((row, index, all) => all.findIndex((candidate) => candidate.date === row.date) === index)

  if (monthRows.length < 3 || windowCount < 4) return baseline

  if (monthRows.length <= windowCount) {
    const selected = new Map<string, AgentTimelineSampleDate>()
    const add = (row: AgentTimelineSampleDate) => {
      if (selected.has(row.date) || selected.size >= windowCount) return false
      selected.set(row.date, row)
      return true
    }
    monthRows.forEach((month, index) => {
      const row = index === 0
        ? month.values[0]
        : index === monthRows.length - 1
          ? month.values.at(-1)!
          : month.peak
      add({
        ...row,
        reason: index === 0 ? 'range-start' : index === monthRows.length - 1 ? 'range-end' : 'time-quantile',
      })
    })

    const trailingTransition = monthRows.length >= 2
      ? { previous: monthRows.at(-2)!, current: monthRows.at(-1)! }
      : null
    const trailingChangeRatio = trailingTransition
      ? Math.abs(trailingTransition.current.count - trailingTransition.previous.count)
        / Math.max(1, trailingTransition.current.count, trailingTransition.previous.count)
      : 0
    if (trailingTransition && trailingChangeRatio >= 0.65 && windowCount >= 6) {
      const trailingSide = trailingTransition.current.count >= trailingTransition.previous.count
        ? trailingTransition.current
        : trailingTransition.previous
      const reason = trailingSide === trailingTransition.previous
        ? 'trailing-change-before' as const
        : 'trailing-change-after' as const
      for (const row of [...trailingSide.values].sort((left, right) => right.count - left.count || left.date.localeCompare(right.date)).slice(0, 2)) {
        if (selected.has(row.date)) selected.set(row.date, { ...row, reason })
        else add({ ...row, reason })
      }
    }

    const transitionCandidates = monthRows.slice(1).map((current, index) => {
      const previous = monthRows[index]
      const activeDayBalance = Math.min(previous.activeDays, current.activeDays)
        / Math.max(1, Math.max(previous.activeDays, current.activeDays))
      return {
        previous,
        current,
        score: Math.abs(current.count - previous.count) * (0.5 + activeDayBalance * 0.5),
      }
    }).sort((left, right) => right.score - left.score
      || left.previous.month.localeCompare(right.previous.month))
    for (const candidate of transitionCandidates) {
      const before = Array.from(selected.values()).find((row) => row.date.startsWith(candidate.previous.month))
      const after = Array.from(selected.values()).find((row) => row.date.startsWith(candidate.current.month))
      if (
        before
        && after
        && !before.reason.startsWith('trailing-change')
        && !after.reason.startsWith('trailing-change')
      ) {
        selected.set(before.date, { ...before, reason: 'activity-change-before' })
        selected.set(after.date, { ...after, reason: 'activity-change-after' })
        break
      }
    }
    for (const candidate of transitionCandidates) {
      if (selected.size >= windowCount) break
      const before = [...candidate.previous.values]
        .sort((left, right) => right.count - left.count || left.date.localeCompare(right.date))
        .find((row) => !selected.has(row.date))
      if (before) add({ ...before, reason: 'activity-change-before' })
      if (selected.size >= windowCount) break
      const after = [...candidate.current.values]
        .sort((left, right) => right.count - left.count || left.date.localeCompare(right.date))
        .find((row) => !selected.has(row.date))
      if (after) add({ ...after, reason: 'activity-change-after' })
    }
    for (const row of baseline) {
      if (selected.size >= windowCount) break
      add(row)
    }
    return Array.from(selected.values()).sort((left, right) => left.date.localeCompare(right.date))
  }

  const requireDistinctMonths = monthRows.length >= windowCount

  if (requireDistinctMonths) {
    // 长时间线既需要有代表性的时间顺序，也需要结构转折。把固定窗口数的大约四分之一
    // 留给前后变化最强的节点，可以在不增加阅读预算的情况下展示均匀分位点跳过的时期。
    const chronologicalWindowCount = Math.min(windowCount, Math.max(2, Math.ceil(windowCount * 0.75)))
    const selected = new Map<string, AgentTimelineSampleDate>()
    const selectedMonths = new Set<string>()
    const add = (row: AgentTimelineSampleDate) => {
      const month = row.date.slice(0, 7)
      if (selected.has(row.date) || selectedMonths.has(month) || selected.size >= windowCount) return false
      selected.set(row.date, row)
      selectedMonths.add(month)
      return true
    }
    const chronologicalMonths = Array.from({ length: chronologicalWindowCount }, (_, index) => (
      monthRows[Math.round((index * (monthRows.length - 1)) / (chronologicalWindowCount - 1))]
    ))
    for (let index = 0; index < chronologicalMonths.length; index += 1) {
      const month = chronologicalMonths[index]
      const row = index === 0
        ? month.values[0]
        : index === chronologicalMonths.length - 1
          ? month.values.at(-1)!
          : month.peak
      add({
        ...row,
        reason: index === 0 ? 'range-start' : index === chronologicalMonths.length - 1 ? 'range-end' : 'time-quantile',
      })
    }

    const transitionCandidates = monthRows.slice(1).map((current, index) => {
      const previous = monthRows[index]
      const activeDayBalance = Math.min(previous.activeDays, current.activeDays)
        / Math.max(1, Math.max(previous.activeDays, current.activeDays))
      return {
        previous,
        current,
        score: Math.abs(current.count - previous.count) * (0.5 + activeDayBalance * 0.5),
      }
    }).sort((left, right) => right.score - left.score
      || left.previous.month.localeCompare(right.previous.month))
    const activityWindowLimit = windowCount - chronologicalWindowCount
    let activityWindows = 0
    for (const candidate of transitionCandidates) {
      if (activityWindows + 2 > activityWindowLimit || selected.size + 2 > windowCount) break
      if (selectedMonths.has(candidate.previous.month) || selectedMonths.has(candidate.current.month)) continue
      add({ ...candidate.previous.peak, reason: 'activity-change-before' })
      add({ ...candidate.current.peak, reason: 'activity-change-after' })
      activityWindows += 2
    }
    if (activityWindows < activityWindowLimit && selected.size < windowCount) {
      for (const candidate of transitionCandidates) {
        const sides = [
          { month: candidate.previous, reason: 'activity-change-before' as const },
          { month: candidate.current, reason: 'activity-change-after' as const },
        ].sort((left, right) => right.month.count - left.month.count || left.month.month.localeCompare(right.month.month))
        const side = sides.find(({ month }) => !selectedMonths.has(month.month))
        if (!side) continue
        if (add({ ...side.month.peak, reason: side.reason })) activityWindows += 1
        break
      }
    }

    const remainingMonths = monthRows.filter(({ month }) => !selectedMonths.has(month))
    while (selected.size < windowCount && remainingMonths.length > 0) {
      const selectedIndexes = monthRows
        .map((month, index) => selectedMonths.has(month.month) ? index : -1)
        .filter((index) => index >= 0)
      const nextIndex = remainingMonths
        .map((month, index) => {
          const monthIndex = monthRows.findIndex((candidate) => candidate.month === month.month)
          const nearestDistance = Math.min(...selectedIndexes.map((selectedIndex) => Math.abs(selectedIndex - monthIndex)))
          return { index, nearestDistance, monthIndex }
        })
        .sort((left, right) => right.nearestDistance - left.nearestDistance || left.monthIndex - right.monthIndex)[0]?.index
      if (nextIndex === undefined) break
      const [month] = remainingMonths.splice(nextIndex, 1)
      add({
        ...month.values[Math.round((month.values.length - 1) / 2)],
        reason: 'time-quantile',
      })
    }
    return Array.from(selected.values()).sort((left, right) => left.date.localeCompare(right.date))
  }

  const selectedMonth = (selected: Map<string, AgentTimelineSampleDate>, row: AgentTimelineSampleDate) => (
    Array.from(selected.values()).some((candidate) => candidate.date.slice(0, 7) === row.date.slice(0, 7))
  )
  const canSelect = (selected: Map<string, AgentTimelineSampleDate>, row: AgentTimelineSampleDate) => (
    !selected.has(row.date) && (!requireDistinctMonths || !selectedMonth(selected, row))
  )

  const trailingTransition = monthRows.length >= 2
    ? { previous: monthRows.at(-2)!, current: monthRows.at(-1)! }
    : null
  const trailingChangeRatio = trailingTransition
    ? Math.abs(trailingTransition.current.count - trailingTransition.previous.count)
      / Math.max(1, trailingTransition.current.count, trailingTransition.previous.count)
    : 0
  const trailingSide = trailingTransition
    ? trailingTransition.current.count >= trailingTransition.previous.count
      ? trailingTransition.current
      : trailingTransition.previous
    : null
  const trailingSelections: AgentTimelineSampleDate[] = trailingSide && trailingChangeRatio >= 0.65 && windowCount >= 6
    ? [...trailingSide.values]
        .sort((left, right) => right.count - left.count || left.date.localeCompare(right.date))
        .slice(0, 2)
        .map((row) => ({
          ...row,
          reason: trailingSide === trailingTransition?.previous
            ? 'trailing-change-before' as const
            : 'trailing-change-after' as const,
        }))
    : []
  const maximumTransitionPairs = Math.min(
    trailingSelections.length > 0 ? 1 : 3,
    Math.max(1, Math.floor((windowCount - 2 - trailingSelections.length) / 3)),
  )
  const transitionCandidates = monthRows.slice(1).map((current, index) => {
    const previous = monthRows[index]
    const activeDayBalance = Math.min(previous.activeDays, current.activeDays)
      / Math.max(1, Math.max(previous.activeDays, current.activeDays))
    return {
      previous,
      current,
      score: Math.abs(current.count - previous.count) * (0.5 + activeDayBalance * 0.5),
    }
  }).sort((left, right) => right.score - left.score
    || left.previous.month.localeCompare(right.previous.month))

  const transitionSelections: AgentTimelineSampleDate[] = []
  const usedTransitionMonths = new Set<string>(trailingTransition && trailingSelections.length > 0
    ? [trailingTransition.previous.month, trailingTransition.current.month]
    : [])
  for (const candidate of transitionCandidates) {
    if (transitionSelections.length >= maximumTransitionPairs * 2) break
    if (usedTransitionMonths.has(candidate.previous.month) || usedTransitionMonths.has(candidate.current.month)) continue
    usedTransitionMonths.add(candidate.previous.month)
    usedTransitionMonths.add(candidate.current.month)
    transitionSelections.push(
      { ...candidate.previous.peak, reason: 'activity-change-before' },
      { ...candidate.current.peak, reason: 'activity-change-after' },
    )
  }
  const selected = new Map<string, AgentTimelineSampleDate>()
  selected.set(rows[0].date, { ...rows[0], reason: 'range-start' })
  selected.set(rows.at(-1)!.date, { ...rows.at(-1)!, reason: 'range-end' })
  for (const row of trailingSelections) {
    if (selected.size >= windowCount) break
    if (row.date !== rows[0].date && row.date !== rows.at(-1)!.date && canSelect(selected, row)) selected.set(row.date, row)
  }
  for (const row of transitionSelections) {
    if (selected.size >= windowCount) break
    if (row.date !== rows[0].date && row.date !== rows.at(-1)!.date && canSelect(selected, row)) selected.set(row.date, row)
  }
  const remainingBaselineSlots = Math.max(0, windowCount - selected.size)
  const baselineCandidates = baseline.filter((row) => row.date !== rows.at(-1)!.date && canSelect(selected, row))
  const distributedBaseline = remainingBaselineSlots >= baselineCandidates.length
    ? baselineCandidates
    : Array.from({ length: remainingBaselineSlots }, (_, index) => {
        if (remainingBaselineSlots === 1) return baselineCandidates[Math.floor((baselineCandidates.length - 1) / 2)]
        return baselineCandidates[Math.round((index * (baselineCandidates.length - 1)) / (remainingBaselineSlots - 1))]
      }).filter((row, index, values) => values.indexOf(row) === index)
  for (const row of distributedBaseline) {
    if (row && canSelect(selected, row)) selected.set(row.date, row)
  }
  if (requireDistinctMonths && selected.size < windowCount) {
    const remainingMonths = monthRows
      .filter(({ month }) => month !== rows.at(-1)!.date.slice(0, 7))
      .filter(({ month }) => !Array.from(selected.values()).some((row) => row.date.startsWith(month)))
    const needed = Math.max(0, windowCount - selected.size)
    const distributedMonths = needed >= remainingMonths.length
      ? remainingMonths
      : Array.from({ length: needed }, (_, index) => {
          if (needed === 1) return remainingMonths[Math.floor((remainingMonths.length - 1) / 2)]
          return remainingMonths[Math.round((index * (remainingMonths.length - 1)) / (needed - 1))]
        }).filter((row, index, values) => values.indexOf(row) === index)
    for (const month of distributedMonths) {
      if (!month) continue
      const row = { ...month.peak, reason: 'time-quantile' as const }
      if (canSelect(selected, row)) selected.set(row.date, row)
    }
  }
  return Array.from(selected.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, windowCount)
}

export function buildAgentTimelineCoverageMap(
  monthlyRowsValue: unknown,
  rawRangesValue: Array<{ startAt?: unknown; endAt?: unknown }>,
): {
  activeMonthCount: number
  touchedMonthCount: number
  untouchedMonthCount: number
  months: AgentTimelineCoverageMonth[]
} {
  const ranges = rawRangesValue
    .map((range) => ({
      startMonth: safeText(range.startAt).slice(0, 7),
      endMonth: safeText(range.endAt).slice(0, 7),
    }))
    .filter((range) => /^\d{4}-\d{2}$/.test(range.startMonth) && /^\d{4}-\d{2}$/.test(range.endMonth))
  const months = (Array.isArray(monthlyRowsValue) ? monthlyRowsValue : [])
    .map((value): AgentTimelineCoverageMonth | null => {
      const row = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      const month = safeText(row?.month).slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(month)) return null
      const representatives = Array.isArray(row?.representativeDates)
        ? row.representativeDates.map((candidate) => {
            const record = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
              ? candidate as Record<string, unknown>
              : null
            return safeText(record?.date || candidate).slice(0, 10)
          })
        : []
      const representativeDates = Array.from(new Set([
        safeText(row?.firstActiveDate).slice(0, 10),
        ...representatives,
        safeText(row?.lastActiveDate).slice(0, 10),
      ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))).slice(0, 6)
      const touched = ranges.some((range) => range.startMonth <= month && range.endMonth >= month)
      return {
        month,
        messageCount: Math.max(0, Math.floor(Number(row?.count) || 0)),
        activeDays: Math.max(0, Math.floor(Number(row?.activeDays) || 0)),
        firstActiveDate: safeText(row?.firstActiveDate).slice(0, 10),
        lastActiveDate: safeText(row?.lastActiveDate).slice(0, 10),
        representativeDates,
        rawPageCoverage: touched ? 'touched' : 'untouched',
      }
    })
    .filter((row): row is AgentTimelineCoverageMonth => Boolean(row))
    .sort((left, right) => left.month.localeCompare(right.month))
  const touchedMonthCount = months.filter((row) => row.rawPageCoverage === 'touched').length
  return {
    activeMonthCount: months.length,
    touchedMonthCount,
    untouchedMonthCount: months.length - touchedMonthCount,
    months,
  }
}

export function filterAgentUnreadAnchorDates(
  dates: unknown[],
  pages: Array<{
    displayName?: unknown
    sessionId?: unknown
    startAt?: unknown
    endAt?: unknown
  }>,
  conversation = '',
): string[] {
  const normalizedConversation = String(conversation || '').trim()
  const normalizedDates = Array.from(new Set(dates
    .map((value) => String(value || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))))
  return normalizedDates.filter((date) => !pages.some((page) => {
    const pageLabels = [page.displayName, page.sessionId]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    if (normalizedConversation && pageLabels.length > 0 && !pageLabels.includes(normalizedConversation)) return false
    const rawStartDate = String(page.startAt || '').slice(0, 10)
    const rawEndDate = String(page.endAt || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(rawEndDate)) return false
    const startDate = rawStartDate <= rawEndDate ? rawStartDate : rawEndDate
    const endDate = rawStartDate <= rawEndDate ? rawEndDate : rawStartDate
    return startDate <= date && endDate >= date
  }))
}

function nextCalendarMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!year || !monthNumber) return ''
  const next = new Date(Date.UTC(year, monthNumber, 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`
}

export function groupAgentUntouchedTimelineSpans(
  monthsValue: AgentTimelineCoverageMonth[],
): AgentTimelineCoverageSpan[] {
  const months = monthsValue
    .filter((row) => row.rawPageCoverage === 'untouched' && /^\d{4}-\d{2}$/.test(row.month))
    .sort((left, right) => left.month.localeCompare(right.month))
  const spans: AgentTimelineCoverageMonth[][] = []
  for (const month of months) {
    const current = spans.at(-1)
    if (!current || nextCalendarMonth(current.at(-1)!.month) !== month.month) spans.push([month])
    else current.push(month)
  }
  return spans.map((span) => {
    const first = span[0]
    const last = span.at(-1)!
    const middle = span[Math.floor((span.length - 1) / 2)]
    const middleDates = middle.representativeDates
    const representativeDate = middleDates.find((date) => (
      date !== middle.firstActiveDate && date !== middle.lastActiveDate
    )) || middleDates[0] || ''
    return {
      startMonth: first.month,
      endMonth: last.month,
      monthCount: span.length,
      messageCount: span.reduce((sum, row) => sum + row.messageCount, 0),
      activeDays: span.reduce((sum, row) => sum + row.activeDays, 0),
      firstActiveDate: first.firstActiveDate,
      representativeDate,
      lastActiveDate: last.lastActiveDate,
    }
  })
}

export function allocateAgentTimelineSamplePositions(
  selectionsValue: AgentTimelineSampleDate[],
  totalWindowCountValue: number,
  expectedWindowMessagesValue: number,
): AgentTimelineSamplePosition[] {
  const selections = selectionsValue
    .map((selection) => ({
      ...selection,
      date: safeText(selection.date),
      count: Math.max(0, Number(selection.count) || 0),
    }))
    .filter((selection) => /^\d{4}-\d{2}-\d{2}$/.test(selection.date) && selection.count > 0)
    .sort((left, right) => left.date.localeCompare(right.date))
  if (selections.length === 0) return []

  const totalWindowCount = Math.max(
    selections.length,
    Math.floor(Number(totalWindowCountValue) || selections.length),
  )
  const expectedWindowMessages = Math.max(1, Math.floor(Number(expectedWindowMessagesValue) || 1))
  const positions = selections.map((selection, index): AgentTimelineSamplePosition => {
    if (index === 0) return { ...selection, position: 'start', offset: 0 }
    if (index === selections.length - 1) return { ...selection, position: 'end', offset: 0 }
    const maximumMiddleOffset = Math.max(0, selection.count - expectedWindowMessages)
    return {
      ...selection,
      position: 'middle',
      offset: Math.floor(maximumMiddleOffset / 2),
    }
  })

  const reasonPriority = (reason: AgentTimelineSampleDate['reason']): number => {
    if (reason === 'trailing-change-before' || reason === 'trailing-change-after') return 0
    if (reason === 'activity-change-before' || reason === 'activity-change-after') return 1
    if (reason === 'segment-activity-peak') return 2
    if (reason === 'time-quantile') return 3
    return 4
  }
  const candidates = [...positions]
    .sort((left, right) => reasonPriority(left.reason) - reasonPriority(right.reason)
      || right.count - left.count
      || left.date.localeCompare(right.date))
  const extraPositionOrder = (sample: AgentTimelineSamplePosition): Array<'start' | 'middle' | 'end'> => {
    if (sample.position === 'start') return ['middle', 'end']
    if (sample.position === 'end') return ['middle', 'start']
    return ['start', 'end']
  }

  for (let round = 0; positions.length < totalWindowCount && round < 2; round += 1) {
    for (const candidate of candidates) {
      if (positions.length >= totalWindowCount) break
      const position = extraPositionOrder(candidate)[round]
      const minimumNonOverlappingMessages = expectedWindowMessages * (round + 2)
      if (candidate.count < minimumNonOverlappingMessages) continue
      if (positions.some((sample) => sample.date === candidate.date && sample.position === position)) continue
      const maximumMiddleOffset = Math.max(0, candidate.count - expectedWindowMessages)
      positions.push({
        ...candidate,
        position,
        offset: position === 'middle' ? Math.floor(maximumMiddleOffset / 2) : 0,
      })
    }
  }

  const positionRank = { start: 0, middle: 1, end: 2 }
  return positions
    .sort((left, right) => left.date.localeCompare(right.date) || positionRank[left.position] - positionRank[right.position])
    .slice(0, totalWindowCount)
}

export function normalizeAgentRawTokenBudget(value: unknown): number {
  const requested = Math.floor(Number(value) || AGENT_RAW_PAGE_DEFAULT_TOKENS)
  return Math.max(AGENT_RAW_PAGE_MIN_TOKENS, Math.min(AGENT_RAW_PAGE_MAX_TOKENS, requested))
}

export function normalizeAgentTimelineWindowTokenBudget(value: unknown): number {
  const requested = Math.floor(Number(value) || AGENT_TIMELINE_WINDOW_DEFAULT_TOKENS)
  return Math.max(AGENT_RAW_PAGE_MIN_TOKENS, Math.min(AGENT_TIMELINE_WINDOW_MAX_TOKENS, requested))
}

export function estimateAgentRawTextTokens(value: string): number {
  if (!value) return 0
  let ascii = 0
  let nonAscii = 0
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.45)
}

function splitFormattedRawMessageBlocks(value: string): string[] {
  return safeText(value)
    .split(/(?=^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\|)/m)
    .map((block) => block.trim())
    .filter((block) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\|/.test(block))
}

export function countAgentRawMessageBlocks(value: string): number {
  return splitFormattedRawMessageBlocks(value).length
}

export function summarizeAgentRawPageTextCoverage(pages: Array<{
  key: string
  scopeKey?: string
  pageText: string
}>): {
  rawMessageBlocks: number
  uniqueRawMessages: number
  duplicateRawMessages: number
  duplicateRatio: number
  distinctScopes: number
} {
  const normalizedPages = pages.map((page) => ({
    key: safeText(page.key),
    scopeKey: safeText(page.scopeKey),
    pageText: safeText(page.pageText),
  }))
  const rawMessageBlocks = normalizedPages.reduce(
    (sum, page) => sum + countAgentRawMessageBlocks(page.pageText),
    0,
  )
  const deduplicated = deduplicateAgentRawPageTexts(normalizedPages)
  const uniqueRawMessages = deduplicated.reduce(
    (sum, page) => sum + countAgentRawMessageBlocks(page.pageText),
    0,
  )
  const duplicateRawMessages = Math.max(0, rawMessageBlocks - uniqueRawMessages)
  return {
    rawMessageBlocks,
    uniqueRawMessages,
    duplicateRawMessages,
    duplicateRatio: rawMessageBlocks > 0 ? duplicateRawMessages / rawMessageBlocks : 0,
    distinctScopes: new Set(normalizedPages.map((page) => page.scopeKey).filter(Boolean)).size,
  }
}

export function deduplicateAgentRawPageTexts(pages: Array<{
  key: string
  scopeKey?: string
  priority?: boolean
  pageText: string
}>): Array<{ key: string; scopeKey?: string; priority?: boolean; pageText: string; duplicateBlocks: number }> {
  const seenBlocks = new Set<string>()
  return pages.map((page) => {
    const scopeKey = safeText(page.scopeKey)
    const uniqueBlocks: string[] = []
    let duplicateBlocks = 0
    for (const block of splitFormattedRawMessageBlocks(page.pageText)) {
      const blockKey = `${scopeKey}\u0001${block}`
      if (seenBlocks.has(blockKey)) {
        duplicateBlocks += 1
        continue
      }
      seenBlocks.add(blockKey)
      uniqueBlocks.push(block)
    }
    return {
      key: safeText(page.key),
      scopeKey: scopeKey || undefined,
      priority: page.priority === true || undefined,
      pageText: uniqueBlocks.join('\n'),
      duplicateBlocks,
    }
  })
}

export function allocateAgentRawPageTokenBudgets(
  pages: Array<{ key: string; scopeKey?: string; priority?: boolean; pageText: string }>,
  totalTokenBudget: number,
  priorityTermsValue: string[] = [],
): Map<string, number> {
  const allocations = new Map<string, number>()
  const priorityTerms = Array.from(new Set(priorityTermsValue.map(safeText).filter(Boolean)))
  const selectDistributed = <T>(values: T[], count: number): T[] => {
    if (count <= 0 || values.length === 0) return []
    if (count >= values.length) return [...values]
    if (count === 1) return [values[Math.floor((values.length - 1) / 2)]]
    return Array.from({ length: count }, (_, index) => values[Math.round((index * (values.length - 1)) / (count - 1))])
      .filter((value, index, selected) => selected.indexOf(value) === index)
  }
  let pending = pages
    .map((page, index) => ({
      key: safeText(page.key),
      scopeKey: safeText(page.scopeKey),
      priority: page.priority === true,
      pageText: safeText(page.pageText),
      needed: estimateAgentRawTextTokens(page.pageText),
      index,
    }))
    .filter((page) => page.key)
  for (const page of pending) allocations.set(page.key, 0)
  const isPriority = (page: (typeof pending)[number]) => page.priority
    || (priorityTerms.length > 0 && priorityTerms.some((term) => page.pageText.includes(term)))
  let remaining = Math.max(0, Math.floor(Number(totalTokenBudget) || 0))
  // 把紧张的合成预算分摊到每一页，可能使各页低于 excerptAgentRawPageText 的有效下限，
  // 实际上丢掉全部原文。这里改为保留按时间分布的页子集，同时留下包含模型所选
  // 导航词项的页面。
  const minimumUsefulExcerptTokens = 500
  const minimumRetainedCost = (page: (typeof pending)[number]) => Math.max(
    1,
    Math.min(page.needed, minimumUsefulExcerptTokens),
  )
  const minimumBudgetForEveryPage = pending.reduce((sum, page) => sum + minimumRetainedCost(page), 0)
  if (pending.length > 1 && remaining < minimumBudgetForEveryPage) {
    const sortedMinimumCosts = pending.map(minimumRetainedCost).sort((left, right) => left - right)
    let maximumPages = 0
    let selectedMinimumCost = 0
    for (const cost of sortedMinimumCosts) {
      if (selectedMinimumCost + cost > remaining) break
      selectedMinimumCost += cost
      maximumPages += 1
    }
    maximumPages = Math.max(1, Math.min(pending.length, maximumPages))
    const pagesByScope = new Map<string, typeof pending>()
    for (const page of pending) {
      const groupKey = page.scopeKey || '__single_scope__'
      const group = pagesByScope.get(groupKey) || []
      group.push(page)
      pagesByScope.set(groupKey, group)
    }
    const scopeGroups = Array.from(pagesByScope.values())
    const selectedGroups = selectDistributed(scopeGroups, Math.min(scopeGroups.length, maximumPages))
    const selected: typeof pending = []
    for (const group of selectedGroups) {
      const preferred = group.filter(isPriority)
      selected.push(selectDistributed(preferred.length > 0 ? preferred : group, 1)[0])
    }
    const selectedKeys = new Set(selected.map((page) => page.key))
    const remainingCandidates = pending.filter((page) => !selectedKeys.has(page.key))
    for (const page of selectDistributed(remainingCandidates, maximumPages - selected.length)) {
      selected.push(page)
      selectedKeys.add(page.key)
    }
    pending = pending.filter((page) => selectedKeys.has(page.key))
  }

  const sourceGroups = new Map<string, typeof pending>()
  for (const page of pending) {
    const groupKey = page.scopeKey || '__single_scope__'
    const group = sourceGroups.get(groupKey) || []
    group.push(page)
    sourceGroups.set(groupKey, group)
  }
  const sourceBudgets = new Map<string, number>()
  const unsettledSources = Array.from(sourceGroups.entries())
    .map(([scopeKey, sourcePages]) => ({
      scopeKey,
      needed: sourcePages.reduce((sum, page) => sum + page.needed, 0),
    }))
    .sort((left, right) => left.needed - right.needed || left.scopeKey.localeCompare(right.scopeKey))
  let sourceBudgetRemaining = remaining
  for (let index = 0; index < unsettledSources.length; index += 1) {
    const source = unsettledSources[index]
    const fairShare = Math.floor(sourceBudgetRemaining / Math.max(1, unsettledSources.length - index))
    if (source.needed <= fairShare) {
      sourceBudgets.set(source.scopeKey, source.needed)
      sourceBudgetRemaining -= source.needed
      continue
    }
    for (let rest = index; rest < unsettledSources.length; rest += 1) {
      sourceBudgets.set(unsettledSources[rest].scopeKey, fairShare)
    }
    sourceBudgetRemaining = 0
    break
  }

  const allocateWithinSource = (sourcePages: typeof pending, sourceTokenBudget: number) => {
    let sourceRemaining = Math.max(0, sourceTokenBudget)
    let retainedPages = [...sourcePages]
    const minimumNeeded = (page: (typeof pending)[number]) => Math.max(
      1,
      Math.min(page.needed, minimumUsefulExcerptTokens),
    )
    const totalMinimumNeeded = retainedPages.reduce((sum, page) => sum + minimumNeeded(page), 0)
    if (retainedPages.length > 1 && sourceRemaining < totalMinimumNeeded) {
      const sortedCosts = retainedPages.map(minimumNeeded).sort((left, right) => left - right)
      let affordableCount = 0
      let affordableCost = 0
      for (const cost of sortedCosts) {
        if (affordableCost + cost > sourceRemaining) break
        affordableCost += cost
        affordableCount += 1
      }
      affordableCount = Math.max(1, Math.min(retainedPages.length, affordableCount))
      const priorityPages = retainedPages.filter(isPriority)
      const ordinaryPages = retainedPages.filter((page) => !isPriority(page))
      const priorityCount = priorityPages.length > 0
        ? Math.min(priorityPages.length, affordableCount, Math.max(1, Math.ceil(affordableCount * 0.75)))
        : 0
      const ordinaryCount = ordinaryPages.length > 0
        ? Math.min(ordinaryPages.length, affordableCount - priorityCount)
        : 0
      const selected: typeof retainedPages = [
        ...selectDistributed(priorityPages, priorityCount),
        ...selectDistributed(ordinaryPages, ordinaryCount),
      ]
      const selectedKeys = new Set(selected.map((page) => page.key))
      const remainingCandidates = [
        ...priorityPages.filter((page) => !selectedKeys.has(page.key)),
        ...ordinaryPages.filter((page) => !selectedKeys.has(page.key)),
      ]
      for (const page of selectDistributed(remainingCandidates, affordableCount - selected.length)) {
        selected.push(page)
        selectedKeys.add(page.key)
      }
      retainedPages = retainedPages.filter((page) => selectedKeys.has(page.key))
    }

    // 每个保留页面先获得足以容纳连贯摘录的空间，优先级只分配剩余的细节预算，
    // 因此聚焦页面不会让所有时间背景或其他候选来源的上下文消失。
    for (const page of retainedPages) {
      const base = Math.min(sourceRemaining, minimumNeeded(page))
      allocations.set(page.key, base)
      sourceRemaining -= base
    }
    if (sourceRemaining <= 0) return

    const priorityGroups = retainedPages.some(isPriority)
      ? [retainedPages.filter(isPriority), retainedPages.filter((page) => !isPriority(page))]
      : [retainedPages]
    for (let groupIndex = 0; groupIndex < priorityGroups.length; groupIndex += 1) {
      const group = priorityGroups[groupIndex]
        .filter((page) => (allocations.get(page.key) || 0) < page.needed)
        .sort((left, right) => left.needed - right.needed || left.index - right.index)
      if (group.length === 0 || sourceRemaining <= 0) continue
      const groupBudget = priorityGroups.length === 1
        ? sourceRemaining
        : groupIndex === 0
          ? Math.floor(sourceTokenBudget * 0.7)
          : sourceRemaining
      let groupRemaining = Math.min(sourceRemaining, groupBudget)
      for (let index = 0; index < group.length; index += 1) {
        const page = group[index]
        const current = allocations.get(page.key) || 0
        const remainingNeed = Math.max(0, page.needed - current)
        const fairShare = Math.floor(groupRemaining / Math.max(1, group.length - index))
        if (remainingNeed <= fairShare) {
          allocations.set(page.key, current + remainingNeed)
          groupRemaining -= remainingNeed
          sourceRemaining -= remainingNeed
          continue
        }
        for (let rest = index; rest < group.length; rest += 1) {
          const restPage = group[rest]
          allocations.set(restPage.key, (allocations.get(restPage.key) || 0) + fairShare)
        }
        sourceRemaining -= fairShare * (group.length - index)
        groupRemaining = 0
        break
      }
    }
  }
  for (const [scopeKey, sourcePages] of sourceGroups) {
    allocateWithinSource(sourcePages, sourceBudgets.get(scopeKey) || 0)
  }
  return allocations
}

export function excerptAgentRawPageText(
  pageTextValue: string,
  tokenBudgetValue: number,
  priorityTermsValue: string[] = [],
): string {
  const pageText = safeText(pageTextValue)
  const tokenBudget = Math.max(0, Math.floor(Number(tokenBudgetValue) || 0))
  if (!pageText || tokenBudget === 0) return ''
  if (estimateAgentRawTextTokens(pageText) <= tokenBudget) return pageText
  const blocks = splitFormattedRawMessageBlocks(pageText)
  if (blocks.length === 0 || tokenBudget < 500) return ''
  const priorityTerms = Array.from(new Set(priorityTermsValue.map(safeText).filter(Boolean)))

  const buildExcerpt = (workingBudget: number) => {
    const selected = new Map<number, string>()
    const addWindow = (center: number, requestedBudget: number) => {
      const order: number[] = [center]
      for (let radius = 1; radius < blocks.length; radius += 1) {
        if (center - radius >= 0) order.push(center - radius)
        if (center + radius < blocks.length) order.push(center + radius)
      }
      let remainingWindow = Math.max(60, requestedBudget)
      let addedInWindow = 0
      for (const blockIndex of order) {
        if (selected.has(blockIndex)) continue
        const block = blocks[blockIndex]
        const blockTokens = estimateAgentRawTextTokens(block)
        if (blockTokens <= remainingWindow) {
          selected.set(blockIndex, block)
          remainingWindow -= blockTokens
          addedInWindow += 1
          continue
        }
        if (addedInWindow === 0 && remainingWindow >= 60) {
          const keepCharacters = Math.max(80, Math.floor(block.length * (remainingWindow / Math.max(1, blockTokens))))
          selected.set(blockIndex, `${block.slice(0, keepCharacters)}\n[该条长消息后部因当前工具返回预算省略]`)
        }
        break
      }
    }

    const priorityCenters = priorityTerms.flatMap((term) => {
      const matches: number[] = []
      for (let index = 0; index < blocks.length; index += 1) {
        if (blocks[index].includes(term)) matches.push(index)
      }
      return matches.length > 0 ? [matches[Math.floor((matches.length - 1) / 2)]] : []
    })
    const uniquePriorityCenters = Array.from(new Set(priorityCenters))
    const priorityBudget = uniquePriorityCenters.length > 0 ? Math.floor(workingBudget * 0.65) : 0
    const priorityWindowBudget = Math.max(60, Math.floor(priorityBudget / Math.max(1, uniquePriorityCenters.length)))
    for (const center of uniquePriorityCenters) addWindow(center, priorityWindowBudget)

    const distributedBudget = Math.max(0, workingBudget - priorityBudget)
    const windowCount = Math.min(blocks.length, Math.max(3, Math.min(7, Math.floor(distributedBudget / 400))))
    const windowBudget = Math.max(60, Math.floor((distributedBudget - windowCount * 24) / windowCount))
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
      const center = windowCount === 1
        ? 0
        : Math.round((blocks.length - 1) * (windowIndex / (windowCount - 1)))
      addWindow(center, windowBudget)
    }
    const ordered = Array.from(selected.entries()).sort((left, right) => left[0] - right[0])
    const output: string[] = []
    let previousIndex = -2
    for (const [blockIndex, block] of ordered) {
      if (blockIndex > previousIndex + 1) output.push('[因当前工具返回预算省略该页部分普通消息]')
      output.push(block)
      previousIndex = blockIndex
    }
    if (previousIndex < blocks.length - 1) output.push('[因当前工具返回预算省略该页部分普通消息]')
    return output.join('\n')
  }

  let excerpt = buildExcerpt(tokenBudget)
  const excerptTokens = estimateAgentRawTextTokens(excerpt)
  if (excerptTokens > tokenBudget) {
    excerpt = buildExcerpt(Math.max(500, Math.floor(tokenBudget * (tokenBudget / excerptTokens) * 0.9)))
  }
  return excerpt
}

export function formatAgentRawTime(timestamp: number): string {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return 'unknown-time'
  const date = new Date(value > 10_000_000_000 ? value : value * 1000)
  if (Number.isNaN(date.getTime())) return 'unknown-time'
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatAgentRawMessage(record: AgentRawMessageRecord): string {
  const body = safeText(record.content) || `[${safeText(record.messageType) || 'unknown'}]`
  const quote = safeText(record.quotedContent)
  const quoteSuffix = quote
    ? `\n  > ${safeText(record.quotedSender) || '引用'}: ${quote.replace(/\n/g, '\n  > ')}`
    : ''
  const media = [
    record.voiceRef ? `voice=${record.voiceRef}` : '',
    record.imageRef ? `image=${record.imageRef}` : '',
  ].filter(Boolean).join(',')
  const kind = safeText(record.messageType) || 'text'
  const kindColumn = kind === 'text' && !media ? '' : `|${kind}${media ? `|${media}` : ''}`
  return `${formatAgentRawTime(record.createTime)}|${safeText(record.sender) || '未知'}${kindColumn}|${body}${quoteSuffix}`
}

export function selectAgentRawPage(
  records: AgentRawMessageRecord[],
  tokenBudgetValue: unknown,
  minimumTokenBudgetValue = AGENT_RAW_PAGE_MIN_TOKENS,
): AgentRawPageSelection {
  const minimumTokenBudget = Math.max(160, Math.min(
    AGENT_RAW_PAGE_MIN_TOKENS,
    Math.floor(Number(minimumTokenBudgetValue) || AGENT_RAW_PAGE_MIN_TOKENS),
  ))
  const tokenBudget = Math.max(minimumTokenBudget, Math.min(
    AGENT_RAW_PAGE_MAX_TOKENS,
    Math.floor(Number(tokenBudgetValue) || AGENT_RAW_PAGE_DEFAULT_TOKENS),
  ))
  if (records.length === 0) return { records: [], consumed: 0, estimatedTokens: 0 }

  const minimumBeforeNaturalBreak = Math.floor(tokenBudget * 0.68)
  const selected: AgentRawMessageRecord[] = []
  let estimatedTokens = 0

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const lineTokens = estimateAgentRawTextTokens(formatAgentRawMessage(record)) + 6
    if (selected.length > 0 && estimatedTokens + lineTokens > tokenBudget) break
    selected.push(record)
    estimatedTokens += lineTokens

    const next = records[index + 1]
    if (!next || estimatedTokens < minimumBeforeNaturalBreak) continue
    const currentSeconds = record.createTime > 10_000_000_000 ? record.createTime / 1000 : record.createTime
    const nextSeconds = next.createTime > 10_000_000_000 ? next.createTime / 1000 : next.createTime
    if (Math.abs(nextSeconds - currentSeconds) >= 30 * 60) break
  }

  return {
    records: selected,
    consumed: selected.length,
    estimatedTokens,
  }
}

export function selectAgentCenteredRawPage(
  recordsValue: AgentRawMessageRecord[],
  anchorValue: AgentRawMessageRecord,
  tokenBudgetValue: unknown,
  minimumTokenBudgetValue = 160,
): AgentRawPageSelection {
  const records = [...recordsValue]
    .filter((record) => Number(record.createTime) > 0)
    .sort((left, right) => left.createTime - right.createTime || left.sortSeq - right.sortSeq || left.localId - right.localId)
  const anchorIndex = records.findIndex((record) => (
    record === anchorValue
    || (
      record.localId === anchorValue?.localId
      && record.createTime === anchorValue?.createTime
      && record.sortSeq === anchorValue?.sortSeq
    )
  ))
  if (anchorIndex < 0) return selectAgentRawPage(records, tokenBudgetValue, minimumTokenBudgetValue)
  const minimumTokenBudget = Math.max(160, Math.min(
    AGENT_RAW_PAGE_MIN_TOKENS,
    Math.floor(Number(minimumTokenBudgetValue) || 160),
  ))
  const tokenBudget = Math.max(minimumTokenBudget, Math.min(
    AGENT_RAW_PAGE_MAX_TOKENS,
    Math.floor(Number(tokenBudgetValue) || minimumTokenBudget),
  ))
  const selected = new Set<number>([anchorIndex])
  let estimatedTokens = estimateAgentRawTextTokens(formatAgentRawMessage(records[anchorIndex])) + 6
  for (let distance = 1; distance < records.length; distance += 1) {
    let added = false
    for (const index of [anchorIndex - distance, anchorIndex + distance]) {
      if (index < 0 || index >= records.length || selected.has(index)) continue
      const lineTokens = estimateAgentRawTextTokens(formatAgentRawMessage(records[index])) + 6
      if (estimatedTokens + lineTokens > tokenBudget) continue
      selected.add(index)
      estimatedTokens += lineTokens
      added = true
    }
    if (!added && anchorIndex - distance < 0 && anchorIndex + distance >= records.length) break
  }
  return {
    records: Array.from(selected).sort((left, right) => left - right).map((index) => records[index]),
    consumed: selected.size,
    estimatedTokens,
  }
}

export function encodeAgentRawPageCursor(cursor: AgentRawPageCursor): string {
  const normalized: AgentRawPageCursor = {
    version: 1,
    sessionId: safeText(cursor.sessionId).slice(0, 512),
    startTime: Math.max(0, Math.floor(Number(cursor.startTime) || 0)),
    endTime: Math.max(0, Math.floor(Number(cursor.endTime) || 0)),
    direction: cursor.direction === 'backward' ? 'backward' : 'forward',
    offset: Math.max(0, Math.floor(Number(cursor.offset) || 0)),
  }
  if (!normalized.sessionId) throw new Error('原文页游标缺少会话')
  return Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url')
}

export function decodeAgentRawPageCursor(value: unknown): AgentRawPageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(safeText(value), 'base64url').toString('utf8')) as Partial<AgentRawPageCursor>
    if (parsed.version !== 1 || !safeText(parsed.sessionId)) return null
    if (parsed.direction !== 'forward' && parsed.direction !== 'backward') return null
    const startTime = Math.max(0, Math.floor(Number(parsed.startTime) || 0))
    const endTime = Math.max(0, Math.floor(Number(parsed.endTime) || 0))
    const offset = Math.max(0, Math.floor(Number(parsed.offset) || 0))
    if (startTime > 0 && endTime > 0 && startTime > endTime) return null
    return {
      version: 1,
      sessionId: safeText(parsed.sessionId),
      startTime,
      endTime,
      direction: parsed.direction,
      offset,
    }
  } catch {
    return null
  }
}

export function agentRawPageHash(records: AgentRawMessageRecord[]): string {
  return createHash('sha256')
    .update(records.map((record) => [
      record.sessionId,
      record.localId,
      record.messageKey || '',
      record.createTime,
      record.sortSeq,
      record.sender,
      record.messageType,
      record.content,
      record.quotedSender || '',
      record.quotedContent || '',
    ].join('\u0001')).join('\u0002')).digest('base64url')
}

export function agentRawPageCacheFingerprint(input: {
  accountFingerprint?: string
  sessionId: string
  startTime: number
  endTime: number
  direction: AgentRawPageDirection
  offset: number
  tokenBudget: number
  tailWatermark?: string
}): string {
  return createHash('sha256').update(JSON.stringify({
    version: AGENT_RAW_PAGE_FORMAT_VERSION,
    accountFingerprint: safeText(input.accountFingerprint),
    sessionId: safeText(input.sessionId),
    startTime: Math.max(0, Math.floor(Number(input.startTime) || 0)),
    endTime: Math.max(0, Math.floor(Number(input.endTime) || 0)),
    direction: input.direction === 'backward' ? 'backward' : 'forward',
    offset: Math.max(0, Math.floor(Number(input.offset) || 0)),
    tokenBudget: normalizeAgentRawTokenBudget(input.tokenBudget),
    tailWatermark: safeText(input.tailWatermark),
  })).digest('base64url')
}
