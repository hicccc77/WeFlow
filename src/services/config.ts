// 配置服务 - 封装 Electron Store
import { config } from './ipc'
import type { ExportDefaultDateRangeConfig } from '../utils/exportDateRange'
import type { ExportAutomationTask } from '../types/exportAutomation'

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
  LAUNCH_AT_STARTUP: 'launchAtStartup',
  SILENT_STARTUP: 'silentStartup',

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
  EXPORT_DEFAULT_FILE_NAMING_MODE: 'exportDefaultFileNamingMode',
  EXPORT_DEFAULT_MEDIA: 'exportDefaultMedia',
  EXPORT_DEFAULT_VOICE_AS_TEXT: 'exportDefaultVoiceAsText',
  EXPORT_DEFAULT_EXCEL_COMPACT_COLUMNS: 'exportDefaultExcelCompactColumns',
  EXPORT_DEFAULT_TXT_COLUMNS: 'exportDefaultTxtColumns',
  EXPORT_DEFAULT_CONCURRENCY: 'exportDefaultConcurrency',
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
  EXPORT_AUTOMATION_TASK_MAP: 'exportAutomationTaskMap',
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
  UPDATE_CHANNEL: 'updateChannel',

  // 通知
  NOTIFICATION_ENABLED: 'notificationEnabled',
  AI_INSIGHT_NOTIFICATION_ENABLED: 'aiInsightNotificationEnabled',
  NOTIFICATION_POSITION: 'notificationPosition',
  NOTIFICATION_FILTER_MODE: 'notificationFilterMode',
  NOTIFICATION_FILTER_LIST: 'notificationFilterList',
  HTTP_API_TOKEN: 'httpApiToken',
  HTTP_API_ENABLED: 'httpApiEnabled',
  HTTP_API_PORT: 'httpApiPort',
  HTTP_API_HOST: 'httpApiHost',
  MESSAGE_PUSH_ENABLED: 'messagePushEnabled',
  MESSAGE_PUSH_FILTER_MODE: 'messagePushFilterMode',
  MESSAGE_PUSH_FILTER_LIST: 'messagePushFilterList',
  WINDOW_CLOSE_BEHAVIOR: 'windowCloseBehavior',
  QUOTE_LAYOUT: 'quoteLayout',

  // 词云
  WORD_CLOUD_EXCLUDE_WORDS: 'wordCloudExcludeWords',

  // 数据收集
  ANALYTICS_CONSENT: 'analyticsConsent',
  ANALYTICS_DENY_COUNT: 'analyticsDenyCount',

  // AI 见解
  AI_MODEL_API_BASE_URL: 'aiModelApiBaseUrl',
  AI_MODEL_API_KEY: 'aiModelApiKey',
  AI_MODEL_API_MODEL: 'aiModelApiModel',
  AI_MODEL_API_MAX_TOKENS: 'aiModelApiMaxTokens',
  AI_INSIGHT_ENABLED: 'aiInsightEnabled',
  AI_INSIGHT_API_BASE_URL: 'aiInsightApiBaseUrl',
  AI_INSIGHT_API_KEY: 'aiInsightApiKey',
  AI_INSIGHT_API_MODEL: 'aiInsightApiModel',
  AI_INSIGHT_SILENCE_DAYS: 'aiInsightSilenceDays',
  AI_INSIGHT_ALLOW_CONTEXT: 'aiInsightAllowContext',
  AI_INSIGHT_ALLOW_MOMENTS_CONTEXT: 'aiInsightAllowMomentsContext',
  AI_INSIGHT_MOMENTS_CONTEXT_COUNT: 'aiInsightMomentsContextCount',
  AI_INSIGHT_MOMENTS_BINDINGS: 'aiInsightMomentsBindings',
  AI_INSIGHT_ALLOW_SOCIAL_CONTEXT: 'aiInsightAllowSocialContext',
  AI_INSIGHT_FILTER_MODE: 'aiInsightFilterMode',
  AI_INSIGHT_FILTER_LIST: 'aiInsightFilterList',
  AI_INSIGHT_WHITELIST_ENABLED: 'aiInsightWhitelistEnabled',
  AI_INSIGHT_WHITELIST: 'aiInsightWhitelist',
  AI_INSIGHT_COOLDOWN_MINUTES: 'aiInsightCooldownMinutes',
  AI_INSIGHT_SCAN_INTERVAL_HOURS: 'aiInsightScanIntervalHours',
  AI_INSIGHT_CONTEXT_COUNT: 'aiInsightContextCount',
  AI_INSIGHT_SOCIAL_CONTEXT_COUNT: 'aiInsightSocialContextCount',
  AI_INSIGHT_SYSTEM_PROMPT: 'aiInsightSystemPrompt',
  AI_INSIGHT_TELEGRAM_ENABLED: 'aiInsightTelegramEnabled',
  AI_INSIGHT_TELEGRAM_TOKEN: 'aiInsightTelegramToken',
  AI_INSIGHT_TELEGRAM_CHAT_IDS: 'aiInsightTelegramChatIds',
  AI_INSIGHT_WEIBO_COOKIE: 'aiInsightWeiboCookie',
  AI_INSIGHT_WEIBO_BINDINGS: 'aiInsightWeiboBindings',

  // AI 足迹
  AI_FOOTPRINT_ENABLED: 'aiFootprintEnabled',
  AI_FOOTPRINT_SYSTEM_PROMPT: 'aiFootprintSystemPrompt',
  AI_INSIGHT_DEBUG_LOG_ENABLED: 'aiInsightDebugLogEnabled',
  AUTO_DOWNLOAD_HIGH_RES: 'autoDownloadHighRes',
  AUTO_DOWNLOAD_WHITELIST: 'autoDownloadWhitelist'
} as const

