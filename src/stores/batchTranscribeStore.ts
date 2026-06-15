import { create } from 'zustand'
import {
  finishBackgroundTask,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import type { BackgroundTaskSourcePage, BackgroundTaskStatus } from '../types/backgroundTask'

export type BatchVoiceTaskType = 'transcribe' | 'decrypt'

interface BatchVoiceTaskControls {
  cancelable?: boolean
  resumable?: boolean
  onCancel?: () => void | Promise<void>
  onPause?: () => void | Promise<void>
  onResume?: () => void | Promise<void>
}

interface BatchVoiceTaskFinishOptions {
  status?: Extract<BackgroundTaskStatus, 'completed' | 'failed' | 'canceled'>
  detail?: string
  progressText?: string
}

export interface BatchTranscribeState {
  /** 是否正在批量转写 */
  isBatchTranscribing: boolean
  /** 当前批量任务类型 */
  taskType: BatchVoiceTaskType
  /** 转写进度 */
  progress: { current: number; total: number }
  /** 是否显示进度浮窗 */
  showToast: boolean
  /** 是否显示结果弹窗 */
  showResult: boolean
  /** 转写结果 */
  result: { success: number; fail: number }
  /** 当前转写的会话名 */
  startTime: number
  sessionName: string
  taskId: string | null

  // Actions
  startTranscribe: (
    total: number,
    sessionName: string,
    taskType?: BatchVoiceTaskType,
    sourcePage?: BackgroundTaskSourcePage,
    controls?: BatchVoiceTaskControls
  ) => void
  updateProgress: (current: number, total: number) => void
  setTaskStatus: (detail: string, progressText?: string, status?: BackgroundTaskStatus) => void
  finishTranscribe: (success: number, fail: number, options?: BatchVoiceTaskFinishOptions) => void
  setShowToast: (show: boolean) => void
  setShowResult: (show: boolean) => void
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

export const useBatchTranscribeStore = create<BatchTranscribeState>((set, get) => ({
  isBatchTranscribing: false,
  taskType: 'transcribe',
  progress: { current: 0, total: 0 },
  showToast: false,
  showResult: false,
  result: { success: 0, fail: 0 },
  sessionName: '',
  startTime: 0,
  taskId: null,

  startTranscribe: (total, sessionName, taskType = 'transcribe', sourcePage = 'chat', controls) => {
    const previousTaskId = get().taskId
    if (previousTaskId) {
      taskProgressUpdateMeta.delete(previousTaskId)
      finishBackgroundTask(previousTaskId, 'canceled', {
        detail: '已被新的语音批量任务替换',
        progressText: '已替换'
      })
    }

    const normalizedProgress = clampProgress(0, total)
    const normalizedSessionName = String(sessionName || '').trim()
    const taskLabel = taskType === 'decrypt' ? '语音批量解密' : '语音批量转写'
    const title = normalizedSessionName
      ? `${taskLabel}（${normalizedSessionName}）`
      : taskLabel
    const taskId = registerBackgroundTask({
      sourcePage,
      title,
      detail: `正在准备${taskType === 'decrypt' ? '语音解密' : '语音转写'}任务...`,
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
      isBatchTranscribing: true,
      taskType,
      showToast: false,
      progress: normalizedProgress,
      showResult: false,
      result: { success: 0, fail: 0 },
      sessionName: normalizedSessionName,
      startTime: Date.now(),
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
        const taskVerb = get().taskType === 'decrypt' ? '解密语音' : '转写语音'
        updateBackgroundTask(taskId, {
          detail: `正在${taskVerb}（${normalizedProgress.current}/${normalizedProgress.total}）`,
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

  finishTranscribe: (success, fail, options) => {
    const taskId = get().taskId
    const normalizedSuccess = Number.isFinite(success) ? Math.max(0, Math.floor(success)) : 0
    const normalizedFail = Number.isFinite(fail) ? Math.max(0, Math.floor(fail)) : 0
    const taskType = get().taskType
    if (taskId) {
      taskProgressUpdateMeta.delete(taskId)
      const status = options?.status || (normalizedSuccess > 0 || normalizedFail === 0 ? 'completed' : 'failed')
      const taskLabel = taskType === 'decrypt' ? '语音批量解密' : '语音批量转写'
      finishBackgroundTask(taskId, status, {
        detail: options?.detail || `${taskLabel}完成：成功 ${normalizedSuccess}，失败 ${normalizedFail}`,
        progressText: options?.progressText || `成功 ${normalizedSuccess} / 失败 ${normalizedFail}`
      })
    }

    set({
      isBatchTranscribing: false,
      showToast: false,
      showResult: false,
      result: { success: normalizedSuccess, fail: normalizedFail },
      startTime: 0,
      taskId: null
    })
  },

  setShowToast: (show) => set({ showToast: show }),
  setShowResult: (show) => set({ showResult: show }),

  reset: () => {
    const taskId = get().taskId
    if (taskId) {
      taskProgressUpdateMeta.delete(taskId)
      finishBackgroundTask(taskId, 'canceled', {
        detail: '语音批量任务已重置',
        progressText: '已停止'
      })
    }
    set({
      isBatchTranscribing: false,
      taskType: 'transcribe',
      progress: { current: 0, total: 0 },
      showToast: false,
      showResult: false,
      result: { success: 0, fail: 0 },
      sessionName: '',
      startTime: 0,
      taskId: null
    })
  }
}))
