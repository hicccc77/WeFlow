// 配置服务 - 封装 Electron Store
import { config } from './ipc'
import type { ExportDefaultDateRangeConfig } from '../utils/exportDateRange'

// 配置键名
export const CONFIG_KEYS = {
  DECRYPT_KEY: 'decryptKey',
  DB_PATH: 'dbPath',
  MY_WXID: 'myWxid',
  WXID_CONFIGS: 'wxidConfigs',
  THEME: 'theme',
  THEME_ID: 'themeId',
  LAST_SESSION: 'lastSession',
  WINDOW_BOUNDS: 'windowBounds',
  CACHE_PATH: 'cachePath',

  EXPORT_PATH: 'exportPath',
  AGREEMENT_ACCEPTED: 'agreementAccepted',
  LOG_ENABLED: 'logEnabled',
  ONBOARDING_DONE: 'onboardingDone',
  LLM_MODEL_PATH: 'llmModelPath',
  IMAGE_XOR_KEY: 'imageXorKey',
  IMAGE_AES_KEY: 'imageAesKey',
  WHISPER_MODEL_NAME: 'whisperModelName',
  WHISPER_MODEL_DIR: 'whisperModelDir',
  WHISPER_DOWNLOAD_SOURCE: 'whisperDownloadSource',
  AUTO_TRANSCRIBE_VOICE: 'autoTranscribeVoice',
  TRANSCRIBE_LANGUAGES: 'transcribeLanguages',
  EXPORT_DEFAULT_FORMAT: 'exportDefaultFormat',
  EXPORT_DEFAULT_AVATARS: 'exportDefaultAvatars',
  EXPORT_DEFAULT_DATE_RANGE: 'exportDefaultDateRange',
  EXPORT_DEFAULT_MEDIA: 'exportDefaultMedia',
  EXPORT_DEFAULT_VOICE_AS_TEXT: 'exportDefaultVoiceAsText',
  EXPORT_DEFAULT_EXCEL_COMPACT_COLUMNS: 'exportDefaultExcelCompactColumns',
  EXPORT_DEFAULT_TXT_COLUMNS: 'exportDefaultTxtColumns',
  EXPORT_DEFAULT_CONCURRENCY: 'exportDefaultConcurrency',
  EXPORT_DEFAULT_IMAGE_DEEP_SEARCH_ON_MISS: 'exportDefaultImageDeepSearchOnMiss',
  EXPORT_WRITE_LAYOUT: 'exportWriteLayout',
  EXPORT_SESSION_NAME_PREFIX_ENABLED: 'exportSessionNamePrefixEnabled',
  EXPORT_LAST_SESSION_RUN_MAP: 'exportLastSessionRunMap',
  EXPORT_LAST_CONTENT_RUN_MAP: 'exportLastContentRunMap',
  EXPORT_SESSION_RECORD_MAP: 'exportSessionRecordMap',
  EXPORT_LAST_SNS_POST_COUNT: 'exportLastSnsPostCount',
  EXPORT_SESSION_MESSAGE_COUNT_CACHE_MAP: 'exportSessionMessageCountCacheMap',
  EXPORT_SESSION_CONTENT_METRIC_CACHE_MAP: 'exportSessionContentMetricCacheMap',
  EXPORT_SNS_STATS_CACHE_MAP: 'exportSnsStatsCacheMap',
  EXPORT_SNS_USER_POST_COUNTS_CACHE_MAP: 'exportSnsUserPostCountsCacheMap',
  EXPORT_SESSION_MUTUAL_FRIENDS_CACHE_MAP: 'exportSessionMutualFriendsCacheMap',
  SNS_PAGE_CACHE_MAP: 'snsPageCacheMap',
  CONTACTS_LOAD_TIMEOUT_MS: 'contactsLoadTimeoutMs',
  CONTACTS_LIST_CACHE_MAP: 'contactsListCacheMap',
  CONTACTS_AVATAR_CACHE_MAP: 'contactsAvatarCacheMap',

  // 安全
  AUTH_ENABLED: 'authEnabled',
  AUTH_PASSWORD: 'authPassword',
  AUTH_USE_HELLO: 'authUseHello',

  // 更新
  IGNORED_UPDATE_VERSION: 'ignoredUpdateVersion',

  // 通知
  NOTIFICATION_ENABLED: 'notificationEnabled',
  NOTIFICATION_POSITION: 'notificationPosition',
  NOTIFICATION_FILTER_MODE: 'notificationFilterMode',
  NOTIFICATION_FILTER_LIST: 'notificationFilterList',
  HTTP_API_TOKEN: 'httpApiToken',
  HTTP_API_ENABLED: 'httpApiEnabled',
  HTTP_API_PORT: 'httpApiPort',
  HTTP_API_HOST: 'httpApiHost',
  MESSAGE_PUSH_ENABLED: 'messagePushEnabled',
  WINDOW_CLOSE_BEHAVIOR: 'windowCloseBehavior',
  QUOTE_LAYOUT: 'quoteLayout',

  // 词云
  WORD_CLOUD_EXCLUDE_WORDS: 'wordCloudExcludeWords',

  // 数据收集
  ANALYTICS_CONSENT: 'analyticsConsent',
  ANALYTICS_DENY_COUNT: 'analyticsDenyCount'
} as const

export interface WxidConfig {
  decryptKey?: string
  imageXorKey?: number
  imageAesKey?: string
  updatedAt?: number
}

export interface ExportDefaultMediaConfig {
  images: boolean
  videos: boolean
  voices: boolean
  emojis: boolean
}

export type WindowCloseBehavior = 'ask' | 'tray' | 'quit'
export type QuoteLayout = 'quote-top' | 'quote-bottom'

const DEFAULT_EXPORT_MEDIA_CONFIG: ExportDefaultMediaConfig = {
  images: true,
  videos: true,
  voices: true,
  emojis: true
}

// 获取解密密钥
export async function getDecryptKey(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.DECRYPT_KEY)
  return value as string | null
}

// 设置解密密钥
export async function setDecryptKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.DECRYPT_KEY, key)
}

// 获取数据库路径
export async function getDbPath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.DB_PATH)
  return value as string | null
}