export interface WxidConfig {
  decryptKey?: string
  imageXorKey?: number
  imageAesKey?: string
  updatedAt?: number
}

export interface AiInsightWeiboBinding {
  uid: string
  screenName?: string
  updatedAt: number
}

export interface AiInsightMomentsBinding {
  enabled: boolean
  updatedAt: number
}

export interface ExportDefaultMediaConfig {
  images: boolean
  videos: boolean
  voices: boolean
  emojis: boolean
  files: boolean
}

export type ExportFileNamingMode = 'classic' | 'date-range'

export type WindowCloseBehavior = 'ask' | 'tray' | 'quit'
export type QuoteLayout = 'quote-top' | 'quote-bottom'
export type UpdateChannel = 'stable' | 'preview' | 'dev'

const DEFAULT_EXPORT_MEDIA_CONFIG: ExportDefaultMediaConfig = {
  images: true,
  videos: true,
  voices: true,
  emojis: true,
  files: true
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

export async function setWxidConfigs(configs: Record<string, WxidConfig>): Promise<void> {
  await config.set(CONFIG_KEYS.WXID_CONFIGS, configs || {})
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

// 获取开机自启动偏好
export async function getLaunchAtStartup(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.LAUNCH_AT_STARTUP)
  if (typeof value === 'boolean') return value
  return null
}

// 设置开机自启动偏好
export async function setLaunchAtStartup(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.LAUNCH_AT_STARTUP, enabled)
}

// 获取静默启动偏好
export async function getSilentStartup(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.SILENT_STARTUP)
  return value === true
}

// 设置静默启动偏好
export async function setSilentStartup(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.SILENT_STARTUP, enabled)
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

// 获取导出默认文件命名方式
export async function getExportDefaultFileNamingMode(): Promise<ExportFileNamingMode | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_FILE_NAMING_MODE)
  if (value === 'classic' || value === 'date-range') return value
  return null
}

// 设置导出默认文件命名方式
export async function setExportDefaultFileNamingMode(mode: ExportFileNamingMode): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_FILE_NAMING_MODE, mode)
}

