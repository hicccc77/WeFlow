export interface ContactsHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getDbPath(): string
  getMyWxidCleaned(): string
  isEnterpriseOpenimUsername(username: string): boolean
  isAllowedEnterpriseOpenimByLocalType(username: string, localType?: number): boolean
  quoteSqlIdentifier(identifier: string): string
}
