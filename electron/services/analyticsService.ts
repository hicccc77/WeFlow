import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

export interface ChatStatistics {
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

export interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  weekdayDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
}

export interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

class AnalyticsService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }
    return trimmed
  }

  private isPrivateSession(username: string, cleanedWxid: string): boolean {
    if (!username) return false
    if (username.toLowerCase() === cleanedWxid.toLowerCase()) return false
    if (username.includes('@chatroom')) return false
    if (username === 'filehelper') return false
    if (username.startsWith('gh_')) return false
    return true
  }

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '未配置微信ID' }
    if (!dbPath) return { success: false, error: '未配置数据库路径' }
    if (!decryptKey) return { success: false, error: '未配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid }
  }

  private async getPrivateSessions(cleanedWxid: string): Promise<string[]> {
    const sessionResult = await wcdbService.getSessions()
    if (!sessionResult.success || !sessionResult.sessions) return []
    const rows = sessionResult.sessions as Record<string, any>[]
    return rows
      .map((row) => row.username || row.user_name || row.userName || '')
      .filter((username) => this.isPrivateSession(username, cleanedWxid))
  }

  private async iterateSessionMessages(
    sessionId: string,
    onRow: (row: Record<string, any>) => void,
    beginTimestamp = 0,
    endTimestamp = 0
  ): Promise<void> {
    const cursorResult = await wcdbService.openMessageCursor(
      sessionId,
      500,
      true,
      beginTimestamp,
      endTimestamp
    )
    if (!cursorResult.success || !cursorResult.cursor) return

    try {
      let hasMore = true
      while (hasMore) {
        const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        if (!batch.success || !batch.rows) break
        for (const row of batch.rows) {
          onRow(row)
        }
        hasMore = batch.hasMore === true
      }
    } finally {
      await wcdbService.closeMessageCursor(cursorResult.cursor)
    }
  }

  async getOverallStatistics(): Promise<{ success: boolean; data?: ChatStatistics; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionIds = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      let totalMessages = 0
      let textMessages = 0
      let imageMessages = 0
      let voiceMessages = 0
      let videoMessages = 0
      let emojiMessages = 0
      let sentMessages = 0
      let receivedMessages = 0
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null
      const messageTypeCounts: Record<number, number> = {}
      const activeDays = new Set<string>()

      for (const sessionId of sessionIds) {
        await this.iterateSessionMessages(sessionId, (row) => {
          const createTime = parseInt(row.create_time || '0', 10)
          if (createTime > 0) {
            if (!firstMessageTime || createTime < firstMessageTime) {
              firstMessageTime = createTime
            }
            if (!lastMessageTime || createTime > lastMessageTime) {
              lastMessageTime = createTime
            }
            const d = new Date(createTime * 1000)
            const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            activeDays.add(dayKey)
          }

          const localType = parseInt(row.local_type || row.type || '1', 10)
          messageTypeCounts[localType] = (messageTypeCounts[localType] || 0) + 1

          totalMessages++
          if (localType === 1 || localType === 244813135921) textMessages++
          else if (localType === 3) imageMessages++
          else if (localType === 34) voiceMessages++
          else if (localType === 43) videoMessages++
          else if (localType === 47) emojiMessages++

          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10)
          if (isSend === 1) sentMessages++
          else receivedMessages++
        })
      }

      const otherMessages = totalMessages - textMessages - imageMessages - voiceMessages - videoMessages - emojiMessages

      return {
        success: true,
        data: {
          totalMessages,
          textMessages,
          imageMessages,
          voiceMessages,
          videoMessages,
          emojiMessages,
          otherMessages: Math.max(0, otherMessages),
          sentMessages,
          receivedMessages,
          firstMessageTime,
          lastMessageTime,
          activeDays: activeDays.size,
          messageTypeCounts
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContactRankings(limit: number = 20): Promise<{ success: boolean; data?: ContactRanking[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionIds = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const stats = new Map<string, { sent: number; received: number; lastTime: number | null }>()

      for (const sessionId of sessionIds) {
        let sent = 0
        let received = 0
        let lastTime: number | null = null

        await this.iterateSessionMessages(sessionId, (row) => {
          const createTime = parseInt(row.create_time || '0', 10)
          if (!lastTime || createTime > lastTime) lastTime = createTime

          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10)
          if (isSend === 1) sent++
          else received++
        })

        stats.set(sessionId, { sent, received, lastTime })
      }

      const usernames = Array.from(stats.keys())
      const [displayNames, avatarUrls] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      const rankings: ContactRanking[] = usernames
        .map((username) => {
          const stat = stats.get(username)!
          const displayName = displayNames.success && displayNames.map
            ? (displayNames.map[username] || username)
            : username
          const avatarUrl = avatarUrls.success && avatarUrls.map
            ? avatarUrls.map[username]
            : undefined
          return {
            username,
            displayName,
            avatarUrl,
            messageCount: stat.sent + stat.received,
            sentCount: stat.sent,
            receivedCount: stat.received,
            lastMessageTime: stat.lastTime
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getTimeDistribution(): Promise<{ success: boolean; data?: TimeDistribution; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionIds = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const hourlyDistribution: Record<number, number> = {}
      const weekdayDistribution: Record<number, number> = {}
      const monthlyDistribution: Record<string, number> = {}

      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0
      for (let i = 1; i <= 7; i++) weekdayDistribution[i] = 0

      for (const sessionId of sessionIds) {
        await this.iterateSessionMessages(sessionId, (row) => {
          const createTime = parseInt(row.create_time || '0', 10)
          if (!createTime) return

          const d = new Date(createTime * 1000)
          const hour = d.getHours()
          const jsWeekday = d.getDay() // 0=Sun
          const weekday = ((jsWeekday + 6) % 7) + 1 // 1=Mon ... 7=Sun
          const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

          hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1
          weekdayDistribution[weekday] = (weekdayDistribution[weekday] || 0) + 1
          monthlyDistribution[monthKey] = (monthlyDistribution[monthKey] || 0) + 1
        })
      }

      return { success: true, data: { hourlyDistribution, weekdayDistribution, monthlyDistribution } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const analyticsService = new AnalyticsService()
