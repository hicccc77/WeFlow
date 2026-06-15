import { create } from 'zustand'
import type { ChatSession, Message, Contact } from '../types/models'

const messageAliasIndex = new Set<string>()

function buildPrimaryMessageKey(message: Message, sourceScope?: string): string {
  if (message.messageKey) return String(message.messageKey)
  const normalizedSourceScope = sourceScope ?? String(message._db_path || '').trim()
  return `fallback:${normalizedSourceScope}:${message.serverId || 0}:${message.createTime}:${message.sortSeq || 0}:${message.localId || 0}:${message.senderUsername || ''}:${message.localType || 0}`
}

function buildMessageAliasKeys(message: Message): string[] {
  const sourceScope = String(message._db_path || '').trim()
  const keys = [buildPrimaryMessageKey(message, sourceScope)]
  const localId = Math.max(0, Number(message.localId || 0))
  const serverId = Math.max(0, Number(message.serverId || 0))
  const createTime = Math.max(0, Number(message.createTime || 0))
  const localType = Math.floor(Number(message.localType || 0))
  const sender = String(message.senderUsername || '')
  const isSend = Number(message.isSend ?? -1)

  if (localId > 0) {
    // 跨 message_*.db 时 local_id 可能重复，必须带分库上下文避免误去重。
    if (sourceScope) {
      keys.push(`lid:${sourceScope}:${localId}`)
    } else {
      // 缺库信息时使用更保守组合，尽量避免把不同消息误判成重复。
      keys.push(`lid_fallback:${localId}:${createTime}:${sender}:${localType}:${serverId}`)
    }
  }
  if (serverId > 0) {
    // server_id 在跨库场景并非绝对全局唯一；必须带来源作用域避免误去重。
    if (sourceScope) {
      keys.push(`sid:${sourceScope}:${serverId}`)
    } else {
      keys.push(`sid_fallback:${serverId}:${createTime}:${sender}:${localType}`)
    }
  }
  if (localType === 3) {
    const imageIdentity = String(message.imageMd5 || message.imageDatName || '').trim()
    if (imageIdentity) {
      keys.push(`img:${sourceScope}:${createTime}:${sender}:${isSend}:${imageIdentity}`)
    }
  }

  return keys
}

function rebuildMessageAliasIndex(messages: Message[]): void {
  messageAliasIndex.clear()
  for (const message of messages) {
    const aliasKeys = buildMessageAliasKeys(message)
    for (const key of aliasKeys) {
      messageAliasIndex.add(key)
    }
  }
}

export interface ChatState {
  // 连接状态
  isConnected: boolean
  isConnecting: boolean
  connectionError: string | null

  // 会话列表
  sessions: ChatSession[]
  filteredSessions: ChatSession[]
  currentSessionId: string | null
  isLoadingSessions: boolean

  // 消息
  messages: Message[]
  isLoadingMessages: boolean
  isLoadingMore: boolean
  hasMoreMessages: boolean
  hasMoreLater: boolean

  // 联系人缓存
  contacts: Map<string, Contact>

  // 搜索
  searchKeyword: string

  // 操作
  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setConnectionError: (error: string | null) => void
  setSessions: (sessions: ChatSession[]) => void
  setFilteredSessions: (sessions: ChatSession[]) => void
  setCurrentSession: (sessionId: string | null, options?: { preserveMessages?: boolean }) => void
  setLoadingSessions: (loading: boolean) => void
  setMessages: (messages: Message[]) => void
  appendMessages: (messages: Message[], prepend?: boolean) => void
  setLoadingMessages: (loading: boolean) => void
  setLoadingMore: (loading: boolean) => void
  setHasMoreMessages: (hasMore: boolean) => void
  setHasMoreLater: (hasMore: boolean) => void
  setContacts: (contacts: Contact[]) => void
  addContact: (contact: Contact) => void
  setSearchKeyword: (keyword: string) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  isConnected: false,
  isConnecting: false,
  connectionError: null,
  sessions: [],
  filteredSessions: [],
  currentSessionId: null,
  isLoadingSessions: false,
  messages: [],
  isLoadingMessages: false,
  isLoadingMore: false,
  hasMoreMessages: true,
  hasMoreLater: false,
  contacts: new Map(),
  searchKeyword: '',

  setConnected: (connected) => set({ isConnected: connected }),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setConnectionError: (error) => set({ connectionError: error }),

  setSessions: (sessions) => set({ sessions, filteredSessions: sessions }),
  setFilteredSessions: (sessions) => set({ filteredSessions: sessions }),

  setCurrentSession: (sessionId, options) => set((state) => {
    const nextMessages = options?.preserveMessages ? state.messages : []
    rebuildMessageAliasIndex(nextMessages)
    return {
      currentSessionId: sessionId,
      messages: nextMessages,
      hasMoreMessages: true,
      hasMoreLater: false
    }
  }),

  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  setMessages: (messages) => set(() => {
    rebuildMessageAliasIndex(messages || [])
    return { messages }
  }),

  appendMessages: (newMessages, prepend = false) => set((state) => {
    const currentMessages = state.messages || []
    if (messageAliasIndex.size === 0 && currentMessages.length > 0) {
      rebuildMessageAliasIndex(currentMessages)
    }

    const filtered: Message[] = []
    newMessages.forEach((msg) => {
      const aliasKeys = buildMessageAliasKeys(msg)
      let exists = false
      for (const key of aliasKeys) {
        if (messageAliasIndex.has(key)) {
          exists = true
          break
        }
      }
      if (exists) return
      filtered.push(msg)
      for (const key of aliasKeys) {
        messageAliasIndex.add(key)
      }
    })

    if (filtered.length === 0) return state

    return {
      messages: prepend
        ? [...filtered, ...currentMessages]
        : [...currentMessages, ...filtered]
    }
  }),

  setLoadingMessages: (loading) => set({ isLoadingMessages: loading }),
  setLoadingMore: (loading) => set({ isLoadingMore: loading }),
  setHasMoreMessages: (hasMore) => set({ hasMoreMessages: hasMore }),
  setHasMoreLater: (hasMore) => set({ hasMoreLater: hasMore }),

  setContacts: (contacts) => set({
    contacts: new Map(contacts.map(c => [c.username, c]))
  }),

  addContact: (contact) => set((state) => {
    const newContacts = new Map(state.contacts)
    newContacts.set(contact.username, contact)
    return { contacts: newContacts }
  }),

  setSearchKeyword: (keyword) => set({ searchKeyword: keyword }),

  reset: () => set(() => {
    messageAliasIndex.clear()
    return {
      isConnected: false,
      isConnecting: false,
      connectionError: null,
      sessions: [],
      filteredSessions: [],
      currentSessionId: null,
      isLoadingSessions: false,
      messages: [],
      isLoadingMessages: false,
      isLoadingMore: false,
      hasMoreMessages: true,
      hasMoreLater: false,
      contacts: new Map(),
      searchKeyword: ''
    }
  })
}))
