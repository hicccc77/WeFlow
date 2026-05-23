import { app, BrowserWindow, ipcMain } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { ConfigService } from '../services/config'
import { annualReportService } from '../services/annualReportService'
import {
  AnnualReportYearsProgressPayload,
  buildAnnualReportYearsCacheKey,
  broadcastAnnualReportYearsProgress,
  getAnnualReportYearsLoadTasks,
  getAnnualReportYearsTaskByCacheKey,
  getAnnualReportYearsSnapshot,
  isYearsLoadCanceled,
  normalizeAnnualReportYearsSnapshot,
  persistAnnualReportYearsSnapshot
} from './annualReportYearsRuntime'
import { MainIpcContext } from './mainIpcContext'

export function registerReportHandlers(ctx: MainIpcContext) {
  ipcMain.handle('annualReport:getAvailableYears', async () => {
    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)
    return annualReportService.getAvailableYears({
      dbPath: cfg.get('dbPath'),
      decryptKey: cfg.get('decryptKey'),
      wxid: cfg.getMyWxidCleaned()
    })
  })

  ipcMain.handle('annualReport:startAvailableYearsLoad', async (event) => {
    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.get('myWxid')
    const cacheKey = buildAnnualReportYearsCacheKey(dbPath, wxid)

    const annualReportYearsTaskByCacheKey = getAnnualReportYearsTaskByCacheKey()
    const annualReportYearsLoadTasks = getAnnualReportYearsLoadTasks()

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

    void event

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
    const task = getAnnualReportYearsLoadTasks().get(key)
    if (!task) return { success: true }
    task.canceled = true
    getAnnualReportYearsLoadTasks().set(key, task)
    return { success: true }
  })

  ipcMain.handle('annualReport:generateReport', async (_, year: number) => {
    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.getMyWxidCleaned()
    const logEnabled = cfg.get('logEnabled')

    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const userDataPath = app.getPath('userData')

    const workerPath = join(__dirname, '../annualReportWorker.js')

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
    const cfg = ctx.getConfigService() || new ConfigService()
    ctx.setConfigService(cfg)

    const dbPath = cfg.get('dbPath')
    const decryptKey = cfg.get('decryptKey')
    const wxid = cfg.getMyWxidCleaned()
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

    const workerPath = join(__dirname, '../dualReportWorker.js')

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

  ipcMain.handle('annualReport:captureCurrentWindow', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) {
        return { success: false, error: '窗口不可用' }
      }

      const image = await win.webContents.capturePage()
      return {
        success: true,
        dataUrl: image.toDataURL(),
        size: image.getSize()
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
