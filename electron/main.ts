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
import { llamaService } from './services/llamaService'
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
const keyService = new KeyService()

let mainWindowReady = false
let shouldShowMain = true

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
  win.once('ready-to-show', () => {
    mainWindowReady = true
    if (autoShow || shouldShowMain) {
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
function createImageViewerWindow(imagePath: string) {
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

  const imageParam = `imagePath=${encodeURIComponent(imagePath)}`

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
    const win = BrowserWindow.fromWebContents(event.sender)

    // 监听下载进度
    autoUpdater.on('download-progress', (progress) => {
      win?.webContents.send('app:downloadProgress', progress)
    })

    // 下载完成后自动安装
    autoUpdater.on('update-downloaded', () => {
      autoUpdater.quitAndInstall(false, true)
    })

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      console.error('下载更新失败:', error)
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

  ipcMain.handle('chat:enrichSessionsContactInfo', async (_, usernames: string[]) => {
    return chatService.enrichSessionsContactInfo(usernames)
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

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return await chatService.getContact(username)
  })

  // Llama AI
  ipcMain.handle('llama:init', async () => {
    return await llamaService.init()
  })

  ipcMain.handle('llama:loadModel', async (_, modelPath: string) => {
    return llamaService.loadModel(modelPath)
  })

  ipcMain.handle('llama:createSession', async (_, systemPrompt?: string) => {
    return llamaService.createSession(systemPrompt)
  })

  ipcMain.handle('llama:chat', async (event, message: string, options?: { thinking?: boolean }) => {
    // We use a callback to stream back to the renderer
    const webContents = event.sender
    try {
      if (!webContents) return { success: false, error: 'No sender' }

      const response = await llamaService.chat(message, options, (token) => {
        if (!webContents.isDestroyed()) {
          webContents.send('llama:token', token)
        }
      })
      return { success: true, response }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('llama:downloadModel', async (event, url: string, savePath: string) => {
    const webContents = event.sender
    try {
      await llamaService.downloadModel(url, savePath, (payload) => {
        if (!webContents.isDestroyed()) {
          webContents.send('llama:downloadProgress', payload)
        }
      })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('llama:getModelsPath', async () => {
    return llamaService.getModelsPath()
  })

  ipcMain.handle('llama:checkFileExists', async (_, filePath: string) => {
    const { existsSync } = await import('fs')
    return existsSync(filePath)
  })

  ipcMain.handle('llama:getModelStatus', async (_, modelPath: string) => {
    return llamaService.getModelStatus(modelPath)
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

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string) => {
    return chatService.getImageData(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceData(sessionId, msgId, createTime, serverId)
  })
  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    return chatService.getAllVoiceMessages(sessionId)
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

    return windowsHelloService.verify(message, targetWin)
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
  ipcMain.handle('window:openImageViewerWindow', (_, imagePath: string) => {
    createImageViewerWindow(imagePath)
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

  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string) => {
    return keyService.autoGetImageKey(manualDir, (message) => {
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

app.whenReady().then(() => {
  configService = new ConfigService()
  const candidateResources = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const fallbackResources = join(process.cwd(), 'resources')
  const resourcesPath = existsSync(candidateResources) ? candidateResources : fallbackResources
  const userDataPath = app.getPath('userData')
  wcdbService.setPaths(resourcesPath, userDataPath)
  wcdbService.setLogEnabled(configService.get('logEnabled') === true)
  registerIpcHandlers()
  const onboardingDone = configService.get('onboardingDone')
  shouldShowMain = onboardingDone === true
  mainWindow = createWindow({ autoShow: shouldShowMain })

  if (!onboardingDone) {
    createOnboardingWindow()
  }

  // 解决朋友圈图片无法加载问题（添加 Referer）
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: ['*://*.qpic.cn/*', '*://*.wx.qq.com/*']
    },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://wx.qq.com/'
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // 启动时检测更新
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
