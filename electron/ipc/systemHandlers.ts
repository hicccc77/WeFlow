import { ipcMain } from 'electron'
import { fileLogService } from '../utils/fileLogService'
import { exportCardDiagnosticsService } from '../services/exportCardDiagnosticsService'
import { cloudControlService } from '../services/cloudControlService'
import { httpService } from '../services/httpService'
import { videoService } from '../services/videoService'
import { MainIpcContext } from './mainIpcContext'

export function registerSystemHandlers(ctx: MainIpcContext) {
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

  ipcMain.handle('log:getPath', async () => {
    return fileLogService.getLogDir()
  })

  ipcMain.handle('log:read', async () => {
    try {
      return { success: true, content: fileLogService.readAll() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:clear', async () => {
    try {
      fileLogService.clearAll()
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

  ipcMain.handle('cloud:init', async () => {
    await cloudControlService.init()
  })

  ipcMain.handle('cloud:recordPage', (_, pageName: string) => {
    cloudControlService.recordPage(pageName)
  })

  ipcMain.handle('cloud:getLogs', async () => {
    return cloudControlService.getLogs()
  })

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

  ipcMain.handle('key:autoGetDbKey', async (event) => {
    return ctx.keyService.autoGetDbKey(180_000, (message: string, level: number) => {
      event.sender.send('key:dbKeyStatus', { message, level })
    })
  })

  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string, wxid?: string) => {
    return ctx.keyService.autoGetImageKey(manualDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    }, wxid)
  })

  ipcMain.handle('key:scanImageKeyFromMemory', async (event, userDir: string) => {
    return ctx.keyService.autoGetImageKeyByMemoryScan(userDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    })
  })
}
