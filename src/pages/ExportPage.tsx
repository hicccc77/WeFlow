import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type UIEvent, type WheelEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { createPortal } from 'react-dom'
import {
  Aperture,
  Calendar,
  Check,
  CheckSquare,
  CircleHelp,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  Hash,
  Image as ImageIcon,
  Loader2,
  AlertTriangle,
  ClipboardList,
  MessageSquare,
  MessageSquareText,
  Mic,
  RefreshCw,
  Search,
  Square,
  Video,
  WandSparkles,
  X
} from 'lucide-react'
import type { ChatSession as AppChatSession, ContactInfo } from '../types/models'
import type { ExportOptions as ElectronExportOptions, ExportProgress } from '../types/electron'
import type { BackgroundTaskRecord } from '../types/backgroundTask'
import * as configService from '../services/config'
import {
  emitExportSessionStatus,
  emitSingleExportDialogStatus,
  onExportSessionStatusRequest,
  onOpenSingleExport
} from '../services/exportBridge'
import {
  requestCancelBackgroundTask,
  requestCancelBackgroundTasks,
  subscribeBackgroundTasks
} from '../services/backgroundTaskMonitor'
import { useContactTypeCountsStore } from '../stores/contactTypeCountsStore'
import { useChatStore } from '../stores/chatStore'
import { SnsPostItem } from '../components/Sns/SnsPostItem'
import { ContactSnsTimelineDialog } from '../components/Sns/ContactSnsTimelineDialog'
import { ExportDateRangeDialog } from '../components/Export/ExportDateRangeDialog'
import { ExportDefaultsSettingsForm, type ExportDefaultsSettingsPatch } from '../components/Export/ExportDefaultsSettingsForm'
import { Avatar } from '../components/Avatar'
import type { SnsPost } from '../types/sns'
import {
  cloneExportDateRange,
  cloneExportDateRangeSelection,
  createDefaultDateRange,
  createDefaultExportDateRangeSelection,
  getExportDateRangeLabel,
  resolveExportDateRangeConfig,
  startOfDay,
  endOfDay,
  type ExportDateRangeSelection
} from '../utils/exportDateRange'
import './ExportPage.scss'

type ConversationTab = 'private' | 'group' | 'official' | 'former_friend'
type TaskStatus = 'queued' | 'running' | 'success' | 'error'
type TaskScope = 'single' | 'multi' | 'content' | 'sns'
type ContentType = 'text' | 'voice' | 'image' | 'video' | 'emoji'
type ContentCardType = ContentType | 'sns'
type SnsRankMode = 'likes' | 'comments'

type SessionLayout = 'shared' | 'per-session'

type DisplayNamePreference = 'group-nickname' | 'remark' | 'nickname'

type TextExportFormat = 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'txt' | 'excel' | 'weclone' | 'sql'
type SnsTimelineExportFormat = 'json' | 'html' | 'arkmejson'

interface ExportOptions {
  format: TextExportFormat
  dateRange: { start: Date; end: Date } | null
  useAllTime: boolean
  exportAvatars: boolean
  exportMedia: boolean
  exportImages: boolean
  exportVoices: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoiceAsText: boolean
  excelCompactColumns: boolean
  txtColumns: string[]
  displayNamePreference: DisplayNamePreference
  exportConcurrency: number
  imageDeepSearchOnMiss: boolean
}

interface SessionRow extends AppChatSession {
  kind: ConversationTab
  wechatId?: string
  hasSession: boolean
}

interface TaskProgress {
  current: number
  total: number
  currentName: string
  phase: ExportProgress['phase'] | ''
  phaseLabel: string
  phaseProgress: number
  phaseTotal: number
  exportedMessages: number
  estimatedTotalMessages: number
  collectedMessages: number
  writtenFiles: number
  mediaDoneFiles: number
  mediaCacheHitFiles: number
  mediaCacheMissFiles: number
  mediaCacheFillFiles: number
  mediaDedupReuseFiles: number
  mediaBytesWritten: number
}

type TaskPerfStage = 'collect' | 'build' | 'write' | 'other'

interface TaskSessionPerformance {
  sessionId: string
  sessionName: string
  startedAt: number
  finishedAt?: number
  elapsedMs: number
  lastPhase?: ExportProgress['phase']
  lastPhaseStartedAt?: number
}

interface TaskPerformance {
  stages: Record<TaskPerfStage, number>
  sessions: Record<string, TaskSessionPerformance>
}

interface ExportTaskPayload {
  sessionIds: string[]
  outputDir: string
  options?: ElectronExportOptions
  scope: TaskScope
  contentType?: ContentType
  sessionNames: string[]
  snsOptions?: {
    format: SnsTimelineExportFormat
    exportImages?: boolean
    exportLivePhotos?: boolean
    exportVideos?: boolean
    startTime?: number
    endTime?: number
  }
}

interface ExportTask {
  id: string
  title: string
  status: TaskStatus
  settledSessionIds?: string[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  payload: ExportTaskPayload
  progress: TaskProgress
  performance?: TaskPerformance
}

interface ExportDialogState {
  open: boolean
  scope: TaskScope
  contentType?: ContentType
  sessionIds: string[]
  sessionNames: string[]
  title: string
}

const defaultTxtColumns = ['index', 'time', 'senderRole', 'messageType', 'content']
const DETAIL_PRECISE_REFRESH_COOLDOWN_MS = 10 * 60 * 1000
const SESSION_MEDIA_METRIC_PREFETCH_ROWS = 10
const SESSION_MEDIA_METRIC_BATCH_SIZE = 8
const SESSION_MEDIA_METRIC_BACKGROUND_FEED_SIZE = 48
const SESSION_MEDIA_METRIC_BACKGROUND_FEED_INTERVAL_MS = 120
const SESSION_MEDIA_METRIC_CACHE_FLUSH_DELAY_MS = 1200
const SNS_USER_POST_COUNT_BATCH_SIZE = 12
const SNS_USER_POST_COUNT_BATCH_INTERVAL_MS = 120
const SNS_RANK_PAGE_SIZE = 50
const SNS_RANK_DISPLAY_LIMIT = 15
const contentTypeLabels: Record<ContentType, string> = {
  text: '聊天文本',
  voice: '语音',
  image: '图片',
  video: '视频',
  emoji: '表情包'
}

const backgroundTaskSourceLabels: Record<string, string> = {
  export: '导出页',
  chat: '聊天页',
  analytics: '分析页',
  sns: '朋友圈页',
  groupAnalytics: '群分析页',
  annualReport: '年度报告',
  other: '其他页面'
}

const backgroundTaskStatusLabels: Record<BackgroundTaskRecord['status'], string> = {
  running: '运行中',
  cancel_requested: '停止中',
  completed: '已完成',
  failed: '失败',
  canceled: '已停止'
}

const conversationTabLabels: Record<ConversationTab, string> = {
  private: '私聊',
  group: '群聊',
  official: '公众号',
  former_friend: '曾经的好友'
}

const getContentTypeLabel = (type: ContentType): string => {
  return contentTypeLabels[type] || type
}

const formatOptions: Array<{ value: TextExportFormat; label: string; desc: string }> = [
  { value: 'chatlab', label: 'ChatLab', desc: '标准格式，支持其他软件导入' },
  { value: 'chatlab-jsonl', label: 'ChatLab JSONL', desc: '流式格式，适合大量消息' },
  { value: 'json', label: 'JSON', desc: '详细格式，包含完整消息信息' },
  { value: 'arkme-json', label: 'Arkme JSON', desc: '紧凑 JSON，支持 sender 去重与关系统计' },
  { value: 'html', label: 'HTML', desc: '网页格式，可直接浏览' },
  { value: 'txt', label: 'TXT', desc: '纯文本，通用格式' },
  { value: 'excel', label: 'Excel', desc: '电子表格，适合统计分析' },
  { value: 'weclone', label: 'WeClone CSV', desc: 'WeClone 兼容字段格式（CSV）' },
  { value: 'sql', label: 'PostgreSQL', desc: '数据库脚本，便于导入到数据库' }
]

const displayNameOptions: Array<{ value: DisplayNamePreference; label: string; desc: string }> = [
  { value: 'group-nickname', label: '群昵称优先', desc: '仅群聊有效，私聊显示备注/昵称' },
  { value: 'remark', label: '备注优先', desc: '有备注显示备注，否则显示昵称' },
  { value: 'nickname', label: '微信昵称', desc: '始终显示微信昵称' }
]

const writeLayoutOptions: Array<{ value: configService.ExportWriteLayout; label: string; desc: string }> = [
  {
    value: 'A',
    label: 'A（类型分目录）',
    desc: '聊天文本、语音、视频、表情包、图片分别创建文件夹'
  },
  {
    value: 'B',
    label: 'B（文本根目录+媒体按会话）',
    desc: '聊天文本在根目录；媒体按类型目录后再按会话分目录'
  },
  {
    value: 'C',
    label: 'C（按会话分目录）',
    desc: '每个会话一个目录，目录内包含文本与媒体文件'
  }
]

const createEmptyProgress = (): TaskProgress => ({
  current: 0,
  total: 0,
  currentName: '',
  phase: '',
  phaseLabel: '',
  phaseProgress: 0,
  phaseTotal: 0,
  exportedMessages: 0,
  estimatedTotalMessages: 0,
  collectedMessages: 0,
  writtenFiles: 0,
  mediaDoneFiles: 0,
  mediaCacheHitFiles: 0,
  mediaCacheMissFiles: 0,
  mediaCacheFillFiles: 0,
  mediaDedupReuseFiles: 0,
  mediaBytesWritten: 0
})

const createEmptyTaskPerformance = (): TaskPerformance => ({
  stages: {
    collect: 0,
    build: 0,
    write: 0,
    other: 0
  },
  sessions: {}
})

const isTextBatchTask = (task: ExportTask): boolean => (
  task.payload.scope === 'content' && task.payload.contentType === 'text'
)

const resolvePerfStageByPhase = (phase?: ExportProgress['phase']): TaskPerfStage => {
  if (phase === 'preparing') return 'collect'
  if (phase === 'writing') return 'write'
  if (phase === 'exporting' || phase === 'exporting-media' || phase === 'exporting-voice') return 'build'
  return 'other'
}

const cloneTaskPerformance = (performance?: TaskPerformance): TaskPerformance => ({
  stages: {
    collect: performance?.stages.collect || 0,
    build: performance?.stages.build || 0,
    write: performance?.stages.write || 0,
    other: performance?.stages.other || 0
  },
  sessions: Object.fromEntries(
    Object.entries(performance?.sessions || {}).map(([sessionId, session]) => [sessionId, { ...session }])
  )
})

const resolveTaskSessionName = (task: ExportTask, sessionId: string, fallback?: string): string => {
  const idx = task.payload.sessionIds.indexOf(sessionId)
  if (idx >= 0) {
    return task.payload.sessionNames[idx] || fallback || sessionId
  }
  return fallback || sessionId
}

const applyProgressToTaskPerformance = (
  task: ExportTask,
  payload: ExportProgress,
  now: number
): TaskPerformance | undefined => {
  if (!isTextBatchTask(task)) return task.performance
  const sessionId = String(payload.currentSessionId || '').trim()
  if (!sessionId) return task.performance || createEmptyTaskPerformance()

  const performance = cloneTaskPerformance(task.performance)
  const sessionName = resolveTaskSessionName(task, sessionId, payload.currentSession || sessionId)
  const existing = performance.sessions[sessionId]
  const session: TaskSessionPerformance = existing
    ? { ...existing, sessionName: existing.sessionName || sessionName }
    : {
      sessionId,
      sessionName,
      startedAt: now,
      elapsedMs: 0
    }

  if (!session.finishedAt && session.lastPhase && typeof session.lastPhaseStartedAt === 'number') {
    const delta = Math.max(0, now - session.lastPhaseStartedAt)
    performance.stages[resolvePerfStageByPhase(session.lastPhase)] += delta
  }

  session.elapsedMs = Math.max(session.elapsedMs, now - session.startedAt)

  if (payload.phase === 'complete') {
    session.finishedAt = now
    session.lastPhase = undefined
    session.lastPhaseStartedAt = undefined
  } else {
    session.lastPhase = payload.phase
    session.lastPhaseStartedAt = now
  }

  performance.sessions[sessionId] = session
  return performance
}

const finalizeTaskPerformance = (task: ExportTask, now: number): TaskPerformance | undefined => {
  if (!isTextBatchTask(task) || !task.performance) return task.performance
  const performance = cloneTaskPerformance(task.performance)
  for (const session of Object.values(performance.sessions)) {
    if (session.finishedAt) continue
    if (session.lastPhase && typeof session.lastPhaseStartedAt === 'number') {
      const delta = Math.max(0, now - session.lastPhaseStartedAt)
      performance.stages[resolvePerfStageByPhase(session.lastPhase)] += delta
    }
    session.elapsedMs = Math.max(session.elapsedMs, now - session.startedAt)
    session.finishedAt = now
    session.lastPhase = undefined
    session.lastPhaseStartedAt = undefined
  }
  return performance
}

const getTaskPerformanceStageTotals = (
  performance: TaskPerformance | undefined,
  now: number
): Record<TaskPerfStage, number> => {
  const totals: Record<TaskPerfStage, number> = {
    collect: performance?.stages.collect || 0,
    build: performance?.stages.build || 0,
    write: performance?.stages.write || 0,
    other: performance?.stages.other || 0
  }
  if (!performance) return totals
  for (const session of Object.values(performance.sessions)) {
    if (session.finishedAt) continue
    if (!session.lastPhase || typeof session.lastPhaseStartedAt !== 'number') continue
    const delta = Math.max(0, now - session.lastPhaseStartedAt)
    totals[resolvePerfStageByPhase(session.lastPhase)] += delta
  }
  return totals
}

const getTaskPerformanceTopSessions = (
  performance: TaskPerformance | undefined,
  now: number,
  limit = 5
): Array<TaskSessionPerformance & { liveElapsedMs: number }> => {
  if (!performance) return []
  return Object.values(performance.sessions)
    .map((session) => {
      const liveElapsedMs = session.finishedAt
        ? session.elapsedMs
        : Math.max(session.elapsedMs, now - session.startedAt)
      return {
        ...session,
        liveElapsedMs
      }
    })
    .sort((a, b) => b.liveElapsedMs - a.liveElapsedMs)
    .slice(0, limit)
}

const formatDurationMs = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`
  }
  return `${seconds}秒`
}

const getTaskStatusLabel = (task: ExportTask): string => {
  if (task.status === 'queued') return '排队中'
  if (task.status === 'running') return '进行中'
  if (task.status === 'success') return '已完成'
  return '失败'
}

const formatAbsoluteDate = (timestamp: number): string => {
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

const formatYmdDateFromSeconds = (timestamp?: number): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp * 1000)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

const formatYmdHmDateTime = (timestamp?: number): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const h = `${d.getHours()}`.padStart(2, '0')
  const min = `${d.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

const isSingleContactSession = (sessionId: string): boolean => {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return false
  if (normalized.includes('@chatroom')) return false
  if (normalized.startsWith('gh_')) return false
  return true
}

const formatPathBrief = (value: string, maxLength = 52): string => {
  const normalized = String(value || '')
  if (normalized.length <= maxLength) return normalized
  const headLength = Math.max(10, Math.floor(maxLength * 0.55))
  const tailLength = Math.max(8, maxLength - headLength - 1)
  return `${normalized.slice(0, headLength)}…${normalized.slice(-tailLength)}`
}

const formatRecentExportTime = (timestamp?: number, now = Date.now()): string => {
  if (!timestamp) return ''
  const diff = Math.max(0, now - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) {
    const minutes = Math.max(1, Math.floor(diff / minute))
    return `${minutes} 分钟前`
  }
  if (diff < day) {
    const hours = Math.max(1, Math.floor(diff / hour))
    return `${hours} 小时前`
  }
  return formatAbsoluteDate(timestamp)
}

const toKindByContactType = (session: AppChatSession, contact?: ContactInfo): ConversationTab => {
  if (session.username.endsWith('@chatroom')) return 'group'
  if (session.username.startsWith('gh_')) return 'official'
  if (contact?.type === 'official') return 'official'
  if (contact?.type === 'former_friend') return 'former_friend'
  return 'private'
}

const toKindByContact = (contact: ContactInfo): ConversationTab => {
  if (contact.type === 'group') return 'group'
  if (contact.type === 'official') return 'official'
  if (contact.type === 'former_friend') return 'former_friend'
  return 'private'
}

const isContentScopeSession = (session: SessionRow): boolean => (
  session.kind === 'private' || session.kind === 'group' || session.kind === 'former_friend'
)

const isExportConversationSession = (session: SessionRow): boolean => (
  session.kind === 'private' || session.kind === 'group' || session.kind === 'former_friend'
)

const exportKindPriority: Record<ConversationTab, number> = {
  private: 0,
  group: 1,
  former_friend: 2,
  official: 3
}

const getAvatarLetter = (name: string): string => {
  if (!name) return '?'
  return [...name][0] || '?'
}

const normalizeExportAvatarUrl = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  if (lower === 'null' || lower === 'undefined') return undefined
  return normalized
}

const toComparableNameSet = (values: Array<string | undefined | null>): Set<string> => {
  const set = new Set<string>()
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (!normalized) continue
    set.add(normalized)
  }
  return set
}

const matchesContactTab = (contact: ContactInfo, tab: ConversationTab): boolean => {
  if (tab === 'private') return contact.type === 'friend'
  if (tab === 'group') return contact.type === 'group'
  if (tab === 'official') return contact.type === 'official'
  return contact.type === 'former_friend'
}

const createTaskId = (): string => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const CONTACT_ENRICH_TIMEOUT_MS = 7000
const EXPORT_SNS_STATS_CACHE_STALE_MS = 12 * 60 * 60 * 1000
const EXPORT_AVATAR_ENRICH_BATCH_SIZE = 80
const DEFAULT_CONTACTS_LOAD_TIMEOUT_MS = 10000
const EXPORT_REENTER_SESSION_SOFT_REFRESH_MS = 5 * 60 * 1000
const EXPORT_REENTER_CONTACTS_SOFT_REFRESH_MS = 5 * 60 * 1000
const EXPORT_REENTER_SNS_SOFT_REFRESH_MS = 3 * 60 * 1000
type SessionDataSource = 'cache' | 'network' | null
type ContactsDataSource = 'cache' | 'network' | null

interface ContactsLoadSession {
  requestId: string
  startedAt: number
  attempt: number
  timeoutMs: number
}

interface ContactsLoadIssue {
  kind: 'timeout' | 'error'
  title: string
  message: string
  reason: string
  errorDetail?: string
  occurredAt: number
  elapsedMs: number
}

interface SessionDetail {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  transferMessages?: number
  redPacketMessages?: number
  callMessages?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
  relationStatsLoaded?: boolean
  statsUpdatedAt?: number
  statsStale?: boolean
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

interface SessionSnsTimelineTarget {
  username: string
  displayName: string
  avatarUrl?: string
}

interface SessionSnsRankItem {
  name: string
  count: number
  latestTime: number
}

type SessionMutualFriendDirection = 'incoming' | 'outgoing' | 'bidirectional'
type SessionMutualFriendBehavior = 'likes' | 'comments' | 'both'

interface SessionMutualFriendItem {
  name: string
  incomingLikeCount: number
  incomingCommentCount: number
  outgoingLikeCount: number
  outgoingCommentCount: number
  totalCount: number
  latestTime: number
  direction: SessionMutualFriendDirection
  behavior: SessionMutualFriendBehavior
}

interface SessionMutualFriendsMetric {
  count: number
  items: SessionMutualFriendItem[]
  loadedPosts: number
  totalPosts: number | null
  computedAt: number
}

interface SessionSnsRankCacheEntry {
  likes: SessionSnsRankItem[]
  comments: SessionSnsRankItem[]
  totalPosts: number
  computedAt: number
}

const buildSessionSnsRankings = (posts: SnsPost[]): { likes: SessionSnsRankItem[]; comments: SessionSnsRankItem[] } => {
  const likeMap = new Map<string, SessionSnsRankItem>()
  const commentMap = new Map<string, SessionSnsRankItem>()

  for (const post of posts) {
    const createTime = Number(post?.createTime) || 0
    const likes = Array.isArray(post?.likes) ? post.likes : []
    const comments = Array.isArray(post?.comments) ? post.comments : []

    for (const likeNameRaw of likes) {
      const name = String(likeNameRaw || '').trim() || '未知用户'
      const current = likeMap.get(name)
      if (current) {
        current.count += 1
        if (createTime > current.latestTime) current.latestTime = createTime
        continue
      }
      likeMap.set(name, { name, count: 1, latestTime: createTime })
    }

    for (const comment of comments) {
      const name = String(comment?.nickname || '').trim() || '未知用户'
      const current = commentMap.get(name)
      if (current) {
        current.count += 1
        if (createTime > current.latestTime) current.latestTime = createTime
        continue
      }
      commentMap.set(name, { name, count: 1, latestTime: createTime })
    }
  }

  const sorter = (a: SessionSnsRankItem, b: SessionSnsRankItem): number => {
    if (b.count !== a.count) return b.count - a.count
    if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime
    return a.name.localeCompare(b.name, 'zh-CN')
  }

  return {
    likes: [...likeMap.values()].sort(sorter),
    comments: [...commentMap.values()].sort(sorter)
  }
}

const buildSessionMutualFriendsMetric = (
  posts: SnsPost[],
  totalPosts: number | null
): SessionMutualFriendsMetric => {
  const friendMap = new Map<string, SessionMutualFriendItem>()

  for (const post of posts) {
    const createTime = Number(post?.createTime) || 0
    const likes = Array.isArray(post?.likes) ? post.likes : []
    const comments = Array.isArray(post?.comments) ? post.comments : []

    for (const likeNameRaw of likes) {
      const name = String(likeNameRaw || '').trim() || '未知用户'
      const existing = friendMap.get(name)
      if (existing) {
        existing.incomingLikeCount += 1
        existing.totalCount += 1
        existing.behavior = existing.incomingCommentCount > 0 ? 'both' : 'likes'
        if (createTime > existing.latestTime) existing.latestTime = createTime
        continue
      }
      friendMap.set(name, {
        name,
        incomingLikeCount: 1,
        incomingCommentCount: 0,
        outgoingLikeCount: 0,
        outgoingCommentCount: 0,
        totalCount: 1,
        latestTime: createTime,
        direction: 'incoming',
        behavior: 'likes'
      })
    }

    for (const comment of comments) {
      const name = String(comment?.nickname || '').trim() || '未知用户'
      const existing = friendMap.get(name)
      if (existing) {
        existing.incomingCommentCount += 1
        existing.totalCount += 1
        existing.behavior = existing.incomingLikeCount > 0 ? 'both' : 'comments'
        if (createTime > existing.latestTime) existing.latestTime = createTime
        continue
      }
      friendMap.set(name, {
        name,
        incomingLikeCount: 0,
        incomingCommentCount: 1,
        outgoingLikeCount: 0,
        outgoingCommentCount: 0,
        totalCount: 1,
        latestTime: createTime,
        direction: 'incoming',
        behavior: 'comments'
      })
    }
  }

  const items = [...friendMap.values()].sort((a, b) => {
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount
    if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  return {
    count: items.length,
    items,
    loadedPosts: posts.length,
    totalPosts,
    computedAt: Date.now()
  }
}

const getSessionMutualFriendDirectionLabel = (direction: SessionMutualFriendDirection): string => {
  if (direction === 'incoming') return '对方赞/评TA'
  if (direction === 'outgoing') return 'TA赞/评对方'
  return '双方有互动'
}

const getSessionMutualFriendBehaviorLabel = (behavior: SessionMutualFriendBehavior): string => {
  if (behavior === 'likes') return '赞'
  if (behavior === 'comments') return '评'
  return '赞/评'
}

const summarizeMutualFriendBehavior = (likeCount: number, commentCount: number): SessionMutualFriendBehavior => {
  if (likeCount > 0 && commentCount > 0) return 'both'
  if (likeCount > 0) return 'likes'
  return 'comments'
}

const describeSessionMutualFriendRelation = (
  item: SessionMutualFriendItem,
  targetDisplayName: string
): string => {
  if (item.direction === 'incoming') {
    if (item.behavior === 'likes') return `${item.name} 给 ${targetDisplayName} 点过赞`
    if (item.behavior === 'comments') return `${item.name} 给 ${targetDisplayName} 评论过`
    return `${item.name} 给 ${targetDisplayName} 点过赞、评论过`
  }
  if (item.direction === 'outgoing') {
    if (item.behavior === 'likes') return `${targetDisplayName} 给 ${item.name} 点过赞`
    if (item.behavior === 'comments') return `${targetDisplayName} 给 ${item.name} 评论过`
    return `${targetDisplayName} 给 ${item.name} 点过赞、评论过`
  }
  if (item.behavior === 'likes') return `${targetDisplayName} 和 ${item.name} 双方都有点赞互动`
  if (item.behavior === 'comments') return `${targetDisplayName} 和 ${item.name} 双方都有评论互动`
  return `${targetDisplayName} 和 ${item.name} 双方都有点赞或评论互动`
}

interface SessionExportMetric {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
  firstTimestamp?: number
  lastTimestamp?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
}

interface SessionContentMetric {
  totalMessages?: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  transferMessages?: number
  redPacketMessages?: number
  callMessages?: number
  firstTimestamp?: number
  lastTimestamp?: number
}

interface TimeRangeBounds {
  minDate: Date
  maxDate: Date
}

interface SessionExportCacheMeta {
  updatedAt: number
  stale: boolean
  includeRelations: boolean
  source: 'memory' | 'disk' | 'fresh'
}

type SessionLoadStageStatus = 'pending' | 'loading' | 'done' | 'failed'

interface SessionLoadStageState {
  status: SessionLoadStageStatus
  startedAt?: number
  finishedAt?: number
  error?: string
}

interface SessionLoadTraceState {
  messageCount: SessionLoadStageState
  mediaMetrics: SessionLoadStageState
  snsPostCounts: SessionLoadStageState
  mutualFriends: SessionLoadStageState
}

interface SessionLoadStageSummary {
  total: number
  loaded: number
  statusLabel: string
  startedAt?: number
  finishedAt?: number
  latestProgressAt?: number
}

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const toContactMapFromCaches = (
  contacts: configService.ContactsListCacheContact[],
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
): Record<string, ContactInfo> => {
  const map: Record<string, ContactInfo> = {}
  for (const contact of contacts || []) {
    if (!contact?.username) continue
    map[contact.username] = {
      ...contact,
      avatarUrl: avatarEntries[contact.username]?.avatarUrl
    }
  }
  return map
}

const mergeAvatarCacheIntoContacts = (
  sourceContacts: ContactInfo[],
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
): ContactInfo[] => {
  if (!sourceContacts.length || Object.keys(avatarEntries).length === 0) {
    return sourceContacts
  }

  let changed = false
  const merged = sourceContacts.map((contact) => {
    const cachedAvatar = avatarEntries[contact.username]?.avatarUrl
    if (!cachedAvatar || contact.avatarUrl) {
      return contact
    }
    changed = true
    return {
      ...contact,
      avatarUrl: cachedAvatar
    }
  })

  return changed ? merged : sourceContacts
}

const upsertAvatarCacheFromContacts = (
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>,
  sourceContacts: ContactInfo[],
  options?: { prune?: boolean; markCheckedUsernames?: string[]; now?: number }
): {
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
  changed: boolean
  updatedAt: number | null
} => {
  const nextCache = { ...avatarEntries }
  const now = options?.now || Date.now()
  const markCheckedSet = new Set((options?.markCheckedUsernames || []).filter(Boolean))
  const usernamesInSource = new Set<string>()
  let changed = false

  for (const contact of sourceContacts) {
    const username = String(contact.username || '').trim()
    if (!username) continue
    usernamesInSource.add(username)
    const prev = nextCache[username]
    const avatarUrl = String(contact.avatarUrl || '').trim()
    if (!avatarUrl) continue
    const updatedAt = !prev || prev.avatarUrl !== avatarUrl ? now : prev.updatedAt
    const checkedAt = markCheckedSet.has(username) ? now : (prev?.checkedAt || now)
    if (!prev || prev.avatarUrl !== avatarUrl || prev.updatedAt !== updatedAt || prev.checkedAt !== checkedAt) {
      nextCache[username] = {
        avatarUrl,
        updatedAt,
        checkedAt
      }
      changed = true
    }
  }

  for (const username of markCheckedSet) {
    const prev = nextCache[username]
    if (!prev) continue
    if (prev.checkedAt !== now) {
      nextCache[username] = {
        ...prev,
        checkedAt: now
      }
      changed = true
    }
  }

  if (options?.prune) {
    for (const username of Object.keys(nextCache)) {
      if (usernamesInSource.has(username)) continue
      delete nextCache[username]
      changed = true
    }
  }

  return {
    avatarEntries: nextCache,
    changed,
    updatedAt: changed ? now : null
  }
}

const toSessionRowsWithContacts = (
  sessions: AppChatSession[],
  contactMap: Record<string, ContactInfo>
): SessionRow[] => {
  const sessionMap = new Map<string, AppChatSession>()
  for (const session of sessions || []) {
    sessionMap.set(session.username, session)
  }

  const contacts = Object.values(contactMap)
    .filter((contact) => (
      contact.type === 'friend' ||
      contact.type === 'group' ||
      contact.type === 'official' ||
      contact.type === 'former_friend'
    ))

  if (contacts.length > 0) {
    return contacts
      .map((contact) => {
        const session = sessionMap.get(contact.username)
        const latestTs = session?.sortTimestamp || session?.lastTimestamp || 0
        return {
          ...(session || {
            username: contact.username,
            type: 0,
            unreadCount: 0,
            summary: '',
            sortTimestamp: latestTs,
            lastTimestamp: latestTs,
            lastMsgType: 0
          }),
          username: contact.username,
          kind: toKindByContact(contact),
          wechatId: contact.username,
          displayName: contact.displayName || session?.displayName || contact.username,
          avatarUrl: session?.avatarUrl || contact.avatarUrl,
          hasSession: Boolean(session)
        } as SessionRow
      })
      .sort((a, b) => {
        const latestA = a.sortTimestamp || a.lastTimestamp || 0
        const latestB = b.sortTimestamp || b.lastTimestamp || 0
        if (latestA !== latestB) return latestB - latestA
        return (a.displayName || a.username).localeCompare(b.displayName || b.username, 'zh-Hans-CN')
      })
  }

  return sessions
    .map((session) => {
      const contact = contactMap[session.username]
      return {
        ...session,
        kind: toKindByContactType(session, contact),
        wechatId: contact?.username || session.username,
        displayName: contact?.displayName || session.displayName || session.username,
        avatarUrl: session.avatarUrl || contact?.avatarUrl,
        hasSession: true
      } as SessionRow
    })
    .sort((a, b) => (b.sortTimestamp || b.lastTimestamp || 0) - (a.sortTimestamp || a.lastTimestamp || 0))
}

const normalizeMessageCount = (value: unknown): number | undefined => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.floor(parsed)
}

const normalizeTimestampSeconds = (value: unknown): number | undefined => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

const clampExportSelectionToBounds = (
  selection: ExportDateRangeSelection,
  bounds: TimeRangeBounds | null
): ExportDateRangeSelection => {
  if (!bounds) return cloneExportDateRangeSelection(selection)

  const boundedStart = startOfDay(bounds.minDate)
  const boundedEnd = endOfDay(bounds.maxDate)
  const originalStart = selection.useAllTime ? boundedStart : startOfDay(selection.dateRange.start)
  const originalEnd = selection.useAllTime ? boundedEnd : endOfDay(selection.dateRange.end)
  const nextStart = new Date(Math.min(Math.max(originalStart.getTime(), boundedStart.getTime()), boundedEnd.getTime()))
  const nextEndCandidate = new Date(Math.min(Math.max(originalEnd.getTime(), boundedStart.getTime()), boundedEnd.getTime()))
  const nextEnd = nextEndCandidate.getTime() < nextStart.getTime() ? endOfDay(nextStart) : nextEndCandidate
  const rangeChanged = nextStart.getTime() !== originalStart.getTime() || nextEnd.getTime() !== originalEnd.getTime()

  return {
    preset: selection.useAllTime ? selection.preset : (rangeChanged ? 'custom' : selection.preset),
    useAllTime: selection.useAllTime,
    dateRange: {
      start: nextStart,
      end: nextEnd
    }
  }
}

const areExportSelectionsEqual = (left: ExportDateRangeSelection, right: ExportDateRangeSelection): boolean => (
  left.preset === right.preset &&
  left.useAllTime === right.useAllTime &&
  left.dateRange.start.getTime() === right.dateRange.start.getTime() &&
  left.dateRange.end.getTime() === right.dateRange.end.getTime()
)

const pickSessionMediaMetric = (
  metricRaw: SessionExportMetric | SessionContentMetric | undefined
): SessionContentMetric | null => {
  if (!metricRaw) return null
  const totalMessages = normalizeMessageCount(metricRaw.totalMessages)
  const voiceMessages = normalizeMessageCount(metricRaw.voiceMessages)
  const imageMessages = normalizeMessageCount(metricRaw.imageMessages)
  const videoMessages = normalizeMessageCount(metricRaw.videoMessages)
  const emojiMessages = normalizeMessageCount(metricRaw.emojiMessages)
  const firstTimestamp = normalizeTimestampSeconds(metricRaw.firstTimestamp)
  const lastTimestamp = normalizeTimestampSeconds(metricRaw.lastTimestamp)
  if (
    typeof totalMessages !== 'number' &&
    typeof voiceMessages !== 'number' &&
    typeof imageMessages !== 'number' &&
    typeof videoMessages !== 'number' &&
    typeof emojiMessages !== 'number' &&
    typeof firstTimestamp !== 'number' &&
    typeof lastTimestamp !== 'number'
  ) {
    return null
  }
  return {
    totalMessages,
    voiceMessages,
    imageMessages,
    videoMessages,
    emojiMessages,
    firstTimestamp,
    lastTimestamp
  }
}

const hasCompleteSessionMediaMetric = (metricRaw: SessionContentMetric | undefined): boolean => {
  if (!metricRaw) return false
  return (
    typeof normalizeMessageCount(metricRaw.voiceMessages) === 'number' &&
    typeof normalizeMessageCount(metricRaw.imageMessages) === 'number' &&
    typeof normalizeMessageCount(metricRaw.videoMessages) === 'number' &&
    typeof normalizeMessageCount(metricRaw.emojiMessages) === 'number'
  )
}

const createDefaultSessionLoadStage = (): SessionLoadStageState => ({ status: 'pending' })

const createDefaultSessionLoadTrace = (): SessionLoadTraceState => ({
  messageCount: createDefaultSessionLoadStage(),
  mediaMetrics: createDefaultSessionLoadStage(),
  snsPostCounts: createDefaultSessionLoadStage(),
  mutualFriends: createDefaultSessionLoadStage()
})

const WriteLayoutSelector = memo(function WriteLayoutSelector({
  writeLayout,
  onChange,
  sessionNameWithTypePrefix,
  onSessionNameWithTypePrefixChange
}: {
  writeLayout: configService.ExportWriteLayout
  onChange: (value: configService.ExportWriteLayout) => Promise<void>
  sessionNameWithTypePrefix: boolean
  onSessionNameWithTypePrefixChange: (enabled: boolean) => Promise<void>
}) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) return

    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setIsOpen(false)
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [isOpen])

  const writeLayoutLabel = writeLayoutOptions.find(option => option.value === writeLayout)?.label || 'A（类型分目录）'

  return (
    <div className="write-layout-control" ref={containerRef}>
      <span className="control-label">写入目录方式</span>
      <button
        className={`layout-trigger ${isOpen ? 'active' : ''}`}
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
      >
        {writeLayoutLabel}
      </button>
      <div className={`layout-dropdown ${isOpen ? 'open' : ''}`}>
        {writeLayoutOptions.map(option => (
          <button
            key={option.value}
            className={`layout-option ${writeLayout === option.value ? 'active' : ''}`}
            type="button"
            onClick={async () => {
              await onChange(option.value)
              setIsOpen(false)
            }}
          >
            <span className="layout-option-label">{option.label}</span>
            <span className="layout-option-desc">{option.desc}</span>
          </button>
        ))}
        <div className="layout-prefix-toggle">
          <div className="layout-prefix-copy">
            <span className="layout-prefix-label">聊天文本文件和会话文件夹带前缀</span>
            <span className="layout-prefix-desc">开启后使用群聊_、私聊_、公众号_、曾经的好友_前缀</span>
          </div>
          <button
            type="button"
            className={`layout-prefix-switch ${sessionNameWithTypePrefix ? 'on' : ''}`}
            onClick={async () => {
              await onSessionNameWithTypePrefixChange(!sessionNameWithTypePrefix)
            }}
            aria-label="聊天文本文件和会话文件夹带前缀"
            aria-pressed={sessionNameWithTypePrefix}
          >
            <span className="layout-prefix-switch-thumb" />
          </button>
        </div>
      </div>
    </div>
  )
})

