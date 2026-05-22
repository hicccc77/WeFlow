import type { ContactCacheEntry } from '../contactCacheService'

export interface SessionDetailHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getCacheScope(): string
  getMessageDbCountSnapshot(forceRefresh?: boolean): Promise<{
    success: boolean
    dbPaths?: string[]
    dbSignature?: string
    error?: string
  }>
  buildMessageDbSignature(dbPaths: string[]): string
  normalizeExportDiagTraceId(traceId?: string): string
  logExportDiag(input: {
    traceId?: string
    source?: 'backend' | 'main' | 'frontend' | 'worker'
    level?: 'debug' | 'info' | 'warn' | 'error'
    message: string
    stepId?: string
    stepName?: string
    status?: 'running' | 'done' | 'failed' | 'timeout'
    durationMs?: number
    data?: Record<string, unknown>
  }): void
  startExportDiagStep(input: {
    traceId?: string
    stepId: string
    stepName: string
    message: string
    data?: Record<string, unknown>
  }): number
  endExportDiagStep(input: {
    traceId?: string
    stepId: string
    stepName: string
    startedAt: number
    success: boolean
    message?: string
    data?: Record<string, unknown>
  }): void
  getAvatarCacheEntry(username: string): ContactCacheEntry | undefined
  isValidAvatarUrl(avatarUrl?: string): avatarUrl is string
  getAvatarsFromHeadImageDb(usernames: string[]): Promise<Record<string, string>>
}
