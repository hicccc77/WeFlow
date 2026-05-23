// ChatLab 格式类型定义
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

export interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
export const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  34359738417: 7,  // 文件消息变体 -> LINK
  103079215153: 7, // 文件消息变体 -> LINK
  25769803825: 7,  // 文件消息变体 -> LINK
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

// 与 chatService 的资源消息识别保持一致，覆盖桌面微信里的多种文件消息 localType。
export const FILE_APP_LOCAL_TYPES = [49, 34359738417, 103079215153, 25769803825] as const
export const FILE_APP_LOCAL_TYPE_SET = new Set<number>(FILE_APP_LOCAL_TYPES)

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'txt' | 'excel' | 'weclone' | 'sql'
  contentType?: 'text' | 'voice' | 'image' | 'video' | 'emoji' | 'file'
  dateRange?: { start: number; end: number } | null
  senderUsername?: string
  fileNameSuffix?: string
  fileNamingMode?: 'classic' | 'date-range'
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVoices?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  exportVoiceAsText?: boolean
  excelCompactColumns?: boolean
  txtColumns?: string[]
  sessionLayout?: 'shared' | 'per-session'
  exportWriteLayout?: 'A' | 'B' | 'C'
  sessionNameWithTypePrefix?: boolean
  displayNamePreference?: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency?: number
}

export const TXT_COLUMN_DEFINITIONS: Array<{ id: string; label: string }> = [
  { id: 'index', label: '序号' },
  { id: 'time', label: '时间' },
  { id: 'senderRole', label: '发送者身份' },
  { id: 'messageType', label: '消息类型' },
  { id: 'content', label: '内容' },
  { id: 'senderNickname', label: '发送者昵称' },
  { id: 'senderWxid', label: '发送者微信ID' },
  { id: 'senderRemark', label: '发送者备注' }
]

export interface MediaExportItem {
  relativePath: string
  kind: 'image' | 'voice' | 'emoji' | 'video' | 'file'
  posterDataUrl?: string
}

export interface ExportDisplayProfile {
  wxid: string
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

// 并发控制：限制同时执行的 Promise 数量
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  async function runNext(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++
      results[index] = await fn(items[index], index)
    }
  }

  // 启动 limit 个并发任务
  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => runNext())

  await Promise.all(workers)
  return results
}