// 获取导出默认媒体设置
export async function getExportDefaultMedia(): Promise<ExportDefaultMediaConfig | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_MEDIA)
  if (typeof value === 'boolean') {
    return {
      images: value,
      videos: value,
      voices: value,
      emojis: value,
      files: value
    }
  }
  if (value && typeof value === 'object') {
    const raw = value as Partial<Record<keyof ExportDefaultMediaConfig, unknown>>
    return {
      images: typeof raw.images === 'boolean' ? raw.images : DEFAULT_EXPORT_MEDIA_CONFIG.images,
      videos: typeof raw.videos === 'boolean' ? raw.videos : DEFAULT_EXPORT_MEDIA_CONFIG.videos,
      voices: typeof raw.voices === 'boolean' ? raw.voices : DEFAULT_EXPORT_MEDIA_CONFIG.voices,
      emojis: typeof raw.emojis === 'boolean' ? raw.emojis : DEFAULT_EXPORT_MEDIA_CONFIG.emojis,
      files: typeof raw.files === 'boolean' ? raw.files : DEFAULT_EXPORT_MEDIA_CONFIG.files
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
    emojis: media.emojis,
    files: media.files
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

export interface ExportAutomationTaskMapItem {
  updatedAt: number
  tasks: ExportAutomationTask[]
}

const normalizeAutomationNumeric = (value: unknown, fallback: number): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.floor(numeric)
}

const normalizeAutomationTask = (raw: unknown): ExportAutomationTask | null => {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>

  const id = String(source.id || '').trim()
  const name = String(source.name || '').trim()
  if (!id || !name) return null

  const sessionIds = Array.isArray(source.sessionIds)
    ? Array.from(new Set(source.sessionIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : []
  const sessionNames = Array.isArray(source.sessionNames)
    ? source.sessionNames.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  if (sessionIds.length === 0) return null

  const scheduleRaw = source.schedule
  if (!scheduleRaw || typeof scheduleRaw !== 'object') return null
  const scheduleObj = scheduleRaw as Record<string, unknown>
  const scheduleType = String(scheduleObj.type || '').trim() as ExportAutomationTask['schedule']['type']
  let schedule: ExportAutomationTask['schedule'] | null = null
  if (scheduleType === 'interval') {
    const rawDays = Math.max(0, normalizeAutomationNumeric(scheduleObj.intervalDays, 0))
    const rawHours = Math.max(0, normalizeAutomationNumeric(scheduleObj.intervalHours, 0))
    const rawFirstTriggerAt = Math.max(0, normalizeAutomationNumeric(scheduleObj.firstTriggerAt, 0))
    const totalHours = (rawDays * 24) + rawHours
    if (totalHours <= 0) return null
    const intervalDays = Math.floor(totalHours / 24)
    const intervalHours = totalHours % 24
    schedule = {
      type: 'interval',
      intervalDays,
      intervalHours,
      firstTriggerAt: rawFirstTriggerAt > 0 ? rawFirstTriggerAt : undefined
    }
  }
  if (!schedule) return null

  const conditionRaw = source.condition
  if (!conditionRaw || typeof conditionRaw !== 'object') return null
  const conditionType = String((conditionRaw as Record<string, unknown>).type || '').trim()
  if (conditionType !== 'new-message-since-last-success') return null

  const templateRaw = source.template
  if (!templateRaw || typeof templateRaw !== 'object') return null
  const template = templateRaw as Record<string, unknown>
  const scope = String(template.scope || '').trim() as ExportAutomationTask['template']['scope']
  if (scope !== 'single' && scope !== 'multi' && scope !== 'content') return null
  const optionTemplate = template.optionTemplate
  if (!optionTemplate || typeof optionTemplate !== 'object') return null
  const dateRangeConfig = template.dateRangeConfig
  const outputDirRaw = String(source.outputDir || '').trim()
  const runStateRaw = source.runState && typeof source.runState === 'object'
    ? (source.runState as Record<string, unknown>)
    : null
  const stopConditionRaw = source.stopCondition && typeof source.stopCondition === 'object'
    ? (source.stopCondition as Record<string, unknown>)
    : null
  const rawContentType = String(template.contentType || '').trim()
  const contentType = (
    rawContentType === 'text' ||
    rawContentType === 'voice' ||
    rawContentType === 'image' ||
    rawContentType === 'video' ||
    rawContentType === 'emoji' ||
    rawContentType === 'file'
  )
    ? rawContentType
    : undefined
  const rawRunStatus = runStateRaw ? String(runStateRaw.lastRunStatus || '').trim() : ''
  const lastRunStatus = (
    rawRunStatus === 'idle' ||
    rawRunStatus === 'queued' ||
    rawRunStatus === 'running' ||
    rawRunStatus === 'success' ||
    rawRunStatus === 'error' ||
    rawRunStatus === 'skipped'
  )
    ? rawRunStatus
    : undefined
  const endAt = stopConditionRaw ? Math.max(0, normalizeAutomationNumeric(stopConditionRaw.endAt, 0)) : 0
  const maxRuns = stopConditionRaw ? Math.max(0, normalizeAutomationNumeric(stopConditionRaw.maxRuns, 0)) : 0

  return {
    id,
    name,
    enabled: source.enabled !== false,
    sessionIds,
    sessionNames,
    outputDir: outputDirRaw || undefined,
    schedule,
    condition: { type: 'new-message-since-last-success' },
    stopCondition: (endAt > 0 || maxRuns > 0)
      ? {
          endAt: endAt > 0 ? endAt : undefined,
          maxRuns: maxRuns > 0 ? maxRuns : undefined
        }
      : undefined,
    template: {
      scope,
      contentType,
      optionTemplate: optionTemplate as ExportAutomationTask['template']['optionTemplate'],
      dateRangeConfig: (dateRangeConfig ?? null) as ExportAutomationTask['template']['dateRangeConfig']
    },
    runState: runStateRaw
      ? {
          lastRunStatus,
          lastTriggeredAt: normalizeAutomationNumeric(runStateRaw.lastTriggeredAt, 0) || undefined,
          lastStartedAt: normalizeAutomationNumeric(runStateRaw.lastStartedAt, 0) || undefined,
          lastFinishedAt: normalizeAutomationNumeric(runStateRaw.lastFinishedAt, 0) || undefined,
          lastSuccessAt: normalizeAutomationNumeric(runStateRaw.lastSuccessAt, 0) || undefined,
          lastSkipAt: normalizeAutomationNumeric(runStateRaw.lastSkipAt, 0) || undefined,
          lastSkipReason: String(runStateRaw.lastSkipReason || '').trim() || undefined,
          lastError: String(runStateRaw.lastError || '').trim() || undefined,
          lastScheduleKey: String(runStateRaw.lastScheduleKey || '').trim() || undefined,
          successCount: Math.max(0, normalizeAutomationNumeric(runStateRaw.successCount, 0)) || undefined
        }
      : undefined,
    createdAt: Math.max(0, normalizeAutomationNumeric(source.createdAt, Date.now())),
    updatedAt: Math.max(0, normalizeAutomationNumeric(source.updatedAt, Date.now()))
  }
}

export async function getExportAutomationTasks(scopeKey: string): Promise<ExportAutomationTaskMapItem | null> {
  if (!scopeKey) return null
  const value = await config.get(CONFIG_KEYS.EXPORT_AUTOMATION_TASK_MAP)
  if (!value || typeof value !== 'object') return null
  const rawMap = value as Record<string, unknown>
  const rawItem = rawMap[scopeKey]
  if (!rawItem || typeof rawItem !== 'object') return null

  const item = rawItem as Record<string, unknown>
  const updatedAt = Number(item.updatedAt)
  const rawTasks = Array.isArray(item.tasks)
    ? item.tasks
    : (Array.isArray(rawItem) ? rawItem : [])
  const tasks: ExportAutomationTask[] = []
  for (const rawTask of rawTasks) {
    const normalized = normalizeAutomationTask(rawTask)
    if (normalized) {
      tasks.push(normalized)
    }
  }
  return {
    updatedAt: Number.isFinite(updatedAt) ? Math.max(0, Math.floor(updatedAt)) : 0,
    tasks
  }
}

export async function setExportAutomationTasks(scopeKey: string, tasks: ExportAutomationTask[]): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_AUTOMATION_TASK_MAP)
  const map = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}
  map[scopeKey] = {
    updatedAt: Date.now(),
    tasks: (Array.isArray(tasks) ? tasks : []).map((task) => ({ ...task }))
  }
  await config.set(CONFIG_KEYS.EXPORT_AUTOMATION_TASK_MAP, map)
}