// 获取api access_token
export async function getHttpApiToken(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_TOKEN)
  return (value as string) || ''
}

// 设置access_token
export async function setHttpApiToken(token: string): Promise<void> {
  await config.set(CONFIG_KEYS.HTTP_API_TOKEN, token)
}

// 设置数据库路径
export async function setDbPath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.DB_PATH, path)
}

// 获取当前用户 wxid
export async function getMyWxid(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.MY_WXID)
  return value as string | null
}

// 设置当前用户 wxid
export async function setMyWxid(wxid: string): Promise<void> {
  await config.set(CONFIG_KEYS.MY_WXID, wxid)
}

export async function getWxidConfigs(): Promise<Record<string, WxidConfig>> {
  const value = await config.get(CONFIG_KEYS.WXID_CONFIGS)
  if (value && typeof value === 'object') {
    return value as Record<string, WxidConfig>
  }
  return {}
}

export async function getWxidConfig(wxid: string): Promise<WxidConfig | null> {
  if (!wxid) return null
  const configs = await getWxidConfigs()
  return configs[wxid] || null
}

export async function setWxidConfig(wxid: string, configValue: WxidConfig): Promise<void> {
  if (!wxid) return
  const configs = await getWxidConfigs()
  const previous = configs[wxid] || {}
  configs[wxid] = {
    ...previous,
    ...configValue,
    updatedAt: Date.now()
  }
  await config.set(CONFIG_KEYS.WXID_CONFIGS, configs)
}

// 获取主题
export async function getTheme(): Promise<'light' | 'dark' | 'system'> {
  const value = await config.get(CONFIG_KEYS.THEME)
  return (value as 'light' | 'dark' | 'system') || 'light'
}

// 设置主题
export async function setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
  await config.set(CONFIG_KEYS.THEME, theme)
}

// 获取主题配色
export async function getThemeId(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.THEME_ID)
  return (value as string) || null
}

// 设置主题配色
export async function setThemeId(themeId: string): Promise<void> {
  await config.set(CONFIG_KEYS.THEME_ID, themeId)
}

// 获取上次打开的会话
export async function getLastSession(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.LAST_SESSION)
  return value as string | null
}

// 设置上次打开的会话
export async function setLastSession(sessionId: string): Promise<void> {
  await config.set(CONFIG_KEYS.LAST_SESSION, sessionId)
}


// 获取缓存路径
export async function getCachePath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.CACHE_PATH)
  return value as string | null
}

// 设置缓存路径
export async function setCachePath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.CACHE_PATH, path)
}




// 获取导出路径
export async function getExportPath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_PATH)
  return value as string | null
}

// 设置导出路径
export async function setExportPath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_PATH, path)
}


// 获取协议同意状态
export async function getAgreementAccepted(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AGREEMENT_ACCEPTED)
  return value === true
}

// 设置协议同意状态
export async function setAgreementAccepted(accepted: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AGREEMENT_ACCEPTED, accepted)
}

// 获取日志开关
export async function getLogEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.LOG_ENABLED)
  return value === true
}

// 设置日志开关
export async function setLogEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.LOG_ENABLED, enabled)
}

// 获取 LLM 模型路径
export async function getLlmModelPath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.LLM_MODEL_PATH)
  return (value as string) || null
}

// 设置 LLM 模型路径
export async function setLlmModelPath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.LLM_MODEL_PATH, path)
}

// 获取 Whisper 模型名称
export async function getWhisperModelName(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.WHISPER_MODEL_NAME)
  return (value as string) || null
}

// 设置 Whisper 模型名称
export async function setWhisperModelName(name: string): Promise<void> {
  await config.set(CONFIG_KEYS.WHISPER_MODEL_NAME, name)
}

// 获取 Whisper 模型目录
export async function getWhisperModelDir(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.WHISPER_MODEL_DIR)
  return (value as string) || null
}

// 设置 Whisper 模型目录
export async function setWhisperModelDir(dir: string): Promise<void> {
  await config.set(CONFIG_KEYS.WHISPER_MODEL_DIR, dir)
}

// 获取 Whisper 下载源
export async function getWhisperDownloadSource(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.WHISPER_DOWNLOAD_SOURCE)
  return (value as string) || null
}

// 设置 Whisper 下载源
export async function setWhisperDownloadSource(source: string): Promise<void> {
  await config.set(CONFIG_KEYS.WHISPER_DOWNLOAD_SOURCE, source)
}

// 清除所有配置
export async function clearConfig(): Promise<void> {
  await config.clear()
}

// 获取图片 XOR 密钥
export async function getImageXorKey(): Promise<number | null> {
  const value = await config.get(CONFIG_KEYS.IMAGE_XOR_KEY)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

// 设置图片 XOR 密钥
export async function setImageXorKey(key: number): Promise<void> {
  await config.set(CONFIG_KEYS.IMAGE_XOR_KEY, key)
}

// 获取图片 AES 密钥
export async function getImageAesKey(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.IMAGE_AES_KEY)
  return (value as string) || null
}

// 设置图片 AES 密钥
export async function setImageAesKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.IMAGE_AES_KEY, key)
}

// 获取是否完成首次配置引导
export async function getOnboardingDone(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.ONBOARDING_DONE)
  return value === true
}

// 设置首次配置引导完成
export async function setOnboardingDone(done: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.ONBOARDING_DONE, done)
}

// 获取自动语音转文字开关
export async function getAutoTranscribeVoice(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AUTO_TRANSCRIBE_VOICE)
  return value === true
}

// 设置自动语音转文字开关
export async function setAutoTranscribeVoice(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AUTO_TRANSCRIBE_VOICE, enabled)
}

// 获取语音转文字支持的语言列表
export async function getTranscribeLanguages(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.TRANSCRIBE_LANGUAGES)
  // 默认只支持中文
  return (value as string[]) || ['zh']
}

// 设置语音转文字支持的语言列表
export async function setTranscribeLanguages(languages: string[]): Promise<void> {
  await config.set(CONFIG_KEYS.TRANSCRIBE_LANGUAGES, languages)
}

// 获取导出默认格式
export async function getExportDefaultFormat(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_FORMAT)
  return (value as string) || null
}

// 设置导出默认格式
export async function setExportDefaultFormat(format: string): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_FORMAT, format)
}

