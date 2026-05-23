import './preload-env'
import { app, BrowserWindow, ipcMain, nativeTheme, session, Tray, Menu, nativeImage } from 'electron'
import { join, dirname } from 'path'
import { autoUpdater } from 'electron-updater'
import { existsSync } from 'fs'
import { ConfigService } from './services/config'
import { wcdbService } from './services/wcdbService'
import { chatService } from './services/chatService'
import { logOptionalError } from './utils/logOptionalError'
import { fileLogService } from './utils/fileLogService'
import { KeyService } from './services/keyService'
import { KeyServiceLinux } from './services/keyServiceLinux'
import { KeyServiceMac } from './services/keyServiceMac'
import { cloudControlService } from './services/cloudControlService'
import { destroyNotificationWindow, registerNotificationHandlers, setNotificationNavigateHandler } from './windows/notificationWindow'
import { httpService } from './services/httpService'
import { messagePushService } from './services/messagePushService'
import { insightService } from './services/insightService'
import { bizService } from './services/bizService'
import { imageDownloadService } from './services/imageDownloadService'
import { registerDatabaseHandlers } from './ipc/databaseHandlers'
import { registerChatHandlers } from './ipc/chatHandlers'
import { registerAnalyticsHandlers } from './ipc/analyticsHandlers'
import { registerConfigHandlers } from './ipc/configHandlers'
import { registerSystemHandlers } from './ipc/systemHandlers'
import { registerAppHandlers } from './ipc/appHandlers'
import { registerWindowHandlers } from './ipc/windowHandlers'
import { registerSnsHandlers } from './ipc/snsHandlers'
import { registerImageHandlers } from './ipc/imageHandlers'
import { registerAuthHandlers } from './ipc/authHandlers'
import { registerExportHandlers } from './ipc/exportHandlers'
import { registerReportHandlers } from './ipc/reportHandlers'
import { MainIpcContext, OpenSessionChatWindowOptions } from './ipc/mainIpcContext'
import { createLaunchAtStartupHelpers } from './app/launchAtStartup'
import { createAutoUpdateHelpers, AUTO_UPDATE_ENABLED } from './app/autoUpdateHelpers'
import { createSnsCacheMigrationRuntime } from './services/snsCacheMigration'
import { deleteChatHistoryPayload } from './ipc/chatHistoryPayloadStore'

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
let configService: ConfigService | null = null
const getConfigService = () => configService
const launchAtStartup = createLaunchAtStartupHelpers(getConfigService)
const autoUpdate = createAutoUpdateHelpers(getConfigService)
const snsMigration = createSnsCacheMigrationRuntime(getConfigService)
autoUpdate.applyAutoUpdateChannel('startup')

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
let isShutdownHandled = false
let shutdownPromise: Promise<void> | null = null
let tray: Tray | null = null
let isClosePromptVisible = false

type WindowCloseBehavior = 'ask' | 'tray' | 'quit'

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

let notificationNavigateHandlerRegistered = false
const focusMainWindowAndNavigate = (sessionId: string): void => {
  const targetWindow = mainWindow
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  targetWindow.focus()
  targetWindow.webContents.send('navigate-to-session', sessionId)
}

const focusMainWindowAndNavigateRoute = (route: string): void => {
  const targetWindow = mainWindow
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  targetWindow.focus()
  targetWindow.webContents.send('navigate-to-route', route)
}

const handleNotificationClickNavigation = (payload: unknown): void => {
  if (payload && typeof payload === 'object') {
    const data = payload as { sessionId?: string; channel?: string; insightRecordId?: string; targetRoute?: string }
    const targetRoute = String(data.targetRoute || '').trim()
    if (targetRoute.startsWith('/')) {
      focusMainWindowAndNavigateRoute(targetRoute)
      return
    }
    if (data.channel === 'ai-insight' && data.insightRecordId) {
      focusMainWindowAndNavigateRoute(`/insight-inbox?recordId=${encodeURIComponent(String(data.insightRecordId))}`)
      return
    }
    focusMainWindowAndNavigate(String(data.sessionId || ''))
    return
  }
  focusMainWindowAndNavigate(String(payload || ''))
}

