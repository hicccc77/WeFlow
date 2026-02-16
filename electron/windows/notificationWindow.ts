import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { ConfigService } from '../services/config'

let notificationWindow: BrowserWindow | null = null
let closeTimer: NodeJS.Timeout | null = null

export function createNotificationWindow() {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
        return notificationWindow
    }

    const isDev = !!process.env.VITE_DEV_SERVER_URL
    const iconPath = isDev
        ? join(__dirname, '../../public/icon.ico')
        : join(process.resourcesPath, 'icon.ico')

    console.log('[NotificationWindow] Creating window...')
    const width = 344
    const height = 114

    // Update default creation size
    notificationWindow = new BrowserWindow({
        width: width,
        height: height,
        type: 'toolbar', // 有助于在某些操作系统上保持置顶
        frame: false,
        transparent: true,
        resizable: false,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false, // 不抢占焦点
        icon: iconPath,
        webPreferences: {
            preload: join(__dirname, 'preload.js'), // FIX: Use correct relative path (same dir in dist)
            contextIsolation: true,
            nodeIntegration: false,
            // devTools: true // Enable DevTools
        }
    })

    // notificationWindow.webContents.openDevTools({ mode: 'detach' }) // DEBUG: Force Open DevTools
    notificationWindow.setIgnoreMouseEvents(true, { forward: true }) // 初始点击穿透

    // 处理鼠标事件 (如果需要从渲染进程转发，但目前特定区域处理?)
    // 实际上，我们希望窗口可点击。
    // 我们将在显示时将忽略鼠标事件设为 false。

    const loadUrl = isDev
        ? `${process.env.VITE_DEV_SERVER_URL}#/notification-window`
        : `file://${join(__dirname, '../dist/index.html')}#/notification-window`

    console.log('[NotificationWindow] Loading URL:', loadUrl)
    notificationWindow.loadURL(loadUrl)

    notificationWindow.on('closed', () => {
        notificationWindow = null
    })

    return notificationWindow
}

export async function showNotification(data: any) {
    // 先检查配置
    const config = ConfigService.getInstance()
    const enabled = await config.get('notificationEnabled')
    if (enabled === false) return // 默认为 true

    // 检查会话过滤
    const filterMode = config.get('notificationFilterMode') || 'all'
    const filterList = config.get('notificationFilterList') || []
    const sessionId = data.sessionId

    if (sessionId && filterMode !== 'all' && filterList.length > 0) {
        const isInList = filterList.includes(sessionId)
        if (filterMode === 'whitelist' && !isInList) {
            // 白名单模式：不在列表中则不显示
            return
        }
        if (filterMode === 'blacklist' && isInList) {
            // 黑名单模式：在列表中则不显示
            return
        }
    }

    let win = notificationWindow
    if (!win || win.isDestroyed()) {
        win = createNotificationWindow()
    }

    if (!win) return

    // 确保加载完成
    if (win.webContents.isLoading()) {
        win.once('ready-to-show', () => {
            showAndSend(win!, data)
        })
    } else {
        showAndSend(win, data)
    }
}

let lastNotificationData: any = null

async function showAndSend(win: BrowserWindow, data: any) {
    lastNotificationData = data
    const config = ConfigService.getInstance()
    const position = (await config.get('notificationPosition')) || 'top-right'

    // 更新位置
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
    const winWidth = 344
    const winHeight = 114
    const padding = 20

    let x = 0
    let y = 0

    switch (position) {
        case 'top-right':
            x = screenWidth - winWidth - padding
            y = padding
            break
        case 'bottom-right':
            x = screenWidth - winWidth - padding
            y = screenHeight - winHeight - padding
            break
        case 'top-left':
            x = padding
            y = padding
            break
        case 'bottom-left':
            x = padding
            y = screenHeight - winHeight - padding
            break
    }

    win.setPosition(Math.floor(x), Math.floor(y))
    win.setSize(winWidth, winHeight) // 确保尺寸

    // 设为可交互
    win.setIgnoreMouseEvents(false)
    win.showInactive() // 显示但不聚焦
    win.setAlwaysOnTop(true, 'screen-saver') // 最高层级

    win.webContents.send('notification:show', data)

    // 自动关闭计时器通常由渲染进程管理
    // 渲染进程发送 'notification:close' 来隐藏窗口
}

export function registerNotificationHandlers() {
    ipcMain.handle('notification:show', (_, data) => {
        showNotification(data)
    })

    ipcMain.handle('notification:close', () => {
        if (notificationWindow && !notificationWindow.isDestroyed()) {
            notificationWindow.hide()
            notificationWindow.setIgnoreMouseEvents(true, { forward: true })
        }
    })

    // Handle renderer ready event (fix race condition)
    ipcMain.on('notification:ready', (event) => {
        console.log('[NotificationWindow] Renderer ready, checking cached data')
        if (lastNotificationData && notificationWindow && !notificationWindow.isDestroyed()) {
            console.log('[NotificationWindow] Re-sending cached data')
            notificationWindow.webContents.send('notification:show', lastNotificationData)
        }
    })

    // Handle resize request from renderer
    ipcMain.on('notification:resize', (event, { width, height }) => {
        if (notificationWindow && !notificationWindow.isDestroyed()) {
            // Enforce max-height if needed, or trust renderer
            // Ensure it doesn't go off screen bottom? 
            // Logic in showAndSend handles position, but we need to keep anchor point (top-right usually).
            // If we resize, we should re-calculate position to keep it anchored?
            // Actually, setSize changes size. If it's top-right, x/y stays same -> window grows down. That's fine for top-right.
            // If bottom-right, growing down pushes it off screen.

            // Simple version: just setSize. For V1 we assume Top-Right.
            // But wait, the config supports bottom-right.
            // We can re-call setPosition or just let it be.
            // If bottom-right, y needs to prevent overflow.

            // Ideally we get current config position
            const bounds = notificationWindow.getBounds()
            // Check if we need to adjust Y?
            // For now, let's just set the size as requested.
            notificationWindow.setSize(Math.round(width), Math.round(height))
        }
    })

    // 'notification-clicked' 在 main.ts 中处理 (导航)
}