export async function clearExportAutomationTasks(scopeKey: string): Promise<void> {
  if (!scopeKey) return
  const current = await config.get(CONFIG_KEYS.EXPORT_AUTOMATION_TASK_MAP)
  if (!current || typeof current !== 'object') return
  const map = { ...(current as Record<string, unknown>) }
  if (!(scopeKey in map)) return
  delete map[scopeKey]
  await config.set(CONFIG_KEYS.EXPORT_AUTOMATION_TASK_MAP, map)
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

// 获取更新渠道（空值/auto 视为未显式设置，交由安装包类型决定默认渠道）
export async function getUpdateChannel(): Promise<UpdateChannel | null> {
  const value = await config.get(CONFIG_KEYS.UPDATE_CHANNEL)
  if (value === 'stable' || value === 'preview' || value === 'dev') return value
  return null
}

// 设置更新渠道
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await config.set(CONFIG_KEYS.UPDATE_CHANNEL, channel)
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

export async function getAiInsightNotificationEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_NOTIFICATION_ENABLED)
  return value !== false
}

export async function setAiInsightNotificationEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_NOTIFICATION_ENABLED, enabled)
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

export type MessagePushFilterMode = 'all' | 'whitelist' | 'blacklist'
export type MessagePushSessionType = 'private' | 'group' | 'official' | 'other'