const ensureNotificationNavigateHandlerRegistered = (): void => {
  if (notificationNavigateHandlerRegistered) return
  notificationNavigateHandlerRegistered = true
  ipcMain.on('notification-clicked', (_event, payload) => {
    handleNotificationClickNavigation(payload)
  })
  setNotificationNavigateHandler((payload: unknown) => {
    handleNotificationClickNavigation(payload)
  })
}

let wechatRequestHeaderInterceptorRegistered = false
const ensureWeChatRequestHeaderInterceptor = (): void => {
  if (wechatRequestHeaderInterceptorRegistered) return
  wechatRequestHeaderInterceptorRegistered = true

  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.qpic.cn/*',
        '*://*.qlogo.cn/*',
        '*://*.wechat.com/*',
        '*://*.weixin.qq.com/*',
        '*://*.wx.qq.com/*'
      ]
    },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351"
      details.requestHeaders['Accept'] = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      details.requestHeaders['Accept-Encoding'] = "gzip, deflate, br"
      details.requestHeaders['Accept-Language'] = "zh-CN,zh;q=0.9"
      details.requestHeaders['Connection'] = "keep-alive"
      details.requestHeaders['Range'] = "bytes=0-"

      let host = ''
      try {
        host = new URL(details.url).hostname.toLowerCase()
      } catch {}
      const isWxQQ = host === 'wx.qq.com' || host.endsWith('.wx.qq.com')
      details.requestHeaders['Referer'] = isWxQQ ? 'https://wx.qq.com/' : 'https://servicewechat.com/'

      callback({ cancel: false, requestHeaders: details.requestHeaders })
    }
  )
}

const getWindowCloseBehavior = (): WindowCloseBehavior => {
  const behavior = configService?.get('windowCloseBehavior')
  return behavior === 'tray' || behavior === 'quit' ? behavior : 'ask'
}

const isSilentStartupEnabled = (): boolean => {
  return configService?.get('silentStartup') === true
}

const requestMainWindowCloseConfirmation = (win: BrowserWindow): void => {
  if (isClosePromptVisible) return
  isClosePromptVisible = true
  win.webContents.send('window:confirmCloseRequested', {
    canMinimizeToTray: Boolean(tray)
  })
}

function resolveAppIconPath(iconName?: string): string {
  let resolvedName = iconName
  if (!resolvedName) {
    if (process.platform === 'linux') resolvedName = 'icon.png'
    else if (process.platform === 'darwin') resolvedName = 'icon.icns'
    else resolvedName = 'icon.ico'
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  if (!isDev) {
    return join(process.resourcesPath, resolvedName)
  }

  const candidates: string[] = []
  if (process.platform === 'darwin' && resolvedName === 'icon.icns') {
    candidates.push(
      join(__dirname, '../resources/icons/macos/icon.icns'),
      join(process.cwd(), 'resources/icons/macos/icon.icns')
    )
  }
  candidates.push(
    join(__dirname, `../public/${resolvedName}`),
    join(process.cwd(), `public/${resolvedName}`)
  )
  if (resolvedName !== 'icon.png') {
    candidates.push(
      join(__dirname, '../public/icon.png'),
      join(process.cwd(), 'public/icon.png')
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return candidates[0] || join(__dirname, `../public/${resolvedName}`)
}

function resolveTrayIcon(): Electron.NativeImage | string {
  const iconPath = resolveAppIconPath()
  const image = nativeImage.createFromPath(iconPath)
  if (!image.isEmpty()) return image

  const pngCandidates = [
    join(__dirname, '../public/icon.png'),
    join(process.cwd(), 'public/icon.png')
  ]
  for (const pngPath of pngCandidates) {
    if (!existsSync(pngPath)) continue
    const png = nativeImage.createFromPath(pngPath)
    if (!png.isEmpty()) return png
  }

  return iconPath
}

function createWindow(options: { autoShow?: boolean } = {}) {
  // 获取图标路径 - 打包后在 resources 目录
  const { autoShow = true } = options
  const iconPath = resolveAppIconPath()

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
  const splashThemeId = configService?.get('themeId') || 'cloud-dancer'
  const splashThemeMode = configService?.get('theme') || 'system'
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

  splashWindow = new BrowserWindow({
    width: 680,
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
    const splashUrl = new URL('splash.html', process.env.VITE_DEV_SERVER_URL)
    splashUrl.searchParams.set('themeId', splashThemeId)
    splashUrl.searchParams.set('themeMode', splashThemeMode)
    splashWindow.loadURL(splashUrl.toString())
  } else {
    splashWindow.loadFile(join(__dirname, '../dist/splash.html'), {
      query: {
        themeId: splashThemeId,
        themeMode: splashThemeMode
      }
    })
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
function createOnboardingWindow(mode: 'default' | 'add-account' = 'default') {
  const onboardingHash = mode === 'add-account'
    ? '/onboarding-window?mode=add-account'
    : '/onboarding-window'

  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    if (process.env.VITE_DEV_SERVER_URL) {
      onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${onboardingHash}`)
    } else {
      onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: onboardingHash })
    }
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
    onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${onboardingHash}`)
  } else {
    onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: onboardingHash })
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
  const win = createChatHistoryRouteWindow(`/chat-history-inline/${payloadId}`)
  win.on('closed', () => {
    deleteChatHistoryPayload(payloadId)
  })
  return win
}

function createChatHistoryRouteWindow(route: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : (process.platform === 'darwin' 
        ? join(process.resourcesPath, 'icon.icns')
        : join(process.resourcesPath, 'icon.ico'))

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
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true
  })
  setupCustomTitleBarWindow(win)

  let hasShown = false
  let isReadyToShow = false
  let hasLoadedRoute = false
  const showChatHistoryWindow = () => {
    if (hasShown || !isReadyToShow || !hasLoadedRoute || win.isDestroyed()) return
    hasShown = true
    win.show()
  }

  win.webContents.once('did-finish-load', () => {
    hasLoadedRoute = true
    setTimeout(showChatHistoryWindow, 30)
  })
  win.webContents.once('did-fail-load', () => {
    hasLoadedRoute = true
    showChatHistoryWindow()
  })
  win.once('ready-to-show', () => {
    isReadyToShow = true
    showChatHistoryWindow()
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

function closeOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close()
  }
}

function buildMainIpcContext(): MainIpcContext {
  return {
    getConfigService: () => configService,
    setConfigService: (service) => { configService = service },
    getMainWindow: () => mainWindow,
    getTray: () => tray,
    getIsAppQuitting: () => isAppQuitting,
    setIsAppQuitting: (value) => { isAppQuitting = value },
    getIsClosePromptVisible: () => isClosePromptVisible,
    setIsClosePromptVisible: (value) => { isClosePromptVisible = value },
    setShouldShowMain: (value) => { shouldShowMain = value },
    createVideoPlayerWindow,
    createChatHistoryWindow,
    createChatHistoryPayloadWindow,
    createSessionChatWindow,
    createAgreementWindow,
    createImageViewerWindow,
    createOnboardingWindow,
    closeOnboardingWindow,
    showMainWindow,
    launchAtStartup,
    autoUpdate,
    snsMigration,
    keyService,
    ensureNotificationNavigateHandlerRegistered
  }
}

// 注册 IPC 处理器
function registerIpcHandlers() {
  const ctx = buildMainIpcContext()
  registerNotificationHandlers()
  bizService.registerHandlers()
  registerDatabaseHandlers(() => configService)
  registerChatHandlers(() => configService)
  registerAnalyticsHandlers()
  registerConfigHandlers(ctx)
  registerSystemHandlers(ctx)
  registerAppHandlers(ctx)
  registerWindowHandlers(ctx)
  registerSnsHandlers(ctx)
  registerImageHandlers()
  registerAuthHandlers(ctx)
  registerExportHandlers(ctx)
  registerReportHandlers(ctx)
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
        if (autoUpdate.shouldOfferUpdateForTrack(latestVersion, currentVersion) && mainWindow) {
          // 检查该版本是否被用户忽略
          const ignoredVersion = configService?.get('ignoredUpdateVersion')
          if (ignoredVersion === latestVersion) {

            return
          }

          // 通知渲染进程有新版本
          mainWindow.webContents.send('app:updateAvailable', {
            version: latestVersion,
            releaseNotes: autoUpdate.getDialogReleaseNotes(result.updateInfo.releaseNotes),
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
  // 先初始化配置，以便在启动早期判定是否需要静默启动
  configService = new ConfigService()
  autoUpdate.applyAutoUpdateChannel('startup')
  launchAtStartup.syncLaunchAtStartupPreference()
  const onboardingDone = configService.get('onboardingDone') === true
  const startInBackground = onboardingDone && isSilentStartupEnabled()
  shouldShowMain = onboardingDone

  if (!startInBackground) {
    // 非静默模式下显示 Splash，提供启动反馈
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
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const withTimeout = <T>(task: () => Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T; error?: string }> => {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ timedOut: true, error: `timeout(${timeoutMs}ms)` })
      }, timeoutMs)

      task()
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ timedOut: false, value })
        })
        .catch((error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ timedOut: false, error: String(error) })
        })
    })
  }

  updateSplashProgress(5, '正在加载配置...')

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
  updateSplashProgress(12, '正在初始化...')
  const candidateResources = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const fallbackResources = join(process.cwd(), 'resources')
  const resourcesPath = existsSync(candidateResources) ? candidateResources : fallbackResources
  const userDataPath = app.getPath('userData')
  fileLogService.setUserDataPath(userDataPath)
  await delay(200)

  // 初始化数据库服务
  updateSplashProgress(20, '正在初始化...')
  wcdbService.setPaths(resourcesPath, userDataPath)
  wcdbService.setLogEnabled(configService.get('logEnabled') === true)
  fileLogService.setLogEnabled(configService.get('logEnabled') === true)
  await delay(200)

  // 注册 IPC 处理器
  updateSplashProgress(28, '正在初始化...')
  registerIpcHandlers()
  if (configService.get('autoDownloadHighRes')) {
    const whitelistArr = configService.get('autoDownloadWhitelist') || []
    const whitelistStr = (Array.isArray(whitelistArr) && whitelistArr.length > 0)
      ? (whitelistArr.join('\0') + '\0\0')
      : ''
    imageDownloadService.startAutoDownload(whitelistStr)
  }
  chatService.addDbMonitorListener((type, json) => {
    messagePushService.handleDbMonitorChange(type, json)
    insightService.handleDbMonitorChange(type, json)
  })
  messagePushService.start()
  insightService.start()
  await delay(200)

  // 已完成引导时，在 Splash 阶段预热核心数据（联系人、消息库索引等）
  if (onboardingDone) {
    updateSplashProgress(34, '正在连接数据库...')
    const connectWarmup = await withTimeout(() => chatService.connect(), 12000)
    const connected = !connectWarmup.timedOut && connectWarmup.value?.success === true

    if (!connected) {
      const reason = connectWarmup.timedOut
        ? connectWarmup.error
        : (connectWarmup.value?.error || connectWarmup.error || 'unknown')
      console.warn('[StartupWarmup] 跳过预热，数据库连接失败:', reason)
      updateSplashProgress(68, '数据库预热已跳过')
    } else {
      const preloadUsernames = new Set<string>()

      updateSplashProgress(44, '正在预加载会话...')
      const sessionsWarmup = await withTimeout(() => chatService.getSessions(), 12000)
      if (!sessionsWarmup.timedOut && sessionsWarmup.value?.success && Array.isArray(sessionsWarmup.value.sessions)) {
        for (const session of sessionsWarmup.value.sessions) {
          const username = String((session as any)?.username || '').trim()
          if (username) preloadUsernames.add(username)
        }
      }

      updateSplashProgress(56, '正在预加载联系人...')
      const contactsWarmup = await withTimeout(() => chatService.getContacts(), 15000)
      if (!contactsWarmup.timedOut && contactsWarmup.value?.success && Array.isArray(contactsWarmup.value.contacts)) {
        for (const contact of contactsWarmup.value.contacts) {
          const username = String((contact as any)?.username || '').trim()
          if (username) preloadUsernames.add(username)
        }
      }

      updateSplashProgress(63, '正在缓存联系人头像...')
      const avatarWarmupUsernames = Array.from(preloadUsernames).slice(0, 2000)
      if (avatarWarmupUsernames.length > 0) {
        await withTimeout(() => chatService.enrichSessionsContactInfo(avatarWarmupUsernames), 15000)
      }

      updateSplashProgress(68, '正在初始化消息库索引...')
      await withTimeout(() => chatService.warmupMessageDbSnapshot(), 10000)
    }
  } else {
    updateSplashProgress(68, '首次启动准备中...')
  }

  // 创建主窗口（不显示，由启动流程统一控制）
  updateSplashProgress(70, '正在准备主窗口...')
  ensureWeChatRequestHeaderInterceptor()
  mainWindow = createWindow({ autoShow: false })

  const resolvedTrayIcon = resolveTrayIcon()


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

  // 等待主窗口加载完成（真正耗时阶段，进度条末端呼吸光点）
  updateSplashProgress(70, '正在准备主窗口...', true)
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
  } else if (startInBackground && tray) {
    mainWindow?.hide()
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

const broadcastAppShuttingDown = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('app:shutting-down')
    } catch (error) {
      logOptionalError('App.broadcastShuttingDown', error)
    }
  }
}

const shutdownAppServices = async (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    isAppQuitting = true
    broadcastAppShuttingDown()
    // 销毁 tray 图标
    if (tray) {
      try { tray.destroy() } catch (error) { logOptionalError('App.shutdown.tray', error) }
      tray = null
    }
    // 通知窗使用 hide 而非 close，退出时主动销毁，避免残留窗口阻塞进程退出。
    destroyNotificationWindow()
    messagePushService.stop()
    insightService.stop()
    // 兜底：5秒后强制退出，防止某个异步任务卡住导致进程残留
    const forceExitTimer = setTimeout(() => {
      console.warn('[App] Force exit after timeout')
      app.exit(0)
    }, 5000)
    forceExitTimer.unref()
    try { await cloudControlService.stop() } catch (error) { logOptionalError('App.shutdown.cloudControl', error) }
    // 停止自动下载服务
    try { await imageDownloadService.stopAutoDownload() } catch (error) { logOptionalError('App.shutdown.imageDownload', error) }
    // 停止 chatService（内部会关闭 cursor 与 DB），避免退出阶段仍触发监控回调
    try { await chatService.close() } catch (error) { logOptionalError('App.shutdown.chatService', error) }
    // 停止 HTTP 服务器，释放 TCP 端口占用，避免进程无法退出
    try { await httpService.stop() } catch (error) { logOptionalError('App.shutdown.httpService', error) }
    // 终止 wcdb Worker 线程，避免线程阻止进程退出
    try { await wcdbService.shutdown() } catch (error) { logOptionalError('App.shutdown.wcdbService', error) }
  })()
  return shutdownPromise
}

app.on('before-quit', (event) => {
  if (isShutdownHandled) return
  event.preventDefault()
  isShutdownHandled = true
  void shutdownAppServices().finally(() => {
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

