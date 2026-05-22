import type { ChatSession, Message } from './types'

export interface MediaAssetsHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  connect(): Promise<{ success: boolean; error?: string }>
  isConnected(): boolean
  getMyWxidCleaned(): string
  getConfigString(key: string): string
  getMessageByLocalId(
    sessionId: string,
    localId: number
  ): Promise<{ success: boolean; message?: Message; error?: string }>
  getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
  forEachWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
  ): Promise<void>
  chatServiceLog(message: string, meta?: unknown): void
}
