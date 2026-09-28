import { formatRelationshipAchievementEvidence } from './evaluator'
import {
  RelationshipAchievementContent,
  type RelationshipJourneyMomentContentId
} from './catalog'
import type {
  RelationshipAchievementChatApi,
  RelationshipAchievementCollection,
  RelationshipAchievementItem,
  RelationshipJourneyMessage
} from './types'

const DAY_SECONDS = 24 * 60 * 60
const SEGMENT_GAP_SECONDS = 30 * 60
const INCREMENTAL_OVERLAP_SECONDS = 3 * 60 * 60
const RETURN_GAP_SECONDS = 30 * DAY_SECONDS
const RETURN_WINDOW_SECONDS = DAY_SECONDS
const COLD_RETURN_GAP_SECONDS = 90 * DAY_SECONDS
const COLD_RETURN_WINDOW_SECONDS = 7 * DAY_SECONDS
const INITIATOR_GAP_SECONDS = 8 * 60 * 60
const DEFAULT_BATCH_SIZE = 800
const DEFAULT_MAX_MESSAGES = 50_000
const SCAN_CACHE_TTL_MS = 10 * 60 * 1_000
export const RELATIONSHIP_JOURNEY_ALGORITHM_VERSION = 'v5-local-achievements1'
const MAX_CONFLICT_EPISODE_DRAFTS = 3
const PRE_CONTEXT_TURNS = 10
const MAX_CONTEXT_TURNS = 36
const CONTEXT_HEAD_TURNS = 18
const MAX_CONTEXT_TEXT_LENGTH = 120

const STRONG_NEGATIVE_WORDS = [
  '你每次', '你从来', '够了', '别说了', '不想理', '烦死', '讨厌', '滚', '闭嘴',
  '分手', '拉黑', '失望', '太过分', '不可理喻', '有病', '算了吧', '别联系', '为什么总是'
]

const MODERATE_NEGATIVE_WORDS = [
  '生气', '难受', '委屈', '吵', '冷静一下', '别烦', '不理解', '不尊重', '敷衍',
  '无语', '呵呵', '随便', '爱怎样怎样', '不想说了'
]

const EXPLICIT_REPAIR_WORDS = [
  '对不起', '抱歉', '我错了', '原谅我', '和好', '不吵了'
]

const SOFT_REPAIR_WORDS = [
  '别生气', '没事了', '好好说', '我理解', '谢谢你愿意', '还是想和你说', '别难过'
]

const THIRD_PARTY_CONTEXT_WORDS = [
  '他说', '她说', '他俩', '她俩', '他们', '她们', '别人', '人家', '前任',
  '同事', '同学', '室友', '家里人', '老板', '客户', '朋友说', '群里',
  '电影', '电视剧', '小说', '剧情', '转发', '原话'
]

const DIRECT_ADDRESS_WORDS = ['你', '你们', '咱俩', '咱们', '我们之间']
const DIRECT_COMMAND_WORDS = ['滚', '闭嘴', '够了', '别说了', '别联系', '不想理', '拉黑', '分手']
const NEGATION_PREFIXES = ['不想', '不要', '不愿', '不会', '没有', '没想', '并不', '不是']
const THIRD_PERSON_SUBJECT_PATTERN = /(?:你|你们).{0,4}(?:说|觉得|认为|问|听说|知道).{0,8}(?:他|她|我)/

export type RelationshipJourneyMomentKind = RelationshipJourneyMomentContentId

export type RelationshipJourneyMomentState = 'observed'

export interface RelationshipJourneyMoment {
  id: string
  kind: RelationshipJourneyMomentKind
  state: RelationshipJourneyMomentState
  occurredAt: number
  endedAt?: number
  parentId?: string
  title: string
  copy: string
  goalCopy: string
  evidence: string
}

export interface RelationshipJourneyScanResult {
  status: 'idle' | 'loading' | 'ready' | 'partial' | 'error'
  moments: RelationshipJourneyMoment[]
  thresholdReachedAt: Record<string, number>
  scannedMessages: number
  truncated: boolean
  semanticReview?: RelationshipJourneySemanticReview
  /** Cache-safe state used by the main process to resume without rescanning history. */
  checkpoint?: RelationshipJourneyScanCheckpoint
  error?: string
}

export interface RelationshipJourneyScanCheckpoint {
  version: 1
  algorithmVersion: string
  /** Earliest timestamp needed to rebuild a segment that crosses the scan boundary. */
  resumeFromTimestamp: number
  /** Highest committed message timestamp from the previous run. */
  watermarkTimestamp: number
  /** Stable, content-free identities for messages sharing the watermark second. */
  watermarkTokens: string[]
  unknownMessageThresholdIds: string[]
  scannedMessages: number
  firstTimestamp: number
  previousJourneyTimestamp: number
  activeDays: string[]
  activeYears: number[]
  activeMonths: number[]
  seasonMasks: Array<{ year: number; mask: number }>
  dayStats: Array<{ date: string; count: number; firstTimestamp: number }>
  newYearStats: Array<{
    year: number
    before: number
    after: number
    mine: number
    peer: number
    lastBefore?: number
    firstAfter?: number
  }>
  firstImageAt: { mine?: number; peer?: number }
  mutualImageDayCount: number
  currentImageDay?: string
  currentImageDayMask: number
  initiatorCounts: { mine: number; peer: number }
  returnWindow?: {
    start: number
    end: number
    gapDays: number
    count: number
    mine: number
    peer: number
  }
  coldReturnWindow?: {
    start: number
    end: number
    gapDays: number
    count: number
    mine: number
    peer: number
  }
  /** Explicit index requested by the UI; entries are monotonic within an account/session. */
  completedAchievementIds: string[]
  sourceExhausted: boolean
  sourceState?: {
    totalRows: number
    firstTimestamp: number
    lastTimestamp: number
    maxMessages: number
  }
}

export type RelationshipJourneyConflictVerdict =
  | 'peer_conflict'
  | 'shared_external_hostility'
  | 'third_party_discussion'
  | 'playful_banter'
  | 'unclear'

export type RelationshipJourneyConflictTarget = 'each_other' | 'external' | 'mixed' | 'unknown'

export interface RelationshipJourneyAdjudicationTurn {
  index: number
  offsetSeconds: number
  speaker: 'A' | 'B'
  text: string
  ruleSignal: boolean
}

export interface RelationshipJourneyConflictCandidate {
  id: string
  type: 'peer_conflict_candidate'
  deterministicConfidence: number
  turns: RelationshipJourneyAdjudicationTurn[]
}

export interface RelationshipJourneyConflictDecision {
  candidateId: string
  verdict: RelationshipJourneyConflictVerdict
  target: RelationshipJourneyConflictTarget
  mutual: boolean
  contextSufficient: boolean
  confidence: number
  evidenceTurnIndexes?: number[]
  reasonCodes?: string[]
}

export type RelationshipJourneyConflictBatchAdjudicator = (
  candidates: RelationshipJourneyConflictCandidate[]
) => Promise<RelationshipJourneyConflictDecision[]>

export interface RelationshipJourneySemanticReview {
  status: 'not-needed' | 'disabled' | 'complete' | 'failed'
  reviewed: number
  accepted: number
}

export interface RelationshipJourneyScanProgress {
  scannedMessages: number
  maxMessages: number
}

export interface LoadRelationshipJourneyMomentsOptions {
  api?: RelationshipAchievementChatApi
  signal?: AbortSignal
  batchSize?: number
  maxMessages?: number
  cacheKey?: string
  forceRefresh?: boolean
  onProgress?: (progress: RelationshipJourneyScanProgress) => void
  adjudicateConflictCandidates?: RelationshipJourneyConflictBatchAdjudicator
  /** A validated, cache-safe result from an earlier scan of the same account/session. */
  resumeResult?: RelationshipJourneyScanResult
}

type Direction = 'mine' | 'peer' | 'unknown'

interface SegmentAccumulator {
  start: number
  end: number
  total: number
  mine: number
  peer: number
  unknown: number
  alternations: number
  lastDirection: Direction
  deepStart?: number
  deepEnd?: number
  deepTotal: number
  deepMine: number
  deepPeer: number
  negativeScore: number
  negativeTurns: number
  negativeMine: number
  negativePeer: number
  strongNegativeCount: number
  directNegativeHits: number
  firstStrongAt?: number
  lastNegativeAt?: number
  explicitRepairCount: number
  softRepairCount: number
  firstRepairAt?: number
  repairDirection?: Direction
  replyAfterRepair: boolean
  postRepairTotal: number
  postRepairMine: number
  postRepairPeer: number
  recentContextTurns: InternalContextTurn[]
  conflictContextTurns?: InternalContextTurn[]
}