export async function getMessagePushFilterMode(): Promise<MessagePushFilterMode> {
  const value = await config.get(CONFIG_KEYS.MESSAGE_PUSH_FILTER_MODE)
  if (value === 'whitelist' || value === 'blacklist') return value
  return 'all'
}

export async function setMessagePushFilterMode(mode: MessagePushFilterMode): Promise<void> {
  await config.set(CONFIG_KEYS.MESSAGE_PUSH_FILTER_MODE, mode)
}

export async function getMessagePushFilterList(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.MESSAGE_PUSH_FILTER_LIST)
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : []
}

export async function setMessagePushFilterList(list: string[]): Promise<void> {
  const normalized = Array.from(new Set((list || []).map(item => String(item || '').trim()).filter(Boolean)))
  await config.set(CONFIG_KEYS.MESSAGE_PUSH_FILTER_LIST, normalized)
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

// ─── AI 见解 ──────────────────────────────────────────────────────────────────

export async function getAiModelApiBaseUrl(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_MODEL_API_BASE_URL)
  if (typeof value === 'string' && value.trim()) return value
  const legacy = await config.get(CONFIG_KEYS.AI_INSIGHT_API_BASE_URL)
  return typeof legacy === 'string' ? legacy : ''
}

export async function setAiModelApiBaseUrl(url: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_MODEL_API_BASE_URL, url)
}

export async function getAiModelApiKey(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_MODEL_API_KEY)
  if (typeof value === 'string' && value.trim()) return value
  const legacy = await config.get(CONFIG_KEYS.AI_INSIGHT_API_KEY)
  return typeof legacy === 'string' ? legacy : ''
}

export async function setAiModelApiKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_MODEL_API_KEY, key)
}

export async function getAiModelApiModel(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_MODEL_API_MODEL)
  if (typeof value === 'string' && value.trim()) return value.trim()
  const legacy = await config.get(CONFIG_KEYS.AI_INSIGHT_API_MODEL)
  return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : 'gpt-4o-mini'
}

export async function setAiModelApiModel(model: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_MODEL_API_MODEL, model)
}

export async function getAiModelApiMaxTokens(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_MODEL_API_MAX_TOKENS)
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  return 200
}

export async function setAiModelApiMaxTokens(maxTokens: number): Promise<void> {
  const normalized = Number.isFinite(maxTokens)
    ? Math.min(65535, Math.max(1, Math.floor(maxTokens)))
    : 200
  await config.set(CONFIG_KEYS.AI_MODEL_API_MAX_TOKENS, normalized)
}

export async function getAiInsightEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_ENABLED)
  return value === true
}

export async function setAiInsightEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_ENABLED, enabled)
}

export async function getAiInsightApiBaseUrl(): Promise<string> {
  return getAiModelApiBaseUrl()
}

export async function setAiInsightApiBaseUrl(url: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_API_BASE_URL, url)
  await setAiModelApiBaseUrl(url)
}

export async function getAiInsightApiKey(): Promise<string> {
  return getAiModelApiKey()
}

