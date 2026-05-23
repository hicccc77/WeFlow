import { ipcMain } from 'electron'
import { snsService, isVideoUrl } from '../services/snsService'
import { exportTaskControlService } from '../services/exportTaskControlService'
import {
  activeExportTasks,
  normalizeExportTaskId,
  finalizeExportTaskControlResult
} from './exportTaskRuntime'
import { SnsCacheMigrationProgressPayload } from '../services/snsCacheMigration'
import { MainIpcContext } from './mainIpcContext'

export function registerSnsHandlers(ctx: MainIpcContext) {
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
    const taskId = normalizeExportTaskId(exportOptions.taskId)
    delete exportOptions.taskId
    const taskControl = taskId ? exportTaskControlService.createControl(taskId, String(exportOptions.outputDir || '')) : undefined
    if (taskId) activeExportTasks.add(taskId)

    try {
      const result = await snsService.exportTimeline(
        exportOptions,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('sns:exportProgress', progress)
          }
        },
        taskControl
      )
      return finalizeExportTaskControlResult(taskId, result)
    } finally {
      if (taskId) activeExportTasks.delete(taskId)
    }
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
      const plan = await ctx.snsMigration.collectLegacySnsCacheMigrationPlan()
      if (!plan) {
        return {
          success: true,
          needed: false,
          inProgress: ctx.snsMigration.getInProgress(),
          totalFiles: 0,
          items: []
        }
      }
      return {
        success: true,
        needed: true,
        inProgress: ctx.snsMigration.getInProgress(),
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
    if (ctx.snsMigration.getInProgress()) {
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
      const plan = await ctx.snsMigration.collectLegacySnsCacheMigrationPlan()
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

      ctx.snsMigration.setInProgress(true)
      const result = await ctx.snsMigration.runLegacySnsCacheMigration(plan, emitProgress)
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
      ctx.snsMigration.setInProgress(false)
    }
  })
}
