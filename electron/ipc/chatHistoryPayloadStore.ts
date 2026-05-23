export interface ChatHistoryPayloadEntry {
  sessionId: string
  title?: string
  recordList: any[]
  createdAt: number
  lastAccessedAt: number
}

const chatHistoryPayloadStore = new Map<string, ChatHistoryPayloadEntry>()
const chatHistoryPayloadTtlMs = 10 * 60 * 1000
const chatHistoryPayloadMaxEntries = 20

export const pruneChatHistoryPayloadStore = (): void => {
  const now = Date.now()

  for (const [payloadId, payload] of chatHistoryPayloadStore.entries()) {
    if (now - payload.createdAt > chatHistoryPayloadTtlMs) {
      chatHistoryPayloadStore.delete(payloadId)
    }
  }

  while (chatHistoryPayloadStore.size > chatHistoryPayloadMaxEntries) {
    const oldestPayloadId = chatHistoryPayloadStore.keys().next().value as string | undefined
    if (!oldestPayloadId) break
    chatHistoryPayloadStore.delete(oldestPayloadId)
  }
}

export const getChatHistoryPayloadStore = (): Map<string, ChatHistoryPayloadEntry> => chatHistoryPayloadStore

export const deleteChatHistoryPayload = (payloadId: string): void => {
  chatHistoryPayloadStore.delete(payloadId)
}
