export interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

export interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
}

export interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
}

export interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
  platformMessageId?: string
  replyToMessageId?: string
  chatRecords?: any[]  // 嵌套的聊天记录
}

export interface ForwardChatRecordItem {
  datatype: number
  sourcename: string
  sourcetime: string
  sourceheadurl?: string
  datadesc?: string
  datatitle?: string
  fileext?: string
  datasize?: number
  chatRecordTitle?: string
  chatRecordDesc?: string
  chatRecordList?: ForwardChatRecordItem[]
}

export interface ExportDisplayProfile {
  accountId: string
  nickname: string
  remark: string
  alias: string
  groupNickname: string
  displayName: string
}

export interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'markdown' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  fileNamingMode?: 'classic' | 'date-range'
  exportConflictStrategy?: 'incremental' | 'overwrite' | 'rename'
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  exportVoiceAsText?: boolean
  exportPathStyle?: 'auto' | 'posix' | 'windows'
  excelCompactColumns?: boolean
  txtColumns?: string[]
  sessionLayout?: 'shared' | 'per-session'
  exportWriteLayout?: 'A' | 'B' | 'C'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
}

export interface MediaExportItem {
  relativePath: string
  kind: 'image' | 'voice' | 'emoji' | 'video' | 'file'
  posterDataUrl?: string
}

export interface ExportDisplayProfile {
  accountId: string
  nickname: string
  remark: string
  alias: string
  groupNickname: string
  displayName: string
}

export type MessageCollectMode = 'full' | 'text-fast' | 'media-fast'
export type MediaContentType = 'voice' | 'image' | 'video' | 'emoji' | 'file'

export interface FileExportCandidate {
  sourcePath: string
  matchedBy: 'md5' | 'name'
  yearMonth?: string
  preferredMonth?: boolean
  mtimeMs: number
  searchOrder: number
}

export interface FileAttachmentSearchRoot {
  accountDir: string
  msgFileRoot?: string
  fileStorageRoot?: string
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  currentSessionId?: string
  phase: 'preparing' | 'exporting' | 'exporting-media' | 'exporting-voice' | 'writing' | 'complete'
  phaseProgress?: number
  phaseTotal?: number
  phaseLabel?: string
  collectedMessages?: number
  exportedMessages?: number
  estimatedTotalMessages?: number
  writtenFiles?: number
  mediaDoneFiles?: number
  mediaCacheHitFiles?: number
  mediaCacheMissFiles?: number
  mediaCacheFillFiles?: number
  mediaDedupReuseFiles?: number
  mediaBytesWritten?: number
}

export interface MediaExportTelemetry {
  doneFiles: number
  cacheHitFiles: number
  cacheMissFiles: number
  cacheFillFiles: number
  dedupReuseFiles: number
  bytesWritten: number
}

export interface MediaSourceResolution {
  sourcePath: string
  cacheHit: boolean
  cachePath?: string
  fileStat?: { size: number; mtimeMs: number }
  dedupeKey?: string
}

export interface ExportTaskControl {
  shouldPause?: () => boolean
  shouldStop?: () => boolean
  recordCreatedFile?: (filePath: string) => void
  recordCreatedDir?: (dirPath: string) => void
}

export interface ExportStatsResult {
  totalMessages: number
  voiceMessages: number
  cachedVoiceCount: number
  needTranscribeCount: number
  mediaMessages: number
  estimatedSeconds: number
  sessions: Array<{ sessionId: string; displayName: string; totalCount: number; voiceCount: number }>
}

export interface ExportStatsSessionSnapshot {
  totalCount: number
  voiceCount: number
  imageCount: number
  videoCount: number
  emojiCount: number
  cachedVoiceCount: number
  lastTimestamp?: number
}

export interface ExportStatsCacheEntry {
  createdAt: number
  result: ExportStatsResult
  sessions: Record<string, ExportStatsSessionSnapshot>
}

export interface ExportAggregatedSessionMetric {
  totalMessages?: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  lastTimestamp?: number
}

export interface ExportAggregatedSessionStatsCacheEntry {
  createdAt: number
  data: Record<string, ExportAggregatedSessionMetric>
}
