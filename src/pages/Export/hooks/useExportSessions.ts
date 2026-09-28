/**
 * ExportV2 — useExportSessions hook
 *
 * Handles fetching chat sessions from the database and merging them with contact data.
 * Also provides client-side filtering (by tab/kind, search query) and sorting.
 */

import { useState, useCallback, useMemo, useRef } from 'react'
import type { ChatSession, ContactInfo } from '../../../types/models'
import type { SessionRow, ConversationTab, ContactsSortConfig } from '../types'
import { toSessionRowsWithContacts } from '../utils/session'

export interface ExportSessionsResult {
  rawSessions: ChatSession[]
  sessions: SessionRow[] // Unfiltered, merged with contacts
  filteredSessions: SessionRow[] // Filtered & sorted
  isLoading: boolean
  error: string | null
  searchQuery: string
  activeTab: ConversationTab
  sortConfig: ContactsSortConfig
  setSearchQuery: (query: string) => void
  setActiveTab: (tab: ConversationTab) => void
  setSortConfig: (config: ContactsSortConfig) => void
  loadSessions: () => Promise<void>
  abort: () => void
}

export function useExportSessions(
  contactMap: Record<string, ContactInfo>,
  initialTab: ConversationTab = 'private',
  metricsMap?: Record<string, any>
): ExportSessionsResult {
  const [rawSessions, setRawSessions] = useState<ChatSession[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ConversationTab>(initialTab)
  const [sortConfig, setSortConfig] = useState<ContactsSortConfig>({ key: 'messageCount', order: 'desc' })

  const abortControllerRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const loadSessions = useCallback(async () => {
    abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const signal = controller.signal

    setIsLoading(true)
    setError(null)

    try {
      // Connect first to ensure DB is ready, just like old ExportPage did
      const connectResult = await window.electronAPI.chat.connect()
      if (signal.aborted) return
      
      if (!connectResult?.success) {
        throw new Error(connectResult?.error || '无法连接到数据库')
      }

      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (signal.aborted) return

      if (sessionsResult?.success && sessionsResult.sessions) {
        setRawSessions(sessionsResult.sessions)
      } else {
        throw new Error(sessionsResult?.error || '获取会话列表失败')
      }
    } catch (err: any) {
      if (!signal.aborted) {
        console.error('[useExportSessions] Error loading sessions:', err)
        setError(err.message || '加载会话失败')
      }
    } finally {
      if (!signal.aborted) {
        setIsLoading(false)
      }
    }
  }, [abort])

  // Merge raw sessions with contacts
  const sessions = useMemo(() => {
    return toSessionRowsWithContacts(rawSessions, contactMap)
  }, [rawSessions, contactMap])

  // Filter and sort
  const filteredSessions = useMemo(() => {
    let result = sessions.filter((s) => s.kind === activeTab)

    const query = searchQuery.trim().toLowerCase()
    if (query) {
      result = result.filter((s) => {
        const nameMatch = (s.displayName || s.accountAlias || '').toLowerCase().includes(query)
        const accountIdMatch = (s.accountAlias || '').toLowerCase().includes(query)
        const aliasMatch = (contactMap[s.accountAlias || '']?.alias || '').toLowerCase().includes(query)
        const remarkMatch = (contactMap[s.accountAlias || '']?.remark || '').toLowerCase().includes(query)
        return nameMatch || accountIdMatch || aliasMatch || remarkMatch
      })
    }

    if (sortConfig.key) {
      result.sort((a, b) => {
        let valA = 0
        let valB = 0
        if (sortConfig.key === 'messageCount') {
          // Temporarily use unreadCount or 0 if we don't have messageCount yet.
          // In the real app, we need to load messageCounts asynchronously.
          valA = metricsMap?.[a.username]?.totalMessages ?? a.messageCountHint ?? a.unreadCount ?? 0
          valB = metricsMap?.[b.username]?.totalMessages ?? b.messageCountHint ?? b.unreadCount ?? 0
        } else if (sortConfig.key === 'latestMessageTime') {
          valA = a.sortTimestamp || a.lastTimestamp || 0
          valB = b.sortTimestamp || b.lastTimestamp || 0
        }
        
        if (valA === valB) return 0
        const diff = valA - valB
        return sortConfig.order === 'asc' ? diff : -diff
      })
    }

    return result
  }, [sessions, activeTab, searchQuery, sortConfig, contactMap, metricsMap])

  return {
    rawSessions,
    sessions,
    filteredSessions,
    isLoading,
    error,
    searchQuery,
    activeTab,
    sortConfig,
    setSearchQuery,
    setActiveTab,
    setSortConfig,
    loadSessions,
    abort
  }
}