// 获取导出默认头像设置
export async function getExportDefaultAvatars(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_AVATARS)
  if (typeof value === 'boolean') return value
  return null
}

// 设置导出默认头像设置
export async function setExportDefaultAvatars(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_AVATARS, enabled)
}

// 获取导出默认时间范围
export async function getExportDefaultDateRange(): Promise<ExportDefaultDateRangeConfig | string | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_DATE_RANGE)
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    return value as ExportDefaultDateRangeConfig
  }
  return null
}

// 设置导出默认时间范围
export async function setExportDefaultDateRange(range: ExportDefaultDateRangeConfig | string): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_DATE_RANGE, range)
}

// 获取导出默认媒体设置
export async function getExportDefaultMedia(): Promise<ExportDefaultMediaConfig | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_MEDIA)
  if (typeof value === 'boolean') {
    return {
      images: value,
      videos: value,
      voices: value,
      emojis: value
    }
  }
  if (value && typeof value === 'object') {
    const raw = value as Partial<Record<keyof ExportDefaultMediaConfig, unknown>>
    return {
      images: typeof raw.images === 'boolean' ? raw.images : DEFAULT_EXPORT_MEDIA_CONFIG.images,
      videos: typeof raw.videos === 'boolean' ? raw.videos : DEFAULT_EXPORT_MEDIA_CONFIG.videos,
      voices: typeof raw.voices === 'boolean' ? raw.voices : DEFAULT_EXPORT_MEDIA_CONFIG.voices,
      emojis: typeof raw.emojis === 'boolean' ? raw.emojis : DEFAULT_EXPORT_MEDIA_CONFIG.emojis
    }
  }
  return null
}

// 设置导出默认媒体设置
export async function setExportDefaultMedia(media: ExportDefaultMediaConfig): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_MEDIA, {
    images: media.images,
    videos: media.videos,
    voices: media.voices,
    emojis: media.emojis
  })
}

// 获取导出默认语音转文字
export async function getExportDefaultVoiceAsText(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_VOICE_AS_TEXT)
  if (typeof value === 'boolean') return value
  return null
}

// 设置导出默认语音转文字
export async function setExportDefaultVoiceAsText(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_VOICE_AS_TEXT, enabled)
}

// 获取导出默认 Excel 列模式
export async function getExportDefaultExcelCompactColumns(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_EXCEL_COMPACT_COLUMNS)
  if (typeof value === 'boolean') return value
  return null
}

// 设置导出默认 Excel 列模式
export async function setExportDefaultExcelCompactColumns(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_EXCEL_COMPACT_COLUMNS, enabled)
}

// 获取导出默认 TXT 列配置
export async function getExportDefaultTxtColumns(): Promise<string[] | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_TXT_COLUMNS)
  return Array.isArray(value) ? (value as string[]) : null
}

// 设置导出默认 TXT 列配置
export async function setExportDefaultTxtColumns(columns: string[]): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_TXT_COLUMNS, columns)
}

// 获取导出默认并发数
export async function getExportDefaultConcurrency(): Promise<number | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_CONCURRENCY)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

// 设置导出默认并发数
export async function setExportDefaultConcurrency(concurrency: number): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_CONCURRENCY, concurrency)
}

// 获取缺图时是否深度搜索（默认导出行为）
export async function getExportDefaultImageDeepSearchOnMiss(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_IMAGE_DEEP_SEARCH_ON_MISS)
  if (typeof value === 'boolean') return value
  return null
}

// 设置缺图时是否深度搜索（默认导出行为）
export async function setExportDefaultImageDeepSearchOnMiss(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_IMAGE_DEEP_SEARCH_ON_MISS, enabled)
}

export type ExportWriteLayout = 'A' | 'B' | 'C'

export async function getExportWriteLayout(): Promise<ExportWriteLayout> {
  const value = await config.get(CONFIG_KEYS.EXPORT_WRITE_LAYOUT)
  if (value === 'A' || value === 'B' || value === 'C') return value
  return 'B'
}

export async function setExportWriteLayout(layout: ExportWriteLayout): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_WRITE_LAYOUT, layout)
}

export async function getExportSessionNamePrefixEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.EXPORT_SESSION_NAME_PREFIX_ENABLED)
  if (typeof value === 'boolean') return value
  return true
}

export async function setExportSessionNamePrefixEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_SESSION_NAME_PREFIX_ENABLED, enabled)
}

export async function getExportLastSessionRunMap(): Promise<Record<string, number>> {
  const value = await config.get(CONFIG_KEYS.EXPORT_LAST_SESSION_RUN_MAP)
  if (!value || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, unknown>)
  const map: Record<string, number> = {}
  for (const [sessionId, raw] of entries) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      map[sessionId] = raw
    }
  }
  return map
}

export async function setExportLastSessionRunMap(map: Record<string, number>): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_LAST_SESSION_RUN_MAP, map)
}

export async function getExportLastContentRunMap(): Promise<Record<string, number>> {
  const value = await config.get(CONFIG_KEYS.EXPORT_LAST_CONTENT_RUN_MAP)
  if (!value || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, unknown>)
  const map: Record<string, number> = {}
  for (const [key, raw] of entries) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      map[key] = raw
    }
  }
  return map
}

export async function setExportLastContentRunMap(map: Record<string, number>): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_LAST_CONTENT_RUN_MAP, map)
}

export interface ExportSessionRecordEntry {
  exportTime: number
  content: string
  outputDir: string
}

export async function getExportSessionRecordMap(): Promise<Record<string, ExportSessionRecordEntry[]>> {
  const value = await config.get(CONFIG_KEYS.EXPORT_SESSION_RECORD_MAP)
  if (!value || typeof value !== 'object') return {}
  const map: Record<string, ExportSessionRecordEntry[]> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [sessionId, rawList] of entries) {
    if (!Array.isArray(rawList)) continue
    const normalizedList: ExportSessionRecordEntry[] = []
    for (const rawItem of rawList) {
      if (!rawItem || typeof rawItem !== 'object') continue
      const exportTime = Number((rawItem as Record<string, unknown>).exportTime)
      const content = String((rawItem as Record<string, unknown>).content || '').trim()
      const outputDir = String((rawItem as Record<string, unknown>).outputDir || '').trim()
      if (!Number.isFinite(exportTime) || exportTime <= 0) continue
      if (!content || !outputDir) continue
      normalizedList.push({
        exportTime: Math.floor(exportTime),
        content,
        outputDir
      })
    }
    if (normalizedList.length > 0) {
      map[sessionId] = normalizedList
    }
  }
  return map
}

