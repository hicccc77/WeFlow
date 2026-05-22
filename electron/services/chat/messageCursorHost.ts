import type { Message } from './types'

export interface MessageCursorHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getMyWxidCleaned(): string
  resolveQuotedMessages(messages: Message[], sessionId: string): Promise<void>
  markSyntheticUnreadRead(sessionId: string, messages: Message[]): void
  chatServiceLog(message: string, meta?: unknown): void
  resolveAccountDir(dbPath: string, wxid: string): string | null
  getConfigString(key: string): string
  getEmojiCacheDir(): string
}
