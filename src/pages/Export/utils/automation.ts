/**
 * ExportV2 — Automation utility functions
 * Pure functions for automation task scheduling, date range resolution, and formatting.
 */

import type {
  ExportAutomationTask,
  ExportAutomationSchedule,
  ExportAutomationDateRangeConfig
} from '../../../types/exportAutomation'
import type { ExportDateRangeSelection, ExportDateRangePreset } from '../../../utils/exportDateRange'
import {
  resolveExportDateRangeConfig,
  getExportDateRangeLabel,
  createDateRangeByLastNDays
} from '../../../utils/exportDateRange'
import { formatDurationMs } from './format'

// ─── Interval normalization ──────────────────────────────────

export const normalizeAutomationIntervalDays = (value: unknown): number =>
  Math.max(0, Math.floor(Number(value) || 0))

export const normalizeAutomationIntervalHours = (value: unknown): number =>
  Math.max(0, Math.min(23, Math.floor(Number(value) || 0)))

export const normalizeAutomationFirstTriggerAt = (value: unknown): number => {
  const numeric = Math.floor(Number(value) || 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric
}

// ─── Interval calculation ────────────────────────────────────

export const resolveAutomationIntervalMs = (schedule: ExportAutomationSchedule): number => {
  const days = normalizeAutomationIntervalDays(schedule.intervalDays)
  const hours = normalizeAutomationIntervalHours(schedule.intervalHours)
  const totalHours = (days * 24) + hours
  if (totalHours <= 0) return 0
  return totalHours * 60 * 60 * 1000
}

// ─── Trigger timing ──────────────────────────────────────────

export const resolveAutomationInitialTriggerAt = (task: ExportAutomationTask): number | null => {
  const intervalMs = resolveAutomationIntervalMs(task.schedule)
  if (intervalMs <= 0) return null
  const firstTriggerAt = normalizeAutomationFirstTriggerAt(task.schedule.firstTriggerAt)
  if (firstTriggerAt > 0) return firstTriggerAt
  const createdAt = Math.max(0, Math.floor(Number(task.createdAt || 0)))
  if (!createdAt) return null
  return createdAt + intervalMs
}

export const resolveAutomationNextTriggerAt = (task: ExportAutomationTask): number | null => {
  const intervalMs = resolveAutomationIntervalMs(task.schedule)
  if (intervalMs <= 0) return null
  const lastTriggeredAt = Math.max(0, Math.floor(Number(task.runState?.lastTriggeredAt || 0)))
  if (lastTriggeredAt > 0) return lastTriggeredAt + intervalMs
  return resolveAutomationInitialTriggerAt(task)
}

export const resolveAutomationDueScheduleKey = (task: ExportAutomationTask, now: Date): string | null => {
  const intervalMs = resolveAutomationIntervalMs(task.schedule)
  if (intervalMs <= 0) return null
  const nowMs = now.getTime()
  const lastTriggeredAt = Math.max(0, Math.floor(Number(task.runState?.lastTriggeredAt || 0)))
  if (lastTriggeredAt > 0) {
    if (nowMs < lastTriggeredAt + intervalMs) return null
    return `interval:${lastTriggeredAt}:${Math.floor((nowMs - lastTriggeredAt) / intervalMs)}`
  }
  const initialTriggerAt = resolveAutomationInitialTriggerAt(task)
  if (!initialTriggerAt) return null
  if (nowMs < initialTriggerAt) return null
  return `first:${initialTriggerAt}`
}

// ─── Schedule formatting ─────────────────────────────────────

export const formatAutomationScheduleLabel = (schedule: ExportAutomationSchedule): string => {
  const days = normalizeAutomationIntervalDays(schedule.intervalDays)
  const hours = normalizeAutomationIntervalHours(schedule.intervalHours)
  const parts: string[] = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  return `每间隔 ${parts.length > 0 ? parts.join(' ') : '0 小时'} 执行一次`
}

export const resolveAutomationFirstTriggerSummary = (task: ExportAutomationTask): string => {
  const firstTriggerAt = normalizeAutomationFirstTriggerAt(task.schedule.firstTriggerAt)
  if (firstTriggerAt <= 0) return '未指定（默认按创建时间+间隔）'
  return new Date(firstTriggerAt).toLocaleString('zh-CN')
}

export const formatAutomationCurrentState = (
  task: ExportAutomationTask,
  queueState: 'queued' | 'running' | null,
  nowMs: number
): string => {
  if (!task.enabled) return '已停用'
  if (queueState === 'running') return '执行中'
  if (queueState === 'queued') return '排队中'
  const nextTriggerAt = resolveAutomationNextTriggerAt(task)
  if (!nextTriggerAt) return '等待触发'
  const diff = nextTriggerAt - nowMs
  if (diff <= 0) return '即将触发'
  return `等待触发 · 下次 ${new Date(nextTriggerAt).toLocaleString('zh-CN')}（约 ${formatDurationMs(diff)} 后）`
}

export const formatAutomationStopCondition = (task: ExportAutomationTask): string => {
  const endAt = Number(task.stopCondition?.endAt || 0)
  const maxRuns = Number(task.stopCondition?.maxRuns || 0)
  const labels: string[] = []
  if (endAt > 0) {
    labels.push(`截止到 ${new Date(endAt).toLocaleString('zh-CN')}`)
  }
  if (maxRuns > 0) {
    const successCount = Math.max(0, Math.floor(Number(task.runState?.successCount || 0)))
    labels.push(`成功 ${successCount}/${maxRuns} 次后停止`)
  }
  return labels.length > 0 ? labels.join(' · ') : '无'
}

export const formatAutomationLastRunSummary = (task: ExportAutomationTask): string => {
  const status = task.runState?.lastRunStatus || 'idle'
  const label = (
    status === 'idle' ? '尚未执行' :
    status === 'queued' ? '已入队' :
    status === 'running' ? '执行中' :
    status === 'success' ? '执行成功' :
    status === 'error' ? '执行失败' :
    status === 'skipped' ? '已跳过' :
    status
  )
  const parts: string[] = [label]
  if (task.runState?.lastSuccessAt) {
    parts.push(`最近成功于 ${new Date(task.runState.lastSuccessAt).toLocaleString('zh-CN')}`)
  }
  if (task.runState?.lastSkipReason) parts.push(task.runState.lastSkipReason)
  if (task.runState?.lastError) parts.push(task.runState.lastError)
  return parts.join(' · ')
}

// ─── Schedule builder ────────────────────────────────────────

export const buildAutomationSchedule = (
  intervalDays: number,
  intervalHours: number,
  firstTriggerAt: number
): ExportAutomationSchedule => ({
  type: 'interval',
  intervalDays,
  intervalHours,
  firstTriggerAt: firstTriggerAt > 0 ? firstTriggerAt : undefined
})

// ─── Date part helpers ───────────────────────────────────────

export const buildAutomationDatePart = (timestamp: number): string => {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const buildAutomationTodayDatePart = (): string => buildAutomationDatePart(Date.now())

export const normalizeAutomationDatePart = (value: string): string => {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

export const normalizeAutomationTimePart = (value: string): string => {
  const text = String(value || '').trim()
  if (!/^\d{2}:\d{2}$/.test(text)) return '00:00'
  const [hoursText, minutesText] = text.split(':')
  const hours = Math.floor(Number(hoursText))
  const minutes = Math.floor(Number(minutesText))
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '00:00'
  const safeHours = Math.min(23, Math.max(0, hours))
  const safeMinutes = Math.min(59, Math.max(0, minutes))
  return `${`${safeHours}`.padStart(2, '0')}:${`${safeMinutes}`.padStart(2, '0')}`
}

// ─── Date range for automation ───────────────────────────────

export type AutomationRangeMode = 'all' | 'today' | 'yesterday' | 'last7days' | 'last30days' | 'last1year' | 'lastNDays' | 'custom'

export const AUTOMATION_RANGE_OPTIONS: Array<{ mode: AutomationRangeMode; label: string }> = [
  { mode: 'all', label: '全部时间' },
  { mode: 'yesterday', label: '往前1天' },
  { mode: 'last7days', label: '往前7天' },
  { mode: 'last30days', label: '往前30天' },
  { mode: 'last1year', label: '往前1年' },
  { mode: 'lastNDays', label: '往前N天' },
  { mode: 'custom', label: '完整时间' }
]

export const AUTOMATION_LAST_N_DAYS_MIN = 1
export const AUTOMATION_LAST_N_DAYS_MAX = 3650
export const AUTOMATION_LAST_N_DAYS_DEFAULT = 3

export const normalizeAutomationLastNDays = (value: unknown): number => {
  const parsed = Math.floor(Number(value) || 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return AUTOMATION_LAST_N_DAYS_DEFAULT
  return Math.min(AUTOMATION_LAST_N_DAYS_MAX, Math.max(AUTOMATION_LAST_N_DAYS_MIN, parsed))
}

export const readAutomationLastNDays = (
  config: ExportAutomationDateRangeConfig | string | null | undefined
): number | null => {
  if (!config || typeof config !== 'object') return null
  const raw = config as Record<string, unknown>
  const mode = String(raw.relativeMode || '').trim()
  if (mode !== 'last-n-days') return null
  const days = Math.floor(Number(raw.relativeDays) || 0)
  if (!Number.isFinite(days) || days <= 0) return null
  return Math.min(AUTOMATION_LAST_N_DAYS_MAX, Math.max(AUTOMATION_LAST_N_DAYS_MIN, days))
}

export const buildAutomationLastNDaysConfig = (days: number): ExportAutomationDateRangeConfig => ({
  version: 1,
  preset: 'custom',
  useAllTime: false,
  relativeMode: 'last-n-days',
  relativeDays: normalizeAutomationLastNDays(days)
})

export const resolveAutomationDateRangeSelection = (
  config: ExportAutomationDateRangeConfig | string | null | undefined,
  now = new Date()
): ExportDateRangeSelection => {
  const relativeDays = readAutomationLastNDays(config)
  if (relativeDays) {
    return {
      preset: 'custom',
      useAllTime: false,
      dateRange: createDateRangeByLastNDays(relativeDays, now)
    }
  }
  return resolveExportDateRangeConfig(config as any, now)
}

export const resolveAutomationRangeMode = (
  config: ExportAutomationDateRangeConfig | string | null | undefined,
  selection: ExportDateRangeSelection
): AutomationRangeMode => {
  if (readAutomationLastNDays(config)) return 'lastNDays'
  if (selection.useAllTime) return 'all'
  if (selection.preset === 'today') return 'today'
  if (selection.preset === 'yesterday') return 'yesterday'
  if (selection.preset === 'last7days') return 'last7days'
  if (selection.preset === 'last30days') return 'last30days'
  if (selection.preset === 'last1year') return 'last1year'
  return 'custom'
}

export const createAutomationSelectionByMode = (
  mode: Exclude<AutomationRangeMode, 'custom' | 'lastNDays'>,
  now = new Date()
): ExportDateRangeSelection => {
  const preset: ExportDateRangePreset = mode
  return resolveExportDateRangeConfig({
    version: 1,
    preset,
    useAllTime: mode === 'all'
  }, now)
}

export const formatAutomationRangeLabel = (
  config: ExportAutomationDateRangeConfig | string | null | undefined,
  selection?: ExportDateRangeSelection
): string => {
  const resolved = selection || resolveAutomationDateRangeSelection(config, new Date())
  const mode = resolveAutomationRangeMode(config, resolved)
  if (mode === 'all') return '每次触发导出全部历史消息'
  if (mode === 'today') return '每次触发导出当天'
  if (mode === 'yesterday') return '每次触发导出前1天（昨日）'
  if (mode === 'last7days') return '每次触发导出前7天'
  if (mode === 'last30days') return '每次触发导出前30天'
  if (mode === 'last1year') return '每次触发导出前1年'
  if (mode === 'lastNDays') {
    return `每次触发导出前 ${readAutomationLastNDays(config) || AUTOMATION_LAST_N_DAYS_DEFAULT} 天`
  }
  return `完整时间：${getExportDateRangeLabel(resolved)}`
}

// ─── Task ID factories ───────────────────────────────────────

export const createTaskId = (): string => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
export const createAutomationTaskId = (): string => `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
