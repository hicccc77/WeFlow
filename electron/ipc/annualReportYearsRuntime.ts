import { BrowserWindow } from 'electron'

export type AnnualReportYearsLoadStrategy = 'cache' | 'native' | 'hybrid'
export type AnnualReportYearsLoadPhase = 'cache' | 'native' | 'scan' | 'done'

export interface AnnualReportYearsProgressPayload {
  years?: number[]
  done: boolean
  error?: string
  canceled?: boolean
  strategy?: AnnualReportYearsLoadStrategy
  phase?: AnnualReportYearsLoadPhase
  statusText?: string
  nativeElapsedMs?: number
  scanElapsedMs?: number
  totalElapsedMs?: number
  switched?: boolean
  nativeTimedOut?: boolean
}

interface AnnualReportYearsTaskState {
  cacheKey: string
  canceled: boolean
  done: boolean
  snapshot: AnnualReportYearsProgressPayload
  updatedAt: number
}

const annualReportYearsLoadTasks = new Map<string, AnnualReportYearsTaskState>()
const annualReportYearsTaskByCacheKey = new Map<string, string>()
const annualReportYearsSnapshotCache = new Map<string, { snapshot: AnnualReportYearsProgressPayload; updatedAt: number; taskId: string }>()
const annualReportYearsSnapshotTtlMs = 10 * 60 * 1000

export const normalizeAnnualReportYearsSnapshot = (snapshot: AnnualReportYearsProgressPayload): AnnualReportYearsProgressPayload => {
  const years = Array.isArray(snapshot.years) ? [...snapshot.years] : []
  return { ...snapshot, years }
}

export const buildAnnualReportYearsCacheKey = (dbPath: string, wxid: string): string => {
  return `${String(dbPath || '').trim()}\u0001${String(wxid || '').trim()}`
}

const pruneAnnualReportYearsSnapshotCache = (): void => {
  const now = Date.now()
  for (const [cacheKey, entry] of annualReportYearsSnapshotCache.entries()) {
    if (now - entry.updatedAt > annualReportYearsSnapshotTtlMs) {
      annualReportYearsSnapshotCache.delete(cacheKey)
    }
  }
}

export const persistAnnualReportYearsSnapshot = (
  cacheKey: string,
  taskId: string,
  snapshot: AnnualReportYearsProgressPayload
): void => {
  annualReportYearsSnapshotCache.set(cacheKey, {
    taskId,
    snapshot: normalizeAnnualReportYearsSnapshot(snapshot),
    updatedAt: Date.now()
  })
  pruneAnnualReportYearsSnapshotCache()
}

export const getAnnualReportYearsSnapshot = (
  cacheKey: string
): { taskId: string; snapshot: AnnualReportYearsProgressPayload } | null => {
  pruneAnnualReportYearsSnapshotCache()
  const entry = annualReportYearsSnapshotCache.get(cacheKey)
  if (!entry) return null
  return {
    taskId: entry.taskId,
    snapshot: normalizeAnnualReportYearsSnapshot(entry.snapshot)
  }
}

export const broadcastAnnualReportYearsProgress = (
  taskId: string,
  payload: AnnualReportYearsProgressPayload
): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('annualReport:availableYearsProgress', {
      taskId,
      ...payload
    })
  }
}

export const isYearsLoadCanceled = (taskId: string): boolean => {
  const task = annualReportYearsLoadTasks.get(taskId)
  return task?.canceled === true
}

export const getAnnualReportYearsLoadTasks = () => annualReportYearsLoadTasks
export const getAnnualReportYearsTaskByCacheKey = () => annualReportYearsTaskByCacheKey
