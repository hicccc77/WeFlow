/**
 * ExportV2 — Performance tracking utilities
 * Pure functions for task performance measurement (per-session timing, stage breakdown).
 */

import type { ExportTask, TaskPerformance, TaskSessionPerformance, TaskPerfStage, ExportProgress } from '../types'
import { TASK_PERFORMANCE_UPDATE_MIN_INTERVAL_MS } from '../constants'
import { isTextBatchTask } from './progress'

// ─── Stage resolution ────────────────────────────────────────

export const resolvePerfStageByPhase = (phase?: ExportProgress['phase']): TaskPerfStage => {
  if (phase === 'preparing') return 'collect'
  if (phase === 'writing') return 'write'
  if (phase === 'exporting' || phase === 'exporting-media' || phase === 'exporting-voice') return 'build'
  return 'other'
}

// ─── Performance object factories ────────────────────────────

export const createEmptyTaskPerformance = (): TaskPerformance => ({
  stages: { collect: 0, build: 0, write: 0, other: 0 },
  sessions: {}
})

export const cloneTaskPerformance = (performance?: TaskPerformance): TaskPerformance => ({
  stages: {
    collect: performance?.stages.collect || 0,
    build: performance?.stages.build || 0,
    write: performance?.stages.write || 0,
    other: performance?.stages.other || 0
  },
  sessions: { ...(performance?.sessions || {}) }
})

// ─── Session name resolution ─────────────────────────────────

export const resolveTaskSessionName = (task: ExportTask, sessionId: string, fallback?: string): string => {
  const idx = task.payload.sessionIds.indexOf(sessionId)
  if (idx >= 0) {
    return task.payload.sessionNames[idx] || fallback || sessionId
  }
  return fallback || sessionId
}

// ─── Apply progress to performance ──────────────────────────

export const applyProgressToTaskPerformance = (
  task: ExportTask,
  payload: ExportProgress,
  now: number
): TaskPerformance | undefined => {
  if (!isTextBatchTask(task)) return task.performance
  const sessionId = String(payload.currentSessionId || '').trim()
  if (!sessionId) return task.performance || createEmptyTaskPerformance()

  const currentPerformance = task.performance
  const currentSession = currentPerformance?.sessions?.[sessionId]
  if (
    payload.phase !== 'complete' &&
    currentSession &&
    currentSession.lastPhase === payload.phase &&
    typeof currentSession.lastPhaseStartedAt === 'number' &&
    now - currentSession.lastPhaseStartedAt < TASK_PERFORMANCE_UPDATE_MIN_INTERVAL_MS
  ) {
    return currentPerformance
  }

  const performance = cloneTaskPerformance(task.performance)
  const sessionName = resolveTaskSessionName(task, sessionId, payload.currentSession || sessionId)
  const existing = performance.sessions[sessionId]
  const session: TaskSessionPerformance = existing
    ? { ...existing, sessionName: existing.sessionName || sessionName }
    : { sessionId, sessionName, startedAt: now, elapsedMs: 0 }

  if (!session.finishedAt && session.lastPhase && typeof session.lastPhaseStartedAt === 'number') {
    const delta = Math.max(0, now - session.lastPhaseStartedAt)
    performance.stages[resolvePerfStageByPhase(session.lastPhase)] += delta
  }

  session.elapsedMs = Math.max(session.elapsedMs, now - session.startedAt)

  if (payload.phase === 'complete') {
    session.finishedAt = now
    session.lastPhase = undefined
    session.lastPhaseStartedAt = undefined
  } else {
    session.lastPhase = payload.phase
    session.lastPhaseStartedAt = now
  }

  performance.sessions[sessionId] = session
  return performance
}

// ─── Finalize performance on task completion ─────────────────

export const finalizeTaskPerformance = (task: ExportTask, now: number): TaskPerformance | undefined => {
  if (!isTextBatchTask(task) || !task.performance) return task.performance
  const performance = cloneTaskPerformance(task.performance)
  const nextSessions: Record<string, TaskSessionPerformance> = {}
  for (const [sessionId, sourceSession] of Object.entries(performance.sessions)) {
    const session: TaskSessionPerformance = { ...sourceSession }
    if (session.finishedAt) continue
    if (session.lastPhase && typeof session.lastPhaseStartedAt === 'number') {
      const delta = Math.max(0, now - session.lastPhaseStartedAt)
      performance.stages[resolvePerfStageByPhase(session.lastPhase)] += delta
    }
    session.elapsedMs = Math.max(session.elapsedMs, now - session.startedAt)
    session.finishedAt = now
    session.lastPhase = undefined
    session.lastPhaseStartedAt = undefined
    nextSessions[sessionId] = session
  }
  for (const [sessionId, sourceSession] of Object.entries(performance.sessions)) {
    if (nextSessions[sessionId]) continue
    nextSessions[sessionId] = { ...sourceSession }
  }
  performance.sessions = nextSessions
  return performance
}

// ─── Stage totals (live, accounts for in-progress sessions) ──

export const getTaskPerformanceStageTotals = (
  performance: TaskPerformance | undefined,
  now: number
): Record<TaskPerfStage, number> => {
  const totals: Record<TaskPerfStage, number> = {
    collect: performance?.stages.collect || 0,
    build: performance?.stages.build || 0,
    write: performance?.stages.write || 0,
    other: performance?.stages.other || 0
  }
  if (!performance) return totals
  for (const session of Object.values(performance.sessions)) {
    if (session.finishedAt) continue
    if (!session.lastPhase || typeof session.lastPhaseStartedAt !== 'number') continue
    const delta = Math.max(0, now - session.lastPhaseStartedAt)
    totals[resolvePerfStageByPhase(session.lastPhase)] += delta
  }
  return totals
}

// ─── Top N slowest sessions ──────────────────────────────────

export const getTaskPerformanceTopSessions = (
  performance: TaskPerformance | undefined,
  now: number,
  limit = 5
): Array<TaskSessionPerformance & { liveElapsedMs: number }> => {
  if (!performance) return []
  return Object.values(performance.sessions)
    .map((session) => {
      const liveElapsedMs = session.finishedAt
        ? session.elapsedMs
        : Math.max(session.elapsedMs, now - session.startedAt)
      return { ...session, liveElapsedMs }
    })
    .sort((a, b) => b.liveElapsedMs - a.liveElapsedMs)
    .slice(0, limit)
}
