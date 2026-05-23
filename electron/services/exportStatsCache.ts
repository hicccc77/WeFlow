import { cleanAccountDirName, getExportStatsDateRangeToken, normalizeSessionIds } from './exportServiceUtils'
import type { ExportAggregatedSessionMetric, ExportAggregatedSessionStatsCacheEntry, ExportOptions, ExportStatsCacheEntry, ExportStatsResult } from './exportServiceTypes'

export interface ExportStatsCacheDeps {
  getConfiguredDbPath: () => string
  getConfiguredMyWxid: () => string
}

export class ExportStatsCacheManager {
  private exportStatsCache = new Map<string, ExportStatsCacheEntry>()
  private exportAggregatedSessionStatsCache = new Map<string, ExportAggregatedSessionStatsCacheEntry>()
  private readonly exportStatsCacheTtlMs = 2 * 60 * 1000
  private readonly exportAggregatedSessionStatsCacheTtlMs = 60 * 1000
  private readonly exportStatsCacheMaxEntries = 16

  constructor(private readonly deps: ExportStatsCacheDeps) {}

  buildExportStatsCacheKey(
    sessionIds: string[],
    options: Pick<ExportOptions, 'dateRange' | 'senderUsername'>,
    cleanedWxid?: string
  ): string {
    const normalizedIds = normalizeSessionIds(sessionIds).sort()
    const senderToken = String(options.senderUsername || '').trim()
    const dateToken = getExportStatsDateRangeToken(options.dateRange)
    const dbPath = this.deps.getConfiguredDbPath()
    const wxidToken = String(cleanedWxid || cleanAccountDirName(this.deps.getConfiguredMyWxid()) || '').trim()
    return `${dbPath}::${wxidToken}::${dateToken}::${senderToken}::${normalizedIds.join('\u001f')}`
  }


  cloneExportStatsResult(result: ExportStatsResult): ExportStatsResult {
    return {
      ...result,
      sessions: result.sessions.map((item) => ({ ...item }))
    }
  }


  pruneExportStatsCaches(): void {
    const now = Date.now()
    for (const [key, entry] of this.exportStatsCache.entries()) {
      if (now - entry.createdAt > this.exportStatsCacheTtlMs) {
        this.exportStatsCache.delete(key)
      }
    }
    for (const [key, entry] of this.exportAggregatedSessionStatsCache.entries()) {
      if (now - entry.createdAt > this.exportAggregatedSessionStatsCacheTtlMs) {
        this.exportAggregatedSessionStatsCache.delete(key)
      }
    }
  }


  getExportStatsCacheEntry(key: string): ExportStatsCacheEntry | null {
    this.pruneExportStatsCaches()
    const entry = this.exportStatsCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.exportStatsCacheTtlMs) {
      this.exportStatsCache.delete(key)
      return null
    }
    return entry
  }


  setExportStatsCacheEntry(key: string, entry: ExportStatsCacheEntry): void {
    this.pruneExportStatsCaches()
    this.exportStatsCache.set(key, entry)
    if (this.exportStatsCache.size <= this.exportStatsCacheMaxEntries) return
    const staleKeys = Array.from(this.exportStatsCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, Math.max(0, this.exportStatsCache.size - this.exportStatsCacheMaxEntries))
      .map(([cacheKey]) => cacheKey)
    for (const staleKey of staleKeys) {
      this.exportStatsCache.delete(staleKey)
    }
  }


  getAggregatedSessionStatsCache(key: string): Record<string, ExportAggregatedSessionMetric> | null {
    this.pruneExportStatsCaches()
    const entry = this.exportAggregatedSessionStatsCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.exportAggregatedSessionStatsCacheTtlMs) {
      this.exportAggregatedSessionStatsCache.delete(key)
      return null
    }
    return entry.data
  }


  setAggregatedSessionStatsCache(
    key: string,
    data: Record<string, ExportAggregatedSessionMetric>
  ): void {
    this.pruneExportStatsCaches()
    this.exportAggregatedSessionStatsCache.set(key, {
      createdAt: Date.now(),
      data
    })
    if (this.exportAggregatedSessionStatsCache.size <= this.exportStatsCacheMaxEntries) return
    const staleKeys = Array.from(this.exportAggregatedSessionStatsCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, Math.max(0, this.exportAggregatedSessionStatsCache.size - this.exportStatsCacheMaxEntries))
      .map(([cacheKey]) => cacheKey)
    for (const staleKey of staleKeys) {
      this.exportAggregatedSessionStatsCache.delete(staleKey)
    }
  }


}