export async function setExportSessionRecordMap(map: Record<string, ExportSessionRecordEntry[]>): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_SESSION_RECORD_MAP, map)
}

export async function getExportLastSnsPostCount(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.EXPORT_LAST_SNS_POST_COUNT)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  return 0
}

export async function setExportLastSnsPostCount(count: number): Promise<void> {
  const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  await config.set(CONFIG_KEYS.EXPORT_LAST_SNS_POST_COUNT, normalized)
}

export interface ExportSessionMessageCountCacheItem {
  updatedAt: number
  counts: Record<string, number>
}

export interface ExportSessionContentMetricCacheEntry {
  totalMessages?: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  firstTimestamp?: number
  lastTimestamp?: number
}

export interface ExportSessionContentMetricCacheItem {
  updatedAt: number
  metrics: Record<string, ExportSessionContentMetricCacheEntry>
}

export interface ExportSnsStatsCacheItem {
  updatedAt: number
  totalPosts: number
  totalFriends: number
}

export interface ExportSnsUserPostCountsCacheItem {
  updatedAt: number
  counts: Record<string, number>
}

export type ExportSessionMutualFriendDirection = 'incoming' | 'outgoing' | 'bidirectional'
export type ExportSessionMutualFriendBehavior = 'likes' | 'comments' | 'both'

export interface ExportSessionMutualFriendCacheItem {
  name: string
  incomingLikeCount: number
  incomingCommentCount: number
  outgoingLikeCount: number
  outgoingCommentCount: number
  totalCount: number
  latestTime: number
  direction: ExportSessionMutualFriendDirection
  behavior: ExportSessionMutualFriendBehavior
}

export interface ExportSessionMutualFriendsCacheEntry {
  count: number
  items: ExportSessionMutualFriendCacheItem[]
  loadedPosts: number
  totalPosts: number | null
  computedAt: number
}

export interface ExportSessionMutualFriendsCacheItem {
  updatedAt: number
  metrics: Record<string, ExportSessionMutualFriendsCacheEntry>
}

export interface SnsPageOverviewCache {
  totalPosts: number
  totalFriends: number
  myPosts: number | null
  earliestTime: number | null
  latestTime: number | null
}

export interface SnsPageCacheItem {
  updatedAt: number
  overviewStats: SnsPageOverviewCache
  posts: unknown[]
}

export interface ContactsListCacheContact {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  alias?: string
  labels?: string[]
  detailDescription?: string
  region?: string
  type: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
}

export interface ContactsListCacheItem {
  updatedAt: number
  contacts: ContactsListCacheContact[]
}

export interface ContactsAvatarCacheEntry {
  avatarUrl: string
  updatedAt: number
  checkedAt: number
}

export interface ContactsAvatarCacheItem {
  updatedAt: number
  avatars: Record<string, ContactsAvatarCacheEntry>
}

export async function getExportSessionMessageCountCache(scopeKey: string): Promise<ExportSessionMessageCountCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.EXPORT_SESSION_MESSAGE_COUNT_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const rawUpdatedAt = (rawItem as Record<string, unknown>).updatedAt
  const rawCounts = (rawItem as Record<string, unknown>).counts
  if (!rawCounts || typeof rawCounts !== 'object') return null

  const counts: Record<string, number> = {}
  for (const [sessionId, countRaw] of Object.entries(rawCounts as Record<string, unknown>)) {
    if (typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0) {
      counts[sessionId] = Math.floor(countRaw)
    }
  }

  return {
    updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
    counts
  }
}

export async function setExportSessionMessageCountCache(scopeKey: string, counts: Record<string, number>): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_SESSION_MESSAGE_COUNT_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalized: Record<string, number> = {}
  for (const [sessionId, countRaw] of Object.entries(counts || {})) {
    if (typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0) {
      normalized[sessionId] = Math.floor(countRaw)
    }
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    counts: normalized
  }
  await config.set(CONFIG_KEYS.EXPORT_SESSION_MESSAGE_COUNT_CACHE_MAP, map)
}

export async function getExportSessionContentMetricCache(scopeKey: string): Promise<ExportSessionContentMetricCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.EXPORT_SESSION_CONTENT_METRIC_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const rawUpdatedAt = (rawItem as Record<string, unknown>).updatedAt
  const rawMetrics = (rawItem as Record<string, unknown>).metrics
  if (!rawMetrics || typeof rawMetrics !== 'object') return null

  const metrics: Record<string, ExportSessionContentMetricCacheEntry> = {}
  for (const [sessionId, rawMetric] of Object.entries(rawMetrics as Record<string, unknown>)) {
    if (!rawMetric || typeof rawMetric !== 'object') continue
    const source = rawMetric as Record<string, unknown>
    const metric: ExportSessionContentMetricCacheEntry = {}
    if (typeof source.totalMessages === 'number' && Number.isFinite(source.totalMessages) && source.totalMessages >= 0) {
      metric.totalMessages = Math.floor(source.totalMessages)
    }
    if (typeof source.voiceMessages === 'number' && Number.isFinite(source.voiceMessages) && source.voiceMessages >= 0) {
      metric.voiceMessages = Math.floor(source.voiceMessages)
    }
    if (typeof source.imageMessages === 'number' && Number.isFinite(source.imageMessages) && source.imageMessages >= 0) {
      metric.imageMessages = Math.floor(source.imageMessages)
    }
    if (typeof source.videoMessages === 'number' && Number.isFinite(source.videoMessages) && source.videoMessages >= 0) {
      metric.videoMessages = Math.floor(source.videoMessages)
    }
    if (typeof source.emojiMessages === 'number' && Number.isFinite(source.emojiMessages) && source.emojiMessages >= 0) {
      metric.emojiMessages = Math.floor(source.emojiMessages)
    }
    if (typeof source.firstTimestamp === 'number' && Number.isFinite(source.firstTimestamp) && source.firstTimestamp > 0) {
      metric.firstTimestamp = Math.floor(source.firstTimestamp)
    }
    if (typeof source.lastTimestamp === 'number' && Number.isFinite(source.lastTimestamp) && source.lastTimestamp > 0) {
      metric.lastTimestamp = Math.floor(source.lastTimestamp)
    }
    if (Object.keys(metric).length === 0) continue
    metrics[sessionId] = metric
  }

  return {
    updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
    metrics
  }
}