export async function setAiInsightApiKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_API_KEY, key)
  await setAiModelApiKey(key)
}

export async function getAiInsightApiModel(): Promise<string> {
  return getAiModelApiModel()
}

export async function setAiInsightApiModel(model: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_API_MODEL, model)
  await setAiModelApiModel(model)
}

export async function getAiInsightSilenceDays(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_SILENCE_DAYS)
  return typeof value === 'number' && value > 0 ? value : 3
}

export async function setAiInsightSilenceDays(days: number): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_SILENCE_DAYS, days)
}

export async function getAiInsightAllowContext(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_ALLOW_CONTEXT)
  return value === true
}

export async function setAiInsightAllowContext(allow: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_ALLOW_CONTEXT, allow)
}

export async function getAiInsightAllowMomentsContext(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_ALLOW_MOMENTS_CONTEXT)
  return value === true
}

export async function setAiInsightAllowMomentsContext(allow: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_ALLOW_MOMENTS_CONTEXT, allow)
}

export async function getAiInsightMomentsContextCount(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_MOMENTS_CONTEXT_COUNT)
  return typeof value === 'number' && value > 0 ? value : 5
}

export async function setAiInsightMomentsContextCount(count: number): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_MOMENTS_CONTEXT_COUNT, count)
}

export async function getAiInsightAllowSocialContext(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_ALLOW_SOCIAL_CONTEXT)
  return value === true
}

export async function setAiInsightAllowSocialContext(allow: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_ALLOW_SOCIAL_CONTEXT, allow)
}

export type AiInsightFilterMode = 'whitelist' | 'blacklist'

const normalizeAiInsightFilterList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
}

export async function getAiInsightFilterMode(): Promise<AiInsightFilterMode> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_FILTER_MODE)
  if (value === 'blacklist') return 'blacklist'
  if (value === 'whitelist') return 'whitelist'
  return 'whitelist'
}

export async function setAiInsightFilterMode(mode: AiInsightFilterMode): Promise<void> {
  const normalizedMode: AiInsightFilterMode = mode === 'blacklist' ? 'blacklist' : 'whitelist'
  await config.set(CONFIG_KEYS.AI_INSIGHT_FILTER_MODE, normalizedMode)
}

export async function getAiInsightFilterList(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_FILTER_LIST)
  return normalizeAiInsightFilterList(value)
}

export async function setAiInsightFilterList(list: string[]): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_FILTER_LIST, normalizeAiInsightFilterList(list))
}

// 兼容旧字段命名：内部已映射到新的黑白名单模式
export async function getAiInsightWhitelistEnabled(): Promise<boolean> {
  return (await getAiInsightFilterMode()) === 'whitelist'
}

export async function setAiInsightWhitelistEnabled(enabled: boolean): Promise<void> {
  await setAiInsightFilterMode(enabled ? 'whitelist' : 'blacklist')
}

export async function getAiInsightWhitelist(): Promise<string[]> {
  return getAiInsightFilterList()
}

export async function setAiInsightWhitelist(list: string[]): Promise<void> {
  await setAiInsightFilterList(list)
}

export async function getAiInsightCooldownMinutes(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_COOLDOWN_MINUTES)
  return typeof value === 'number' && value >= 0 ? value : 120
}

export async function setAiInsightCooldownMinutes(minutes: number): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_COOLDOWN_MINUTES, minutes)
}

export async function getAiInsightScanIntervalHours(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_SCAN_INTERVAL_HOURS)
  return typeof value === 'number' && value > 0 ? value : 4
}

export async function setAiInsightScanIntervalHours(hours: number): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_SCAN_INTERVAL_HOURS, hours)
}

export async function getAiInsightContextCount(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_CONTEXT_COUNT)
  return typeof value === 'number' && value > 0 ? value : 40
}

export async function setAiInsightContextCount(count: number): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_CONTEXT_COUNT, count)
}

export async function getAiInsightSocialContextCount(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_SOCIAL_CONTEXT_COUNT)
  return typeof value === 'number' && value > 0 ? value : 3
}

export async function setAiInsightSocialContextCount(count: number): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_SOCIAL_CONTEXT_COUNT, count)
}

