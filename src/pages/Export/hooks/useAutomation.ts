import { create } from 'zustand'
import { useEffect, useRef, useCallback } from 'react'
import * as configService from '../../../services/config'
import type { ExportAutomationTask } from '../../../types/exportAutomation'
import type { ExportTaskPayload } from '../types'
import {
  resolveAutomationDueScheduleKey,
  resolveAutomationDateRangeSelection,
} from '../utils/automation'

// ─── Core Logic Helpers ─────────────────────────────────────

export const resolveAutomationScopeKey = async (): Promise<string> => {
  const [myAccountId, dbPath] = await Promise.all([
    configService.getMyAccountId(),
    configService.getDbPath()
  ])
  return dbPath || myAccountId ? `${dbPath || ''}::${myAccountId || ''}` : 'default'
}

const resolveAutomationHasNewMessages = async (task: ExportAutomationTask): Promise<{ shouldRun: boolean; reason?: string }> => {
  const lastSuccessAt = Number(task.runState?.lastSuccessAt || 0)
  if (!lastSuccessAt) return { shouldRun: true }
  
  const stats = await window.electronAPI.chat.getExportSessionStats(task.sessionIds, {
    includeRelations: false,
    allowStaleCache: true
  })
  if (!stats.success || !stats.data) {
    return { shouldRun: false, reason: stats.error || '会话统计失败，已跳过' }
  }
  
  let latestTimestamp = 0
  for (const sessionId of task.sessionIds) {
    const raw = Number(stats.data?.[sessionId]?.lastTimestamp || 0)
    if (Number.isFinite(raw) && raw > latestTimestamp) {
      latestTimestamp = Math.max(0, Math.floor(raw))
    }
  }
  if (latestTimestamp <= 0) {
    return { shouldRun: false, reason: '未检测到可用会话时间戳，已跳过' }
  }
  
  const lastSuccessSeconds = Math.floor(lastSuccessAt / 1000)
  if (latestTimestamp > lastSuccessSeconds) {
    return { shouldRun: true }
  } else {
    return { shouldRun: false, reason: '无新消息，本次触发已跳过' }
  }
}

const buildAutomationExportOptions = (task: ExportAutomationTask): any => {
  const dateRangeSelection = resolveAutomationDateRangeSelection(task.template.dateRangeConfig)
  return {
    ...task.template.optionTemplate,
    exportPathStyle: task.template.optionTemplate?.exportPathStyle || 'auto',
    useAllTime: dateRangeSelection.useAllTime,
    dateRange: dateRangeSelection.useAllTime ? null : dateRangeSelection.dateRange
  }
}

const resolveAutomationOutputDir = async (task: ExportAutomationTask): Promise<string> => {
  const taskOutputDir = String(task.outputDir || '').trim()
  if (taskOutputDir) return taskOutputDir

  const configuredOutputDir = String(await configService.getExportPath() || '').trim()
  if (configuredOutputDir) return configuredOutputDir

  try {
    return String(await window.electronAPI.app.getDownloadsPath() || '').trim()
  } catch {
    return ''
  }
}

// ─── Zustand Store ──────────────────────────────────────────

interface AutomationState {
  isReady: boolean
  tasks: ExportAutomationTask[]
  
  loadTasks: () => Promise<void>
  addTask: (task: ExportAutomationTask) => Promise<void>
  updateTask: (taskId: string, updater: (prev: ExportAutomationTask) => ExportAutomationTask) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  isReady: false,
  tasks: [],

  loadTasks: async () => {
    try {
      const scopeKey = await resolveAutomationScopeKey()
      const item = await configService.getExportAutomationTasks(scopeKey)
      set({ tasks: item?.tasks || [], isReady: true })
    } catch (error) {
      console.error('加载自动化导出任务失败', error)
      set({ isReady: true })
    }
  },

  addTask: async (task) => {
    const { tasks } = get()
    const nextTasks = [task, ...tasks]
    set({ tasks: nextTasks })
    const scopeKey = await resolveAutomationScopeKey()
    await configService.setExportAutomationTasks(scopeKey, nextTasks)
  },

  updateTask: async (taskId, updater) => {
    const { tasks } = get()
    const nextTasks = tasks.map(t => t.id === taskId ? updater(t) : t)
    set({ tasks: nextTasks })
    const scopeKey = await resolveAutomationScopeKey()
    await configService.setExportAutomationTasks(scopeKey, nextTasks)
  },

  deleteTask: async (taskId) => {
    const { tasks } = get()
    const nextTasks = tasks.filter(t => t.id !== taskId)
    set({ tasks: nextTasks })
    const scopeKey = await resolveAutomationScopeKey()
    await configService.setExportAutomationTasks(scopeKey, nextTasks)
  }
}))

// ─── Runner Hook ────────────────────────────────────────────

