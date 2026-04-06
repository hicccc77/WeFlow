import './preload-env'
import { app, BrowserWindow, ipcMain, nativeTheme, session, Tray, Menu, nativeImage } from 'electron'
import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { autoUpdater } from 'electron-updater'
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { ConfigService } from './services/config'
import { dbPathService } from './services/dbPathService'
import { wcdbService } from './services/wcdbService'
import { chatService } from './services/chatService'
import { imageDecryptService } from './services/imageDecryptService'
import { imagePreloadService } from './services/imagePreloadService'
import { analyticsService } from './services/analyticsService'
import { groupAnalyticsService } from './services/groupAnalyticsService'
import { annualReportService } from './services/annualReportService'
import { exportService, ExportOptions, ExportProgress } from './services/exportService'
import { KeyService } from './services/keyService'
import { KeyServiceLinux } from './services/keyServiceLinux'
import { KeyServiceMac } from './services/keyServiceMac'
import { voiceTranscribeService } from './services/voiceTranscribeService'
import { videoService } from './services/videoService'
import { snsService, isVideoUrl } from './services/snsService'
import { contactExportService } from './services/contactExportService'
import { windowsHelloService } from './services/windowsHelloService'
import { exportCardDiagnosticsService } from './services/exportCardDiagnosticsService'
import { cloudControlService } from './services/cloudControlService'

import { destroyNotificationWindow, registerNotificationHandlers, showNotification } from './windows/notificationWindow'
import { httpService } from './services/httpService'
import { messagePushService } from './services/messagePushService'
import { bizService } from './services/bizService'

// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，强制全量下载
// 更新通道策略：
// - 稳定版（如 4.3.0）默认走 latest
// - 预览版（如 0.26.2）默认走 preview（0.年.当年发布序号）
// - 开发版（如 26.4.5）默认走 dev（年.月.日）
// - 用户可在设置页切换稳定/预览/开发，切换后即时生效
// 同时区分 Windows x64 / arm64，避免更新清单互相覆盖。
const appVersion = app.getVersion()
const inferUpdateTrackFromVersion = (version: string): 'stable' | 'preview' | 'dev' => {
  const normalized = String(version || '').trim().replace(/^v/i, '')
  if (/^0\.\d{2}\.\d+$/i.test(normalized)) return 'preview'
  if (/^\d{2}\.\d{1,2}\.\d{1,2}$/i.test(normalized)) return 'dev'
  // 兼容旧版命名（如 4.3.0-preview.26.1 / 4.3.0-dev.26.3.4）
  if (/-preview\.\d+\.\d+$/i.test(normalized)) return 'preview'
  if (/-dev\.\d+\.\d+\.\d+$/i.test(normalized)) return 'dev'
  // 兼容 alpha/beta/rc 预发布
  if (/(alpha|beta|rc)/i.test(normalized)) return 'dev'
  return 'stable'
}

const defaultUpdateTrack: 'stable' | 'preview' | 'dev' = (() => {
  const inferred = inferUpdateTrackFromVersion(appVersion)
  if (inferred === 'preview' || inferred === 'dev') return inferred
  return 'stable'
})()
let configService: ConfigService | null = null

const normalizeUpdateTrack = (raw: unknown): 'stable' | 'preview' | 'dev' | null => {
  if (raw === 'stable' || raw === 'preview' || raw === 'dev') return raw
  return null
}

const getEffectiveUpdateTrack = (): 'stable' | 'preview' | 'dev' => {
  const configuredTrack = normalizeUpdateTrack(configService?.get('updateChannel'))
  return configuredTrack || defaultUpdateTrack
}

const isRemoteVersionNewer = (latestVersion: string, currentVersion: string): boolean => {
  const latest = String(latestVersion || '').trim()
  const current = String(currentVersion || '').trim()
  if (!latest || !current) return false

  const parseVersion = (version: string) => {
    const normalized = version.replace(/^v/i, '')
    const [main, pre = ''] = normalized.split('-', 2)
    const core = main.split('.').map((segment) => Number.parseInt(segment, 10) || 0)
    const prerelease = pre ? pre.split('.').map((segment) => /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment) : []
    return { core, prerelease }
  }

  const compareParsedVersion = (a: ReturnType<typeof parseVersion>, b: ReturnType<typeof parseVersion>): number => {
    const maxLen = Math.max(a.core.length, b.core.length)
    for (let i = 0; i < maxLen; i += 1) {
      const left = a.core[i] || 0
      const right = b.core[i] || 0
      if (left > right) return 1
      if (left < right) return -1
    }

    const aPre = a.prerelease
    const bPre = b.prerelease
    if (aPre.length === 0 && bPre.length === 0) return 0
    if (aPre.length === 0) return 1
    if (bPre.length === 0) return -1

    const preMaxLen = Math.max(aPre.length, bPre.length)
    for (let i = 0; i < preMaxLen; i += 1) {
      const left = aPre[i]
      const right = bPre[i]
      if (left === undefined) return -1
      if (right === undefined) return 1
      if (left === right) continue

      const leftNum = typeof left === 'number'
      const rightNum = typeof right === 'number'
      if (leftNum && rightNum) return left > right ? 1 : -1
      if (leftNum) return -1
      if (rightNum) return 1
      return String(left) > String(right) ? 1 : -1
    }

    return 0
  }

  try {
    return autoUpdater.currentVersion.compare(latest) < 0
  } catch {
    return compareParsedVersion(parseVersion(latest), parseVersion(current)) > 0
  }
}

const shouldOfferUpdateForTrack = (latestVersion: string, currentVersion: string): boolean => {
  if (isRemoteVersionNewer(latestVersion, currentVersion)) return true
  const effectiveTrack = getEffectiveUpdateTrack()
  const currentTrack = inferUpdateTrackFromVersion(currentVersion)
  // 切换通道后，目标通道最新版本与当前版本不同即提示更新（即使是降级）
  if (effectiveTrack !== currentTrack && latestVersion !== currentVersion) return true
  return false
}

let lastAppliedUpdaterChannel: string | null = null
let lastAppliedUpdaterFeedUrl: string | null = null
const resetUpdaterProviderCache = () => {
  const updater = autoUpdater as any
  // electron-updater 会缓存 provider；切换 channel 后需清理缓存，避免仍请求旧通道
  for (const key of ['clientPromise', '_clientPromise', 'updateInfoAndProvider']) {
    if (Object.prototype.hasOwnProperty.call(updater, key)) {
      updater[key] = null
    }
  }
}

const getUpdaterFeedUrlByTrack = (track: 'stable' | 'preview' | 'dev'): string => {
  const repoBase = 'https://github.com/hicccc77/WeFlow/releases'
  if (track === 'stable') return `${repoBase}/latest/download`
  if (track === 'preview') return `${repoBase}/download/nightly-preview`
  return `${repoBase}/download/nightly-dev`
}

const applyAutoUpdateChannel = (reason: 'startup' | 'settings' = 'startup') => {
  const track = getEffectiveUpdateTrack()
  const currentTrack = inferUpdateTrackFromVersion(appVersion)
  const baseUpdateChannel = track === 'stable' ? 'latest' : track
  const nextFeedUrl = getUpdaterFeedUrlByTrack(track)
  const nextUpdaterChannel =
    process.platform === 'win32' && process.arch === 'arm64'
      ? `${baseUpdateChannel}-arm64`
      : baseUpdateChannel
  if (
    (lastAppliedUpdaterChannel && lastAppliedUpdaterChannel !== nextUpdaterChannel) ||
    (lastAppliedUpdaterFeedUrl && lastAppliedUpdaterFeedUrl !== nextFeedUrl)
  ) {
    resetUpdaterProviderCache()
  }
  autoUpdater.allowPrerelease = track !== 'stable'
  // 只要用户当前选择的目标通道与当前安装版本所属通道不同，就允许跨通道更新（含降级）
  autoUpdater.allowDowngrade = track !== currentTrack
  // 统一走 generic feed，确保 preview/dev 命中各自固定发布页，不受 GitHub provider 的 prerelease 选择影响。
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: nextFeedUrl,
    channel: nextUpdaterChannel
  })
  autoUpdater.channel = nextUpdaterChannel
  lastAppliedUpdaterChannel = nextUpdaterChannel
  lastAppliedUpdaterFeedUrl = nextFeedUrl
  console.log(`[Update](${reason}) 当前版本 ${appVersion}，当前轨道: ${currentTrack}，渠道偏好: ${track}，更新通道: ${autoUpdater.channel}，feed=${nextFeedUrl}，allowDowngrade=${autoUpdater.allowDowngrade}`)
}

applyAutoUpdateChannel('startup')
const AUTO_UPDATE_ENABLED =
  process.env.AUTO_UPDATE_ENABLED === 'true' ||
  process.env.AUTO_UPDATE_ENABLED === '1' ||
  (process.env.AUTO_UPDATE_ENABLED == null && !process.env.VITE_DEV_SERVER_URL)

const getLaunchAtStartupUnsupportedReason = (): string | null => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return '当前平台暂不支持开机自启动'
  }
  if (!app.isPackaged) {
    return '仅安装后的 Windows / macOS 版本支持开机自启动'
  }
  return null
}

const isLaunchAtStartupSupported = (): boolean => getLaunchAtStartupUnsupportedReason() == null

const getStoredLaunchAtStartupPreference = (): boolean | undefined => {
  const value = configService?.get('launchAtStartup')
  return typeof value === 'boolean' ? value : undefined
}

const getSystemLaunchAtStartup = (): boolean => {
  if (!isLaunchAtStartupSupported()) return false
  try {
    return app.getLoginItemSettings().openAtLogin === true
  } catch (error) {
    console.error('[WeFlow] 读取开机自启动状态失败:', error)
    return false
  }
}

const buildLaunchAtStartupSettings = (enabled: boolean): Parameters<typeof app.setLoginItemSettings>[0] =>
  process.platform === 'win32'
    ? { openAtLogin: enabled, path: process.execPath }
    : { openAtLogin: enabled }

const setSystemLaunchAtStartup = (enabled: boolean): { success: boolean; enabled: boolean; error?: string } => {
  try {
    app.setLoginItemSettings(buildLaunchAtStartupSettings(enabled))
    const effectiveEnabled = app.getLoginItemSettings().openAtLogin === true
    if (effectiveEnabled !== enabled) {
      return {
        success: false,
        enabled: effectiveEnabled,
        error: '系统未接受该开机自启动设置'
      }
    }
    return { success: true, enabled: effectiveEnabled }
  } catch (error) {
    return {
      success: false,
      enabled: getSystemLaunchAtStartup(),
      error: `设置开机自启动失败: ${String((error as Error)?.message || error)}`
    }
  }
}

const getLaunchAtStartupStatus = (): { enabled: boolean; supported: boolean; reason?: string } => {
  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) {
    return {
      enabled: getStoredLaunchAtStartupPreference() === true,
      supported: false,
      reason: unsupportedReason
    }
  }
  return {
    enabled: getSystemLaunchAtStartup(),
    supported: true
  }
}

const applyLaunchAtStartupPreference = (
  enabled: boolean
): { success: boolean; enabled: boolean; supported: boolean; reason?: string; error?: string } => {
  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) {
    return {
      success: false,
      enabled: getStoredLaunchAtStartupPreference() === true,
      supported: false,
      reason: unsupportedReason
    }
  }

  const result = setSystemLaunchAtStartup(enabled)
  configService?.set('launchAtStartup', result.enabled)
  return {
    ...result,
    supported: true
  }
}

