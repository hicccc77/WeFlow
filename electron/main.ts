import './preload-env'
import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron'
import { Worker } from 'worker_threads'
import { join, dirname } from 'path'
import { autoUpdater } from 'electron-updater'
import { readFile, writeFile, mkdir } from 'fs/promises'
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
import { voiceTranscribeService } from './services/voiceTranscribeService'
import { videoService } from './services/videoService'
import { snsService, isVideoUrl } from './services/snsService'
import { contactExportService } from './services/contactExportService'
import { windowsHelloService } from './services/windowsHelloService'
import { exportCardDiagnosticsService } from './services/exportCardDiagnosticsService'

import { registerNotificationHandlers, showNotification } from './windows/notificationWindow'
import { httpService } from './services/httpService'


// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，强制全量下载
const AUTO_UPDATE_ENABLED =
  process.env.AUTO_UPDATE_ENABLED === 'true' ||
  process.env.AUTO_UPDATE_ENABLED === '1' ||
  (process.env.AUTO_UPDATE_ENABLED == null && !process.env.VITE_DEV_SERVER_URL)

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
let configService: ConfigService | null = null

// 协议窗口实例
let agreementWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null
// Splash 启动窗口
let splashWindow: BrowserWindow | null = null
const sessionChatWindows = new Map<string, BrowserWindow>()
const keyService = new KeyService()

let mainWindowReady = false
let shouldShowMain = true

// 更新下载状态管理（Issue #294 修复）
let isDownloadInProgress = false
let downloadProgressHandler: ((progress: any) => void) | null = null
let downloadedHandler: (() => void) | null = null

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

function createWindow(options: { autoShow?: boolean } = {}) {
  // 获取图标路径 - 打包后在 resources 目录
  const { autoShow = true } = options
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

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
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#1a1a1a',
      height: 40
    },
    show: false
  })

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
    : join(process.resourcesPath, 'icon.ico')

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
    : join(process.resourcesPath, 'icon.ico')

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
    : join(process.resourcesPath, 'icon.ico')

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
    : join(process.resourcesPath, 'icon.ico')

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
    : join(process.resourcesPath, 'icon.ico')

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
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
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
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

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
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#ffffff' : '#1a1a1a',
      height: 32
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/chat-history/${sessionId}/${messageId}`)

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
      hash: `/chat-history/${sessionId}/${messageId}`
    })
  }

  return win
}

/**
 * 创建独立的会话聊天窗口（单会话，复用聊天页右侧消息区域）
 */
function createSessionChatWindow(sessionId: string) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return null

  const existing = sessionChatWindows.get(normalizedSessionId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.focus()
    return existing
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 560,
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

  const sessionParam = `sessionId=${encodeURIComponent(normalizedSessionId)}`
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/chat-window?${sessionParam}`)

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
      hash: `/chat-window?${sessionParam}`
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
    }
  })

  sessionChatWindows.set(normalizedSessionId, win)
  return win
}

function showMainWindow() {
  shouldShowMain = true
  if (mainWindowReady) {
    mainWindow?.show()
  }
}

// 注册 IPC 处理器
function registerIpcHandlers() {
  registerNotificationHandlers()
  // 配置相关
  ipcMain.handle('config:get', async (_, key: string) => {
    return configService?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    return configService?.set(key as any, value)
  })

  ipcMain.handle('config:clear', async () => {
    configService?.clear()
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

  ipcMain.handle('app:checkForUpdates', async () => {
    if (!AUTO_UPDATE_ENABLED) {
      return { hasUpdate: false }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version
        if (latestVersion !== currentVersion) {
          return {
            hasUpdate: true,
            version: latestVersion,
            releaseNotes: result.updateInfo.releaseNotes as string || ''
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
    } catch (error) {
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
      throw error
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

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
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

  // 打开会话聊天窗口（同会话仅保留一个窗口并聚焦）
  ipcMain.handle('window:openSessionChatWindow', (_, sessionId: string) => {
    const win = createSessionChatWindow(sessionId)
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
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string) => {
    try {
      const result = await videoService.getVideoInfo(videoMd5)
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

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return await chatService.getContact(username)
  })


  ipcMain.handle('chat:getContactAvatar', async (_, username: string) => {
    return await chatService.getContactAvatar(username)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return await chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getContacts', async () => {
    return await chatService.getContacts()
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
  ipcMain.handle('chat:resolveVoiceCache', async (_, sessionId: string, msgId: string) => {
    return chatService.resolveVoiceCache(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceTranscript', async (event, sessionId: string, msgId: string, createTime?: number) => {
    return chatService.getVoiceTranscript(sessionId, msgId, createTime, (text) => {
      event.sender.send('chat:voiceTranscriptPartial', { msgId, text })
    })
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageById(sessionId, localId)
  })

  ipcMain.handle('chat:execQuery', async (_, kind: string, path: string | null, sql: string) => {
    return chatService.execQuery(kind, path, sql)
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

  // 私聊克隆


  ipcMain.handle('image:decrypt', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) => {
    return imageDecryptService.decryptImage(payload)
  })
  ipcMain.handle('image:resolveCache', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }) => {
    return imageDecryptService.resolveCachedImage(payload)
  })
  ipcMain.handle('image:preload', async (_, payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }>) => {
    imagePreloadService.enqueue(payloads || [])
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
    const onProgress = (progress: ExportProgress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('export:progress', progress)
      }
    }

    return exportService.exportSessions(sessionIds, outputDir, options, onProgress)
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
          nativeTimeoutMs: 5000,
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
    return keyService.autoGetDbKey(60_000, (message, level) => {
      event.sender.send('key:dbKeyStatus', { message, level })
    })
  })

  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string, wxid?: string) => {
    return keyService.autoGetImageKey(manualDir, (message) => {
      event.sender.send('key:imageKeyStatus', { message })
    }, wxid)
  })

  ipcMain.handle('key:scanImageKeyFromMemory', async (event, userDir: string) => {
    return keyService.autoGetImageKeyByMemoryScan(userDir, (message) => {
      event.sender.send('key:imageKeyStatus', { message })
    })
  })

  // HTTP API 服务
  ipcMain.handle('http:start', async (_, port?: number) => {
    return httpService.start(port || 5031)
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
        if (latestVersion !== currentVersion && mainWindow) {
          // 检查该版本是否被用户忽略
          const ignoredVersion = configService?.get('ignoredUpdateVersion')
          if (ignoredVersion === latestVersion) {

            return
          }

          // 通知渲染进程有新版本
          mainWindow.webContents.send('app:updateAvailable', {
            version: latestVersion,
            releaseNotes: result.updateInfo.releaseNotes || ''
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
  await delay(200)

  // 检查配置状态
  const onboardingDone = configService.get('onboardingDone')
  shouldShowMain = onboardingDone === true

  // 创建主窗口（不显示，由启动流程统一控制）
  updateSplashProgress(30, '正在加载界面...')
  mainWindow = createWindow({ autoShow: false })

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
