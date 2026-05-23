import { app } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { ipcMain } from 'electron'
import { ConfigService } from '../services/config'
import { exportService, ExportOptions, ExportProgress } from '../services/exportService'
import { exportTaskControlService } from '../services/exportTaskControlService'
import {
  activeExportWorkers,
  activeExportTasks,
  normalizeExportTaskId,
  postExportWorkerControl,
  finalizeExportTaskControlResult
} from './exportTaskRuntime'
import { MainIpcContext } from './mainIpcContext'

export function registerExportHandlers(ctx: MainIpcContext) {
  ipcMain.handle('export:getExportStats', async (_, sessionIds: string[], options: ExportOptions) => {
    return exportService.getExportStats(sessionIds, options)
  })

  ipcMain.handle('export:pauseTask', async (_, taskId: string) => {
    const normalizedTaskId = normalizeExportTaskId(taskId)
    if (!normalizedTaskId) return { success: false, error: '缺少导出任务 ID' }
    const success = exportTaskControlService.pauseTask(normalizedTaskId)
    if (success) postExportWorkerControl(normalizedTaskId, 'pause')
    return { success }
  })

  ipcMain.handle('export:resumeTask', async (_, taskId: string) => {
    const normalizedTaskId = normalizeExportTaskId(taskId)
    if (!normalizedTaskId) return { success: false, error: '缺少导出任务 ID' }
    const success = exportTaskControlService.resumeTask(normalizedTaskId)
    if (success) postExportWorkerControl(normalizedTaskId, 'resume')
    return { success }
  })

  ipcMain.handle('export:cancelTask', async (_, taskId: string) => {
    const normalizedTaskId = normalizeExportTaskId(taskId)
    if (!normalizedTaskId) return { success: false, error: '缺少导出任务 ID' }
    const success = exportTaskControlService.cancelTask(normalizedTaskId)
    if (success) postExportWorkerControl(normalizedTaskId, 'cancel')
    if (success && !activeExportTasks.has(normalizedTaskId)) {
      const cleanup = await exportTaskControlService.cleanupTask(normalizedTaskId)
      return cleanup.success
        ? { success: true, cleanup }
        : { success: false, error: cleanup.error || '清理已导出文件失败' }
    }
    return { success }
  })

  ipcMain.handle('export:exportSessions', async (event, sessionIds: string[], outputDir: string, options: ExportOptions, controlOptions?: { taskId?: string }) => {
    const taskId = normalizeExportTaskId(controlOptions?.taskId)
    if (taskId) exportTaskControlService.createControl(taskId, outputDir)
    if (taskId) activeExportTasks.add(taskId)
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

    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)
    const logEnabled = cfg.get('logEnabled')
    const dbPath = String(cfg.get('dbPath') || '').trim()
    const decryptKey = String(cfg.get('decryptKey') || '').trim()
    const myWxid = String(cfg.getMyWxidCleaned() || '').trim()
    const imageKeys = cfg.getImageKeysForCurrentWxid()
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')
    const workerPath = join(__dirname, '../exportWorker.js')

    const runWorker = async () => {
      return await new Promise<any>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            sessionIds,
            outputDir,
            options,
            taskId,
            dbPath,
            decryptKey,
            myWxid,
            imageXorKey: imageKeys.xorKey,
            imageAesKey: imageKeys.aesKey,
            resourcesPath,
            userDataPath,
            logEnabled
          }
        })

        let settled = false
        if (taskId) {
          activeExportWorkers.set(taskId, worker)
        }
        const finalizeResolve = (value: any) => {
          if (settled) return
          settled = true
          if (taskId && activeExportWorkers.get(taskId) === worker) {
            activeExportWorkers.delete(taskId)
          }
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const finalizeReject = (error: Error) => {
          if (settled) return
          settled = true
          if (taskId && activeExportWorkers.get(taskId) === worker) {
            activeExportWorkers.delete(taskId)
          }
          worker.removeAllListeners()
          void worker.terminate()
          reject(error)
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:progress') {
            onProgress(msg.data as ExportProgress)
            return
          }
          if (msg && msg.type === 'export:createdFiles' && taskId) {
            const filePaths = Array.isArray(msg.filePaths) ? msg.filePaths : []
            for (const filePath of filePaths) {
              exportTaskControlService.recordCreatedFile(taskId, String(filePath || ''))
            }
            return
          }
          if (msg && msg.type === 'export:createdDirs' && taskId) {
            const dirPaths = Array.isArray(msg.dirPaths) ? msg.dirPaths : []
            for (const dirPath of dirPaths) {
              exportTaskControlService.recordCreatedDir(taskId, String(dirPath || ''))
            }
            return
          }
          if (msg && msg.type === 'export:createdFile' && taskId) {
            exportTaskControlService.recordCreatedFile(taskId, String(msg.filePath || ''))
            return
          }
          if (msg && msg.type === 'export:createdDir' && taskId) {
            exportTaskControlService.recordCreatedDir(taskId, String(msg.dirPath || ''))
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
      const result = await runWorker()
      return await finalizeExportTaskControlResult(taskId, result)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[export-worker] ${errorMessage}`)
      const normalizedSessionIds = Array.isArray(sessionIds) ? sessionIds : []
      const failedSessionErrors: Record<string, string> = {}
      for (const sessionId of normalizedSessionIds) {
        failedSessionErrors[sessionId] = errorMessage
      }
      const result = {
        success: false,
        successCount: 0,
        failCount: normalizedSessionIds.length,
        failedSessionIds: normalizedSessionIds,
        failedSessionErrors,
        error: `导出 Worker 执行失败: ${errorMessage}`
      }
      return await finalizeExportTaskControlResult(taskId, result)
    } finally {
      if (taskId) activeExportTasks.delete(taskId)
      flushProgress()
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
    }
  })

  ipcMain.handle('export:exportSession', async (event, sessionId: string, outputPath: string, options: ExportOptions) => {
    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)
    const imageKeys = cfg.getImageKeysForCurrentWxid()
    const workerPath = join(__dirname, '../exportWorker.js')

    try {
      return await new Promise<any>((resolve) => {
        const worker = new Worker(workerPath, {
          workerData: {
            mode: 'single',
            sessionId,
            outputPath,
            options,
            dbPath: String(cfg.get('dbPath') || '').trim(),
            decryptKey: String(cfg.get('decryptKey') || '').trim(),
            myWxid: String(cfg.getMyWxidCleaned() || '').trim(),
            imageXorKey: imageKeys.xorKey,
            imageAesKey: imageKeys.aesKey,
            resourcesPath: app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources'),
            userDataPath: app.getPath('userData'),
            logEnabled: cfg.get('logEnabled')
          }
        })

        let settled = false
        const finalize = (value: any) => {
          if (settled) return
          settled = true
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const fail = (error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error(`[export-worker-single] ${errorMessage}`)
          finalize({ success: false, error: `导出 Worker 执行失败: ${errorMessage}` })
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:progress') {
            if (!event.sender.isDestroyed()) {
              event.sender.send('export:progress', msg.data)
            }
            return
          }
          if (msg && msg.type === 'export:result') {
            finalize(msg.data)
            return
          }
          if (msg && msg.type === 'export:error') {
            fail(String(msg.error || '导出 Worker 执行失败'))
          }
        })
        worker.on('error', fail)
        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            finalize({ success: false, error: '导出 Worker 未返回结果' })
          } else {
            fail(`导出 Worker 异常退出: ${code}`)
          }
        })
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[export-worker-single] ${errorMessage}`)
      return { success: false, error: `导出 Worker 启动失败: ${errorMessage}` }
    }
  })

  ipcMain.handle('export:exportContacts', async (_, outputDir: string, options: any) => {
    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)
    const workerPath = join(__dirname, '../exportWorker.js')

    try {
      return await new Promise<any>((resolve) => {
        const worker = new Worker(workerPath, {
          workerData: {
            mode: 'contacts',
            outputDir,
            options,
            dbPath: String(cfg.get('dbPath') || '').trim(),
            decryptKey: String(cfg.get('decryptKey') || '').trim(),
            myWxid: String(cfg.getMyWxidCleaned() || '').trim(),
            resourcesPath: app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources'),
            userDataPath: app.getPath('userData'),
            logEnabled: cfg.get('logEnabled')
          }
        })

        let settled = false
        const finalize = (value: any) => {
          if (settled) return
          settled = true
          worker.removeAllListeners()
          void worker.terminate()
          resolve(value)
        }
        const fail = (error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error(`[export-worker-contacts] ${errorMessage}`)
          finalize({ success: false, error: `导出 Worker 执行失败: ${errorMessage}` })
        }

        worker.on('message', (msg: any) => {
          if (msg && msg.type === 'export:result') {
            finalize(msg.data)
            return
          }
          if (msg && msg.type === 'export:error') {
            fail(String(msg.error || '导出 Worker 执行失败'))
          }
        })
        worker.on('error', fail)
        worker.on('exit', (code) => {
          if (settled) return
          if (code === 0) {
            finalize({ success: false, error: '导出 Worker 未返回结果' })
          } else {
            fail(`导出 Worker 异常退出: ${code}`)
          }
        })
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[export-worker-contacts] ${errorMessage}`)
      return { success: false, error: `导出 Worker 启动失败: ${errorMessage}` }
    }
  })
}