const syncLaunchAtStartupPreference = () => {
  if (!configService) return

  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) return

  const storedPreference = getStoredLaunchAtStartupPreference()
  const systemEnabled = getSystemLaunchAtStartup()

  if (typeof storedPreference !== 'boolean') {
    configService.set('launchAtStartup', systemEnabled)
    return
  }

  if (storedPreference === systemEnabled) return

  const result = setSystemLaunchAtStartup(storedPreference)
  configService.set('launchAtStartup', result.enabled)
  if (!result.success && result.error) {
    console.error('[WeFlow] 同步开机自启动设置失败:', result.error)
  }
}

// 使用白名单过滤 PATH，避免被第三方目录中的旧版 VC++ 运行库劫持。
// 仅保留系统目录（Windows/System32/SysWOW64）和应用自身目录（可执行目录、resources）。
function sanitizePathEnv() {
  // 开发模式不做裁剪，避免影响本地工具链
  if (process.env.VITE_DEV_SERVER_URL) return

  const rawPath = process.env.PATH || process.env.Path
  if (!rawPath) return

  const sep = process.platform === 'win32' ? ';' : ':'
  const parts = rawPath.split(sep).filter(Boolean)

  const systemRoot = process.env.SystemRoot || process.env.WINDIR || ''
  const safePrefixes = [
    systemRoot,
    systemRoot ? join(systemRoot, 'System32') : '',
    systemRoot ? join(systemRoot, 'SysWOW64') : '',
    dirname(process.execPath),
    process.resourcesPath,
    join(process.resourcesPath || '', 'resources')
  ].filter(Boolean)

  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const isSafe = (p: string) => {
    const np = normalize(p)
    return safePrefixes.some((prefix) => np.startsWith(normalize(prefix)))
  }

  const filtered = parts.filter(isSafe)
  if (filtered.length !== parts.length) {
    const removed = parts.filter((p) => !isSafe(p))
    console.warn('[WeFlow] 使用白名单裁剪 PATH，移除目录:', removed)
    const nextPath = filtered.join(sep)
    process.env.PATH = nextPath
    process.env.Path = nextPath
  }
}

// 启动时立即清理 PATH，后续创建的 worker 也能继承安全的环境
sanitizePathEnv()

// 单例服务

// 协议窗口实例
let agreementWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null
// Splash 启动窗口
let splashWindow: BrowserWindow | null = null
const sessionChatWindows = new Map<string, BrowserWindow>()
const sessionChatWindowSources = new Map<string, 'chat' | 'export'>()

let keyService: any
if (process.platform === 'darwin') {
  keyService = new KeyServiceMac()
} else if (process.platform === 'linux') {
  // const { KeyServiceLinux } = require('./services/keyServiceLinux')
  // keyService = new KeyServiceLinux()

  import('./services/keyServiceLinux').then(({ KeyServiceLinux }) => {
    keyService = new KeyServiceLinux();
  });

} else {
  keyService = new KeyService()
}

let mainWindowReady = false
let shouldShowMain = true
let isAppQuitting = false
let tray: Tray | null = null
let isClosePromptVisible = false
const chatHistoryPayloadStore = new Map<string, { sessionId: string; title?: string; recordList: any[] }>()

type WindowCloseBehavior = 'ask' | 'tray' | 'quit'

// 更新下载状态管理（Issue #294 修复）
let isDownloadInProgress = false
let downloadProgressHandler: ((progress: any) => void) | null = null
let downloadedHandler: (() => void) | null = null

const normalizeReleaseNotes = (rawReleaseNotes: unknown): string => {
  const merged = (() => {
    if (typeof rawReleaseNotes === 'string') {
      return rawReleaseNotes
    }
    if (Array.isArray(rawReleaseNotes)) {
      return rawReleaseNotes
        .map((item) => {
          if (!item || typeof item !== 'object') return ''
          const note = (item as { note?: unknown }).note
          return typeof note === 'string' ? note : ''
        })
        .filter(Boolean)
        .join('\n\n')
    }
    return ''
  })()

  if (!merged.trim()) return ''

  const normalizeHeadingText = (raw: string): string => {
    return raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, '\'')
      .replace(/&#x27;/gi, '\'')
      .toLowerCase()
      .replace(/[：:]/g, '')
      .replace(/\s+/g, '')
      .trim()
  }

  const shouldStripReleaseSection = (headingRaw: string): boolean => {
    const heading = normalizeHeadingText(headingRaw)
    if (!heading) return false
    if (heading.startsWith('下载') || heading.startsWith('download')) return true

    if ((heading.includes('macos') || heading.startsWith('mac')) && heading.includes('安装提示')) return true
    return false
  }

  // 兼容 electron-updater 直接返回 HTML 的场景（含 dir/anchor 等标签嵌套）
  const removeDownloadSectionFromHtml = (input: string): string => {
    const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
    const headings: Array<{ start: number; end: number; headingText: string }> = []
    let match: RegExpExecArray | null

    while ((match = headingPattern.exec(input)) !== null) {
      const full = match[0]
      headings.push({
        start: match.index,
        end: match.index + full.length,
        headingText: match[2] || ''
      })
    }

    if (headings.length === 0) return input

    const rangesToRemove: Array<{ start: number; end: number }> = []
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i]
      if (!shouldStripReleaseSection(current.headingText)) continue

      const nextStart = i + 1 < headings.length ? headings[i + 1].start : input.length
      rangesToRemove.push({ start: current.start, end: nextStart })
    }

    if (rangesToRemove.length === 0) return input

    let output = ''
    let cursor = 0
    for (const range of rangesToRemove) {
      output += input.slice(cursor, range.start)
      cursor = range.end
    }
    output += input.slice(cursor)
    return output
  }

  // 兼容 Markdown 场景（Action 最终 release note 模板）
  const removeDownloadSectionFromMarkdown = (input: string): string => {
    const lines = input.split(/\r?\n/)
    const output: string[] = []
    let skipSection = false

    for (const line of lines) {
      const headingMatch = line.match(/^\s*#{1,6}\s*(.+?)\s*$/)
      if (headingMatch) {
        if (shouldStripReleaseSection(headingMatch[1])) {
          skipSection = true
          continue
        }
        if (skipSection) {
          skipSection = false
        }
      }
      if (!skipSection) {
        output.push(line)
      }
    }

    return output.join('\n')
  }

  const cleaned = removeDownloadSectionFromMarkdown(removeDownloadSectionFromHtml(merged))
    // 兜底：即使没有匹配到标题，也不在弹窗展示 macOS 隔离标记清理命令
    .replace(/^[ \t>*-]*`?\s*xattr\s+-[a-z]*d[a-z]*\s+com\.apple\.quarantine[^\n]*`?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned
}

const getDialogReleaseNotes = (rawReleaseNotes: unknown): string => {
  const track = getEffectiveUpdateTrack()
  if (track !== 'stable') {
    return '修复了一些已知问题'
  }
  return normalizeReleaseNotes(rawReleaseNotes)
}

type AnnualReportYearsLoadStrategy = 'cache' | 'native' | 'hybrid'
type AnnualReportYearsLoadPhase = 'cache' | 'native' | 'scan' | 'done'

interface AnnualReportYearsProgressPayload {
  years?: number[]
  done: boolean
  error?: string
  canceled?: boolean
  strategy?: AnnualReportYearsLoadStrategy
  phase?: AnnualReportYearsLoadPhase
  statusText?: string
  nativeElapsedMs?: number
  scanElapsedMs?: number
  totalElapsedMs?: number
  switched?: boolean
  nativeTimedOut?: boolean
}

interface AnnualReportYearsTaskState {
  cacheKey: string
  canceled: boolean
  done: boolean
  snapshot: AnnualReportYearsProgressPayload
  updatedAt: number
}

interface OpenSessionChatWindowOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
}

const normalizeSessionChatWindowSource = (source: unknown): 'chat' | 'export' => {
  return String(source || '').trim().toLowerCase() === 'export' ? 'export' : 'chat'
}

const normalizeSessionChatWindowOptionString = (value: unknown): string => {
  return String(value || '').trim()
}