interface InternalContextTurn {
  timestamp: number
  direction: 'mine' | 'peer'
  text: string
  ruleSignal: boolean
}

interface ReconciliationDraft {
  occurredAt: number
  endedAt: number
  deterministicConfidence: number
}

interface ConflictEpisodeDraft {
  id: string
  occurredAt: number
  lastNegativeAt: number
  deterministicConfidence: number
  contextTurns: InternalContextTurn[]
  reconciliation?: ReconciliationDraft
}

interface SensitiveJourneyDraftState {
  conflicts: ConflictEpisodeDraft[]
}

interface ReturnWindow {
  start: number
  end: number
  gapDays: number
  count: number
  mine: number
  peer: number
}

interface DayAccumulator {
  count: number
  firstTimestamp: number
}

interface NewYearAccumulator {
  year: number
  before: number
  after: number
  mine: number
  peer: number
  lastBefore?: number
  firstAfter?: number
}

export interface RelationshipJourneyNode {
  id: string
  lane: 'mainline' | 'branch'
  state: 'recorded'
  occurredAt?: number
  title: string
  copy: string
  goalCopy: string
  evidence: string
  side: 'start' | 'end'
  achievement?: RelationshipAchievementItem
  moment?: RelationshipJourneyMoment
  parentId?: string
}

interface ColdReturnWindow extends ReturnWindow {}

export interface RelationshipJourneyViewModel {
  nodes: RelationshipJourneyNode[]
  /** Locked mainline details stay out of the renderer model until they are reached. */
  futureState: 'locked' | 'unknown' | 'unwritten'
  quality: 'loading' | 'complete' | 'partial' | 'unavailable'
}

const journeyScanCache = new Map<string, { result: RelationshipJourneyScanResult; updatedAt: number }>()

const directionOf = (message: RelationshipJourneyMessage): Direction => {
  if (message.isSend === 1) return 'mine'
  if (message.isSend === 0) return 'peer'
  return 'unknown'
}

const normalizeTimestamp = (value: unknown): number => {
  let numeric = Math.floor(Number(value || 0))
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  while (numeric > 10_000_000_000) numeric = Math.floor(numeric / 1_000)
  return numeric
}

const localDateKey = (timestamp: number): string => {
  const date = new Date(timestamp * 1_000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const readableText = (message: RelationshipJourneyMessage): string => {
  if (message.localType !== 1) return ''
  const value = String(message.parsedContent || message.rawContent || message.content || '').trim()
  if (!value || /^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b|&lt;)/i.test(value)) {
    return ''
  }
  return value.slice(0, 280)
}

const localMonthSerial = (timestamp: number): number => {
  const date = new Date(timestamp * 1_000)
  return date.getFullYear() * 12 + date.getMonth()
}

const hasConsecutiveMonths = (months: Set<number>, current: number, required: number): boolean => {
  for (let offset = 0; offset < required; offset += 1) {
    if (!months.has(current - offset)) return false
  }
  return true
}

const sanitizeContextText = (value: string): string => String(value || '')
  .replace(/https?:\/\/\S+|www\.\S+/gi, '[链接]')
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱]')
  .replace(/\baccountId_[a-z0-9_-]+\b/gi, '[账号]')
  .replace(/@[\w\u4e00-\u9fff-]{2,32}/g, '@某人')
  .replace(/\b(?:\d[\s-]?){7,}\d\b/g, '[号码]')
  .replace(/(?:[a-z]:\\|\\\\|\/Users\/|\/home\/)[^<>\r\n，。！？；]+/gi, '[路径]')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_CONTEXT_TEXT_LENGTH)

const wordScore = (text: string, words: string[], score: number): { score: number; matches: number } => {
  let matches = 0
  for (const word of words) {
    let fromIndex = 0
    while (fromIndex < text.length) {
      const matchIndex = text.indexOf(word, fromIndex)
      if (matchIndex < 0) break
      const prefix = text.slice(Math.max(0, matchIndex - 6), matchIndex)
      if (!NEGATION_PREFIXES.some((negation) => prefix.includes(negation))) matches += 1
      fromIndex = matchIndex + word.length
    }
  }
  return { score: matches * score, matches }
}

interface SemanticTextSignals {
  strongScore: number
  strongMatches: number
  moderateScore: number
  moderateMatches: number
  explicitRepairMatches: number
  softRepairMatches: number
}

const firstContainedIndex = (text: string, words: string[]): number => {
  let earliest = -1
  for (const word of words) {
    const index = text.indexOf(word)
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index
  }
  return earliest
}

const clauseDirectlyAddressesPeer = (clause: string): boolean => {
  const addressIndex = firstContainedIndex(clause, DIRECT_ADDRESS_WORDS)
  if (addressIndex < 0) return false
  const thirdPartyIndex = firstContainedIndex(clause, THIRD_PARTY_CONTEXT_WORDS)
  return thirdPartyIndex < 0 || addressIndex < thirdPartyIndex
}

const explicitRepairIntentMatches = (clause: string): number => {
  if (
    /(?:你|你们|他|她|他们|她们).{0,8}(?:为什么不|怎么不|应该|该|能不能|说|讲).{0,8}(?:对不起|抱歉|和好)/.test(clause) ||
    /我.{0,4}(?:不是|没有|没想|不想).{0,4}错了/.test(clause)
  ) {
    return 0
  }
  const lexicalMatches = wordScore(clause, EXPLICIT_REPAIR_WORDS, 1).matches
  if (lexicalMatches === 0 && !/我.{0,3}(?:真的)?错了/.test(clause)) return 0
  const senderOwnsRepair = /^(?:真的)?(?:对不起|抱歉)/.test(clause) ||
    /我.{0,3}(?:真的)?(?:错了|对不起|抱歉)/.test(clause) ||
    clause.includes('原谅我') ||
    /^(?:我们|咱们).{0,3}(?:和好|不吵了)/.test(clause) ||
    /^(?:和好吧|不吵了)/.test(clause)
  return senderOwnsRepair ? Math.max(1, lexicalMatches) : 0
}

const semanticTextSignals = (text: string): SemanticTextSignals => {
  const signals: SemanticTextSignals = {
    strongScore: 0,
    strongMatches: 0,
    moderateScore: 0,
    moderateMatches: 0,
    explicitRepairMatches: 0,
    softRepairMatches: 0
  }
  const clauses = text.split(/[，,。！？!?；;\n]+/).map((clause) => clause.trim()).filter(Boolean)
  let activeTarget: 'peer' | 'third' | 'unknown' = 'unknown'
  for (const clause of clauses) {
    const shiftedToThirdPerson = THIRD_PERSON_SUBJECT_PATTERN.test(clause)
    const thirdPartyContext = shiftedToThirdPerson || THIRD_PARTY_CONTEXT_WORDS.some((word) => clause.includes(word))
    const directlyAddressed = !shiftedToThirdPerson && clauseDirectlyAddressesPeer(clause)
    const compact = clause.replace(/\s+/g, '')
    const shortDirectCommand = compact.length <= 12 &&
      DIRECT_COMMAND_WORDS.some((word) => compact.includes(word)) &&
      !thirdPartyContext
    if (directlyAddressed || shortDirectCommand) activeTarget = 'peer'
    else if (thirdPartyContext) activeTarget = 'third'
    const directNegative = directlyAddressed ||
      (activeTarget === 'peer' && !thirdPartyContext) ||
      shortDirectCommand

    if (directNegative) {
      const strong = wordScore(clause, STRONG_NEGATIVE_WORDS, 3)
      const moderate = wordScore(clause, MODERATE_NEGATIVE_WORDS, 1)
      signals.strongScore += strong.score
      signals.strongMatches += strong.matches
      signals.moderateScore += moderate.score
      signals.moderateMatches += moderate.matches
    }

    // A second-person clause remains relevant even if it mentions a colleague or
    // another context: “你总拿同事当借口” is still directed at this conversation.
    if (activeTarget !== 'third' || directlyAddressed) {
      signals.explicitRepairMatches += explicitRepairIntentMatches(clause)
      signals.softRepairMatches += wordScore(clause, SOFT_REPAIR_WORDS, 1).matches
    }
  }
  return signals
}

const appendBoundedContextTurn = (
  turns: InternalContextTurn[],
  turn: InternalContextTurn
): void => {
  turns.push(turn)
  if (turns.length > MAX_CONTEXT_TURNS) {
    // Preserve the beginning where the target is usually established and the
    // newest replies where that target may be clarified.
    turns.splice(CONTEXT_HEAD_TURNS, turns.length - MAX_CONTEXT_TURNS)
  }
}

