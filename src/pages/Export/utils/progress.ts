/**
 * ExportV2 — Progress utility functions
 * Pure functions for progress normalization, comparison, and formatting.
 */

import type { TaskProgress, ExportTask, ExportProgress } from '../types'

// ─── Progress comparison ─────────────────────────────────────

export const areTaskProgressEqual = (left: TaskProgress, right: TaskProgress): boolean => (
  left.current === right.current &&
  left.total === right.total &&
  left.currentName === right.currentName &&
  left.phase === right.phase &&
  left.phaseLabel === right.phaseLabel &&
  left.phaseProgress === right.phaseProgress &&
  left.phaseTotal === right.phaseTotal &&
  left.exportedMessages === right.exportedMessages &&
  left.estimatedTotalMessages === right.estimatedTotalMessages &&
  left.collectedMessages === right.collectedMessages &&
  left.writtenFiles === right.writtenFiles &&
  left.mediaDoneFiles === right.mediaDoneFiles &&
  left.mediaCacheHitFiles === right.mediaCacheHitFiles &&
  left.mediaCacheMissFiles === right.mediaCacheMissFiles &&
  left.mediaCacheFillFiles === right.mediaCacheFillFiles &&
  left.mediaDedupReuseFiles === right.mediaDedupReuseFiles &&
  left.mediaBytesWritten === right.mediaBytesWritten
)

// ─── Progress normalization ──────────────────────────────────

export const normalizeProgressFloat = (value: unknown, digits = 3): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  const factor = 10 ** digits
  return Math.round(parsed * factor) / factor
}

export const normalizeProgressInt = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

// ─── Progress payload signature (for dedup) ──────────────────

export const buildProgressPayloadSignature = (payload: ExportProgress): string => ([
  String(payload.phase || ''),
  String(payload.currentSessionId || ''),
  String(payload.currentSession || ''),
  String(payload.phaseLabel || ''),
  normalizeProgressFloat(payload.current, 4),
  normalizeProgressFloat(payload.total, 4),
  normalizeProgressFloat(payload.phaseProgress, 2),
  normalizeProgressFloat(payload.phaseTotal, 2),
  normalizeProgressInt(payload.collectedMessages),
  normalizeProgressInt(payload.exportedMessages),
  normalizeProgressInt(payload.estimatedTotalMessages),
  normalizeProgressInt(payload.writtenFiles),
  normalizeProgressInt(payload.mediaDoneFiles),
  normalizeProgressInt(payload.mediaCacheHitFiles),
  normalizeProgressInt(payload.mediaCacheMissFiles),
  normalizeProgressInt(payload.mediaCacheFillFiles),
  normalizeProgressInt(payload.mediaDedupReuseFiles),
  normalizeProgressInt(payload.mediaBytesWritten)
].join('|'))

// ─── Task status helpers ─────────────────────────────────────

export const isExportTaskActiveStatus = (status: import('../types').TaskStatus): boolean => (
  status === 'queued' ||
  status === 'running' ||
  status === 'pause_requested' ||
  status === 'paused' ||
  status === 'cancel_requested'
)

export const getTaskStatusLabel = (task: ExportTask): string => {
  if (task.status === 'queued') return '排队中'
  if (task.status === 'running') return '进行中'
  if (task.status === 'pause_requested') return '暂停中'
  if (task.status === 'paused') return '已暂停'
  if (task.status === 'cancel_requested') return '取消中'
  if (task.status === 'canceled') return '已取消'
  if (task.status === 'success') return '已完成'
  return '失败'
}

export const resolveExportTaskCardClass = (
  status: import('../types').TaskStatus
): 'queued' | 'running' | 'paused' | 'stopped' | 'success' | 'error' => {
  if (status === 'pause_requested' || status === 'paused') return 'paused'
  if (status === 'cancel_requested' || status === 'canceled') return 'stopped'
  return status
}

export const resolveBackgroundTaskCardClass = (
  status: import('../../../types/backgroundTask').BackgroundTaskRecord['status']
): 'running' | 'paused' | 'stopped' | 'success' | 'error' => {
  if (status === 'running') return 'running'
  if (status === 'pause_requested' || status === 'paused') return 'paused'
  if (status === 'cancel_requested' || status === 'canceled') return 'stopped'
  if (status === 'completed') return 'success'
  return 'error'
}

// ─── Background task progress parsing ────────────────────────

export const parseBackgroundTaskProgress = (progressText?: string): {
  current: number
  total: number
  ratio: number | null
} => {
  const normalized = String(progressText || '').trim()
  if (!normalized) return { current: 0, total: 0, ratio: null }
  const match = normalized.match(/(\d+)\s*\/\s*(\d+)/)
  if (!match) return { current: 0, total: 0, ratio: null }
  const current = Math.max(0, Math.floor(Number(match[1]) || 0))
  const total = Math.max(0, Math.floor(Number(match[2]) || 0))
  if (total <= 0) return { current, total, ratio: null }
  return {
    current,
    total,
    ratio: Math.max(0, Math.min(1, current / total))
  }
}

// ─── Task scope helpers ──────────────────────────────────────

export const isTextBatchTask = (task: ExportTask): boolean =>
  task.payload.scope === 'content' && task.payload.contentType === 'text'

export const isImageExportTask = (task: ExportTask): boolean => {
  if (task.payload.scope === 'sns') {
    return Boolean(task.payload.snsOptions?.exportImages)
  }
  if (task.payload.scope !== 'content') return false
  if (task.payload.contentType === 'image') return true
  return Boolean(task.payload.options?.exportImages)
}

// ─── Task open directory resolution ──────────────────────────

import { resolveParentDir } from './format'

export const resolveTaskOpenDir = (task: ExportTask): string => {
  const sessionIds = Array.isArray(task.payload.sessionIds) ? task.payload.sessionIds : []
  if (sessionIds.length === 1) {
    const onlySessionId = String(sessionIds[0] || '').trim()
    const outputPath = onlySessionId ? String(task.sessionOutputPaths?.[onlySessionId] || '').trim() : ''
    if (outputPath) {
      return resolveParentDir(outputPath) || task.payload.outputDir
    }
  }
  return task.payload.outputDir
}