export async function getAiInsightSystemPrompt(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_SYSTEM_PROMPT)
  return typeof value === 'string' ? value : ''
}

export async function setAiInsightSystemPrompt(prompt: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_SYSTEM_PROMPT, prompt)
}

export async function getAiInsightTelegramEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_TELEGRAM_ENABLED)
  return value === true
}

export async function setAiInsightTelegramEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_TELEGRAM_ENABLED, enabled)
}

export async function getAiInsightTelegramToken(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_TELEGRAM_TOKEN)
  return typeof value === 'string' ? value : ''
}

export async function setAiInsightTelegramToken(token: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_TELEGRAM_TOKEN, token)
}

export async function getAiInsightTelegramChatIds(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_TELEGRAM_CHAT_IDS)
  return typeof value === 'string' ? value : ''
}

export async function setAiInsightTelegramChatIds(chatIds: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_TELEGRAM_CHAT_IDS, chatIds)
}

export async function getAiInsightWeiboCookie(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_WEIBO_COOKIE)
  return typeof value === 'string' ? value : ''
}

export async function setAiInsightWeiboCookie(cookieValue: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_WEIBO_COOKIE, cookieValue)
}

export async function getAiInsightWeiboBindings(): Promise<Record<string, AiInsightWeiboBinding>> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_WEIBO_BINDINGS)
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, AiInsightWeiboBinding>
}

export async function setAiInsightWeiboBindings(bindings: Record<string, AiInsightWeiboBinding>): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_WEIBO_BINDINGS, bindings)
}

const normalizeAiInsightMomentsBindings = (value: unknown): Record<string, AiInsightMomentsBinding> => {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, AiInsightMomentsBinding> = {}
  for (const [sessionIdRaw, bindingRaw] of Object.entries(value as Record<string, unknown>)) {
    const sessionId = String(sessionIdRaw || '').trim()
    if (!sessionId) continue
    if (!bindingRaw || typeof bindingRaw !== 'object') continue
    const bindingObj = bindingRaw as { enabled?: unknown; updatedAt?: unknown }
    if (bindingObj.enabled !== true) continue
    const updatedAtRaw = Number(bindingObj.updatedAt)
    result[sessionId] = {
      enabled: true,
      updatedAt: Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? Math.floor(updatedAtRaw) : Date.now()
    }
  }
  return result
}

export async function getAiInsightMomentsBindings(): Promise<Record<string, AiInsightMomentsBinding>> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_MOMENTS_BINDINGS)
  return normalizeAiInsightMomentsBindings(value)
}

export async function setAiInsightMomentsBindings(bindings: Record<string, AiInsightMomentsBinding>): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_MOMENTS_BINDINGS, normalizeAiInsightMomentsBindings(bindings))
}

export async function getAiFootprintEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_FOOTPRINT_ENABLED)
  return value === true
}

export async function setAiFootprintEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_FOOTPRINT_ENABLED, enabled)
}

export async function getAiFootprintSystemPrompt(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.AI_FOOTPRINT_SYSTEM_PROMPT)
  return typeof value === 'string' ? value : ''
}

export async function setAiFootprintSystemPrompt(prompt: string): Promise<void> {
  await config.set(CONFIG_KEYS.AI_FOOTPRINT_SYSTEM_PROMPT, prompt)
}

export async function getAiInsightDebugLogEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AI_INSIGHT_DEBUG_LOG_ENABLED)
  return value === true
}

export async function setAiInsightDebugLogEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AI_INSIGHT_DEBUG_LOG_ENABLED, enabled)
}

export async function getAutoDownloadHighRes(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AUTO_DOWNLOAD_HIGH_RES)
  return value === true
}

export async function setAutoDownloadHighRes(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AUTO_DOWNLOAD_HIGH_RES, enabled)
}

export async function getAutoDownloadWhitelist(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.AUTO_DOWNLOAD_WHITELIST)
  return Array.isArray(value) ? value : []
}

export async function setAutoDownloadWhitelist(list: string[]): Promise<void> {
  const normalized = Array.from(new Set((list || []).map(item => String(item || '').trim()).filter(Boolean)))
  await config.set(CONFIG_KEYS.AUTO_DOWNLOAD_WHITELIST, normalized)
}