const SectionInfoTooltip = memo(function SectionInfoTooltip({
  label,
  heading,
  messages
}: {
  label: string
  heading: string
  messages: string[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) return

    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setIsOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <div className="section-info-tooltip" ref={containerRef}>
      <button
        type="button"
        className={`section-info-trigger ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(prev => !prev)}
        aria-label={`查看${label}说明`}
        aria-expanded={isOpen}
      >
        <CircleHelp size={14} />
      </button>
      {isOpen && (
        <div className="section-info-popover" role="dialog" aria-label={`${label}说明`}>
          <h4>{heading}</h4>
          {messages.map(message => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
    </div>
  )
})

interface TaskCenterModalProps {
  isOpen: boolean
  tasks: ExportTask[]
  taskRunningCount: number
  taskQueuedCount: number
  expandedPerfTaskId: string | null
  nowTick: number
  onClose: () => void
  onTogglePerfTask: (taskId: string) => void
}

const TaskCenterModal = memo(function TaskCenterModal({
  isOpen,
  tasks,
  taskRunningCount,
  taskQueuedCount,
  expandedPerfTaskId,
  nowTick,
  onClose,
  onTogglePerfTask
}: TaskCenterModalProps) {
  if (!isOpen) return null

  return (
    <div
      className="task-center-modal-overlay"
      onClick={onClose}
    >
      <div
        className="task-center-modal"
        role="dialog"
        aria-modal="true"
        aria-label="任务中心"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="task-center-modal-header">
          <div className="task-center-modal-title">
            <h3>任务中心</h3>
            <span>进行中 {taskRunningCount} · 排队 {taskQueuedCount} · 总计 {tasks.length}</span>
          </div>
          <button
            className="close-icon-btn"
            type="button"
            onClick={onClose}
            aria-label="关闭任务中心"
          >
            <X size={16} />
          </button>
        </div>
        <div className="task-center-modal-body">
          {tasks.length === 0 ? (
            <div className="task-empty">暂无任务。点击会话导出或卡片导出后会在这里创建任务。</div>
          ) : (
            <div className="task-list">
              {tasks.map(task => {
                const canShowPerfDetail = isTextBatchTask(task) && Boolean(task.performance)
                const isPerfExpanded = expandedPerfTaskId === task.id
                const stageTotals = canShowPerfDetail
                  ? getTaskPerformanceStageTotals(task.performance, nowTick)
                  : null
                const stageTotalMs = stageTotals
                  ? stageTotals.collect + stageTotals.build + stageTotals.write + stageTotals.other
                  : 0
                const topSessions = isPerfExpanded
                  ? getTaskPerformanceTopSessions(task.performance, nowTick, 5)
                  : []
                const normalizedProgressTotal = task.progress.total > 0 ? task.progress.total : 0
                const normalizedProgressCurrent = normalizedProgressTotal > 0
                  ? Math.max(0, Math.min(normalizedProgressTotal, task.progress.current))
                  : 0
                const completedSessionTotal = normalizedProgressTotal > 0
                  ? normalizedProgressTotal
                  : task.payload.sessionIds.length
                const completedSessionCount = Math.min(
                  completedSessionTotal,
                  (task.settledSessionIds || []).length
                )
                const exportedMessages = Math.max(0, Math.floor(task.progress.exportedMessages || 0))
                const estimatedTotalMessages = Math.max(0, Math.floor(task.progress.estimatedTotalMessages || 0))
                const collectedMessages = Math.max(0, Math.floor(task.progress.collectedMessages || 0))
                const messageProgressLabel = estimatedTotalMessages > 0
                  ? `已导出 ${Math.min(exportedMessages, estimatedTotalMessages)}/${estimatedTotalMessages} 条`
                  : `已导出 ${exportedMessages} 条`
                const effectiveMessageProgressLabel = (
                  exportedMessages > 0 || estimatedTotalMessages > 0 || collectedMessages <= 0 || task.progress.phase !== 'preparing'
                )
                  ? messageProgressLabel
                  : `已收集 ${collectedMessages.toLocaleString()} 条`
                const phaseProgress = Math.max(0, Math.floor(task.progress.phaseProgress || 0))
                const phaseTotal = Math.max(0, Math.floor(task.progress.phaseTotal || 0))
                const mediaDoneFiles = Math.max(0, Math.floor(task.progress.mediaDoneFiles || 0))
                const mediaCacheHitFiles = Math.max(0, Math.floor(task.progress.mediaCacheHitFiles || 0))
                const mediaCacheMissFiles = Math.max(0, Math.floor(task.progress.mediaCacheMissFiles || 0))
                const mediaDedupReuseFiles = Math.max(0, Math.floor(task.progress.mediaDedupReuseFiles || 0))
                const mediaCacheTotal = mediaCacheHitFiles + mediaCacheMissFiles
                const mediaCacheMetricLabel = mediaCacheTotal > 0
                  ? `缓存命中 ${mediaCacheHitFiles}/${mediaCacheTotal}`
                  : ''
                const mediaDedupMetricLabel = mediaDedupReuseFiles > 0
                  ? `复用 ${mediaDedupReuseFiles}`
                  : ''
                const phaseMetricLabel = phaseTotal > 0
                  ? (
                    task.progress.phase === 'exporting-media'
                      ? `媒体 ${Math.min(phaseProgress, phaseTotal)}/${phaseTotal}`
                      : task.progress.phase === 'exporting-voice'
                        ? `语音 ${Math.min(phaseProgress, phaseTotal)}/${phaseTotal}`
                        : ''
                  )
                  : ''
                const mediaLiveMetricLabel = task.progress.phase === 'exporting-media'
                  ? (mediaDoneFiles > 0 ? `已处理 ${mediaDoneFiles}` : '')
                  : ''
                const sessionProgressLabel = completedSessionTotal > 0
                  ? `会话 ${completedSessionCount}/${completedSessionTotal}`
                  : '会话处理中'
                const currentSessionRatio = task.progress.phaseTotal > 0
                  ? Math.max(0, Math.min(1, task.progress.phaseProgress / task.progress.phaseTotal))
                  : null
                return (
                  <div key={task.id} className={`task-card ${task.status}`}>
                    <div className="task-main">
                      <div className="task-title">{task.title}</div>
                      <div className="task-meta">
                        <span className={`task-status ${task.status}`}>{getTaskStatusLabel(task)}</span>
                        <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
                      </div>
                      {task.status === 'running' && (
                        <>
                          <div className="task-progress-bar">
                            <div
                              className="task-progress-fill"
                              style={{ width: `${normalizedProgressTotal > 0 ? (normalizedProgressCurrent / normalizedProgressTotal) * 100 : 0}%` }}
                            />
                          </div>
                          <div className="task-progress-text">
                            {`${sessionProgressLabel} · ${effectiveMessageProgressLabel}`}
                            {phaseMetricLabel ? ` · ${phaseMetricLabel}` : ''}
                            {mediaLiveMetricLabel ? ` · ${mediaLiveMetricLabel}` : ''}
                            {mediaCacheMetricLabel ? ` · ${mediaCacheMetricLabel}` : ''}
                            {mediaDedupMetricLabel ? ` · ${mediaDedupMetricLabel}` : ''}
                            {task.status === 'running' && currentSessionRatio !== null
                              ? `（当前会话 ${Math.round(currentSessionRatio * 100)}%）`
                              : ''}
                            {task.progress.phaseLabel ? ` · ${task.progress.phaseLabel}` : ''}
                          </div>
                        </>
                      )}
                      {canShowPerfDetail && stageTotals && (
                        <div className="task-perf-summary">
                          <span>累计耗时 {formatDurationMs(stageTotalMs)}</span>
                          {task.progress.total > 0 && (
                            <span>平均/会话 {formatDurationMs(Math.floor(stageTotalMs / Math.max(1, task.progress.total)))}</span>
                          )}
                        </div>
                      )}
                      {canShowPerfDetail && isPerfExpanded && stageTotals && (
                        <div className="task-perf-panel">
                          <div className="task-perf-title">阶段耗时分布</div>
                          {[
                            { key: 'collect' as const, label: '收集消息' },
                            { key: 'build' as const, label: '构建消息' },
                            { key: 'write' as const, label: '写入文件' },
                            { key: 'other' as const, label: '其他' }
                          ].map(item => {
                            const value = stageTotals[item.key]
                            const ratio = stageTotalMs > 0 ? Math.min(100, (value / stageTotalMs) * 100) : 0
                            return (
                              <div className="task-perf-row" key={item.key}>
                                <div className="task-perf-row-head">
                                  <span>{item.label}</span>
                                  <span>{formatDurationMs(value)}</span>
                                </div>
                                <div className="task-perf-row-track">
                                  <div className="task-perf-row-fill" style={{ width: `${ratio}%` }} />
                                </div>
                              </div>
                            )
                          })}
                          <div className="task-perf-title">最慢会话 Top5</div>
                          {topSessions.length === 0 ? (
                            <div className="task-perf-empty">暂无会话耗时数据</div>
                          ) : (
                            <div className="task-perf-session-list">
                              {topSessions.map((session, index) => (
                                <div className="task-perf-session-item" key={session.sessionId}>
                                  <span className="task-perf-session-rank">
                                    {index + 1}. {session.sessionName || session.sessionId}
                                    {!session.finishedAt ? '（进行中）' : ''}
                                  </span>
                                  <span className="task-perf-session-time">{formatDurationMs(session.liveElapsedMs)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {task.status === 'error' && <div className="task-error">{task.error || '任务失败'}</div>}
                    </div>
                    <div className="task-actions">
                      {canShowPerfDetail && (
                        <button
                          className={`task-action-btn ${isPerfExpanded ? 'primary' : ''}`}
                          type="button"
                          onClick={() => onTogglePerfTask(task.id)}
                        >
                          {isPerfExpanded ? '收起详情' : '性能详情'}
                        </button>
                      )}
                      <button className="task-action-btn" onClick={() => task.payload.outputDir && void window.electronAPI.shell.openPath(task.payload.outputDir)}>
                        <FolderOpen size={14} /> 目录
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

function ExportPage() {
  const navigate = useNavigate()
  const { setCurrentSession } = useChatStore()
  const location = useLocation()
  const isExportRoute = location.pathname === '/export'

  const [isLoading, setIsLoading] = useState(true)
  const [isSessionEnriching, setIsSessionEnriching] = useState(false)
  const [isSnsStatsLoading, setIsSnsStatsLoading] = useState(true)
  const [isBaseConfigLoading, setIsBaseConfigLoading] = useState(true)
  const [isTaskCenterOpen, setIsTaskCenterOpen] = useState(false)
  const [expandedPerfTaskId, setExpandedPerfTaskId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [sessionDataSource, setSessionDataSource] = useState<SessionDataSource>(null)
  const [sessionContactsUpdatedAt, setSessionContactsUpdatedAt] = useState<number | null>(null)
  const [sessionAvatarUpdatedAt, setSessionAvatarUpdatedAt] = useState<number | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [activeTab, setActiveTab] = useState<ConversationTab>('private')
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [contactsList, setContactsList] = useState<ContactInfo[]>([])
  const [isContactsListLoading, setIsContactsListLoading] = useState(true)
  const [, setContactsDataSource] = useState<ContactsDataSource>(null)
  const [contactsUpdatedAt, setContactsUpdatedAt] = useState<number | null>(null)
  const [avatarCacheUpdatedAt, setAvatarCacheUpdatedAt] = useState<number | null>(null)
  const [sessionMessageCounts, setSessionMessageCounts] = useState<Record<string, number>>({})
  const [isLoadingSessionCounts, setIsLoadingSessionCounts] = useState(false)
  const [isSessionCountStageReady, setIsSessionCountStageReady] = useState(false)
  const [sessionContentMetrics, setSessionContentMetrics] = useState<Record<string, SessionContentMetric>>({})
  const [sessionLoadTraceMap, setSessionLoadTraceMap] = useState<Record<string, SessionLoadTraceState>>({})
  const [sessionLoadProgressPulseMap, setSessionLoadProgressPulseMap] = useState<Record<string, { at: number; delta: number }>>({})
  const [contactsLoadTimeoutMs, setContactsLoadTimeoutMs] = useState(DEFAULT_CONTACTS_LOAD_TIMEOUT_MS)
  const [contactsLoadSession, setContactsLoadSession] = useState<ContactsLoadSession | null>(null)
  const [contactsLoadIssue, setContactsLoadIssue] = useState<ContactsLoadIssue | null>(null)
  const [showContactsDiagnostics, setShowContactsDiagnostics] = useState(false)
  const [contactsDiagnosticTick, setContactsDiagnosticTick] = useState(Date.now())
  const [showSessionDetailPanel, setShowSessionDetailPanel] = useState(false)
  const [showSessionLoadDetailModal, setShowSessionLoadDetailModal] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingSessionDetail, setIsLoadingSessionDetail] = useState(false)
  const [isLoadingSessionDetailExtra, setIsLoadingSessionDetailExtra] = useState(false)
  const [isRefreshingSessionDetailStats, setIsRefreshingSessionDetailStats] = useState(false)
  const [isLoadingSessionRelationStats, setIsLoadingSessionRelationStats] = useState(false)
  const [copiedDetailField, setCopiedDetailField] = useState<string | null>(null)
  const [snsUserPostCounts, setSnsUserPostCounts] = useState<Record<string, number>>({})
  const [snsUserPostCountsStatus, setSnsUserPostCountsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [sessionSnsTimelineTarget, setSessionSnsTimelineTarget] = useState<SessionSnsTimelineTarget | null>(null)
  const [sessionSnsTimelinePosts, setSessionSnsTimelinePosts] = useState<SnsPost[]>([])
  const [sessionSnsTimelineLoading, setSessionSnsTimelineLoading] = useState(false)
  const [sessionSnsTimelineLoadingMore, setSessionSnsTimelineLoadingMore] = useState(false)
  const [sessionSnsTimelineHasMore, setSessionSnsTimelineHasMore] = useState(false)
  const [sessionSnsTimelineTotalPosts, setSessionSnsTimelineTotalPosts] = useState<number | null>(null)
  const [sessionSnsTimelineStatsLoading, setSessionSnsTimelineStatsLoading] = useState(false)
  const [sessionSnsRankMode, setSessionSnsRankMode] = useState<SnsRankMode | null>(null)
  const [sessionSnsLikeRankings, setSessionSnsLikeRankings] = useState<SessionSnsRankItem[]>([])
  const [sessionSnsCommentRankings, setSessionSnsCommentRankings] = useState<SessionSnsRankItem[]>([])
  const [sessionSnsRankLoading, setSessionSnsRankLoading] = useState(false)
  const [sessionSnsRankError, setSessionSnsRankError] = useState<string | null>(null)
  const [sessionSnsRankLoadedPosts, setSessionSnsRankLoadedPosts] = useState(0)
  const [sessionSnsRankTotalPosts, setSessionSnsRankTotalPosts] = useState<number | null>(null)
  const [sessionMutualFriendsMetrics, setSessionMutualFriendsMetrics] = useState<Record<string, SessionMutualFriendsMetric>>({})
  const [sessionMutualFriendsDialogTarget, setSessionMutualFriendsDialogTarget] = useState<SessionSnsTimelineTarget | null>(null)
  const [sessionMutualFriendsSearch, setSessionMutualFriendsSearch] = useState('')
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskRecord[]>([])

  const [exportFolder, setExportFolder] = useState('')
  const [writeLayout, setWriteLayout] = useState<configService.ExportWriteLayout>('B')
  const [sessionNameWithTypePrefix, setSessionNameWithTypePrefix] = useState(true)
  const [snsExportFormat, setSnsExportFormat] = useState<SnsTimelineExportFormat>('html')
  const [snsExportImages, setSnsExportImages] = useState(false)
  const [snsExportLivePhotos, setSnsExportLivePhotos] = useState(false)
  const [snsExportVideos, setSnsExportVideos] = useState(false)
  const [isTimeRangeDialogOpen, setIsTimeRangeDialogOpen] = useState(false)
  const [isResolvingTimeRangeBounds, setIsResolvingTimeRangeBounds] = useState(false)
  const [timeRangeBounds, setTimeRangeBounds] = useState<TimeRangeBounds | null>(null)
  const [isExportDefaultsModalOpen, setIsExportDefaultsModalOpen] = useState(false)
  const [timeRangeSelection, setTimeRangeSelection] = useState<ExportDateRangeSelection>(() => createDefaultExportDateRangeSelection())
  const [exportDefaultFormat, setExportDefaultFormat] = useState<TextExportFormat>('excel')
  const [exportDefaultAvatars, setExportDefaultAvatars] = useState(true)
  const [exportDefaultDateRangeSelection, setExportDefaultDateRangeSelection] = useState<ExportDateRangeSelection>(() => createDefaultExportDateRangeSelection())
  const [exportDefaultMedia, setExportDefaultMedia] = useState<configService.ExportDefaultMediaConfig>({
    images: true,
    videos: true,
    voices: true,
    emojis: true
  })
  const [exportDefaultVoiceAsText, setExportDefaultVoiceAsText] = useState(false)
  const [exportDefaultExcelCompactColumns, setExportDefaultExcelCompactColumns] = useState(true)
  const [exportDefaultConcurrency, setExportDefaultConcurrency] = useState(2)
  const [exportDefaultImageDeepSearchOnMiss, setExportDefaultImageDeepSearchOnMiss] = useState(true)

  const [options, setOptions] = useState<ExportOptions>({
    format: 'json',
    dateRange: {
      start: new Date(new Date().setHours(0, 0, 0, 0)),
      end: new Date()
    },
    useAllTime: false,
    exportAvatars: true,
    exportMedia: true,
    exportImages: true,
    exportVoices: true,
    exportVideos: true,
        exportEmojis: true,
    exportVoiceAsText: false,
    excelCompactColumns: true,
    txtColumns: defaultTxtColumns,
    displayNamePreference: 'remark',
    exportConcurrency: 2,
    imageDeepSearchOnMiss: true
  })

  const [exportDialog, setExportDialog] = useState<ExportDialogState>({
    open: false,
    scope: 'single',
    sessionIds: [],
    sessionNames: [],
    title: ''
  })
  const [showSessionFormatSelect, setShowSessionFormatSelect] = useState(false)

  const [tasks, setTasks] = useState<ExportTask[]>([])
  const [lastExportBySession, setLastExportBySession] = useState<Record<string, number>>({})
  const [lastExportByContent, setLastExportByContent] = useState<Record<string, number>>({})
  const [exportRecordsBySession, setExportRecordsBySession] = useState<Record<string, configService.ExportSessionRecordEntry[]>>({})
  const [lastSnsExportPostCount, setLastSnsExportPostCount] = useState(0)
  const [snsStats, setSnsStats] = useState<{ totalPosts: number; totalFriends: number }>({
    totalPosts: 0,
    totalFriends: 0
  })
  const [hasSeededSnsStats, setHasSeededSnsStats] = useState(false)
  const [nowTick, setNowTick] = useState(Date.now())
  const [isContactsListAtTop, setIsContactsListAtTop] = useState(true)
  const [isContactsHeaderDragging, setIsContactsHeaderDragging] = useState(false)
  const [contactsListScrollParent, setContactsListScrollParent] = useState<HTMLDivElement | null>(null)
  const [contactsHorizontalScrollMetrics, setContactsHorizontalScrollMetrics] = useState({
    viewportWidth: 0,
    contentWidth: 0
  })
  const tabCounts = useContactTypeCountsStore(state => state.tabCounts)
  const isSharedTabCountsLoading = useContactTypeCountsStore(state => state.isLoading)
  const isSharedTabCountsReady = useContactTypeCountsStore(state => state.isReady)
  const ensureSharedTabCountsLoaded = useContactTypeCountsStore(state => state.ensureLoaded)
  const syncContactTypeCounts = useContactTypeCountsStore(state => state.syncFromContacts)

  const progressUnsubscribeRef = useRef<(() => void) | null>(null)
  const runningTaskIdRef = useRef<string | null>(null)
  const tasksRef = useRef<ExportTask[]>([])
  const hasSeededSnsStatsRef = useRef(false)
  const sessionLoadTokenRef = useRef(0)
  const preselectAppliedRef = useRef(false)
  const exportCacheScopeRef = useRef('default')
  const exportCacheScopeReadyRef = useRef(false)
  const contactsLoadVersionRef = useRef(0)
  const contactsLoadAttemptRef = useRef(0)
  const contactsLoadTimeoutTimerRef = useRef<number | null>(null)
  const contactsLoadTimeoutMsRef = useRef(DEFAULT_CONTACTS_LOAD_TIMEOUT_MS)
  const contactsAvatarCacheRef = useRef<Record<string, configService.ContactsAvatarCacheEntry>>({})
  const contactsVirtuosoRef = useRef<VirtuosoHandle | null>(null)
  const sessionTableSectionRef = useRef<HTMLDivElement | null>(null)
  const contactsHorizontalViewportRef = useRef<HTMLDivElement | null>(null)
  const contactsHorizontalContentRef = useRef<HTMLDivElement | null>(null)
  const contactsBottomScrollbarRef = useRef<HTMLDivElement | null>(null)
  const contactsScrollSyncSourceRef = useRef<'viewport' | 'bottom' | null>(null)
  const contactsHeaderDragStateRef = useRef({
    pointerId: -1,
    startClientX: 0,
    startScrollLeft: 0,
    didDrag: false
  })
  const sessionFormatDropdownRef = useRef<HTMLDivElement | null>(null)
  const detailRequestSeqRef = useRef(0)
  const sessionsRef = useRef<SessionRow[]>([])
  const sessionContentMetricsRef = useRef<Record<string, SessionContentMetric>>({})
  const contactsListSizeRef = useRef(0)
  const contactsUpdatedAtRef = useRef<number | null>(null)
  const sessionsHydratedAtRef = useRef(0)
  const snsStatsHydratedAtRef = useRef(0)
  const inProgressSessionIdsRef = useRef<string[]>([])
  const activeTaskCountRef = useRef(0)
  const hasBaseConfigReadyRef = useRef(false)
  const sessionCountRequestIdRef = useRef(0)
  const isLoadingSessionCountsRef = useRef(false)
  const activeTabRef = useRef<ConversationTab>('private')
  const detailStatsPriorityRef = useRef(false)
  const sessionSnsTimelinePostsRef = useRef<SnsPost[]>([])
  const sessionSnsTimelineLoadingRef = useRef(false)
  const sessionSnsTimelineRequestTokenRef = useRef(0)
  const sessionSnsRankRequestTokenRef = useRef(0)
  const sessionSnsRankLoadingRef = useRef(false)
  const sessionSnsRankCacheRef = useRef<Record<string, SessionSnsRankCacheEntry>>({})
  const snsUserPostCountsHydrationTokenRef = useRef(0)
  const snsUserPostCountsBatchTimerRef = useRef<number | null>(null)
  const sessionPreciseRefreshAtRef = useRef<Record<string, number>>({})
  const sessionLoadProgressSnapshotRef = useRef<Record<string, { loaded: number; total: number }>>({})
  const sessionMediaMetricQueueRef = useRef<string[]>([])
  const sessionMediaMetricQueuedSetRef = useRef<Set<string>>(new Set())
  const sessionMediaMetricLoadingSetRef = useRef<Set<string>>(new Set())
  const sessionMediaMetricReadySetRef = useRef<Set<string>>(new Set())
  const sessionMediaMetricRunIdRef = useRef(0)
  const sessionMediaMetricWorkerRunningRef = useRef(false)
  const sessionMediaMetricBackgroundFeedTimerRef = useRef<number | null>(null)
  const sessionMediaMetricPersistTimerRef = useRef<number | null>(null)
  const sessionMediaMetricPendingPersistRef = useRef<Record<string, configService.ExportSessionContentMetricCacheEntry>>({})
  const sessionMediaMetricVisibleRangeRef = useRef<{ startIndex: number; endIndex: number }>({
    startIndex: 0,
    endIndex: -1
  })
  const avatarHydrationRequestedRef = useRef<Set<string>>(new Set())
  const sessionMutualFriendsMetricsRef = useRef<Record<string, SessionMutualFriendsMetric>>({})
  const sessionMutualFriendsDirectMetricsRef = useRef<Record<string, SessionMutualFriendsMetric>>({})
  const sessionMutualFriendsQueueRef = useRef<string[]>([])
  const sessionMutualFriendsQueuedSetRef = useRef<Set<string>>(new Set())
  const sessionMutualFriendsLoadingSetRef = useRef<Set<string>>(new Set())
  const sessionMutualFriendsReadySetRef = useRef<Set<string>>(new Set())
  const sessionMutualFriendsRunIdRef = useRef(0)
  const sessionMutualFriendsWorkerRunningRef = useRef(false)
  const sessionMutualFriendsBackgroundFeedTimerRef = useRef<number | null>(null)
  const sessionMutualFriendsPersistTimerRef = useRef<number | null>(null)
  const sessionMutualFriendsVisibleRangeRef = useRef<{ startIndex: number; endIndex: number }>({
    startIndex: 0,
    endIndex: -1
  })

  const handleContactsListScrollParentRef = useCallback((node: HTMLDivElement | null) => {
    setContactsListScrollParent(prev => (prev === node ? prev : node))
  }, [])

  const ensureExportCacheScope = useCallback(async (): Promise<string> => {
    if (exportCacheScopeReadyRef.current) {
      return exportCacheScopeRef.current
    }
    const [myWxid, dbPath] = await Promise.all([
      configService.getMyWxid(),
      configService.getDbPath()
    ])
    const scopeKey = dbPath || myWxid
      ? `${dbPath || ''}::${myWxid || ''}`
      : 'default'
    exportCacheScopeRef.current = scopeKey
    exportCacheScopeReadyRef.current = true
    return scopeKey
  }, [])

  const loadContactsCaches = useCallback(async (scopeKey: string) => {
    const [contactsItem, avatarItem] = await Promise.all([
      configService.getContactsListCache(scopeKey),
      configService.getContactsAvatarCache(scopeKey)
    ])
    return {
      contactsItem,
      avatarItem
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const value = await configService.getContactsLoadTimeoutMs()
        if (!cancelled) {
          setContactsLoadTimeoutMs(value)
        }
      } catch (error) {
        console.error('读取通讯录超时配置失败:', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    contactsLoadTimeoutMsRef.current = contactsLoadTimeoutMs
  }, [contactsLoadTimeoutMs])

  useEffect(() => {
    isLoadingSessionCountsRef.current = isLoadingSessionCounts
  }, [isLoadingSessionCounts])

  useEffect(() => {
    sessionContentMetricsRef.current = sessionContentMetrics
  }, [sessionContentMetrics])

  useEffect(() => {
    sessionMutualFriendsMetricsRef.current = sessionMutualFriendsMetrics
  }, [sessionMutualFriendsMetrics])

  const patchSessionLoadTraceStage = useCallback((
    sessionIds: string[],
    stageKey: keyof SessionLoadTraceState,
    status: SessionLoadStageStatus,
    options?: { force?: boolean; error?: string }
  ) => {
    if (sessionIds.length === 0) return
    const now = Date.now()
    setSessionLoadTraceMap(prev => {
      let changed = false
      const next = { ...prev }
      for (const sessionIdRaw of sessionIds) {
        const sessionId = String(sessionIdRaw || '').trim()
        if (!sessionId) continue
        const prevTrace = next[sessionId] || createDefaultSessionLoadTrace()
        const prevStage = prevTrace[stageKey] || createDefaultSessionLoadStage()
        if (!options?.force && prevStage.status === 'done' && status !== 'done') {
          continue
        }
        let stageChanged = false
        const nextStage: SessionLoadStageState = { ...prevStage }
        if (nextStage.status !== status) {
          nextStage.status = status
          stageChanged = true
        }
        if (status === 'loading') {
          if (!nextStage.startedAt) {
            nextStage.startedAt = now
            stageChanged = true
          }
          if (nextStage.finishedAt) {
            nextStage.finishedAt = undefined
            stageChanged = true
          }
          if (nextStage.error) {
            nextStage.error = undefined
            stageChanged = true
          }
        } else if (status === 'done') {
          if (!nextStage.startedAt) {
            nextStage.startedAt = now
            stageChanged = true
          }
          if (!nextStage.finishedAt) {
            nextStage.finishedAt = now
            stageChanged = true
          }
          if (nextStage.error) {
            nextStage.error = undefined
            stageChanged = true
          }
        } else if (status === 'failed') {
          if (!nextStage.startedAt) {
            nextStage.startedAt = now
            stageChanged = true
          }
          if (!nextStage.finishedAt) {
            nextStage.finishedAt = now
            stageChanged = true
          }
          const nextError = options?.error || '加载失败'
          if (nextStage.error !== nextError) {
            nextStage.error = nextError
            stageChanged = true
          }
        } else if (status === 'pending') {
          if (nextStage.startedAt !== undefined) {
            nextStage.startedAt = undefined
            stageChanged = true
          }
          if (nextStage.finishedAt !== undefined) {
            nextStage.finishedAt = undefined
            stageChanged = true
          }
          if (nextStage.error !== undefined) {
            nextStage.error = undefined
            stageChanged = true
          }
        }
        if (!stageChanged) continue
        next[sessionId] = {
          ...prevTrace,
          [stageKey]: nextStage
        }
        changed = true
      }
      return changed ? next : prev
    })
  }, [])

  const loadContactsList = useCallback(async (options?: { scopeKey?: string }) => {
    const scopeKey = options?.scopeKey || await ensureExportCacheScope()
    const loadVersion = contactsLoadVersionRef.current + 1
    contactsLoadVersionRef.current = loadVersion
    contactsLoadAttemptRef.current += 1
    const startedAt = Date.now()
    const timeoutMs = contactsLoadTimeoutMsRef.current
    const requestId = `export-contacts-${startedAt}-${contactsLoadAttemptRef.current}`
    setContactsLoadSession({
      requestId,
      startedAt,
      attempt: contactsLoadAttemptRef.current,
      timeoutMs
    })
    setContactsLoadIssue(null)
    setShowContactsDiagnostics(false)
    if (contactsLoadTimeoutTimerRef.current) {
      window.clearTimeout(contactsLoadTimeoutTimerRef.current)
      contactsLoadTimeoutTimerRef.current = null
    }
    const timeoutTimerId = window.setTimeout(() => {
      if (contactsLoadVersionRef.current !== loadVersion) return
      const elapsedMs = Date.now() - startedAt
      setContactsLoadIssue({
        kind: 'timeout',
        title: '联系人列表加载超时',
        message: `等待超过 ${timeoutMs}ms，联系人列表仍未返回。`,
        reason: 'chat.getContacts 长时间未返回，可能是数据库查询繁忙或连接异常。',
        occurredAt: Date.now(),
        elapsedMs
      })
    }, timeoutMs)
    contactsLoadTimeoutTimerRef.current = timeoutTimerId

    setIsContactsListLoading(true)
    try {
      const contactsResult = await window.electronAPI.chat.getContacts({ lite: true })
      if (contactsLoadVersionRef.current !== loadVersion) return

      if (contactsResult.success && contactsResult.contacts) {
        if (contactsLoadTimeoutTimerRef.current === timeoutTimerId) {
          window.clearTimeout(contactsLoadTimeoutTimerRef.current)
          contactsLoadTimeoutTimerRef.current = null
        }
        const contactsWithAvatarCache = mergeAvatarCacheIntoContacts(
          contactsResult.contacts,
          contactsAvatarCacheRef.current
        )
        setContactsList(contactsWithAvatarCache)
        syncContactTypeCounts(contactsWithAvatarCache)
        setContactsDataSource('network')
        setContactsUpdatedAt(Date.now())
        setContactsLoadIssue(null)
        setIsContactsListLoading(false)

        const upsertResult = upsertAvatarCacheFromContacts(
          contactsAvatarCacheRef.current,
          contactsWithAvatarCache,
          { prune: true }
        )
        contactsAvatarCacheRef.current = upsertResult.avatarEntries
        if (upsertResult.updatedAt) {
          setAvatarCacheUpdatedAt(upsertResult.updatedAt)
        }

        void configService.setContactsAvatarCache(scopeKey, contactsAvatarCacheRef.current).catch((error) => {
          console.error('写入导出页头像缓存失败:', error)
        })
        void configService.setContactsListCache(
          scopeKey,
          contactsWithAvatarCache.map(contact => ({
            username: contact.username,
            displayName: contact.displayName,
            remark: contact.remark,
            nickname: contact.nickname,
            alias: contact.alias,
            type: contact.type
          }))
        ).catch((error) => {
          console.error('写入导出页通讯录缓存失败:', error)
        })
        return
      }

      const elapsedMs = Date.now() - startedAt
      setContactsLoadIssue({
        kind: 'error',
        title: '联系人列表加载失败',
        message: '联系人接口返回失败，未拿到联系人列表。',
        reason: 'chat.getContacts 返回 success=false。',
        errorDetail: contactsResult.error || '未知错误',
        occurredAt: Date.now(),
        elapsedMs
      })
    } catch (error) {
      console.error('加载导出页联系人失败:', error)
      const elapsedMs = Date.now() - startedAt
      setContactsLoadIssue({
        kind: 'error',
        title: '联系人列表加载失败',
        message: '联系人请求执行异常。',
        reason: '调用 chat.getContacts 发生异常。',
        errorDetail: String(error),
        occurredAt: Date.now(),
        elapsedMs
      })
    } finally {
      if (contactsLoadTimeoutTimerRef.current === timeoutTimerId) {
        window.clearTimeout(contactsLoadTimeoutTimerRef.current)
        contactsLoadTimeoutTimerRef.current = null
      }
      if (contactsLoadVersionRef.current === loadVersion) {
        setIsContactsListLoading(false)
      }
    }
  }, [ensureExportCacheScope, syncContactTypeCounts])

  const hydrateVisibleContactAvatars = useCallback(async (usernames: string[]) => {
    const targets = Array.from(new Set(
      (usernames || [])
        .map((username) => String(username || '').trim())
        .filter(Boolean)
    )).filter((username) => {
      if (avatarHydrationRequestedRef.current.has(username)) return false
      const contact = contactsList.find((item) => item.username === username)
      const session = sessions.find((item) => item.username === username)
      const existingAvatarUrl = normalizeExportAvatarUrl(contact?.avatarUrl || session?.avatarUrl)
      return !existingAvatarUrl
    })

    if (targets.length === 0) return
    targets.forEach((username) => avatarHydrationRequestedRef.current.add(username))

    const settled = await Promise.allSettled(
      targets.map(async (username) => {
        const profile = await window.electronAPI.chat.getContactAvatar(username)
        return {
          username,
          avatarUrl: normalizeExportAvatarUrl(profile?.avatarUrl),
          displayName: profile?.displayName ? String(profile.displayName).trim() : undefined
        }
      })
    )

    const avatarPatches = new Map<string, { avatarUrl?: string; displayName?: string }>()
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue
      const { username, avatarUrl, displayName } = item.value
      if (!avatarUrl && !displayName) continue
      avatarPatches.set(username, { avatarUrl, displayName })
    }
    if (avatarPatches.size === 0) return

    const now = Date.now()
    setContactsList((prev) => prev.map((contact) => {
      const patch = avatarPatches.get(contact.username)
      if (!patch) return contact
      return {
        ...contact,
        displayName: patch.displayName || contact.displayName,
        avatarUrl: patch.avatarUrl || contact.avatarUrl
      }
    }))
    setSessions((prev) => prev.map((session) => {
      const patch = avatarPatches.get(session.username)
      if (!patch) return session
      return {
        ...session,
        displayName: patch.displayName || session.displayName,
        avatarUrl: patch.avatarUrl || session.avatarUrl
      }
    }))
    setSessionDetail((prev) => {
      if (!prev) return prev
      const patch = avatarPatches.get(prev.wxid)
      if (!patch) return prev
      return {
        ...prev,
        displayName: patch.displayName || prev.displayName,
        avatarUrl: patch.avatarUrl || prev.avatarUrl
      }
    })

    let avatarCacheChanged = false
    for (const [username, patch] of avatarPatches.entries()) {
      if (!patch.avatarUrl) continue
      const previous = contactsAvatarCacheRef.current[username]
      if (previous?.avatarUrl === patch.avatarUrl) continue
      contactsAvatarCacheRef.current[username] = {
        avatarUrl: patch.avatarUrl,
        updatedAt: now,
        checkedAt: now
      }
      avatarCacheChanged = true
    }
    if (avatarCacheChanged) {
      setAvatarCacheUpdatedAt(now)
      const scopeKey = exportCacheScopeRef.current
      if (scopeKey) {
        void configService.setContactsAvatarCache(scopeKey, contactsAvatarCacheRef.current).catch(() => {})
      }
    }
  }, [contactsList, sessions])


  useEffect(() => {
    if (!isExportRoute) return
    let cancelled = false
    void (async () => {
      const scopeKey = await ensureExportCacheScope()
      if (cancelled) return
      let cachedContactsCount = 0
      let cachedContactsUpdatedAt = 0
      try {
        const [cacheItem, avatarCacheItem] = await Promise.all([
          configService.getContactsListCache(scopeKey),
          configService.getContactsAvatarCache(scopeKey)
        ])
        cachedContactsCount = Array.isArray(cacheItem?.contacts) ? cacheItem.contacts.length : 0
        cachedContactsUpdatedAt = Number(cacheItem?.updatedAt || 0)
        const avatarCacheMap = avatarCacheItem?.avatars || {}
        contactsAvatarCacheRef.current = avatarCacheMap
        setAvatarCacheUpdatedAt(avatarCacheItem?.updatedAt || null)
        if (!cancelled && cacheItem && Array.isArray(cacheItem.contacts) && cacheItem.contacts.length > 0) {
          const cachedContacts: ContactInfo[] = cacheItem.contacts.map(contact => ({
            ...contact,
            avatarUrl: avatarCacheMap[contact.username]?.avatarUrl
          }))
          setContactsList(cachedContacts)
          syncContactTypeCounts(cachedContacts)
          setContactsDataSource('cache')
          setContactsUpdatedAt(cacheItem.updatedAt || null)
          setIsContactsListLoading(false)
        }
      } catch (error) {
        console.error('读取导出页联系人缓存失败:', error)
      }

      const latestContactsUpdatedAt = Math.max(
        Number(contactsUpdatedAtRef.current || 0),
        cachedContactsUpdatedAt
      )
      const hasFreshContactSnapshot = (contactsListSizeRef.current > 0 || cachedContactsCount > 0) &&
        latestContactsUpdatedAt > 0 &&
        Date.now() - latestContactsUpdatedAt <= EXPORT_REENTER_CONTACTS_SOFT_REFRESH_MS

      if (!cancelled && !hasFreshContactSnapshot) {
        void loadContactsList({ scopeKey })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isExportRoute, ensureExportCacheScope, loadContactsList, syncContactTypeCounts])

  useEffect(() => {
    if (isExportRoute) return
    contactsLoadVersionRef.current += 1
  }, [isExportRoute])

  useEffect(() => {
    if (contactsLoadTimeoutTimerRef.current) {
      window.clearTimeout(contactsLoadTimeoutTimerRef.current)
      contactsLoadTimeoutTimerRef.current = null
    }
    return () => {
      if (contactsLoadTimeoutTimerRef.current) {
        window.clearTimeout(contactsLoadTimeoutTimerRef.current)
        contactsLoadTimeoutTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!contactsLoadIssue || contactsList.length > 0) return
    if (!(isContactsListLoading && contactsLoadIssue.kind === 'timeout')) return
    const timer = window.setInterval(() => {
      setContactsDiagnosticTick(Date.now())
    }, 500)
    return () => window.clearInterval(timer)
  }, [contactsList.length, isContactsListLoading, contactsLoadIssue])

  useEffect(() => {
    return subscribeBackgroundTasks(setBackgroundTasks)
  }, [])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    contactsListSizeRef.current = contactsList.length
  }, [contactsList.length])

  useEffect(() => {
    contactsUpdatedAtRef.current = contactsUpdatedAt
  }, [contactsUpdatedAt])

  useEffect(() => {
    if (!expandedPerfTaskId) return
    const target = tasks.find(task => task.id === expandedPerfTaskId)
    if (!target || !isTextBatchTask(target)) {
      setExpandedPerfTaskId(null)
    }
  }, [tasks, expandedPerfTaskId])

  useEffect(() => {
    hasSeededSnsStatsRef.current = hasSeededSnsStats
  }, [hasSeededSnsStats])

  useEffect(() => {
    sessionSnsTimelinePostsRef.current = sessionSnsTimelinePosts
  }, [sessionSnsTimelinePosts])

  const preselectSessionIds = useMemo(() => {
    const state = location.state as { preselectSessionIds?: unknown; preselectSessionId?: unknown } | null
    const rawList = Array.isArray(state?.preselectSessionIds)
      ? state?.preselectSessionIds
      : (typeof state?.preselectSessionId === 'string' ? [state.preselectSessionId] : [])

    return rawList
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  }, [location.state])

  useEffect(() => {
    if (!isExportRoute) return
    const timer = setInterval(() => setNowTick(Date.now()), 60 * 1000)
    return () => clearInterval(timer)
  }, [isExportRoute])

  useEffect(() => {
    if (!isTaskCenterOpen || !expandedPerfTaskId) return
    const target = tasks.find(task => task.id === expandedPerfTaskId)
    if (!target || target.status !== 'running' || !isTextBatchTask(target)) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isTaskCenterOpen, expandedPerfTaskId, tasks])

  const loadBaseConfig = useCallback(async (): Promise<boolean> => {
    setIsBaseConfigLoading(true)
    let isReady = true
    try {
      const [savedPath, savedFormat, savedAvatars, savedMedia, savedVoiceAsText, savedExcelCompactColumns, savedTxtColumns, savedConcurrency, savedImageDeepSearchOnMiss, savedSessionMap, savedContentMap, savedSessionRecordMap, savedSnsPostCount, savedWriteLayout, savedSessionNameWithTypePrefix, savedDefaultDateRange, exportCacheScope] = await Promise.all([
        configService.getExportPath(),
        configService.getExportDefaultFormat(),
        configService.getExportDefaultAvatars(),
        configService.getExportDefaultMedia(),
        configService.getExportDefaultVoiceAsText(),
        configService.getExportDefaultExcelCompactColumns(),
        configService.getExportDefaultTxtColumns(),
        configService.getExportDefaultConcurrency(),
        configService.getExportDefaultImageDeepSearchOnMiss(),
        configService.getExportLastSessionRunMap(),
        configService.getExportLastContentRunMap(),
        configService.getExportSessionRecordMap(),
        configService.getExportLastSnsPostCount(),
        configService.getExportWriteLayout(),
        configService.getExportSessionNamePrefixEnabled(),
        configService.getExportDefaultDateRange(),
        ensureExportCacheScope()
      ])

      const cachedSnsStats = await configService.getExportSnsStatsCache(exportCacheScope)

      if (savedPath) {
        setExportFolder(savedPath)
      } else {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        setExportFolder(downloadsPath)
      }

      setWriteLayout(savedWriteLayout)
      setSessionNameWithTypePrefix(savedSessionNameWithTypePrefix)
      setLastExportBySession(savedSessionMap)
      setLastExportByContent(savedContentMap)
      setExportRecordsBySession(savedSessionRecordMap)
      setLastSnsExportPostCount(savedSnsPostCount)
      setExportDefaultFormat((savedFormat as TextExportFormat) || 'excel')
      setExportDefaultAvatars(savedAvatars ?? true)
      setExportDefaultMedia(savedMedia ?? {
        images: true,
        videos: true,
        voices: true,
        emojis: true
      })
      setExportDefaultVoiceAsText(savedVoiceAsText ?? false)
      setExportDefaultExcelCompactColumns(savedExcelCompactColumns ?? true)
      setExportDefaultConcurrency(savedConcurrency ?? 2)
      setExportDefaultImageDeepSearchOnMiss(savedImageDeepSearchOnMiss ?? true)
      const resolvedDefaultDateRange = resolveExportDateRangeConfig(savedDefaultDateRange)
      setExportDefaultDateRangeSelection(resolvedDefaultDateRange)
      setTimeRangeSelection(resolvedDefaultDateRange)

      if (cachedSnsStats && Date.now() - cachedSnsStats.updatedAt <= EXPORT_SNS_STATS_CACHE_STALE_MS) {
        setSnsStats({
          totalPosts: cachedSnsStats.totalPosts || 0,
          totalFriends: cachedSnsStats.totalFriends || 0
        })
        snsStatsHydratedAtRef.current = Date.now()
        hasSeededSnsStatsRef.current = true
        setHasSeededSnsStats(true)
      }

      const txtColumns = savedTxtColumns && savedTxtColumns.length > 0 ? savedTxtColumns : defaultTxtColumns
      setOptions(prev => ({
        ...prev,
        format: ((savedFormat as TextExportFormat) || 'excel'),
        exportAvatars: savedAvatars ?? true,
        exportMedia: Boolean(
          (savedMedia?.images ?? prev.exportImages) ||
          (savedMedia?.voices ?? prev.exportVoices) ||
          (savedMedia?.videos ?? prev.exportVideos) ||
          (savedMedia?.emojis ?? prev.exportEmojis)
        ),
        exportImages: savedMedia?.images ?? prev.exportImages,
        exportVoices: savedMedia?.voices ?? prev.exportVoices,
        exportVideos: savedMedia?.videos ?? prev.exportVideos,
        exportEmojis: savedMedia?.emojis ?? prev.exportEmojis,
        exportVoiceAsText: savedVoiceAsText ?? prev.exportVoiceAsText,
        excelCompactColumns: savedExcelCompactColumns ?? prev.excelCompactColumns,
        txtColumns,
        exportConcurrency: savedConcurrency ?? prev.exportConcurrency,
        imageDeepSearchOnMiss: savedImageDeepSearchOnMiss ?? prev.imageDeepSearchOnMiss
      }))
    } catch (error) {
      isReady = false
      console.error('加载导出配置失败:', error)
    } finally {
      setIsBaseConfigLoading(false)
    }
    if (isReady) {
      hasBaseConfigReadyRef.current = true
    }
    return isReady
  }, [ensureExportCacheScope])

  const loadSnsStats = useCallback(async (options?: { full?: boolean; silent?: boolean }) => {
    if (!options?.silent) {
      setIsSnsStatsLoading(true)
    }

    const applyStats = async (next: { totalPosts: number; totalFriends: number } | null) => {
      if (!next) return
      const normalized = {
        totalPosts: Number.isFinite(next.totalPosts) ? Math.max(0, Math.floor(next.totalPosts)) : 0,
        totalFriends: Number.isFinite(next.totalFriends) ? Math.max(0, Math.floor(next.totalFriends)) : 0
      }
      setSnsStats(normalized)
      snsStatsHydratedAtRef.current = Date.now()
      hasSeededSnsStatsRef.current = true
      setHasSeededSnsStats(true)
      if (exportCacheScopeReadyRef.current) {
        await configService.setExportSnsStatsCache(exportCacheScopeRef.current, normalized)
      }
    }

    try {
      const fastResult = await withTimeout(window.electronAPI.sns.getExportStatsFast(), 2200)
      if (fastResult?.success && fastResult.data) {
        const fastStats = {
          totalPosts: fastResult.data.totalPosts || 0,
          totalFriends: fastResult.data.totalFriends || 0
        }
        if (fastStats.totalPosts > 0 || hasSeededSnsStatsRef.current) {
          await applyStats(fastStats)
        }
      }

      if (options?.full) {
        const result = await withTimeout(window.electronAPI.sns.getExportStats(), 9000)
        if (result?.success && result.data) {
          await applyStats({
            totalPosts: result.data.totalPosts || 0,
            totalFriends: result.data.totalFriends || 0
          })
        }
      }
    } catch (error) {
      console.error('加载朋友圈导出统计失败:', error)
    } finally {
      if (!options?.silent) {
        setIsSnsStatsLoading(false)
      }
    }
  }, [])

  const loadSnsUserPostCounts = useCallback(async (options?: { force?: boolean }) => {
    if (snsUserPostCountsStatus === 'loading') return
    if (!options?.force && snsUserPostCountsStatus === 'ready') return

    const targetSessionIds = sessionsRef.current
      .filter((session) => session.hasSession && isSingleContactSession(session.username))
      .map((session) => session.username)

    snsUserPostCountsHydrationTokenRef.current += 1
    const runToken = snsUserPostCountsHydrationTokenRef.current
    if (snsUserPostCountsBatchTimerRef.current) {
      window.clearTimeout(snsUserPostCountsBatchTimerRef.current)
      snsUserPostCountsBatchTimerRef.current = null
    }

    if (targetSessionIds.length === 0) {
      setSnsUserPostCountsStatus('ready')
      return
    }

    const scopeKey = exportCacheScopeReadyRef.current
      ? exportCacheScopeRef.current
      : await ensureExportCacheScope()
    const targetSet = new Set(targetSessionIds)
    let cachedCounts: Record<string, number> = {}
    try {
      const cached = await configService.getExportSnsUserPostCountsCache(scopeKey)
      cachedCounts = cached?.counts || {}
    } catch (cacheError) {
      console.error('读取导出页朋友圈条数缓存失败:', cacheError)
    }

    const cachedTargetCounts = Object.entries(cachedCounts).reduce<Record<string, number>>((acc, [sessionId, countRaw]) => {
      if (!targetSet.has(sessionId)) return acc
      const nextCount = Number(countRaw)
      acc[sessionId] = Number.isFinite(nextCount) ? Math.max(0, Math.floor(nextCount)) : 0
      return acc
    }, {})
    const cachedReadySessionIds = Object.keys(cachedTargetCounts)
    if (cachedReadySessionIds.length > 0) {
      setSnsUserPostCounts(prev => ({ ...prev, ...cachedTargetCounts }))
      patchSessionLoadTraceStage(cachedReadySessionIds, 'snsPostCounts', 'done')
    }

    const pendingSessionIds = options?.force
      ? targetSessionIds
      : targetSessionIds.filter((sessionId) => !(sessionId in cachedTargetCounts))
    if (pendingSessionIds.length === 0) {
      setSnsUserPostCountsStatus('ready')
      return
    }

    patchSessionLoadTraceStage(pendingSessionIds, 'snsPostCounts', 'pending', { force: true })
    patchSessionLoadTraceStage(pendingSessionIds, 'snsPostCounts', 'loading')
    setSnsUserPostCountsStatus('loading')

    let normalizedCounts: Record<string, number> = {}
    try {
      const result = await window.electronAPI.sns.getUserPostCounts()
      if (runToken !== snsUserPostCountsHydrationTokenRef.current) return

      if (!result.success || !result.counts) {
        patchSessionLoadTraceStage(pendingSessionIds, 'snsPostCounts', 'failed', {
          error: result.error || '朋友圈条数统计失败'
        })
        setSnsUserPostCountsStatus('error')
        return
      }

      for (const [rawUsername, rawCount] of Object.entries(result.counts)) {
        const username = String(rawUsername || '').trim()
        if (!username) continue
        const value = Number(rawCount)
        normalizedCounts[username] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
      }

      void (async () => {
        try {
          await configService.setExportSnsUserPostCountsCache(scopeKey, normalizedCounts)
        } catch (cacheError) {
          console.error('写入导出页朋友圈条数缓存失败:', cacheError)
        }
      })()
    } catch (error) {
      console.error('加载朋友圈用户条数失败:', error)
      if (runToken !== snsUserPostCountsHydrationTokenRef.current) return
      patchSessionLoadTraceStage(pendingSessionIds, 'snsPostCounts', 'failed', {
        error: String(error)
      })
      setSnsUserPostCountsStatus('error')
      return
    }

    let cursor = 0
    const applyBatch = () => {
      if (runToken !== snsUserPostCountsHydrationTokenRef.current) return

      const batchSessionIds = pendingSessionIds.slice(cursor, cursor + SNS_USER_POST_COUNT_BATCH_SIZE)
      if (batchSessionIds.length === 0) {
        setSnsUserPostCountsStatus('ready')
        snsUserPostCountsBatchTimerRef.current = null
        return
      }

      const batchCounts: Record<string, number> = {}
      for (const sessionId of batchSessionIds) {
        const nextCount = normalizedCounts[sessionId]
        batchCounts[sessionId] = Number.isFinite(nextCount) ? Math.max(0, Math.floor(nextCount)) : 0
      }

      setSnsUserPostCounts(prev => ({ ...prev, ...batchCounts }))
      patchSessionLoadTraceStage(batchSessionIds, 'snsPostCounts', 'done')

      cursor += batchSessionIds.length
      if (cursor < targetSessionIds.length) {
        snsUserPostCountsBatchTimerRef.current = window.setTimeout(applyBatch, SNS_USER_POST_COUNT_BATCH_INTERVAL_MS)
      } else {
        setSnsUserPostCountsStatus('ready')
        snsUserPostCountsBatchTimerRef.current = null
      }
    }

    applyBatch()
  }, [ensureExportCacheScope, patchSessionLoadTraceStage, snsUserPostCountsStatus])

  const loadSessionSnsTimelinePosts = useCallback(async (target: SessionSnsTimelineTarget, options?: { reset?: boolean }) => {
    const reset = Boolean(options?.reset)
    if (sessionSnsTimelineLoadingRef.current) return

    sessionSnsTimelineLoadingRef.current = true
    if (reset) {
      setSessionSnsTimelineLoading(true)
      setSessionSnsTimelineLoadingMore(false)
      setSessionSnsTimelineHasMore(false)
    } else {
      setSessionSnsTimelineLoadingMore(true)
    }

    const requestToken = ++sessionSnsTimelineRequestTokenRef.current

    try {
      const limit = 20
      let endTime: number | undefined
      if (!reset && sessionSnsTimelinePostsRef.current.length > 0) {
        endTime = sessionSnsTimelinePostsRef.current[sessionSnsTimelinePostsRef.current.length - 1].createTime - 1
      }

      const result = await window.electronAPI.sns.getTimeline(limit, 0, [target.username], '', undefined, endTime)
      if (requestToken !== sessionSnsTimelineRequestTokenRef.current) return

      if (!result.success || !Array.isArray(result.timeline)) {
        if (reset) {
          setSessionSnsTimelinePosts([])
          setSessionSnsTimelineHasMore(false)
        }
        return
      }

      const timeline = [...(result.timeline as SnsPost[])].sort((a, b) => b.createTime - a.createTime)
      if (reset) {
        setSessionSnsTimelinePosts(timeline)
        setSessionSnsTimelineHasMore(timeline.length >= limit)
        return
      }

      const existingIds = new Set(sessionSnsTimelinePostsRef.current.map((post) => post.id))
      const uniqueOlder = timeline.filter((post) => !existingIds.has(post.id))
      if (uniqueOlder.length > 0) {
        const merged = [...sessionSnsTimelinePostsRef.current, ...uniqueOlder].sort((a, b) => b.createTime - a.createTime)
        setSessionSnsTimelinePosts(merged)
      }
      if (timeline.length < limit) {
        setSessionSnsTimelineHasMore(false)
      }
    } catch (error) {
      console.error('加载联系人朋友圈失败:', error)
      if (requestToken === sessionSnsTimelineRequestTokenRef.current && reset) {
        setSessionSnsTimelinePosts([])
        setSessionSnsTimelineHasMore(false)
      }
    } finally {
      if (requestToken === sessionSnsTimelineRequestTokenRef.current) {
        sessionSnsTimelineLoadingRef.current = false
        setSessionSnsTimelineLoading(false)
        setSessionSnsTimelineLoadingMore(false)
      }
    }
  }, [])

  const closeSessionSnsTimeline = useCallback(() => {
    sessionSnsTimelineRequestTokenRef.current += 1
    sessionSnsTimelineLoadingRef.current = false
    sessionSnsRankRequestTokenRef.current += 1
    sessionSnsRankLoadingRef.current = false
    setSessionSnsRankMode(null)
    setSessionSnsLikeRankings([])
    setSessionSnsCommentRankings([])
    setSessionSnsRankLoading(false)
    setSessionSnsRankError(null)
    setSessionSnsRankLoadedPosts(0)
    setSessionSnsRankTotalPosts(null)
    setSessionSnsTimelineTarget(null)
    setSessionSnsTimelinePosts([])
    setSessionSnsTimelineLoading(false)
    setSessionSnsTimelineLoadingMore(false)
    setSessionSnsTimelineHasMore(false)
    setSessionSnsTimelineTotalPosts(null)
    setSessionSnsTimelineStatsLoading(false)
  }, [])

  const sessionSnsTimelineInitialTotalPosts = useMemo(() => {
    const username = String(sessionSnsTimelineTarget?.username || '').trim()
    if (!username) return null
    if (!Object.prototype.hasOwnProperty.call(snsUserPostCounts, username)) return null
    const count = Number(snsUserPostCounts[username] || 0)
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  }, [sessionSnsTimelineTarget, snsUserPostCounts])

  const sessionSnsTimelineInitialTotalPostsLoading = useMemo(() => {
    const username = String(sessionSnsTimelineTarget?.username || '').trim()
    if (!username) return false
    if (Object.prototype.hasOwnProperty.call(snsUserPostCounts, username)) return false
    return snsUserPostCountsStatus === 'loading' || snsUserPostCountsStatus === 'idle'
  }, [sessionSnsTimelineTarget, snsUserPostCounts, snsUserPostCountsStatus])

  const openSessionSnsTimelineByTarget = useCallback((target: SessionSnsTimelineTarget) => {
    sessionSnsRankRequestTokenRef.current += 1
    sessionSnsRankLoadingRef.current = false
    setSessionSnsRankMode(null)
    setSessionSnsLikeRankings([])
    setSessionSnsCommentRankings([])
    setSessionSnsRankLoading(false)
    setSessionSnsRankError(null)
    setSessionSnsRankLoadedPosts(0)
    setSessionSnsTimelineTarget(target)
    setSessionSnsTimelinePosts([])
    setSessionSnsTimelineHasMore(false)
    setSessionSnsTimelineLoadingMore(false)
    setSessionSnsTimelineLoading(false)
    const hasKnownCount = Object.prototype.hasOwnProperty.call(snsUserPostCounts, target.username)
    if (hasKnownCount) {
      const count = Number(snsUserPostCounts[target.username] || 0)
      const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
      setSessionSnsTimelineTotalPosts(normalizedCount)
      setSessionSnsTimelineStatsLoading(false)
      setSessionSnsRankTotalPosts(normalizedCount)
    } else {
      setSessionSnsTimelineTotalPosts(null)
      setSessionSnsTimelineStatsLoading(snsUserPostCountsStatus === 'loading' || snsUserPostCountsStatus === 'idle')
      setSessionSnsRankTotalPosts(null)
    }

    void loadSnsUserPostCounts()
  }, [
    loadSnsUserPostCounts,
    snsUserPostCounts,
    snsUserPostCountsStatus
  ])

  const openSessionSnsTimeline = useCallback(() => {
    const normalizedSessionId = String(sessionDetail?.wxid || '').trim()
    if (!isSingleContactSession(normalizedSessionId) || !sessionDetail) return

    const target: SessionSnsTimelineTarget = {
      username: normalizedSessionId,
      displayName: sessionDetail.displayName || sessionDetail.remark || sessionDetail.nickName || normalizedSessionId,
      avatarUrl: sessionDetail.avatarUrl
    }

    openSessionSnsTimelineByTarget(target)
  }, [openSessionSnsTimelineByTarget, sessionDetail])

  const openContactSnsTimeline = useCallback((contact: ContactInfo) => {
    const normalizedSessionId = String(contact?.username || '').trim()
    if (!isSingleContactSession(normalizedSessionId)) return
    openSessionSnsTimelineByTarget({
      username: normalizedSessionId,
      displayName: contact.displayName || contact.remark || contact.nickname || normalizedSessionId,
      avatarUrl: contact.avatarUrl
    })
  }, [openSessionSnsTimelineByTarget])

  const openSessionMutualFriendsDialog = useCallback((contact: ContactInfo) => {
    const normalizedSessionId = String(contact?.username || '').trim()
    if (!normalizedSessionId || !isSingleContactSession(normalizedSessionId)) return
    const metric = sessionMutualFriendsMetricsRef.current[normalizedSessionId]
    if (!metric) return
    setSessionMutualFriendsSearch('')
    setSessionMutualFriendsDialogTarget({
      username: normalizedSessionId,
      displayName: contact.displayName || contact.remark || contact.nickname || normalizedSessionId,
      avatarUrl: contact.avatarUrl
    })
  }, [])

  const closeSessionMutualFriendsDialog = useCallback(() => {
    setSessionMutualFriendsDialogTarget(null)
    setSessionMutualFriendsSearch('')
  }, [])

  const loadMoreSessionSnsTimeline = useCallback(() => {
    if (!sessionSnsTimelineTarget || sessionSnsTimelineLoading || sessionSnsTimelineLoadingMore || !sessionSnsTimelineHasMore) return
    void loadSessionSnsTimelinePosts(sessionSnsTimelineTarget, { reset: false })
  }, [
    loadSessionSnsTimelinePosts,
    sessionSnsTimelineHasMore,
    sessionSnsTimelineLoading,
    sessionSnsTimelineLoadingMore,
    sessionSnsTimelineTarget
  ])

  const loadSessionSnsRankings = useCallback(async (target: SessionSnsTimelineTarget) => {
    const normalizedUsername = String(target?.username || '').trim()
    if (!normalizedUsername || sessionSnsRankLoadingRef.current) return

    const knownTotal = snsUserPostCountsStatus === 'ready'
      ? Number(snsUserPostCounts[normalizedUsername] || 0)
      : null
    const normalizedKnownTotal = knownTotal !== null && Number.isFinite(knownTotal)
      ? Math.max(0, Math.floor(knownTotal))
      : null
    const cached = sessionSnsRankCacheRef.current[normalizedUsername]

    if (cached && (normalizedKnownTotal === null || cached.totalPosts === normalizedKnownTotal)) {
      setSessionSnsLikeRankings(cached.likes)
      setSessionSnsCommentRankings(cached.comments)
      setSessionSnsRankLoadedPosts(cached.totalPosts)
      setSessionSnsRankTotalPosts(cached.totalPosts)
      setSessionSnsRankError(null)
      setSessionSnsRankLoading(false)
      return
    }

    sessionSnsRankLoadingRef.current = true
    const requestToken = ++sessionSnsRankRequestTokenRef.current
    setSessionSnsRankLoading(true)
    setSessionSnsRankError(null)
    setSessionSnsRankLoadedPosts(0)
    setSessionSnsRankTotalPosts(normalizedKnownTotal)

    try {
      const allPosts: SnsPost[] = []
      let endTime: number | undefined
      let hasMore = true

      while (hasMore) {
        const result = await window.electronAPI.sns.getTimeline(
          SNS_RANK_PAGE_SIZE,
          0,
          [normalizedUsername],
          '',
          undefined,
          endTime
        )
        if (requestToken !== sessionSnsRankRequestTokenRef.current) return

        if (!result.success) {
          throw new Error(result.error || '加载朋友圈排行失败')
        }

        const pagePosts = Array.isArray(result.timeline)
          ? [...(result.timeline as SnsPost[])].sort((a, b) => b.createTime - a.createTime)
          : []
        if (pagePosts.length === 0) {
          hasMore = false
          break
        }

        allPosts.push(...pagePosts)
        setSessionSnsRankLoadedPosts(allPosts.length)
        if (normalizedKnownTotal === null) {
          setSessionSnsRankTotalPosts(allPosts.length)
        }

        endTime = pagePosts[pagePosts.length - 1].createTime - 1
        hasMore = pagePosts.length >= SNS_RANK_PAGE_SIZE
      }

      if (requestToken !== sessionSnsRankRequestTokenRef.current) return

      const rankings = buildSessionSnsRankings(allPosts)
      const totalPosts = allPosts.length
      sessionSnsRankCacheRef.current[normalizedUsername] = {
        likes: rankings.likes,
        comments: rankings.comments,
        totalPosts,
        computedAt: Date.now()
      }
      setSessionSnsLikeRankings(rankings.likes)
      setSessionSnsCommentRankings(rankings.comments)
      setSessionSnsRankLoadedPosts(totalPosts)
      setSessionSnsRankTotalPosts(totalPosts)
      setSessionSnsRankError(null)
    } catch (error) {
      if (requestToken !== sessionSnsRankRequestTokenRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setSessionSnsLikeRankings([])
      setSessionSnsCommentRankings([])
      setSessionSnsRankError(message || '加载朋友圈排行失败')
    } finally {
      if (requestToken === sessionSnsRankRequestTokenRef.current) {
        sessionSnsRankLoadingRef.current = false
        setSessionSnsRankLoading(false)
      }
    }
  }, [snsUserPostCounts, snsUserPostCountsStatus])

  const renderSessionSnsTimelineStats = useCallback((): string => {
    const loadedCount = sessionSnsTimelinePosts.length
    const loadPart = sessionSnsTimelineStatsLoading
      ? `已加载 ${loadedCount} / 总数统计中...`
      : sessionSnsTimelineTotalPosts === null
        ? `已加载 ${loadedCount} 条`
        : `已加载 ${loadedCount} / 共 ${sessionSnsTimelineTotalPosts} 条`

    if (sessionSnsTimelineLoading && loadedCount === 0) return `${loadPart} ｜ 加载中...`
    if (loadedCount === 0) return loadPart

    const latest = sessionSnsTimelinePosts[0]?.createTime
    const earliest = sessionSnsTimelinePosts[sessionSnsTimelinePosts.length - 1]?.createTime
    const rangeText = `${formatYmdDateFromSeconds(earliest)} ~ ${formatYmdDateFromSeconds(latest)}`
    return `${loadPart} ｜ ${rangeText}`
  }, [
    sessionSnsTimelineLoading,
    sessionSnsTimelinePosts,
    sessionSnsTimelineStatsLoading,
    sessionSnsTimelineTotalPosts
  ])

  const toggleSessionSnsRankMode = useCallback((mode: SnsRankMode) => {
    setSessionSnsRankMode((prev) => (prev === mode ? null : mode))
  }, [])

  const sessionSnsActiveRankings = useMemo(() => {
    if (sessionSnsRankMode === 'likes') return sessionSnsLikeRankings
    if (sessionSnsRankMode === 'comments') return sessionSnsCommentRankings
    return []
  }, [sessionSnsCommentRankings, sessionSnsLikeRankings, sessionSnsRankMode])

  const mergeSessionContentMetrics = useCallback((input: Record<string, SessionExportMetric | SessionContentMetric | undefined>) => {
    const entries = Object.entries(input)
    if (entries.length === 0) return

    const nextMessageCounts: Record<string, number> = {}
    const nextMetrics: Record<string, SessionContentMetric> = {}

    for (const [sessionIdRaw, metricRaw] of entries) {
      const sessionId = String(sessionIdRaw || '').trim()
      if (!sessionId || !metricRaw) continue
      const totalMessages = normalizeMessageCount(metricRaw.totalMessages)
      const voiceMessages = normalizeMessageCount(metricRaw.voiceMessages)
      const imageMessages = normalizeMessageCount(metricRaw.imageMessages)
      const videoMessages = normalizeMessageCount(metricRaw.videoMessages)
      const emojiMessages = normalizeMessageCount(metricRaw.emojiMessages)
      const transferMessages = normalizeMessageCount(metricRaw.transferMessages)
      const redPacketMessages = normalizeMessageCount(metricRaw.redPacketMessages)
      const callMessages = normalizeMessageCount(metricRaw.callMessages)

      if (
        typeof totalMessages !== 'number' &&
        typeof voiceMessages !== 'number' &&
        typeof imageMessages !== 'number' &&
        typeof videoMessages !== 'number' &&
        typeof emojiMessages !== 'number' &&
        typeof transferMessages !== 'number' &&
        typeof redPacketMessages !== 'number' &&
        typeof callMessages !== 'number' &&
        typeof normalizeTimestampSeconds(metricRaw.firstTimestamp) !== 'number' &&
        typeof normalizeTimestampSeconds(metricRaw.lastTimestamp) !== 'number'
      ) {
        continue
      }

      nextMetrics[sessionId] = {
        totalMessages,
        voiceMessages,
        imageMessages,
        videoMessages,
        emojiMessages,
        transferMessages,
        redPacketMessages,
        callMessages,
        firstTimestamp: normalizeTimestampSeconds(metricRaw.firstTimestamp),
        lastTimestamp: normalizeTimestampSeconds(metricRaw.lastTimestamp)
      }
      if (typeof totalMessages === 'number') {
        nextMessageCounts[sessionId] = totalMessages
      }
    }

    if (Object.keys(nextMessageCounts).length > 0) {
      setSessionMessageCounts(prev => {
        let changed = false
        const merged = { ...prev }
        for (const [sessionId, count] of Object.entries(nextMessageCounts)) {
          if (merged[sessionId] === count) continue
          merged[sessionId] = count
          changed = true
        }
        return changed ? merged : prev
      })
    }

    if (Object.keys(nextMetrics).length > 0) {
      setSessionContentMetrics(prev => {
        let changed = false
        const merged = { ...prev }
        for (const [sessionId, metric] of Object.entries(nextMetrics)) {
          const previous = merged[sessionId] || {}
          const nextMetric: SessionContentMetric = {
            totalMessages: typeof metric.totalMessages === 'number' ? metric.totalMessages : previous.totalMessages,
            voiceMessages: typeof metric.voiceMessages === 'number' ? metric.voiceMessages : previous.voiceMessages,
            imageMessages: typeof metric.imageMessages === 'number' ? metric.imageMessages : previous.imageMessages,
            videoMessages: typeof metric.videoMessages === 'number' ? metric.videoMessages : previous.videoMessages,
            emojiMessages: typeof metric.emojiMessages === 'number' ? metric.emojiMessages : previous.emojiMessages,
            transferMessages: typeof metric.transferMessages === 'number' ? metric.transferMessages : previous.transferMessages,
            redPacketMessages: typeof metric.redPacketMessages === 'number' ? metric.redPacketMessages : previous.redPacketMessages,
            callMessages: typeof metric.callMessages === 'number' ? metric.callMessages : previous.callMessages,
            firstTimestamp: typeof metric.firstTimestamp === 'number' ? metric.firstTimestamp : previous.firstTimestamp,
            lastTimestamp: typeof metric.lastTimestamp === 'number' ? metric.lastTimestamp : previous.lastTimestamp
          }
          if (
            previous.totalMessages === nextMetric.totalMessages &&
            previous.voiceMessages === nextMetric.voiceMessages &&
            previous.imageMessages === nextMetric.imageMessages &&
            previous.videoMessages === nextMetric.videoMessages &&
            previous.emojiMessages === nextMetric.emojiMessages &&
            previous.transferMessages === nextMetric.transferMessages &&
            previous.redPacketMessages === nextMetric.redPacketMessages &&
            previous.callMessages === nextMetric.callMessages &&
            previous.firstTimestamp === nextMetric.firstTimestamp &&
            previous.lastTimestamp === nextMetric.lastTimestamp
          ) {
            continue
          }
          merged[sessionId] = nextMetric
          changed = true
        }
        return changed ? merged : prev
      })
    }
  }, [])

  const resetSessionMediaMetricLoader = useCallback(() => {
    sessionMediaMetricRunIdRef.current += 1
    sessionMediaMetricQueueRef.current = []
    sessionMediaMetricQueuedSetRef.current.clear()
    sessionMediaMetricLoadingSetRef.current.clear()
    sessionMediaMetricReadySetRef.current.clear()
    sessionMediaMetricWorkerRunningRef.current = false
    sessionMediaMetricPendingPersistRef.current = {}
    sessionMediaMetricVisibleRangeRef.current = { startIndex: 0, endIndex: -1 }
    if (sessionMediaMetricBackgroundFeedTimerRef.current) {
      window.clearTimeout(sessionMediaMetricBackgroundFeedTimerRef.current)
      sessionMediaMetricBackgroundFeedTimerRef.current = null
    }
    if (sessionMediaMetricPersistTimerRef.current) {
      window.clearTimeout(sessionMediaMetricPersistTimerRef.current)
      sessionMediaMetricPersistTimerRef.current = null
    }
  }, [])

  const flushSessionMediaMetricCache = useCallback(async () => {
    const pendingMetrics = sessionMediaMetricPendingPersistRef.current
    sessionMediaMetricPendingPersistRef.current = {}
    if (Object.keys(pendingMetrics).length === 0) return

    try {
      const scopeKey = await ensureExportCacheScope()
      const existing = await configService.getExportSessionContentMetricCache(scopeKey)
      const nextMetrics = {
        ...(existing?.metrics || {}),
        ...pendingMetrics
      }
      await configService.setExportSessionContentMetricCache(scopeKey, nextMetrics)
    } catch (error) {
      console.error('写入导出页会话内容统计缓存失败:', error)
    }
  }, [ensureExportCacheScope])

  const scheduleFlushSessionMediaMetricCache = useCallback(() => {
    if (sessionMediaMetricPersistTimerRef.current) return
    sessionMediaMetricPersistTimerRef.current = window.setTimeout(() => {
      sessionMediaMetricPersistTimerRef.current = null
      void flushSessionMediaMetricCache()
    }, SESSION_MEDIA_METRIC_CACHE_FLUSH_DELAY_MS)
  }, [flushSessionMediaMetricCache])

  const resetSessionMutualFriendsLoader = useCallback(() => {
    sessionMutualFriendsRunIdRef.current += 1
    sessionMutualFriendsDirectMetricsRef.current = {}
    sessionMutualFriendsQueueRef.current = []
    sessionMutualFriendsQueuedSetRef.current.clear()
    sessionMutualFriendsLoadingSetRef.current.clear()
    sessionMutualFriendsReadySetRef.current.clear()
    sessionMutualFriendsWorkerRunningRef.current = false
    sessionMutualFriendsVisibleRangeRef.current = { startIndex: 0, endIndex: -1 }
    if (sessionMutualFriendsBackgroundFeedTimerRef.current) {
      window.clearTimeout(sessionMutualFriendsBackgroundFeedTimerRef.current)
      sessionMutualFriendsBackgroundFeedTimerRef.current = null
    }
    if (sessionMutualFriendsPersistTimerRef.current) {
      window.clearTimeout(sessionMutualFriendsPersistTimerRef.current)
      sessionMutualFriendsPersistTimerRef.current = null
    }
  }, [])

  const flushSessionMutualFriendsCache = useCallback(async () => {
    try {
      const scopeKey = await ensureExportCacheScope()
      await configService.setExportSessionMutualFriendsCache(
        scopeKey,
        sessionMutualFriendsDirectMetricsRef.current
      )
    } catch (error) {
      console.error('写入导出页共同好友缓存失败:', error)
    }
  }, [ensureExportCacheScope])

  const scheduleFlushSessionMutualFriendsCache = useCallback(() => {
    if (sessionMutualFriendsPersistTimerRef.current) return
    sessionMutualFriendsPersistTimerRef.current = window.setTimeout(() => {
      sessionMutualFriendsPersistTimerRef.current = null
      void flushSessionMutualFriendsCache()
    }, SESSION_MEDIA_METRIC_CACHE_FLUSH_DELAY_MS)
  }, [flushSessionMutualFriendsCache])

  const isSessionMutualFriendsReady = useCallback((sessionId: string): boolean => {
    if (!sessionId) return true
    if (sessionMutualFriendsReadySetRef.current.has(sessionId)) return true
    const existing = sessionMutualFriendsMetricsRef.current[sessionId]
    if (existing && typeof existing.count === 'number' && Array.isArray(existing.items)) {
      sessionMutualFriendsReadySetRef.current.add(sessionId)
      return true
    }
    return false
  }, [])

  const enqueueSessionMutualFriendsRequests = useCallback((sessionIds: string[], options?: { front?: boolean }) => {
    if (activeTaskCountRef.current > 0) return
    const front = options?.front === true
    const incoming: string[] = []
    for (const sessionIdRaw of sessionIds) {
      const sessionId = String(sessionIdRaw || '').trim()
      if (!sessionId) continue
      if (sessionMutualFriendsQueuedSetRef.current.has(sessionId)) continue
      if (sessionMutualFriendsLoadingSetRef.current.has(sessionId)) continue
      if (isSessionMutualFriendsReady(sessionId)) continue
      sessionMutualFriendsQueuedSetRef.current.add(sessionId)
      incoming.push(sessionId)
    }
    if (incoming.length === 0) return
    patchSessionLoadTraceStage(incoming, 'mutualFriends', 'pending')
    if (front) {
      sessionMutualFriendsQueueRef.current = [...incoming, ...sessionMutualFriendsQueueRef.current]
    } else {
      sessionMutualFriendsQueueRef.current.push(...incoming)
    }
  }, [isSessionMutualFriendsReady, patchSessionLoadTraceStage])

  const hasPendingMetricLoads = useCallback((): boolean => (
    isLoadingSessionCountsRef.current ||
    sessionMediaMetricQueuedSetRef.current.size > 0 ||
    sessionMediaMetricLoadingSetRef.current.size > 0 ||
    sessionMediaMetricWorkerRunningRef.current ||
    snsUserPostCountsStatus === 'loading' ||
    snsUserPostCountsStatus === 'idle'
  ), [snsUserPostCountsStatus])

  const getSessionMutualFriendProfile = useCallback((sessionId: string): {
    displayName: string
    candidateNames: Set<string>
  } => {
    const normalizedSessionId = String(sessionId || '').trim()
    const contact = contactsList.find(item => item.username === normalizedSessionId)
    const session = sessionsRef.current.find(item => item.username === normalizedSessionId)
    const displayName = contact?.displayName || contact?.remark || contact?.nickname || session?.displayName || normalizedSessionId
    return {
      displayName,
      candidateNames: toComparableNameSet([
        displayName,
        contact?.displayName,
        contact?.remark,
        contact?.nickname,
        contact?.alias
      ])
    }
  }, [contactsList])

  const rebuildSessionMutualFriendsMetric = useCallback((targetSessionId: string): SessionMutualFriendsMetric | null => {
    const normalizedTargetSessionId = String(targetSessionId || '').trim()
    if (!normalizedTargetSessionId) return null

    const directMetrics = sessionMutualFriendsDirectMetricsRef.current
    const directMetric = directMetrics[normalizedTargetSessionId]
    if (!directMetric) return null

    const { candidateNames } = getSessionMutualFriendProfile(normalizedTargetSessionId)
    const mergedMap = new Map<string, SessionMutualFriendItem>()
    for (const item of directMetric.items) {
      mergedMap.set(item.name, { ...item })
    }

    for (const [sourceSessionId, sourceMetric] of Object.entries(directMetrics)) {
      if (!sourceMetric || sourceSessionId === normalizedTargetSessionId) continue
      const sourceProfile = getSessionMutualFriendProfile(sourceSessionId)
      if (!sourceProfile.displayName) continue
      if (mergedMap.has(sourceProfile.displayName)) continue

      const reverseMatches = sourceMetric.items.filter(item => candidateNames.has(item.name))
      if (reverseMatches.length === 0) continue

      const reverseCount = reverseMatches.reduce((sum, item) => sum + item.totalCount, 0)
      const reverseLikeCount = reverseMatches.reduce((sum, item) => sum + item.incomingLikeCount, 0)
      const reverseCommentCount = reverseMatches.reduce((sum, item) => sum + item.incomingCommentCount, 0)
      const reverseLatestTime = reverseMatches.reduce((latest, item) => Math.max(latest, item.latestTime), 0)
      const existing = mergedMap.get(sourceProfile.displayName)
      if (existing) {
        existing.outgoingLikeCount += reverseLikeCount
        existing.outgoingCommentCount += reverseCommentCount
        existing.totalCount += reverseCount
        existing.latestTime = Math.max(existing.latestTime, reverseLatestTime)
        existing.direction = (existing.incomingLikeCount + existing.incomingCommentCount) > 0
          ? 'bidirectional'
          : 'outgoing'
        existing.behavior = summarizeMutualFriendBehavior(
          existing.incomingLikeCount + existing.outgoingLikeCount,
          existing.incomingCommentCount + existing.outgoingCommentCount
        )
      } else {
        mergedMap.set(sourceProfile.displayName, {
          name: sourceProfile.displayName,
          incomingLikeCount: 0,
          incomingCommentCount: 0,
          outgoingLikeCount: reverseLikeCount,
          outgoingCommentCount: reverseCommentCount,
          totalCount: reverseCount,
          latestTime: reverseLatestTime,
          direction: 'outgoing',
          behavior: summarizeMutualFriendBehavior(reverseLikeCount, reverseCommentCount)
        })
      }
    }

    const items = [...mergedMap.values()].sort((a, b) => {
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount
      if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime
      return a.name.localeCompare(b.name, 'zh-CN')
    })

    return {
      ...directMetric,
      count: items.length,
      items
    }
  }, [getSessionMutualFriendProfile])

  const rebuildSessionMutualFriendsStateFromDirectMetrics = useCallback((sessionIds?: string[]) => {
    const targets = Array.isArray(sessionIds) && sessionIds.length > 0
      ? sessionIds
      : Object.keys(sessionMutualFriendsDirectMetricsRef.current)
    const nextMetrics: Record<string, SessionMutualFriendsMetric> = {}
    const readyIds: string[] = []
    for (const sessionIdRaw of targets) {
      const sessionId = String(sessionIdRaw || '').trim()
      if (!sessionId) continue
      const rebuilt = rebuildSessionMutualFriendsMetric(sessionId)
      if (!rebuilt) continue
      nextMetrics[sessionId] = rebuilt
      readyIds.push(sessionId)
    }
    sessionMutualFriendsMetricsRef.current = nextMetrics
    setSessionMutualFriendsMetrics(nextMetrics)
    if (readyIds.length > 0) {
      for (const sessionId of readyIds) {
        sessionMutualFriendsReadySetRef.current.add(sessionId)
      }
      patchSessionLoadTraceStage(readyIds, 'mutualFriends', 'done')
    }
  }, [patchSessionLoadTraceStage, rebuildSessionMutualFriendsMetric])

  const applySessionMutualFriendsMetric = useCallback((sessionId: string, directMetric: SessionMutualFriendsMetric) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return
    sessionMutualFriendsDirectMetricsRef.current[normalizedSessionId] = directMetric
    scheduleFlushSessionMutualFriendsCache()

    const impactedSessionIds = new Set<string>([normalizedSessionId])
    const allSessionIds = sessionsRef.current
      .filter(session => session.hasSession && isSingleContactSession(session.username))
      .map(session => session.username)

    for (const targetSessionId of allSessionIds) {
      if (targetSessionId === normalizedSessionId) continue
      const targetProfile = getSessionMutualFriendProfile(targetSessionId)
      if (directMetric.items.some(item => targetProfile.candidateNames.has(item.name))) {
        impactedSessionIds.add(targetSessionId)
      }
    }

    setSessionMutualFriendsMetrics(prev => {
      const next = { ...prev }
      let changed = false
      for (const targetSessionId of impactedSessionIds) {
        const rebuiltMetric = rebuildSessionMutualFriendsMetric(targetSessionId)
        if (!rebuiltMetric) continue
        const previousMetric = prev[targetSessionId]
        const previousSerialized = previousMetric ? JSON.stringify(previousMetric) : ''
        const nextSerialized = JSON.stringify(rebuiltMetric)
        if (previousSerialized === nextSerialized) continue
        next[targetSessionId] = rebuiltMetric
        changed = true
      }
      return changed ? next : prev
    })
  }, [getSessionMutualFriendProfile, rebuildSessionMutualFriendsMetric, scheduleFlushSessionMutualFriendsCache])

  const isSessionMediaMetricReady = useCallback((sessionId: string): boolean => {
    if (!sessionId) return true
    if (sessionMediaMetricReadySetRef.current.has(sessionId)) return true
    const existing = sessionContentMetricsRef.current[sessionId]
    if (hasCompleteSessionMediaMetric(existing)) {
      sessionMediaMetricReadySetRef.current.add(sessionId)
      return true
    }
    return false
  }, [])

  const enqueueSessionMediaMetricRequests = useCallback((sessionIds: string[], options?: { front?: boolean }) => {
    if (activeTaskCountRef.current > 0) return
    const front = options?.front === true
    const incoming: string[] = []
    for (const sessionIdRaw of sessionIds) {
      const sessionId = String(sessionIdRaw || '').trim()
      if (!sessionId) continue
      if (sessionMediaMetricQueuedSetRef.current.has(sessionId)) continue
      if (sessionMediaMetricLoadingSetRef.current.has(sessionId)) continue
      if (isSessionMediaMetricReady(sessionId)) continue
      sessionMediaMetricQueuedSetRef.current.add(sessionId)
      incoming.push(sessionId)
    }
    if (incoming.length === 0) return
    patchSessionLoadTraceStage(incoming, 'mediaMetrics', 'pending')
    if (front) {
      sessionMediaMetricQueueRef.current = [...incoming, ...sessionMediaMetricQueueRef.current]
    } else {
      sessionMediaMetricQueueRef.current.push(...incoming)
    }
  }, [isSessionMediaMetricReady, patchSessionLoadTraceStage])

  const applySessionMediaMetricsFromStats = useCallback((data?: Record<string, SessionExportMetric>) => {
    if (!data) return
    const nextMetrics: Record<string, SessionContentMetric> = {}
    let hasPatch = false
    for (const [sessionIdRaw, metricRaw] of Object.entries(data)) {
      const sessionId = String(sessionIdRaw || '').trim()
      if (!sessionId) continue
      const metric = pickSessionMediaMetric(metricRaw)
      if (!metric) continue
      nextMetrics[sessionId] = metric
      hasPatch = true
      sessionMediaMetricPendingPersistRef.current[sessionId] = {
        ...sessionMediaMetricPendingPersistRef.current[sessionId],
        ...metric
      }
      if (hasCompleteSessionMediaMetric(metric)) {
        sessionMediaMetricReadySetRef.current.add(sessionId)
      }
    }

    if (hasPatch) {
      mergeSessionContentMetrics(nextMetrics)
      scheduleFlushSessionMediaMetricCache()
    }
  }, [mergeSessionContentMetrics, scheduleFlushSessionMediaMetricCache])

  const runSessionMediaMetricWorker = useCallback(async (runId: number) => {
    if (sessionMediaMetricWorkerRunningRef.current) return
    sessionMediaMetricWorkerRunningRef.current = true
    const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> => {
      let timer: number | null = null
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            reject(new Error(`会话多媒体统计超时(${stage}, ${timeoutMs}ms)`))
          }, timeoutMs)
        })
        return await Promise.race([promise, timeoutPromise])
      } finally {
        if (timer !== null) {
          window.clearTimeout(timer)
        }
      }
    }
    try {
      while (runId === sessionMediaMetricRunIdRef.current) {
        if (activeTaskCountRef.current > 0) {
          await new Promise(resolve => window.setTimeout(resolve, 150))
          continue
        }
        if (sessionMediaMetricQueueRef.current.length === 0) break

        const batchSessionIds: string[] = []
        while (batchSessionIds.length < SESSION_MEDIA_METRIC_BATCH_SIZE && sessionMediaMetricQueueRef.current.length > 0) {
          const nextId = sessionMediaMetricQueueRef.current.shift()
          if (!nextId) continue
          sessionMediaMetricQueuedSetRef.current.delete(nextId)
          if (sessionMediaMetricLoadingSetRef.current.has(nextId)) continue
          if (isSessionMediaMetricReady(nextId)) continue
          sessionMediaMetricLoadingSetRef.current.add(nextId)
          batchSessionIds.push(nextId)
        }
        if (batchSessionIds.length === 0) {
          continue
        }
        patchSessionLoadTraceStage(batchSessionIds, 'mediaMetrics', 'loading')

        try {
          const cacheResult = await withTimeout(
            window.electronAPI.chat.getExportSessionStats(
              batchSessionIds,
              { includeRelations: false, allowStaleCache: true, cacheOnly: true }
            ),
            12000,
            'cacheOnly'
          )
          if (runId !== sessionMediaMetricRunIdRef.current) return
          if (cacheResult.success && cacheResult.data) {
            applySessionMediaMetricsFromStats(cacheResult.data as Record<string, SessionExportMetric>)
          }

          const missingSessionIds = batchSessionIds.filter(sessionId => !isSessionMediaMetricReady(sessionId))
          if (missingSessionIds.length > 0) {
            const freshResult = await withTimeout(
              window.electronAPI.chat.getExportSessionStats(
                missingSessionIds,
                { includeRelations: false, allowStaleCache: true }
              ),
              45000,
              'fresh'
            )
            if (runId !== sessionMediaMetricRunIdRef.current) return
            if (freshResult.success && freshResult.data) {
              applySessionMediaMetricsFromStats(freshResult.data as Record<string, SessionExportMetric>)
            }
          }

          const unresolvedSessionIds = batchSessionIds.filter(sessionId => !isSessionMediaMetricReady(sessionId))
          if (unresolvedSessionIds.length > 0) {
            patchSessionLoadTraceStage(unresolvedSessionIds, 'mediaMetrics', 'failed', {
              error: '统计结果缺失，已跳过当前批次'
            })
          }
        } catch (error) {
          console.error('导出页加载会话媒体统计失败:', error)
          patchSessionLoadTraceStage(batchSessionIds, 'mediaMetrics', 'failed', {
            error: String(error)
          })
        } finally {
          const completedSessionIds: string[] = []
          for (const sessionId of batchSessionIds) {
            sessionMediaMetricLoadingSetRef.current.delete(sessionId)
            if (isSessionMediaMetricReady(sessionId)) {
              sessionMediaMetricReadySetRef.current.add(sessionId)
              completedSessionIds.push(sessionId)
            }
          }
          if (completedSessionIds.length > 0) {
            patchSessionLoadTraceStage(completedSessionIds, 'mediaMetrics', 'done')
          }
        }

        await new Promise(resolve => window.setTimeout(resolve, 0))
      }
    } finally {
      sessionMediaMetricWorkerRunningRef.current = false
      if (runId === sessionMediaMetricRunIdRef.current && sessionMediaMetricQueueRef.current.length > 0) {
        void runSessionMediaMetricWorker(runId)
      }
    }
  }, [applySessionMediaMetricsFromStats, isSessionMediaMetricReady, patchSessionLoadTraceStage])

  const scheduleSessionMediaMetricWorker = useCallback(() => {
    if (activeTaskCountRef.current > 0) return
    if (sessionMediaMetricWorkerRunningRef.current) return
    const runId = sessionMediaMetricRunIdRef.current
    void runSessionMediaMetricWorker(runId)
  }, [runSessionMediaMetricWorker])

  const loadSessionMutualFriendsMetric = useCallback(async (sessionId: string): Promise<SessionMutualFriendsMetric> => {
    const normalizedSessionId = String(sessionId || '').trim()
    const hasKnownTotal = Object.prototype.hasOwnProperty.call(snsUserPostCounts, normalizedSessionId)
    const knownTotalRaw = hasKnownTotal ? Number(snsUserPostCounts[normalizedSessionId] || 0) : NaN
    const knownTotal = Number.isFinite(knownTotalRaw) ? Math.max(0, Math.floor(knownTotalRaw)) : null
    const allPosts: SnsPost[] = []
    let endTime: number | undefined
    let hasMore = true

    while (hasMore) {
      const result = await window.electronAPI.sns.getTimeline(
        SNS_RANK_PAGE_SIZE,
        0,
        [normalizedSessionId],
        '',
        undefined,
        endTime
      )
      if (!result.success) {
        throw new Error(result.error || '共同好友统计失败')
      }

      const pagePosts = Array.isArray(result.timeline)
        ? [...(result.timeline as SnsPost[])].sort((a, b) => b.createTime - a.createTime)
        : []
      if (pagePosts.length === 0) {
        hasMore = false
        break
      }

      allPosts.push(...pagePosts)
      endTime = pagePosts[pagePosts.length - 1].createTime - 1
      hasMore = pagePosts.length >= SNS_RANK_PAGE_SIZE
    }

    return buildSessionMutualFriendsMetric(allPosts, knownTotal)
  }, [snsUserPostCounts])

  const runSessionMutualFriendsWorker = useCallback(async (runId: number) => {
    if (sessionMutualFriendsWorkerRunningRef.current) return
    sessionMutualFriendsWorkerRunningRef.current = true
    try {
      while (runId === sessionMutualFriendsRunIdRef.current) {
        if (activeTaskCountRef.current > 0) {
          await new Promise(resolve => window.setTimeout(resolve, 150))
          continue
        }
        if (hasPendingMetricLoads()) {
          await new Promise(resolve => window.setTimeout(resolve, 120))
          continue
        }

        const sessionId = sessionMutualFriendsQueueRef.current.shift()
        if (!sessionId) break
        sessionMutualFriendsQueuedSetRef.current.delete(sessionId)
        if (sessionMutualFriendsLoadingSetRef.current.has(sessionId)) continue
        if (isSessionMutualFriendsReady(sessionId)) continue

        sessionMutualFriendsLoadingSetRef.current.add(sessionId)
        patchSessionLoadTraceStage([sessionId], 'mutualFriends', 'loading')

        try {
          const metric = await loadSessionMutualFriendsMetric(sessionId)
          if (runId !== sessionMutualFriendsRunIdRef.current) return
          applySessionMutualFriendsMetric(sessionId, metric)
          sessionMutualFriendsReadySetRef.current.add(sessionId)
          patchSessionLoadTraceStage([sessionId], 'mutualFriends', 'done')
        } catch (error) {
          console.error('导出页加载共同好友统计失败:', error)
          patchSessionLoadTraceStage([sessionId], 'mutualFriends', 'failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          sessionMutualFriendsLoadingSetRef.current.delete(sessionId)
        }

        await new Promise(resolve => window.setTimeout(resolve, 0))
      }
    } finally {
      sessionMutualFriendsWorkerRunningRef.current = false
      if (runId === sessionMutualFriendsRunIdRef.current && sessionMutualFriendsQueueRef.current.length > 0) {
        void runSessionMutualFriendsWorker(runId)
      }
    }
  }, [
    applySessionMutualFriendsMetric,
    hasPendingMetricLoads,
    isSessionMutualFriendsReady,
    loadSessionMutualFriendsMetric,
    patchSessionLoadTraceStage
  ])

  const scheduleSessionMutualFriendsWorker = useCallback(() => {
    if (activeTaskCountRef.current > 0) return
    if (!isSessionCountStageReady) return
    if (hasPendingMetricLoads()) return
    if (sessionMutualFriendsWorkerRunningRef.current) return
    const runId = sessionMutualFriendsRunIdRef.current
    void runSessionMutualFriendsWorker(runId)
  }, [hasPendingMetricLoads, isSessionCountStageReady, runSessionMutualFriendsWorker])

  const loadSessionMessageCounts = useCallback(async (
    sourceSessions: SessionRow[],
    priorityTab: ConversationTab,
    options?: {
      scopeKey?: string
      seededCounts?: Record<string, number>
    }
  ): Promise<Record<string, number>> => {
    const requestId = sessionCountRequestIdRef.current + 1
    sessionCountRequestIdRef.current = requestId
    const isStale = () => sessionCountRequestIdRef.current !== requestId
    setIsSessionCountStageReady(false)

    const exportableSessions = sourceSessions.filter(session => session.hasSession)
    const exportableSessionIds = exportableSessions.map(session => session.username)
    const exportableSessionIdSet = new Set(exportableSessionIds)
    patchSessionLoadTraceStage(exportableSessionIds, 'messageCount', 'pending', { force: true })
    const seededHintCounts = exportableSessions.reduce<Record<string, number>>((acc, session) => {
      const nextCount = normalizeMessageCount(session.messageCountHint)
      if (typeof nextCount === 'number') {
        acc[session.username] = nextCount
      }
      return acc
    }, {})
    const seededPersistentCounts = Object.entries(options?.seededCounts || {}).reduce<Record<string, number>>((acc, [sessionId, countRaw]) => {
      if (!exportableSessionIdSet.has(sessionId)) return acc
      const nextCount = normalizeMessageCount(countRaw)
      if (typeof nextCount === 'number') {
        acc[sessionId] = nextCount
      }
      return acc
    }, {})
    const seededPersistentSessionIds = Object.keys(seededPersistentCounts)
    if (seededPersistentSessionIds.length > 0) {
      patchSessionLoadTraceStage(seededPersistentSessionIds, 'messageCount', 'done')
    }
    const seededCounts = { ...seededHintCounts, ...seededPersistentCounts }
    const accumulatedCounts: Record<string, number> = { ...seededCounts }
    setSessionMessageCounts(seededCounts)
    if (Object.keys(seededCounts).length > 0) {
      mergeSessionContentMetrics(
        Object.entries(seededCounts).reduce<Record<string, SessionContentMetric>>((acc, [sessionId, count]) => {
          acc[sessionId] = { totalMessages: count }
          return acc
        }, {})
      )
    }

    if (exportableSessions.length === 0) {
      setIsLoadingSessionCounts(false)
      if (!isStale()) {
        setIsSessionCountStageReady(true)
      }
      return { ...accumulatedCounts }
    }

    const prioritizedSessionIds = exportableSessions
      .filter(session => session.kind === priorityTab)
      .map(session => session.username)
    const prioritizedSet = new Set(prioritizedSessionIds)
    const remainingSessionIds = exportableSessions
      .filter(session => !prioritizedSet.has(session.username))
      .map(session => session.username)

    const applyCounts = (input: Record<string, number> | undefined) => {
      if (!input || isStale()) return
      const normalized = Object.entries(input).reduce<Record<string, number>>((acc, [sessionId, count]) => {
        const nextCount = normalizeMessageCount(count)
        if (typeof nextCount === 'number') {
          acc[sessionId] = nextCount
        }
        return acc
      }, {})
      if (Object.keys(normalized).length === 0) return
      for (const [sessionId, count] of Object.entries(normalized)) {
        accumulatedCounts[sessionId] = count
      }
      setSessionMessageCounts(prev => ({ ...prev, ...normalized }))
      mergeSessionContentMetrics(
        Object.entries(normalized).reduce<Record<string, SessionContentMetric>>((acc, [sessionId, count]) => {
          acc[sessionId] = { totalMessages: count }
          return acc
        }, {})
      )
    }

    setIsLoadingSessionCounts(true)
    try {
      if (prioritizedSessionIds.length > 0) {
        patchSessionLoadTraceStage(prioritizedSessionIds, 'messageCount', 'loading')
        const priorityResult = await window.electronAPI.chat.getSessionMessageCounts(prioritizedSessionIds)
        if (isStale()) return { ...accumulatedCounts }
        if (priorityResult.success) {
          applyCounts(priorityResult.counts)
          patchSessionLoadTraceStage(prioritizedSessionIds, 'messageCount', 'done')
        } else {
          patchSessionLoadTraceStage(
            prioritizedSessionIds,
            'messageCount',
            'failed',
            { error: priorityResult.error || '总消息数加载失败' }
          )
        }
      }

      if (remainingSessionIds.length > 0) {
        patchSessionLoadTraceStage(remainingSessionIds, 'messageCount', 'loading')
        const remainingResult = await window.electronAPI.chat.getSessionMessageCounts(remainingSessionIds)
        if (isStale()) return { ...accumulatedCounts }
        if (remainingResult.success) {
          applyCounts(remainingResult.counts)
          patchSessionLoadTraceStage(remainingSessionIds, 'messageCount', 'done')
        } else {
          patchSessionLoadTraceStage(
            remainingSessionIds,
            'messageCount',
            'failed',
            { error: remainingResult.error || '总消息数加载失败' }
          )
        }
      }
    } catch (error) {
      console.error('导出页加载会话消息总数失败:', error)
      patchSessionLoadTraceStage(exportableSessionIds, 'messageCount', 'failed', {
        error: String(error)
      })
    } finally {
      if (!isStale()) {
        setIsLoadingSessionCounts(false)
        setIsSessionCountStageReady(true)
        if (options?.scopeKey && Object.keys(accumulatedCounts).length > 0) {
          try {
            await configService.setExportSessionMessageCountCache(options.scopeKey, accumulatedCounts)
          } catch (cacheError) {
            console.error('写入导出页会话总消息缓存失败:', cacheError)
          }
        }
      }
    }
    return { ...accumulatedCounts }
  }, [mergeSessionContentMetrics, patchSessionLoadTraceStage])

  const loadSessions = useCallback(async () => {
    const loadToken = Date.now()
    sessionLoadTokenRef.current = loadToken
    sessionsHydratedAtRef.current = 0
    sessionPreciseRefreshAtRef.current = {}
    resetSessionMediaMetricLoader()
    resetSessionMutualFriendsLoader()
    setIsLoading(true)
    setIsSessionEnriching(false)
    sessionCountRequestIdRef.current += 1
    setSessionMessageCounts({})
    setSessionContentMetrics({})
    setSessionMutualFriendsMetrics({})
    sessionMutualFriendsMetricsRef.current = {}
    setSessionMutualFriendsDialogTarget(null)
    setSessionMutualFriendsSearch('')
    setSessionLoadTraceMap({})
    setSessionLoadProgressPulseMap({})
    sessionLoadProgressSnapshotRef.current = {}
    snsUserPostCountsHydrationTokenRef.current += 1
    if (snsUserPostCountsBatchTimerRef.current) {
      window.clearTimeout(snsUserPostCountsBatchTimerRef.current)
      snsUserPostCountsBatchTimerRef.current = null
    }
    setSnsUserPostCounts({})
    setSnsUserPostCountsStatus('idle')
    setIsLoadingSessionCounts(false)
    setIsSessionCountStageReady(false)

    const isStale = () => sessionLoadTokenRef.current !== loadToken

    try {
      const scopeKey = await ensureExportCacheScope()
      if (isStale()) return

      const [
        cachedContactsPayload,
        cachedMessageCountsPayload,
        cachedContentMetricsPayload,
        cachedMutualFriendsPayload
      ] = await Promise.all([
        loadContactsCaches(scopeKey),
        configService.getExportSessionMessageCountCache(scopeKey),
        configService.getExportSessionContentMetricCache(scopeKey),
        configService.getExportSessionMutualFriendsCache(scopeKey)
      ])
      if (isStale()) return

      const {
        contactsItem: cachedContactsItem,
        avatarItem: cachedAvatarItem
      } = cachedContactsPayload

      const cachedContacts = cachedContactsItem?.contacts || []
      const cachedAvatarEntries = cachedAvatarItem?.avatars || {}
      const cachedContactMap = toContactMapFromCaches(cachedContacts, cachedAvatarEntries)
      if (cachedContacts.length > 0) {
        syncContactTypeCounts(Object.values(cachedContactMap))
        setSessions(toSessionRowsWithContacts([], cachedContactMap).filter(isExportConversationSession))
        setSessionDataSource('cache')
        setIsLoading(false)
      }
      setSessionContactsUpdatedAt(cachedContactsItem?.updatedAt || null)
      setSessionAvatarUpdatedAt(cachedAvatarItem?.updatedAt || null)

      const connectResult = await window.electronAPI.chat.connect()
      if (!connectResult.success) {
        console.error('连接失败:', connectResult.error)
        if (!isStale()) setIsLoading(false)
        return
      }

      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (isStale()) return

      if (sessionsResult.success && sessionsResult.sessions) {
        const rawSessions = sessionsResult.sessions
        const baseSessions = toSessionRowsWithContacts(rawSessions, cachedContactMap).filter(isExportConversationSession)
        const exportableSessionIds = baseSessions
          .filter((session) => session.hasSession)
          .map((session) => session.username)
        const exportableSessionIdSet = new Set(exportableSessionIds)

        const cachedMessageCounts = Object.entries(cachedMessageCountsPayload?.counts || {}).reduce<Record<string, number>>((acc, [sessionId, countRaw]) => {
          if (!exportableSessionIdSet.has(sessionId)) return acc
          const nextCount = normalizeMessageCount(countRaw)
          if (typeof nextCount === 'number') {
            acc[sessionId] = nextCount
          }
          return acc
        }, {})

        const cachedCountAsMetrics = Object.entries(cachedMessageCounts).reduce<Record<string, SessionContentMetric>>((acc, [sessionId, count]) => {
          acc[sessionId] = { totalMessages: count }
          return acc
        }, {})
        const cachedContentMetrics = Object.entries(cachedContentMetricsPayload?.metrics || {}).reduce<Record<string, SessionContentMetric>>((acc, [sessionId, rawMetric]) => {
          if (!exportableSessionIdSet.has(sessionId)) return acc
          const metric = pickSessionMediaMetric(rawMetric)
          if (!metric) return acc
          acc[sessionId] = metric
          if (hasCompleteSessionMediaMetric(metric)) {
            sessionMediaMetricReadySetRef.current.add(sessionId)
          }
          return acc
        }, {})
        const cachedContentMetricReadySessionIds = Object.entries(cachedContentMetrics)
          .filter(([, metric]) => hasCompleteSessionMediaMetric(metric))
          .map(([sessionId]) => sessionId)
        if (cachedContentMetricReadySessionIds.length > 0) {
          patchSessionLoadTraceStage(cachedContentMetricReadySessionIds, 'mediaMetrics', 'done')
        }
        const cachedMutualFriendDirectMetrics = Object.entries(cachedMutualFriendsPayload?.metrics || {}).reduce<Record<string, SessionMutualFriendsMetric>>((acc, [sessionIdRaw, metricRaw]) => {
          const sessionId = String(sessionIdRaw || '').trim()
          if (!exportableSessionIdSet.has(sessionId) || !isSingleContactSession(sessionId)) return acc
          const metric = metricRaw as SessionMutualFriendsMetric | undefined
          if (!metric || !Array.isArray(metric.items) || !Number.isFinite(metric.count)) return acc
          acc[sessionId] = metric
          return acc
        }, {})
        const cachedMutualFriendSessionIds = Object.keys(cachedMutualFriendDirectMetrics)

        if (isStale()) return
        if (Object.keys(cachedMessageCounts).length > 0) {
          setSessionMessageCounts(cachedMessageCounts)
        }
        if (Object.keys(cachedCountAsMetrics).length > 0) {
          mergeSessionContentMetrics(cachedCountAsMetrics)
        }
        if (Object.keys(cachedContentMetrics).length > 0) {
          mergeSessionContentMetrics(cachedContentMetrics)
        }
        if (cachedMutualFriendSessionIds.length > 0) {
          sessionMutualFriendsDirectMetricsRef.current = cachedMutualFriendDirectMetrics
          rebuildSessionMutualFriendsStateFromDirectMetrics(cachedMutualFriendSessionIds)
        } else {
          sessionMutualFriendsMetricsRef.current = {}
          setSessionMutualFriendsMetrics({})
        }
        setSessions(baseSessions)
        sessionsHydratedAtRef.current = Date.now()
        void (async () => {
          await loadSessionMessageCounts(baseSessions, activeTabRef.current, {
            scopeKey,
            seededCounts: cachedMessageCounts
          })
          if (isStale()) return
        })()
        setSessionDataSource(cachedContacts.length > 0 ? 'cache' : 'network')
        if (cachedContacts.length === 0) {
          setSessionContactsUpdatedAt(Date.now())
        }
        setIsLoading(false)

        // 后台补齐联系人字段（昵称、头像、类型），不阻塞首屏会话列表渲染。
        setIsSessionEnriching(true)
        void (async () => {
          try {
            if (detailStatsPriorityRef.current) return
            let contactMap = { ...cachedContactMap }
            let avatarEntries = { ...cachedAvatarEntries }
            let hasFreshNetworkData = false
            let hasNetworkContactsSnapshot = false

            if (isStale()) return
            if (detailStatsPriorityRef.current) return
            const contactsResult = await withTimeout(window.electronAPI.chat.getContacts({ lite: true }), CONTACT_ENRICH_TIMEOUT_MS)
            if (isStale()) return

            const contactsFromNetwork: ContactInfo[] = contactsResult?.success && contactsResult.contacts ? contactsResult.contacts : []
            if (contactsFromNetwork.length > 0) {
              hasFreshNetworkData = true
              hasNetworkContactsSnapshot = true
              const contactsWithCachedAvatar = mergeAvatarCacheIntoContacts(contactsFromNetwork, avatarEntries)
              const nextContactMap = contactsWithCachedAvatar.reduce<Record<string, ContactInfo>>((map, contact) => {
                map[contact.username] = contact
                return map
              }, {})
              for (const [username, cachedContact] of Object.entries(cachedContactMap)) {
                if (!nextContactMap[username]) {
                  nextContactMap[username] = cachedContact
                }
              }
              contactMap = nextContactMap
              syncContactTypeCounts(Object.values(contactMap))
              const refreshAt = Date.now()
              setSessionContactsUpdatedAt(refreshAt)

              const upsertResult = upsertAvatarCacheFromContacts(avatarEntries, Object.values(contactMap), {
                prune: true,
                now: refreshAt
              })
              avatarEntries = upsertResult.avatarEntries
              if (upsertResult.updatedAt) {
                setSessionAvatarUpdatedAt(upsertResult.updatedAt)
              }
            }

            const sourceContacts = Object.values(contactMap)
            const sourceByUsername = new Map<string, ContactInfo>()
            for (const contact of sourceContacts) {
              if (!contact?.username) continue
              sourceByUsername.set(contact.username, contact)
            }
            const rawSessionMap = rawSessions.reduce<Record<string, AppChatSession>>((map, session) => {
              map[session.username] = session
              return map
            }, {})
            const candidateUsernames = sourceContacts.length > 0
              ? sourceContacts.map(contact => contact.username)
              : baseSessions.map(session => session.username)
            const needsEnrichment = candidateUsernames
              .filter(Boolean)
              .filter((username) => {
                const currentContact = sourceByUsername.get(username)
                const session = rawSessionMap[username]
                const currentAvatarUrl = currentContact?.avatarUrl || session?.avatarUrl
                return !currentAvatarUrl
              })

            let extraContactMap: Record<string, { displayName?: string; avatarUrl?: string }> = {}
            if (needsEnrichment.length > 0) {
              for (let i = 0; i < needsEnrichment.length; i += EXPORT_AVATAR_ENRICH_BATCH_SIZE) {
                if (isStale()) return
                if (detailStatsPriorityRef.current) return
                const batch = needsEnrichment.slice(i, i + EXPORT_AVATAR_ENRICH_BATCH_SIZE)
                if (batch.length === 0) continue
                try {
                  const enrichResult = await withTimeout(
                    window.electronAPI.chat.enrichSessionsContactInfo(batch, {
                      skipDisplayName: true,
                      onlyMissingAvatar: true
                    }),
                    CONTACT_ENRICH_TIMEOUT_MS
                  )
                  if (isStale()) return
                  if (enrichResult?.success && enrichResult.contacts) {
                    extraContactMap = {
                      ...extraContactMap,
                      ...enrichResult.contacts
                    }
                    hasFreshNetworkData = true
                    for (const [username, enriched] of Object.entries(enrichResult.contacts)) {
                      const current = sourceByUsername.get(username)
                      if (!current) continue
                      sourceByUsername.set(username, {
                        ...current,
                        displayName: enriched.displayName || current.displayName,
                        avatarUrl: enriched.avatarUrl || current.avatarUrl
                      })
                    }
                  }
                } catch (batchError) {
                  console.error('导出页分批补充会话联系人信息失败:', batchError)
                }

                const batchContacts = batch
                  .map(username => sourceByUsername.get(username))
                  .filter((contact): contact is ContactInfo => Boolean(contact))
                const upsertResult = upsertAvatarCacheFromContacts(avatarEntries, batchContacts, {
                  markCheckedUsernames: batch
                })
                avatarEntries = upsertResult.avatarEntries
                if (upsertResult.updatedAt) {
                  setSessionAvatarUpdatedAt(upsertResult.updatedAt)
                }
                await new Promise(resolve => setTimeout(resolve, 0))
              }
            }

            const contactsForPersist = Array.from(sourceByUsername.values())
            if (hasNetworkContactsSnapshot && contactsForPersist.length > 0) {
              const upsertResult = upsertAvatarCacheFromContacts(avatarEntries, contactsForPersist, {
                prune: true
              })
              avatarEntries = upsertResult.avatarEntries
              if (upsertResult.updatedAt) {
                setSessionAvatarUpdatedAt(upsertResult.updatedAt)
              }
            }
            contactMap = contactsForPersist.reduce<Record<string, ContactInfo>>((map, contact) => {
              map[contact.username] = contact
              return map
            }, contactMap)

            if (isStale()) return
            const nextSessions = toSessionRowsWithContacts(rawSessions, contactMap).filter(isExportConversationSession)
              .map((session) => {
                const extra = extraContactMap[session.username]
                const displayName = extra?.displayName || session.displayName || session.username
                const avatarUrl = extra?.avatarUrl || session.avatarUrl || avatarEntries[session.username]?.avatarUrl
                if (displayName === session.displayName && avatarUrl === session.avatarUrl) {
                  return session
                }
                return {
                  ...session,
                  displayName,
                  avatarUrl
                }
              })
              .sort((a, b) => (b.sortTimestamp || b.lastTimestamp || 0) - (a.sortTimestamp || a.lastTimestamp || 0))

            const contactsCachePayload = Object.values(contactMap).map((contact) => ({
              username: contact.username,
              displayName: contact.displayName || contact.username,
              remark: contact.remark,
              nickname: contact.nickname,
              alias: contact.alias,
              type: contact.type
            }))

            const persistAt = Date.now()
            setContactsList(contactsForPersist)
            setSessions(nextSessions)
            sessionsHydratedAtRef.current = persistAt
            if (hasNetworkContactsSnapshot && contactsCachePayload.length > 0) {
              await configService.setContactsListCache(scopeKey, contactsCachePayload)
              setSessionContactsUpdatedAt(persistAt)
            }
            if (Object.keys(avatarEntries).length > 0) {
              await configService.setContactsAvatarCache(scopeKey, avatarEntries)
              setSessionAvatarUpdatedAt(persistAt)
            }
            if (hasFreshNetworkData) {
              setSessionDataSource('network')
            }
          } catch (enrichError) {
            console.error('导出页补充会话联系人信息失败:', enrichError)
          } finally {
            if (!isStale()) setIsSessionEnriching(false)
          }
        })()
      } else {
        setIsLoading(false)
      }
    } catch (error) {
      console.error('加载会话失败:', error)
      if (!isStale()) setIsLoading(false)
    } finally {
      if (!isStale()) setIsLoading(false)
    }
  }, [ensureExportCacheScope, loadContactsCaches, loadSessionMessageCounts, mergeSessionContentMetrics, patchSessionLoadTraceStage, rebuildSessionMutualFriendsStateFromDirectMetrics, resetSessionMediaMetricLoader, resetSessionMutualFriendsLoader, syncContactTypeCounts])

  useEffect(() => {
    if (!isExportRoute) return
    const now = Date.now()
    const hasFreshSessionSnapshot = hasBaseConfigReadyRef.current &&
      sessionsRef.current.length > 0 &&
      now - sessionsHydratedAtRef.current <= EXPORT_REENTER_SESSION_SOFT_REFRESH_MS
    const baseConfigPromise = loadBaseConfig()
    void ensureSharedTabCountsLoaded()
    if (!hasFreshSessionSnapshot) {
      void loadSessions()
    }

    // 朋友圈统计延后一点加载，避免与首屏会话初始化抢占。
    const timer = window.setTimeout(() => {
      void (async () => {
        await baseConfigPromise
        const hasFreshSnsSnapshot = hasSeededSnsStatsRef.current &&
          Date.now() - snsStatsHydratedAtRef.current <= EXPORT_REENTER_SNS_SOFT_REFRESH_MS
        if (!hasFreshSnsSnapshot) {
          void loadSnsStats({ full: true })
        }
      })()
    }, 120)

    return () => window.clearTimeout(timer)
  }, [isExportRoute, ensureSharedTabCountsLoaded, loadBaseConfig, loadSessions, loadSnsStats])

  useEffect(() => {
    if (isExportRoute) return
    // 导出页隐藏时停止后台联系人补齐请求，避免与通讯录页面查询抢占。
    sessionLoadTokenRef.current = Date.now()
    sessionCountRequestIdRef.current += 1
    snsUserPostCountsHydrationTokenRef.current += 1
    if (snsUserPostCountsBatchTimerRef.current) {
      window.clearTimeout(snsUserPostCountsBatchTimerRef.current)
      snsUserPostCountsBatchTimerRef.current = null
    }
    resetSessionMutualFriendsLoader()
    setIsSessionEnriching(false)
    setIsLoadingSessionCounts(false)
    setSnsUserPostCountsStatus(prev => (prev === 'loading' ? 'idle' : prev))
  }, [isExportRoute, resetSessionMutualFriendsLoader])

  useEffect(() => {
    if (activeTab === 'official') {
      setActiveTab('private')
    }
  }, [activeTab])

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  useEffect(() => {
    preselectAppliedRef.current = false
  }, [location.key, preselectSessionIds])

  useEffect(() => {
    if (preselectAppliedRef.current) return
    if (sessions.length === 0 || preselectSessionIds.length === 0) return

    const exists = new Set(sessions.map(session => session.username))
    const matched = preselectSessionIds.filter(id => exists.has(id))
    preselectAppliedRef.current = true

    if (matched.length > 0) {
      setSelectedSessions(new Set(matched))
    }
  }, [sessions, preselectSessionIds])

  const selectedCount = selectedSessions.size

  const toggleSelectSession = (sessionId: string) => {
    const target = sessions.find(session => session.username === sessionId)
    if (!target?.hasSession) return
    setSelectedSessions(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const toggleSelectAllVisible = () => {
    const visibleIds = filteredContacts
      .filter(contact => sessionRowByUsername.get(contact.username)?.hasSession)
      .map(contact => contact.username)
    if (visibleIds.length === 0) return

    setSelectedSessions(prev => {
      const next = new Set(prev)
      const allSelected = visibleIds.every(id => next.has(id))
      if (allSelected) {
        for (const id of visibleIds) {
          next.delete(id)
        }
      } else {
        for (const id of visibleIds) {
          next.add(id)
        }
      }
      return next
    })
  }

  const clearSelection = () => setSelectedSessions(new Set())

  const openExportDialog = useCallback((payload: Omit<ExportDialogState, 'open'>) => {
    setExportDialog({ open: true, ...payload })
    setIsTimeRangeDialogOpen(false)
    setTimeRangeBounds(null)
    setTimeRangeSelection(exportDefaultDateRangeSelection)

    setOptions(prev => {
      const nextDateRange = cloneExportDateRange(exportDefaultDateRangeSelection.dateRange)

      const next: ExportOptions = {
        ...prev,
        format: exportDefaultFormat,
        exportAvatars: exportDefaultAvatars,
        useAllTime: exportDefaultDateRangeSelection.useAllTime,
        dateRange: nextDateRange,
        exportMedia: Boolean(
          exportDefaultMedia.images ||
          exportDefaultMedia.voices ||
          exportDefaultMedia.videos ||
          exportDefaultMedia.emojis
        ),
        exportImages: exportDefaultMedia.images,
        exportVoices: exportDefaultMedia.voices,
        exportVideos: exportDefaultMedia.videos,
        exportEmojis: exportDefaultMedia.emojis,
        exportVoiceAsText: exportDefaultVoiceAsText,
        excelCompactColumns: exportDefaultExcelCompactColumns,
        exportConcurrency: exportDefaultConcurrency,
        imageDeepSearchOnMiss: exportDefaultImageDeepSearchOnMiss
      }

      if (payload.scope === 'sns') {
        return next
      }

      if (payload.scope === 'content' && payload.contentType) {
        if (payload.contentType === 'text') {
          next.exportMedia = false
          next.exportImages = false
          next.exportVoices = false
          next.exportVideos = false
          next.exportEmojis = false
        } else {
          next.exportMedia = true
          next.exportImages = payload.contentType === 'image'
          next.exportVoices = payload.contentType === 'voice'
          next.exportVideos = payload.contentType === 'video'
          next.exportEmojis = payload.contentType === 'emoji'
          next.exportVoiceAsText = false
        }
      }

      return next
    })
  }, [
    exportDefaultDateRangeSelection,
    exportDefaultExcelCompactColumns,
    exportDefaultFormat,
    exportDefaultAvatars,
    exportDefaultMedia,
    exportDefaultVoiceAsText,
    exportDefaultConcurrency,
    exportDefaultImageDeepSearchOnMiss
  ])

  const closeExportDialog = useCallback(() => {
    setExportDialog(prev => ({ ...prev, open: false }))
    setIsTimeRangeDialogOpen(false)
    setTimeRangeBounds(null)
  }, [])

  const resolveChatExportTimeRangeBounds = useCallback(async (sessionIds: string[]): Promise<TimeRangeBounds | null> => {
    const normalizedSessionIds = Array.from(new Set((sessionIds || []).map(id => String(id || '').trim()).filter(Boolean)))
    if (normalizedSessionIds.length === 0) return null

    const sessionRowMap = new Map<string, SessionRow>()
    for (const session of sessions) {
      sessionRowMap.set(session.username, session)
    }

    let minTimestamp: number | undefined
    let maxTimestamp: number | undefined
    const resolvedSessionBounds = new Map<string, { hasMin: boolean; hasMax: boolean }>()

    const absorbMetric = (sessionId: string, metric?: { firstTimestamp?: number; lastTimestamp?: number } | null) => {
      if (!metric) return
      const firstTimestamp = normalizeTimestampSeconds(metric.firstTimestamp)
      const lastTimestamp = normalizeTimestampSeconds(metric.lastTimestamp)
      if (typeof firstTimestamp !== 'number' && typeof lastTimestamp !== 'number') return

      const previous = resolvedSessionBounds.get(sessionId) || { hasMin: false, hasMax: false }
      const nextState = {
        hasMin: previous.hasMin || typeof firstTimestamp === 'number',
        hasMax: previous.hasMax || typeof lastTimestamp === 'number'
      }
      resolvedSessionBounds.set(sessionId, nextState)

      if (typeof firstTimestamp === 'number' && (minTimestamp === undefined || firstTimestamp < minTimestamp)) {
        minTimestamp = firstTimestamp
      }
      if (typeof lastTimestamp === 'number' && (maxTimestamp === undefined || lastTimestamp > maxTimestamp)) {
        maxTimestamp = lastTimestamp
      }
    }

    for (const sessionId of normalizedSessionIds) {
      const sessionRow = sessionRowMap.get(sessionId)
      absorbMetric(sessionId, {
        firstTimestamp: undefined,
        lastTimestamp: sessionRow?.sortTimestamp || sessionRow?.lastTimestamp
      })
      absorbMetric(sessionId, sessionContentMetrics[sessionId])
      if (sessionDetail?.wxid === sessionId) {
        absorbMetric(sessionId, {
          firstTimestamp: sessionDetail.firstMessageTime,
          lastTimestamp: sessionDetail.latestMessageTime
        })
      }
    }

    const applyStatsResult = (result?: {
      success: boolean
      data?: Record<string, SessionExportMetric>
    } | null) => {
      if (!result?.success || !result.data) return
      applySessionMediaMetricsFromStats(result.data)
      for (const sessionId of normalizedSessionIds) {
        absorbMetric(sessionId, result.data[sessionId])
      }
    }

    const missingSessionIds = () => normalizedSessionIds.filter(sessionId => {
      const resolved = resolvedSessionBounds.get(sessionId)
      return !resolved?.hasMin || !resolved?.hasMax
    })

    const staleSessionIds = new Set<string>()

    if (missingSessionIds().length > 0) {
      const cacheResult = await window.electronAPI.chat.getExportSessionStats(
        missingSessionIds(),
        { includeRelations: false, allowStaleCache: true, cacheOnly: true }
      )
      applyStatsResult(cacheResult)
      for (const sessionId of cacheResult?.needsRefresh || []) {
        staleSessionIds.add(String(sessionId || '').trim())
      }
    }

    const sessionsNeedingFreshStats = Array.from(new Set([
      ...missingSessionIds(),
      ...Array.from(staleSessionIds).filter(Boolean)
    ]))

    if (sessionsNeedingFreshStats.length > 0) {
      applyStatsResult(await window.electronAPI.chat.getExportSessionStats(
        sessionsNeedingFreshStats,
        { includeRelations: false }
      ))
    }

    if (missingSessionIds().length > 0) {
      return null
    }
    if (typeof minTimestamp !== 'number' || typeof maxTimestamp !== 'number') {
      return null
    }

    return {
      minDate: new Date(minTimestamp * 1000),
      maxDate: new Date(maxTimestamp * 1000)
    }
  }, [applySessionMediaMetricsFromStats, sessionContentMetrics, sessionDetail, sessions])

  const openTimeRangeDialog = useCallback(() => {
    void (async () => {
      if (isResolvingTimeRangeBounds) return
      setIsResolvingTimeRangeBounds(true)
      try {
        let nextBounds: TimeRangeBounds | null = null
        if (exportDialog.scope !== 'sns') {
          nextBounds = await resolveChatExportTimeRangeBounds(exportDialog.sessionIds)
        }
        setTimeRangeBounds(nextBounds)
        if (nextBounds) {
          const nextSelection = clampExportSelectionToBounds(timeRangeSelection, nextBounds)
          if (!areExportSelectionsEqual(nextSelection, timeRangeSelection)) {
            setTimeRangeSelection(nextSelection)
            setOptions(prev => ({
              ...prev,
              useAllTime: nextSelection.useAllTime,
              dateRange: cloneExportDateRange(nextSelection.dateRange)
            }))
          }
        }
        setIsTimeRangeDialogOpen(true)
      } catch (error) {
        console.error('导出页解析时间范围边界失败', error)
        setTimeRangeBounds(null)
        setIsTimeRangeDialogOpen(true)
      } finally {
        setIsResolvingTimeRangeBounds(false)
      }
    })()
  }, [exportDialog.scope, exportDialog.sessionIds, isResolvingTimeRangeBounds, resolveChatExportTimeRangeBounds, timeRangeSelection])

  const closeTimeRangeDialog = useCallback(() => {
    setIsTimeRangeDialogOpen(false)
  }, [])

  const timeRangeSummaryLabel = useMemo(() => getExportDateRangeLabel(timeRangeSelection), [timeRangeSelection])

  useEffect(() => {
    const unsubscribe = onOpenSingleExport((payload) => {
      void (async () => {
        const sessionId = typeof payload?.sessionId === 'string'
          ? payload.sessionId.trim()
          : ''
        if (!sessionId) return

        const sessionName = typeof payload?.sessionName === 'string'
          ? payload.sessionName.trim()
          : ''
        const displayName = sessionName || sessionId
        const requestId = typeof payload?.requestId === 'string'
          ? payload.requestId.trim()
          : ''

        const emitStatus = (
          status: 'initializing' | 'opened' | 'failed',
          message?: string
        ) => {
          if (!requestId) return
          emitSingleExportDialogStatus({ requestId, status, message })
        }

        try {
          if (!hasBaseConfigReadyRef.current) {
            emitStatus('initializing')
            const ready = await loadBaseConfig()
            if (!ready) {
              emitStatus('failed', '导出模块初始化失败，请重试')
              return
            }
          }

          setSelectedSessions(new Set([sessionId]))
          openExportDialog({
            scope: 'single',
            sessionIds: [sessionId],
            sessionNames: [displayName],
            title: `导出会话：${displayName}`
          })
          emitStatus('opened')
        } catch (error) {
          console.error('聊天页唤起导出弹窗失败:', error)
          emitStatus('failed', String(error))
        }
      })()
    })

    return unsubscribe
  }, [loadBaseConfig, openExportDialog])

  const buildExportOptions = (scope: TaskScope, contentType?: ContentType): ElectronExportOptions => {
    const sessionLayout: SessionLayout = writeLayout === 'C' ? 'per-session' : 'shared'
    const exportMediaEnabled = Boolean(options.exportImages || options.exportVoices || options.exportVideos || options.exportEmojis)

    const base: ElectronExportOptions = {
      format: options.format,
      exportAvatars: options.exportAvatars,
      exportMedia: exportMediaEnabled,
      exportImages: options.exportImages,
      exportVoices: options.exportVoices,
      exportVideos: options.exportVideos,
      exportEmojis: options.exportEmojis,
      exportVoiceAsText: options.exportVoiceAsText,
      excelCompactColumns: options.excelCompactColumns,
      txtColumns: options.txtColumns,
      displayNamePreference: options.displayNamePreference,
      exportConcurrency: options.exportConcurrency,
      imageDeepSearchOnMiss: options.imageDeepSearchOnMiss,
      sessionLayout,
      sessionNameWithTypePrefix,
      dateRange: options.useAllTime
        ? null
        : options.dateRange
          ? {
              start: Math.floor(options.dateRange.start.getTime() / 1000),
              end: Math.floor(options.dateRange.end.getTime() / 1000)
            }
          : null
    }

    if (scope === 'content' && contentType) {
      if (contentType === 'text') {
        const textExportConcurrency = Math.min(2, Math.max(1, base.exportConcurrency ?? options.exportConcurrency))
        return {
          ...base,
          contentType,
          exportConcurrency: textExportConcurrency,
          exportAvatars: base.exportAvatars,
          exportMedia: false,
          exportImages: false,
          exportVoices: false,
          exportVideos: false,
          exportEmojis: false
        }
      }

      return {
        ...base,
        contentType,
        exportMedia: true,
        exportImages: contentType === 'image',
        exportVoices: contentType === 'voice',
        exportVideos: contentType === 'video',
        exportEmojis: contentType === 'emoji',
        exportVoiceAsText: false
      }
    }

    return base
  }

  const buildSnsExportOptions = () => {
    const format: SnsTimelineExportFormat = snsExportFormat
    const dateRange = options.useAllTime
      ? null
      : options.dateRange
        ? {
            startTime: Math.floor(options.dateRange.start.getTime() / 1000),
            endTime: Math.floor(options.dateRange.end.getTime() / 1000)
          }
        : null

    return {
      format,
      exportImages: snsExportImages,
      exportLivePhotos: snsExportLivePhotos,
      exportVideos: snsExportVideos,
      startTime: dateRange?.startTime,
      endTime: dateRange?.endTime
    }
  }

  const markSessionExported = useCallback((sessionIds: string[], timestamp: number) => {
    setLastExportBySession(prev => {
      const next = { ...prev }
      for (const id of sessionIds) {
        next[id] = timestamp
      }
      void configService.setExportLastSessionRunMap(next)
      return next
    })
  }, [])

  const markContentExported = useCallback((sessionIds: string[], contentTypes: ContentType[], timestamp: number) => {
    setLastExportByContent(prev => {
      const next = { ...prev }
      for (const id of sessionIds) {
        for (const type of contentTypes) {
          next[`${id}::${type}`] = timestamp
        }
      }
      void configService.setExportLastContentRunMap(next)
      return next
    })
  }, [])

  const resolveTaskExportContentLabel = useCallback((payload: ExportTaskPayload): string => {
    if (payload.scope === 'content' && payload.contentType) {
      return getContentTypeLabel(payload.contentType)
    }
    if (payload.scope === 'sns') return '朋友圈'

    const labels: string[] = ['聊天文本']
    const opts = payload.options
    if (opts?.exportMedia) {
      if (opts.exportImages) labels.push('图片')
      if (opts.exportVoices) labels.push('语音')
      if (opts.exportVideos) labels.push('视频')
      if (opts.exportEmojis) labels.push('表情包')
    }
    return Array.from(new Set(labels)).join('、')
  }, [])

  const markSessionExportRecords = useCallback((
    sessionIds: string[],
    content: string,
    outputDir: string,
    exportTime: number
  ) => {
    const normalizedContent = String(content || '').trim()
    const normalizedOutputDir = String(outputDir || '').trim()
    const normalizedExportTime = Number.isFinite(exportTime) ? Math.max(0, Math.floor(exportTime)) : Date.now()
    if (!normalizedContent || !normalizedOutputDir) return
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return

    setExportRecordsBySession(prev => {
      const next: Record<string, configService.ExportSessionRecordEntry[]> = { ...prev }
      let changed = false

      for (const rawSessionId of sessionIds) {
        const sessionId = String(rawSessionId || '').trim()
        if (!sessionId) continue
        const existingList = Array.isArray(next[sessionId]) ? [...next[sessionId]] : []
        const lastRecord = existingList[existingList.length - 1]
        if (
          lastRecord &&
          lastRecord.content === normalizedContent &&
          lastRecord.outputDir === normalizedOutputDir &&
          Math.abs(Number(lastRecord.exportTime || 0) - normalizedExportTime) <= 2000
        ) {
          continue
        }
        existingList.push({
          exportTime: normalizedExportTime,
          content: normalizedContent,
          outputDir: normalizedOutputDir
        })
        next[sessionId] = existingList.slice(-80)
        changed = true
      }

      if (!changed) return prev
      void configService.setExportSessionRecordMap(next)
      return next
    })
  }, [])

  const inferContentTypesFromOptions = (opts: ElectronExportOptions): ContentType[] => {
    const types: ContentType[] = ['text']
    if (opts.exportMedia) {
      if (opts.exportVoices) types.push('voice')
      if (opts.exportImages) types.push('image')
      if (opts.exportVideos) types.push('video')
      if (opts.exportEmojis) types.push('emoji')
    }
    return types
  }

  const updateTask = useCallback((taskId: string, updater: (task: ExportTask) => ExportTask) => {
    setTasks(prev => prev.map(task => (task.id === taskId ? updater(task) : task)))
  }, [])

  const runNextTask = useCallback(async () => {
    if (runningTaskIdRef.current) return

    const queue = [...tasksRef.current].reverse()
    const next = queue.find(task => task.status === 'queued')
    if (!next) return

    runningTaskIdRef.current = next.id
    updateTask(next.id, task => ({
      ...task,
      status: 'running',
      settledSessionIds: [],
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      performance: isTextBatchTask(task)
        ? (task.performance || createEmptyTaskPerformance())
        : task.performance
    }))
    const taskExportContentLabel = resolveTaskExportContentLabel(next.payload)

    progressUnsubscribeRef.current?.()
    const settledSessionIdsFromProgress = new Set<string>()
    const sessionMessageProgress = new Map<string, { exported: number; total: number; knownTotal: boolean }>()
    let queuedProgressPayload: ExportProgress | null = null
    let queuedProgressRaf: number | null = null
    let queuedProgressTimer: number | null = null

    const clearQueuedProgress = () => {
      if (queuedProgressRaf !== null) {
        window.cancelAnimationFrame(queuedProgressRaf)
        queuedProgressRaf = null
      }
      if (queuedProgressTimer !== null) {
        window.clearTimeout(queuedProgressTimer)
        queuedProgressTimer = null
      }
    }

    const updateSessionMessageProgress = (payload: ExportProgress) => {
      const sessionId = String(payload.currentSessionId || '').trim()
      if (!sessionId) return
      const prev = sessionMessageProgress.get(sessionId) || { exported: 0, total: 0, knownTotal: false }
      const nextExported = Number.isFinite(payload.exportedMessages)
        ? Math.max(prev.exported, Math.max(0, Math.floor(Number(payload.exportedMessages || 0))))
        : prev.exported
      const hasEstimatedTotal = Number.isFinite(payload.estimatedTotalMessages)
      const nextTotal = hasEstimatedTotal
        ? Math.max(prev.total, Math.max(0, Math.floor(Number(payload.estimatedTotalMessages || 0))))
        : prev.total
      const knownTotal = prev.knownTotal || hasEstimatedTotal
      sessionMessageProgress.set(sessionId, {
        exported: nextExported,
        total: nextTotal,
        knownTotal
      })
    }

    const resolveAggregatedMessageProgress = () => {
      let exported = 0
      let estimated = 0
      let allKnown = true
      for (const sessionId of next.payload.sessionIds) {
        const entry = sessionMessageProgress.get(sessionId)
        if (!entry) {
          allKnown = false
          continue
        }
        exported += entry.exported
        estimated += entry.total
        if (!entry.knownTotal) {
          allKnown = false
        }
      }
      return {
        exported: Math.max(0, Math.floor(exported)),
        estimated: allKnown ? Math.max(0, Math.floor(estimated)) : 0
      }
    }

    const flushQueuedProgress = () => {
      if (!queuedProgressPayload) return
      const payload = queuedProgressPayload
      queuedProgressPayload = null
      const now = Date.now()
      const currentSessionId = String(payload.currentSessionId || '').trim()
      updateTask(next.id, task => {
        if (task.status !== 'running') return task
        const performance = applyProgressToTaskPerformance(task, payload, now)
        const settledSessionIds = task.settledSessionIds || []
        const nextSettledSessionIds = (
          payload.phase === 'complete' &&
          currentSessionId &&
          !settledSessionIds.includes(currentSessionId)
        )
          ? [...settledSessionIds, currentSessionId]
          : settledSessionIds
        const aggregatedMessageProgress = resolveAggregatedMessageProgress()
        const collectedMessages = Number.isFinite(payload.collectedMessages)
          ? Math.max(0, Math.floor(Number(payload.collectedMessages || 0)))
          : task.progress.collectedMessages
        const writtenFiles = Number.isFinite(payload.writtenFiles)
          ? Math.max(task.progress.writtenFiles, Math.max(0, Math.floor(Number(payload.writtenFiles || 0))))
          : task.progress.writtenFiles
        const prevMediaDoneFiles = Number.isFinite(task.progress.mediaDoneFiles)
          ? Math.max(0, Math.floor(Number(task.progress.mediaDoneFiles || 0)))
          : 0
        const prevMediaCacheHitFiles = Number.isFinite(task.progress.mediaCacheHitFiles)
          ? Math.max(0, Math.floor(Number(task.progress.mediaCacheHitFiles || 0)))
          : 0
        const prevMediaCacheMissFiles = Number.isFinite(task.progress.mediaCacheMissFiles)
          ? Math.max(0, Math.floor(Number(task.progress.mediaCacheMissFiles || 0)))
          : 0
        const prevMediaCacheFillFiles = Number.isFinite(task.progress.mediaCacheFillFiles)
          ? Math.max(0, Math.floor(Number(task.progress.mediaCacheFillFiles || 0)))
          : 0
        const prevMediaDedupReuseFiles = Number.isFinite(task.progress.mediaDedupReuseFiles)
          ? Math.max(0, Math.floor(Number(task.progress.mediaDedupReuseFiles || 0)))
          : 0
        const prevMediaBytesWritten = Number.isFinite(task.progress.mediaBytesWritten)
          ? Math.max(0, Math.floor(Number(task.progress.mediaBytesWritten || 0)))
          : 0
        const mediaDoneFiles = Number.isFinite(payload.mediaDoneFiles)
          ? Math.max(prevMediaDoneFiles, Math.max(0, Math.floor(Number(payload.mediaDoneFiles || 0))))
          : prevMediaDoneFiles
        const mediaCacheHitFiles = Number.isFinite(payload.mediaCacheHitFiles)
          ? Math.max(prevMediaCacheHitFiles, Math.max(0, Math.floor(Number(payload.mediaCacheHitFiles || 0))))
          : prevMediaCacheHitFiles
        const mediaCacheMissFiles = Number.isFinite(payload.mediaCacheMissFiles)
          ? Math.max(prevMediaCacheMissFiles, Math.max(0, Math.floor(Number(payload.mediaCacheMissFiles || 0))))
          : prevMediaCacheMissFiles
        const mediaCacheFillFiles = Number.isFinite(payload.mediaCacheFillFiles)
          ? Math.max(prevMediaCacheFillFiles, Math.max(0, Math.floor(Number(payload.mediaCacheFillFiles || 0))))
          : prevMediaCacheFillFiles
        const mediaDedupReuseFiles = Number.isFinite(payload.mediaDedupReuseFiles)
          ? Math.max(prevMediaDedupReuseFiles, Math.max(0, Math.floor(Number(payload.mediaDedupReuseFiles || 0))))
          : prevMediaDedupReuseFiles
        const mediaBytesWritten = Number.isFinite(payload.mediaBytesWritten)
          ? Math.max(prevMediaBytesWritten, Math.max(0, Math.floor(Number(payload.mediaBytesWritten || 0))))
          : prevMediaBytesWritten
        return {
          ...task,
          progress: {
            current: payload.current,
            total: payload.total,
            currentName: payload.currentSession,
            phase: payload.phase,
            phaseLabel: payload.phaseLabel || '',
            phaseProgress: payload.phaseProgress || 0,
            phaseTotal: payload.phaseTotal || 0,
            exportedMessages: Math.max(task.progress.exportedMessages, aggregatedMessageProgress.exported),
            estimatedTotalMessages: aggregatedMessageProgress.estimated > 0
              ? Math.max(task.progress.estimatedTotalMessages, aggregatedMessageProgress.estimated)
              : (task.progress.estimatedTotalMessages > 0 ? task.progress.estimatedTotalMessages : 0),
            collectedMessages: Math.max(task.progress.collectedMessages, collectedMessages),
            writtenFiles,
            mediaDoneFiles,
            mediaCacheHitFiles,
            mediaCacheMissFiles,
            mediaCacheFillFiles,
            mediaDedupReuseFiles,
            mediaBytesWritten
          },
          settledSessionIds: nextSettledSessionIds,
          performance
        }
      })
    }

    const queueProgressUpdate = (payload: ExportProgress) => {
      queuedProgressPayload = payload
      if (payload.phase === 'complete') {
        clearQueuedProgress()
        flushQueuedProgress()
        return
      }
      if (queuedProgressRaf !== null || queuedProgressTimer !== null) return
      queuedProgressRaf = window.requestAnimationFrame(() => {
        queuedProgressRaf = null
        queuedProgressTimer = window.setTimeout(() => {
          queuedProgressTimer = null
          flushQueuedProgress()
        }, 100)
      })
    }
    if (next.payload.scope === 'sns') {
      progressUnsubscribeRef.current = window.electronAPI.sns.onExportProgress((payload) => {
        updateTask(next.id, task => {
          if (task.status !== 'running') return task
          return {
            ...task,
            progress: {
              current: payload.current || 0,
              total: payload.total || 0,
              currentName: '',
              phase: 'exporting',
              phaseLabel: payload.status || '',
              phaseProgress: payload.total > 0 ? payload.current : 0,
              phaseTotal: payload.total || 0,
              exportedMessages: payload.total > 0 ? Math.max(0, Math.floor(payload.current || 0)) : task.progress.exportedMessages,
              estimatedTotalMessages: payload.total > 0 ? Math.max(0, Math.floor(payload.total || 0)) : task.progress.estimatedTotalMessages,
              collectedMessages: task.progress.collectedMessages,
              writtenFiles: task.progress.writtenFiles,
              mediaDoneFiles: task.progress.mediaDoneFiles,
              mediaCacheHitFiles: task.progress.mediaCacheHitFiles,
              mediaCacheMissFiles: task.progress.mediaCacheMissFiles,
              mediaCacheFillFiles: task.progress.mediaCacheFillFiles,
              mediaDedupReuseFiles: task.progress.mediaDedupReuseFiles,
              mediaBytesWritten: task.progress.mediaBytesWritten
            }
          }
        })
      })
    } else {
      progressUnsubscribeRef.current = window.electronAPI.export.onProgress((payload: ExportProgress) => {
        const now = Date.now()
        const currentSessionId = String(payload.currentSessionId || '').trim()
        updateSessionMessageProgress(payload)
        if (payload.phase === 'complete' && currentSessionId && !settledSessionIdsFromProgress.has(currentSessionId)) {
          settledSessionIdsFromProgress.add(currentSessionId)
          const phaseLabel = String(payload.phaseLabel || '')
          const isFailed = phaseLabel.includes('失败')
          if (!isFailed) {
            const contentTypes = next.payload.contentType
              ? [next.payload.contentType]
              : (next.payload.options ? inferContentTypesFromOptions(next.payload.options) : [])
            markSessionExported([currentSessionId], now)
            if (contentTypes.length > 0) {
              markContentExported([currentSessionId], contentTypes, now)
            }
            markSessionExportRecords([currentSessionId], taskExportContentLabel, next.payload.outputDir, now)
          }
        }
        queueProgressUpdate(payload)
      })
    }

    try {
      if (next.payload.scope === 'sns') {
        const snsOptions = next.payload.snsOptions || { format: 'html' as SnsTimelineExportFormat, exportImages: false, exportLivePhotos: false, exportVideos: false }
        const result = await window.electronAPI.sns.exportTimeline({
          outputDir: next.payload.outputDir,
          format: snsOptions.format,
          exportImages: snsOptions.exportImages,
          exportLivePhotos: snsOptions.exportLivePhotos,
          exportVideos: snsOptions.exportVideos,
          startTime: snsOptions.startTime,
          endTime: snsOptions.endTime
        })

        if (!result.success) {
          updateTask(next.id, task => ({
            ...task,
            status: 'error',
            finishedAt: Date.now(),
            error: result.error || '朋友圈导出失败',
            performance: finalizeTaskPerformance(task, Date.now())
          }))
        } else {
          const doneAt = Date.now()
          const exportedPosts = Math.max(0, result.postCount || 0)
          const mergedExportedCount = Math.max(lastSnsExportPostCount, exportedPosts)
          setLastSnsExportPostCount(mergedExportedCount)
          await configService.setExportLastSnsPostCount(mergedExportedCount)
          await loadSnsStats({ full: true })

          updateTask(next.id, task => ({
            ...task,
            status: 'success',
            finishedAt: doneAt,
            progress: {
              ...task.progress,
              current: exportedPosts,
              total: exportedPosts,
              phaseLabel: '完成',
              phaseProgress: 1,
              phaseTotal: 1
            },
            performance: finalizeTaskPerformance(task, doneAt)
          }))
        }
      } else {
        if (!next.payload.options) {
          throw new Error('导出参数缺失')
        }

        const result = await window.electronAPI.export.exportSessions(
          next.payload.sessionIds,
          next.payload.outputDir,
          next.payload.options
        )

        if (!result.success) {
          updateTask(next.id, task => ({
            ...task,
            status: 'error',
            finishedAt: Date.now(),
            error: result.error || '导出失败',
            performance: finalizeTaskPerformance(task, Date.now())
          }))
        } else {
          const doneAt = Date.now()
          const contentTypes = next.payload.contentType
            ? [next.payload.contentType]
            : inferContentTypesFromOptions(next.payload.options)
          const successSessionIds = Array.isArray(result.successSessionIds)
            ? result.successSessionIds
            : []
          if (successSessionIds.length > 0) {
            const unsettledSuccessSessionIds = successSessionIds.filter((sessionId) => !settledSessionIdsFromProgress.has(sessionId))
            if (unsettledSuccessSessionIds.length > 0) {
              markSessionExported(unsettledSuccessSessionIds, doneAt)
              markSessionExportRecords(unsettledSuccessSessionIds, taskExportContentLabel, next.payload.outputDir, doneAt)
              if (contentTypes.length > 0) {
                markContentExported(unsettledSuccessSessionIds, contentTypes, doneAt)
              }
            }
          }

          updateTask(next.id, task => ({
            ...task,
            status: 'success',
            finishedAt: doneAt,
            progress: {
              ...task.progress,
              current: task.progress.total || next.payload.sessionIds.length,
              total: task.progress.total || next.payload.sessionIds.length,
              phaseLabel: '完成',
              phaseProgress: 1,
              phaseTotal: 1
            },
            performance: finalizeTaskPerformance(task, doneAt)
          }))
        }
      }
    } catch (error) {
      const doneAt = Date.now()
      updateTask(next.id, task => ({
        ...task,
        status: 'error',
        finishedAt: doneAt,
        error: String(error),
        performance: finalizeTaskPerformance(task, doneAt)
      }))
    } finally {
      clearQueuedProgress()
      flushQueuedProgress()
      progressUnsubscribeRef.current?.()
      progressUnsubscribeRef.current = null
      runningTaskIdRef.current = null
      void runNextTask()
    }
  }, [
    updateTask,
    markSessionExported,
    markSessionExportRecords,
    markContentExported,
    resolveTaskExportContentLabel,
    loadSnsStats,
    lastSnsExportPostCount
  ])

  useEffect(() => {
    void runNextTask()
  }, [tasks, runNextTask])

  useEffect(() => {
    return () => {
      progressUnsubscribeRef.current?.()
      progressUnsubscribeRef.current = null
    }
  }, [])

  const createTask = async () => {
    if (!exportDialog.open || !exportFolder) return
    if (exportDialog.scope !== 'sns' && exportDialog.sessionIds.length === 0) return

    const exportOptions = exportDialog.scope === 'sns'
      ? undefined
      : buildExportOptions(exportDialog.scope, exportDialog.contentType)
    const snsOptions = exportDialog.scope === 'sns'
      ? buildSnsExportOptions()
      : undefined
    const title =
      exportDialog.scope === 'single'
        ? `${exportDialog.sessionNames[0] || '会话'} 导出`
        : exportDialog.scope === 'multi'
          ? `批量导出（${exportDialog.sessionIds.length} 个会话）`
          : exportDialog.scope === 'sns'
            ? '朋友圈批量导出'
            : `${contentTypeLabels[exportDialog.contentType || 'text']}批量导出`

    const task: ExportTask = {
      id: createTaskId(),
      title,
      status: 'queued',
      settledSessionIds: [],
      createdAt: Date.now(),
      payload: {
        sessionIds: exportDialog.sessionIds,
        sessionNames: exportDialog.sessionNames,
        outputDir: exportFolder,
        options: exportOptions,
        scope: exportDialog.scope,
        contentType: exportDialog.contentType,
        snsOptions
      },
      progress: createEmptyProgress(),
      performance: exportDialog.scope === 'content' && exportDialog.contentType === 'text'
        ? createEmptyTaskPerformance()
        : undefined
    }

    setTasks(prev => [task, ...prev])
    closeExportDialog()

    await configService.setExportDefaultFormat(options.format)
    await configService.setExportDefaultAvatars(options.exportAvatars)
    await configService.setExportDefaultMedia({
      images: options.exportImages,
      voices: options.exportVoices,
      videos: options.exportVideos,
      emojis: options.exportEmojis
    })
    await configService.setExportDefaultVoiceAsText(options.exportVoiceAsText)
    await configService.setExportDefaultExcelCompactColumns(options.excelCompactColumns)
    await configService.setExportDefaultTxtColumns(options.txtColumns)
    await configService.setExportDefaultConcurrency(options.exportConcurrency)
    await configService.setExportDefaultImageDeepSearchOnMiss(options.imageDeepSearchOnMiss)
    setExportDefaultImageDeepSearchOnMiss(options.imageDeepSearchOnMiss)
  }

  const openSingleExport = useCallback((session: SessionRow) => {
    if (!session.hasSession) return
    openExportDialog({
      scope: 'single',
      sessionIds: [session.username],
      sessionNames: [session.displayName || session.username],
      title: `导出会话：${session.displayName || session.username}`
    })
  }, [openExportDialog])

  const resolveSessionExistingMessageCount = useCallback((session: SessionRow): number => {
    const counted = normalizeMessageCount(sessionMessageCounts[session.username])
    if (typeof counted === 'number') return counted
    const hinted = normalizeMessageCount(session.messageCountHint)
    if (typeof hinted === 'number') return hinted
    return 0
  }, [sessionMessageCounts])

  const orderSessionsForExport = useCallback((source: SessionRow[]): SessionRow[] => {
    return source
      .filter((session) => session.hasSession && isContentScopeSession(session))
      .map((session) => ({
        session,
        count: resolveSessionExistingMessageCount(session)
      }))
      .filter((item) => item.count > 0)
      .sort((a, b) => {
        const kindDiff = exportKindPriority[a.session.kind] - exportKindPriority[b.session.kind]
        if (kindDiff !== 0) return kindDiff
        if (a.count !== b.count) return b.count - a.count
        const tsA = a.session.sortTimestamp || a.session.lastTimestamp || 0
        const tsB = b.session.sortTimestamp || b.session.lastTimestamp || 0
        if (tsA !== tsB) return tsB - tsA
        return (a.session.displayName || a.session.username)
          .localeCompare(b.session.displayName || b.session.username, 'zh-Hans-CN')
      })
      .map((item) => item.session)
  }, [resolveSessionExistingMessageCount])

  const openBatchExport = () => {
    const selectedSet = new Set(selectedSessions)
    const selectedRows = sessions.filter((session) => selectedSet.has(session.username))
    const orderedRows = orderSessionsForExport(selectedRows)
    if (orderedRows.length === 0) {
      window.alert('所选会话暂无可导出的消息（总消息数为 0）')
      return
    }
    const ids = orderedRows.map((session) => session.username)
    const names = orderedRows.map((session) => session.displayName || session.username)

    openExportDialog({
      scope: 'multi',
      sessionIds: ids,
      sessionNames: names,
      title: `批量导出（${ids.length} 个会话）`
    })
  }

  const openContentExport = (contentType: ContentType) => {
    const orderedRows = orderSessionsForExport(sessions)
    if (orderedRows.length === 0) {
      window.alert('当前会话列表暂无可导出的消息（总消息数为 0）')
      return
    }
    const ids = orderedRows.map((session) => session.username)
    const names = orderedRows.map((session) => session.displayName || session.username)

    openExportDialog({
      scope: 'content',
      contentType,
      sessionIds: ids,
      sessionNames: names,
      title: `${contentTypeLabels[contentType]}批量导出`
    })
  }

  const openSnsExport = () => {
    openExportDialog({
      scope: 'sns',
      sessionIds: [],
      sessionNames: ['全部朋友圈动态'],
      title: '朋友圈批量导出'
    })
  }

  const runningSessionIds = useMemo(() => {
    const set = new Set<string>()
    for (const task of tasks) {
      if (task.status !== 'running') continue
      const settled = new Set(task.settledSessionIds || [])
      for (const id of task.payload.sessionIds) {
        if (settled.has(id)) continue
        set.add(id)
      }
    }
    return set
  }, [tasks])

  const queuedSessionIds = useMemo(() => {
    const set = new Set<string>()
    for (const task of tasks) {
      if (task.status !== 'queued') continue
      for (const id of task.payload.sessionIds) {
        set.add(id)
      }
    }
    return set
  }, [tasks])

  const inProgressSessionIds = useMemo(() => {
    const set = new Set<string>()
    for (const task of tasks) {
      if (task.status !== 'running' && task.status !== 'queued') continue
      for (const id of task.payload.sessionIds) {
        set.add(id)
      }
    }
    return Array.from(set).sort()
  }, [tasks])
  const activeTaskCount = useMemo(
    () => tasks.filter(task => task.status === 'running' || task.status === 'queued').length,
    [tasks]
  )

  const inProgressSessionIdsKey = useMemo(
    () => inProgressSessionIds.join('||'),
    [inProgressSessionIds]
  )
  const inProgressStatusKey = useMemo(
    () => `${activeTaskCount}::${inProgressSessionIdsKey}`,
    [activeTaskCount, inProgressSessionIdsKey]
  )

  useEffect(() => {
    inProgressSessionIdsRef.current = inProgressSessionIds
  }, [inProgressSessionIds])

  useEffect(() => {
    activeTaskCountRef.current = activeTaskCount
  }, [activeTaskCount])

  useEffect(() => {
    emitExportSessionStatus({
      inProgressSessionIds: inProgressSessionIdsRef.current,
      activeTaskCount: activeTaskCountRef.current
    })
  }, [inProgressStatusKey])

  useEffect(() => {
    const unsubscribe = onExportSessionStatusRequest(() => {
      emitExportSessionStatus({
        inProgressSessionIds: inProgressSessionIdsRef.current,
        activeTaskCount: activeTaskCountRef.current
      })
    })
    return unsubscribe
  }, [])

  const runningCardTypes = useMemo(() => {
    const set = new Set<ContentCardType>()
    for (const task of tasks) {
      if (task.status !== 'running') continue
      if (task.payload.scope === 'sns') {
        set.add('sns')
        continue
      }
      if (task.payload.scope === 'content' && task.payload.contentType) {
        set.add(task.payload.contentType)
      }
    }
    return set
  }, [tasks])

  const contentCards = useMemo(() => {
    const scopeSessions = sessions.filter(isContentScopeSession)
    const snsExportedCount = Math.min(lastSnsExportPostCount, snsStats.totalPosts)

    const sessionCards = [
      { type: 'text' as ContentType, icon: MessageSquareText },
      { type: 'voice' as ContentType, icon: Mic },
      { type: 'image' as ContentType, icon: ImageIcon },
      { type: 'video' as ContentType, icon: Video },
      { type: 'emoji' as ContentType, icon: WandSparkles }
    ].map(item => {
      let exported = 0
      for (const session of scopeSessions) {
        if (lastExportByContent[`${session.username}::${item.type}`]) {
          exported += 1
        }
      }

      return {
        ...item,
        label: contentTypeLabels[item.type],
        stats: [
          { label: '已导出', value: exported, unit: '个对话' }
        ]
      }
    })

    const snsCard = {
      type: 'sns' as ContentCardType,
      icon: Aperture,
      label: '朋友圈',
      headerCount: snsStats.totalPosts,
      stats: [
        { label: '已导出', value: snsExportedCount, unit: '条' }
      ]
    }

    return [...sessionCards, snsCard]
  }, [sessions, lastExportByContent, snsStats, lastSnsExportPostCount])

  const activeTabLabel = useMemo(() => {
    if (activeTab === 'private') return '私聊'
    if (activeTab === 'group') return '群聊'
    return '曾经的好友'
  }, [activeTab])
  const contactsHeaderMainLabel = useMemo(() => {
    if (activeTab === 'group') return '群聊名称'
    if (activeTab === 'private' || activeTab === 'former_friend') return '联系人'
    return '联系人（头像/名称/微信号）'
  }, [activeTab])
  const shouldShowSnsColumn = useMemo(() => (
    activeTab === 'private' || activeTab === 'former_friend'
  ), [activeTab])
  const shouldShowMutualFriendsColumn = shouldShowSnsColumn

  const sessionRowByUsername = useMemo(() => {
    const map = new Map<string, SessionRow>()
    for (const session of sessions) {
      map.set(session.username, session)
    }
    return map
  }, [sessions])

  const filteredContacts = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    const contacts = contactsList
      .filter((contact) => {
        if (!matchesContactTab(contact, activeTab)) return false
        if (!keyword) return true
        return (
          (contact.displayName || '').toLowerCase().includes(keyword) ||
          (contact.remark || '').toLowerCase().includes(keyword) ||
          (contact.nickname || '').toLowerCase().includes(keyword) ||
          (contact.alias || '').toLowerCase().includes(keyword) ||
          contact.username.toLowerCase().includes(keyword)
        )
      })

    const indexedContacts = contacts.map((contact, index) => ({
      contact,
      index,
      count: (() => {
        const counted = normalizeMessageCount(sessionMessageCounts[contact.username])
        if (typeof counted === 'number') return counted
        const hinted = normalizeMessageCount(sessionRowByUsername.get(contact.username)?.messageCountHint)
        return hinted
      })()
    }))

    indexedContacts.sort((a, b) => {
      const aHasCount = typeof a.count === 'number'
      const bHasCount = typeof b.count === 'number'
      if (aHasCount && bHasCount) {
        const diff = (b.count as number) - (a.count as number)
        if (diff !== 0) return diff
      } else if (aHasCount) {
        return -1
      } else if (bHasCount) {
        return 1
      }
      // 无统计值或同分时保持原顺序，避免列表频繁跳动。
      return a.index - b.index
    })

    return indexedContacts.map(item => item.contact)
  }, [contactsList, activeTab, searchKeyword, sessionMessageCounts, sessionRowByUsername])

  const keywordMatchedContactUsernameSet = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    const matched = new Set<string>()
    for (const contact of contactsList) {
      if (!contact?.username) continue
      if (!keyword) {
        matched.add(contact.username)
        continue
      }
      if (
        (contact.displayName || '').toLowerCase().includes(keyword) ||
        (contact.remark || '').toLowerCase().includes(keyword) ||
        (contact.nickname || '').toLowerCase().includes(keyword) ||
        (contact.alias || '').toLowerCase().includes(keyword) ||
        contact.username.toLowerCase().includes(keyword)
      ) {
        matched.add(contact.username)
      }
    }
    return matched
  }, [contactsList, searchKeyword])

  const loadDetailTargetsByTab = useMemo(() => {
    const targets: Record<ConversationTab, string[]> = {
      private: [],
      group: [],
      official: [],
      former_friend: []
    }
    for (const session of sessions) {
      if (!session.hasSession) continue
      if (!keywordMatchedContactUsernameSet.has(session.username)) continue
      targets[session.kind].push(session.username)
    }
    return targets
  }, [keywordMatchedContactUsernameSet, sessions])

  const formatLoadDetailTime = useCallback((value?: number): string => {
    if (!value || !Number.isFinite(value)) return '--'
    return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
  }, [])

  const getLoadDetailStatusLabel = useCallback((
    loaded: number,
    total: number,
    hasStarted: boolean,
    hasLoading: boolean,
    failedCount: number
  ): string => {
    if (total <= 0) return '待加载'
    const terminalCount = loaded + failedCount
    if (terminalCount >= total) {
      if (failedCount > 0) return `已完成 ${loaded}/${total}（失败 ${failedCount}）`
      return `已完成 ${total}`
    }
    if (hasLoading) return `加载中 ${loaded}/${total}`
    if (hasStarted && failedCount > 0) return `已完成 ${loaded}/${total}（失败 ${failedCount}）`
    if (hasStarted) return `已完成 ${loaded}/${total}`
    return '待加载'
  }, [])

  const summarizeLoadTraceForTab = useCallback((
    sessionIds: string[],
    stageKey: keyof SessionLoadTraceState
  ): SessionLoadStageSummary => {
    const total = sessionIds.length
    let loaded = 0
    let failedCount = 0
    let hasStarted = false
    let hasLoading = false
    let earliestStart: number | undefined
    let latestFinish: number | undefined
    let latestProgressAt: number | undefined
    for (const sessionId of sessionIds) {
      const stage = sessionLoadTraceMap[sessionId]?.[stageKey]
      if (stage?.status === 'done') {
        loaded += 1
        if (typeof stage.finishedAt === 'number') {
          latestProgressAt = latestProgressAt === undefined
            ? stage.finishedAt
            : Math.max(latestProgressAt, stage.finishedAt)
        }
      }
      if (stage?.status === 'failed') {
        failedCount += 1
      }
      if (stage?.status === 'loading') {
        hasLoading = true
      }
      if (stage?.status === 'loading' || stage?.status === 'failed' || typeof stage?.startedAt === 'number') {
        hasStarted = true
      }
      if (typeof stage?.startedAt === 'number') {
        earliestStart = earliestStart === undefined
          ? stage.startedAt
          : Math.min(earliestStart, stage.startedAt)
      }
      if (typeof stage?.finishedAt === 'number') {
        latestFinish = latestFinish === undefined
          ? stage.finishedAt
          : Math.max(latestFinish, stage.finishedAt)
      }
    }
    return {
      total,
      loaded,
      statusLabel: getLoadDetailStatusLabel(loaded, total, hasStarted, hasLoading, failedCount),
      startedAt: earliestStart,
      finishedAt: (loaded + failedCount) >= total ? latestFinish : undefined,
      latestProgressAt
    }
  }, [getLoadDetailStatusLabel, sessionLoadTraceMap])

  const createNotApplicableLoadSummary = useCallback((): SessionLoadStageSummary => {
    return {
      total: 0,
      loaded: 0,
      statusLabel: '不适用'
    }
  }, [])

  const sessionLoadDetailRows = useMemo(() => {
    const tabOrder: ConversationTab[] = ['private', 'group', 'former_friend']
    return tabOrder.map((tab) => {
      const sessionIds = loadDetailTargetsByTab[tab] || []
      const snsSessionIds = sessionIds.filter((sessionId) => isSingleContactSession(sessionId))
      const snsPostCounts = tab === 'private' || tab === 'former_friend'
        ? summarizeLoadTraceForTab(snsSessionIds, 'snsPostCounts')
        : createNotApplicableLoadSummary()
      const mutualFriends = tab === 'private' || tab === 'former_friend'
        ? summarizeLoadTraceForTab(snsSessionIds, 'mutualFriends')
        : createNotApplicableLoadSummary()
      return {
        tab,
        label: conversationTabLabels[tab],
        messageCount: summarizeLoadTraceForTab(sessionIds, 'messageCount'),
        mediaMetrics: summarizeLoadTraceForTab(sessionIds, 'mediaMetrics'),
        snsPostCounts,
        mutualFriends
      }
    })
  }, [createNotApplicableLoadSummary, loadDetailTargetsByTab, summarizeLoadTraceForTab])

  const formatLoadDetailPulseTime = useCallback((value?: number): string => {
    if (!value || !Number.isFinite(value)) return '--'
    return new Date(value).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }, [])

  useEffect(() => {
    const previousSnapshot = sessionLoadProgressSnapshotRef.current
    const nextSnapshot: Record<string, { loaded: number; total: number }> = {}
    const resetKeys: string[] = []
    const updates: Array<{ key: string; at: number; delta: number }> = []
    const stageKeys: Array<keyof SessionLoadTraceState> = ['messageCount', 'mediaMetrics', 'snsPostCounts', 'mutualFriends']

    for (const row of sessionLoadDetailRows) {
      for (const stageKey of stageKeys) {
        const summary = row[stageKey]
        const key = `${stageKey}:${row.tab}`
        const loaded = Number.isFinite(summary.loaded) ? Math.max(0, Math.floor(summary.loaded)) : 0
        const total = Number.isFinite(summary.total) ? Math.max(0, Math.floor(summary.total)) : 0
        nextSnapshot[key] = { loaded, total }

        const previous = previousSnapshot[key]
        if (!previous || previous.total !== total || loaded < previous.loaded) {
          resetKeys.push(key)
          continue
        }
        if (loaded > previous.loaded) {
          updates.push({
            key,
            at: summary.latestProgressAt || Date.now(),
            delta: loaded - previous.loaded
          })
        }
      }
    }

    sessionLoadProgressSnapshotRef.current = nextSnapshot
    if (resetKeys.length === 0 && updates.length === 0) return

    setSessionLoadProgressPulseMap(prev => {
      let changed = false
      const next = { ...prev }
      for (const key of resetKeys) {
        if (!(key in next)) continue
        delete next[key]
        changed = true
      }
      for (const update of updates) {
        const previous = next[update.key]
        if (previous && previous.at === update.at && previous.delta === update.delta) continue
        next[update.key] = { at: update.at, delta: update.delta }
        changed = true
      }
      return changed ? next : prev
    })
  }, [sessionLoadDetailRows])

  useEffect(() => {
    contactsVirtuosoRef.current?.scrollToIndex({ index: 0, align: 'start' })
    setIsContactsListAtTop(true)
  }, [activeTab, searchKeyword])

  const collectVisibleSessionMetricTargets = useCallback((sourceContacts: ContactInfo[]): string[] => {
    if (sourceContacts.length === 0) return []
    const startCandidate = sessionMediaMetricVisibleRangeRef.current.startIndex
    const endCandidate = sessionMediaMetricVisibleRangeRef.current.endIndex
    const startIndex = Math.max(0, Math.min(sourceContacts.length - 1, startCandidate >= 0 ? startCandidate : 0))
    const visibleEnd = endCandidate >= startIndex
      ? endCandidate
      : Math.min(sourceContacts.length - 1, startIndex + 9)
    const endIndex = Math.max(startIndex, Math.min(sourceContacts.length - 1, visibleEnd + SESSION_MEDIA_METRIC_PREFETCH_ROWS))
    const sessionIds: string[] = []
    for (let index = startIndex; index <= endIndex; index += 1) {
      const contact = sourceContacts[index]
      if (!contact?.username) continue
      const mappedSession = sessionRowByUsername.get(contact.username)
      if (!mappedSession?.hasSession) continue
      sessionIds.push(contact.username)
    }
    return sessionIds
  }, [sessionRowByUsername])

  const collectVisibleSessionMutualFriendsTargets = useCallback((sourceContacts: ContactInfo[]): string[] => {
    if (sourceContacts.length === 0) return []
    const startCandidate = sessionMutualFriendsVisibleRangeRef.current.startIndex
    const endCandidate = sessionMutualFriendsVisibleRangeRef.current.endIndex
    const startIndex = Math.max(0, Math.min(sourceContacts.length - 1, startCandidate >= 0 ? startCandidate : 0))
    const visibleEnd = endCandidate >= startIndex
      ? endCandidate
      : Math.min(sourceContacts.length - 1, startIndex + 9)
    const endIndex = Math.max(startIndex, Math.min(sourceContacts.length - 1, visibleEnd + SESSION_MEDIA_METRIC_PREFETCH_ROWS))
    const sessionIds: string[] = []
    for (let index = startIndex; index <= endIndex; index += 1) {
      const contact = sourceContacts[index]
      if (!contact?.username || !isSingleContactSession(contact.username)) continue
      const mappedSession = sessionRowByUsername.get(contact.username)
      if (!mappedSession?.hasSession) continue
      sessionIds.push(contact.username)
    }
    return sessionIds
  }, [sessionRowByUsername])

  const handleContactsRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    const startIndex = Number.isFinite(range?.startIndex) ? Math.max(0, Math.floor(range.startIndex)) : 0
    const endIndex = Number.isFinite(range?.endIndex) ? Math.max(startIndex, Math.floor(range.endIndex)) : startIndex
    sessionMediaMetricVisibleRangeRef.current = { startIndex, endIndex }
    sessionMutualFriendsVisibleRangeRef.current = { startIndex, endIndex }
    void hydrateVisibleContactAvatars(
      filteredContacts
        .slice(startIndex, endIndex + 1)
        .map((contact) => contact.username)
    )
    const visibleTargets = collectVisibleSessionMetricTargets(filteredContacts)
    if (visibleTargets.length === 0) return
    enqueueSessionMediaMetricRequests(visibleTargets, { front: true })
    scheduleSessionMediaMetricWorker()
    const visibleMutualFriendsTargets = collectVisibleSessionMutualFriendsTargets(filteredContacts)
    if (visibleMutualFriendsTargets.length > 0) {
      enqueueSessionMutualFriendsRequests(visibleMutualFriendsTargets, { front: true })
      scheduleSessionMutualFriendsWorker()
    }
  }, [
    collectVisibleSessionMetricTargets,
    collectVisibleSessionMutualFriendsTargets,
    enqueueSessionMediaMetricRequests,
    enqueueSessionMutualFriendsRequests,
    filteredContacts,
    hydrateVisibleContactAvatars,
    scheduleSessionMediaMetricWorker,
    scheduleSessionMutualFriendsWorker
  ])

  useEffect(() => {
    if (filteredContacts.length === 0) return
    const bootstrapTargets = filteredContacts.slice(0, 24).map((contact) => contact.username)
    void hydrateVisibleContactAvatars(bootstrapTargets)
  }, [filteredContacts, hydrateVisibleContactAvatars])

  useEffect(() => {
    const sessionId = String(sessionDetail?.wxid || '').trim()
    if (!sessionId) return
    void hydrateVisibleContactAvatars([sessionId])
  }, [hydrateVisibleContactAvatars, sessionDetail?.wxid])

  useEffect(() => {
    if (activeTaskCount > 0) return
    if (filteredContacts.length === 0) return
    const runId = sessionMediaMetricRunIdRef.current
    const visibleTargets = collectVisibleSessionMetricTargets(filteredContacts)
    if (visibleTargets.length > 0) {
      enqueueSessionMediaMetricRequests(visibleTargets, { front: true })
      scheduleSessionMediaMetricWorker()
    }

    if (sessionMediaMetricBackgroundFeedTimerRef.current) {
      window.clearTimeout(sessionMediaMetricBackgroundFeedTimerRef.current)
      sessionMediaMetricBackgroundFeedTimerRef.current = null
    }

    const visibleTargetSet = new Set(visibleTargets)
    let cursor = 0
    const feedNext = () => {
      if (runId !== sessionMediaMetricRunIdRef.current) return
      const batchIds: string[] = []
      while (cursor < filteredContacts.length && batchIds.length < SESSION_MEDIA_METRIC_BACKGROUND_FEED_SIZE) {
        const contact = filteredContacts[cursor]
        cursor += 1
        if (!contact?.username) continue
        if (visibleTargetSet.has(contact.username)) continue
        const mappedSession = sessionRowByUsername.get(contact.username)
        if (!mappedSession?.hasSession) continue
        batchIds.push(contact.username)
      }

      if (batchIds.length > 0) {
        enqueueSessionMediaMetricRequests(batchIds)
        scheduleSessionMediaMetricWorker()
      }

      if (cursor < filteredContacts.length) {
        sessionMediaMetricBackgroundFeedTimerRef.current = window.setTimeout(feedNext, SESSION_MEDIA_METRIC_BACKGROUND_FEED_INTERVAL_MS)
      }
    }

    feedNext()
    return () => {
      if (sessionMediaMetricBackgroundFeedTimerRef.current) {
        window.clearTimeout(sessionMediaMetricBackgroundFeedTimerRef.current)
        sessionMediaMetricBackgroundFeedTimerRef.current = null
      }
    }
  }, [
    activeTaskCount,
    collectVisibleSessionMetricTargets,
    enqueueSessionMediaMetricRequests,
    filteredContacts,
    scheduleSessionMediaMetricWorker,
    sessionRowByUsername
  ])

  useEffect(() => {
    if (activeTaskCount > 0) return
    const runId = sessionMediaMetricRunIdRef.current
    const allTargets = [
      ...(loadDetailTargetsByTab.private || []),
      ...(loadDetailTargetsByTab.group || []),
      ...(loadDetailTargetsByTab.former_friend || [])
    ]
    if (allTargets.length === 0) return

    let timer: number | null = null
    let cursor = 0
    const feedNext = () => {
      if (runId !== sessionMediaMetricRunIdRef.current) return
      const batchIds: string[] = []
      while (cursor < allTargets.length && batchIds.length < SESSION_MEDIA_METRIC_BACKGROUND_FEED_SIZE) {
        const sessionId = allTargets[cursor]
        cursor += 1
        if (!sessionId) continue
        batchIds.push(sessionId)
      }
      if (batchIds.length > 0) {
        enqueueSessionMediaMetricRequests(batchIds)
        scheduleSessionMediaMetricWorker()
      }
      if (cursor < allTargets.length) {
        timer = window.setTimeout(feedNext, SESSION_MEDIA_METRIC_BACKGROUND_FEED_INTERVAL_MS)
      }
    }

    feedNext()
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [
    activeTaskCount,
    enqueueSessionMediaMetricRequests,
    loadDetailTargetsByTab.former_friend,
    loadDetailTargetsByTab.group,
    loadDetailTargetsByTab.private,
    scheduleSessionMediaMetricWorker
  ])

  useEffect(() => {
    if (activeTaskCount > 0) return
    if (!isSessionCountStageReady || filteredContacts.length === 0) return
    const runId = sessionMutualFriendsRunIdRef.current
    const visibleTargets = collectVisibleSessionMutualFriendsTargets(filteredContacts)
    if (visibleTargets.length > 0) {
      enqueueSessionMutualFriendsRequests(visibleTargets, { front: true })
      scheduleSessionMutualFriendsWorker()
    }

    if (sessionMutualFriendsBackgroundFeedTimerRef.current) {
      window.clearTimeout(sessionMutualFriendsBackgroundFeedTimerRef.current)
      sessionMutualFriendsBackgroundFeedTimerRef.current = null
    }

    const visibleTargetSet = new Set(visibleTargets)
    let cursor = 0
    const feedNext = () => {
      if (runId !== sessionMutualFriendsRunIdRef.current) return
      const batchIds: string[] = []
      while (cursor < filteredContacts.length && batchIds.length < SESSION_MEDIA_METRIC_BACKGROUND_FEED_SIZE) {
        const contact = filteredContacts[cursor]
        cursor += 1
        if (!contact?.username || !isSingleContactSession(contact.username)) continue
        if (visibleTargetSet.has(contact.username)) continue
        const mappedSession = sessionRowByUsername.get(contact.username)
        if (!mappedSession?.hasSession) continue
        batchIds.push(contact.username)
      }

      if (batchIds.length > 0) {
        enqueueSessionMutualFriendsRequests(batchIds)
        scheduleSessionMutualFriendsWorker()
      }

      if (cursor < filteredContacts.length) {
        sessionMutualFriendsBackgroundFeedTimerRef.current = window.setTimeout(feedNext, SESSION_MEDIA_METRIC_BACKGROUND_FEED_INTERVAL_MS)
      }
    }

    feedNext()
    return () => {
      if (sessionMutualFriendsBackgroundFeedTimerRef.current) {
        window.clearTimeout(sessionMutualFriendsBackgroundFeedTimerRef.current)
        sessionMutualFriendsBackgroundFeedTimerRef.current = null
      }
    }
  }, [
    activeTaskCount,
    collectVisibleSessionMutualFriendsTargets,
    enqueueSessionMutualFriendsRequests,
    filteredContacts,
    isSessionCountStageReady,
    scheduleSessionMutualFriendsWorker,
    sessionRowByUsername
  ])

  useEffect(() => {
    return () => {
      snsUserPostCountsHydrationTokenRef.current += 1
      if (snsUserPostCountsBatchTimerRef.current) {
        window.clearTimeout(snsUserPostCountsBatchTimerRef.current)
        snsUserPostCountsBatchTimerRef.current = null
      }
      if (sessionMediaMetricBackgroundFeedTimerRef.current) {
        window.clearTimeout(sessionMediaMetricBackgroundFeedTimerRef.current)
        sessionMediaMetricBackgroundFeedTimerRef.current = null
      }
      if (sessionMediaMetricPersistTimerRef.current) {
        window.clearTimeout(sessionMediaMetricPersistTimerRef.current)
        sessionMediaMetricPersistTimerRef.current = null
      }
      if (sessionMutualFriendsBackgroundFeedTimerRef.current) {
        window.clearTimeout(sessionMutualFriendsBackgroundFeedTimerRef.current)
        sessionMutualFriendsBackgroundFeedTimerRef.current = null
      }
      if (sessionMutualFriendsPersistTimerRef.current) {
        window.clearTimeout(sessionMutualFriendsPersistTimerRef.current)
        sessionMutualFriendsPersistTimerRef.current = null
      }
      void flushSessionMediaMetricCache()
      void flushSessionMutualFriendsCache()
    }
  }, [flushSessionMediaMetricCache, flushSessionMutualFriendsCache])

  const contactByUsername = useMemo(() => {
    const map = new Map<string, ContactInfo>()
    for (const contact of contactsList) {
      map.set(contact.username, contact)
    }
    return map
  }, [contactsList])

  useEffect(() => {
    if (!showSessionDetailPanel) return
    const sessionId = String(sessionDetail?.wxid || '').trim()
    if (!sessionId) return

    const mappedSession = sessionRowByUsername.get(sessionId)
    const mappedContact = contactByUsername.get(sessionId)
    if (!mappedSession && !mappedContact) return

    setSessionDetail((prev) => {
      if (!prev || prev.wxid !== sessionId) return prev

      const nextDisplayName = mappedSession?.displayName || mappedContact?.displayName || prev.displayName || sessionId
      const nextRemark = mappedContact?.remark ?? prev.remark
      const nextNickName = mappedContact?.nickname ?? prev.nickName
      const nextAlias = mappedContact?.alias ?? prev.alias
      const nextAvatarUrl = mappedSession?.avatarUrl || mappedContact?.avatarUrl || prev.avatarUrl

      if (
        nextDisplayName === prev.displayName &&
        nextRemark === prev.remark &&
        nextNickName === prev.nickName &&
        nextAlias === prev.alias &&
        nextAvatarUrl === prev.avatarUrl
      ) {
        return prev
      }

      return {
        ...prev,
        displayName: nextDisplayName,
        remark: nextRemark,
        nickName: nextNickName,
        alias: nextAlias,
        avatarUrl: nextAvatarUrl
      }
    })
  }, [contactByUsername, sessionDetail?.wxid, sessionRowByUsername, showSessionDetailPanel])

  const currentSessionExportRecords = useMemo(() => {
    const sessionId = String(sessionDetail?.wxid || '').trim()
    if (!sessionId) return [] as configService.ExportSessionRecordEntry[]
    const records = Array.isArray(exportRecordsBySession[sessionId]) ? exportRecordsBySession[sessionId] : []
    return [...records]
      .sort((a, b) => Number(b.exportTime || 0) - Number(a.exportTime || 0))
      .slice(0, 20)
  }, [sessionDetail?.wxid, exportRecordsBySession])

  const sessionDetailSupportsSnsTimeline = useMemo(() => {
    const sessionId = String(sessionDetail?.wxid || '').trim()
    return isSingleContactSession(sessionId)
  }, [sessionDetail?.wxid])

  const sessionDetailSnsCountLabel = useMemo(() => {
    const sessionId = String(sessionDetail?.wxid || '').trim()
    if (!sessionId || !sessionDetailSupportsSnsTimeline) return '朋友圈：0条'

    if (snsUserPostCountsStatus === 'loading' || snsUserPostCountsStatus === 'idle') {
      return '朋友圈：统计中...'
    }
    if (snsUserPostCountsStatus === 'error') {
      return '朋友圈：统计失败'
    }

    const count = Number(snsUserPostCounts[sessionId] || 0)
    const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    return `朋友圈：${normalized}条`
  }, [sessionDetail?.wxid, sessionDetailSupportsSnsTimeline, snsUserPostCounts, snsUserPostCountsStatus])

  const sessionMutualFriendsDialogMetric = useMemo(() => {
    const sessionId = String(sessionMutualFriendsDialogTarget?.username || '').trim()
    if (!sessionId) return null
    return sessionMutualFriendsMetrics[sessionId] || null
  }, [sessionMutualFriendsDialogTarget, sessionMutualFriendsMetrics])

  const filteredSessionMutualFriendsDialogItems = useMemo(() => {
    const items = sessionMutualFriendsDialogMetric?.items || []
    const keyword = sessionMutualFriendsSearch.trim().toLowerCase()
    if (!keyword) return items
    return items.filter(item => item.name.toLowerCase().includes(keyword))
  }, [sessionMutualFriendsDialogMetric, sessionMutualFriendsSearch])

  const applySessionDetailStats = useCallback((
    sessionId: string,
    metric: SessionExportMetric,
    cacheMeta?: SessionExportCacheMeta,
    relationLoadedOverride?: boolean
  ) => {
    mergeSessionContentMetrics({ [sessionId]: metric })
    setSessionDetail((prev) => {
      if (!prev || prev.wxid !== sessionId) return prev
      const relationLoaded = relationLoadedOverride ?? Boolean(prev.relationStatsLoaded)
      return {
        ...prev,
        messageCount: Number.isFinite(metric.totalMessages) ? metric.totalMessages : prev.messageCount,
        voiceMessages: Number.isFinite(metric.voiceMessages) ? metric.voiceMessages : prev.voiceMessages,
        imageMessages: Number.isFinite(metric.imageMessages) ? metric.imageMessages : prev.imageMessages,
        videoMessages: Number.isFinite(metric.videoMessages) ? metric.videoMessages : prev.videoMessages,
        emojiMessages: Number.isFinite(metric.emojiMessages) ? metric.emojiMessages : prev.emojiMessages,
        transferMessages: Number.isFinite(metric.transferMessages) ? metric.transferMessages : prev.transferMessages,
        redPacketMessages: Number.isFinite(metric.redPacketMessages) ? metric.redPacketMessages : prev.redPacketMessages,
        callMessages: Number.isFinite(metric.callMessages) ? metric.callMessages : prev.callMessages,
        groupMemberCount: Number.isFinite(metric.groupMemberCount) ? metric.groupMemberCount : prev.groupMemberCount,
        groupMyMessages: Number.isFinite(metric.groupMyMessages) ? metric.groupMyMessages : prev.groupMyMessages,
        groupActiveSpeakers: Number.isFinite(metric.groupActiveSpeakers) ? metric.groupActiveSpeakers : prev.groupActiveSpeakers,
        privateMutualGroups: relationLoaded && Number.isFinite(metric.privateMutualGroups)
          ? metric.privateMutualGroups
          : prev.privateMutualGroups,
        groupMutualFriends: relationLoaded && Number.isFinite(metric.groupMutualFriends)
          ? metric.groupMutualFriends
          : prev.groupMutualFriends,
        relationStatsLoaded: relationLoaded,
        statsUpdatedAt: cacheMeta?.updatedAt ?? prev.statsUpdatedAt,
        statsStale: typeof cacheMeta?.stale === 'boolean' ? cacheMeta.stale : prev.statsStale,
        firstMessageTime: Number.isFinite(metric.firstTimestamp) ? metric.firstTimestamp : prev.firstMessageTime,
        latestMessageTime: Number.isFinite(metric.lastTimestamp) ? metric.lastTimestamp : prev.latestMessageTime
      }
    })
  }, [mergeSessionContentMetrics])

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return
    const preciseCacheKey = `${exportCacheScopeRef.current}::${normalizedSessionId}`

    detailStatsPriorityRef.current = true
    sessionCountRequestIdRef.current += 1
    setIsLoadingSessionCounts(false)

    const requestSeq = ++detailRequestSeqRef.current
    const mappedSession = sessionRowByUsername.get(normalizedSessionId)
    const mappedContact = contactByUsername.get(normalizedSessionId)
    const cachedMetric = sessionContentMetrics[normalizedSessionId]
    const countedCount = normalizeMessageCount(sessionMessageCounts[normalizedSessionId])
    const metricCount = normalizeMessageCount(cachedMetric?.totalMessages)
    const metricVoice = normalizeMessageCount(cachedMetric?.voiceMessages)
    const metricImage = normalizeMessageCount(cachedMetric?.imageMessages)
    const metricVideo = normalizeMessageCount(cachedMetric?.videoMessages)
    const metricEmoji = normalizeMessageCount(cachedMetric?.emojiMessages)
    const metricTransfer = normalizeMessageCount(cachedMetric?.transferMessages)
    const metricRedPacket = normalizeMessageCount(cachedMetric?.redPacketMessages)
    const metricCall = normalizeMessageCount(cachedMetric?.callMessages)
    const hintedCount = typeof mappedSession?.messageCountHint === 'number' && Number.isFinite(mappedSession.messageCountHint) && mappedSession.messageCountHint >= 0
      ? Math.floor(mappedSession.messageCountHint)
      : undefined
    const initialMessageCount = countedCount ?? metricCount ?? hintedCount

    setCopiedDetailField(null)
    setIsRefreshingSessionDetailStats(false)
    setIsLoadingSessionRelationStats(false)
    setSessionDetail((prev) => {
      const sameSession = prev?.wxid === normalizedSessionId
      return {
        wxid: normalizedSessionId,
        displayName: mappedSession?.displayName || mappedContact?.displayName || prev?.displayName || normalizedSessionId,
        remark: sameSession ? prev?.remark : mappedContact?.remark,
        nickName: sameSession ? prev?.nickName : mappedContact?.nickname,
        alias: sameSession ? prev?.alias : mappedContact?.alias,
        avatarUrl: mappedSession?.avatarUrl || mappedContact?.avatarUrl || (sameSession ? prev?.avatarUrl : undefined),
        messageCount: initialMessageCount ?? (sameSession ? prev.messageCount : Number.NaN),
        voiceMessages: metricVoice ?? (sameSession ? prev?.voiceMessages : undefined),
        imageMessages: metricImage ?? (sameSession ? prev?.imageMessages : undefined),
        videoMessages: metricVideo ?? (sameSession ? prev?.videoMessages : undefined),
        emojiMessages: metricEmoji ?? (sameSession ? prev?.emojiMessages : undefined),
        transferMessages: metricTransfer ?? (sameSession ? prev?.transferMessages : undefined),
        redPacketMessages: metricRedPacket ?? (sameSession ? prev?.redPacketMessages : undefined),
        callMessages: metricCall ?? (sameSession ? prev?.callMessages : undefined),
        privateMutualGroups: sameSession ? prev?.privateMutualGroups : undefined,
        groupMemberCount: sameSession ? prev?.groupMemberCount : undefined,
        groupMyMessages: sameSession ? prev?.groupMyMessages : undefined,
        groupActiveSpeakers: sameSession ? prev?.groupActiveSpeakers : undefined,
        groupMutualFriends: sameSession ? prev?.groupMutualFriends : undefined,
        relationStatsLoaded: sameSession ? prev?.relationStatsLoaded : false,
        statsUpdatedAt: sameSession ? prev?.statsUpdatedAt : undefined,
        statsStale: sameSession ? prev?.statsStale : undefined,
        firstMessageTime: sameSession ? prev?.firstMessageTime : undefined,
        latestMessageTime: sameSession ? prev?.latestMessageTime : undefined,
        messageTables: sameSession && Array.isArray(prev?.messageTables) ? prev.messageTables : []
      }
    })
    setIsLoadingSessionDetail(true)
    setIsLoadingSessionDetailExtra(true)

    try {
      const result = await window.electronAPI.chat.getSessionDetailFast(normalizedSessionId)
      if (requestSeq !== detailRequestSeqRef.current) return
      if (result.success && result.detail) {
        const fastMessageCount = normalizeMessageCount(result.detail.messageCount)
        if (typeof fastMessageCount === 'number') {
          setSessionMessageCounts((prev) => {
            if (prev[normalizedSessionId] === fastMessageCount) return prev
            return {
              ...prev,
              [normalizedSessionId]: fastMessageCount
            }
          })
          mergeSessionContentMetrics({
            [normalizedSessionId]: {
              totalMessages: fastMessageCount
            }
          })
        }
        setSessionDetail((prev) => ({
          wxid: normalizedSessionId,
          displayName: result.detail!.displayName || prev?.displayName || normalizedSessionId,
          remark: result.detail!.remark ?? prev?.remark,
          nickName: result.detail!.nickName ?? prev?.nickName,
          alias: result.detail!.alias ?? prev?.alias,
          avatarUrl: result.detail!.avatarUrl || prev?.avatarUrl,
          messageCount: Number.isFinite(result.detail!.messageCount) ? result.detail!.messageCount : prev?.messageCount ?? Number.NaN,
          voiceMessages: prev?.voiceMessages,
          imageMessages: prev?.imageMessages,
          videoMessages: prev?.videoMessages,
          emojiMessages: prev?.emojiMessages,
          transferMessages: prev?.transferMessages,
          redPacketMessages: prev?.redPacketMessages,
          callMessages: prev?.callMessages,
          privateMutualGroups: prev?.privateMutualGroups,
          groupMemberCount: prev?.groupMemberCount,
          groupMyMessages: prev?.groupMyMessages,
          groupActiveSpeakers: prev?.groupActiveSpeakers,
          groupMutualFriends: prev?.groupMutualFriends,
          relationStatsLoaded: prev?.relationStatsLoaded,
          statsUpdatedAt: prev?.statsUpdatedAt,
          statsStale: prev?.statsStale,
          firstMessageTime: prev?.firstMessageTime,
          latestMessageTime: prev?.latestMessageTime,
          messageTables: Array.isArray(prev?.messageTables) ? (prev?.messageTables || []) : []
        }))
      }
    } catch (error) {
      console.error('导出页加载会话详情失败:', error)
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingSessionDetail(false)
      }
    }

    try {
      const extraPromise = window.electronAPI.chat.getSessionDetailExtra(normalizedSessionId)
      void (async () => {
        try {
          const extraResult = await extraPromise
          if (requestSeq !== detailRequestSeqRef.current) return
          if (!extraResult.success || !extraResult.detail) return
          const detail = extraResult.detail
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              firstMessageTime: detail.firstMessageTime,
              latestMessageTime: detail.latestMessageTime,
              messageTables: Array.isArray(detail.messageTables) ? detail.messageTables : []
            }
          })
        } catch (error) {
          console.error('导出页加载会话详情补充信息失败:', error)
        } finally {
          if (requestSeq === detailRequestSeqRef.current) {
            setIsLoadingSessionDetailExtra(false)
          }
        }
      })()

      let quickMetric: SessionExportMetric | undefined
      let quickCacheMeta: SessionExportCacheMeta | undefined
      try {
        const quickStatsResult = await window.electronAPI.chat.getExportSessionStats(
          [normalizedSessionId],
          { includeRelations: false, allowStaleCache: true, cacheOnly: true }
        )
        if (requestSeq !== detailRequestSeqRef.current) return
        if (quickStatsResult.success) {
          quickMetric = quickStatsResult.data?.[normalizedSessionId] as SessionExportMetric | undefined
          quickCacheMeta = quickStatsResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
          if (quickMetric) {
            applySessionDetailStats(normalizedSessionId, quickMetric, quickCacheMeta, false)
          } else if (quickCacheMeta) {
            const cacheMeta = quickCacheMeta
            setSessionDetail((prev) => {
              if (!prev || prev.wxid !== normalizedSessionId) return prev
              return {
                ...prev,
                statsUpdatedAt: cacheMeta.updatedAt,
                statsStale: cacheMeta.stale
              }
            })
          }
        }
      } catch (error) {
        console.error('导出页读取会话统计缓存失败:', error)
      }

      try {
        const relationCacheResult = await window.electronAPI.chat.getExportSessionStats(
          [normalizedSessionId],
          { includeRelations: true, allowStaleCache: true, cacheOnly: true }
        )
        if (requestSeq !== detailRequestSeqRef.current) return
        if (relationCacheResult.success && relationCacheResult.data) {
          const relationMetric = relationCacheResult.data[normalizedSessionId] as SessionExportMetric | undefined
          const relationCacheMeta = relationCacheResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
          if (relationMetric) {
            applySessionDetailStats(normalizedSessionId, relationMetric, relationCacheMeta, true)
          }
        }
      } catch (error) {
        console.error('导出页读取会话关系缓存失败:', error)
      }

      const lastPreciseAt = sessionPreciseRefreshAtRef.current[preciseCacheKey] || 0
      const hasRecentPrecise = Date.now() - lastPreciseAt <= DETAIL_PRECISE_REFRESH_COOLDOWN_MS
      const shouldRunBackgroundRefresh = !hasRecentPrecise && (!quickMetric || Boolean(quickCacheMeta?.stale))

      if (shouldRunBackgroundRefresh) {
        setIsRefreshingSessionDetailStats(true)
        void (async () => {
          try {
            // 后台补齐非关系统计，不走精确特型扫描，避免阻塞列表统计队列。
            const freshResult = await window.electronAPI.chat.getExportSessionStats(
              [normalizedSessionId],
              { includeRelations: false, forceRefresh: true }
            )
            if (requestSeq !== detailRequestSeqRef.current) return
            if (freshResult.success && freshResult.data) {
              const metric = freshResult.data[normalizedSessionId] as SessionExportMetric | undefined
              const cacheMeta = freshResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
              if (metric) {
                applySessionDetailStats(normalizedSessionId, metric, cacheMeta, false)
                sessionPreciseRefreshAtRef.current[preciseCacheKey] = Date.now()
              } else if (cacheMeta) {
                setSessionDetail((prev) => {
                  if (!prev || prev.wxid !== normalizedSessionId) return prev
                  return {
                    ...prev,
                    statsUpdatedAt: cacheMeta.updatedAt,
                    statsStale: cacheMeta.stale
                  }
                })
              }
            }
          } catch (error) {
            console.error('导出页刷新会话统计失败:', error)
          } finally {
            if (requestSeq === detailRequestSeqRef.current) {
              setIsRefreshingSessionDetailStats(false)
            }
          }
        })()
      }
    } catch (error) {
      console.error('导出页加载会话详情补充统计失败:', error)
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingSessionDetailExtra(false)
      }
    }
  }, [applySessionDetailStats, contactByUsername, mergeSessionContentMetrics, sessionContentMetrics, sessionMessageCounts, sessionRowByUsername])

  const loadSessionRelationStats = useCallback(async (options?: { forceRefresh?: boolean }) => {
    const normalizedSessionId = String(sessionDetail?.wxid || '').trim()
    if (!normalizedSessionId || isLoadingSessionRelationStats) return

    const requestSeq = detailRequestSeqRef.current
    const forceRefresh = options?.forceRefresh === true
    setIsLoadingSessionRelationStats(true)
    try {
      if (!forceRefresh) {
        const relationCacheResult = await window.electronAPI.chat.getExportSessionStats(
          [normalizedSessionId],
          { includeRelations: true, allowStaleCache: true, cacheOnly: true }
        )
        if (requestSeq !== detailRequestSeqRef.current) return

        const relationMetric = relationCacheResult.success && relationCacheResult.data
          ? relationCacheResult.data[normalizedSessionId] as SessionExportMetric | undefined
          : undefined
        const relationCacheMeta = relationCacheResult.success
          ? relationCacheResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
          : undefined
        if (relationMetric) {
          applySessionDetailStats(normalizedSessionId, relationMetric, relationCacheMeta, true)
          return
        }
      }

      const relationResult = await window.electronAPI.chat.getExportSessionStats(
        [normalizedSessionId],
        { includeRelations: true, forceRefresh, preferAccurateSpecialTypes: true }
      )
      if (requestSeq !== detailRequestSeqRef.current) return

      const metric = relationResult.success && relationResult.data
        ? relationResult.data[normalizedSessionId] as SessionExportMetric | undefined
        : undefined
      const cacheMeta = relationResult.success
        ? relationResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
        : undefined
      if (metric) {
        applySessionDetailStats(normalizedSessionId, metric, cacheMeta, true)
      }
    } catch (error) {
      console.error('导出页加载会话关系统计失败:', error)
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingSessionRelationStats(false)
      }
    }
  }, [applySessionDetailStats, isLoadingSessionRelationStats, sessionDetail?.wxid])

  const handleRefreshTableData = useCallback(async () => {
    const scopeKey = await ensureExportCacheScope()

    resetSessionMutualFriendsLoader()
    sessionMutualFriendsMetricsRef.current = {}
    setSessionMutualFriendsMetrics({})
    closeSessionMutualFriendsDialog()
    try {
      await configService.clearExportSessionMutualFriendsCache(scopeKey)
    } catch (error) {
      console.error('清理导出页共同好友缓存失败:', error)
    }

    if (isSessionCountStageReady) {
      const visibleTargetIds = collectVisibleSessionMutualFriendsTargets(filteredContacts)
      const visibleTargetSet = new Set(visibleTargetIds)
      const remainingTargetIds = sessionsRef.current
        .filter((session) => session.hasSession && isSingleContactSession(session.username) && !visibleTargetSet.has(session.username))
        .map((session) => session.username)

      if (visibleTargetIds.length > 0) {
        enqueueSessionMutualFriendsRequests(visibleTargetIds, { front: true })
      }
      if (remainingTargetIds.length > 0) {
        enqueueSessionMutualFriendsRequests(remainingTargetIds)
      }
      scheduleSessionMutualFriendsWorker()
    }

    await Promise.all([
      loadContactsList({ scopeKey }),
      loadSnsStats({ full: true }),
      loadSnsUserPostCounts({ force: true })
    ])

    const currentDetailSessionId = showSessionDetailPanel
      ? String(sessionDetail?.wxid || '').trim()
      : ''
    if (currentDetailSessionId) {
      await loadSessionDetail(currentDetailSessionId)
      void loadSessionRelationStats({ forceRefresh: true })
    }
  }, [
    closeSessionMutualFriendsDialog,
    collectVisibleSessionMutualFriendsTargets,
    enqueueSessionMutualFriendsRequests,
    ensureExportCacheScope,
    filteredContacts,
    isSessionCountStageReady,
    loadContactsList,
    loadSessionDetail,
    loadSessionRelationStats,
    loadSnsStats,
    loadSnsUserPostCounts,
    resetSessionMutualFriendsLoader,
    scheduleSessionMutualFriendsWorker,
    showSessionDetailPanel,
    sessionDetail?.wxid
  ])

  useEffect(() => {
    if (!showSessionDetailPanel || !sessionDetailSupportsSnsTimeline) return
    if (snsUserPostCountsStatus === 'idle') {
      void loadSnsUserPostCounts()
    }
  }, [
    loadSnsUserPostCounts,
    sessionDetailSupportsSnsTimeline,
    showSessionDetailPanel,
    snsUserPostCountsStatus
  ])

  useEffect(() => {
    if (!isExportRoute || !isSessionCountStageReady) return
    if (snsUserPostCountsStatus !== 'idle') return
    const timer = window.setTimeout(() => {
      void loadSnsUserPostCounts()
    }, 260)
    return () => window.clearTimeout(timer)
  }, [isExportRoute, isSessionCountStageReady, loadSnsUserPostCounts, snsUserPostCountsStatus])

  useEffect(() => {
    if (!sessionSnsTimelineTarget) return
    if (Object.prototype.hasOwnProperty.call(snsUserPostCounts, sessionSnsTimelineTarget.username)) {
      const total = Number(snsUserPostCounts[sessionSnsTimelineTarget.username] || 0)
      const normalizedTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
      setSessionSnsTimelineTotalPosts(normalizedTotal)
      setSessionSnsRankTotalPosts(normalizedTotal)
      setSessionSnsTimelineStatsLoading(false)
      return
    }
    if (snsUserPostCountsStatus === 'loading' || snsUserPostCountsStatus === 'idle') {
      setSessionSnsTimelineStatsLoading(true)
      return
    }
    setSessionSnsTimelineTotalPosts(null)
    setSessionSnsRankTotalPosts(null)
    setSessionSnsTimelineStatsLoading(false)
  }, [sessionSnsTimelineTarget, snsUserPostCounts, snsUserPostCountsStatus])

  useEffect(() => {
    if (sessionSnsTimelineTotalPosts === null) return
    if (sessionSnsTimelinePosts.length >= sessionSnsTimelineTotalPosts) {
      setSessionSnsTimelineHasMore(false)
    }
  }, [sessionSnsTimelinePosts.length, sessionSnsTimelineTotalPosts])

  useEffect(() => {
    if (!sessionSnsRankMode || !sessionSnsTimelineTarget) return
    void loadSessionSnsRankings(sessionSnsTimelineTarget)
  }, [loadSessionSnsRankings, sessionSnsRankMode, sessionSnsTimelineTarget])

  const closeSessionDetailPanel = useCallback(() => {
    detailRequestSeqRef.current += 1
    detailStatsPriorityRef.current = false
    sessionSnsTimelineRequestTokenRef.current += 1
    sessionSnsTimelineLoadingRef.current = false
    sessionSnsRankRequestTokenRef.current += 1
    sessionSnsRankLoadingRef.current = false
    setShowSessionDetailPanel(false)
    setIsLoadingSessionDetail(false)
    setIsLoadingSessionDetailExtra(false)
    setIsRefreshingSessionDetailStats(false)
    setIsLoadingSessionRelationStats(false)
    setSessionSnsRankMode(null)
    setSessionSnsLikeRankings([])
    setSessionSnsCommentRankings([])
    setSessionSnsRankLoading(false)
    setSessionSnsRankError(null)
    setSessionSnsRankLoadedPosts(0)
    setSessionSnsRankTotalPosts(null)
    setSessionSnsTimelineTarget(null)
    setSessionSnsTimelinePosts([])
    setSessionSnsTimelineLoading(false)
    setSessionSnsTimelineLoadingMore(false)
    setSessionSnsTimelineHasMore(false)
    setSessionSnsTimelineTotalPosts(null)
    setSessionSnsTimelineStatsLoading(false)
  }, [])

  const openSessionDetail = useCallback((sessionId: string) => {
    if (!sessionId) return
    detailStatsPriorityRef.current = true
    setShowSessionDetailPanel(true)
    if (isSingleContactSession(sessionId)) {
      void loadSnsUserPostCounts()
    }
    void loadSessionDetail(sessionId)
  }, [loadSessionDetail, loadSnsUserPostCounts])

  useEffect(() => {
    if (!showSessionDetailPanel) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSessionDetailPanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSessionDetailPanel, showSessionDetailPanel])

  useEffect(() => {
    if (!showSessionLoadDetailModal) return
    if (snsUserPostCountsStatus === 'idle') {
      void loadSnsUserPostCounts()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSessionLoadDetailModal(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [loadSnsUserPostCounts, showSessionLoadDetailModal, snsUserPostCountsStatus])

  useEffect(() => {
    if (!sessionSnsTimelineTarget) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSessionSnsTimeline()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSessionSnsTimeline, sessionSnsTimelineTarget])

  useEffect(() => {
    if (!sessionMutualFriendsDialogTarget) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSessionMutualFriendsDialog()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSessionMutualFriendsDialog, sessionMutualFriendsDialogTarget])

  useEffect(() => {
    if (!showSessionFormatSelect) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (sessionFormatDropdownRef.current && !sessionFormatDropdownRef.current.contains(target)) {
        setShowSessionFormatSelect(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [showSessionFormatSelect])

  useEffect(() => {
    if (!exportDialog.open) {
      setShowSessionFormatSelect(false)
    }
  }, [exportDialog.open])

  const handleCopyDetailField = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedDetailField(field)
      setTimeout(() => setCopiedDetailField(null), 1500)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopiedDetailField(field)
      setTimeout(() => setCopiedDetailField(null), 1500)
    }
  }, [])

  const contactsIssueElapsedMs = useMemo(() => {
    if (!contactsLoadIssue) return 0
    if (isContactsListLoading && contactsLoadSession) {
      return Math.max(contactsLoadIssue.elapsedMs, contactsDiagnosticTick - contactsLoadSession.startedAt)
    }
    return contactsLoadIssue.elapsedMs
  }, [contactsDiagnosticTick, isContactsListLoading, contactsLoadIssue, contactsLoadSession])

  const contactsDiagnosticsText = useMemo(() => {
    if (!contactsLoadIssue || !contactsLoadSession) return ''
    return [
      `请求ID: ${contactsLoadSession.requestId}`,
      `请求序号: 第 ${contactsLoadSession.attempt} 次`,
      `阈值配置: ${contactsLoadSession.timeoutMs}ms`,
      `当前状态: ${contactsLoadIssue.kind === 'timeout' ? '超时等待中' : '请求失败'}`,
      `累计耗时: ${(contactsIssueElapsedMs / 1000).toFixed(1)}s`,
      `发生时间: ${new Date(contactsLoadIssue.occurredAt).toLocaleString()}`,
      '阶段: chat.getContacts',
      `原因: ${contactsLoadIssue.reason}`,
      `错误详情: ${contactsLoadIssue.errorDetail || '无'}`
    ].join('\n')
  }, [contactsIssueElapsedMs, contactsLoadIssue, contactsLoadSession])

  const copyContactsDiagnostics = useCallback(async () => {
    if (!contactsDiagnosticsText) return
    try {
      await navigator.clipboard.writeText(contactsDiagnosticsText)
      alert('诊断信息已复制')
    } catch (error) {
      console.error('复制诊断信息失败:', error)
      alert('复制失败，请手动复制诊断信息')
    }
  }, [contactsDiagnosticsText])
  const handleCancelBackgroundTask = useCallback((taskId: string) => {
    requestCancelBackgroundTask(taskId)
  }, [])
  const handleCancelAllNonExportTasks = useCallback(() => {
    requestCancelBackgroundTasks(task => (
      task.sourcePage !== 'export' &&
      task.cancelable &&
      (task.status === 'running' || task.status === 'cancel_requested')
    ))
  }, [])

  const sessionContactsUpdatedAtLabel = useMemo(() => {
    if (!sessionContactsUpdatedAt) return ''
    return new Date(sessionContactsUpdatedAt).toLocaleString()
  }, [sessionContactsUpdatedAt])

  const sessionAvatarUpdatedAtLabel = useMemo(() => {
    if (!sessionAvatarUpdatedAt) return ''
    return new Date(sessionAvatarUpdatedAt).toLocaleString()
  }, [sessionAvatarUpdatedAt])

  const sessionAvatarCachedCount = useMemo(() => {
    return sessions.reduce((count, session) => (session.avatarUrl ? count + 1 : count), 0)
  }, [sessions])

  const visibleSelectableCount = useMemo(() => (
    filteredContacts.reduce((count, contact) => (
      sessionRowByUsername.get(contact.username)?.hasSession ? count + 1 : count
    ), 0)
  ), [filteredContacts, sessionRowByUsername])
  const isAllVisibleSelected = visibleSelectableCount > 0 && selectedCount === visibleSelectableCount

  const canCreateTask = exportDialog.scope === 'sns'
    ? Boolean(exportFolder)
    : Boolean(exportFolder) && exportDialog.sessionIds.length > 0
  const scopeLabel = exportDialog.scope === 'single'
    ? '单会话'
    : exportDialog.scope === 'multi'
      ? '多会话'
      : exportDialog.scope === 'sns'
        ? '朋友圈批量'
        : `按内容批量（${contentTypeLabels[exportDialog.contentType || 'text']}）`
  const scopeCountLabel = exportDialog.scope === 'sns'
    ? `共 ${snsStats.totalPosts} 条朋友圈动态`
    : `共 ${exportDialog.sessionIds.length} 个会话`
  const snsFormatOptions: Array<{ value: SnsTimelineExportFormat; label: string; desc: string }> = [
    { value: 'html', label: 'HTML', desc: '网页格式，可直接浏览' },
    { value: 'json', label: 'JSON', desc: '原始结构化格式（兼容旧导入）' },
    { value: 'arkmejson', label: 'ArkmeJSON', desc: '增强结构化格式，包含互动身份字段' }
  ]
  const formatCandidateOptions = exportDialog.scope === 'sns'
    ? snsFormatOptions
    : formatOptions
  const isSessionScopeDialog = exportDialog.scope === 'single' || exportDialog.scope === 'multi'
  const isContentScopeDialog = exportDialog.scope === 'content'
  const isContentTextDialog = isContentScopeDialog && exportDialog.contentType === 'text'
  const useCollapsedSessionFormatSelector = isSessionScopeDialog || isContentTextDialog
  const shouldShowFormatSection = !isContentScopeDialog || isContentTextDialog
  const shouldShowMediaSection = !isContentScopeDialog
  const shouldShowImageDeepSearchToggle = exportDialog.scope !== 'sns' && (
    (isSessionScopeDialog && options.exportImages) ||
    (isContentScopeDialog && exportDialog.contentType === 'image')
  )
  const avatarExportStatusLabel = options.exportAvatars ? '已开启聊天消息导出带头像' : '已关闭聊天消息导出带头像'
  const contentTextDialogSummary = '此模式只导出聊天文本，不包含图片语音视频表情包等多媒体文件。'
  const activeDialogFormatLabel = exportDialog.scope === 'sns'
    ? (snsFormatOptions.find(option => option.value === snsExportFormat)?.label ?? snsExportFormat)
    : (formatOptions.find(option => option.value === options.format)?.label ?? options.format)
  const shouldShowDisplayNameSection = !(
    exportDialog.scope === 'sns' ||
    (
      exportDialog.scope === 'content' &&
      (
        exportDialog.contentType === 'voice' ||
        exportDialog.contentType === 'image' ||
        exportDialog.contentType === 'video' ||
        exportDialog.contentType === 'emoji'
      )
    )
  )
  const isTabCountComputing = isSharedTabCountsLoading && !isSharedTabCountsReady
  const isSnsCardStatsLoading = !hasSeededSnsStats
  const taskRunningCount = tasks.filter(task => task.status === 'running').length
  const taskQueuedCount = tasks.filter(task => task.status === 'queued').length
  const taskCenterAlertCount = taskRunningCount + taskQueuedCount
  const hasFilteredContacts = filteredContacts.length > 0
  const contactsTableMinWidth = useMemo(() => {
    const baseWidth = 24 + 34 + 44 + 280 + 120 + (4 * 72) + 140 + (8 * 12)
    const snsWidth = shouldShowSnsColumn ? 72 + 12 : 0
    const mutualFriendsWidth = shouldShowMutualFriendsColumn ? 72 + 12 : 0
    return baseWidth + snsWidth + mutualFriendsWidth
  }, [shouldShowMutualFriendsColumn, shouldShowSnsColumn])
  const contactsTableStyle = useMemo(() => (
    {
      ['--contacts-table-min-width' as const]: `${contactsTableMinWidth}px`
    } as CSSProperties
  ), [contactsTableMinWidth])
  const hasContactsHorizontalOverflow = contactsHorizontalScrollMetrics.contentWidth - contactsHorizontalScrollMetrics.viewportWidth > 1
  const contactsBottomScrollbarInnerStyle = useMemo<CSSProperties>(() => ({
    width: `${Math.max(contactsHorizontalScrollMetrics.contentWidth, contactsHorizontalScrollMetrics.viewportWidth)}px`
  }), [contactsHorizontalScrollMetrics.contentWidth, contactsHorizontalScrollMetrics.viewportWidth])
  const nonExportBackgroundTasks = useMemo(() => (
    backgroundTasks.filter(task => task.sourcePage !== 'export')
  ), [backgroundTasks])
  const runningNonExportTaskCount = useMemo(() => (
    nonExportBackgroundTasks.filter(task => task.status === 'running' || task.status === 'cancel_requested').length
  ), [nonExportBackgroundTasks])
  const cancelableNonExportTaskCount = useMemo(() => (
    nonExportBackgroundTasks.filter(task => (
      task.cancelable &&
      (task.status === 'running' || task.status === 'cancel_requested')
    )).length
  ), [nonExportBackgroundTasks])
  const nonExportBackgroundTasksUpdatedAt = useMemo(() => (
    nonExportBackgroundTasks.reduce((latest, task) => Math.max(latest, task.updatedAt || 0), 0)
  ), [nonExportBackgroundTasks])
  const sessionLoadDetailUpdatedAt = useMemo(() => {
    let latest = 0
    for (const row of sessionLoadDetailRows) {
      const candidateTimes = [
        row.messageCount.finishedAt || row.messageCount.startedAt || 0,
        row.mediaMetrics.finishedAt || row.mediaMetrics.startedAt || 0,
        row.snsPostCounts.finishedAt || row.snsPostCounts.startedAt || 0,
        row.mutualFriends.finishedAt || row.mutualFriends.startedAt || 0
      ]
      for (const candidate of candidateTimes) {
        if (candidate > latest) {
          latest = candidate
        }
      }
    }
    return latest
  }, [sessionLoadDetailRows])
  const isSessionLoadDetailActive = useMemo(() => (
    sessionLoadDetailRows.some(row => (
      row.messageCount.statusLabel.startsWith('加载中') ||
      row.mediaMetrics.statusLabel.startsWith('加载中') ||
      row.snsPostCounts.statusLabel.startsWith('加载中') ||
      row.mutualFriends.statusLabel.startsWith('加载中')
    ))
  ), [sessionLoadDetailRows])
  const syncContactsHorizontalScroll = useCallback((source: 'viewport' | 'bottom', scrollLeft: number) => {
    if (contactsScrollSyncSourceRef.current && contactsScrollSyncSourceRef.current !== source) return

    contactsScrollSyncSourceRef.current = source
    const viewport = contactsHorizontalViewportRef.current
    const bottomScrollbar = contactsBottomScrollbarRef.current

    if (source !== 'viewport' && viewport && Math.abs(viewport.scrollLeft - scrollLeft) > 1) {
      viewport.scrollLeft = scrollLeft
    }

    if (source !== 'bottom' && bottomScrollbar && Math.abs(bottomScrollbar.scrollLeft - scrollLeft) > 1) {
      bottomScrollbar.scrollLeft = scrollLeft
    }

    window.requestAnimationFrame(() => {
      if (contactsScrollSyncSourceRef.current === source) {
        contactsScrollSyncSourceRef.current = null
      }
    })
  }, [])
  const handleContactsHorizontalViewportScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    syncContactsHorizontalScroll('viewport', event.currentTarget.scrollLeft)
  }, [syncContactsHorizontalScroll])
  const handleContactsBottomScrollbarScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    syncContactsHorizontalScroll('bottom', event.currentTarget.scrollLeft)
  }, [syncContactsHorizontalScroll])
  const resetContactsHeaderDrag = useCallback((currentTarget?: HTMLDivElement | null) => {
    const dragState = contactsHeaderDragStateRef.current
    if (currentTarget && dragState.pointerId >= 0 && currentTarget.hasPointerCapture(dragState.pointerId)) {
      currentTarget.releasePointerCapture(dragState.pointerId)
    }
    dragState.pointerId = -1
    dragState.startClientX = 0
    dragState.startScrollLeft = 0
    dragState.didDrag = false
    setIsContactsHeaderDragging(false)
  }, [])
  const handleContactsHeaderPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!hasContactsHorizontalOverflow || event.pointerType === 'touch') return
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, label, [role="button"]')) {
      return
    }

    contactsHeaderDragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startScrollLeft: contactsHorizontalViewportRef.current?.scrollLeft ?? 0,
      didDrag: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsContactsHeaderDragging(true)
  }, [hasContactsHorizontalOverflow])
  const handleContactsHeaderPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const dragState = contactsHeaderDragStateRef.current
    if (dragState.pointerId !== event.pointerId) return

    const viewport = contactsHorizontalViewportRef.current
    const content = contactsHorizontalContentRef.current
    if (!viewport || !content) return

    const deltaX = event.clientX - dragState.startClientX
    if (!dragState.didDrag && Math.abs(deltaX) < 4) return

    dragState.didDrag = true
    const maxScrollLeft = Math.max(0, content.scrollWidth - viewport.clientWidth)
    const nextScrollLeft = Math.max(0, Math.min(dragState.startScrollLeft - deltaX, maxScrollLeft))

    viewport.scrollLeft = nextScrollLeft
    syncContactsHorizontalScroll('viewport', nextScrollLeft)
    event.preventDefault()
  }, [syncContactsHorizontalScroll])
  const handleContactsHeaderPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (contactsHeaderDragStateRef.current.pointerId !== event.pointerId) return
    resetContactsHeaderDrag(event.currentTarget)
  }, [resetContactsHeaderDrag])
  const handleContactsHeaderPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (contactsHeaderDragStateRef.current.pointerId !== event.pointerId) return
    resetContactsHeaderDrag(event.currentTarget)
  }, [resetContactsHeaderDrag])
  useEffect(() => {
    const viewport = contactsHorizontalViewportRef.current
    const content = contactsHorizontalContentRef.current
    if (!viewport || !content) return

    const syncMetrics = () => {
      const viewportWidth = Math.round(viewport.clientWidth)
      const contentWidth = Math.round(content.scrollWidth)

      setContactsHorizontalScrollMetrics((prev) => (
        prev.viewportWidth === viewportWidth && prev.contentWidth === contentWidth
          ? prev
          : { viewportWidth, contentWidth }
      ))

      const maxScrollLeft = Math.max(0, contentWidth - viewportWidth)
      const clampedScrollLeft = Math.min(viewport.scrollLeft, maxScrollLeft)

      if (Math.abs(viewport.scrollLeft - clampedScrollLeft) > 1) {
        viewport.scrollLeft = clampedScrollLeft
      }

      const bottomScrollbar = contactsBottomScrollbarRef.current
      if (bottomScrollbar) {
        const nextScrollLeft = Math.min(bottomScrollbar.scrollLeft, maxScrollLeft)
        if (Math.abs(bottomScrollbar.scrollLeft - nextScrollLeft) > 1) {
          bottomScrollbar.scrollLeft = nextScrollLeft
        }
        if (Math.abs(nextScrollLeft - clampedScrollLeft) > 1) {
          bottomScrollbar.scrollLeft = clampedScrollLeft
        }
      }
    }

    syncMetrics()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncMetrics)
      return () => window.removeEventListener('resize', syncMetrics)
    }

    const resizeObserver = new ResizeObserver(syncMetrics)
    resizeObserver.observe(viewport)
    resizeObserver.observe(content)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])
  const closeTaskCenter = useCallback(() => {
    setIsTaskCenterOpen(false)
    setExpandedPerfTaskId(null)
  }, [])
  const toggleTaskPerfDetail = useCallback((taskId: string) => {
    setExpandedPerfTaskId(prev => (prev === taskId ? null : taskId))
  }, [])
  const renderContactRow = useCallback((_: number, contact: ContactInfo) => {
    const matchedSession = sessionRowByUsername.get(contact.username)
    const canExport = Boolean(matchedSession?.hasSession)
    const isSessionBindingPending = !matchedSession && (isLoading || isSessionEnriching)
    const checked = canExport && selectedSessions.has(contact.username)
    const isRunning = canExport && runningSessionIds.has(contact.username)
    const isQueued = canExport && queuedSessionIds.has(contact.username)
    const recentExportTimestamp = lastExportBySession[contact.username]
    const hasRecentExport = canExport && Boolean(recentExportTimestamp)
    const recentExportTime = hasRecentExport ? formatRecentExportTime(recentExportTimestamp, nowTick) : ''
    const countedMessages = normalizeMessageCount(sessionMessageCounts[contact.username])
    const hintedMessages = normalizeMessageCount(matchedSession?.messageCountHint)
    const displayedMessageCount = countedMessages ?? hintedMessages
    const mediaMetric = sessionContentMetrics[contact.username]
    const messageCountState: { state: 'value'; text: string } | { state: 'loading' } | { state: 'na'; text: '--' } =
      !canExport
        ? (isSessionBindingPending ? { state: 'loading' } : { state: 'na', text: '--' })
        : typeof displayedMessageCount === 'number'
          ? { state: 'value', text: displayedMessageCount.toLocaleString('zh-CN') }
          : { state: 'loading' }
    const metricToDisplay = (value: unknown): { state: 'value'; text: string } | { state: 'loading' } | { state: 'na'; text: '--' } => {
      const normalized = normalizeMessageCount(value)
      if (!canExport) {
        return isSessionBindingPending ? { state: 'loading' } : { state: 'na', text: '--' }
      }
      if (typeof normalized === 'number') {
        return { state: 'value', text: normalized.toLocaleString('zh-CN') }
      }
      return { state: 'loading' }
    }
    const emojiMetric = metricToDisplay(mediaMetric?.emojiMessages)
    const voiceMetric = metricToDisplay(mediaMetric?.voiceMessages)
    const imageMetric = metricToDisplay(mediaMetric?.imageMessages)
    const videoMetric = metricToDisplay(mediaMetric?.videoMessages)
    const supportsSnsTimeline = isSingleContactSession(contact.username)
    const hasSnsCount = Object.prototype.hasOwnProperty.call(snsUserPostCounts, contact.username)
    const snsStageStatus = sessionLoadTraceMap[contact.username]?.snsPostCounts?.status
    const isSnsCountLoading = (
      supportsSnsTimeline &&
      !hasSnsCount &&
      (
        snsStageStatus === 'pending' ||
        snsStageStatus === 'loading' ||
        snsUserPostCountsStatus === 'loading' ||
        snsUserPostCountsStatus === 'idle'
      )
    )
    const snsRawCount = Number(snsUserPostCounts[contact.username] || 0)
    const snsCount = Number.isFinite(snsRawCount) ? Math.max(0, Math.floor(snsRawCount)) : 0
    const mutualFriendsMetric = sessionMutualFriendsMetrics[contact.username]
    const hasMutualFriendsMetric = Boolean(mutualFriendsMetric)
    const mutualFriendsStageStatus = sessionLoadTraceMap[contact.username]?.mutualFriends?.status
    const isMutualFriendsLoading = (
      supportsSnsTimeline &&
      canExport &&
      !hasMutualFriendsMetric &&
      (
        mutualFriendsStageStatus === 'pending' ||
        mutualFriendsStageStatus === 'loading'
      )
    )
    const openChatLabel = contact.type === 'friend'
      ? '打开私聊'
      : contact.type === 'group'
        ? '打开群聊'
        : '打开对话'
    return (
      <div className={`contact-row ${checked ? 'selected' : ''}`}>
        <div className="contact-item">
          <div className="row-left-sticky">
            <div className="row-select-cell">
              <button
                className={`select-icon-btn ${checked ? 'checked' : ''}`}
                type="button"
                disabled={!canExport}
                onClick={() => toggleSelectSession(contact.username)}
                title={canExport ? (checked ? '取消选择' : '选择会话') : '该联系人暂无会话记录'}
              >
                {checked ? <CheckSquare size={16} /> : <Square size={16} />}
              </button>
            </div>
            <div className="contact-avatar">
              <Avatar
                src={normalizeExportAvatarUrl(contact.avatarUrl)}
                name={contact.displayName}
                size="100%"
                shape="rounded"
              />
            </div>
            <div className="contact-info">
              <div className="contact-name">{contact.displayName}</div>
              <div className="contact-remark">{contact.alias || contact.username}</div>
            </div>
          </div>
          <div className="row-message-count">
            <div className="row-message-stats">
              <strong className={`row-message-count-value ${messageCountState.state === 'value' ? '' : 'muted'}`}>
                {messageCountState.state === 'loading'
                  ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="统计加载中" />
                  : messageCountState.text}
              </strong>
            </div>
            {canExport && (
              <button
                type="button"
                className="row-open-chat-link"
                title="切换到聊天页查看该会话"
                onClick={() => {
                  setCurrentSession(contact.username)
                  navigate('/chat')
                }}
              >
                {openChatLabel}
              </button>
            )}
          </div>
          <div className="row-media-metric">
            <strong className="row-media-metric-value">
              {emojiMetric.state === 'loading'
                ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="统计加载中" />
                : emojiMetric.text}
            </strong>
          </div>
          <div className="row-media-metric">
            <strong className="row-media-metric-value">
              {voiceMetric.state === 'loading'
                ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="统计加载中" />
                : voiceMetric.text}
            </strong>
          </div>
          <div className="row-media-metric">
            <strong className="row-media-metric-value">
              {imageMetric.state === 'loading'
                ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="统计加载中" />
                : imageMetric.text}
            </strong>
          </div>
          <div className="row-media-metric">
            <strong className="row-media-metric-value">
              {videoMetric.state === 'loading'
                ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="统计加载中" />
                : videoMetric.text}
            </strong>
          </div>
          {shouldShowSnsColumn && (
            <div className="row-media-metric">
              {supportsSnsTimeline ? (
                <button
                  type="button"
                  className={`row-sns-metric-btn ${isSnsCountLoading ? 'loading' : ''}`}
                  title={`查看 ${contact.displayName || contact.username} 的朋友圈`}
                  onClick={() => openContactSnsTimeline(contact)}
                >
                  {isSnsCountLoading
                    ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="朋友圈统计加载中" />
                    : hasSnsCount
                      ? `${snsCount.toLocaleString('zh-CN')} 条`
                      : '--'}
                </button>
              ) : (
                <strong className="row-media-metric-value">--</strong>
              )}
            </div>
          )}
          {shouldShowMutualFriendsColumn && (
            <div className="row-media-metric">
              {supportsSnsTimeline ? (
                <button
                  type="button"
                  className={`row-sns-metric-btn row-mutual-friends-btn ${isMutualFriendsLoading ? 'loading' : ''} ${hasMutualFriendsMetric ? 'ready' : ''}`}
                  title={`查看 ${contact.displayName || contact.username} 的共同好友`}
                  onClick={() => openSessionMutualFriendsDialog(contact)}
                  disabled={!hasMutualFriendsMetric}
                >
                  {isMutualFriendsLoading
                    ? <Loader2 size={12} className="spin row-media-metric-icon" aria-label="共同好友统计加载中" />
                    : hasMutualFriendsMetric
                      ? mutualFriendsMetric.count.toLocaleString('zh-CN')
                      : '--'}
                </button>
              ) : (
                <strong className="row-media-metric-value">--</strong>
              )}
            </div>
          )}
          <div className="row-action-cell">
            <div className={`row-action-main ${hasRecentExport ? '' : 'single-line'}`.trim()}>
              <div className={`row-export-action-stack ${hasRecentExport ? '' : 'single-line'}`.trim()}>
                <button
                  type="button"
                  className={`row-export-link ${isRunning ? 'state-running' : ''} ${!canExport ? 'state-disabled' : ''}`}
                  disabled={!canExport || isRunning}
                  onClick={() => {
                    if (!matchedSession || !matchedSession.hasSession) return
                    openSingleExport({
                      ...matchedSession,
                      displayName: contact.displayName || matchedSession.displayName || matchedSession.username
                    })
                  }}
                >
                  {!canExport ? '暂无会话' : isRunning ? '导出中...' : isQueued ? '排队中' : '导出'}
                </button>
                {hasRecentExport && <span className="row-export-time">{recentExportTime}</span>}
              </div>
              <button
                className={`row-detail-btn ${showSessionDetailPanel && sessionDetail?.wxid === contact.username ? 'active' : ''}`}
                onClick={() => openSessionDetail(contact.username)}
              >
                详情
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }, [
    lastExportBySession,
    navigate,
    nowTick,
    openContactSnsTimeline,
    openSessionDetail,
    openSessionMutualFriendsDialog,
    openSingleExport,
    queuedSessionIds,
    runningSessionIds,
    selectedSessions,
    sessionDetail?.wxid,
    sessionContentMetrics,
    sessionMutualFriendsMetrics,
    sessionLoadTraceMap,
    sessionMessageCounts,
    sessionRowByUsername,
    isLoading,
    isSessionEnriching,
    showSessionDetailPanel,
    shouldShowMutualFriendsColumn,
    shouldShowSnsColumn,
    snsUserPostCounts,
    snsUserPostCountsStatus,
    setCurrentSession,
    toggleSelectSession
  ])
  const handleContactsListWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const deltaY = event.deltaY
    if (!deltaY) return
    const sectionTop = sessionTableSectionRef.current?.getBoundingClientRect().top ?? 0
    const sectionPinned = sectionTop <= 8

    if (deltaY > 0 && !sectionPinned) {
      event.preventDefault()
      window.scrollBy({ top: deltaY, behavior: 'auto' })
      return
    }

    if (deltaY < 0 && isContactsListAtTop) {
      event.preventDefault()
      window.scrollBy({ top: deltaY, behavior: 'auto' })
    }
  }, [isContactsListAtTop])
  useEffect(() => {
    if (hasFilteredContacts) return
    setIsContactsListAtTop(true)
  }, [hasFilteredContacts])
  const chooseExportFolder = useCallback(async () => {
    const result = await window.electronAPI.dialog.openFile({
      title: '选择导出目录',
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      const nextPath = result.filePaths[0]
      setExportFolder(nextPath)
      await configService.setExportPath(nextPath)
    }
  }, [])

  const handleExportDefaultsChanged = useCallback((patch: ExportDefaultsSettingsPatch) => {
    if (patch.format) {
      setExportDefaultFormat(patch.format as TextExportFormat)
    }
    if (typeof patch.avatars === 'boolean') {
      setExportDefaultAvatars(patch.avatars)
      setOptions(prev => ({ ...prev, exportAvatars: patch.avatars! }))
    }
    if (patch.dateRange) {
      setExportDefaultDateRangeSelection(patch.dateRange)
    }
    if (patch.media) {
      const mediaPatch = patch.media
      setExportDefaultMedia(mediaPatch)
      setOptions(prev => ({
        ...prev,
        exportMedia: Boolean(mediaPatch.images || mediaPatch.voices || mediaPatch.videos || mediaPatch.emojis),
        exportImages: mediaPatch.images,
        exportVoices: mediaPatch.voices,
        exportVideos: mediaPatch.videos,
        exportEmojis: mediaPatch.emojis
      }))
    }
    if (typeof patch.voiceAsText === 'boolean') {
      setExportDefaultVoiceAsText(patch.voiceAsText)
    }
    if (typeof patch.excelCompactColumns === 'boolean') {
      setExportDefaultExcelCompactColumns(patch.excelCompactColumns)
    }
    if (typeof patch.concurrency === 'number') {
      setExportDefaultConcurrency(patch.concurrency)
    }
  }, [])

  return (
    <div className="export-board-page">
      <div className="export-top-panel">
        <div className="export-top-bar">
          <div className="global-export-controls">
            <div className="path-control">
              <span className="control-label">导出位置</span>
              <div className="path-inline-row">
                <div className="path-value">
                  <button
                    className="path-link"
                    type="button"
                    title={exportFolder}
                    onClick={() => void chooseExportFolder()}
                  >
                    {exportFolder || '未设置'}
                  </button>
                  <button className="path-change-btn" type="button" onClick={() => void chooseExportFolder()}>
                    更换
                  </button>
                </div>
                <button className="secondary-btn" onClick={() => exportFolder && void window.electronAPI.shell.openPath(exportFolder)}>
                  <ExternalLink size={14} /> 打开
                </button>
              </div>
            </div>

            <WriteLayoutSelector
              writeLayout={writeLayout}
              onChange={async (value) => {
                setWriteLayout(value)
                await configService.setExportWriteLayout(value)
              }}
              sessionNameWithTypePrefix={sessionNameWithTypePrefix}
              onSessionNameWithTypePrefixChange={async (enabled) => {
                setSessionNameWithTypePrefix(enabled)
                await configService.setExportSessionNamePrefixEnabled(enabled)
              }}
            />

            <div className="more-export-settings-control">
              <button
                className="more-export-settings-btn"
                type="button"
                onClick={() => setIsExportDefaultsModalOpen(true)}
              >
                更多导出设置
              </button>
            </div>
          </div>

          <button
            className={`task-center-card ${taskCenterAlertCount > 0 ? 'has-alert' : ''}`}
            type="button"
            onClick={() => setIsTaskCenterOpen(true)}
          >
            <span className="task-center-card-label">任务中心</span>
            {taskCenterAlertCount > 0 && (
              <span className="task-center-card-badge">{taskCenterAlertCount}</span>
            )}
          </button>
        </div>
      </div>

      <TaskCenterModal
        isOpen={isTaskCenterOpen}
        tasks={tasks}
        taskRunningCount={taskRunningCount}
        taskQueuedCount={taskQueuedCount}
        expandedPerfTaskId={expandedPerfTaskId}
        nowTick={nowTick}
        onClose={closeTaskCenter}
        onTogglePerfTask={toggleTaskPerfDetail}
      />

      {isExportDefaultsModalOpen && (
        <div
          className="export-defaults-modal-overlay"
          onClick={() => setIsExportDefaultsModalOpen(false)}
        >
          <div
            className="export-defaults-modal"
            role="dialog"
            aria-modal="true"
            aria-label="更多导出设置"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="export-defaults-modal-header">
              <div>
                <h3>更多导出设置</h3>
              </div>
              <button
                className="close-icon-btn"
                type="button"
                onClick={() => setIsExportDefaultsModalOpen(false)}
                aria-label="关闭更多导出设置"
              >
                <X size={16} />
              </button>
            </div>
            <div className="export-defaults-modal-body">
              <ExportDefaultsSettingsForm layout="split" onDefaultsChanged={handleExportDefaultsChanged} />
            </div>
            <div className="export-defaults-modal-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setIsExportDefaultsModalOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="export-section-title-row">
        <h3 className="export-section-title">按类型批量导出</h3>
        <SectionInfoTooltip
          label="按类型批量导出"
          heading="按类型批量导出说明"
          messages={[
            '按数据类型统一导出，适合横向汇总同类内容，比如集中导出图片、语音或视频。',
            '发起前可先设置导出时间范围和格式，能减少无关数据，导出结果更聚焦。',
            '每个类型卡片中展示到已导出会话数，统计范围会涵盖下方按会话导出。'
          ]}
        />
      </div>
      <div className="content-card-grid">
        {contentCards.map(card => {
          const Icon = card.icon
          const isCardStatsLoading = card.type === 'sns'
            ? isSnsCardStatsLoading
            : false
          const isCardRunning = runningCardTypes.has(card.type)
          const isPrimaryCard = card.type === 'text'
          return (
            <div key={card.type} className="content-card">
              <div className="card-header">
                <div className="card-title"><Icon size={16} /> {card.label}</div>
                {card.type === 'sns' && (
                  <div className="card-title-meta">
                    {isCardStatsLoading ? (
                      <span className="count-loading">
                        统计中<span className="animated-ellipsis" aria-hidden="true">...</span>
                      </span>
                    ) : `${card.headerCount.toLocaleString()} 条`}
                  </div>
                )}
              </div>
              <div className="card-stats">
                {card.stats.map((stat) => (
                  <div key={stat.label} className="stat-item">
                    <span>{stat.label}</span>
                    <strong>
                      {isCardStatsLoading ? (
                        <span className="count-loading">
                          统计中<span className="animated-ellipsis" aria-hidden="true">...</span>
                        </span>
                      ) : `${stat.value.toLocaleString()} ${stat.unit}`}
                    </strong>
                  </div>
                ))}
              </div>
              <button
                className={`card-export-btn ${isPrimaryCard ? 'primary' : 'secondary'} ${isCardRunning ? 'running' : ''}`}
                disabled={isCardRunning}
                onClick={() => {
                  if (card.type === 'sns') {
                    openSnsExport()
                    return
                  }
                  openContentExport(card.type)
                }}
              >
                {isCardRunning ? (
                  <>
                    <span>批量导出中</span>
                    <Loader2 size={14} className="spin" />
                  </>
                ) : '批量导出'}
              </button>
            </div>
          )
        })}
      </div>

      <div className="export-section-title-row">
        <h3 className="export-section-title">按会话导出</h3>
        <SectionInfoTooltip
          label="按会话导出"
          heading="按会话导出说明"
          messages={[
            '按会话维度导出完整上下文，适合按客户、项目或群组进行归档。',
            '你可以先在列表中筛选目标会话，再批量导出，结果会保留每个会话的结构与时间线。'
          ]}
        />
        <button
          className={`session-load-detail-entry ${isSessionLoadDetailActive ? 'active' : ''}`}
          type="button"
          onClick={() => setShowSessionLoadDetailModal(true)}
        >
          <span className="session-load-detail-entry-icon" aria-hidden="true">
            <span className="session-load-detail-entry-bar" />
            <span className="session-load-detail-entry-bar" />
            <span className="session-load-detail-entry-bar" />
          </span>
          <span>数据加载详情</span>
        </button>
      </div>
      <div className="session-table-section" ref={sessionTableSectionRef}>
        <div className="session-table-layout">
          <div className="table-wrap" style={contactsTableStyle}>
            <div className="table-toolbar">
              <div className="table-tabs" role="tablist" aria-label="会话类型">
                <button className={`tab-btn ${activeTab === 'private' ? 'active' : ''}`} onClick={() => setActiveTab('private')}>
                  <span className="tab-btn-content">
                    <span>私聊</span>
                    <span>{isTabCountComputing ? <span className="count-loading">计算中<span className="animated-ellipsis" aria-hidden="true">...</span></span> : tabCounts.private}</span>
                  </span>
                </button>
                <button className={`tab-btn ${activeTab === 'group' ? 'active' : ''}`} onClick={() => setActiveTab('group')}>
                  <span className="tab-btn-content">
                    <span>群聊</span>
                    <span>{isTabCountComputing ? <span className="count-loading">计算中<span className="animated-ellipsis" aria-hidden="true">...</span></span> : tabCounts.group}</span>
                  </span>
                </button>
                <button className={`tab-btn ${activeTab === 'former_friend' ? 'active' : ''}`} onClick={() => setActiveTab('former_friend')}>
                  <span className="tab-btn-content">
                    <span>曾经的好友</span>
                    <span>{isTabCountComputing ? <span className="count-loading">计算中<span className="animated-ellipsis" aria-hidden="true">...</span></span> : tabCounts.former_friend}</span>
                  </span>
                </button>
              </div>

              <div className="toolbar-actions">
                <div className="search-input-wrap">
                  <Search size={14} />
                  <input
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder={`搜索${activeTabLabel}联系人...`}
                  />
                  {searchKeyword && (
                    <button className="clear-search" onClick={() => setSearchKeyword('')}>
                      <X size={12} />
                    </button>
                  )}
                </div>
                <button className="secondary-btn" onClick={() => void handleRefreshTableData()} disabled={isContactsListLoading}>
                  <RefreshCw size={14} className={isContactsListLoading ? 'spin' : ''} />
                  刷新
                </button>
              </div>
            </div>

            <div className="table-scroll-shell">
              <div
                ref={contactsHorizontalViewportRef}
                className="table-scroll-viewport"
                onScroll={handleContactsHorizontalViewportScroll}
              >
                <div ref={contactsHorizontalContentRef} className="table-scroll-content">
                  <div className="session-table-sticky">
                    {contactsList.length > 0 && isContactsListLoading && (
                      <div className="table-stage-hint">
                        <Loader2 size={14} className="spin" />
                        联系人列表同步中…
                      </div>
                    )}

                    {hasFilteredContacts && (
                      <div
                        className={`contacts-list-header ${hasContactsHorizontalOverflow ? 'is-draggable' : ''} ${isContactsHeaderDragging ? 'is-dragging' : ''}`}
                        onPointerDown={handleContactsHeaderPointerDown}
                        onPointerMove={handleContactsHeaderPointerMove}
                        onPointerUp={handleContactsHeaderPointerUp}
                        onPointerCancel={handleContactsHeaderPointerCancel}
                      >
                        <span className="contacts-list-header-left">
                          <span className="contacts-list-header-select">
                            <button
                              className={`select-icon-btn ${isAllVisibleSelected ? 'checked' : ''}`}
                              type="button"
                              onClick={toggleSelectAllVisible}
                              disabled={visibleSelectableCount === 0}
                              title={isAllVisibleSelected ? '取消全选当前筛选联系人' : '全选当前筛选联系人'}
                            >
                              {isAllVisibleSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                            </button>
                          </span>
                          <span className="contacts-list-header-main">
                            <span className="contacts-list-header-main-label">{contactsHeaderMainLabel}</span>
                          </span>
                        </span>
                        <span className="contacts-list-header-count">总消息数</span>
                        <span className="contacts-list-header-media">表情包</span>
                        <span className="contacts-list-header-media">语音</span>
                        <span className="contacts-list-header-media">图片</span>
                        <span className="contacts-list-header-media">视频</span>
                        {shouldShowSnsColumn && (
                          <span className="contacts-list-header-media">朋友圈</span>
                        )}
                        {shouldShowMutualFriendsColumn && (
                          <span className="contacts-list-header-media">共同好友</span>
                        )}
                        <span className="contacts-list-header-actions">
                          {selectedCount > 0 && (
                            <>
                              <button
                                className="selection-clear-btn"
                                type="button"
                                onClick={clearSelection}
                              >
                                清空
                              </button>
                              <button
                                className="selection-export-btn"
                                type="button"
                                onClick={openBatchExport}
                              >
                                <span>批量导出</span>
                                <span className="selection-export-count">{selectedCount}</span>
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    )}
                  </div>

                  {contactsList.length === 0 && contactsLoadIssue ? (
                    <div className="load-issue-state">
                      <div className="issue-card">
                        <div className="issue-title">
                          <AlertTriangle size={18} />
                          <span>{contactsLoadIssue.title}</span>
                        </div>
                        <p className="issue-message">{contactsLoadIssue.message}</p>
                        <p className="issue-reason">{contactsLoadIssue.reason}</p>
                        <ul className="issue-hints">
                          <li>可能原因1：数据库当前仍在执行高开销查询（例如导出页后台统计）。</li>
                          <li>可能原因2：contact.db 数据量较大，首次查询时间过长。</li>
                          <li>可能原因3：数据库连接状态异常或 IPC 调用卡住。</li>
                        </ul>
                        <div className="issue-actions">
                          <button className="issue-btn primary" onClick={() => void handleRefreshTableData()}>
                            <RefreshCw size={14} />
                            <span>重试加载</span>
                          </button>
                          <button className="issue-btn" onClick={() => setShowContactsDiagnostics(prev => !prev)}>
                            <ClipboardList size={14} />
                            <span>{showContactsDiagnostics ? '收起诊断详情' : '查看诊断详情'}</span>
                          </button>
                          <button className="issue-btn" onClick={copyContactsDiagnostics}>
                            <span>复制诊断信息</span>
                          </button>
                        </div>
                        {showContactsDiagnostics && (
                          <pre className="issue-diagnostics">{contactsDiagnosticsText}</pre>
                        )}
                      </div>
                    </div>
                  ) : isContactsListLoading && contactsList.length === 0 ? (
                    <div className="loading-state">
                      <Loader2 size={32} className="spin" />
                      <span>联系人加载中...</span>
                    </div>
                  ) : !hasFilteredContacts ? (
                    <div className="empty-state">
                      <span>暂无联系人</span>
                    </div>
                  ) : (
                    <div
                      className="contacts-list"
                      ref={handleContactsListScrollParentRef}
                      onWheelCapture={handleContactsListWheelCapture}
                    >
                      <Virtuoso
                        ref={contactsVirtuosoRef}
                        className="contacts-virtuoso"
                        customScrollParent={contactsListScrollParent ?? undefined}
                        data={filteredContacts}
                        computeItemKey={(_, contact) => contact.username}
                        fixedItemHeight={76}
                        itemContent={renderContactRow}
                        rangeChanged={handleContactsRangeChanged}
                        atTopStateChange={setIsContactsListAtTop}
                        overscan={420}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {hasFilteredContacts && hasContactsHorizontalOverflow && (
              <div
                ref={contactsBottomScrollbarRef}
                className="table-bottom-scrollbar"
                onScroll={handleContactsBottomScrollbarScroll}
                aria-label="会话列表横向滚动条"
              >
                <div className="table-bottom-scrollbar-inner" style={contactsBottomScrollbarInnerStyle} />
              </div>
            )}
          </div>

          {showSessionLoadDetailModal && (
            <div
              className="session-load-detail-overlay"
              onClick={() => setShowSessionLoadDetailModal(false)}
            >
              <div
                className="session-load-detail-modal"
                role="dialog"
                aria-modal="true"
                aria-label="数据加载详情"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="session-load-detail-header">
                  <div>
                    <h4>数据加载详情</h4>
                    <p>
                      更新时间：
                      {sessionLoadDetailUpdatedAt > 0
                        ? new Date(sessionLoadDetailUpdatedAt).toLocaleString('zh-CN')
                        : '暂无'}
                    </p>
                  </div>
                  <button
                    className="session-load-detail-close"
                    type="button"
                    onClick={() => setShowSessionLoadDetailModal(false)}
                    aria-label="关闭"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="session-load-detail-body">
                  <section className="session-load-detail-block">
                    <h5>其他页面后台任务</h5>
                    <div className="session-load-detail-summary">
                      <div className="session-load-detail-summary-text">
                        <strong>{runningNonExportTaskCount}</strong>
                        <span>个任务正在占用后台读取资源</span>
                        {nonExportBackgroundTasksUpdatedAt > 0 && (
                          <em>最近更新时间 {new Date(nonExportBackgroundTasksUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</em>
                        )}
                      </div>
                      <button
                        type="button"
                        className="session-load-detail-stop-btn"
                        onClick={handleCancelAllNonExportTasks}
                        disabled={cancelableNonExportTaskCount === 0}
                      >
                        中断其他页面加载
                      </button>
                    </div>
                    <p className="session-load-detail-note">
                      停止请求会阻止其他页面继续发起后续统计或补算；当前已经发出的单次查询，会在返回后结束。
                    </p>
                    {nonExportBackgroundTasks.length > 0 ? (
                      <div className="session-load-detail-task-list">
                        {nonExportBackgroundTasks.map((task) => (
                          <div key={task.id} className={`session-load-detail-task-item status-${task.status}`}>
                            <div className="session-load-detail-task-main">
                              <div className="session-load-detail-task-title-row">
                                <span className="session-load-detail-task-source">
                                  {backgroundTaskSourceLabels[task.sourcePage] || backgroundTaskSourceLabels.other}
                                </span>
                                <strong>{task.title}</strong>
                                <span className={`session-load-detail-task-status status-${task.status}`}>
                                  {backgroundTaskStatusLabels[task.status]}
                                </span>
                              </div>
                              <p>{task.detail || '暂无详细说明'}</p>
                              <div className="session-load-detail-task-meta">
                                <span>开始：{formatLoadDetailTime(task.startedAt)}</span>
                                <span>更新：{formatLoadDetailTime(task.updatedAt)}</span>
                                {task.progressText && <span>进度：{task.progressText}</span>}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="session-load-detail-task-stop-btn"
                              onClick={() => handleCancelBackgroundTask(task.id)}
                              disabled={!task.cancelable || (task.status !== 'running' && task.status !== 'cancel_requested')}
                            >
                              停止
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="session-load-detail-empty">
                        当前没有检测到其他页面后台任务
                      </div>
                    )}
                  </section>

                  <section className="session-load-detail-block">
                    <h5>总消息数</h5>
                    <div className="session-load-detail-table">
                      <div className="session-load-detail-row header">
                        <span>会话类型</span>
                        <span>加载状态</span>
                        <span>开始时间</span>
                        <span>完成时间</span>
                      </div>
                      {sessionLoadDetailRows.map((row) => {
                        const pulse = sessionLoadProgressPulseMap[`messageCount:${row.tab}`]
                        const isLoading = row.messageCount.statusLabel.startsWith('加载中')
                        return (
                          <div className="session-load-detail-row" key={`message-${row.tab}`}>
                            <span>{row.label}</span>
                            <span className="session-load-detail-status-cell">
                              <span>{row.messageCount.statusLabel}</span>
                              {isLoading && (
                                <Loader2 size={12} className="spin session-load-detail-status-icon" aria-label="加载中" />
                              )}
                              {isLoading && pulse && pulse.delta > 0 && (
                                <span className="session-load-detail-progress-pulse">
                                  {formatLoadDetailPulseTime(pulse.at)} +{pulse.delta}条
                                </span>
                              )}
                            </span>
                            <span>{formatLoadDetailTime(row.messageCount.startedAt)}</span>
                            <span>{formatLoadDetailTime(row.messageCount.finishedAt)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  <section className="session-load-detail-block">
                    <h5>多媒体统计（表情包/图片/视频/语音）</h5>
                    <div className="session-load-detail-table">
                      <div className="session-load-detail-row header">
                        <span>会话类型</span>
                        <span>加载状态</span>
                        <span>开始时间</span>
                        <span>完成时间</span>
                      </div>
                      {sessionLoadDetailRows.map((row) => {
                        const pulse = sessionLoadProgressPulseMap[`mediaMetrics:${row.tab}`]
                        const isLoading = row.mediaMetrics.statusLabel.startsWith('加载中')
                        return (
                          <div className="session-load-detail-row" key={`media-${row.tab}`}>
                            <span>{row.label}</span>
                            <span className="session-load-detail-status-cell">
                              <span>{row.mediaMetrics.statusLabel}</span>
                              {isLoading && (
                                <Loader2 size={12} className="spin session-load-detail-status-icon" aria-label="加载中" />
                              )}
                              {isLoading && pulse && pulse.delta > 0 && (
                                <span className="session-load-detail-progress-pulse">
                                  {formatLoadDetailPulseTime(pulse.at)} +{pulse.delta}条
                                </span>
                              )}
                            </span>
                            <span>{formatLoadDetailTime(row.mediaMetrics.startedAt)}</span>
                            <span>{formatLoadDetailTime(row.mediaMetrics.finishedAt)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  <section className="session-load-detail-block">
                    <h5>朋友圈条数统计</h5>
                    <div className="session-load-detail-table">
                      <div className="session-load-detail-row header">
                        <span>会话类型</span>
                        <span>加载状态</span>
                        <span>开始时间</span>
                        <span>完成时间</span>
                      </div>
                      {sessionLoadDetailRows
                        .filter((row) => row.tab === 'private' || row.tab === 'former_friend')
                        .map((row) => {
                        const pulse = sessionLoadProgressPulseMap[`snsPostCounts:${row.tab}`]
                        const isLoading = row.snsPostCounts.statusLabel.startsWith('加载中')
                        return (
                          <div className="session-load-detail-row" key={`sns-count-${row.tab}`}>
                            <span>{row.label}</span>
                            <span className="session-load-detail-status-cell">
                              <span>{row.snsPostCounts.statusLabel}</span>
                              {isLoading && (
                                <Loader2 size={12} className="spin session-load-detail-status-icon" aria-label="加载中" />
                              )}
                              {isLoading && pulse && pulse.delta > 0 && (
                                <span className="session-load-detail-progress-pulse">
                                  {formatLoadDetailPulseTime(pulse.at)} +{pulse.delta}条
                                </span>
                              )}
                            </span>
                            <span>{formatLoadDetailTime(row.snsPostCounts.startedAt)}</span>
                            <span>{formatLoadDetailTime(row.snsPostCounts.finishedAt)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  <section className="session-load-detail-block">
                    <h5>共同好友统计</h5>
                    <div className="session-load-detail-table">
                      <div className="session-load-detail-row header">
                        <span>会话类型</span>
                        <span>加载状态</span>
                        <span>开始时间</span>
                        <span>完成时间</span>
                      </div>
                      {sessionLoadDetailRows
                        .filter((row) => row.tab === 'private' || row.tab === 'former_friend')
                        .map((row) => {
                          const pulse = sessionLoadProgressPulseMap[`mutualFriends:${row.tab}`]
                          const isLoading = row.mutualFriends.statusLabel.startsWith('加载中')
                          return (
                            <div className="session-load-detail-row" key={`mutual-friends-${row.tab}`}>
                              <span>{row.label}</span>
                              <span className="session-load-detail-status-cell">
                                <span>{row.mutualFriends.statusLabel}</span>
                                {isLoading && (
                                  <Loader2 size={12} className="spin session-load-detail-status-icon" aria-label="加载中" />
                                )}
                                {isLoading && pulse && pulse.delta > 0 && (
                                  <span className="session-load-detail-progress-pulse">
                                    {formatLoadDetailPulseTime(pulse.at)} +{pulse.delta}个
                                  </span>
                                )}
                              </span>
                              <span>{formatLoadDetailTime(row.mutualFriends.startedAt)}</span>
                              <span>{formatLoadDetailTime(row.mutualFriends.finishedAt)}</span>
                            </div>
                          )
                        })}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          )}

          {sessionMutualFriendsDialogTarget && sessionMutualFriendsDialogMetric && (
            <div
              className="session-mutual-friends-overlay"
              onClick={closeSessionMutualFriendsDialog}
            >
              <div
                className="session-mutual-friends-modal"
                role="dialog"
                aria-modal="true"
                aria-label="共同好友"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="session-mutual-friends-header">
                  <div className="session-mutual-friends-header-main">
                    <div className="session-mutual-friends-avatar">
                      <Avatar
                        src={normalizeExportAvatarUrl(sessionMutualFriendsDialogTarget.avatarUrl)}
                        name={sessionMutualFriendsDialogTarget.displayName}
                        size="100%"
                        shape="rounded"
                      />
                    </div>
                    <div className="session-mutual-friends-meta">
                      <h4>{sessionMutualFriendsDialogTarget.displayName} 的共同好友</h4>
                      <div className="session-mutual-friends-stats">
                        共 {sessionMutualFriendsDialogMetric.count.toLocaleString('zh-CN')} 人
                        {sessionMutualFriendsDialogMetric.totalPosts !== null
                          ? ` · 已统计 ${sessionMutualFriendsDialogMetric.loadedPosts.toLocaleString('zh-CN')} / ${sessionMutualFriendsDialogMetric.totalPosts.toLocaleString('zh-CN')} 条朋友圈`
                          : ` · 已统计 ${sessionMutualFriendsDialogMetric.loadedPosts.toLocaleString('zh-CN')} 条朋友圈`}
                      </div>
                    </div>
                  </div>
                  <button
                    className="session-mutual-friends-close"
                    type="button"
                    onClick={closeSessionMutualFriendsDialog}
                    aria-label="关闭共同好友弹窗"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="session-mutual-friends-tip">
                  打开桌面端微信，进入到这个人的朋友圈中，刷ta 的朋友圈，刷的越多这里的数据聚合越多
                </div>

                <div className="session-mutual-friends-toolbar">
                  <input
                    value={sessionMutualFriendsSearch}
                    onChange={(event) => setSessionMutualFriendsSearch(event.target.value)}
                    placeholder="搜索共同好友"
                    aria-label="搜索共同好友"
                  />
                </div>

                <div className="session-mutual-friends-body">
                  {filteredSessionMutualFriendsDialogItems.length === 0 ? (
                    <div className="session-mutual-friends-empty">
                      {sessionMutualFriendsSearch.trim() ? '没有匹配的共同好友' : '暂无共同好友数据'}
                    </div>
                  ) : (
                    <div className="session-mutual-friends-list">
                      {filteredSessionMutualFriendsDialogItems.map((item, index) => (
                        <div className="session-mutual-friends-row" key={`${sessionMutualFriendsDialogTarget.username}-${item.name}`}>
                          <span className="session-mutual-friends-rank">{index + 1}</span>
                          <span className="session-mutual-friends-name" title={item.name}>{item.name}</span>
                          <span className={`session-mutual-friends-source ${item.direction}`}>
                            {getSessionMutualFriendDirectionLabel(item.direction)}
                          </span>
                          <span className="session-mutual-friends-count">{item.totalCount.toLocaleString('zh-CN')}</span>
                          <span className="session-mutual-friends-latest">{formatYmdDateFromSeconds(item.latestTime)}</span>
                          <span
                            className="session-mutual-friends-desc"
                            title={describeSessionMutualFriendRelation(item, sessionMutualFriendsDialogTarget.displayName)}
                          >
                            {describeSessionMutualFriendRelation(item, sessionMutualFriendsDialogTarget.displayName)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {showSessionDetailPanel && (
            <div
              className="export-session-detail-overlay"
              onClick={closeSessionDetailPanel}
            >
              <aside
                className="export-session-detail-panel"
                role="dialog"
                aria-modal="true"
                aria-label="会话详情"
                onClick={(event) => event.stopPropagation()}
              >
              <div className="detail-header">
                <div className="detail-header-main">
                  <div className="detail-header-avatar">
                    <Avatar
                      src={normalizeExportAvatarUrl(sessionDetail?.avatarUrl)}
                      name={sessionDetail?.displayName || sessionDetail?.wxid || ''}
                      size="100%"
                      shape="rounded"
                    />
                  </div>
                  <div className="detail-header-meta">
                    <h4>{sessionDetail?.displayName || '会话详情'}</h4>
                    <div className="detail-header-id">{sessionDetail?.wxid || ''}</div>
                  </div>
                </div>
                <button className="close-btn" onClick={closeSessionDetailPanel}>
                  <X size={16} />
                </button>
              </div>
              {isLoadingSessionDetail && !sessionDetail ? (
                <div className="detail-loading">
                  <Loader2 size={20} className="spin" />
                  <span>加载中...</span>
                </div>
              ) : sessionDetail ? (
                <div className="detail-content">
                  <div className="detail-section">
                    <div className="detail-item">
                      <Hash size={14} />
                      <span className="label">微信ID</span>
                      <span className="value">{sessionDetail.wxid}</span>
                      <button className="copy-btn" title="复制" onClick={() => void handleCopyDetailField(sessionDetail.wxid, 'wxid')}>
                        {copiedDetailField === 'wxid' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                    {sessionDetail.remark && (
                      <div className="detail-item">
                        <span className="label">备注</span>
                        <span className="value">{sessionDetail.remark}</span>
                        <button className="copy-btn" title="复制" onClick={() => void handleCopyDetailField(sessionDetail.remark || '', 'remark')}>
                          {copiedDetailField === 'remark' ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                    )}
                    {sessionDetail.nickName && (
                      <div className="detail-item">
                        <span className="label">昵称</span>
                        <span className="value">{sessionDetail.nickName}</span>
                        <button className="copy-btn" title="复制" onClick={() => void handleCopyDetailField(sessionDetail.nickName || '', 'nickName')}>
                          {copiedDetailField === 'nickName' ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                    )}
                    {sessionDetail.alias && (
                      <div className="detail-item">
                        <span className="label">微信号</span>
                        <span className="value">{sessionDetail.alias}</span>
                        <button className="copy-btn" title="复制" onClick={() => void handleCopyDetailField(sessionDetail.alias || '', 'alias')}>
                          {copiedDetailField === 'alias' ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                    )}
                    {sessionDetailSupportsSnsTimeline && (
                      <div className="detail-item">
                        <Aperture size={14} />
                        <span className="label">朋友圈</span>
                        <span className="value">
                          <button
                            className="detail-inline-btn detail-sns-entry-btn"
                            type="button"
                            onClick={openSessionSnsTimeline}
                          >
                            {sessionDetailSnsCountLabel}
                          </button>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="detail-section">
                    <div className="section-title">
                      <ClipboardList size={14} />
                      <span>导出记录（最近 20 条）</span>
                    </div>
                    {currentSessionExportRecords.length === 0 ? (
                      <div className="detail-record-empty">暂无导出记录</div>
                    ) : (
                      <div className="detail-record-list">
                        {currentSessionExportRecords.map((record, index) => (
                          <div className="detail-record-item" key={`${record.exportTime}-${record.content}-${index}`}>
                            <div className="record-row">
                              <span className="label">导出时间</span>
                              <span className="value">{formatYmdHmDateTime(record.exportTime)}</span>
                            </div>
                            <div className="record-row">
                              <span className="label">导出内容</span>
                              <span className="value">{record.content}</span>
                            </div>
                            <div className="record-row">
                              <span className="label">导出目录</span>
                              <span className="value path" title={record.outputDir}>{formatPathBrief(record.outputDir)}</span>
                              <button
                                className="detail-inline-btn"
                                type="button"
                                onClick={() => void window.electronAPI.shell.openPath(record.outputDir)}
                              >
                                打开
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="detail-section">
                    <div className="section-title">
                      <MessageSquare size={14} />
                      <span>消息统计（导出口径）</span>
                    </div>
                    <div className="detail-stats-meta">
                      {isRefreshingSessionDetailStats
                        ? '统计刷新中...'
                        : sessionDetail.statsUpdatedAt
                          ? `${sessionDetail.statsStale ? '缓存于' : '更新于'} ${formatYmdHmDateTime(sessionDetail.statsUpdatedAt)}${sessionDetail.statsStale ? '（将后台刷新）' : ''}`
                          : (isLoadingSessionDetailExtra ? '统计加载中...' : '暂无统计缓存')}
                    </div>
                    <div className="detail-item">
                      <span className="label">消息总数</span>
                      <span className="value highlight">
                        {Number.isFinite(sessionDetail.messageCount)
                          ? sessionDetail.messageCount.toLocaleString()
                          : ((isLoadingSessionDetail || isLoadingSessionDetailExtra) ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">语音</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.voiceMessages)
                          ? (sessionDetail.voiceMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">图片</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.imageMessages)
                          ? (sessionDetail.imageMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">视频</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.videoMessages)
                          ? (sessionDetail.videoMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">表情包</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.emojiMessages)
                          ? (sessionDetail.emojiMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">转账消息数</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.transferMessages)
                          ? (sessionDetail.transferMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">红包消息数</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.redPacketMessages)
                          ? (sessionDetail.redPacketMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="label">通话消息数</span>
                      <span className="value">
                        {Number.isFinite(sessionDetail.callMessages)
                          ? (sessionDetail.callMessages as number).toLocaleString()
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    {sessionDetail.wxid.includes('@chatroom') ? (
                      <>
                        <div className="detail-item">
                          <span className="label">我发的消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.groupMyMessages)
                              ? (sessionDetail.groupMyMessages as number).toLocaleString()
                              : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">群人数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.groupMemberCount)
                              ? (sessionDetail.groupMemberCount as number).toLocaleString()
                              : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">群发言人数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.groupActiveSpeakers)
                              ? (sessionDetail.groupActiveSpeakers as number).toLocaleString()
                              : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">群共同好友数</span>
                          <span className="value">
                            {sessionDetail.relationStatsLoaded
                              ? (Number.isFinite(sessionDetail.groupMutualFriends)
                                ? (sessionDetail.groupMutualFriends as number).toLocaleString()
                                : '—')
                              : (
                                <button
                                  className="detail-inline-btn"
                                  onClick={() => { void loadSessionRelationStats() }}
                                  disabled={isLoadingSessionRelationStats || isLoadingSessionDetailExtra}
                                >
                                  {isLoadingSessionRelationStats ? '加载中...' : '点击加载'}
                                </button>
                              )}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="detail-item">
                        <span className="label">共同群聊数</span>
                        <span className="value">
                          {sessionDetail.relationStatsLoaded
                            ? (Number.isFinite(sessionDetail.privateMutualGroups)
                              ? (sessionDetail.privateMutualGroups as number).toLocaleString()
                              : '—')
                            : (
                              <button
                                className="detail-inline-btn"
                                onClick={() => { void loadSessionRelationStats() }}
                                disabled={isLoadingSessionRelationStats || isLoadingSessionDetailExtra}
                              >
                                {isLoadingSessionRelationStats ? '加载中...' : '点击加载'}
                              </button>
                            )}
                        </span>
                      </div>
                    )}
                    <div className="detail-item">
                      <Calendar size={14} />
                      <span className="label">首条消息</span>
                      <span className="value">
                        {sessionDetail.firstMessageTime
                          ? formatYmdDateFromSeconds(sessionDetail.firstMessageTime)
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                    <div className="detail-item">
                      <Calendar size={14} />
                      <span className="label">最新消息</span>
                      <span className="value">
                        {sessionDetail.latestMessageTime
                          ? formatYmdDateFromSeconds(sessionDetail.latestMessageTime)
                          : (isLoadingSessionDetailExtra ? '统计中...' : '—')}
                      </span>
                    </div>
                  </div>

                  <div className="detail-section">
                    <div className="section-title">
                      <Database size={14} />
                      <span>数据库分布</span>
                    </div>
                    {Array.isArray(sessionDetail.messageTables) && sessionDetail.messageTables.length > 0 ? (
                      <div className="table-list">
                        {sessionDetail.messageTables.map((table, index) => (
                          <div key={`${table.dbName}-${table.tableName}-${index}`} className="table-item">
                            <span className="db-name">{table.dbName}</span>
                            <span className="table-count">{table.count.toLocaleString()} 条</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="detail-table-placeholder">
                        {isLoadingSessionDetailExtra ? '统计中...' : '暂无统计数据'}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="detail-empty">暂无详情</div>
              )}
              </aside>
            </div>
          )}

          <ContactSnsTimelineDialog
            target={sessionSnsTimelineTarget}
            onClose={closeSessionSnsTimeline}
            initialTotalPosts={sessionSnsTimelineInitialTotalPosts}
            initialTotalPostsLoading={sessionSnsTimelineInitialTotalPostsLoading}
          />
        </div>
      </div>

      {exportDialog.open && createPortal(
        <div className="export-dialog-overlay" onClick={closeExportDialog}>
          <div className="export-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="dialog-header">
              <div className="dialog-header-copy">
                <h3>{exportDialog.title}</h3>
                {isContentTextDialog && (
                  <div className="dialog-header-note">{contentTextDialogSummary}</div>
                )}
              </div>
              <button className="close-icon-btn" onClick={closeExportDialog}><X size={16} /></button>
            </div>

            <div className="dialog-body">
              {exportDialog.scope !== 'single' && (
                <div className="dialog-section">
                  <h4>导出范围</h4>
                  <div className="scope-tag-row">
                    <span className="scope-tag">{scopeLabel}</span>
                    <span className="scope-count">{scopeCountLabel}</span>
                  </div>
                  <div className="scope-list">
                    {exportDialog.sessionNames.slice(0, 20).map(name => (
                      <span key={name} className="scope-item">{name}</span>
                    ))}
                    {exportDialog.sessionNames.length > 20 && <span className="scope-item">... 还有 {exportDialog.sessionNames.length - 20} 个</span>}
                  </div>
                </div>
              )}

              {shouldShowFormatSection && (
                <div className="dialog-section">
                  {useCollapsedSessionFormatSelector ? (
                    <div className="section-header-action">
                      <h4>对话文本导出格式选择</h4>
                      <div className="dialog-format-select" ref={sessionFormatDropdownRef}>
                        <button
                          type="button"
                          className={`time-range-trigger dialog-format-trigger ${showSessionFormatSelect ? 'open' : ''}`}
                          onClick={() => setShowSessionFormatSelect(prev => !prev)}
                        >
                          <span className="dialog-format-trigger-label">{activeDialogFormatLabel}</span>
                          <span className="time-range-arrow">&gt;</span>
                        </button>
                        {showSessionFormatSelect && (
                          <div className="dialog-format-dropdown">
                            {formatOptions.map(option => (
                              <button
                                key={option.value}
                                type="button"
                                className={`dialog-format-option ${options.format === option.value ? 'active' : ''}`}
                                onClick={() => {
                                  setOptions(prev => ({ ...prev, format: option.value as TextExportFormat }))
                                  setShowSessionFormatSelect(false)
                                }}
                              >
                                <span className="option-label">{option.label}</span>
                                <span className="option-desc">{option.desc}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <h4>{exportDialog.scope === 'sns' ? '朋友圈导出格式选择' : '对话文本导出格式选择'}</h4>
                  )}
                  {!isContentScopeDialog && exportDialog.scope !== 'sns' && (
                    <div className="format-note">{avatarExportStatusLabel}</div>
                  )}
                  {isContentTextDialog && (
                    <div className="format-note">{avatarExportStatusLabel}</div>
                  )}
                  {!useCollapsedSessionFormatSelector && (
                    <div className="format-grid">
                      {formatCandidateOptions.map(option => (
                        <button
                          key={option.value}
                          className={`format-card ${exportDialog.scope === 'sns'
                            ? (snsExportFormat === option.value ? 'active' : '')
                            : (options.format === option.value ? 'active' : '')}`}
                          onClick={() => {
                            if (exportDialog.scope === 'sns') {
                              setSnsExportFormat(option.value as SnsTimelineExportFormat)
                            } else {
                              setOptions(prev => ({ ...prev, format: option.value as TextExportFormat }))
                            }
                          }}
                        >
                          <div className="format-label">{option.label}</div>
                          <div className="format-desc">{option.desc}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="dialog-section">
                <div className="section-header-action">
                  <h4>时间范围</h4>
                  <button
                    type="button"
                    className="time-range-trigger"
                    onClick={openTimeRangeDialog}
                    disabled={isResolvingTimeRangeBounds}
                  >
                    <span>{isResolvingTimeRangeBounds ? '正在统计可选时间...' : timeRangeSummaryLabel}</span>
                    <span className="time-range-arrow">&gt;</span>
                  </button>
                </div>
              </div>

              {shouldShowMediaSection && (
                <div className="dialog-section">
                  <h4>{exportDialog.scope === 'sns' ? '媒体文件（可多选）' : '媒体内容'}</h4>
                  <div className="media-check-grid">
                    {exportDialog.scope === 'sns' ? (
                      <>
                        <label><input type="checkbox" checked={snsExportImages} onChange={event => setSnsExportImages(event.target.checked)} /> 图片</label>
                        <label><input type="checkbox" checked={snsExportLivePhotos} onChange={event => setSnsExportLivePhotos(event.target.checked)} /> 实况图</label>
                        <label><input type="checkbox" checked={snsExportVideos} onChange={event => setSnsExportVideos(event.target.checked)} /> 视频</label>
                      </>
                    ) : (
                      <>
                        <label><input type="checkbox" checked={options.exportImages} onChange={event => setOptions(prev => ({ ...prev, exportImages: event.target.checked }))} /> 图片</label>
                        <label><input type="checkbox" checked={options.exportVoices} onChange={event => setOptions(prev => ({ ...prev, exportVoices: event.target.checked }))} /> 语音</label>
                        <label><input type="checkbox" checked={options.exportVideos} onChange={event => setOptions(prev => ({ ...prev, exportVideos: event.target.checked }))} /> 视频</label>
                        <label><input type="checkbox" checked={options.exportEmojis} onChange={event => setOptions(prev => ({ ...prev, exportEmojis: event.target.checked }))} /> 表情包</label>
                      </>
                    )}
                  </div>
                  {exportDialog.scope === 'sns' && (
                    <div className="format-note">全不勾选时仅导出文本信息，不导出媒体文件。</div>
                  )}
                </div>
              )}

              {shouldShowImageDeepSearchToggle && (
                <div className="dialog-section">
                  <div className="dialog-switch-row">
                    <div className="dialog-switch-copy">
                      <h4>缺图时深度搜索</h4>
                      <div className="format-note">关闭后仅尝试 hardlink 命中，未命中将直接显示占位符，导出速度更快。</div>
                    </div>
                    <button
                      type="button"
                      className={`dialog-switch ${options.imageDeepSearchOnMiss ? 'on' : ''}`}
                      aria-pressed={options.imageDeepSearchOnMiss}
                      aria-label="切换缺图时深度搜索"
                      onClick={() => setOptions(prev => ({ ...prev, imageDeepSearchOnMiss: !prev.imageDeepSearchOnMiss }))}
                    >
                      <span className="dialog-switch-thumb" />
                    </button>
                  </div>
                </div>
              )}

              {isSessionScopeDialog && (
                <div className="dialog-section">
                  <div className="dialog-switch-row">
                    <div className="dialog-switch-copy">
                      <h4>语音转文字</h4>
                      <div className="format-note">默认状态跟随更多导出设置中的语音转文字开关。</div>
                    </div>
                    <button
                      type="button"
                      className={`dialog-switch ${options.exportVoiceAsText ? 'on' : ''}`}
                      aria-pressed={options.exportVoiceAsText}
                      aria-label="切换语音转文字"
                      onClick={() => setOptions(prev => ({ ...prev, exportVoiceAsText: !prev.exportVoiceAsText }))}
                    >
                      <span className="dialog-switch-thumb" />
                    </button>
                  </div>
                </div>
              )}

              {shouldShowDisplayNameSection && (
                <div className="dialog-section">
                  <h4>发送者名称显示</h4>
                  <div className="display-name-options" role="radiogroup" aria-label="发送者名称显示">
                    {displayNameOptions.map(option => {
                      const isActive = options.displayNamePreference === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          className={`display-name-item ${isActive ? 'active' : ''}`}
                          onClick={() => setOptions(prev => ({ ...prev, displayNamePreference: option.value }))}
                        >
                          <span>{option.label}</span>
                          <small>{option.desc}</small>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="dialog-actions">
              <button className="secondary-btn" onClick={closeExportDialog}>取消</button>
              <button className="primary-btn" onClick={() => void createTask()} disabled={!canCreateTask}>
                <Download size={14} /> 创建导出任务
              </button>
            </div>

            <ExportDateRangeDialog
              open={isTimeRangeDialogOpen}
              value={timeRangeSelection}
              minDate={timeRangeBounds?.minDate}
              maxDate={timeRangeBounds?.maxDate}
              onClose={closeTimeRangeDialog}
              onConfirm={(nextSelection) => {
                setTimeRangeSelection(nextSelection)
                setOptions(prev => ({
                  ...prev,
                  useAllTime: nextSelection.useAllTime,
                  dateRange: cloneExportDateRange(nextSelection.dateRange)
                }))
                closeTimeRangeDialog()
              }}
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default ExportPage