export async function setExportSessionContentMetricCache(
  scopeKey: string,
  metrics: Record<string, ExportSessionContentMetricCacheEntry>
): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_SESSION_CONTENT_METRIC_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalized: Record<string, ExportSessionContentMetricCacheEntry> = {}
  for (const [sessionId, rawMetric] of Object.entries(metrics || {})) {
    if (!rawMetric || typeof rawMetric !== 'object') continue
    const metric: ExportSessionContentMetricCacheEntry = {}
    if (typeof rawMetric.totalMessages === 'number' && Number.isFinite(rawMetric.totalMessages) && rawMetric.totalMessages >= 0) {
      metric.totalMessages = Math.floor(rawMetric.totalMessages)
    }
    if (typeof rawMetric.voiceMessages === 'number' && Number.isFinite(rawMetric.voiceMessages) && rawMetric.voiceMessages >= 0) {
      metric.voiceMessages = Math.floor(rawMetric.voiceMessages)
    }
    if (typeof rawMetric.imageMessages === 'number' && Number.isFinite(rawMetric.imageMessages) && rawMetric.imageMessages >= 0) {
      metric.imageMessages = Math.floor(rawMetric.imageMessages)
    }
    if (typeof rawMetric.videoMessages === 'number' && Number.isFinite(rawMetric.videoMessages) && rawMetric.videoMessages >= 0) {
      metric.videoMessages = Math.floor(rawMetric.videoMessages)
    }
    if (typeof rawMetric.emojiMessages === 'number' && Number.isFinite(rawMetric.emojiMessages) && rawMetric.emojiMessages >= 0) {
      metric.emojiMessages = Math.floor(rawMetric.emojiMessages)
    }
    if (typeof rawMetric.firstTimestamp === 'number' && Number.isFinite(rawMetric.firstTimestamp) && rawMetric.firstTimestamp > 0) {
      metric.firstTimestamp = Math.floor(rawMetric.firstTimestamp)
    }
    if (typeof rawMetric.lastTimestamp === 'number' && Number.isFinite(rawMetric.lastTimestamp) && rawMetric.lastTimestamp > 0) {
      metric.lastTimestamp = Math.floor(rawMetric.lastTimestamp)
    }
    if (Object.keys(metric).length === 0) continue
    normalized[sessionId] = metric
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    metrics: normalized
  }
  await config.set(CONFIG_KEYS.EXPORT_SESSION_CONTENT_METRIC_CACHE_MAP, map)
}

export async function getExportSnsStatsCache(scopeKey: string): Promise<ExportSnsStatsCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.EXPORT_SNS_STATS_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const raw = rawItem as Record<string, unknown>
  const totalPosts = typeof raw.totalPosts === 'number' && Number.isFinite(raw.totalPosts) && raw.totalPosts >= 0
    ? Math.floor(raw.totalPosts)
    : 0
  const totalFriends = typeof raw.totalFriends === 'number' && Number.isFinite(raw.totalFriends) && raw.totalFriends >= 0
    ? Math.floor(raw.totalFriends)
    : 0
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    ? raw.updatedAt
    : 0

  return { updatedAt, totalPosts, totalFriends }
}

export async function setExportSnsStatsCache(
  scopeKey: string,
  stats: { totalPosts: number; totalFriends: number }
): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_SNS_STATS_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  map[scopeKey] = {
    updatedAt: Date.now(),
    totalPosts: Number.isFinite(stats.totalPosts) ? Math.max(0, Math.floor(stats.totalPosts)) : 0,
    totalFriends: Number.isFinite(stats.totalFriends) ? Math.max(0, Math.floor(stats.totalFriends)) : 0
  }

  await config.set(CONFIG_KEYS.EXPORT_SNS_STATS_CACHE_MAP, map)
}

export async function getExportSnsUserPostCountsCache(scopeKey: string): Promise<ExportSnsUserPostCountsCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.EXPORT_SNS_USER_POST_COUNTS_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const raw = rawItem as Record<string, unknown>
  const rawCounts = raw.counts
  if (!rawCounts || typeof rawCounts !== 'object') return null

  const counts: Record<string, number> = {}
  for (const [rawUsername, rawCount] of Object.entries(rawCounts as Record<string, unknown>)) {
    const username = String(rawUsername || '').trim()
    if (!username) continue
    const valueNum = Number(rawCount)
    counts[username] = Number.isFinite(valueNum) ? Math.max(0, Math.floor(valueNum)) : 0
  }

  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    ? raw.updatedAt
    : 0
  return { updatedAt, counts }
}

export async function setExportSnsUserPostCountsCache(
  scopeKey: string,
  counts: Record<string, number>
): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_SNS_USER_POST_COUNTS_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalized: Record<string, number> = {}
  for (const [rawUsername, rawCount] of Object.entries(counts || {})) {
    const username = String(rawUsername || '').trim()
    if (!username) continue
    const valueNum = Number(rawCount)
    normalized[username] = Number.isFinite(valueNum) ? Math.max(0, Math.floor(valueNum)) : 0
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    counts: normalized
  }

  await config.set(CONFIG_KEYS.EXPORT_SNS_USER_POST_COUNTS_CACHE_MAP, map)
}

const normalizeMutualFriendDirection = (value: unknown): ExportSessionMutualFriendDirection | null => {
  if (value === 'incoming' || value === 'outgoing' || value === 'bidirectional') {
    return value
  }
  return null
}

const normalizeMutualFriendBehavior = (value: unknown): ExportSessionMutualFriendBehavior | null => {
  if (value === 'likes' || value === 'comments' || value === 'both') {
    return value
  }
  return null
}

