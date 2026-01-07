// 配置服务 - 封装 Electron Store
import { config } from './ipc'

// 配置键名
export const CONFIG_KEYS = {
  DECRYPT_KEY: 'decryptKey',
  DB_PATH: 'dbPath',
  MY_WXID: 'myWxid',
  THEME: 'theme',
  LAST_SESSION: 'lastSession',
  WINDOW_BOUNDS: 'windowBounds',
  CACHE_PATH: 'cachePath',
  EXPORT_PATH: 'exportPath',
  AGREEMENT_ACCEPTED: 'agreementAccepted',
  LOG_ENABLED: 'logEnabled'
} as const

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

// 获取主题
export async function getTheme(): Promise<'light' | 'dark'> {
  const value = await config.get(CONFIG_KEYS.THEME)
  return (value as 'light' | 'dark') || 'light'
}

// 设置主题
export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await config.set(CONFIG_KEYS.THEME, theme)
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
