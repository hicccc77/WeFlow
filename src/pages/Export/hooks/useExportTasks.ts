/**
 * ExportV2 — useExportTasks hook
 *
 * Manages the queue and state of manual export tasks.
 * Includes starting tasks via electronAPI, tracking progress, and aborting.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { ExportTask, ExportTaskPayload, TaskStatus } from '../types'
import { createEmptyProgress } from '../constants'
import { useExportTaskStore } from '../../../stores/exportTaskStore'
import { buildProgressPayloadSignature } from '../utils/progress'
import { resolvePerfStageByPhase, applyProgressToTaskPerformance } from '../utils/performance'
import { emitExportSessionStatus, onExportSessionStatusRequest } from '../../../services/exportBridge'
import { useAutomationStore } from './useAutomation'
import type { ExportProgress } from '../types'
import type { ExportAutomationTask } from '../../../types/exportAutomation'

export interface ExportTasksResult {
  tasks: ExportTask[]
  activeTasks: ExportTask[]
  completedTasks: ExportTask[]
  startTask: (payload: ExportTaskPayload) => void
  cancelTask: (taskId: string) => void
  clearCompletedTasks: () => void
}

const generateTaskId = () => `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`

const updateAutomationRunState = (
  automationTaskId: string | undefined,
  updater: (prev: ExportAutomationTask) => ExportAutomationTask
) => {
  if (!automationTaskId) return
  void useAutomationStore.getState().updateTask(automationTaskId, updater)
}

export function useExportTasks(): ExportTasksResult {
  const [tasks, setTasks] = useState<ExportTask[]>([])
  
  const tasksRef = useRef<ExportTask[]>([])
  tasksRef.current = tasks

  const { setSessionStatus } = useExportTaskStore()

  const publishSessionStatus = useCallback(() => {
    const activeTasks = tasksRef.current.filter(t => t.status === 'running' || t.status === 'cancel_requested')
    const inProgressSessionIds = new Set<string>()
    activeTasks.forEach(task => {
      task.payload.sessionIds.forEach(id => inProgressSessionIds.add(id))
    })

    const payload = {
      activeTaskCount: activeTasks.length,
      inProgressSessionIds: Array.from(inProgressSessionIds)
    }

    setSessionStatus(payload)
    emitExportSessionStatus(payload)
  }, [setSessionStatus])

  // Track the ongoing tasks to update the global zustand store badge
  useEffect(() => {
    publishSessionStatus()
  }, [tasks, publishSessionStatus])

  useEffect(() => {
    const unsubscribe = onExportSessionStatusRequest(publishSessionStatus)
    publishSessionStatus()
    return unsubscribe
  }, [publishSessionStatus])

  const updateTask = useCallback((taskId: string, updater: (prev: ExportTask) => ExportTask) => {
    setTasks(prev => prev.map(t => t.id === taskId ? updater(t) : t))
  }, [])

  const startTask = useCallback((payload: ExportTaskPayload) => {
    const taskId = generateTaskId()
    const title = payload.sessionIds.length > 1
        ? `批量导出 ${payload.sessionIds.length} 个会话`
        : `导出 ${payload.sessionNames[0] || '会话'}`

    const newTask: ExportTask = {
      id: taskId,
      title,
      status: 'running',
      createdAt: Date.now(),
      startedAt: Date.now(),
      payload,
      progress: createEmptyProgress()
    }

    setTasks(prev => [newTask, ...prev])

    if (payload.source === 'automation') {
      updateAutomationRunState(payload.automationTaskId, (prev) => ({
        ...prev,
        updatedAt: Date.now(),
        runState: {
          ...(prev.runState || {}),
          lastRunStatus: 'running',
          lastStartedAt: Date.now(),
          lastSkipReason: undefined,
          lastError: undefined
        }
      }))
    }

    // Kick off via electron API
    const run = async () => {
      let progressUnsubscribe: (() => void) | null = null
      let lastProgressSig = ''
      
      try {
        // Subscribe to progress
        progressUnsubscribe = window.electronAPI.export.onProgress((progressPayload: ExportProgress) => {
          if ((progressPayload as any).taskId && (progressPayload as any).taskId !== taskId) return

          const sig = buildProgressPayloadSignature(progressPayload)
          if (sig === lastProgressSig) return
          lastProgressSig = sig

          updateTask(taskId, (task) => {
            if (task.status !== 'running') return task

            const nextProgress = { ...task.progress, ...progressPayload }
            // The original expected performance from task or undefined. 
            // The signature is applyProgressToTaskPerformance(task: ExportTask, payload: ExportProgress, now: number)
            const nextPerf = applyProgressToTaskPerformance(task, progressPayload, Date.now())

            return {
              ...task,
              progress: nextProgress,
              performance: nextPerf
            }
          })
        })

        const frontendOptions = payload.options as any
        const electronOptions = { ...frontendOptions }
        if (frontendOptions?.useAllTime) {
          electronOptions.dateRange = null
        } else if (frontendOptions?.dateRange) {
          electronOptions.dateRange = {
            start: frontendOptions.dateRange.start.getTime(),
            end: frontendOptions.dateRange.end.getTime()
          }
        }

        const result = await window.electronAPI.export.exportSessions(
          payload.sessionIds,
          payload.outputDir,
          electronOptions,
          { taskId }
        )

        updateTask(taskId, (task) => {
          const stopped = result?.stopped === true
          return {
            ...task,
            status: stopped ? 'canceled' : (result?.success ? 'success' : 'error'),
            finishedAt: Date.now(),
            error: stopped ? undefined : (result?.error || undefined),
            sessionOutputPaths: result?.sessionOutputPaths
          }
        })

        if (payload.source === 'automation') {
          const finishedAt = Date.now()
          updateAutomationRunState(payload.automationTaskId, (prev) => {
            const previousSuccessCount = Math.max(0, Math.floor(Number(prev.runState?.successCount || 0)))
            const stopped = result?.stopped === true
            const completedSuccessfully = result?.success === true && !stopped
            return {
              ...prev,
              updatedAt: finishedAt,
              runState: {
                ...(prev.runState || {}),
                lastRunStatus: completedSuccessfully ? 'success' : 'error',
                lastFinishedAt: finishedAt,
                lastSuccessAt: completedSuccessfully ? finishedAt : prev.runState?.lastSuccessAt,
                lastError: completedSuccessfully ? undefined : (stopped ? '用户已取消' : (result?.error || '导出失败')),
                successCount: completedSuccessfully ? previousSuccessCount + 1 : previousSuccessCount
              }
            }
          })
        }

      } catch (err: any) {
        console.error('[useExportTasks] Task failed:', err)
        const errorMessage = err.message || '未知错误'
        updateTask(taskId, (task) => ({
          ...task,
          status: 'error',
          finishedAt: Date.now(),
          error: errorMessage
        }))
        if (payload.source === 'automation') {
          const finishedAt = Date.now()
          updateAutomationRunState(payload.automationTaskId, (prev) => ({
            ...prev,
            updatedAt: finishedAt,
            runState: {
              ...(prev.runState || {}),
              lastRunStatus: 'error',
              lastFinishedAt: finishedAt,
              lastError: errorMessage
            }
          }))
        }
      } finally {
        if (progressUnsubscribe) {
          progressUnsubscribe()
        }
      }
    }

    void run()
  }, [updateTask])

  const cancelTask = useCallback((taskId: string) => {
    updateTask(taskId, (task) => {
      if (task.status === 'running') {
        void window.electronAPI.export.cancelTask(taskId).then((result) => {
          if (result?.success !== false) return
          updateTask(taskId, (current) => ({
            ...current,
            status: 'error',
            finishedAt: Date.now(),
            error: result?.error || '取消导出失败'
          }))
        }).catch((error) => {
          updateTask(taskId, (current) => ({
            ...current,
            status: 'error',
            finishedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error)
          }))
        })
        return { ...task, status: 'cancel_requested' }
      }
      return task
    })
  }, [updateTask])

  const clearCompletedTasks = useCallback(() => {
    setTasks(prev => prev.filter(t => t.status === 'running' || t.status === 'cancel_requested'))
  }, [])

  const activeTasks = tasks.filter(t => t.status === 'running' || t.status === 'cancel_requested')
  const completedTasks = tasks.filter(t => t.status === 'success' || t.status === 'error' || t.status === 'canceled')

  return {
    tasks,
    activeTasks,
    completedTasks,
    startTask,
    cancelTask,
    clearCompletedTasks
  }
}