const normalizeExportSessionMutualFriendsCacheEntry = (raw: unknown): ExportSessionMutualFriendsCacheEntry | null => {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const count = Number(source.count)
  const loadedPosts = Number(source.loadedPosts)
  const computedAt = Number(source.computedAt)
  const itemsRaw = Array.isArray(source.items) ? source.items : []
  const totalPostsRaw = source.totalPosts
  const totalPosts = totalPostsRaw === null || totalPostsRaw === undefined
    ? null
    : Number(totalPostsRaw)

  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(loadedPosts) || loadedPosts < 0 || !Number.isFinite(computedAt) || computedAt < 0) {
    return null
  }

  const items: ExportSessionMutualFriendCacheItem[] = []
  for (const itemRaw of itemsRaw) {
    if (!itemRaw || typeof itemRaw !== 'object') continue
    const item = itemRaw as Record<string, unknown>
    const name = String(item.name || '').trim()
    const direction = normalizeMutualFriendDirection(item.direction)
    const behavior = normalizeMutualFriendBehavior(item.behavior)
    const incomingLikeCount = Number(item.incomingLikeCount)
    const incomingCommentCount = Number(item.incomingCommentCount)
    const outgoingLikeCount = Number(item.outgoingLikeCount)
    const outgoingCommentCount = Number(item.outgoingCommentCount)
    const totalCount = Number(item.totalCount)
    const latestTime = Number(item.latestTime)
    if (!name || !direction || !behavior) continue
    if (
      !Number.isFinite(incomingLikeCount) || incomingLikeCount < 0 ||
      !Number.isFinite(incomingCommentCount) || incomingCommentCount < 0 ||
      !Number.isFinite(outgoingLikeCount) || outgoingLikeCount < 0 ||
      !Number.isFinite(outgoingCommentCount) || outgoingCommentCount < 0 ||
      !Number.isFinite(totalCount) || totalCount < 0 ||
      !Number.isFinite(latestTime) || latestTime < 0
    ) {
      continue
    }
    items.push({
      name,
      incomingLikeCount: Math.floor(incomingLikeCount),
      incomingCommentCount: Math.floor(incomingCommentCount),
      outgoingLikeCount: Math.floor(outgoingLikeCount),
      outgoingCommentCount: Math.floor(outgoingCommentCount),
      totalCount: Math.floor(totalCount),
      latestTime: Math.floor(latestTime),
      direction,
      behavior
    })
  }

  return {
    count: Math.floor(count),
    items,
    loadedPosts: Math.floor(loadedPosts),
    totalPosts: totalPosts === null
      ? null
      : (Number.isFinite(totalPosts) && totalPosts >= 0 ? Math.floor(totalPosts) : null),
    computedAt: Math.floor(computedAt)
  }
}

export async function getExportSessionMutualFriendsCache(scopeKey: string): Promise<ExportSessionMutualFriendsCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.EXPORT_SESSION_MUTUAL_FRIENDS_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const rawUpdatedAt = (rawItem as Record<string, unknown>).updatedAt
  const rawMetrics = (rawItem as Record<string, unknown>).metrics
  if (!rawMetrics || typeof rawMetrics !== 'object') return null

  const metrics: Record<string, ExportSessionMutualFriendsCacheEntry> = {}
  for (const [sessionIdRaw, metricRaw] of Object.entries(rawMetrics as Record<string, unknown>)) {
    const sessionId = String(sessionIdRaw || '').trim()
    if (!sessionId) continue
    const metric = normalizeExportSessionMutualFriendsCacheEntry(metricRaw)
    if (!metric) continue
    metrics[sessionId] = metric
  }

  return {
    updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
    metrics
  }
}

export async function setExportSessionMutualFriendsCache(
  scopeKey: string,
  metrics: Record<string, ExportSessionMutualFriendsCacheEntry>
): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_SESSION_MUTUAL_FRIENDS_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalized: Record<string, ExportSessionMutualFriendsCacheEntry> = {}
  for (const [sessionIdRaw, metricRaw] of Object.entries(metrics || {})) {
    const sessionId = String(sessionIdRaw || '').trim()
    if (!sessionId) continue
    const metric = normalizeExportSessionMutualFriendsCacheEntry(metricRaw)
    if (!metric) continue
    normalized[sessionId] = metric
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    metrics: normalized
  }

  await config.set(CONFIG_KEYS.EXPORT_SESSION_MUTUAL_FRIENDS_CACHE_MAP, map)
}

export async function clearExportSessionMutualFriendsCache(scopeKey: string): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_SESSION_MUTUAL_FRIENDS_CACHE_MAP)
  if (!current || typeof current !== 'object') return
  const map = { ...(current as Record<string, unknown>) }
  if (!(scopeKey in map)) return
  delete map[scopeKey]
  await config.set(CONFIG_KEYS.EXPORT_SESSION_MUTUAL_FRIENDS_CACHE_MAP, map)
}

export async function getSnsPageCache(scopeKey: string): Promise<SnsPageCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.SNS_PAGE_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const raw = rawItem as Record<string, unknown>
  const rawOverview = raw.overviewStats
  const rawPosts = raw.posts
  if (!rawOverview || typeof rawOverview !== 'object' || !Array.isArray(rawPosts)) return null

  const overviewObj = rawOverview as Record<string, unknown>
  const normalizeNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0)
  const normalizeNullableTimestamp = (v: unknown) => {
    if (v === null || v === undefined) return null
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
    return null
  }
  const normalizeNullableCount = (v: unknown) => {
    if (v === null || v === undefined) return null
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v)
    return null
  }

  return {
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    overviewStats: {
      totalPosts: Math.max(0, normalizeNumber(overviewObj.totalPosts)),
      totalFriends: Math.max(0, normalizeNumber(overviewObj.totalFriends)),
      myPosts: normalizeNullableCount(overviewObj.myPosts),
      earliestTime: normalizeNullableTimestamp(overviewObj.earliestTime),
      latestTime: normalizeNullableTimestamp(overviewObj.latestTime)
    },
    posts: rawPosts
  }
}

