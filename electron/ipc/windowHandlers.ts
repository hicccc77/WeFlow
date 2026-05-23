import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import {
  getChatHistoryPayloadStore,
  pruneChatHistoryPayloadStore,
  ChatHistoryPayloadEntry
} from './chatHistoryPayloadStore'
import { MainIpcContext } from './mainIpcContext'

export function registerWindowHandlers(ctx: MainIpcContext) {
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
    const mainWindow = ctx.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      ctx.setIsClosePromptVisible(false)
      return false
    }

    try {
      if (action === 'tray') {
        if (ctx.getTray()) {
          mainWindow.hide()
          return true
        }
        return false
      }

      if (action === 'quit') {
        ctx.setIsAppQuitting(true)
        app.quit()
        return true
      }

      return true
    } finally {
      ctx.setIsClosePromptVisible(false)
    }
  })

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

  ipcMain.handle('window:openVideoPlayerWindow', (_, videoPath: string, videoWidth?: number, videoHeight?: number) => {
    ctx.createVideoPlayerWindow(videoPath, videoWidth, videoHeight)
  })

  ipcMain.handle('window:openChatHistoryWindow', (_, sessionId: string, messageId: number) => {
    ctx.createChatHistoryWindow(sessionId, messageId)
    return true
  })

  ipcMain.handle('window:openChatHistoryPayloadWindow', (_, payload: { sessionId: string; title?: string; recordList: any[] }) => {
    const payloadId = randomUUID()
    const chatHistoryPayloadStore = getChatHistoryPayloadStore()
    pruneChatHistoryPayloadStore()
    const now = Date.now()
    chatHistoryPayloadStore.set(payloadId, {
      sessionId: String(payload?.sessionId || '').trim(),
      title: String(payload?.title || '').trim() || '聊天记录',
      recordList: Array.isArray(payload?.recordList) ? payload.recordList : [],
      createdAt: now,
      lastAccessedAt: now
    })
    pruneChatHistoryPayloadStore()
    ctx.createChatHistoryPayloadWindow(payloadId)
    return true
  })

  ipcMain.handle('window:getChatHistoryPayload', (_, payloadId: string) => {
    const chatHistoryPayloadStore = getChatHistoryPayloadStore()
    pruneChatHistoryPayloadStore()
    const normalizedPayloadId = String(payloadId || '').trim()
    const payload = chatHistoryPayloadStore.get(normalizedPayloadId)
    if (!payload) return { success: false, error: '聊天记录载荷不存在或已失效' }
    const nextPayload: ChatHistoryPayloadEntry = {
      ...payload,
      lastAccessedAt: Date.now()
    }
    chatHistoryPayloadStore.set(normalizedPayloadId, nextPayload)
    return {
      success: true,
      payload: {
        sessionId: nextPayload.sessionId,
        title: nextPayload.title,
        recordList: nextPayload.recordList
      }
    }
  })

  ipcMain.handle('window:openSessionChatWindow', (_, sessionId: string, options?: Parameters<MainIpcContext['createSessionChatWindow']>[1]) => {
    const win = ctx.createSessionChatWindow(sessionId, options)
    return Boolean(win)
  })

  ipcMain.handle('window:resizeToFitVideo', (event, videoWidth: number, videoHeight: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !videoWidth || !videoHeight) return

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    const titleBarHeight = 40
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    let winWidth: number
    let winHeight: number

    if (aspectRatio >= 1) {
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
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

    win.setSize(winWidth, winHeight)
    win.center()
  })

  ipcMain.handle('window:openAgreementWindow', async () => {
    ctx.createAgreementWindow()
    return true
  })

  ipcMain.handle('window:openImageViewerWindow', async (_, imagePath: string, liveVideoPath?: string) => {
    if (imagePath.startsWith('data:')) {
      const commaIdx = imagePath.indexOf(',')
      const meta = imagePath.slice(5, commaIdx)
      const ext = meta.split('/')[1]?.split(';')[0] || 'jpg'
      const tmpPath = join(app.getPath('temp'), `weflow_preview_${Date.now()}.${ext}`)
      await writeFile(tmpPath, Buffer.from(imagePath.slice(commaIdx + 1), 'base64'))
      ctx.createImageViewerWindow(`file://${tmpPath.replace(/\\/g, '/')}`, liveVideoPath)
    } else {
      ctx.createImageViewerWindow(imagePath, liveVideoPath)
    }
  })

  ipcMain.handle('window:completeOnboarding', async () => {
    try {
      ctx.getConfigService()?.set('onboardingDone', true)
    } catch (e) {
      console.error('保存引导完成状态失败:', e)
    }

    ctx.closeOnboardingWindow()
    ctx.showMainWindow()
    return true
  })

  ipcMain.handle('window:openOnboardingWindow', async (_, options?: { mode?: 'add-account' }) => {
    ctx.setShouldShowMain(false)
    const mainWindow = ctx.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
    const mode = options?.mode === 'add-account' ? 'add-account' : 'default'
    ctx.createOnboardingWindow(mode)
    return true
  })
}
