import { create } from 'zustand'
import {
  finishBackgroundTask,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import type { BackgroundTaskSourcePage, BackgroundTaskStatus } from '../types/backgroundTask'

interface BatchDecryptTaskControls {
  cancelable?: boolean
  resumable?: boolean
  onCancel?: () => void | Promise<void>
  onPause?: () => void | Promise<void>
  onResume?: () => void | Promise<void>
}

interface BatchDecryptFinishOptions {
  status?: Extract<BackgroundTaskStatus, 'completed' | 'failed' | 'canceled'>
  detail?: string
  progressText?: string
}

export interface BatchImageDecryptState {
  isBatchDecrypting: boolean
  progress: { current: number; total: number }
  showToast: boolean
  showResultToast: boolean
  result: { success: number; fail: number }
  startTime: number
  sessionName: string
  taskId: string | null

  startDecrypt: (
    total: number,
    sessionName: string,
    sourcePage?: BackgroundTaskSourcePage,
    controls?: BatchDecryptTaskControls
  ) => void
  updateProgress: (current: number, total: number) => void
  setTaskStatus: (detail: string, progressText?: string, status?: BackgroundTaskStatus) => void
  finishDecrypt: (success: number, fail: number, options?: BatchDecryptFinishOptions) => void
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

  startDecrypt: (total, sessionName, sourcePage = 'chat', controls) => {
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
      cancelable: controls?.cancelable !== false,
      resumable: controls?.resumable === true,
      onCancel: controls?.onCancel,
      onPause: controls?.onPause,
      onResume: controls?.onResume
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
    let shouldCommitUi = true
    if (taskId) {
      const now = Date.now()
      const meta = taskProgressUpdateMeta.get(taskId)
      const step = meta?.step || calcProgressStep(normalizedProgress.total)
      const bucket = Math.floor(normalizedProgress.current / step)
      const intervalReached = !meta || (now - meta.lastAt >= TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS)
      const crossedBucket = !meta || bucket !== meta.lastBucket
      const isFinal = normalizedProgress.total > 0 && normalizedProgress.current >= normalizedProgress.total
      const shouldPublish = crossedBucket || intervalReached || isFinal
      shouldCommitUi = shouldPublish
      if (shouldPublish) {
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
    if (shouldCommitUi && (
      previousProgress.current !== normalizedProgress.current ||
      previousProgress.total !== normalizedProgress.total
    )) {
      set({
        progress: normalizedProgress
      })
    }
  },

  setTaskStatus: (detail, progressText, status) => {
    const taskId = get().taskId
    if (!taskId) return
    const normalizedDetail = String(detail || '').trim()
    if (!normalizedDetail) return
    updateBackgroundTask(taskId, {
      detail: normalizedDetail,
      progressText,
      status
    })
  },

  finishDecrypt: (success, fail, options) => {
    const taskId = get().taskId
    const normalizedSuccess = Number.isFinite(success) ? Math.max(0, Math.floor(success)) : 0
    const normalizedFail = Number.isFinite(fail) ? Math.max(0, Math.floor(fail)) : 0
    if (taskId) {
      taskProgressUpdateMeta.delete(taskId)
      const status = options?.status || (normalizedSuccess > 0 || normalizedFail === 0 ? 'completed' : 'failed')
      finishBackgroundTask(taskId, status, {
        detail: options?.detail || `图片批量解密完成：成功 ${normalizedSuccess}，失败 ${normalizedFail}`,
        progressText: options?.progressText || `成功 ${normalizedSuccess} / 失败 ${normalizedFail}`
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