export async function setSnsPageCache(
  scopeKey: string,
  payload: { overviewStats: SnsPageOverviewCache; posts: unknown[] }
): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.SNS_PAGE_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalizeNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)
  const normalizeNullableTimestamp = (v: unknown) => {
    if (v === null || v === undefined) return null
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
    return null
  }
  const normalizeNullableCount = (v: unknown) => {
    if (v === null || v === undefined) return null
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v)
    return null
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    overviewStats: {
      totalPosts: normalizeNumber(payload?.overviewStats?.totalPosts),
      totalFriends: normalizeNumber(payload?.overviewStats?.totalFriends),
      myPosts: normalizeNullableCount(payload?.overviewStats?.myPosts),
      earliestTime: normalizeNullableTimestamp(payload?.overviewStats?.earliestTime),
      latestTime: normalizeNullableTimestamp(payload?.overviewStats?.latestTime)
    },
    posts: Array.isArray(payload?.posts) ? payload.posts : []
  }

  await config.set(CONFIG_KEYS.SNS_PAGE_CACHE_MAP, map)
}

// 获取通讯录加载超时阈值（毫秒）
export async function getContactsLoadTimeoutMs(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.CONTACTS_LOAD_TIMEOUT_MS)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1000 && value <= 60000) {
    const normalized = Math.floor(value)
    // 兼容历史默认值 3000ms：自动提升到新的更稳妥阈值。
    return normalized === 3000 ? 10000 : normalized
  }
  return 10000
}

// 设置通讯录加载超时阈值（毫秒）
export async function setContactsLoadTimeoutMs(timeoutMs: number): Promise<void> {
  const normalized = Number.isFinite(timeoutMs)
    ? Math.min(60000, Math.max(1000, Math.floor(timeoutMs)))
    : 10000
  await config.set(CONFIG_KEYS.CONTACTS_LOAD_TIMEOUT_MS, normalized)
}

export async function getContactsListCache(scopeKey: string): Promise<ContactsListCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.CONTACTS_LIST_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const rawUpdatedAt = (rawItem as Record<string, unknown>).updatedAt
  const rawContacts = (rawItem as Record<string, unknown>).contacts
  if (!Array.isArray(rawContacts)) return null

  const contacts: ContactsListCacheContact[] = []
  for (const raw of rawContacts) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const username = typeof item.username === 'string' ? item.username.trim() : ''
    if (!username) continue
    const displayName = typeof item.displayName === 'string' ? item.displayName : username
    const type = typeof item.type === 'string' ? item.type : 'other'
    contacts.push({
      username,
      displayName,
      remark: typeof item.remark === 'string' ? item.remark : undefined,
      nickname: typeof item.nickname === 'string' ? item.nickname : undefined,
      alias: typeof item.alias === 'string' ? item.alias : undefined,
      labels: Array.isArray(item.labels)
        ? Array.from(new Set(item.labels.map((label) => String(label || '').trim()).filter(Boolean)))
        : undefined,
      detailDescription: typeof item.detailDescription === 'string' ? (item.detailDescription.trim() || undefined) : undefined,
      region: typeof item.region === 'string' ? (item.region.trim() || undefined) : undefined,
      type: (type === 'friend' || type === 'group' || type === 'official' || type === 'former_friend' || type === 'other')
        ? type
        : 'other'
    })
  }

  return {
    updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
    contacts
  }
}

export async function setContactsListCache(scopeKey: string, contacts: ContactsListCacheContact[]): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.CONTACTS_LIST_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalized: ContactsListCacheContact[] = []
  for (const contact of contacts || []) {
    const username = String(contact?.username || '').trim()
    if (!username) continue
    const displayName = String(contact?.displayName || username)
    const type = contact?.type || 'other'
    if (type !== 'friend' && type !== 'group' && type !== 'official' && type !== 'former_friend' && type !== 'other') {
      continue
    }
    normalized.push({
      username,
      displayName,
      remark: contact?.remark ? String(contact.remark) : undefined,
      nickname: contact?.nickname ? String(contact.nickname) : undefined,
      alias: contact?.alias ? String(contact.alias) : undefined,
      labels: Array.isArray(contact?.labels)
        ? Array.from(new Set(contact.labels.map((label) => String(label || '').trim()).filter(Boolean)))
        : undefined,
      detailDescription: contact?.detailDescription ? (String(contact.detailDescription).trim() || undefined) : undefined,
      region: contact?.region ? (String(contact.region).trim() || undefined) : undefined,
      type
    })
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    contacts: normalized
  }
  await config.set(CONFIG_KEYS.CONTACTS_LIST_CACHE_MAP, map)
}

export async function getContactsAvatarCache(scopeKey: string): Promise<ContactsAvatarCacheItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.CONTACTS_AVATAR_CACHE_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const rawUpdatedAt = (rawItem as Record<string, unknown>).updatedAt
  const rawAvatars = (rawItem as Record<string, unknown>).avatars
  if (!rawAvatars || typeof rawAvatars !== 'object') return null

  const avatars: Record<string, ContactsAvatarCacheEntry> = {}
  for (const [rawUsername, rawEntry] of Object.entries(rawAvatars as Record<string, unknown>)) {
    const username = rawUsername.trim()
    if (!username) continue

    if (typeof rawEntry === 'string') {
      const avatarUrl = rawEntry.trim()
      if (!avatarUrl) continue
      avatars[username] = {
        avatarUrl,
        updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
        checkedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0
      }
      continue
    }

    if (!rawEntry || typeof rawEntry !== 'object') continue
    const entry = rawEntry as Record<string, unknown>
    const avatarUrl = typeof entry.avatarUrl === 'string' ? entry.avatarUrl.trim() : ''
    if (!avatarUrl) continue
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : 0
    const checkedAt = typeof entry.checkedAt === 'number' && Number.isFinite(entry.checkedAt)
      ? entry.checkedAt
      : updatedAt

    avatars[username] = {
      avatarUrl,
      updatedAt,
      checkedAt
    }
  }

  return {
    updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
    avatars
  }
}

