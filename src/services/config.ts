// 配置服务 - 封装 Electron Store
import { config } from './ipc'

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
  EXPORT_DEFAULT_DATE_RANGE: 'exportDefaultDateRange',
  EXPORT_DEFAULT_MEDIA: 'exportDefaultMedia',
  EXPORT_DEFAULT_VOICE_AS_TEXT: 'exportDefaultVoiceAsText',
  EXPORT_DEFAULT_EXCEL_COMPACT_COLUMNS: 'exportDefaultExcelCompactColumns',
  EXPORT_DEFAULT_TXT_COLUMNS: 'exportDefaultTxtColumns'
} as const

export interface WxidConfig {
  decryptKey?: string
  imageXorKey?: number
  imageAesKey?: string
  updatedAt?: number
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
export async function getTheme(): Promise<'light' | 'dark'> {
  const value = await config.get(CONFIG_KEYS.THEME)
  return (value as 'light' | 'dark') || 'light'
}

// 设置主题
export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
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

// 获取导出默认时间范围
export async function getExportDefaultDateRange(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_DATE_RANGE)
  return (value as string) || null
}

// 设置导出默认时间范围
export async function setExportDefaultDateRange(range: string): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_DATE_RANGE, range)
}

// 获取导出默认媒体设置
export async function getExportDefaultMedia(): Promise<boolean | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_MEDIA)
  if (typeof value === 'boolean') return value
  return null
}

// 设置导出默认媒体设置
export async function setExportDefaultMedia(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_MEDIA, enabled)
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
