import { create } from 'zustand'

export interface Contact {
  id: string
  name: string
  avatarUrl?: string
}

export interface ContactWithStatus extends Contact {
  lastMessage: string
  unread: number
  starred: boolean
  ignored?: boolean
}

export interface AnalysisResult {
  isComplex: boolean
  reason: string
  guideQuestions: string[]
  discussionId?: number
}

export interface DiscussionRound {
  role: 'user' | 'assistant'
  content: string
  round: number
}

export interface ReplySuggestion {
  content: string
  reason: string
  style: 'safe' | 'warm' | 'firm'
  confidence: number
}

export interface DailyBriefing {
  summary: string
  unrepliedCount: number
  topContacts: { name: string; count: number }[]
  todos: string[]
}

export interface AssistantState {
  contacts: ContactWithStatus[]
  selectedContact: string | null
  selectedMessage: string | null
  analysisResult: AnalysisResult | null
  discussionRounds: DiscussionRound[]
  discussionId: number | null
  replySuggestions: ReplySuggestion[]
  isAnalyzing: boolean
  isDiscussing: boolean
  isGeneratingReplies: boolean
  error: string | null
  searchQuery: string
  searchResults: Contact[]
  briefing: DailyBriefing | null
  briefingError: string | null
  showDiscussionPanel: boolean
  contextData: Record<string, unknown> | null

  // actions
  loadContacts: () => Promise<void>
  selectContact: (id: string) => void
  analyze: (contact: string, message: string) => Promise<void>
  discuss: (userInput: string) => Promise<void>
  generateReplies: () => Promise<void>
  search: (query: string) => void
  loadBriefing: () => Promise<void>
  toggleDiscussionPanel: () => void
  starContact: (id: string) => Promise<void>
  ignoreContact: (id: string) => Promise<void>
  loadContext: (contactId: string) => Promise<void>
  clearError: () => void
}