export async function setContactsAvatarCache(
  scopeKey: string,
  avatars: Record<string, ContactsAvatarCacheEntry>
): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.CONTACTS_AVATAR_CACHE_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}

  const normalized: Record<string, ContactsAvatarCacheEntry> = {}
  for (const [rawUsername, rawEntry] of Object.entries(avatars || {})) {
    const username = String(rawUsername || '').trim()
    if (!username || !rawEntry || typeof rawEntry !== 'object') continue
    const avatarUrl = String(rawEntry.avatarUrl || '').trim()
    if (!avatarUrl) continue
    const updatedAt = Number.isFinite(rawEntry.updatedAt)
      ? Math.max(0, Math.floor(rawEntry.updatedAt))
      : Date.now()
    const checkedAt = Number.isFinite(rawEntry.checkedAt)
      ? Math.max(0, Math.floor(rawEntry.checkedAt))
      : updatedAt
    normalized[username] = {
      avatarUrl,
      updatedAt,
      checkedAt
    }
  }

  map[scopeKey] = {
    updatedAt: Date.now(),
    avatars: normalized
  }
  await config.set(CONFIG_KEYS.CONTACTS_AVATAR_CACHE_MAP, map)
}

// === 安全相关 ===

export async function getAuthEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AUTH_ENABLED)
  return value === true
}

export async function setAuthEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_ENABLED, enabled)
}

export async function getAuthPassword(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AUTH_PASSWORD)
  return (value as string) || ''
}

export async function setAuthPassword(passwordHash: string): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_PASSWORD, passwordHash)
}

export async function getAuthUseHello(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AUTH_USE_HELLO)
  return value === true
}

export async function setAuthUseHello(useHello: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_USE_HELLO, useHello)
}

// === 更新相关 ===

// 获取被忽略的更新版本
export async function getIgnoredUpdateVersion(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.IGNORED_UPDATE_VERSION)
  return (value as string) || null
}

// 设置被忽略的更新版本
export async function setIgnoredUpdateVersion(version: string): Promise<void> {
  await config.set(CONFIG_KEYS.IGNORED_UPDATE_VERSION, version)
}

// 获取通知开关
export async function getNotificationEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.NOTIFICATION_ENABLED)
  return value !== false // 默认为 true
}

// 设置通知开关
export async function setNotificationEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.NOTIFICATION_ENABLED, enabled)
}

// 获取通知位置
export async function getNotificationPosition(): Promise<'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'> {
  const value = await config.get(CONFIG_KEYS.NOTIFICATION_POSITION)
  return (value as any) || 'top-right'
}

// 设置通知位置
export async function setNotificationPosition(position: string): Promise<void> {
  await config.set(CONFIG_KEYS.NOTIFICATION_POSITION, position)
}

// 获取通知过滤模式
export async function getNotificationFilterMode(): Promise<'all' | 'whitelist' | 'blacklist'> {
  const value = await config.get(CONFIG_KEYS.NOTIFICATION_FILTER_MODE)
  return (value as any) || 'all'
}

// 设置通知过滤模式
export async function setNotificationFilterMode(mode: 'all' | 'whitelist' | 'blacklist'): Promise<void> {
  await config.set(CONFIG_KEYS.NOTIFICATION_FILTER_MODE, mode)
}

// 获取通知过滤列表
export async function getNotificationFilterList(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.NOTIFICATION_FILTER_LIST)
  return Array.isArray(value) ? value : []
}

// 设置通知过滤列表
export async function setNotificationFilterList(list: string[]): Promise<void> {
  await config.set(CONFIG_KEYS.NOTIFICATION_FILTER_LIST, list)
}

export async function getMessagePushEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.MESSAGE_PUSH_ENABLED)
  return value === true
}

export async function setMessagePushEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.MESSAGE_PUSH_ENABLED, enabled)
}

export async function getWindowCloseBehavior(): Promise<WindowCloseBehavior> {
  const value = await config.get(CONFIG_KEYS.WINDOW_CLOSE_BEHAVIOR)
  if (value === 'tray' || value === 'quit') return value
  return 'ask'
}

export async function setWindowCloseBehavior(behavior: WindowCloseBehavior): Promise<void> {
  await config.set(CONFIG_KEYS.WINDOW_CLOSE_BEHAVIOR, behavior)
}

export async function getQuoteLayout(): Promise<QuoteLayout> {
  const value = await config.get(CONFIG_KEYS.QUOTE_LAYOUT)
  if (value === 'quote-bottom') return value
  return 'quote-top'
}

export async function setQuoteLayout(layout: QuoteLayout): Promise<void> {
  await config.set(CONFIG_KEYS.QUOTE_LAYOUT, layout)
}

// 获取词云排除词列表
export async function getWordCloudExcludeWords(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.WORD_CLOUD_EXCLUDE_WORDS)
  return Array.isArray(value) ? value : []
}

// 设置词云排除词列表
export async function setWordCloudExcludeWords(words: string[]): Promise<void> {
  await config.set(CONFIG_KEYS.WORD_CLOUD_EXCLUDE_WORDS, words)
}

// 获取数据收集同意状态
export async function getAnalyticsConsent(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.ANALYTICS_CONSENT)
  if (typeof value === 'boolean') return value
  return null
}

// 设置数据收集同意状态
export async function setAnalyticsConsent(consent: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.ANALYTICS_CONSENT, consent)
}

// 获取数据收集拒绝次数
export async function getAnalyticsDenyCount(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.ANALYTICS_DENY_COUNT)
  return typeof value === 'number' ? value : 0
}

// 设置数据收集拒绝次数
export async function setAnalyticsDenyCount(count: number): Promise<void> {
  await config.set(CONFIG_KEYS.ANALYTICS_DENY_COUNT, count)
}


// 获取 HTTP API 自动启动状态
export async function getHttpApiEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_ENABLED)
  return value === true
}

// 设置 HTTP API 自动启动状态
export async function setHttpApiEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.HTTP_API_ENABLED, enabled)
}

// 获取 HTTP API 端口
export async function getHttpApiPort(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_PORT)
  return typeof value === 'number' ? value : 5031
}

// 设置 HTTP API 端口
export async function setHttpApiPort(port: number): Promise<void> {
  await config.set(CONFIG_KEYS.HTTP_API_PORT, port)
}

export async function getHttpApiHost(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_HOST)
  return typeof value === 'string' && value.trim() ? value.trim() : '127.0.0.1'
}

export async function setHttpApiHost(host: string): Promise<void> {
  await config.set(CONFIG_KEYS.HTTP_API_HOST, host)
}