const captureContextTurn = (
  segment: SegmentAccumulator,
  timestamp: number,
  direction: Direction,
  text: string,
  signals: SemanticTextSignals,
  ruleSignal: boolean
): void => {
  if (direction !== 'mine' && direction !== 'peer') return
  const sanitized = sanitizeContextText(text)
  if (!sanitized) return
  const turn: InternalContextTurn = {
    timestamp,
    direction,
    text: sanitized,
    ruleSignal
  }
  if (segment.conflictContextTurns) {
    appendBoundedContextTurn(segment.conflictContextTurns, turn)
    return
  }
  if (signals.strongMatches > 0) {
    segment.conflictContextTurns = [...segment.recentContextTurns]
    appendBoundedContextTurn(segment.conflictContextTurns, turn)
    return
  }
  segment.recentContextTurns.push(turn)
  if (segment.recentContextTurns.length > PRE_CONTEXT_TURNS) {
    segment.recentContextTurns.splice(0, segment.recentContextTurns.length - PRE_CONTEXT_TURNS)
  }
}

const createSegment = (timestamp: number): SegmentAccumulator => ({
  start: timestamp,
  end: timestamp,
  total: 0,
  mine: 0,
  peer: 0,
  unknown: 0,
  alternations: 0,
  lastDirection: 'unknown',
  deepTotal: 0,
  deepMine: 0,
  deepPeer: 0,
  negativeScore: 0,
  negativeTurns: 0,
  negativeMine: 0,
  negativePeer: 0,
  strongNegativeCount: 0,
  directNegativeHits: 0,
  explicitRepairCount: 0,
  softRepairCount: 0,
  replyAfterRepair: false,
  postRepairTotal: 0,
  postRepairMine: 0,
  postRepairPeer: 0,
  recentContextTurns: []
})

const addMessageToSegment = (segment: SegmentAccumulator, message: RelationshipJourneyMessage): void => {
  const timestamp = normalizeTimestamp(message.createTime)
  const direction = directionOf(message)
  segment.end = Math.max(segment.end, timestamp)
  segment.total += 1
  segment[direction] += 1
  if (
    direction !== 'unknown' &&
    segment.lastDirection !== 'unknown' &&
    direction !== segment.lastDirection
  ) {
    segment.alternations += 1
  }
  if (direction !== 'unknown') segment.lastDirection = direction

  const hour = new Date(timestamp * 1_000).getHours()
  if (hour >= 23 || hour < 5) {
    segment.deepStart = segment.deepStart === undefined ? timestamp : Math.min(segment.deepStart, timestamp)
    segment.deepEnd = segment.deepEnd === undefined ? timestamp : Math.max(segment.deepEnd, timestamp)
    segment.deepTotal += 1
    if (direction === 'mine') segment.deepMine += 1
    if (direction === 'peer') segment.deepPeer += 1
  }

  const text = readableText(message)
  if (!text) return
  const signals = semanticTextSignals(text)
  const hasRepairIntent = signals.explicitRepairMatches > 0 || signals.softRepairMatches > 0
  // A strong direct expression always wins. Without one, explicit repair phrases
  // such as “不吵了” and “别生气” must not be swallowed by their inner keywords.
  const negativeMatches = signals.strongMatches + (
    hasRepairIntent && signals.strongMatches === 0 ? 0 : signals.moderateMatches
  )
  captureContextTurn(
    segment,
    timestamp,
    direction,
    text,
    signals,
    negativeMatches > 0 || hasRepairIntent
  )

  if (negativeMatches > 0) {
    segment.negativeScore += signals.strongScore + (
      hasRepairIntent && signals.strongMatches === 0 ? 0 : signals.moderateScore
    )
    segment.negativeTurns += 1
    if (direction === 'mine') segment.negativeMine += 1
    if (direction === 'peer') segment.negativePeer += 1
    segment.strongNegativeCount += signals.strongMatches
    segment.directNegativeHits += signals.strongMatches
    if (signals.strongMatches > 0 && segment.firstStrongAt === undefined) segment.firstStrongAt = timestamp
    segment.lastNegativeAt = timestamp
    // A new negative turn invalidates an earlier repair attempt. The automatic
    // model only records reconciliation after a stable, two-sided continuation.
    segment.explicitRepairCount = 0
    segment.softRepairCount = 0
    segment.firstRepairAt = undefined
    segment.repairDirection = undefined
    segment.replyAfterRepair = false
    segment.postRepairTotal = 0
    segment.postRepairMine = 0
    segment.postRepairPeer = 0
    return
  }

  if (
    segment.firstRepairAt !== undefined &&
    timestamp > segment.firstRepairAt &&
    direction !== 'unknown' &&
    segment.repairDirection !== undefined &&
    direction !== segment.repairDirection
  ) {
    segment.replyAfterRepair = true
  }
  if (segment.firstRepairAt !== undefined && timestamp > segment.firstRepairAt) {
    segment.postRepairTotal += 1
    if (direction === 'mine') segment.postRepairMine += 1
    if (direction === 'peer') segment.postRepairPeer += 1
  }
  if (hasRepairIntent) {
    segment.explicitRepairCount += signals.explicitRepairMatches
    segment.softRepairCount += signals.softRepairMatches
    if (segment.firstRepairAt === undefined) {
      segment.firstRepairAt = timestamp
      segment.repairDirection = direction
    }
  }
}

const hasMoment = (moments: RelationshipJourneyMoment[], kind: RelationshipJourneyMomentKind): boolean =>
  moments.some((moment) => moment.kind === kind)