const loadSessionChatWindowContent = (
  win: BrowserWindow,
  sessionId: string,
  source: 'chat' | 'export',
  options?: OpenSessionChatWindowOptions
) => {
  const queryParams = new URLSearchParams({
    sessionId,
    source
  })
  const initialDisplayName = normalizeSessionChatWindowOptionString(options?.initialDisplayName)
  const initialAvatarUrl = normalizeSessionChatWindowOptionString(options?.initialAvatarUrl)
  const initialContactType = normalizeSessionChatWindowOptionString(options?.initialContactType)
  if (initialDisplayName) queryParams.set('initialDisplayName', initialDisplayName)
  if (initialAvatarUrl) queryParams.set('initialAvatarUrl', initialAvatarUrl)
  if (initialContactType) queryParams.set('initialContactType', initialContactType)
  const query = queryParams.toString()
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/chat-window?${query}`)
    return
  }
  win.loadFile(join(__dirname, '../dist/index.html'), {
    hash: `/chat-window?${query}`
  })
}

const annualReportYearsLoadTasks = new Map<string, AnnualReportYearsTaskState>()
const annualReportYearsTaskByCacheKey = new Map<string, string>()
const annualReportYearsSnapshotCache = new Map<string, { snapshot: AnnualReportYearsProgressPayload; updatedAt: number; taskId: string }>()
const annualReportYearsSnapshotTtlMs = 10 * 60 * 1000

const normalizeAnnualReportYearsSnapshot = (snapshot: AnnualReportYearsProgressPayload): AnnualReportYearsProgressPayload => {
  const years = Array.isArray(snapshot.years) ? [...snapshot.years] : []
  return { ...snapshot, years }
}

const buildAnnualReportYearsCacheKey = (dbPath: string, wxid: string): string => {
  return `${String(dbPath || '').trim()}\u0001${String(wxid || '').trim()}`
}

const pruneAnnualReportYearsSnapshotCache = (): void => {
  const now = Date.now()
  for (const [cacheKey, entry] of annualReportYearsSnapshotCache.entries()) {
    if (now - entry.updatedAt > annualReportYearsSnapshotTtlMs) {
      annualReportYearsSnapshotCache.delete(cacheKey)
    }
  }
}

const persistAnnualReportYearsSnapshot = (
  cacheKey: string,
  taskId: string,
  snapshot: AnnualReportYearsProgressPayload
): void => {
  annualReportYearsSnapshotCache.set(cacheKey, {
    taskId,
    snapshot: normalizeAnnualReportYearsSnapshot(snapshot),
    updatedAt: Date.now()
  })
  pruneAnnualReportYearsSnapshotCache()
}

const getAnnualReportYearsSnapshot = (
  cacheKey: string
): { taskId: string; snapshot: AnnualReportYearsProgressPayload } | null => {
  pruneAnnualReportYearsSnapshotCache()
  const entry = annualReportYearsSnapshotCache.get(cacheKey)
  if (!entry) return null
  return {
    taskId: entry.taskId,
    snapshot: normalizeAnnualReportYearsSnapshot(entry.snapshot)
  }
}

const broadcastAnnualReportYearsProgress = (
  taskId: string,
  payload: AnnualReportYearsProgressPayload
): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('annualReport:availableYearsProgress', {
      taskId,
      ...payload
    })
  }
}

const isYearsLoadCanceled = (taskId: string): boolean => {
  const task = annualReportYearsLoadTasks.get(taskId)
  return task?.canceled === true
}

const setupCustomTitleBarWindow = (win: BrowserWindow): void => {
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false)
  }

  const emitMaximizeState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximizeStateChanged', win.isMaximized() || win.isFullScreen())
  }

  win.on('maximize', emitMaximizeState)
  win.on('unmaximize', emitMaximizeState)
  win.on('enter-full-screen', emitMaximizeState)
  win.on('leave-full-screen', emitMaximizeState)
  win.webContents.on('did-finish-load', emitMaximizeState)
}

const getWindowCloseBehavior = (): WindowCloseBehavior => {
  const behavior = configService?.get('windowCloseBehavior')
  return behavior === 'tray' || behavior === 'quit' ? behavior : 'ask'
}

const requestMainWindowCloseConfirmation = (win: BrowserWindow): void => {
  if (isClosePromptVisible) return
  isClosePromptVisible = true
  win.webContents.send('window:confirmCloseRequested', {
    canMinimizeToTray: Boolean(tray)
  })
}

function createWindow(options: { autoShow?: boolean } = {}) {
  // 获取图标路径 - 打包后在 resources 目录
  const { autoShow = true } = options
  let iconName = 'icon.ico';
  if (process.platform === 'linux') {
    iconName = 'icon.png';
  } else if (process.platform === 'darwin') {
    iconName = 'icon.icns';
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL

  const iconPath = isDev
      ? join(__dirname, `../public/${iconName}`)
      : join(process.resourcesPath, iconName);

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // Allow loading local files (video playback)
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    show: false
  })
  setupCustomTitleBarWindow(win)

  // 窗口准备好后显示
  // Splash 模式下不在这里 show，由启动流程统一控制
  win.once('ready-to-show', () => {
    mainWindowReady = true
    if (autoShow && !splashWindow) {
      win.show()
    }
  })

  // 开发环境加载 vite 服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)

    // 开发环境下按 F12 或 Ctrl+Shift+I 打开开发者工具
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }

  // Handle notification click navigation
  ipcMain.on('notification-clicked', (_, sessionId) => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('navigate-to-session', sessionId)
  })

  // 拦截请求，修改 Referer 和 User-Agent 以通过微信 CDN 鉴权
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.qpic.cn/*',
        '*://*.qlogo.cn/*',
        '*://*.wechat.com/*',
        '*://*.weixin.qq.com/*'
      ]
    },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351"
      details.requestHeaders['Accept'] = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      details.requestHeaders['Accept-Encoding'] = "gzip, deflate, br"
      details.requestHeaders['Accept-Language'] = "zh-CN,zh;q=0.9"
      details.requestHeaders['Referer'] = "https://servicewechat.com/"
      details.requestHeaders['Connection'] = "keep-alive"
      details.requestHeaders['Range'] = "bytes=0-"
      callback({ cancel: false, requestHeaders: details.requestHeaders })
    }
  )

  // 忽略微信 CDN 域名的证书错误（部分节点证书配置不正确）
  win.webContents.on('certificate-error', (event, url, _error, _cert, callback) => {
    const trusted = ['.qq.com', '.qpic.cn', '.weixin.qq.com', '.wechat.com']
    try {
      const host = new URL(url).hostname
      if (trusted.some(d => host.endsWith(d))) {
        event.preventDefault()
        callback(true)
        return
      }
    } catch {}
    callback(false)
  })

  win.on('close', (e) => {
    if (isAppQuitting || win !== mainWindow) return
    e.preventDefault()
    const closeBehavior = getWindowCloseBehavior()

    if (closeBehavior === 'quit') {
      isAppQuitting = true
      app.quit()
      return
    }

    if (closeBehavior === 'tray' && tray) {
      win.hide()
      return
    }

    requestMainWindowCloseConfirmation(win)
  })

  win.on('closed', () => {
    if (mainWindow !== win) return

    mainWindow = null
    mainWindowReady = false
    isClosePromptVisible = false

    if (process.platform !== 'darwin' && !isAppQuitting) {
      destroyNotificationWindow()
      if (BrowserWindow.getAllWindows().length === 0) {
        app.quit()
      }
    }
  })

  return win
}

/**
 * 创建用户协议窗口
 */
function createAgreementWindow() {
  // 如果已存在，聚焦
  if (agreementWindow && !agreementWindow.isDestroyed()) {
    agreementWindow.focus()
    return agreementWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const isDark = nativeTheme.shouldUseDarkColors

  agreementWindow = new BrowserWindow({
    width: 700,
    height: 600,
    minWidth: 500,
    minHeight: 400,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 32
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF'
  })

  agreementWindow.once('ready-to-show', () => {
    agreementWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    agreementWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/agreement-window`)
  } else {
    agreementWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/agreement-window' })
  }

  agreementWindow.on('closed', () => {
    agreementWindow = null
  })

  return agreementWindow
}

/**
 * 创建 Splash 启动窗口
 * 使用纯 HTML 页面，不依赖 React，确保极速显示
 */
function createSplashWindow(): BrowserWindow {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  splashWindow = new BrowserWindow({
    width: 760,
    height: 460,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    center: true,
    skipTaskbar: false,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
      // 不需要 preload —— 通过 executeJavaScript 单向推送进度
    },
    show: false
  })

  if (isDev) {
    splashWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}splash.html`)
  } else {
    splashWindow.loadFile(join(__dirname, '../dist/splash.html'))
  }

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })

  splashWindow.on('closed', () => {
    splashWindow = null
  })

  return splashWindow
}

/**
 * 向 Splash 窗口发送进度更新
 */
function updateSplashProgress(percent: number, text: string, indeterminate = false) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`updateProgress(${percent}, ${JSON.stringify(text)}, ${indeterminate})`)
      .catch(() => {})
  }
}

/**
 * 关闭 Splash 窗口
 */
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

/**
 * 创建首次引导窗口
 */
function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus()
    return onboardingWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  onboardingWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 900,
    minHeight: 620,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  onboardingWindow.once('ready-to-show', () => {
    onboardingWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/onboarding-window`)
  } else {
    onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/onboarding-window' })
  }

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
  })

  return onboardingWindow
}

/**
 * 创建独立的视频播放窗口
 * 窗口大小会根据视频比例自动调整
 */
function createVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  // 获取屏幕尺寸
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  // 计算窗口尺寸，只有标题栏 40px，控制栏悬浮
  let winWidth = 854
  let winHeight = 520
  const titleBarHeight = 40

  if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    if (aspectRatio >= 1) {
      // 横向视频
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)
  }

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 360,
    minHeight: 280,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#ffffff',
      height: 40
    },
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  const videoParam = `videoPath=${encodeURIComponent(videoPath)}`
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/video-player-window?${videoParam}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/video-player-window?${videoParam}`
    })
  }
}

/**
 * 创建独立的图片查看窗口
 */
function createImageViewerWindow(imagePath: string, liveVideoPath?: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // 允许加载本地文件
    },
    frame: false,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  setupCustomTitleBarWindow(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  let imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  if (liveVideoPath) imageParam += `&liveVideoPath=${encodeURIComponent(liveVideoPath)}`

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/image-viewer-window?${imageParam}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/image-viewer-window?${imageParam}`
    })
  }

  return win
}

/**
 * 创建独立的聊天记录窗口
 */
function createChatHistoryWindow(sessionId: string, messageId: number) {
  return createChatHistoryRouteWindow(`/chat-history/${sessionId}/${messageId}`)
}

function createChatHistoryPayloadWindow(payloadId: string) {
  return createChatHistoryRouteWindow(`/chat-history-inline/${payloadId}`)
}

function createChatHistoryRouteWindow(route: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  // 根据系统主题设置窗口背景色
  const isDark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    autoHideMenuBar: true
  })
  setupCustomTitleBarWindow(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${route}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: route
    })
  }

  return win
}

/**
 * 创建独立的会话聊天窗口（单会话，复用聊天页右侧消息区域）
 */
function createSessionChatWindow(sessionId: string, options?: OpenSessionChatWindowOptions) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return null
  const normalizedSource = normalizeSessionChatWindowSource(options?.source)

  const existing = sessionChatWindows.get(normalizedSessionId)
  if (existing && !existing.isDestroyed()) {
    const trackedSource = sessionChatWindowSources.get(normalizedSessionId) || 'chat'
    if (trackedSource !== normalizedSource) {
      loadSessionChatWindowContent(existing, normalizedSessionId, normalizedSource, options)
      sessionChatWindowSources.set(normalizedSessionId, normalizedSource)
    }
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.focus()
    return existing
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  const isDark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 600,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#ffffff' : '#1a1a1a',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    autoHideMenuBar: true
  })

  loadSessionChatWindowContent(win, normalizedSessionId, normalizedSource, options)

  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    const tracked = sessionChatWindows.get(normalizedSessionId)
    if (tracked === win) {
      sessionChatWindows.delete(normalizedSessionId)
      sessionChatWindowSources.delete(normalizedSessionId)
    }
  })

  sessionChatWindows.set(normalizedSessionId, win)
  sessionChatWindowSources.set(normalizedSessionId, normalizedSource)
  return win
}

function showMainWindow() {
  shouldShowMain = true
  if (mainWindowReady) {
    mainWindow?.show()
  }
}

const normalizeAccountId = (value: string): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

const buildAccountNameMatcher = (wxidCandidates: string[]) => {
  const loweredCandidates = wxidCandidates
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
  return (name: string): boolean => {
    const loweredName = String(name || '').trim().toLowerCase()
    if (!loweredName) return false
    return loweredCandidates.some((candidate) => (
      loweredName === candidate ||
      loweredName.startsWith(`${candidate}_`) ||
      loweredName.includes(candidate)
    ))
  }
}

const removePathIfExists = async (
  targetPath: string,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!targetPath || !existsSync(targetPath)) return
  try {
    await rm(targetPath, { recursive: true, force: true })
    removedPaths.push(targetPath)
  } catch (error) {
    warnings.push(`${targetPath}: ${String(error)}`)
  }
}

const removeMatchedEntriesInDir = async (
  rootDir: string,
  shouldRemove: (name: string) => boolean,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!rootDir || !existsSync(rootDir)) return
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!shouldRemove(entry.name)) continue
      const targetPath = join(rootDir, entry.name)
      await removePathIfExists(targetPath, removedPaths, warnings)
    }
  } catch (error) {
    warnings.push(`${rootDir}: ${String(error)}`)
  }
}

const normalizeFsPathForCompare = (value: string): string => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

type SnsCacheMigrationCandidate = {
  label: string
  sourceDir: string
  targetDir: string
  fileCount: number
}

type SnsCacheMigrationPlan = {
  legacyBaseDir: string
  currentBaseDir: string
  candidates: SnsCacheMigrationCandidate[]
  totalFiles: number
}

type SnsCacheMigrationProgressPayload = {
  status: 'running' | 'done' | 'error'
  phase: 'copying' | 'cleanup' | 'done' | 'error'
  current: number
  total: number
  copied: number
  skipped: number
  remaining: number
  message?: string
  currentItemLabel?: string
}

let snsCacheMigrationInProgress = false

const countFilesInDir = async (dirPath: string): Promise<number> => {
  if (!dirPath || !existsSync(dirPath)) return 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        count += await countFilesInDir(fullPath)
        continue
      }
      if (entry.isFile()) count += 1
    }
    return count
  } catch {
    return 0
  }
}

const migrateDirectoryPreserveNewFiles = async (
  sourceDir: string,
  targetDir: string,
  onFileProcessed?: (payload: { copied: boolean }) => void
): Promise<{ copied: number; skipped: number; processed: number }> => {
  let copied = 0
  let skipped = 0
  let processed = 0

  if (!existsSync(sourceDir)) return { copied, skipped, processed }
  await mkdir(targetDir, { recursive: true })

  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)

    if (entry.isDirectory()) {
      const nested = await migrateDirectoryPreserveNewFiles(sourcePath, targetPath, onFileProcessed)
      copied += nested.copied
      skipped += nested.skipped
      processed += nested.processed
      continue
    }

    if (!entry.isFile()) continue

    if (existsSync(targetPath)) {
      skipped += 1
      processed += 1
      onFileProcessed?.({ copied: false })
      continue
    }

    await mkdir(dirname(targetPath), { recursive: true })
    await copyFile(sourcePath, targetPath)
    copied += 1
    processed += 1
    onFileProcessed?.({ copied: true })
  }

  return { copied, skipped, processed }
}

