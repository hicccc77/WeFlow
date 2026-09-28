/**
 * ExportV2 — useBackgroundTasks hook
 *
 * Subscribes to global background tasks (like data-backup, data-processing)
 * to display them in the Export Page if there are any active ones.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { BackgroundTaskRecord } from '../../../types/backgroundTask'
import {
  clearSettledBackgroundTasks,
  requestCancelBackgroundTask,
  requestCancelBackgroundTasks,
  requestPauseBackgroundTask,
  requestResumeBackgroundTask,
  subscribeBackgroundTasks
} from '../../../services/backgroundTaskMonitor'

export interface BackgroundTasksResult {
  allTasks: BackgroundTaskRecord[]
  chatTasks: BackgroundTaskRecord[]
  nonExportTasks: BackgroundTaskRecord[]
  nonExportTasksUpdatedAt: number
  
  pauseTask: (taskId: string) => void
  resumeTask: (taskId: string) => void
  cancelTask: (taskId: string) => void
  cancelChatTasks: () => void
  clearSettledTasks: (predicate?: (task: BackgroundTaskRecord) => boolean) => void
}

export function useBackgroundTasks(): BackgroundTasksResult {
  const [tasks, setTasks] = useState<BackgroundTaskRecord[]>([])

  useEffect(() => {
    // Subscribe to global background tasks
    const unsubscribe = subscribeBackgroundTasks((newTasks) => {
      setTasks(newTasks)
    })
    return () => unsubscribe()
  }, [])

  const chatTasks = useMemo(() => {
    return tasks.filter(task => task.sourcePage === 'chat')
  }, [tasks])

  const nonExportTasks = useMemo(() => {
    // Tasks that are neither from export nor chat
    return tasks.filter(task => task.sourcePage !== 'export' && task.sourcePage !== 'chat')
  }, [tasks])

  const nonExportTasksUpdatedAt = useMemo(() => {
    return nonExportTasks.reduce((latest, task) => Math.max(latest, task.updatedAt || 0), 0)
  }, [nonExportTasks])

  const pauseTask = useCallback((taskId: string) => {
    requestPauseBackgroundTask(taskId)
  }, [])

  const resumeTask = useCallback((taskId: string) => {
    requestResumeBackgroundTask(taskId)
  }, [])

  const cancelTask = useCallback((taskId: string) => {
    requestCancelBackgroundTask(taskId)
  }, [])

  const cancelChatTasks = useCallback(() => {
    requestCancelBackgroundTasks(task => task.sourcePage === 'chat' && task.status !== 'completed' && task.status !== 'canceled' && task.status !== 'failed')
  }, [])

  const clearSettledTasks = useCallback((predicate?: (task: BackgroundTaskRecord) => boolean) => {
    clearSettledBackgroundTasks(predicate)
  }, [])

  return {
    allTasks: tasks,
    chatTasks,
    nonExportTasks,
    nonExportTasksUpdatedAt,
    
    pauseTask,
    resumeTask,
    cancelTask,
    cancelChatTasks,
    clearSettledTasks
  }
}