const formatDuration = (seconds: number): string => {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`
}

const createMomentId = (kind: RelationshipJourneyMomentKind, timestamp: number): string =>
  `${kind}:${Math.floor(timestamp)}`

const conflictConfidence = (segment: SegmentAccumulator): number => Math.min(100,
  Math.min(35, segment.negativeScore * 2 + segment.strongNegativeCount * 4) +
  (segment.negativeMine > 0 && segment.negativePeer > 0 ? 20 : 0) +
  Math.min(20, segment.alternations * 3) +
  (segment.total >= 16 ? 10 : segment.total >= 10 ? 7 : 0) +
  Math.min(15, segment.directNegativeHits * 6)
)

const repairConfidence = (segment: SegmentAccumulator, afterTimestamp: number): number => {
  if (
    !segment.firstRepairAt ||
    segment.firstRepairAt <= Math.max(afterTimestamp + 5 * 60, segment.lastNegativeAt || 0) ||
    !(segment.explicitRepairCount >= 1 || segment.softRepairCount >= 2) ||
    !segment.replyAfterRepair ||
    segment.postRepairTotal < 4 ||
    segment.postRepairMine < 1 ||
    segment.postRepairPeer < 1
  ) {
    return 0
  }
  return Math.min(100,
    (segment.explicitRepairCount >= 1 ? 30 : 24) +
    20 +
    Math.min(20, segment.postRepairTotal * 4) +
    15 +
    10
  )
}

const finalizeSegment = (
  segment: SegmentAccumulator | null,
  moments: RelationshipJourneyMoment[],
  sensitiveDrafts: SensitiveJourneyDraftState,
  allowTurningPoints = true
): void => {
  if (!segment || segment.total === 0) return
  const duration = Math.max(0, segment.end - segment.start)
  const bothParticipated = segment.mine > 0 && segment.peer > 0

  if (
    !hasMoment(moments, 'long-conversation') &&
    duration >= 45 * 60 &&
    segment.total >= 40 &&
    bothParticipated
  ) {
    moments.push({
      id: createMomentId('long-conversation', segment.start),
      kind: 'long-conversation',
      state: 'observed',
      occurredAt: segment.start,
      endedAt: segment.end,
      ...RelationshipAchievementContent.getJourneyMoment('long-conversation'),
      evidence: `一段连续对话持续 ${formatDuration(duration)}，双方共留下 ${segment.total} 条记录`
    })
  }

  if (
    !hasMoment(moments, 'back-and-forth') &&
    segment.alternations >= 30 &&
    segment.mine >= 10 &&
    segment.peer >= 10
  ) {
    moments.push({
      id: createMomentId('back-and-forth', segment.end),
      kind: 'back-and-forth',
      state: 'observed',
      occurredAt: segment.end,
      ...RelationshipAchievementContent.getJourneyMoment('back-and-forth'),
      evidence: `同一段连续对话中方向交替 ${segment.alternations} 次，你发送 ${segment.mine} 条，对方发送 ${segment.peer} 条`
    })
  }

  if (
    !hasMoment(moments, 'across-midnight') &&
    bothParticipated &&
    segment.total >= 20 &&
    localDateKey(segment.start) !== localDateKey(segment.end)
  ) {
    moments.push({
      id: createMomentId('across-midnight', segment.end),
      kind: 'across-midnight',
      state: 'observed',
      occurredAt: segment.end,
      ...RelationshipAchievementContent.getJourneyMoment('across-midnight'),
      evidence: `一段连续对话从 ${localDateKey(segment.start)} 延续到 ${localDateKey(segment.end)}，双方合计 ${segment.total} 条消息`
    })
  }

  const deepDuration = segment.deepStart && segment.deepEnd
    ? Math.max(0, segment.deepEnd - segment.deepStart)
    : 0
  if (
    !hasMoment(moments, 'late-night-conversation') &&
    deepDuration >= 30 * 60 &&
    segment.deepTotal >= 24 &&
    segment.deepMine >= 5 &&
    segment.deepPeer >= 5
  ) {
    moments.push({
      id: createMomentId('late-night-conversation', segment.deepStart as number),
      kind: 'late-night-conversation',
      state: 'observed',
      occurredAt: segment.deepStart as number,
      endedAt: segment.deepEnd,
      ...RelationshipAchievementContent.getJourneyMoment('late-night-conversation'),
      evidence: `23:00—05:00 之间持续 ${formatDuration(deepDuration)}，双方都在回应`
    })
  }

  const denseEnough = duration <= 3 * 60 * 60 && segment.total >= 10
  const confidence = conflictConfidence(segment)
  const highConfidenceConflict = Boolean(
    allowTurningPoints &&
    denseEnough &&
    segment.mine >= 3 &&
    segment.peer >= 3 &&
    segment.alternations >= 4 &&
    segment.negativeTurns >= 3 &&
    segment.negativeMine >= 1 &&
    segment.negativePeer >= 1 &&
    segment.negativeScore >= 10 &&
    segment.strongNegativeCount >= 2 &&
    segment.directNegativeHits >= 2 &&
    confidence >= 75 &&
    segment.firstStrongAt
  )
  let activeDraft: ConflictEpisodeDraft | undefined = sensitiveDrafts.conflicts[sensitiveDrafts.conflicts.length - 1]
  let droppedConflictWindow = false
  if (highConfidenceConflict && segment.firstStrongAt) {
    const occurredAt = segment.firstStrongAt
    const lastNegativeAt = segment.lastNegativeAt || segment.end
    // Never merge rule-only windows before semantic review. A gaming outburst
    // followed by a real peer conflict would otherwise inherit the gaming date.
    if (sensitiveDrafts.conflicts.length < MAX_CONFLICT_EPISODE_DRAFTS) {
      activeDraft = {
        id: `peer-conflict-draft:${Math.floor(occurredAt)}`,
        occurredAt,
        lastNegativeAt,
        deterministicConfidence: confidence,
        contextTurns: [...(segment.conflictContextTurns || [])]
      }
      sensitiveDrafts.conflicts.push(activeDraft)
    } else {
      droppedConflictWindow = true
    }
  }

  activeDraft = droppedConflictWindow
    ? undefined
    : sensitiveDrafts.conflicts[sensitiveDrafts.conflicts.length - 1]
  const episodeLastNegativeAt = activeDraft?.lastNegativeAt
  const automaticRepairConfidence = episodeLastNegativeAt
    ? repairConfidence(segment, episodeLastNegativeAt)
    : 0
  if (
    allowTurningPoints &&
    activeDraft &&
    episodeLastNegativeAt &&
    !activeDraft.reconciliation &&
    bothParticipated &&
    segment.total >= 8 &&
    segment.firstRepairAt &&
    segment.firstRepairAt > episodeLastNegativeAt &&
    segment.firstRepairAt - episodeLastNegativeAt <= 7 * DAY_SECONDS &&
    automaticRepairConfidence >= 75
  ) {
    activeDraft.reconciliation = {
      occurredAt: segment.firstRepairAt,
      endedAt: segment.end,
      deterministicConfidence: automaticRepairConfidence
    }
  }
}

const buildAdjudicationCandidate = (
  draft: ConflictEpisodeDraft
): RelationshipJourneyConflictCandidate => {
  const orderedTurns = [...draft.contextTurns]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(0, MAX_CONTEXT_TURNS)
  const baseTimestamp = orderedTurns[0]?.timestamp || draft.occurredAt
  return {
    id: draft.id,
    type: 'peer_conflict_candidate',
    deterministicConfidence: draft.deterministicConfidence,
    turns: orderedTurns.map((turn, index) => ({
      index,
      offsetSeconds: Math.max(0, turn.timestamp - baseTimestamp),
      speaker: turn.direction === 'mine' ? 'A' : 'B',
      text: turn.text,
      ruleSignal: turn.ruleSignal
    }))
  }
}

const CONFLICT_VERDICTS = new Set<RelationshipJourneyConflictVerdict>([
  'peer_conflict',
  'shared_external_hostility',
  'third_party_discussion',
  'playful_banter',
  'unclear'
])

const CONFLICT_TARGETS = new Set<RelationshipJourneyConflictTarget>([
  'each_other',
  'external',
  'mixed',
  'unknown'
])

const isValidConflictDecision = (
  value: unknown,
  candidateId: string
): value is RelationshipJourneyConflictDecision => {
  if (!value || typeof value !== 'object') return false
  const decision = value as Partial<RelationshipJourneyConflictDecision>
  if (decision.candidateId !== candidateId) return false
  if (!CONFLICT_VERDICTS.has(decision.verdict as RelationshipJourneyConflictVerdict)) return false
  if (!CONFLICT_TARGETS.has(decision.target as RelationshipJourneyConflictTarget)) return false
  if (typeof decision.mutual !== 'boolean' || typeof decision.contextSufficient !== 'boolean') return false
  if (
    typeof decision.confidence !== 'number' ||
    !Number.isFinite(decision.confidence) ||
    decision.confidence < 0 ||
    decision.confidence > 1
  ) return false
  if (
    decision.evidenceTurnIndexes !== undefined &&
    (!Array.isArray(decision.evidenceTurnIndexes) ||
      decision.evidenceTurnIndexes.some((index) => !Number.isInteger(index) || index < 0))
  ) return false
  if (
    decision.reasonCodes !== undefined &&
    (!Array.isArray(decision.reasonCodes) ||
      decision.reasonCodes.some((reason) => typeof reason !== 'string'))
  ) return false
  return true
}

const isAcceptedPeerConflict = (decision: RelationshipJourneyConflictDecision): boolean =>
  decision.verdict === 'peer_conflict' &&
  decision.target === 'each_other' &&
  decision.mutual &&
  decision.contextSufficient &&
  decision.confidence >= 0.85 &&
  decision.reasonCodes?.includes('direct_mutual_attack') === true &&
  !decision.reasonCodes.some((reason) => [
    'game_or_competition',
    'shared_external_target',
    'third_party_discussion',
    'quoted_or_reported',
    'playful_banter',
    'ambiguous_target',
    'context_insufficient'
  ].includes(reason))

const materializeAcceptedConflict = (
  moments: RelationshipJourneyMoment[],
  draft: ConflictEpisodeDraft,
  decision: RelationshipJourneyConflictDecision
): void => {
  const argumentId = createMomentId('first-argument', draft.occurredAt)
  moments.push({
    id: argumentId,
    kind: 'first-argument',
    state: 'observed',
    occurredAt: draft.occurredAt,
    endedAt: draft.lastNegativeAt,
    ...RelationshipAchievementContent.getJourneyMoment('first-argument'),
    evidence: `本地规则初筛后又通过 AI 语义复核；规则置信度 ${draft.deterministicConfidence}%，语境置信度 ${Math.round(decision.confidence * 100)}%`
  })
  if (!draft.reconciliation) return
  moments.push({
    id: createMomentId('first-reconciliation', draft.reconciliation.occurredAt),
    kind: 'first-reconciliation',
    state: 'observed',
    occurredAt: draft.reconciliation.occurredAt,
    endedAt: draft.reconciliation.endedAt,
    parentId: argumentId,
    ...RelationshipAchievementContent.getJourneyMoment('first-reconciliation'),
    evidence: `已确认的争执片段之后，本地规则识别到明确缓和表达、对方回应与后续稳定交流，规则置信度 ${draft.reconciliation.deterministicConfidence}%`
  })
}

const reviewSensitiveDrafts = async (
  sensitiveDrafts: SensitiveJourneyDraftState,
  moments: RelationshipJourneyMoment[],
  options: LoadRelationshipJourneyMomentsOptions
): Promise<RelationshipJourneySemanticReview> => {
  const drafts = sensitiveDrafts.conflicts.slice(0, MAX_CONFLICT_EPISODE_DRAFTS)
  if (drafts.length === 0) return { status: 'not-needed', reviewed: 0, accepted: 0 }
  if (!options.adjudicateConflictCandidates) {
    return { status: 'disabled', reviewed: 0, accepted: 0 }
  }
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const candidates = drafts.map(buildAdjudicationCandidate)
  if (candidates.some((candidate) => candidate.turns.length === 0)) {
    return { status: 'failed', reviewed: 0, accepted: 0 }
  }
  let decisions: RelationshipJourneyConflictDecision[]
  try {
    decisions = await options.adjudicateConflictCandidates(candidates)
  } catch (error) {
    // Only the caller's signal cancels the whole scan. Provider timeouts and
    // provider-owned AbortErrors fail closed for sensitive nodes while keeping
    // objective journey milestones available.
    if (options.signal?.aborted) throw error
    return { status: 'failed', reviewed: 0, accepted: 0 }
  }
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (!Array.isArray(decisions) || decisions.length !== candidates.length) {
    return { status: 'failed', reviewed: 0, accepted: 0 }
  }
  const decisionsById = new Map<string, RelationshipJourneyConflictDecision>()
  for (const decision of decisions) {
    const candidateId = typeof decision?.candidateId === 'string' ? decision.candidateId : ''
    if (!candidateId || decisionsById.has(candidateId)) {
      return { status: 'failed', reviewed: 0, accepted: 0 }
    }
    const matchingCandidate = candidates.find((candidate) => candidate.id === candidateId)
    if (!matchingCandidate || !isValidConflictDecision(decision, matchingCandidate.id)) {
      return { status: 'failed', reviewed: 0, accepted: 0 }
    }
    decisionsById.set(candidateId, decision)
  }
  const acceptedIndex = candidates.findIndex((candidate) => {
    const decision = decisionsById.get(candidate.id)
    return Boolean(decision && isAcceptedPeerConflict(decision))
  })
  if (acceptedIndex >= 0) {
    const acceptedDraft: ConflictEpisodeDraft = {
      ...drafts[acceptedIndex],
      contextTurns: drafts[acceptedIndex].contextTurns,
      reconciliation: drafts[acceptedIndex].reconciliation
        ? { ...drafts[acceptedIndex].reconciliation }
        : undefined
    }
    // Merge only later windows that independently passed semantic review.
    // Rejected gaming/third-party windows can never move the published date.
    for (let index = acceptedIndex + 1; index < drafts.length; index += 1) {
      const laterDecision = decisionsById.get(candidates[index].id)
      const laterDraft = drafts[index]
      if (
        !laterDecision ||
        !isAcceptedPeerConflict(laterDecision) ||
        laterDraft.occurredAt <= acceptedDraft.lastNegativeAt ||
        laterDraft.occurredAt - acceptedDraft.lastNegativeAt > 7 * DAY_SECONDS
      ) continue
      acceptedDraft.lastNegativeAt = Math.max(acceptedDraft.lastNegativeAt, laterDraft.lastNegativeAt)
      acceptedDraft.deterministicConfidence = Math.max(
        acceptedDraft.deterministicConfidence,
        laterDraft.deterministicConfidence
      )
      if (!acceptedDraft.reconciliation && laterDraft.reconciliation) {
        acceptedDraft.reconciliation = { ...laterDraft.reconciliation }
      }
    }
    materializeAcceptedConflict(
      moments,
      acceptedDraft,
      decisionsById.get(candidates[acceptedIndex].id) as RelationshipJourneyConflictDecision
    )
  }
  return {
    status: 'complete',
    reviewed: candidates.length,
    accepted: acceptedIndex >= 0 ? 1 : 0
  }
}

const getDefaultJourneyApi = (): RelationshipAchievementChatApi | null => {
  if (typeof window === 'undefined') return null
  const chatApi = window.electronAPI?.chat
  if (!chatApi?.getRelationshipJourneyMoments && !chatApi?.getMessages) return null
  return chatApi as RelationshipAchievementChatApi
}

export const clearRelationshipJourneyScanCache = (sessionId?: string): void => {
  if (!sessionId) {
    journeyScanCache.clear()
    return
  }
  const normalizedSessionId = String(sessionId).trim()
  const prefix = `${RELATIONSHIP_JOURNEY_ALGORITHM_VERSION}:${normalizedSessionId}:`
  for (const key of journeyScanCache.keys()) {
    if (key === `${RELATIONSHIP_JOURNEY_ALGORITHM_VERSION}:${normalizedSessionId}` || key.startsWith(prefix)) {
      journeyScanCache.delete(key)
    }
  }
}

export const createRelationshipJourneyScanLoadingState = (): RelationshipJourneyScanResult => ({
  status: 'loading',
  moments: [],
  thresholdReachedAt: {},
  scannedMessages: 0,
  truncated: false
})

const normalizeCheckpointNumber = (value: unknown): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0
}

const normalizeJourneyCheckpoint = (
  result?: RelationshipJourneyScanResult
): RelationshipJourneyScanCheckpoint | null => {
  const checkpoint = result?.checkpoint
  if (
    !checkpoint ||
    checkpoint.version !== 1 ||
    checkpoint.algorithmVersion !== RELATIONSHIP_JOURNEY_ALGORITHM_VERSION ||
    !Array.isArray(checkpoint.watermarkTokens) ||
    !Array.isArray(checkpoint.unknownMessageThresholdIds) ||
    !Array.isArray(checkpoint.activeDays) ||
    !Array.isArray(checkpoint.activeYears) ||
    !Array.isArray(checkpoint.activeMonths) ||
    !Array.isArray(checkpoint.seasonMasks) ||
    !Array.isArray(checkpoint.dayStats) ||
    !Array.isArray(checkpoint.newYearStats) ||
    !Array.isArray(checkpoint.completedAchievementIds)
  ) {
    return null
  }
  return checkpoint
}

const messageBoundaryToken = (message: RelationshipJourneyMessage, timestamp: number): string => {
  const source = `${normalizeCheckpointNumber(message.localId)}:${normalizeCheckpointNumber(message.localType)}:${message.isSend ?? ''}:${timestamp}`
  let first = 2166136261
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 2246822519)
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`
}