export function useAutomationRunner(startTask: (payload: ExportTaskPayload) => void) {
  const { isReady, tasks, loadTasks, updateTask } = useAutomationStore()
  const isRunningRef = useRef(false)
  const startTaskRef = useRef(startTask)
  const tasksRef = useRef(tasks)

  // Keep refs in sync
  useEffect(() => { startTaskRef.current = startTask }, [startTask])
  useEffect(() => { tasksRef.current = tasks }, [tasks])

  // Initialize store
  useEffect(() => {
    if (!isReady) {
      void loadTasks()
    }
  }, [isReady, loadTasks])

  // Stable evaluate function that reads from refs + Zustand.getState()
  const evaluate = useCallback(async () => {
    const store = useAutomationStore.getState()
    if (!store.isReady) return
    if (isRunningRef.current) return
    isRunningRef.current = true

    const patchTask = (taskId: string, updater: (prev: ExportAutomationTask) => ExportAutomationTask) => {
      void store.updateTask(taskId, updater)
    }

    const markSkipped = (taskId: string, reason: string, scheduleKey?: string) => {
      patchTask(taskId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        runState: {
          ...(current.runState || {}),
          lastRunStatus: 'skipped',
          lastSkipAt: Date.now(),
          lastSkipReason: reason,
          lastScheduleKey: scheduleKey || current.runState?.lastScheduleKey
        }
      }))
    }

    try {
      const now = new Date()
      const currentTasks = useAutomationStore.getState().tasks
      const enabledTasks = currentTasks.filter((task) => task.enabled)
      
      for (const task of enabledTasks) {
        const successCount = Math.max(0, Math.floor(Number(task.runState?.successCount || 0)))
        const maxRuns = Math.max(0, Math.floor(Number(task.stopCondition?.maxRuns || 0)))
        
        // Check max runs
        if (maxRuns > 0 && successCount >= maxRuns) {
          patchTask(task.id, (current) => ({
            ...current,
            enabled: false,
            updatedAt: Date.now(),
            runState: {
              ...(current.runState || {}),
              lastRunStatus: 'skipped',
              lastSkipAt: Date.now(),
              lastSkipReason: `已达到最大执行次数（${maxRuns} 次），任务已自动停用`,
              successCount
            }
          }))
          continue
        }

        // Check end date
        const endAt = Number(task.stopCondition?.endAt || 0)
        if (endAt > 0 && now.getTime() > endAt) {
          patchTask(task.id, (current) => ({
            ...current,
            enabled: false,
            updatedAt: Date.now(),
            runState: {
              ...(current.runState || {}),
              lastRunStatus: 'skipped',
              lastSkipAt: Date.now(),
              lastSkipReason: '已超过终止时间，任务已自动停用'
            }
          }))
          continue
        }

        const scheduleKey = resolveAutomationDueScheduleKey(task, now)
        if (!scheduleKey) continue
        if (task.runState?.lastScheduleKey === scheduleKey) continue

        // Check conditions
        if (task.condition?.type === 'new-message-since-last-success') {
          const checkResult = await resolveAutomationHasNewMessages(task)
          if (!checkResult.shouldRun) {
            markSkipped(task.id, checkResult.reason || '无新消息，本次触发已跳过', scheduleKey)
            continue
          }
        }

        // Enqueue
        const outputDir = await resolveAutomationOutputDir(task)
        if (!outputDir) {
          markSkipped(task.id, '导出目录未设置', scheduleKey)
          continue
        }

        const exportOptions = buildAutomationExportOptions(task)

        patchTask(task.id, (prev) => ({
          ...prev,
          updatedAt: Date.now(),
          runState: {
            ...(prev.runState || {}),
            lastRunStatus: 'queued',
            lastTriggeredAt: Date.now(),
            lastSkipReason: undefined,
            lastError: undefined,
            lastScheduleKey: scheduleKey
          }
        }))

        startTaskRef.current({
          sessionIds: task.sessionIds,
          sessionNames: task.sessionNames,
          outputDir,
          options: exportOptions,
          scope: task.template.scope,
          source: 'automation',
          automationTaskId: task.id,
          contentType: task.template.contentType
        })
      }
    } catch (error) {
      console.error('Automation Schedule Evaluation Failed', error)
    } finally {
      isRunningRef.current = false
    }
  }, []) // No reactive deps — reads from refs/getState() directly

  // Stable 30-second timer that never resets
  useEffect(() => {
    if (!isReady) return

    let cancelled = false
    const run = () => {
      if (cancelled) return
      void evaluate()
    }

    // Run once immediately
    run()

    const timer = setInterval(run, 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isReady, evaluate])

  // Manual trigger helper
  const enqueueAutomationTask = useCallback(async (
    task: ExportAutomationTask,
    _options?: { scheduleKey?: string }
  ): Promise<{ queued: boolean; reason?: string }> => {
    const outputDir = await resolveAutomationOutputDir(task)
    if (!outputDir) {
      return { queued: false, reason: '导出目录未设置' }
    }

    const exportOptions = buildAutomationExportOptions(task)

    await updateTask(task.id, (prev) => ({
      ...prev,
      updatedAt: Date.now(),
      runState: {
        ...(prev.runState || {}),
        lastRunStatus: 'queued',
        lastTriggeredAt: Date.now(),
        lastSkipReason: undefined,
        lastError: undefined,
        lastScheduleKey: _options?.scheduleKey || prev.runState?.lastScheduleKey
      }
    }))

    startTaskRef.current({
      sessionIds: task.sessionIds,
      sessionNames: task.sessionNames,
      outputDir,
      options: exportOptions,
      scope: task.template.scope,
      source: 'automation',
      automationTaskId: task.id,
      contentType: task.template.contentType
    })

    return { queued: true }
  }, [updateTask])

  return { enqueueAutomationTask }
}
