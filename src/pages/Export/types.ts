/**
 * ExportV2 — Type definitions
 * Extracted and cleaned from the original ExportPage.tsx monolith.
 */

import type { ChatSession as AppChatSession, ContactInfo } from '../../types/models'
import type { ExportOptions as ElectronExportOptions, ExportProgress } from '../../types/electron'
import type { BackgroundTaskRecord } from '../../types/backgroundTask'

// ─── Tabs & Enums ────────────────────────────────────────────

export type ConversationTab = 'private' | 'group' | 'official' | 'former_friend'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested'
  | 'success'
  | 'error'

export type TaskScope = 'single' | 'multi' | 'content' | 'sns'

export type ContentType = 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'

export type ContentCardType = ContentType | 'sns'

export type SessionLayout = 'shared' | 'per-session'

export type DisplayNamePreference = 'group-nickname' | 'remark' | 'nickname'

export type ExportConflictStrategy = 'incremental' | 'overwrite' | 'rename'

export type TextExportFormat =
  | 'chatlab'
  | 'chatlab-jsonl'
  | 'json'
  | 'arkme-json'
  | 'html'
  | 'markdown'
  | 'txt'
  | 'excel'
  | 'weclone'
  | 'sql'

export type SnsTimelineExportFormat = 'json' | 'html' | 'arkmejson' | 'markdown'

export type ContactsSortKey = 'messageCount' | 'latestMessageTime'
export type ContactsSortOrder = 'desc' | 'asc'

export interface ContactsSortConfig {
  key: ContactsSortKey | null
  order: ContactsSortOrder | null
}

// ─── Export Options ──────────────────────────────────────────

export interface ExportOptions {
  format: TextExportFormat
  dateRange: { start: Date; end: Date } | null
  useAllTime: boolean
  exportAvatars: boolean
  exportMedia: boolean
  exportImages: boolean
  exportVoices: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportFiles: boolean
  maxFileSizeMb: number
  exportVoiceAsText: boolean
  exportPathStyle: 'auto' | 'posix' | 'windows'
  exportConflictStrategy: ExportConflictStrategy
  excelCompactColumns: boolean
  txtColumns: string[]
  displayNamePreference: DisplayNamePreference
  exportConcurrency: number
  fileNamingMode: 'classic' | 'date-range'
}

// ─── Session ─────────────────────────────────────────────────

export interface SessionRow extends AppChatSession {
  kind: ConversationTab
  wechatId?: string
  hasSession: boolean
  remark?: string
  nickname?: string
  displayName?: string
  avatarUrl?: string
}

// ─── Task Progress ───────────────────────────────────────────

export interface TaskProgress {
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

export type TaskPerfStage = 'collect' | 'build' | 'write' | 'other'

export interface TaskSessionPerformance {
  sessionId: string
  sessionName: string
  startedAt: number
  finishedAt?: number
  elapsedMs: number
  lastPhase?: ExportProgress['phase']
  lastPhaseStartedAt?: number
}

export interface TaskPerformance {
  stages: Record<TaskPerfStage, number>
  sessions: Record<string, TaskSessionPerformance>
}

// ─── Export Task ──────────────────────────────────────────────

export interface ExportTaskPayload {
  sessionIds: string[]
  outputDir: string
  options?: ElectronExportOptions
  scope: TaskScope
  source: 'manual' | 'automation'
  automationTaskId?: string
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

export interface ExportTask {
  id: string
  title: string
  status: TaskStatus
  settledSessionIds?: string[]
  sessionOutputPaths?: Record<string, string>
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  payload: ExportTaskPayload
  progress: TaskProgress
  performance?: TaskPerformance
}

// ─── Export Dialog ────────────────────────────────────────────

export interface ExportDialogState {
  open: boolean
  intent: 'manual' | 'automation-create'
  scope: TaskScope
  contentType?: ContentType
  sessionIds: string[]
  sessionNames: string[]
  title: string
}

// ─── Session Detail ──────────────────────────────────────────

export interface SessionDetail {
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

// ─── Session Metrics ─────────────────────────────────────────

export interface SessionExportMetric {
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

export interface SessionContentMetric {
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

export interface TimeRangeBounds {
  minDate: Date
  maxDate: Date
}

export interface SessionExportCacheMeta {
  updatedAt: number
  stale: boolean
  includeRelations: boolean
  source: 'memory' | 'disk' | 'fresh'
  rangeFiltered?: boolean
}

// ─── Session Load Trace ──────────────────────────────────────

export type SessionLoadStageStatus = 'pending' | 'loading' | 'done' | 'failed'

export interface SessionLoadStageState {
  status: SessionLoadStageStatus
  startedAt?: number
  finishedAt?: number
  error?: string
}

export interface SessionLoadTraceState {
  messageCount: SessionLoadStageState
  mediaMetrics: SessionLoadStageState
}

// ─── Contacts Loading ────────────────────────────────────────

export type SessionDataSource = 'cache' | 'network' | null
export type ContactsDataSource = 'cache' | 'network' | null

export interface ContactsLoadSession {
  requestId: string
  startedAt: number
  attempt: number
  timeoutMs: number
}

export interface ContactsLoadIssue {
  kind: 'timeout' | 'error'
  title: string
  message: string
  reason: string
  errorDetail?: string
  occurredAt: number
  elapsedMs: number
}

// ─── Automation Draft (for the create/edit form) ─────────────

export interface AutomationTaskDraft {
  mode: 'create' | 'edit'
  id?: string
  name: string
  enabled: boolean
  sessionIds: string[]
  sessionNames: string[]
  outputDir: string
  useGlobalOutputDir: boolean
  scope: Exclude<TaskScope, 'sns'>
  contentType?: ContentType
  optionTemplate: Omit<ElectronExportOptions, 'dateRange'>
  dateRangeConfig: import('../../types/exportAutomation').ExportAutomationDateRangeConfig | string | null
  intervalDays: number
  intervalHours: number
  firstTriggerAtEnabled: boolean
  firstTriggerAtValue: string
  stopAtEnabled: boolean
  stopAtValue: string
  maxRunsEnabled: boolean
  maxRuns: number
}

// ─── Re-exports for convenience ──────────────────────────────

export type { AppChatSession, ContactInfo }
export type { ElectronExportOptions, ExportProgress }
export type { BackgroundTaskRecord }
export type {
  ExportAutomationCondition,
  ExportAutomationDateRangeConfig,
  ExportAutomationSchedule,
  ExportAutomationTask
} from '../../types/exportAutomation'
