import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ChatStatistics {
  totalMessages: number
  textMessages: number
  imageMessages: number
  voiceMessages: number
  videoMessages: number
  emojiMessages: number
  otherMessages: number
  sentMessages: number
  receivedMessages: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  activeDays: number
  messageTypeCounts: Record<number, number>
}

interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
}

interface SelfSentDailyDistribution {
  unit: 'day'
  dailyDistribution: Record<string, number>
  totalMessages: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  beginTimestamp: number
  endTimestamp: number
}

interface AnalyticsState {
  // 数据
  statistics: ChatStatistics | null
  rankings: ContactRanking[]
  timeDistribution: TimeDistribution | null
  selfSentDailyDistribution: SelfSentDailyDistribution | null

  // 状态
  isLoaded: boolean
  lastLoadTime: number | null

  // Actions
  setStatistics: (data: ChatStatistics) => void
  setRankings: (data: ContactRanking[]) => void
  setTimeDistribution: (data: TimeDistribution) => void
  setSelfSentDailyDistribution: (data: SelfSentDailyDistribution) => void
  markLoaded: () => void
  clearCache: () => void
}

export const useAnalyticsStore = create<AnalyticsState>()(
  persist(
    (set) => ({
      statistics: null,
      rankings: [],
      timeDistribution: null,
      selfSentDailyDistribution: null,
      isLoaded: false,
      lastLoadTime: null,

      setStatistics: (data) => set({ statistics: data }),
      setRankings: (data) => set({ rankings: data }),
      setTimeDistribution: (data) => set({ timeDistribution: data }),
      setSelfSentDailyDistribution: (data) => set({ selfSentDailyDistribution: data }),
      markLoaded: () => set({ isLoaded: true, lastLoadTime: Date.now() }),
      clearCache: () => set({
        statistics: null,
        rankings: [],
        timeDistribution: null,
        selfSentDailyDistribution: null,
        isLoaded: false,
        lastLoadTime: null
      }),
    }),
    {
      name: 'analytics-storage',
    }
  )
)
