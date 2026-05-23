import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { AUTO_UPDATE_ENABLED } from '../app/autoUpdateHelpers'
import { MainIpcContext } from './mainIpcContext'

export function registerAppHandlers(ctx: MainIpcContext) {
  ctx.ensureNotificationNavigateHandlerRegistered()

  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion()
  })

  ipcMain.handle('app:getLaunchAtStartupStatus', async () => {
    return ctx.launchAtStartup.getLaunchAtStartupStatus()
  })

  ipcMain.handle('app:setLaunchAtStartup', async (_, enabled: boolean) => {
    return ctx.launchAtStartup.applyLaunchAtStartupPreference(enabled === true)
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    if (!AUTO_UPDATE_ENABLED) {
      return { hasUpdate: false }
    }
    ctx.autoUpdate.applyAutoUpdateChannel('settings')
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version
        if (ctx.autoUpdate.shouldOfferUpdateForTrack(latestVersion, currentVersion)) {
          return {
            hasUpdate: true,
            version: latestVersion,
            releaseNotes: ctx.autoUpdate.getDialogReleaseNotes(result.updateInfo.releaseNotes),
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

    if (ctx.autoUpdate.getIsDownloadInProgress()) {
      throw new Error('更新正在下载中，请稍候')
    }

    ctx.autoUpdate.setIsDownloadInProgress(true)
    const win = BrowserWindow.fromWebContents(event.sender)

    if (ctx.autoUpdate.getDownloadProgressHandler()) {
      autoUpdater.removeListener('download-progress', ctx.autoUpdate.getDownloadProgressHandler()!)
      ctx.autoUpdate.setDownloadProgressHandler(null)
    }
    if (ctx.autoUpdate.getDownloadedHandler()) {
      autoUpdater.removeListener('update-downloaded', ctx.autoUpdate.getDownloadedHandler()!)
      ctx.autoUpdate.setDownloadedHandler(null)
    }

    const downloadProgressHandler = (progress: any) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:downloadProgress', progress)
      }
    }

    const downloadedHandler = () => {
      console.log('[Update] 更新下载完成，准备安装')
      if (ctx.autoUpdate.getDownloadProgressHandler()) {
        autoUpdater.removeListener('download-progress', ctx.autoUpdate.getDownloadProgressHandler()!)
        ctx.autoUpdate.setDownloadProgressHandler(null)
      }
      ctx.autoUpdate.setDownloadedHandler(null)
      ctx.autoUpdate.setIsDownloadInProgress(false)
      autoUpdater.quitAndInstall(false, true)
    }

    ctx.autoUpdate.setDownloadProgressHandler(downloadProgressHandler)
    ctx.autoUpdate.setDownloadedHandler(downloadedHandler)

    autoUpdater.on('download-progress', downloadProgressHandler)
    autoUpdater.once('update-downloaded', downloadedHandler)

    try {
      console.log('[Update] 开始下载更新...')
      await autoUpdater.downloadUpdate()
    } catch (error: any) {
      console.error('[Update] 下载更新失败:', error)
      ctx.autoUpdate.setIsDownloadInProgress(false)
      if (ctx.autoUpdate.getDownloadProgressHandler()) {
        autoUpdater.removeListener('download-progress', ctx.autoUpdate.getDownloadProgressHandler()!)
        ctx.autoUpdate.setDownloadProgressHandler(null)
      }
      if (ctx.autoUpdate.getDownloadedHandler()) {
        autoUpdater.removeListener('update-downloaded', ctx.autoUpdate.getDownloadedHandler()!)
        ctx.autoUpdate.setDownloadedHandler(null)
      }

      const errorCode = typeof error?.code === 'string' ? error.code : ''
      const rawErrorMessage =
        typeof error?.message === 'string'
          ? error.message
          : (typeof error === 'string' ? error : JSON.stringify(error))

      if (errorCode === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' || /ZIP file not provided/i.test(rawErrorMessage)) {
        throw new Error('当前发布版本缺少 macOS 自动更新所需的 ZIP 包，请联系开发者重新发布该版本')
      }

      throw new Error(rawErrorMessage || '下载更新失败，请稍后重试')
    }
  })

  ipcMain.handle('app:ignoreUpdate', async (_, version: string) => {
    ctx.getConfigService()?.set('ignoredUpdateVersion', version)
    return { success: true }
  })
}