const collectLegacySnsCacheMigrationPlan = async (): Promise<SnsCacheMigrationPlan | null> => {
  if (!configService) return null

  const legacyBaseDir = configService.getCacheBasePath()
  const configuredCachePath = String(configService.get('cachePath') || '').trim()
  const currentBaseDir = configuredCachePath || join(app.getPath('documents'), 'WeFlow')

  if (!legacyBaseDir || !currentBaseDir) return null

  const candidates = [
    {
      label: '朋友圈媒体缓存',
      sourceDir: join(legacyBaseDir, 'sns_cache'),
      targetDir: join(currentBaseDir, 'sns_cache')
    },
    {
      label: '朋友圈表情缓存（合并到 Emojis）',
      sourceDir: join(legacyBaseDir, 'sns_emoji_cache'),
      targetDir: join(currentBaseDir, 'Emojis')
    },
    {
      label: '朋友圈表情缓存（当前目录残留）',
      sourceDir: join(currentBaseDir, 'sns_emoji_cache'),
      targetDir: join(currentBaseDir, 'Emojis')
    }
  ]

  const pendingKeys = new Set<string>()
  const pending: SnsCacheMigrationCandidate[] = []
  for (const item of candidates) {
    const sourceKey = normalizeFsPathForCompare(item.sourceDir)
    const targetKey = normalizeFsPathForCompare(item.targetDir)
    if (!sourceKey || sourceKey === targetKey) continue
    const dedupeKey = `${sourceKey}=>${targetKey}`
    if (pendingKeys.has(dedupeKey)) continue
    const fileCount = await countFilesInDir(item.sourceDir)
    if (fileCount <= 0) continue
    pendingKeys.add(dedupeKey)
    pending.push({ ...item, fileCount })
  }
  if (pending.length === 0) return null

  const totalFiles = pending.reduce((sum, item) => sum + item.fileCount, 0)
  return {
    legacyBaseDir,
    currentBaseDir,
    candidates: pending,
    totalFiles
  }
}

const runLegacySnsCacheMigration = async (
  plan: SnsCacheMigrationPlan,
  onProgress: (payload: SnsCacheMigrationProgressPayload) => void
): Promise<{ copied: number; skipped: number; totalFiles: number }> => {
  let processed = 0
  let copied = 0
  let skipped = 0
  const total = plan.totalFiles

  const emitProgress = (patch?: Partial<SnsCacheMigrationProgressPayload>) => {
    onProgress({
      status: 'running',
      phase: 'copying',
      current: processed,
      total,
      copied,
      skipped,
      remaining: Math.max(0, total - processed),
      ...patch
    })
  }

  emitProgress({ message: '准备迁移缓存...' })

  for (const item of plan.candidates) {
    emitProgress({ currentItemLabel: item.label, message: `正在迁移：${item.label}` })
    const result = await migrateDirectoryPreserveNewFiles(item.sourceDir, item.targetDir, ({ copied: copiedThisFile }) => {
      processed += 1
      if (copiedThisFile) copied += 1
      else skipped += 1
      emitProgress({ currentItemLabel: item.label })
    })
    // 兜底对齐计数，防止回调未触发造成偏差
    const expectedProcessed = copied + skipped
    if (processed !== expectedProcessed) {
      processed = expectedProcessed
      copied = Math.max(copied, result.copied)
      skipped = Math.max(skipped, result.skipped)
      emitProgress({ currentItemLabel: item.label })
    }
  }

  emitProgress({ phase: 'cleanup', message: '正在清理旧目录...' })
  for (const item of plan.candidates) {
    await rm(item.sourceDir, { recursive: true, force: true })
  }

  if (existsSync(plan.legacyBaseDir)) {
    try {
      const remaining = await readdir(plan.legacyBaseDir)
      if (remaining.length === 0) {
        await rm(plan.legacyBaseDir, { recursive: true, force: true })
      }
    } catch {
      // 忽略旧目录清理失败，不影响迁移结果
    }
  }

  onProgress({
    status: 'done',
    phase: 'done',
    current: processed,
    total,
    copied,
    skipped,
    remaining: Math.max(0, total - processed),
    message: '迁移完成'
  })

  return { copied, skipped, totalFiles: total }
}

