import { config } from '../../services/ipc'
import { AI_ANALYSIS_DEFAULTS, AI_ANALYSIS_LOG_RETENTION_DAYS } from './defaults'
import type { AiAnalysisLogEntry, AiAnalysisSettings, AiAnalysisTaskRecord } from './types'

const NS = 'aiAnalysisV1'

const KEYS = {
  settings: `${NS}.settings`,
  logs: `${NS}.logs`,
  tasks: `${NS}.tasks`,
  columnWidths: `${NS}.columnWidths`,
  systemLogs: `${NS}.systemLogs`
} as const

const now = () => Date.now()

const retentionMs = AI_ANALYSIS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

const uniqueById = <T extends { id: string }>(items: T[]): T[] => {
  const map = new Map<string, T>()
  for (const item of items) map.set(item.id, item)
  return Array.from(map.values())
}

export async function getAiAnalysisSettings(): Promise<AiAnalysisSettings> {
  const raw = await config.get(KEYS.settings)
  const value = (raw || {}) as Partial<AiAnalysisSettings>
  return {
    ...AI_ANALYSIS_DEFAULTS,
    ...value,
    defaultDays: Number(value.defaultDays || AI_ANALYSIS_DEFAULTS.defaultDays),
    defaultMediaTypes: Array.isArray(value.defaultMediaTypes) && value.defaultMediaTypes.length > 0
      ? value.defaultMediaTypes
      : AI_ANALYSIS_DEFAULTS.defaultMediaTypes,
    updatedAt: Number(value.updatedAt || 0)
  }
}

export async function setAiAnalysisSettings(next: Partial<AiAnalysisSettings>): Promise<AiAnalysisSettings> {
  const current = await getAiAnalysisSettings()
  const merged: AiAnalysisSettings = {
    ...current,
    ...next,
    updatedAt: now()
  }
  await config.set(KEYS.settings, merged)
  return merged
}

export async function getAiAnalysisTasks(): Promise<AiAnalysisTaskRecord[]> {
  const raw = await config.get(KEYS.tasks)
  const tasks = Array.isArray(raw) ? raw as AiAnalysisTaskRecord[] : []
  return uniqueById(tasks).sort((a, b) => b.createdAt - a.createdAt)
}

export async function upsertAiAnalysisTask(task: AiAnalysisTaskRecord): Promise<void> {
  const tasks = await getAiAnalysisTasks()
  const merged = uniqueById([task, ...tasks]).sort((a, b) => b.createdAt - a.createdAt)
  await config.set(KEYS.tasks, merged)
}

export async function getAiAnalysisLogs(taskId?: string): Promise<AiAnalysisLogEntry[]> {
  const raw = await config.get(KEYS.logs)
  const logs = Array.isArray(raw) ? raw as AiAnalysisLogEntry[] : []
  const threshold = now() - retentionMs
  const retained = logs.filter(item => Number(item.createdAt) >= threshold)
  const filtered = taskId ? retained.filter(item => item.taskId === taskId) : retained
  return filtered.sort((a, b) => b.createdAt - a.createdAt)
}

export async function appendAiAnalysisLog(entry: AiAnalysisLogEntry): Promise<void> {
  const retained = await getAiAnalysisLogs()
  const next = uniqueById([entry, ...retained]).sort((a, b) => b.createdAt - a.createdAt)
  await config.set(KEYS.logs, next)
}

export async function clearExpiredAiAnalysisLogs(): Promise<void> {
  const raw = await config.get(KEYS.logs)
  const logs = Array.isArray(raw) ? raw as AiAnalysisLogEntry[] : []
  const threshold = now() - retentionMs
  const retained = logs.filter(item => Number(item.createdAt) >= threshold)
  await config.set(KEYS.logs, retained)
}

export async function getAiAnalysisSystemLogs(): Promise<AiAnalysisLogEntry[]> {
  const raw = await config.get(KEYS.systemLogs)
  const logs = Array.isArray(raw) ? raw as AiAnalysisLogEntry[] : []
  const threshold = now() - retentionMs
  return logs
    .filter(item => Number(item.createdAt) >= threshold)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function appendAiAnalysisSystemLog(entry: AiAnalysisLogEntry): Promise<void> {
  const logs = await getAiAnalysisSystemLogs()
  const next = uniqueById([entry, ...logs]).sort((a, b) => b.createdAt - a.createdAt)
  await config.set(KEYS.systemLogs, next)
}

export async function getAiAnalysisColumnWidths(): Promise<Record<string, number>> {
  const raw = await config.get(KEYS.columnWidths)
  return (raw && typeof raw === 'object') ? raw as Record<string, number> : {}
}

export async function setAiAnalysisColumnWidths(widths: Record<string, number>): Promise<void> {
  await config.set(KEYS.columnWidths, widths)
}
