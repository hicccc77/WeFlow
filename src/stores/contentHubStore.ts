import { create } from 'zustand'

export interface ContentItem {
  id: string
  type: '公众号' | '链接' | '文件' | '图片' | '视频'
  title: string
  source: string
  sourceType: '群聊' | '私聊'
  groupName?: string
  timestamp: number
  summary: string
  url?: string
  starred?: boolean
  ignored?: boolean
}

export interface ContentFilters {
  types: string[]
  sources: string[]
  contact?: string
  days: number
}

/** Map backend content type to frontend display type */
function mapContentType(backendType: string): ContentItem['type'] {
  const mapping: Record<string, ContentItem['type']> = {
    'official-article': '公众号',
    'video-channel': '视频',
    'link': '链接',
    'file': '文件',
    'miniapp': '链接',
  }
  return mapping[backendType] || '链接'
}

export interface ContentHubState {
  items: ContentItem[]
  filters: ContentFilters
  selectedItem: ContentItem | null
  analysisResult: string | null
  isLoading: boolean
  isAnalyzing: boolean
  error: string | null

  setFilter: (key: string, value: unknown) => void
  loadContent: () => Promise<void>
  analyzeContent: (id: string) => Promise<void>
  selectItem: (item: ContentItem | null) => void
  toggleStarred: (id: string) => void
  toggleIgnored: (id: string) => void
}

export const useContentHubStore = create<ContentHubState>((set, get) => ({
  items: [],
  filters: { types: [], sources: [], days: 30 },
  selectedItem: null,
  analysisResult: null,
  isLoading: false,
  isAnalyzing: false,
  error: null,

  setFilter: (key, value) => {
    set(state => ({
      filters: { ...state.filters, [key]: value },
    }))
    // Reload content when filters change
    get().loadContent()
  },

  loadContent: async () => {
    set({ isLoading: true, error: null })
    try {
      const { filters } = get()
      const backendFilters: any = {}
      if (filters.types.length > 0) {
        backendFilters.types = filters.types
      }
      if (filters.days > 0) {
        const now = Math.floor(Date.now() / 1000)
        backendFilters.timeRange = { start: now - filters.days * 86400, end: now }
      }
      if (filters.contact) {
        backendFilters.contactId = filters.contact
      }

      const result = await window.electronAPI.contentHub.getItems(backendFilters)
      const items: ContentItem[] = (result || []).map((item: any) => ({
        id: item.id || String(item.timestamp),
        type: mapContentType(item.type),
        title: item.title || '无标题',
        source: item.source?.contactName || '',
        sourceType: item.source?.isGroup ? '群聊' : '私聊',
        groupName: item.source?.sessionName,
        timestamp: item.timestamp * 1000 || Date.now(),
        summary: item.description || '',
        url: item.url,
        starred: item.bookmarked,
        ignored: item.ignored,
      }))

      set({ items, isLoading: false })
    } catch (e) {
      console.error('Failed to load content:', e)
      set({ isLoading: false, error: '加载内容失败' })
    }
  },

  analyzeContent: async (id) => {
    set({ isAnalyzing: true, analysisResult: null, error: null })
    try {
      const result = await window.electronAPI.contentHub.analyzeContent(id)
      if (result) {
        set({
          isAnalyzing: false,
          analysisResult: `### AI 深度分析\n\n**摘要**: ${result.summary || ''}\n\n**分享动机**: ${result.motivation || ''}\n\n**相关性**: ${result.relevance || ''}\n\n**建议回应**: ${result.suggestedResponse || ''}`,
        })
      } else {
        set({ isAnalyzing: false, analysisResult: '分析暂无结果' })
      }
    } catch (e: any) {
      console.error('Content analysis failed:', e)
      const msg = e?.message || String(e)
      set({
        isAnalyzing: false,
        error: msg.includes('timeout') ? 'AI 响应超时，请重试'
          : msg.includes('key') || msg.includes('401') ? 'API Key 无效，请在设置中检查'
          : `AI 分析失败：${msg.slice(0, 80)}`,
      })
    }
  },

  selectItem: (item) => {
    set({ selectedItem: item, analysisResult: null })
  },

  toggleStarred: async (id) => {
    try {
      await window.electronAPI.contentHub.starItem(id)
      set(state => ({
        items: state.items.map(item =>
          item.id === id ? { ...item, starred: !item.starred } : item
        ),
      }))
    } catch (e: any) {
      set({ error: e?.message || '收藏操作失败' })
    }
  },

  toggleIgnored: async (id) => {
    try {
      await window.electronAPI.contentHub.ignoreItem(id)
      set(state => ({
        items: state.items.map(item =>
          item.id === id ? { ...item, ignored: !item.ignored } : item
        ),
      }))
    } catch (e: any) {
      set({ error: e?.message || '忽略操作失败' })
    }
  },
}))