// 注册 IPC 处理器
function registerIpcHandlers() {
  registerNotificationHandlers()
  bizService.registerHandlers()
  // 配置相关
  ipcMain.handle('config:get', async (_, key: string) => {
    return configService?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    let result: unknown
    if (key === 'launchAtStartup') {
      result = applyLaunchAtStartupPreference(value === true)
    } else {
      result = configService?.set(key as any, value)
    }
    if (key === 'updateChannel') {
      applyAutoUpdateChannel('settings')
    }
    void messagePushService.handleConfigChanged(key)
    return result
  })

  ipcMain.handle('config:clear', async () => {
    if (isLaunchAtStartupSupported() && getSystemLaunchAtStartup()) {
      const result = setSystemLaunchAtStartup(false)
      if (!result.success && result.error) {
        console.error('[WeFlow] 清空配置时关闭开机自启动失败:', result.error)
      }
    }
    configService?.clear()
    messagePushService.handleConfigCleared()
    return true
  })

  // 文件对话框
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog(options)
  })

  ipcMain.handle('dialog:openDirectory', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      ...options
    })
  })

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showSaveDialog(options)
  })

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    const { shell } = await import('electron')
    return shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const { shell } = await import('electron')
    return shell.openExternal(url)
  })

  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion()
  })

  ipcMain.handle('app:getLaunchAtStartupStatus', async () => {
    return getLaunchAtStartupStatus()
  })

  ipcMain.handle('app:setLaunchAtStartup', async (_, enabled: boolean) => {
    return applyLaunchAtStartupPreference(enabled === true)
  })

  ipcMain.handle('app:checkWayland', async () => {
    if (process.platform !== 'linux') return false;

    const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase();
    return Boolean(process.env.WAYLAND_DISPLAY || sessionType === 'wayland');
  })

  ipcMain.handle('log:getPath', async () => {
    return join(app.getPath('userData'), 'logs', 'wcdb.log')
  })

  ipcMain.handle('log:read', async () => {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      const content = await readFile(logPath, 'utf8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:clear', async () => {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, '', 'utf8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('diagnostics:getExportCardLogs', async (_, options?: { limit?: number }) => {
    return exportCardDiagnosticsService.snapshot(options?.limit)
  })

  ipcMain.handle('diagnostics:clearExportCardLogs', async () => {
    exportCardDiagnosticsService.clear()
    return { success: true }
  })

  ipcMain.handle('diagnostics:exportExportCardLogs', async (_, payload?: {
    filePath?: string
    frontendLogs?: unknown[]
  }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) {
      return { success: false, error: '导出路径不能为空' }
    }
    return exportCardDiagnosticsService.exportCombinedLogs(filePath, payload?.frontendLogs || [])
  })

  // 数据收集服务
  ipcMain.handle('cloud:init', async () => {
    await cloudControlService.init()
  })

  ipcMain.handle('cloud:recordPage', (_, pageName: string) => {
    cloudControlService.recordPage(pageName)
  })

  ipcMain.handle('cloud:getLogs', async () => {
    return cloudControlService.getLogs()
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    if (!AUTO_UPDATE_ENABLED) {
      return { hasUpdate: false }
    }
    // 每次主动检查前重新应用一次通道配置，确保使用最新选择的更新通道。
    applyAutoUpdateChannel('settings')
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version
        if (shouldOfferUpdateForTrack(latestVersion, currentVersion)) {
          return {
            hasUpdate: true,
            version: latestVersion,
            releaseNotes: getDialogReleaseNotes(result.updateInfo.releaseNotes),
            minimumVersion: (result.updateInfo as any).minimumVersion
          }
        }
      }
      return { hasUpdate: false }
    } catch (error) {
      console.error('检查更新失败:', error)
      return { hasUpdate: false }
    }
  })

  ipcMain.handle('app:downloadAndInstall', async (event) => {
    if (!AUTO_UPDATE_ENABLED) {
      throw new Error('自动更新已暂时禁用')
    }

    // 防止重复下载（Issue #294 修复）
    if (isDownloadInProgress) {
      throw new Error('更新正在下载中，请稍候')
    }

    isDownloadInProgress = true
    const win = BrowserWindow.fromWebContents(event.sender)

    // 清理旧的监听器（Issue #294 修复：防止监听器泄漏）
    if (downloadProgressHandler) {
      autoUpdater.removeListener('download-progress', downloadProgressHandler)
      downloadProgressHandler = null
    }
    if (downloadedHandler) {
      autoUpdater.removeListener('update-downloaded', downloadedHandler)
      downloadedHandler = null
    }

    // 创建新的监听器并保存引用
    downloadProgressHandler = (progress) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:downloadProgress', progress)
      }
    }

    downloadedHandler = () => {
      console.log('[Update] 更新下载完成，准备安装')
      if (downloadProgressHandler) {
        autoUpdater.removeListener('download-progress', downloadProgressHandler)
        downloadProgressHandler = null
      }
      downloadedHandler = null
      isDownloadInProgress = false
      autoUpdater.quitAndInstall(false, true)
    }

    autoUpdater.on('download-progress', downloadProgressHandler)
    autoUpdater.once('update-downloaded', downloadedHandler)

    try {
      console.log('[Update] 开始下载更新...')
      await autoUpdater.downloadUpdate()
    } catch (error: any) {
      console.error('[Update] 下载更新失败:', error)
      // 失败时清理状态和监听器
      isDownloadInProgress = false
      if (downloadProgressHandler) {
        autoUpdater.removeListener('download-progress', downloadProgressHandler)
        downloadProgressHandler = null
      }
      if (downloadedHandler) {
        autoUpdater.removeListener('update-downloaded', downloadedHandler)
        downloadedHandler = null
      }
      
      // 统一错误提示格式，避免出现 [object Object] 的 JSON 字符串
      const errorMessage = error.message || (typeof error === 'string' ? error : JSON.stringify(error))
      throw new Error(errorMessage)
    }
  })

  ipcMain.handle('app:ignoreUpdate', async (_, version: string) => {
    configService?.set('ignoredUpdateVersion', version)
    return { success: true }
  })

  // 窗口控制
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return Boolean(win?.isMaximized() || win?.isFullScreen())
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:respondCloseConfirm', async (_event, action: 'tray' | 'quit' | 'cancel') => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      isClosePromptVisible = false
      return false
    }

    try {
      if (action === 'tray') {
        if (tray) {
          mainWindow.hide()
          return true
        }
        return false
      }

      if (action === 'quit') {
        isAppQuitting = true
        app.quit()
        return true
      }

      return true
    } finally {
      isClosePromptVisible = false
    }
  })

  // 更新窗口控件主题色
  ipcMain.on('window:setTitleBarOverlay', (event, options: { symbolColor: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      try {
        win.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: options.symbolColor,
          height: 40
        })
      } catch (error) {
        console.warn('TitleBarOverlay not enabled for this window:', error)
      }
    }
  })

  // 打开视频播放窗口
  ipcMain.handle('window:openVideoPlayerWindow', (_, videoPath: string, videoWidth?: number, videoHeight?: number) => {
    createVideoPlayerWindow(videoPath, videoWidth, videoHeight)
  })

  // 打开聊天记录窗口
  ipcMain.handle('window:openChatHistoryWindow', (_, sessionId: string, messageId: number) => {
    createChatHistoryWindow(sessionId, messageId)
    return true
  })

  ipcMain.handle('window:openChatHistoryPayloadWindow', (_, payload: { sessionId: string; title?: string; recordList: any[] }) => {
    const payloadId = randomUUID()
    chatHistoryPayloadStore.set(payloadId, {
      sessionId: String(payload?.sessionId || '').trim(),
      title: String(payload?.title || '').trim() || '聊天记录',
      recordList: Array.isArray(payload?.recordList) ? payload.recordList : []
    })
    createChatHistoryPayloadWindow(payloadId)
    return true
  })

  ipcMain.handle('window:getChatHistoryPayload', (_, payloadId: string) => {
    const payload = chatHistoryPayloadStore.get(String(payloadId || '').trim())
    if (!payload) return { success: false, error: '聊天记录载荷不存在或已失效' }
    return { success: true, payload }
  })

  // 打开会话聊天窗口（同会话仅保留一个窗口并聚焦）
  ipcMain.handle('window:openSessionChatWindow', (_, sessionId: string, options?: OpenSessionChatWindowOptions) => {
    const win = createSessionChatWindow(sessionId, options)
    return Boolean(win)
  })

  // 根据视频尺寸调整窗口大小
  ipcMain.handle('window:resizeToFitVideo', (event, videoWidth: number, videoHeight: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !videoWidth || !videoHeight) return

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    // 只有标题栏 40px，控制栏悬浮在视频上
    const titleBarHeight = 40
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    let winWidth: number
    let winHeight: number

    if (aspectRatio >= 1) {
      // 横向视频 - 以宽度为基准
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频 - 以高度为基准
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      // 确保宽度不会太窄
      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)

    // 调整窗口大小并居中
    win.setSize(winWidth, winHeight)
    win.center()
  })

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => {
    try {
      const result = await videoService.getVideoInfo(videoMd5, options)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: String(e), exists: false }
    }
  })

  ipcMain.handle('video:parseVideoMd5', async (_, content: string) => {
    try {
      const md5 = videoService.parseVideoMd5(content)
      return { success: true, md5 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 数据库路径相关
  ipcMain.handle('dbpath:autoDetect', async () => {
    return dbPathService.autoDetect()
  })

  ipcMain.handle('dbpath:scanWxids', async (_, rootPath: string) => {
    return dbPathService.scanWxids(rootPath)
  })

  ipcMain.handle('dbpath:scanWxidCandidates', async (_, rootPath: string) => {
    return dbPathService.scanWxidCandidates(rootPath)
  })

  ipcMain.handle('dbpath:getDefault', async () => {
    return dbPathService.getDefaultPath()
  })

  // WCDB 数据库相关
  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string) => {
    return wcdbService.testConnection(dbPath, hexKey, wxid)
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    return wcdbService.open(dbPath, hexKey, wxid)
  })

  ipcMain.handle('wcdb:close', async () => {
    wcdbService.close()
    return true
  })



  // 聊天相关
  ipcMain.handle('chat:connect', async () => {
    return chatService.connect()
  })

  ipcMain.handle('chat:getSessions', async () => {
    return chatService.getSessions()
  })

  ipcMain.handle('chat:getSessionStatuses', async (_, usernames: string[]) => {
    return chatService.getSessionStatuses(usernames)
  })

  ipcMain.handle('chat:getExportTabCounts', async () => {
    return chatService.getExportTabCounts()
  })

  ipcMain.handle('chat:getContactTypeCounts', async () => {
    return chatService.getContactTypeCounts()
  })

  ipcMain.handle('chat:getSessionMessageCounts', async (_, sessionIds: string[]) => {
    return chatService.getSessionMessageCounts(sessionIds)
  })

  ipcMain.handle('chat:enrichSessionsContactInfo', async (_, usernames: string[], options?: {
    skipDisplayName?: boolean
    onlyMissingAvatar?: boolean
  }) => {
    return chatService.enrichSessionsContactInfo(usernames, options)
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => {
    return chatService.getMessages(sessionId, offset, limit, startTime, endTime, ascending)
  })

  ipcMain.handle('chat:getLatestMessages', async (_, sessionId: string, limit?: number) => {
    return chatService.getLatestMessages(sessionId, limit)
  })

  ipcMain.handle('chat:getNewMessages', async (_, sessionId: string, minTime: number, limit?: number) => {
    return chatService.getNewMessages(sessionId, minTime, limit)
  })

  ipcMain.handle('chat:updateMessage', async (_, sessionId: string, localId: number, createTime: number, newContent: string) => {
    return chatService.updateMessage(sessionId, localId, createTime, newContent)
  })

  ipcMain.handle('chat:deleteMessage', async (_, sessionId: string, localId: number, createTime: number, dbPathHint?: string) => {
    return chatService.deleteMessage(sessionId, localId, createTime, dbPathHint)
  })

  ipcMain.handle('chat:checkAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.checkAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:installAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.installAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:uninstallAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.uninstallAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return await chatService.getContact(username)
  })


  ipcMain.handle('chat:getContactAvatar', async (_, username: string) => {
    return await chatService.getContactAvatar(username)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return await chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getContacts', async (_, options?: { lite?: boolean }) => {
    return await chatService.getContacts(options)
  })

  ipcMain.handle('chat:getCachedMessages', async (_, sessionId: string) => {
    return chatService.getCachedSessionMessages(sessionId)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    return chatService.getMyAvatarUrl()
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string) => {
    return chatService.downloadEmoji(cdnUrl, md5)
  })

  ipcMain.handle('chat:close', async () => {
    chatService.close()
    return true
  })

  ipcMain.handle('chat:clearCurrentAccountData', async (_, options?: { clearCache?: boolean; clearExports?: boolean }) => {
    const cfg = configService
    if (!cfg) return { success: false, error: '配置服务未初始化' }

    const clearCache = options?.clearCache === true
    const clearExports = options?.clearExports === true
    if (!clearCache && !clearExports) {
      return { success: false, error: '请至少选择一项清理范围' }
    }

    const rawWxid = String(cfg.get('myWxid') || '').trim()
    if (!rawWxid) {
      return { success: false, error: '当前账号未登录或未识别，无法清理' }
    }
    const normalizedWxid = normalizeAccountId(rawWxid)
    const wxidCandidates = Array.from(new Set([rawWxid, normalizedWxid].filter(Boolean)))
    const isMatchedAccountName = buildAccountNameMatcher(wxidCandidates)
    const removedPaths: string[] = []
    const warnings: string[] = []

    try {
      wcdbService.close()
      chatService.close()
    } catch (error) {
      warnings.push(`关闭数据库连接失败: ${String(error)}`)
    }

    if (clearCache) {
      const [analyticsResult, imageResult] = await Promise.all([
        analyticsService.clearCache(),
        imageDecryptService.clearCache()
      ])
      const chatResult = chatService.clearCaches()
      const cleanupResults = [analyticsResult, imageResult, chatResult]
      for (const result of cleanupResults) {
        if (!result.success && result.error) warnings.push(result.error)
      }

      const configuredCachePath = String(cfg.get('cachePath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const userDataCacheDir = join(app.getPath('userData'), 'cache')
      const cacheRootCandidates = [
        configuredCachePath,
        join(documentsWeFlowDir, 'Images'),
        join(documentsWeFlowDir, 'Voices'),
        join(documentsWeFlowDir, 'Emojis'),
        userDataCacheDir
      ].filter(Boolean)

      for (const wxid of wxidCandidates) {
        if (configuredCachePath) {
          await removePathIfExists(join(configuredCachePath, wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Images', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Voices', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Emojis', wxid), removedPaths, warnings)
        }
        await removePathIfExists(join(documentsWeFlowDir, 'Images', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Voices', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Emojis', wxid), removedPaths, warnings)
        await removePathIfExists(join(userDataCacheDir, wxid), removedPaths, warnings)
      }

      for (const cacheRoot of cacheRootCandidates) {
        await removeMatchedEntriesInDir(cacheRoot, isMatchedAccountName, removedPaths, warnings)
      }
    }

    if (clearExports) {
      const configuredExportPath = String(cfg.get('exportPath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const exportRootCandidates = [
        configuredExportPath,
        join(documentsWeFlowDir, 'exports'),
        join(documentsWeFlowDir, 'Exports')
      ].filter(Boolean)

      for (const exportRoot of exportRootCandidates) {
        await removeMatchedEntriesInDir(exportRoot, isMatchedAccountName, removedPaths, warnings)
      }

      const resetConfigKeys = [
        'exportSessionRecordMap',
        'exportLastSessionRunMap',
        'exportLastContentRunMap',
        'exportSessionMessageCountCacheMap',
        'exportSessionContentMetricCacheMap',
        'exportSnsStatsCacheMap',
        'snsPageCacheMap',
        'contactsListCacheMap',
        'contactsAvatarCacheMap',
        'lastSession'
      ]
      for (const key of resetConfigKeys) {
        const defaultValue = key === 'lastSession' ? '' : {}
        cfg.set(key as any, defaultValue as any)
      }
    }

    if (clearCache) {
      try {
        const wxidConfigsRaw = cfg.get('wxidConfigs') as Record<string, any> | undefined
        if (wxidConfigsRaw && typeof wxidConfigsRaw === 'object') {
          const nextConfigs: Record<string, any> = { ...wxidConfigsRaw }
          for (const key of Object.keys(nextConfigs)) {
            if (isMatchedAccountName(key) || normalizeAccountId(key) === normalizedWxid) {
              delete nextConfigs[key]
            }
          }
          cfg.set('wxidConfigs' as any, nextConfigs as any)
        }
        cfg.set('myWxid' as any, '')
        cfg.set('decryptKey' as any, '')
        cfg.set('imageXorKey' as any, 0)
        cfg.set('imageAesKey' as any, '')
        cfg.set('dbPath' as any, '')
        cfg.set('lastOpenedDb' as any, '')
        cfg.set('onboardingDone' as any, false)
        cfg.set('lastSession' as any, '')
      } catch (error) {
        warnings.push(`清理账号配置失败: ${String(error)}`)
      }
    }

    return {
      success: true,
      removedPaths,
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    }
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    return chatService.getSessionDetail(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailFast', async (_, sessionId: string) => {
    return chatService.getSessionDetailFast(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailExtra', async (_, sessionId: string) => {
    return chatService.getSessionDetailExtra(sessionId)
  })

  ipcMain.handle('chat:getExportSessionStats', async (_, sessionIds: string[], options?: {
    includeRelations?: boolean
    forceRefresh?: boolean
    allowStaleCache?: boolean
    preferAccurateSpecialTypes?: boolean
    cacheOnly?: boolean
  }) => {
    return chatService.getExportSessionStats(sessionIds, options)
  })

  ipcMain.handle('chat:getGroupMyMessageCountHint', async (_, chatroomId: string) => {
    return chatService.getGroupMyMessageCountHint(chatroomId)
  })

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string) => {
    return chatService.getImageData(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceData(sessionId, msgId, createTime, serverId)
  })
  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    return chatService.getAllVoiceMessages(sessionId)
  })
  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })
  ipcMain.handle('chat:getMessageDates', async (_, sessionId: string) => {
    return chatService.getMessageDates(sessionId)
  })
  ipcMain.handle('chat:getMessageDateCounts', async (_, sessionId: string) => {
    return chatService.getMessageDateCounts(sessionId)
  })

  ipcMain.handle('chat:getResourceMessages', async (_, options?: {
    sessionId?: string
    types?: Array<'image' | 'video' | 'voice' | 'file'>
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return chatService.getResourceMessages(options)
  })

  ipcMain.handle('chat:getMediaStream', async (_, options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return wcdbService.getMediaStream(options)
  })
  ipcMain.handle('chat:resolveVoiceCache', async (_, sessionId: string, msgId: string) => {
    return chatService.resolveVoiceCache(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceTranscript', async (event, sessionId: string, msgId: string, createTime?: number) => {
    return chatService.getVoiceTranscript(sessionId, msgId, createTime, (text) => {
      event.sender.send('chat:voiceTranscriptPartial', { sessionId, msgId, createTime, text })
    })
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageById(sessionId, localId)
  })

  ipcMain.handle('chat:searchMessages', async (_, keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) => {
    return chatService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
  })

  ipcMain.handle('sns:getTimeline', async (_, limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => {
    return snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime)
  })

  ipcMain.handle('sns:getSnsUsernames', async () => {
    return snsService.getSnsUsernames()
  })

  ipcMain.handle('sns:getUserPostCounts', async () => {
    return snsService.getUserPostCounts()
  })

  ipcMain.handle('sns:getExportStats', async () => {
    return snsService.getExportStats()
  })

  ipcMain.handle('sns:getExportStatsFast', async () => {
    return snsService.getExportStatsFast()
  })

  ipcMain.handle('sns:getUserPostStats', async (_, username: string) => {
    return snsService.getUserPostStats(username)
  })

  ipcMain.handle('sns:debugResource', async (_, url: string) => {
    return snsService.debugResource(url)
  })

  ipcMain.handle('sns:proxyImage', async (_, payload: string | { url: string; key?: string | number }) => {
    const url = typeof payload === 'string' ? payload : payload?.url
    const key = typeof payload === 'string' ? undefined : payload?.key
    return snsService.proxyImage(url, key)
  })

  ipcMain.handle('sns:downloadImage', async (_, payload: { url: string; key?: string | number }) => {
    try {
      const { url, key } = payload
      const result = await snsService.downloadImage(url, key)

      if (!result.success || !result.data) {
        return { success: false, error: result.error || '下载图片失败' }
      }

      const { dialog } = await import('electron')
      const ext = (result.contentType || '').split('/')[1] || 'jpg'
      const defaultPath = `SNS_${Date.now()}.${ext}`


      const filters = isVideoUrl(url)
        ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv'] }]
        : [{ name: 'Images', extensions: [ext, 'jpg', 'jpeg', 'png', 'webp', 'gif'] }]

      const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath,
        filters
      })

      if (canceled || !filePath) {
        return { success: false, error: '用户已取消' }
      }

      const fs = await import('fs/promises')
      await fs.writeFile(filePath, result.data)

      return { success: true, filePath }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('sns:exportTimeline', async (event, options: any) => {
    const exportOptions = { ...(options || {}) }
    delete exportOptions.taskId

    return snsService.exportTimeline(
      exportOptions,
      (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('sns:exportProgress', progress)
        }
      }
    )
  })

  ipcMain.handle('sns:selectExportDir', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出目录'
    })
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true }
    }
    return { canceled: false, filePath: result.filePaths[0] }
  })

  ipcMain.handle('sns:installBlockDeleteTrigger', async () => {
    return snsService.installSnsBlockDeleteTrigger()
  })

  ipcMain.handle('sns:uninstallBlockDeleteTrigger', async () => {
    return snsService.uninstallSnsBlockDeleteTrigger()
  })

  ipcMain.handle('sns:checkBlockDeleteTrigger', async () => {
    return snsService.checkSnsBlockDeleteTrigger()
  })

  ipcMain.handle('sns:deleteSnsPost', async (_, postId: string) => {
    return snsService.deleteSnsPost(postId)
  })

  ipcMain.handle('sns:downloadEmoji', async (_, params: { url: string; encryptUrl?: string; aesKey?: string }) => {
    return snsService.downloadSnsEmoji(params.url, params.encryptUrl, params.aesKey)
  })

  ipcMain.handle('sns:getCacheMigrationStatus', async () => {
    try {
      const plan = await collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        return {
          success: true,
          needed: false,
          inProgress: snsCacheMigrationInProgress,
          totalFiles: 0,
          items: []
        }
      }
      return {
        success: true,
        needed: true,
        inProgress: snsCacheMigrationInProgress,
        totalFiles: plan.totalFiles,
        legacyBaseDir: plan.legacyBaseDir,
        currentBaseDir: plan.currentBaseDir,
        items: plan.candidates
      }
    } catch (error) {
      return { success: false, needed: false, error: String((error as Error)?.message || error || '') }
    }
  })

  ipcMain.handle('sns:startCacheMigration', async (event) => {
    if (snsCacheMigrationInProgress) {
      return { success: false, error: '迁移任务正在进行中' }
    }

    const sender = event.sender
    let lastProgress: SnsCacheMigrationProgressPayload = {
      status: 'running',
      phase: 'copying',
      current: 0,
      total: 0,
      copied: 0,
      skipped: 0,
      remaining: 0
    }
    const emitProgress = (payload: SnsCacheMigrationProgressPayload) => {
      lastProgress = payload
      if (!sender.isDestroyed()) {
        sender.send('sns:cacheMigrationProgress', payload)
      }
    }

    try {
      const plan = await collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        emitProgress({
          status: 'done',
          phase: 'done',
          current: 0,
          total: 0,
          copied: 0,
          skipped: 0,
          remaining: 0,
          message: '无需迁移'
        })
        return { success: true, copied: 0, skipped: 0, totalFiles: 0, message: '无需迁移' }
      }

      snsCacheMigrationInProgress = true
      const result = await runLegacySnsCacheMigration(plan, emitProgress)
      return { success: true, ...result }
    } catch (error) {
      const message = String((error as Error)?.message || error || '')
      emitProgress({
        ...lastProgress,
        status: 'error',
        phase: 'error',
        message
      })
      return { success: false, error: message }
    } finally {
      snsCacheMigrationInProgress = false
    }
  })

  // 私聊克隆


  ipcMain.handle('image:decrypt', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) => {
    return imageDecryptService.decryptImage(payload)
  })
  ipcMain.handle('image:resolveCache', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; disableUpdateCheck?: boolean }) => {
    return imageDecryptService.resolveCachedImage(payload)
  })
  ipcMain.handle(
    'image:resolveCacheBatch',
    async (
      _,
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>,
      options?: { disableUpdateCheck?: boolean }
    ) => {
      const list = Array.isArray(payloads) ? payloads : []
      const rows = await Promise.all(list.map(async (payload) => {
        return imageDecryptService.resolveCachedImage({
          ...payload,
          disableUpdateCheck: options?.disableUpdateCheck === true
        })
      }))
      return { success: true, rows }
    }
  )
  ipcMain.handle(
    'image:preload',
    async (
      _,
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>,
      options?: { allowDecrypt?: boolean }
    ) => {
    imagePreloadService.enqueue(payloads || [], options)
    return true
  })

  // Windows Hello
  ipcMain.handle('auth:hello', async (event, message?: string) => {
    // 无论哪个窗口调用，都尝试强制附着到主窗口，确保体验一致
    // 如果主窗口不存在（极其罕见），则回退到调用者窗口
    const targetWin = (mainWindow && !mainWindow.isDestroyed())
      ? mainWindow
      : (BrowserWindow.fromWebContents(event.sender) || undefined)

    const result = await windowsHelloService.verify(message, targetWin)

    // Hello 验证成功后，自动用 authHelloSecret 中的密码解锁密钥
    if (result && configService) {
      const secret = configService.getHelloSecret()
      if (secret && configService.isLockMode()) {
        configService.unlock(secret)
      }
    }

    return result
  })

  // 验证应用锁状态（检测 lock: 前缀，防篡改）
  ipcMain.handle('auth:verifyEnabled', async () => {
    return configService?.verifyAuthEnabled() ?? false
  })

  // 密码解锁（验证 + 解密密钥到内存）
  ipcMain.handle('auth:unlock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.unlock(password)
  })

  // 开启应用锁
  ipcMain.handle('auth:enableLock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.enableLock(password)
  })

  // 关闭应用锁
  ipcMain.handle('auth:disableLock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.disableLock(password)
  })

  // 修改密码
  ipcMain.handle('auth:changePassword', async (_event, oldPassword: string, newPassword: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.changePassword(oldPassword, newPassword)
  })

  // 设置 Hello Secret
  ipcMain.handle('auth:setHelloSecret', async (_event, password: string) => {
    if (!configService) return { success: false }
    configService.setHelloSecret(password)
    return { success: true }
  })

  // 清除 Hello Secret
  ipcMain.handle('auth:clearHelloSecret', async () => {
    if (!configService) return { success: false }
    configService.clearHelloSecret()
    return { success: true }
  })

  // 检查是否处于 lock: 模式
  ipcMain.handle('auth:isLockMode', async () => {
    return configService?.isLockMode() ?? false
  })

  // 导出相关
  ipcMain.handle('export:getExportStats', async (_, sessionIds: string[], options: any) => {
    return exportService.getExportStats(sessionIds, options)
  })

  ipcMain.handle('export:exportSessions', async (event, sessionIds: string[], outputDir: string, options: ExportOptions) => {
    const PROGRESS_FORWARD_INTERVAL_MS = 180
    let pendingProgress: ExportProgress | null = null
    let progressTimer: NodeJS.Timeout | null = null
    let lastProgressSentAt = 0

    const flushProgress = () => {
      if (!pendingProgress) return
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send('export:progress', pendingProgress)
      }
      pendingProgress = null
      lastProgressSentAt = Date.now()
    }

    const queueProgress = (progress: ExportProgress) => {
      pendingProgress = progress
      const force = progress.phase === 'complete'
      if (force) {
        flushProgress()
        return
      }

      const now = Date.now()
      const elapsed = now - lastProgressSentAt
      if (elapsed >= PROGRESS_FORWARD_INTERVAL_MS) {
        flushProgress()
        return
      }

      if (progressTimer) return
      progressTimer = setTimeout(() => {
        flushProgress()
      }, PROGRESS_FORWARD_INTERVAL_MS - elapsed)
    }

    const onProgress = (progress: ExportProgress) => {
      queueProgress(progress)
    }

    const runMainFallback = async (reason: string) => {
      console.warn(`[fallback-export-main] ${reason}`)
      return exportService.exportSessions(sessionIds, outputDir, options, onProgress)
    }

    const cfg = configService || new ConfigService()
    configService = cfg
    const logEnabled = cfg.get('logEnabled')
    const dbPath = String(cfg.get('dbPath') || '').trim()
    const decryptKey = String(cfg.get('decryptKey') || '').trim()
    const myWxid = String(cfg.get('myWxid') || '').trim()
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')
    const workerPath = join(__dirname, 'exportWorker.js')

    const runWorker = async () => {
      return await new Promise<any>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            sessionIds,
            outputDir,
            options,
            dbPath,
            decryptKey,
            myWxid,
            resourcesPath,
            userDataPath,
            logEnabled
          }
        })

        let settled = false
        const finalizeResolve = (value: any) => {
          if (settled) return
          settled = true
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const finalizeReject = (error: Error) => {
          if (settled) return
          settled = true
          worker.removeAllListeners()
          void worker.terminate()
          reject(error)
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:progress') {
            onProgress(msg.data as ExportProgress)
            return
          }
          if (msg && msg.type === 'export:result') {
            finalizeResolve(msg.data)
            return
          }
          if (msg && msg.type === 'export:error') {
            finalizeReject(new Error(String(msg.error || '导出 Worker 执行失败')))
          }
        })

        worker.on('error', (error) => {
          finalizeReject(error instanceof Error ? error : new Error(String(error)))
        })

        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            finalizeResolve({ success: false, successCount: 0, failCount: 0, error: '导出 Worker 未返回结果' })
          } else {
            finalizeReject(new Error(`导出 Worker 异常退出: ${code}`))
          }
        })
      })
    }

    try {
      return await runWorker()
    } catch (error) {
      return runMainFallback(error instanceof Error ? error.message : String(error))
    } finally {
      flushProgress()
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
    }
  })

  ipcMain.handle('export:exportSession', async (_, sessionId: string, outputPath: string, options: ExportOptions) => {
    return exportService.exportSessionToChatLab(sessionId, outputPath, options)
  })

  ipcMain.handle('export:exportContacts', async (_, outputDir: string, options: any) => {
    return contactExportService.exportContacts(outputDir, options)
  })

  // 数据分析相关
  ipcMain.handle('analytics:getOverallStatistics', async (_, force?: boolean) => {
    return analyticsService.getOverallStatistics(force)
  })

  ipcMain.handle('analytics:getContactRankings', async (_, limit?: number, beginTimestamp?: number, endTimestamp?: number) => {
    return analyticsService.getContactRankings(limit, beginTimestamp, endTimestamp)
  })

  ipcMain.handle('analytics:getTimeDistribution', async () => {
    return analyticsService.getTimeDistribution()
  })

  ipcMain.handle('analytics:getExcludedUsernames', async () => {
    return analyticsService.getExcludedUsernames()
  })

  ipcMain.handle('analytics:setExcludedUsernames', async (_, usernames: string[]) => {
    return analyticsService.setExcludedUsernames(usernames)
  })

  ipcMain.handle('analytics:getExcludeCandidates', async () => {
    return analyticsService.getExcludeCandidates()
  })

  // 缓存管理
  ipcMain.handle('cache:clearAnalytics', async () => {
    return analyticsService.clearCache()
  })

  ipcMain.handle('cache:clearImages', async () => {
    const imageResult = await imageDecryptService.clearCache()
    const emojiResult = chatService.clearCaches({ includeMessages: false, includeContacts: false, includeEmojis: true })
    const errors = [imageResult, emojiResult]
      .filter((result) => !result.success)
      .map((result) => result.error)
      .filter(Boolean) as string[]
    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') }
    }
    return { success: true }
  })

  ipcMain.handle('cache:clearAll', async () => {
    const [analyticsResult, imageResult] = await Promise.all([
      analyticsService.clearCache(),
      imageDecryptService.clearCache()
    ])
    const chatResult = chatService.clearCaches()
    const errors = [analyticsResult, imageResult, chatResult]
      .filter((result) => !result.success)
      .map((result) => result.error)
      .filter(Boolean) as string[]
    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') }
    }
    return { success: true }
  })

  ipcMain.handle('whisper:downloadModel', async (event) => {
    return voiceTranscribeService.downloadModel((progress) => {
      event.sender.send('whisper:downloadProgress', progress)
    })
  })

  ipcMain.handle('whisper:getModelStatus', async () => {
    return voiceTranscribeService.getModelStatus()
  })

  // 群聊分析相关
  ipcMain.handle('groupAnalytics:getGroupChats', async () => {
    return groupAnalyticsService.getGroupChats()
  })

  ipcMain.handle('groupAnalytics:getGroupMembers', async (_, chatroomId: string) => {
    return groupAnalyticsService.getGroupMembers(chatroomId)
  })

  ipcMain.handle(
    'groupAnalytics:getGroupMembersPanelData',
    async (_, chatroomId: string, options?: { forceRefresh?: boolean; includeMessageCounts?: boolean } | boolean) => {
      const normalizedOptions = typeof options === 'boolean'
        ? { forceRefresh: options }
        : options
      return groupAnalyticsService.getGroupMembersPanelData(chatroomId, normalizedOptions)
    }
  )

  ipcMain.handle('groupAnalytics:getGroupMessageRanking', async (_, chatroomId: string, limit?: number, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupMessageRanking(chatroomId, limit, startTime, endTime)
  })

  ipcMain.handle('groupAnalytics:getGroupActiveHours', async (_, chatroomId: string, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupActiveHours(chatroomId, startTime, endTime)
  })

  ipcMain.handle('groupAnalytics:getGroupMediaStats', async (_, chatroomId: string, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupMediaStats(chatroomId, startTime, endTime)
  })

  ipcMain.handle(
    'groupAnalytics:getGroupMemberAnalytics',
    async (_, chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => {
      return groupAnalyticsService.getGroupMemberAnalytics(chatroomId, memberUsername, startTime, endTime)
    }
  )

  ipcMain.handle(
    'groupAnalytics:getGroupMemberMessages',
    async (
      _,
      chatroomId: string,
      memberUsername: string,
      options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
    ) => {
      return groupAnalyticsService.getGroupMemberMessages(chatroomId, memberUsername, options)
    }
  )

  ipcMain.handle('groupAnalytics:exportGroupMembers', async (_, chatroomId: string, outputPath: string) => {
    return groupAnalyticsService.exportGroupMembers(chatroomId, outputPath)
  })

  ipcMain.handle(
    'groupAnalytics:exportGroupMemberMessages',
    async (_, chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) => {
      return groupAnalyticsService.exportGroupMemberMessages(chatroomId, memberUsername, outputPath, startTime, endTime)
    }
  )

  // 打开协议窗口
  ipcMain.handle('window:openAgreementWindow', async () => {
    createAgreementWindow()
    return true
  })

  // 打开图片查看窗口
  ipcMain.handle('window:openImageViewerWindow', async (_, imagePath: string, liveVideoPath?: string) => {
    // 如果是 dataUrl，写入临时文件
    if (imagePath.startsWith('data:')) {
      const commaIdx = imagePath.indexOf(',')
      const meta = imagePath.slice(5, commaIdx) // e.g. "image/jpeg;base64"
      const ext = meta.split('/')[1]?.split(';')[0] || 'jpg'
      const tmpPath = join(app.getPath('temp'), `weflow_preview_${Date.now()}.${ext}`)
      await writeFile(tmpPath, Buffer.from(imagePath.slice(commaIdx + 1), 'base64'))
      createImageViewerWindow(`file://${tmpPath.replace(/\\/g, '/')}`, liveVideoPath)
    } else {
      createImageViewerWindow(imagePath, liveVideoPath)
    }
  })

  // 完成引导，关闭引导窗口并显示主窗口
  ipcMain.handle('window:completeOnboarding', async () => {
    try {
      configService?.set('onboardingDone', true)
    } catch (e) {
      console.error('保存引导完成状态失败:', e)
    }

    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close()
    }
    showMainWindow()
    return true
  })

  // 重新打开首次引导窗口，并隐藏主窗口
  ipcMain.handle('window:openOnboardingWindow', async () => {
    shouldShowMain = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
    createOnboardingWindow()
    return true
  })

  // 年度报告相关
  ipcMain.handle('annualReport:getAvailableYears', async () => {
    const cfg = configService || new ConfigService()
    configService = cfg
    return annualReportService.getAvailableYears({
      dbPath: cfg.get('dbPath'),
      decryptKey: cfg.get('decryptKey'),
      wxid: cfg.get('myWxid')
    })
  })

  ipcMain.handle('annualReport:startAvailableYearsLoad', async (event) => {
    const cfg = configService || new ConfigService()
    configService = cfg

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.get('myWxid')
    const cacheKey = buildAnnualReportYearsCacheKey(dbPath, wxid)

    const runningTaskId = annualReportYearsTaskByCacheKey.get(cacheKey)
    if (runningTaskId) {
      const runningTask = annualReportYearsLoadTasks.get(runningTaskId)
      if (runningTask && !runningTask.done) {
        return {
          success: true,
          taskId: runningTaskId,
          reused: true,
          snapshot: normalizeAnnualReportYearsSnapshot(runningTask.snapshot)
        }
      }
      annualReportYearsTaskByCacheKey.delete(cacheKey)
    }

    const cachedSnapshot = getAnnualReportYearsSnapshot(cacheKey)
    if (cachedSnapshot && cachedSnapshot.snapshot.done) {
      return {
        success: true,
        taskId: cachedSnapshot.taskId,
        reused: true,
        snapshot: normalizeAnnualReportYearsSnapshot(cachedSnapshot.snapshot)
      }
    }

    const taskId = `years_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const initialSnapshot: AnnualReportYearsProgressPayload = cachedSnapshot?.snapshot && !cachedSnapshot.snapshot.done
      ? {
        ...normalizeAnnualReportYearsSnapshot(cachedSnapshot.snapshot),
        done: false,
        canceled: false,
        error: undefined
      }
      : {
        years: [],
        done: false,
        strategy: 'native',
        phase: 'native',
        statusText: '准备使用原生快速模式加载年份...',
        nativeElapsedMs: 0,
        scanElapsedMs: 0,
        totalElapsedMs: 0,
        switched: false,
        nativeTimedOut: false
      }

    const updateTaskSnapshot = (payload: AnnualReportYearsProgressPayload): AnnualReportYearsProgressPayload | null => {
      const task = annualReportYearsLoadTasks.get(taskId)
      if (!task) return null

      const hasPayloadYears = Array.isArray(payload.years)
      const nextYears = (hasPayloadYears && (payload.done || (payload.years || []).length > 0))
        ? [...(payload.years || [])]
        : Array.isArray(task.snapshot.years) ? [...task.snapshot.years] : []

      const nextSnapshot: AnnualReportYearsProgressPayload = normalizeAnnualReportYearsSnapshot({
        ...task.snapshot,
        ...payload,
        years: nextYears
      })
      task.snapshot = nextSnapshot
      task.done = nextSnapshot.done === true
      task.updatedAt = Date.now()
      annualReportYearsLoadTasks.set(taskId, task)
      persistAnnualReportYearsSnapshot(task.cacheKey, taskId, nextSnapshot)
      return nextSnapshot
    }

    annualReportYearsLoadTasks.set(taskId, {
      cacheKey,
      canceled: false,
      done: false,
      snapshot: normalizeAnnualReportYearsSnapshot(initialSnapshot),
      updatedAt: Date.now()
    })
    annualReportYearsTaskByCacheKey.set(cacheKey, taskId)
    persistAnnualReportYearsSnapshot(cacheKey, taskId, initialSnapshot)

    void (async () => {
      try {
        const result = await annualReportService.getAvailableYears({
          dbPath,
          decryptKey,
          wxid,
          onProgress: (progress) => {
            if (isYearsLoadCanceled(taskId)) return
            const snapshot = updateTaskSnapshot({
              ...progress,
              done: false
            })
            if (!snapshot) return
            broadcastAnnualReportYearsProgress(taskId, snapshot)
          },
          shouldCancel: () => isYearsLoadCanceled(taskId)
        })

        const canceled = isYearsLoadCanceled(taskId)
        if (canceled) {
          const snapshot = updateTaskSnapshot({
            done: true,
            canceled: true,
            phase: 'done',
            statusText: '已取消年份加载'
          })
          if (snapshot) {
            broadcastAnnualReportYearsProgress(taskId, snapshot)
          }
          return
        }

        const completionPayload: AnnualReportYearsProgressPayload = result.success
          ? {
            years: result.data || [],
            done: true,
            strategy: result.meta?.strategy,
            phase: 'done',
            statusText: result.meta?.statusText || '年份数据加载完成',
            nativeElapsedMs: result.meta?.nativeElapsedMs,
            scanElapsedMs: result.meta?.scanElapsedMs,
            totalElapsedMs: result.meta?.totalElapsedMs,
            switched: result.meta?.switched,
            nativeTimedOut: result.meta?.nativeTimedOut
          }
          : {
            years: result.data || [],
            done: true,
            error: result.error || '加载年度数据失败',
            strategy: result.meta?.strategy,
            phase: 'done',
            statusText: result.meta?.statusText || '年份数据加载失败',
            nativeElapsedMs: result.meta?.nativeElapsedMs,
            scanElapsedMs: result.meta?.scanElapsedMs,
            totalElapsedMs: result.meta?.totalElapsedMs,
            switched: result.meta?.switched,
            nativeTimedOut: result.meta?.nativeTimedOut
          }

        const snapshot = updateTaskSnapshot(completionPayload)
        if (snapshot) {
          broadcastAnnualReportYearsProgress(taskId, snapshot)
        }
      } catch (e) {
        const snapshot = updateTaskSnapshot({
          done: true,
          error: String(e),
          phase: 'done',
          statusText: '年份数据加载失败',
          strategy: 'hybrid'
        })
        if (snapshot) {
          broadcastAnnualReportYearsProgress(taskId, snapshot)
        }
      } finally {
        const task = annualReportYearsLoadTasks.get(taskId)
        if (task) {
          annualReportYearsTaskByCacheKey.delete(task.cacheKey)
        }
        annualReportYearsLoadTasks.delete(taskId)
      }
    })()

    return {
      success: true,
      taskId,
      reused: false,
      snapshot: normalizeAnnualReportYearsSnapshot(initialSnapshot)
    }
  })

  ipcMain.handle('annualReport:cancelAvailableYearsLoad', async (_, taskId: string) => {
    const key = String(taskId || '').trim()
    if (!key) return { success: false, error: '任务ID不能为空' }
    const task = annualReportYearsLoadTasks.get(key)
    if (!task) return { success: true }
    task.canceled = true
    annualReportYearsLoadTasks.set(key, task)
    return { success: true }
  })

  ipcMain.handle('annualReport:generateReport', async (_, year: number) => {
    const cfg = configService || new ConfigService()
    configService = cfg

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.get('myWxid')
    const logEnabled = cfg.get('logEnabled')

    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')

    const workerPath = join(__dirname, 'annualReportWorker.js')

    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { year, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled }
      })

      const cleanup = () => {
        worker.removeAllListeners()
      }

      worker.on('message', (msg: any) => {
        if (msg && msg.type === 'annualReport:progress') {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('annualReport:progress', msg.data)
            }
          }
          return
        }
        if (msg && (msg.type === 'annualReport:result' || msg.type === 'done')) {
          cleanup()
          void worker.terminate()
          resolve(msg.data ?? msg.result)
          return
        }
        if (msg && (msg.type === 'annualReport:error' || msg.type === 'error')) {
          cleanup()
          void worker.terminate()
          resolve({ success: false, error: msg.error || '年度报告生成失败' })
        }
      })

      worker.on('error', (err) => {
        cleanup()
        resolve({ success: false, error: String(err) })
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          cleanup()
          resolve({ success: false, error: `年度报告线程异常退出: ${code}` })
        }
      })
    })
  })

  ipcMain.handle('dualReport:generateReport', async (_, payload: { friendUsername: string; year: number }) => {
    const cfg = configService || new ConfigService()
    configService = cfg

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.get('myWxid')
    const logEnabled = cfg.get('logEnabled')
    const friendUsername = payload?.friendUsername
    const year = payload?.year ?? 0
    const excludeWords = cfg.get('wordCloudExcludeWords') || []

    if (!friendUsername) {
      return { success: false, error: '缺少好友用户名' }
    }

    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')

    const workerPath = join(__dirname, 'dualReportWorker.js')

    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { year, friendUsername, dbPath, decryptKey, myWxid: wxid, resourcesPath, userDataPath, logEnabled, excludeWords }
      })

      const cleanup = () => {
        worker.removeAllListeners()
      }

      worker.on('message', (msg: any) => {
        if (msg && msg.type === 'dualReport:progress') {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('dualReport:progress', msg.data)
            }
          }
          return
        }
        if (msg && (msg.type === 'dualReport:result' || msg.type === 'done')) {
          cleanup()
          void worker.terminate()
          resolve(msg.data ?? msg.result)
          return
        }
        if (msg && (msg.type === 'dualReport:error' || msg.type === 'error')) {
          cleanup()
          void worker.terminate()
          resolve({ success: false, error: msg.error || '双人报告生成失败' })
        }
      })

      worker.on('error', (err) => {
        cleanup()
        resolve({ success: false, error: String(err) })
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          cleanup()
          resolve({ success: false, error: `双人报告线程异常退出: ${code}` })
        }
      })
    })
  })

  ipcMain.handle('annualReport:exportImages', async (_, payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) => {
    try {
      const { baseDir, folderName, images } = payload
      if (!baseDir || !folderName || !Array.isArray(images) || images.length === 0) {
        return { success: false, error: '导出参数无效' }
      }

      let targetDir = join(baseDir, folderName)
      if (existsSync(targetDir)) {
        let idx = 2
        while (existsSync(`${targetDir}_${idx}`)) idx++
        targetDir = `${targetDir}_${idx}`
      }

      await mkdir(targetDir, { recursive: true })

      for (const img of images) {
        const dataUrl = img.dataUrl || ''
        const commaIndex = dataUrl.indexOf(',')
        if (commaIndex <= 0) continue
        const base64 = dataUrl.slice(commaIndex + 1)
        const buffer = Buffer.from(base64, 'base64')
        const filePath = join(targetDir, img.name)
        await writeFile(filePath, buffer)
      }

      return { success: true, dir: targetDir }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 密钥获取
  ipcMain.handle('key:autoGetDbKey', async (event) => {
    return keyService.autoGetDbKey(180_000, (message: string, level: number) => {
      event.sender.send('key:dbKeyStatus', { message, level })
    })
  })

  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string, wxid?: string) => {
    return keyService.autoGetImageKey(manualDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    }, wxid)
  })

  ipcMain.handle('key:scanImageKeyFromMemory', async (event, userDir: string) => {
    return keyService.autoGetImageKeyByMemoryScan(userDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    })
  })

  // HTTP API 服务
  ipcMain.handle('http:start', async (_, port?: number, host?: string) => {
    const bindHost = typeof host === 'string' && host.trim() ? host.trim() : '127.0.0.1'
    return httpService.start(port || 5031, bindHost)
  })

  ipcMain.handle('http:stop', async () => {
    await httpService.stop()
    return { success: true }
  })

  ipcMain.handle('http:status', async () => {
    return {
      running: httpService.isRunning(),
      port: httpService.getPort(),
      mediaExportPath: httpService.getDefaultMediaExportPath()
    }
  })

}

// 主窗口引用
let mainWindow: BrowserWindow | null = null

// 启动时自动检测更新
function checkForUpdatesOnStartup() {
  if (!AUTO_UPDATE_ENABLED) return
  // 开发环境不检测更新
  if (process.env.VITE_DEV_SERVER_URL) return

  // 延迟3秒检测，等待窗口完全加载
  setTimeout(async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version

        // 检查是否有新版本
        if (shouldOfferUpdateForTrack(latestVersion, currentVersion) && mainWindow) {
          // 检查该版本是否被用户忽略
          const ignoredVersion = configService?.get('ignoredUpdateVersion')
          if (ignoredVersion === latestVersion) {

            return
          }

          // 通知渲染进程有新版本
          mainWindow.webContents.send('app:updateAvailable', {
            version: latestVersion,
            releaseNotes: getDialogReleaseNotes(result.updateInfo.releaseNotes),
            minimumVersion: (result.updateInfo as any).minimumVersion
          })
        }
      }
    } catch (error) {
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}

app.whenReady().then(async () => {
  // 立即创建 Splash 窗口，确保用户尽快看到反馈
  createSplashWindow()

  // 等待 Splash 页面加载完成后再推送进度
  if (splashWindow) {
    await new Promise<void>((resolve) => {
      if (splashWindow!.webContents.isLoading()) {
        splashWindow!.webContents.once('did-finish-load', () => resolve())
      } else {
        resolve()
      }
    })
    splashWindow.webContents
      .executeJavaScript(`setVersion(${JSON.stringify(app.getVersion())})`)
      .catch(() => {})
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  // 初始化配置服务
  updateSplashProgress(5, '正在加载配置...')
  configService = new ConfigService()
  applyAutoUpdateChannel('startup')
  syncLaunchAtStartupPreference()

  // 将用户主题配置推送给 Splash 窗口
  if (splashWindow && !splashWindow.isDestroyed()) {
    const themeId = configService.get('themeId') || 'cloud-dancer'
    const themeMode = configService.get('theme') || 'system'
    splashWindow.webContents
      .executeJavaScript(`applyTheme(${JSON.stringify(themeId)}, ${JSON.stringify(themeMode)})`)
      .catch(() => {})
  }
  await delay(200)

  // 设置资源路径
  updateSplashProgress(10, '正在初始化...')
  const candidateResources = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const fallbackResources = join(process.cwd(), 'resources')
  const resourcesPath = existsSync(candidateResources) ? candidateResources : fallbackResources
  const userDataPath = app.getPath('userData')
  await delay(200)

  // 初始化数据库服务
  updateSplashProgress(18, '正在初始化...')
  wcdbService.setPaths(resourcesPath, userDataPath)
  wcdbService.setLogEnabled(configService.get('logEnabled') === true)
  await delay(200)

  // 注册 IPC 处理器
  updateSplashProgress(25, '正在初始化...')
  registerIpcHandlers()
  chatService.addDbMonitorListener((type, json) => {
    messagePushService.handleDbMonitorChange(type, json)
  })
  messagePushService.start()
  await delay(200)

  // 检查配置状态
  const onboardingDone = configService.get('onboardingDone')
  shouldShowMain = onboardingDone === true

  // 创建主窗口（不显示，由启动流程统一控制）
  updateSplashProgress(30, '正在加载界面...')
  mainWindow = createWindow({ autoShow: false })

  let iconName = 'icon.ico';
  if (process.platform === 'linux') {
    iconName = 'icon.png';
  } else if (process.platform === 'darwin') {
    iconName = 'icon.icns';
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL

  const resolvedTrayIcon = isDev
      ? join(__dirname, `../public/${iconName}`)
      : join(process.resourcesPath, iconName);


  try {
    tray = new Tray(resolvedTrayIcon)
    tray.setToolTip('WeFlow')
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isAppQuitting = true
          app.quit()
        }
      }
    ])
    tray.setContextMenu(contextMenu)
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (e) {
    console.warn('[Tray] Failed to create tray icon:', e)
  }

  // 配置网络服务
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: ['*://*.qpic.cn/*', '*://*.wx.qq.com/*']
    },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://wx.qq.com/'
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // 等待主窗口加载完成（真正耗时阶段，进度条末端呼吸光点）
  updateSplashProgress(30, '正在加载界面...', true)
  await new Promise<void>((resolve) => {
    if (mainWindowReady) {
      resolve()
    } else {
      mainWindow!.once('ready-to-show', () => {
        mainWindowReady = true
        resolve()
      })
    }
  })

  // 加载完成，收尾
  updateSplashProgress(100, '启动完成')
  await new Promise((resolve) => setTimeout(resolve, 250))
  closeSplash()

  if (!onboardingDone) {
    createOnboardingWindow()
  } else {
    mainWindow?.show()
  }

  // 启动时检测更新（不阻塞启动）
  checkForUpdatesOnStartup()

  await httpService.autoStart()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('before-quit', async () => {
  isAppQuitting = true
  // 销毁 tray 图标
  if (tray) { try { tray.destroy() } catch {} tray = null }
  // 通知窗使用 hide 而非 close，退出时主动销毁，避免残留窗口阻塞进程退出。
  destroyNotificationWindow()
  // 兜底：5秒后强制退出，防止某个异步任务卡住导致进程残留
  const forceExitTimer = setTimeout(() => {
    console.warn('[App] Force exit after timeout')
    app.exit(0)
  }, 5000)
  forceExitTimer.unref()
  // 停止 HTTP 服务器，释放 TCP 端口占用，避免进程无法退出
  try { await httpService.stop() } catch {}
  // 终止 wcdb Worker 线程，避免线程阻止进程退出
  try { await wcdbService.shutdown() } catch {}
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
