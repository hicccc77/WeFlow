/**
 * ExportV2 — Constants and configuration
 * Extracted from ExportPage.tsx, cleaned and organized.
 */

import type {
  ContentType,
  ConversationTab,
  DisplayNamePreference,
  ExportConflictStrategy,
  TextExportFormat,
  TaskProgress,
  ContactsSortConfig
} from './types'
import type { BackgroundTaskRecord } from '../../types/backgroundTask'
import type { ExportWriteLayout } from '../../services/config'

// ─── Content type labels ─────────────────────────────────────

export const contentTypeLabels: Record<ContentType, string> = {
  text: '聊天文本',
  voice: '语音',
  image: '图片',
  video: '视频',
  emoji: '表情包',
  file: '文件'
}

export const getContentTypeLabel = (type: ContentType): string =>
  contentTypeLabels[type] || type

// ─── Conversation tab labels ─────────────────────────────────

export const conversationTabLabels: Record<ConversationTab, string> = {
  private: '私聊',
  group: '群聊',
  official: '公众号',
  former_friend: '曾经的好友'
}

// ─── Export format options ────────────────────────────────────

export const formatOptions: Array<{ value: TextExportFormat; label: string; desc: string }> = [
  { value: 'chatlab', label: 'ChatLab', desc: '标准格式，支持其他软件导入' },
  { value: 'chatlab-jsonl', label: 'ChatLab JSONL', desc: '流式格式，适合大量消息' },
  { value: 'json', label: 'JSON', desc: '详细格式，包含完整消息信息' },
  { value: 'arkme-json', label: 'Arkme JSON', desc: '紧凑 JSON，支持 sender 去重与关系统计' },
  { value: 'html', label: 'HTML', desc: '网页格式，可直接浏览' },
  { value: 'markdown', label: 'Markdown', desc: '支持文本、图片与链接，适合 AI 场景' },
  { value: 'txt', label: 'TXT', desc: '纯文本，通用格式' },
  { value: 'excel', label: 'Excel', desc: '电子表格，适合统计分析' },
  { value: 'weclone', label: 'WeClone CSV', desc: 'WeClone 兼容字段格式（CSV）' },
  { value: 'sql', label: 'PostgreSQL', desc: '数据库脚本，便于导入到数据库' }
]

// ─── Display name options ────────────────────────────────────

export const displayNameOptions: Array<{ value: DisplayNamePreference; label: string; desc: string }> = [
  { value: 'group-nickname', label: '群昵称优先', desc: '群聊显示群昵称，缺失时回退备注/用户名' },
  { value: 'remark', label: '备注优先', desc: '有备注显示备注，否则显示用户名' },
  { value: 'nickname', label: '用户名优先', desc: '有用户名显示用户名，否则显示备注' }
]

export const conflictStrategyOptions: Array<{ value: ExportConflictStrategy; label: string; desc: string }> = [
  { value: 'incremental', label: '增量跳过', desc: '复用已有同名媒体；聊天文件有变化时更新原文件' },
  { value: 'overwrite', label: '全量覆盖', desc: '同名文件直接替换，适合强制刷新导出结果' },
  { value: 'rename', label: '保留副本', desc: '同名导出追加序号，保留旧版本' }
]

// ─── Write layout options ────────────────────────────────────

export const writeLayoutOptions: Array<{ value: ExportWriteLayout; label: string; desc: string }> = [
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

// ─── File size presets ───────────────────────────────────────

export const FILE_SIZE_PRESETS_MB = [0, 100, 200, 500, 1024] as const
export const MAX_EXPORT_FILE_SIZE_MB_LIMIT = 4096

// ─── Default txt export columns ──────────────────────────────

export const defaultTxtColumns = ['index', 'time', 'senderRole', 'messageType', 'content']

// ─── Background task labels ──────────────────────────────────

export const backgroundTaskSourceLabels: Record<string, string> = {
  export: '导出页',
  chat: '聊天页',
  analytics: '分析页',
  sns: '朋友圈页',
  groupAnalytics: '群分析页',
  annualReport: '年度报告',
  other: '其他页面'
}

export const backgroundTaskStatusLabels: Record<BackgroundTaskRecord['status'], string> = {
  running: '运行中',
  pause_requested: '中断中',
  paused: '已中断',
  cancel_requested: '停止中',
  completed: '已完成',
  failed: '失败',
  canceled: '已停止'
}

// ─── Conversation tab sort priority ──────────────────────────

export const exportKindPriority: Record<ConversationTab, number> = {
  private: 0,
  group: 1,
  former_friend: 2,
  official: 3
}

// ─── Default sort config ─────────────────────────────────────

export const DEFAULT_CONTACTS_SORT_CONFIG: ContactsSortConfig = { key: null, order: null }

// ─── Timing constants ────────────────────────────────────────

export const DETAIL_PRECISE_REFRESH_COOLDOWN_MS = 10 * 60 * 1000
export const TASK_PERFORMANCE_UPDATE_MIN_INTERVAL_MS = 900
export const EXPORT_PROGRESS_UI_FLUSH_INTERVAL_MS = 320
export const SESSION_MEDIA_METRIC_PREFETCH_ROWS = 10
export const SESSION_MEDIA_METRIC_BATCH_SIZE = 8
export const SESSION_MEDIA_METRIC_BACKGROUND_FEED_SIZE = 48
export const SESSION_MEDIA_METRIC_VISIBLE_REFRESH_LIMIT = 24
export const SESSION_MEDIA_METRIC_TAB_REFRESH_LIMIT = 96
export const SESSION_MEDIA_METRIC_CACHE_FLUSH_DELAY_MS = 1200
export const SESSION_DETAIL_BACKGROUND_METRIC_LIMIT_PER_TAB = 96
export const INLINE_AVATAR_CACHE_MAX_LENGTH = 4096

export const CONTACT_ENRICH_TIMEOUT_MS = 7000
export const EXPORT_SNS_STATS_CACHE_STALE_MS = 12 * 60 * 60 * 1000
export const EXPORT_AVATAR_ENRICH_BATCH_SIZE = 80
export const DEFAULT_CONTACTS_LOAD_TIMEOUT_MS = 10000
export const EXPORT_REENTER_SESSION_SOFT_REFRESH_MS = 5 * 60 * 1000
export const EXPORT_REENTER_CONTACTS_SOFT_REFRESH_MS = 5 * 60 * 1000

// ─── Default export options ──────────────────────────────────

export const createDefaultExportOptions = (): import('./types').ExportOptions => ({
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
  exportFiles: true,
  maxFileSizeMb: 200,
  exportVoiceAsText: false,
  exportPathStyle: 'auto',
  exportConflictStrategy: 'incremental',
  excelCompactColumns: true,
  txtColumns: defaultTxtColumns,
  displayNamePreference: 'remark',
  exportConcurrency: 2,
  fileNamingMode: 'classic'
})

// ─── Empty progress factory ──────────────────────────────────

export const createEmptyProgress = (): TaskProgress => ({
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
