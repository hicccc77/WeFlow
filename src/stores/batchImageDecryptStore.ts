import { create } from 'zustand'
import {
  finishBackgroundTask,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import type { BackgroundTaskSourcePage } from '../types/backgroundTask'

export interface BatchImageDecryptState {
  isBatchDecrypting: boolean
  progress: { current: number; total: number }
  showToast: boolean
  showResultToast: boolean
  result: { success: number; fail: number }
  startTime: number
  sessionName: string
  taskId: string | null

  startDecrypt: (total: number, sessionName: string, sourcePage?: BackgroundTaskSourcePage) => void
  updateProgress: (current: number, total: number) => void
  finishDecrypt: (success: number, fail: number) => void
  setShowToast: (show: boolean) => void
  setShowResultToast: (show: boolean) => void
  reset: () => void
}

const clampProgress = (current: number, total: number): { current: number; total: number } => {
  const normalizedTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  const normalizedCurrentRaw = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0
  const normalizedCurrent = normalizedTotal > 0
    ? Math.min(normalizedCurrentRaw, normalizedTotal)
    : normalizedCurrentRaw
  return { current: normalizedCurrent, total: normalizedTotal }
}

const TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS = 250
const TASK_PROGRESS_UPDATE_MAX_STEPS = 100

const taskProgressUpdateMeta = new Map<string, { lastAt: number; lastBucket: number; step: number }>()

const calcProgressStep = (total: number): number => {
  if (total <= 0) return 1
  return Math.max(1, Math.floor(total / TASK_PROGRESS_UPDATE_MAX_STEPS))
}

export const useBatchImageDecryptStore = create<BatchImageDecryptState>((set, get) => ({
  isBatchDecrypting: false,
  progress: { current: 0, total: 0 },
  showToast: false,
  showResultToast: false,
  result: { success: 0, fail: 0 },
  startTime: 0,
  sessionName: '',
  taskId: null,

  startDecrypt: (total, sessionName, sourcePage = 'chat') => {
    const previousTaskId = get().taskId
    if (previousTaskId) {
      taskProgressUpdateMeta.delete(previousTaskId)
      finishBackgroundTask(previousTaskId, 'canceled', {
        detail: '已被新的批量解密任务替换',
        progressText: '已替换'
      })
    }

    const normalizedProgress = clampProgress(0, total)
    const normalizedSessionName = String(sessionName || '').trim()
    const title = normalizedSessionName
      ? `图片批量解密（${normalizedSessionName}）`
      : '图片批量解密'
    const taskId = registerBackgroundTask({
      sourcePage,
      title,
      detail: `正在解密图片（${normalizedProgress.current}/${normalizedProgress.total}）`,
      progressText: `${normalizedProgress.current} / ${normalizedProgress.total}`,
      cancelable: false
    })
    taskProgressUpdateMeta.set(taskId, {
      lastAt: Date.now(),
      lastBucket: 0,
      step: calcProgressStep(normalizedProgress.total)
    })

    set({
      isBatchDecrypting: true,
      progress: normalizedProgress,
      showToast: true,
      showResultToast: false,
      result: { success: 0, fail: 0 },
      startTime: Date.now(),
      sessionName: normalizedSessionName,
      taskId
    })
  },

  updateProgress: (current, total) => {
    const previousProgress = get().progress
    const normalizedProgress = clampProgress(current, total)
    const taskId = get().taskId
    if (taskId) {
      const now = Date.now()
      const meta = taskProgressUpdateMeta.get(taskId)
      const step = meta?.step || calcProgressStep(normalizedProgress.total)
      const bucket = Math.floor(normalizedProgress.current / step)
      const intervalReached = !meta || (now - meta.lastAt >= TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS)
      const crossedBucket = !meta || bucket !== meta.lastBucket
      const isFinal = normalizedProgress.total > 0 && normalizedProgress.current >= normalizedProgress.total
      if (crossedBucket || intervalReached || isFinal) {
        updateBackgroundTask(taskId, {
          detail: `正在解密图片（${normalizedProgress.current}/${normalizedProgress.total}）`,
          progressText: `${normalizedProgress.current} / ${normalizedProgress.total}`
        })
        taskProgressUpdateMeta.set(taskId, {
          lastAt: now,
          lastBucket: bucket,
          step
        })
      }
    }
    if (
      previousProgress.current !== normalizedProgress.current ||
      previousProgress.total !== normalizedProgress.total
    ) {
      set({
        progress: normalizedProgress
      })
    }
  },

  finishDecrypt: (success, fail) => {
    const taskId = get().taskId
    const normalizedSuccess = Number.isFinite(success) ? Math.max(0, Math.floor(success)) : 0
    const normalizedFail = Number.isFinite(fail) ? Math.max(0, Math.floor(fail)) : 0
    if (taskId) {
      taskProgressUpdateMeta.delete(taskId)
      const status = normalizedSuccess > 0 || normalizedFail === 0 ? 'completed' : 'failed'
      finishBackgroundTask(taskId, status, {
        detail: `图片批量解密完成：成功 ${normalizedSuccess}，失败 ${normalizedFail}`,
        progressText: `成功 ${normalizedSuccess} / 失败 ${normalizedFail}`
      })
    }

    set({
      isBatchDecrypting: false,
      showToast: false,
      showResultToast: true,
      result: { success: normalizedSuccess, fail: normalizedFail },
      startTime: 0,
      taskId: null
    })
  },

  setShowToast: (show) => set({ showToast: show }),
  setShowResultToast: (show) => set({ showResultToast: show }),

  reset: () => {
    const taskId = get().taskId
    if (taskId) {
      taskProgressUpdateMeta.delete(taskId)
      finishBackgroundTask(taskId, 'canceled', {
        detail: '批量解密任务已重置',
        progressText: '已停止'
      })
    }

    set({
      isBatchDecrypting: false,
      progress: { current: 0, total: 0 },
      showToast: false,
      showResultToast: false,
      result: { success: 0, fail: 0 },
      startTime: 0,
      sessionName: '',
      taskId: null
    })
  }
}))