/** Map backend ReplySuggestion (text/reasoning) to frontend shape (content/reason) */
function mapSuggestion(s: { text: string; reasoning: string; style: string; confidence: number }): ReplySuggestion {
  return {
    content: s.text,
    reason: s.reasoning,
    style: (s.style as 'safe' | 'warm' | 'firm') || 'safe',
    confidence: s.confidence,
  }
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  contacts: [],
  selectedContact: null,
  selectedMessage: null,
  analysisResult: null,
  discussionRounds: [],
  discussionId: null,
  replySuggestions: [],
  isAnalyzing: false,
  isDiscussing: false,
  isGeneratingReplies: false,
  error: null,
  searchQuery: '',
  searchResults: [],
  briefing: null,
  briefingError: null,
  showDiscussionPanel: false,
  contextData: null,

  clearError: () => set({ error: null }),

  loadContacts: async () => {
    try {
      // Load contacts from WCDB via existing chat API
      const result = await window.electronAPI.chat.getSessions()
      const sessionList = (result as any)?.sessions || (Array.isArray(result) ? result : [])

      // Load starred/ignored preferences from intelligenceDb
      let starredSet = new Set<string>()
      let ignoredSet = new Set<string>()
      try {
        const prefs = await window.electronAPI.intel.getPreferences()
        starredSet = new Set(prefs.starred)
        ignoredSet = new Set(prefs.ignored)
      } catch { /* preferences not available yet */ }

      const contacts: ContactWithStatus[] = []
      for (const session of sessionList.slice(0, 200)) {
        const name = session.displayName || session.name || session.id || ''
        contacts.push({
          id: session.id || session.sessionId || '',
          name,
          avatarUrl: session.avatarUrl,
          lastMessage: session.lastMessage || '',
          unread: session.unreadCount || 0,
          starred: starredSet.has(name),
          ignored: ignoredSet.has(name),
        })
      }

      set({ contacts })
    } catch (e) {
      console.error('Failed to load contacts:', e)
      set({ error: '加载联系人失败' })
    }
  },

  selectContact: (id) => {
    const state = get()
    const contact = state.contacts.find(c => c.id === id)
    set({
      selectedContact: id,
      selectedMessage: contact?.lastMessage || null,
      analysisResult: null,
      discussionRounds: [],
      discussionId: null,
      replySuggestions: [],
      contextData: null,
      error: null,
    })
    // Auto-load context and analyze
    if (contact?.lastMessage) {
      state.analyze(id, contact.lastMessage)
    }
    state.loadContext(id)
  },

  analyze: async (contact, message) => {
    set({ isAnalyzing: true, error: null, selectedMessage: message })
    try {
      const result = await window.electronAPI.intel.analyzeMessage(contact, message)
      const analysisResult: AnalysisResult = {
        isComplex: result.isComplex,
        reason: result.reason,
        guideQuestions: result.guideQuestions || [],
        discussionId: result.discussionId,
      }

      const suggestions = result.suggestions ? result.suggestions.map(mapSuggestion) : []

      set({
        isAnalyzing: false,
        analysisResult,
        replySuggestions: suggestions,
        discussionId: result.discussionId || null,
        showDiscussionPanel: result.isComplex,
      })
    } catch (e: any) {
      console.error('Analysis failed:', e)
      const msg = e?.message || String(e)
      set({
        isAnalyzing: false,
        error: msg.includes('timeout') ? 'AI 响应超时，请重试'
          : msg.includes('429') || msg.includes('rate') ? 'AI 请求过于频繁，请稍后重试'
          : msg.includes('401') || msg.includes('key') ? 'API Key 无效，请在设置中检查配置'
          : `AI 分析失败：${msg.slice(0, 80)}`,
      })
    }
  },

  discuss: async (userInput) => {
    const { selectedContact, selectedMessage, discussionId, discussionRounds } = get()
    if (!selectedContact || !selectedMessage) return

    const nextRound = discussionRounds.length + 1
    set({
      isDiscussing: true,
      error: null,
      discussionRounds: [...discussionRounds, { role: 'user', content: userInput, round: nextRound }],
    })

    try {
      const result = await window.electronAPI.intel.discuss(
        selectedContact,
        selectedMessage,
        userInput,
        discussionId || undefined,
      )

      const aiContent = result.followup
        ? `${result.analysis}\n\n**追问：** ${result.followup}`
        : result.analysis

      set(state => ({
        isDiscussing: false,
        discussionId: result.discussionId,
        discussionRounds: [
          ...state.discussionRounds,
          { role: 'assistant', content: aiContent, round: result.round },
        ],
      }))
    } catch (e: any) {
      console.error('Discussion failed:', e)
      set({
        isDiscussing: false,
        error: e?.message || '讨论分析失败，请重试',
      })
    }
  },

  generateReplies: async () => {
    const { selectedContact, selectedMessage, discussionId } = get()
    if (!selectedContact || !selectedMessage) return

    set({ isGeneratingReplies: true, error: null })

    try {
      let suggestions: ReplySuggestion[]

      if (discussionId) {
        // Generate replies based on discussion
        const result = await window.electronAPI.intel.discussReply(discussionId)
        suggestions = (result || []).map(mapSuggestion)
      } else {
        // Generate direct replies
        const result = await window.electronAPI.intel.generateReplies(selectedContact, selectedMessage)
        suggestions = (result || []).map(mapSuggestion)
      }

      set({ isGeneratingReplies: false, replySuggestions: suggestions })
    } catch (e: any) {
      console.error('Reply generation failed:', e)
      set({
        isGeneratingReplies: false,
        error: e?.message || '生成回复建议失败',
      })
    }
  },

  search: (query) => {
    set({ searchQuery: query })
    if (!query.trim()) {
      set({ searchResults: [] })
      return
    }
    const { contacts } = get()
    const results = contacts.filter(c =>
      c.name.toLowerCase().includes(query.toLowerCase())
    )
    set({ searchResults: results })
  },

  loadBriefing: async () => {
    try {
      const result = await window.electronAPI.intel.getDailyBriefing()
      if (result) {
        set({
          briefing: {
            summary: result.summary || '暂无简报数据',
            unrepliedCount: result.items?.filter((i: any) => i.category === 'unreplied').length || 0,
            topContacts: result.items?.slice(0, 3).map((i: any) => ({
              name: i.contact || '',
              count: i.priority || 0,
            })) || [],
            todos: result.items?.filter((i: any) => i.category === 'reminder').map((i: any) => i.title) || [],
          },
        })
      }
    } catch (e: any) {
      console.warn('Failed to load briefing:', e)
      set({ briefingError: '每日简报加载失败' })
    }
  },

  toggleDiscussionPanel: () => {
    set(state => ({ showDiscussionPanel: !state.showDiscussionPanel }))
  },

  starContact: async (id) => {
    try {
      await window.electronAPI.intel.starContact(id)
      set(state => ({
        contacts: state.contacts.map(c =>
          c.id === id ? { ...c, starred: !c.starred } : c
        ),
      }))
    } catch (e) {
      console.error('Star contact failed:', e)
    }
  },

  ignoreContact: async (id) => {
    try {
      await window.electronAPI.intel.ignoreContact(id)
      set(state => ({
        contacts: state.contacts.map(c =>
          c.id === id ? { ...c, ignored: !c.ignored } : c
        ),
      }))
    } catch (e) {
      console.error('Ignore contact failed:', e)
    }
  },

  loadContext: async (contactId) => {
    try {
      const result = await window.electronAPI.intel.getContext(contactId)
      if (result) {
        set({
          contextData: {
            messages: result.messages,
            hasMore: result.hasMore,
            total: result.total,
            isGroup: result.isGroup,
          },
        })
      }
    } catch (e) {
      // Context is non-critical
      console.warn('Failed to load context:', e)
    }
  },
}))
