export interface SessionStatsHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getCacheScope(): string
  getMyWxidCleaned(): string
}
