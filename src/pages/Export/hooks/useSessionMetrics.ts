/**
 * ExportV2 — useSessionMetrics hook
 *
 * Fetches and caches session content metrics (total messages, voice, image, video, etc.)
 * from the backend SQLite database.
 */

import { create } from 'zustand'

export interface SessionContentMetric {
  totalMessages?: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  fileMessages?: number
  systemMessages?: number
  appMessages?: number
}

interface SessionMetricsState {
  metricsMap: Record<string, SessionContentMetric>
  isLoading: boolean
  error: Error | null
  loadingRefs: Set<string>
  fetchMetrics: (sessionIds: string[]) => Promise<void>
}

export const useSessionMetrics = create<SessionMetricsState>((set, get) => ({
  metricsMap: {},
  isLoading: false,
  error: null,
  loadingRefs: new Set(),
  fetchMetrics: async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return

    const { metricsMap, loadingRefs } = get()
    const missingIds = sessionIds.filter(id => !metricsMap[id] && !loadingRefs.has(id))
    if (missingIds.length === 0) return

    set({ isLoading: true, error: null })
    
    const newLoadingRefs = new Set(loadingRefs)
    missingIds.forEach(id => newLoadingRefs.add(id))
    set({ loadingRefs: newLoadingRefs })

    try {
      const stats = await window.electronAPI.chat.getExportSessionStats(missingIds, { includeRelations: false })
      
      const newMetrics: Record<string, SessionContentMetric> = {}
      if (stats.success && stats.data) {
        for (const [sessionId, sessionStat] of Object.entries(stats.data)) {
          newMetrics[sessionId] = {
            totalMessages: sessionStat.totalMessages,
            voiceMessages: sessionStat.voiceMessages,
            imageMessages: sessionStat.imageMessages, 
            videoMessages: sessionStat.videoMessages,
            emojiMessages: sessionStat.emojiMessages,
            fileMessages: sessionStat.fileMessages ?? 0  // 文件消息数量，由后端 ExportSessionStats 返回
          }
        }
      }

      set(state => ({ 
        metricsMap: { ...state.metricsMap, ...newMetrics }
      }))
    } catch (err) {
      console.error('Failed to fetch session metrics:', err)
      set({ error: err instanceof Error ? err : new Error(String(err)) })
    } finally {
      set(state => {
        const nextLoadingRefs = new Set(state.loadingRefs)
        missingIds.forEach(id => nextLoadingRefs.delete(id))
        return { loadingRefs: nextLoadingRefs, isLoading: false }
      })
    }
  }
}))