export const loadRelationshipJourneyMoments = async (
  sessionId: string,
  options: LoadRelationshipJourneyMomentsOptions = {}
): Promise<RelationshipJourneyScanResult> => {
  const api = options.api || getDefaultJourneyApi()
  if (!api?.getRelationshipJourneyMoments && !api?.getMessages) {
    return {
      status: 'error',
      moments: [],
      thresholdReachedAt: {},
      scannedMessages: 0,
      truncated: false,
      error: '当前环境无法读取旅程片段'
    }
  }

  const batchSize = Math.max(100, Math.min(2_000, Math.floor(options.batchSize || DEFAULT_BATCH_SIZE)))
  const maxMessages = Math.max(1_000, Math.min(100_000, Math.floor(options.maxMessages || DEFAULT_MAX_MESSAGES)))
  const cacheKey = `${RELATIONSHIP_JOURNEY_ALGORITHM_VERSION}:${String(options.cacheKey || sessionId).trim()}`
  const cached = journeyScanCache.get(cacheKey)
  if (
    !api.getRelationshipJourneyMoments &&
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.updatedAt <= SCAN_CACHE_TTL_MS
  ) {
    return cached.result
  }
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (api.getRelationshipJourneyMoments) {
    const response = await api.getRelationshipJourneyMoments(sessionId, maxMessages, options.forceRefresh)
    if (!response?.success || !response.data || typeof response.data !== 'object') {
      return {
        status: 'error',
        moments: [],
        thresholdReachedAt: {},
        scannedMessages: 0,
        truncated: false,
        error: response?.error || '本地旅程分析没有返回可用结果'
      }
    }
    const result = response.data as RelationshipJourneyScanResult
    if (!Array.isArray(result.moments) || !result.thresholdReachedAt) {
      return {
        status: 'error',
        moments: [],
        thresholdReachedAt: {},
        scannedMessages: 0,
        truncated: false,
        error: '本地旅程分析结果格式无效'
      }
    }
    return result
  }
  const resumeCheckpoint = options.forceRefresh ? null : normalizeJourneyCheckpoint(options.resumeResult)
  const resumeResult = resumeCheckpoint ? options.resumeResult : undefined
  const moments: RelationshipJourneyMoment[] = resumeResult
    ? resumeResult.moments.map((moment) => ({ ...moment }))
    : []
  const sensitiveDrafts: SensitiveJourneyDraftState = { conflicts: [] }
  const thresholdReachedAt: Record<string, number> = resumeResult
    ? { ...resumeResult.thresholdReachedAt }
    : {}
  const unknownMessageThresholds = new Set<string>(resumeCheckpoint?.unknownMessageThresholdIds || [])
  const activeDays = new Set<string>(resumeCheckpoint?.activeDays || [])
  const activeYears = new Set<number>(resumeCheckpoint?.activeYears || [])
  const activeMonths = new Set<number>(resumeCheckpoint?.activeMonths || [])
  const seasonMasks = new Map<number, number>(
    (resumeCheckpoint?.seasonMasks || []).map((entry) => [entry.year, entry.mask])
  )
  const dayStats = new Map<string, DayAccumulator>(
    (resumeCheckpoint?.dayStats || []).map((entry) => [entry.date, {
      count: normalizeCheckpointNumber(entry.count),
      firstTimestamp: normalizeCheckpointNumber(entry.firstTimestamp)
    }])
  )
  const newYearStats = new Map<number, NewYearAccumulator>(
    (resumeCheckpoint?.newYearStats || []).map((entry) => [entry.year, { ...entry }])
  )
  const firstImageAt: Partial<Record<'mine' | 'peer', number>> = {
    ...(resumeCheckpoint?.firstImageAt || {})
  }
  let mutualImageDayCount = normalizeCheckpointNumber(resumeCheckpoint?.mutualImageDayCount)
  let currentImageDay = String(resumeCheckpoint?.currentImageDay || '')
  let currentImageDayMask = normalizeCheckpointNumber(resumeCheckpoint?.currentImageDayMask)
  const initiatorCounts = {
    mine: normalizeCheckpointNumber(resumeCheckpoint?.initiatorCounts?.mine),
    peer: normalizeCheckpointNumber(resumeCheckpoint?.initiatorCounts?.peer)
  }
  let segment: SegmentAccumulator | null = null
  let returnWindow: ReturnWindow | null = resumeCheckpoint?.returnWindow
    ? { ...resumeCheckpoint.returnWindow }
    : null
  let coldReturnWindow: ColdReturnWindow | null = resumeCheckpoint?.coldReturnWindow
    ? { ...resumeCheckpoint.coldReturnWindow }
    : null
  let previousJourneyTimestamp = 0
  let previousCommittedJourneyTimestamp = normalizeCheckpointNumber(resumeCheckpoint?.previousJourneyTimestamp)
  let firstTimestamp = normalizeCheckpointNumber(resumeCheckpoint?.firstTimestamp)
  let offset = 0
  let scannedMessages = normalizeCheckpointNumber(resumeCheckpoint?.scannedMessages)
  let processedThisRun = 0
  let hasMore = true
  let error: string | undefined
  const previousWatermarkTimestamp = normalizeCheckpointNumber(resumeCheckpoint?.watermarkTimestamp)
  const previousWatermarkTokens = new Set(resumeCheckpoint?.watermarkTokens || [])
  let watermarkTimestamp = previousWatermarkTimestamp
  let watermarkTokens = new Set(resumeCheckpoint?.watermarkTokens || [])

  const addReturnMessage = (timestamp: number, direction: Direction) => {
    if (!returnWindow || timestamp > returnWindow.end) return
    returnWindow.count += 1
    if (direction === 'mine') returnWindow.mine += 1
    if (direction === 'peer') returnWindow.peer += 1
    if (
      !hasMoment(moments, 'return-after-silence') &&
      returnWindow.count >= 10 &&
      returnWindow.mine > 0 &&
      returnWindow.peer > 0
    ) {
      moments.push({
        id: createMomentId('return-after-silence', returnWindow.start),
        kind: 'return-after-silence',
        state: 'observed',
        occurredAt: returnWindow.start,
        ...RelationshipAchievementContent.getJourneyMoment('return-after-silence'),
        evidence: `当前本地记录曾留白 ${returnWindow.gapDays} 天，恢复后一天内双方都再次留下消息`
      })
    }
  }

  const addColdReturnMessage = (timestamp: number, direction: Direction) => {
    if (!coldReturnWindow || timestamp > coldReturnWindow.end) return
    coldReturnWindow.count += 1
    if (direction === 'mine') coldReturnWindow.mine += 1
    if (direction === 'peer') coldReturnWindow.peer += 1
    if (
      !hasMoment(moments, 'warm-after-silence') &&
      coldReturnWindow.count >= 100 &&
      coldReturnWindow.mine >= 10 &&
      coldReturnWindow.peer >= 10
    ) {
      moments.push({
        id: createMomentId('warm-after-silence', timestamp),
        kind: 'warm-after-silence',
        state: 'observed',
        occurredAt: timestamp,
        ...RelationshipAchievementContent.getJourneyMoment('warm-after-silence'),
        evidence: `本地记录曾连续留白 ${coldReturnWindow.gapDays} 天，恢复后 7 天内双方合计 ${coldReturnWindow.count} 条消息，其中你 ${coldReturnWindow.mine} 条、对方 ${coldReturnWindow.peer} 条`
      })
    }
  }

  try {
    while (hasMore && processedThisRun < maxMessages) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const remaining = maxMessages - processedThisRun
      const response = await api.getMessages!(
        sessionId,
        offset,
        Math.min(batchSize, remaining),
        normalizeCheckpointNumber(resumeCheckpoint?.resumeFromTimestamp),
        0,
        true
      )
      if (!response?.success) throw new Error(response?.error || '读取聊天片段失败')

      // Both supported APIs return ascending rows. Keep that database order so even
      // legacy rows with an invalid timestamp still contribute to raw message-count
      // milestones without being moved to an artificial point in the journey.
      const messages = (response.messages || [])
        .map((message) => ({ message, timestamp: normalizeTimestamp(message.createTime) }))

      for (const { message, timestamp } of messages) {
        if (processedThisRun >= maxMessages) break
        const boundaryToken = messageBoundaryToken(message, timestamp)
        const isNewMessage = !resumeCheckpoint ||
          timestamp > previousWatermarkTimestamp ||
          (timestamp === previousWatermarkTimestamp && !previousWatermarkTokens.has(boundaryToken))
        if (isNewMessage) {
          processedThisRun += 1
          scannedMessages += 1
          if (timestamp > watermarkTimestamp) {
            watermarkTimestamp = timestamp
            watermarkTokens = new Set([boundaryToken])
          } else if (timestamp === watermarkTimestamp) {
            watermarkTokens.add(boundaryToken)
          }
        }

        if (isNewMessage && timestamp > 0 && !firstTimestamp) {
          firstTimestamp = timestamp
          thresholdReachedAt.first_page = timestamp
        }
        const messageThresholds: Array<[number, string]> = [
          [100, 'messages_100'],
          [1_000, 'messages_1000'],
          [10_000, 'messages_10000'],
          [50_000, 'messages_50000']
        ]
        for (const [threshold, id] of messageThresholds) {
          if (
            isNewMessage &&
            scannedMessages >= threshold &&
            thresholdReachedAt[id] === undefined &&
            !unknownMessageThresholds.has(id)
          ) {
            if (timestamp > 0) thresholdReachedAt[id] = timestamp
            else unknownMessageThresholds.add(id)
          }
        }

        // A row without a usable timestamp can count toward a message milestone,
        // but cannot safely be used for dated or semantic journey moments.
        if (timestamp <= 0) continue

        const direction = directionOf(message)

        const dateKey = localDateKey(timestamp)
        if (isNewMessage && !activeDays.has(dateKey)) {
          activeDays.add(dateKey)
          const activeDayThresholds: Array<[number, string]> = [
            [7, 'active_days_7'],
            [30, 'active_days_30'],
            [100, 'active_days_100'],
            [365, 'active_days_365']
          ]
          for (const [threshold, id] of activeDayThresholds) {
            if (activeDays.size >= threshold && thresholdReachedAt[id] === undefined) {
              thresholdReachedAt[id] = timestamp
            }
          }
        }

        const date = new Date(timestamp * 1_000)
        const year = date.getFullYear()
        if (isNewMessage && !activeYears.has(year)) {
          activeYears.add(year)
          const yearThresholds: Array<[number, string]> = [
            [2, 'years_2'],
            [3, 'years_3'],
            [5, 'years_5']
          ]
          for (const [threshold, id] of yearThresholds) {
            if (activeYears.size >= threshold && thresholdReachedAt[id] === undefined) {
              thresholdReachedAt[id] = timestamp
            }
          }
        }
        if (isNewMessage && firstTimestamp && timestamp - firstTimestamp >= 365 * DAY_SECONDS && !thresholdReachedAt.span_365) {
          thresholdReachedAt.span_365 = timestamp
        }

        if (message.isVisibleForJourney === false) continue

        if (isNewMessage) {
          const day = dayStats.get(dateKey)
          dayStats.set(dateKey, day
            ? { count: day.count + 1, firstTimestamp: Math.min(day.firstTimestamp, timestamp) }
            : { count: 1, firstTimestamp: timestamp })

          const monthSerial = localMonthSerial(timestamp)
          if (!activeMonths.has(monthSerial)) {
            activeMonths.add(monthSerial)
            if (
              !hasMoment(moments, 'monthly-continuity') &&
              hasConsecutiveMonths(activeMonths, monthSerial, 12)
            ) {
              moments.push({
                id: createMomentId('monthly-continuity', timestamp),
                kind: 'monthly-continuity',
                state: 'observed',
                occurredAt: timestamp,
                ...RelationshipAchievementContent.getJourneyMoment('monthly-continuity'),
                evidence: `截至 ${year} 年 ${date.getMonth() + 1} 月，连续 12 个自然月都有本地消息记录`
              })
            }
          }

          const seasonBit = 1 << Math.floor(date.getMonth() / 3)
          const seasonMask = (seasonMasks.get(year) || 0) | seasonBit
          seasonMasks.set(year, seasonMask)
          if (!hasMoment(moments, 'four-seasons') && seasonMask === 0b1111) {
            moments.push({
              id: createMomentId('four-seasons', timestamp),
              kind: 'four-seasons',
              state: 'observed',
              occurredAt: timestamp,
              ...RelationshipAchievementContent.getJourneyMoment('four-seasons'),
              evidence: `${year} 年的四个季度都留下过本地消息记录`
            })
          }
        }

        if (isNewMessage) {
          const beginsNewConversation = previousCommittedJourneyTimestamp === 0 ||
            timestamp - previousCommittedJourneyTimestamp >= INITIATOR_GAP_SECONDS
          if (
            beginsNewConversation &&
            (direction === 'mine' || direction === 'peer') &&
            !hasMoment(moments, 'mutual-initiators')
          ) {
            initiatorCounts[direction] += 1
            if (initiatorCounts.mine >= 10 && initiatorCounts.peer >= 10) {
              moments.push({
                id: createMomentId('mutual-initiators', timestamp),
                kind: 'mutual-initiators',
                state: 'observed',
                occurredAt: timestamp,
                ...RelationshipAchievementContent.getJourneyMoment('mutual-initiators'),
                evidence: `间隔至少 8 小时视为新对话；你主动开启 ${initiatorCounts.mine} 次，对方主动开启 ${initiatorCounts.peer} 次`
              })
            }
          }

          if (
            previousCommittedJourneyTimestamp > 0 &&
            timestamp - previousCommittedJourneyTimestamp >= RETURN_GAP_SECONDS &&
            !hasMoment(moments, 'return-after-silence')
          ) {
            returnWindow = {
              start: timestamp,
              end: timestamp + RETURN_WINDOW_SECONDS,
              gapDays: Math.floor((timestamp - previousCommittedJourneyTimestamp) / DAY_SECONDS),
              count: 0,
              mine: 0,
              peer: 0
            }
          } else if (returnWindow && timestamp > returnWindow.end && !hasMoment(moments, 'return-after-silence')) {
            returnWindow = null
          }
          addReturnMessage(timestamp, direction)

          if (
            previousCommittedJourneyTimestamp > 0 &&
            timestamp - previousCommittedJourneyTimestamp >= COLD_RETURN_GAP_SECONDS &&
            !hasMoment(moments, 'warm-after-silence')
          ) {
            coldReturnWindow = {
              start: timestamp,
              end: timestamp + COLD_RETURN_WINDOW_SECONDS,
              gapDays: Math.floor((timestamp - previousCommittedJourneyTimestamp) / DAY_SECONDS),
              count: 0,
              mine: 0,
              peer: 0
            }
          } else if (
            coldReturnWindow &&
            timestamp > coldReturnWindow.end &&
            !hasMoment(moments, 'warm-after-silence')
          ) {
            coldReturnWindow = null
          }
          addColdReturnMessage(timestamp, direction)
        }

        if (message.localType === 3 && (direction === 'mine' || direction === 'peer')) {
          firstImageAt[direction] = firstImageAt[direction] ?? timestamp
          if (
            firstImageAt.mine &&
            firstImageAt.peer &&
            !hasMoment(moments, 'mutual-images')
          ) {
            const occurredAt = Math.max(firstImageAt.mine, firstImageAt.peer)
            moments.push({
              id: createMomentId('mutual-images', occurredAt),
              kind: 'mutual-images',
              state: 'observed',
              occurredAt,
              ...RelationshipAchievementContent.getJourneyMoment('mutual-images'),
              evidence: '当前本地记录里，你和对方都曾发来过图片'
            })
          }

          if (isNewMessage && !hasMoment(moments, 'photo-diary')) {
            if (currentImageDay !== dateKey) {
              currentImageDay = dateKey
              currentImageDayMask = 0
            }
            const previousMask = currentImageDayMask
            currentImageDayMask |= direction === 'mine' ? 1 : 2
            if (previousMask !== 3 && currentImageDayMask === 3) {
              mutualImageDayCount += 1
              if (mutualImageDayCount >= 30) {
                moments.push({
                  id: createMomentId('photo-diary', timestamp),
                  kind: 'photo-diary',
                  state: 'observed',
                  occurredAt: timestamp,
                  ...RelationshipAchievementContent.getJourneyMoment('photo-diary'),
                  evidence: `共有 ${mutualImageDayCount} 个不同日期里，你和对方都发送过图片`
                })
              }
            }
          }
        }

        if (message.localType === 34 && !hasMoment(moments, 'first-voice')) {
          moments.push({
            id: createMomentId('first-voice', timestamp),
            kind: 'first-voice',
            state: 'observed',
            occurredAt: timestamp,
            ...RelationshipAchievementContent.getJourneyMoment('first-voice'),
            evidence: message.voiceDurationSeconds
              ? `当前本地记录里最早的一条语音，时长约 ${Math.round(message.voiceDurationSeconds)} 秒`
              : '当前本地记录里最早的一条可识别语音记录'
          })
        }

        const month = date.getMonth()
        const dayOfMonth = date.getDate()
        const hour = date.getHours()
        if (isNewMessage && ((month === 11 && dayOfMonth === 31 && hour === 23) || (month === 0 && dayOfMonth === 1 && hour === 0))) {
          const targetYear = month === 11 ? year + 1 : year
          const current = newYearStats.get(targetYear) || {
            year: targetYear,
            before: 0,
            after: 0,
            mine: 0,
            peer: 0
          }
          if (month === 11) {
            current.before += 1
            current.lastBefore = Math.max(current.lastBefore || 0, timestamp)
          } else {
            current.after += 1
            current.firstAfter = current.firstAfter === undefined
              ? timestamp
              : Math.min(current.firstAfter, timestamp)
          }
          if (direction === 'mine') current.mine += 1
          if (direction === 'peer') current.peer += 1
          newYearStats.set(targetYear, current)
        }

        if (!segment || timestamp - segment.end > SEGMENT_GAP_SECONDS) {
          finalizeSegment(segment, moments, sensitiveDrafts)
          segment = createSegment(timestamp)
        }
        addMessageToSegment(segment, message)
        previousJourneyTimestamp = timestamp
        if (isNewMessage) previousCommittedJourneyTimestamp = timestamp
      }

      const nextOffset = Number.isFinite(response.nextOffset)
        ? Math.floor(response.nextOffset as number)
        : offset + (response.messages?.length || 0)
      hasMore = response.hasMore === true
      if (hasMore && nextOffset <= offset) {
        error = '消息分页没有继续前进，已停止整理后续片段'
        break
      }
      offset = nextOffset
      options.onProgress?.({ scannedMessages, maxMessages: scannedMessages + Math.max(0, maxMessages - processedThisRun) })
      if ((response.messages?.length || 0) === 0 && !hasMore) break
      if (hasMore && processedThisRun < maxMessages) {
        // Let Electron process pointer/input and cancellation IPC between batches.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
  } catch (caught) {
    if (options.signal?.aborted || (caught instanceof DOMException && caught.name === 'AbortError')) throw caught
    error = caught instanceof Error ? caught.message : String(caught)
  }

  // A truncated final segment may be cut off in the middle of a conversation.
  // Keep objective milestones, but do not infer a sensitive turning point from it.
  finalizeSegment(segment, moments, sensitiveDrafts, !hasMore)

  if (!hasMoment(moments, 'new-year-together')) {
    const newYear = Array.from(newYearStats.values())
      .filter((entry) =>
        entry.before > 0 &&
        entry.after > 0 &&
        entry.mine > 0 &&
        entry.peer > 0 &&
        entry.lastBefore !== undefined &&
        entry.firstAfter !== undefined &&
        entry.firstAfter - entry.lastBefore <= 90 * 60
      )
      .sort((left, right) => left.year - right.year)[0]
    if (newYear) {
      const occurredAt = Math.floor(new Date(newYear.year, 0, 1, 0, 0, 0).getTime() / 1_000)
      moments.push({
        id: createMomentId('new-year-together', occurredAt),
        kind: 'new-year-together',
        state: 'observed',
        occurredAt,
        ...RelationshipAchievementContent.getJourneyMoment('new-year-together'),
        evidence: `跨入 ${newYear.year} 年前后一小时，双方都在这段对话里留下过消息`
      })
    }
  }

  const peakDay = Array.from(dayStats.entries())
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))[0]
  if (peakDay && !hasMoment(moments, 'peak-day')) {
    moments.push({
      id: createMomentId('peak-day', peakDay[1].firstTimestamp),
      kind: 'peak-day',
      state: 'observed',
      occurredAt: peakDay[1].firstTimestamp,
      ...RelationshipAchievementContent.getJourneyMoment('peak-day'),
      evidence: `${peakDay[0]} 共整理到 ${peakDay[1].count} 条本地记录${hasMore ? '（旅程仍有后续未扫描）' : ''}`
    })
  }

  const nextSemanticReview = await reviewSensitiveDrafts(sensitiveDrafts, moments, options)
  const semanticReview = resumeResult?.semanticReview && nextSemanticReview.status === 'not-needed'
    ? resumeResult.semanticReview
    : nextSemanticReview

  moments.sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
  const truncated = hasMore && processedThisRun >= maxMessages
  const completedAchievementIds = Array.from(new Set([
    ...Object.keys(thresholdReachedAt),
    ...moments.map((moment) => `moment:${moment.kind}`)
  ])).sort()
  const checkpoint: RelationshipJourneyScanCheckpoint = {
    version: 1,
    algorithmVersion: RELATIONSHIP_JOURNEY_ALGORITHM_VERSION,
    resumeFromTimestamp: Math.max(0, watermarkTimestamp - INCREMENTAL_OVERLAP_SECONDS),
    watermarkTimestamp,
    watermarkTokens: Array.from(watermarkTokens).slice(-4_096),
    unknownMessageThresholdIds: Array.from(unknownMessageThresholds).sort(),
    scannedMessages,
    firstTimestamp,
    previousJourneyTimestamp: previousCommittedJourneyTimestamp,
    activeDays: thresholdReachedAt.active_days_365
      ? []
      : Array.from(activeDays).sort(),
    activeYears: thresholdReachedAt.years_5
      ? []
      : Array.from(activeYears).sort((left, right) => left - right),
    activeMonths: hasMoment(moments, 'monthly-continuity')
      ? []
      : Array.from(activeMonths).sort((left, right) => left - right),
    seasonMasks: hasMoment(moments, 'four-seasons')
      ? []
      : Array.from(seasonMasks.entries())
        .map(([year, mask]) => ({ year, mask }))
        .sort((left, right) => left.year - right.year),
    dayStats: hasMoment(moments, 'peak-day')
      ? []
      : Array.from(dayStats.entries())
        .map(([date, value]) => ({ date, ...value }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    newYearStats: hasMoment(moments, 'new-year-together')
      ? []
      : Array.from(newYearStats.values()).sort((left, right) => left.year - right.year),
    firstImageAt: hasMoment(moments, 'mutual-images') ? {} : { ...firstImageAt },
    mutualImageDayCount: hasMoment(moments, 'photo-diary') ? 0 : mutualImageDayCount,
    currentImageDay: hasMoment(moments, 'photo-diary') ? undefined : currentImageDay || undefined,
    currentImageDayMask: hasMoment(moments, 'photo-diary') ? 0 : currentImageDayMask,
    initiatorCounts: hasMoment(moments, 'mutual-initiators')
      ? { mine: 0, peer: 0 }
      : { ...initiatorCounts },
    returnWindow: returnWindow && !hasMoment(moments, 'return-after-silence')
      ? { ...returnWindow }
      : undefined,
    coldReturnWindow: coldReturnWindow && !hasMoment(moments, 'warm-after-silence')
      ? { ...coldReturnWindow }
      : undefined,
    completedAchievementIds,
    sourceExhausted: !hasMore
  }
  const result: RelationshipJourneyScanResult = {
    status: error ? (scannedMessages > 0 ? 'partial' : 'error') : 'ready',
    moments,
    thresholdReachedAt,
    scannedMessages,
    truncated,
    semanticReview,
    checkpoint,
    error
  }
  if (result.status === 'ready') {
    journeyScanCache.set(cacheKey, { result, updatedAt: Date.now() })
  }
  return result
}

const MAINLINE_IDS = [
  'first_page',
  'active_days_7',
  'messages_100',
  'active_days_30',
  'messages_1000',
  'active_days_100',
  'span_365',
  'messages_10000',
  'years_2',
  'active_days_365',
  'messages_50000',
  'years_5'
] as const

const fallbackDateTimestamp = (item: RelationshipAchievementItem): number | undefined => {
  const value = item.evidence?.firstDate
  if (!value) return undefined
  const match = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
  if (!match) return undefined
  const timestamp = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  if (!Number.isFinite(timestamp)) return undefined
  const seconds = Math.floor(timestamp / 1_000)
  if (item.definition.id === 'first_page') return seconds
  if (item.definition.metric === 'conversationSpanDays') {
    return seconds + item.definition.threshold * DAY_SECONDS
  }
  return undefined
}

export const buildRelationshipJourneyViewModel = (
  collection: RelationshipAchievementCollection,
  scan: RelationshipJourneyScanResult
): RelationshipJourneyViewModel => {
  const itemMap = new Map(collection.achievements.map((item) => [item.definition.id, item]))
  const mainline = MAINLINE_IDS.flatMap((id, index) => {
    const item = itemMap.get(id)
    if (!item || item.status !== 'unlocked') return []
    return [{
      id,
      lane: 'mainline' as const,
      state: 'recorded' as const,
      occurredAt: scan.thresholdReachedAt[id] ?? fallbackDateTimestamp(item),
      title: item.definition.title,
      copy: item.copy,
      goalCopy: item.definition.goalCopy,
      evidence: formatRelationshipAchievementEvidence(item),
      side: index % 2 === 0 ? 'end' as const : 'start' as const,
      achievement: item
    }]
  })

  const branches = scan.moments.map((moment, index): RelationshipJourneyNode => {
    const content = RelationshipAchievementContent.getJourneyMoment(moment.kind)
    return {
      id: moment.id,
      lane: 'branch',
      state: 'recorded',
      occurredAt: moment.occurredAt,
      title: content.title,
      copy: content.copy,
      goalCopy: content.goalCopy,
      evidence: moment.evidence,
      side: index % 2 === 0 ? 'start' : 'end',
      moment,
      parentId: moment.parentId
    }
  })

  const nodes = [...mainline, ...branches]
    .sort((left, right) => {
      if (left.occurredAt && right.occurredAt) {
        return left.occurredAt - right.occurredAt || (left.lane === 'mainline' ? -1 : 1)
      }
      if (left.occurredAt) return -1
      if (right.occurredAt) return 1
      return MAINLINE_IDS.indexOf(left.id as typeof MAINLINE_IDS[number]) -
        MAINLINE_IDS.indexOf(right.id as typeof MAINLINE_IDS[number])
    })
    .map((node, index) => ({
      ...node,
      side: node.lane === 'branch'
        ? node.side
        : index % 2 === 0 ? 'end' as const : 'start' as const
    }))

  const futureState = MAINLINE_IDS.some((id) => itemMap.get(id)?.status === 'locked')
    ? 'locked' as const
    : collection.summary.error > 0
      ? 'unknown' as const
      : 'unwritten' as const

  const allUnavailable = collection.summary.total > 0 &&
    collection.summary.error === collection.summary.total
  const quality = collection.summary.loading === collection.summary.total
    ? 'loading'
    : allUnavailable
      ? 'unavailable'
      : collection.summary.error > 0 || scan.status === 'partial' || scan.status === 'error'
        ? 'partial'
        : 'complete'

  return {
    nodes,
    futureState,
    quality
  }
}
