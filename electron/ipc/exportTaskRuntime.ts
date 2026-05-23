import { Worker } from 'worker_threads'
import { exportTaskControlService } from '../services/exportTaskControlService'

export const activeExportWorkers = new Map<string, Worker>()
export const activeExportTasks = new Set<string>()

export const normalizeExportTaskId = (taskId: unknown): string => String(taskId || '').trim()

export const postExportWorkerControl = (taskId: string, action: 'pause' | 'resume' | 'cancel') => {
  const worker = activeExportWorkers.get(taskId)
  if (!worker) return
  try {
    worker.postMessage({ type: `export:${action}` })
  } catch (error) {
    console.warn(`[export-task-control] failed to post ${action} to worker:`, error)
  }
}

export const finalizeExportTaskControlResult = async (taskId: string, result: any) => {
  if (!taskId) return result
  if (result?.stopped) {
    const cleanup = await exportTaskControlService.cleanupTask(taskId)
    if (!cleanup.success) {
      return {
        ...result,
        success: false,
        error: `导出已停止，但清理已导出文件失败：${cleanup.error || '未知错误'}`
      }
    }
    return {
      ...result,
      cleanup
    }
  }
  if (!result?.paused) {
    exportTaskControlService.releaseTask(taskId)
  }
  return result
}
