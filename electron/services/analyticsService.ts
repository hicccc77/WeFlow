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

    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders', 'placeholder_foldgroup',
      '@helper_folders', '@placeholder_foldgroup'
    ]

    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }

    if (username.includes('@kefu.openim') || username.includes('@openim')) return false
    if (username.includes('service_')) return false

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
    if (!sessionResult.success || !sessionResult.sessions) {
      console.log('[私聊分析] getSessions 失败:', sessionResult.error)
      return []
    }
    const rows = sessionResult.sessions as Record<string, any>[]
    console.log('[私聊分析] 总会话数:', rows.length)
    console.log('[私聊分析] cleanedWxid:', cleanedWxid)

    const usernames = rows.map((row) => row.username || row.user_name || row.userName || '')
    console.log('[私聊分析] 会话列表示例 (前10个):', usernames.slice(0, 10))

    const privateSessions = usernames.filter((username) => this.isPrivateSession(username, cleanedWxid))
    console.log('[私聊分析] 过滤后的私聊会话数:', privateSessions.length)
    console.log('[私聊分析] 私聊会话示例 (前10个):', privateSessions.slice(0, 10))

    return privateSessions
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
      let batchCount = 0
      while (hasMore) {
        const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        if (!batch.success || !batch.rows) break
        for (const row of batch.rows) {
          onRow(row)
        }
        hasMore = batch.hasMore === true

        // 每处理完一个批次，如果已经处理了较多数据，暂时让出执行权
        batchCount++
        if (batchCount % 10 === 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    } finally {
      await wcdbService.closeMessageCursor(cursorResult.cursor)
    }
  }

  private setProgress(window: any, status: string, progress: number) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('analytics:progress', { status, progress })
    }
  }

  async getOverallStatistics(): Promise<{ success: boolean; data?: ChatStatistics; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionIds = await this.getPrivateSessions(conn.cleanedWxid)
      console.log('[私聊分析] getPrivateSessions 返回会话数:', sessionIds.length)

      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const { BrowserWindow } = require('electron')
      const win = BrowserWindow.getAllWindows()[0]
      this.setProgress(win, '正在执行原生数据聚合...', 30)

      console.log('[私聊分析] 调用 getAggregateStats, sessionIds数量:', sessionIds.length)
      const result = await wcdbService.getAggregateStats(sessionIds, 0, 0)
      console.log('[私聊分析] getAggregateStats 返回:', {
        success: result.success,
        hasData: !!result.data,
        error: result.error,
        dataKeys: result.data ? Object.keys(result.data) : []
      })

      if (!result.success || !result.data) {
        console.error('[私聊分析] 聚合统计失败:', result.error)
        return { success: false, error: result.error || '聚合统计失败' }
      }

      this.setProgress(win, '同步分析结果...', 90)
      const d = result.data

      const textTypes = [1, 244813135921]
      let textMessages = 0
      for (const t of textTypes) textMessages += (d.typeCounts[t] || 0)
      const imageMessages = d.typeCounts[3] || 0
      const voiceMessages = d.typeCounts[34] || 0
      const videoMessages = d.typeCounts[43] || 0
      const emojiMessages = d.typeCounts[47] || 0
      const otherMessages = d.total - textMessages - imageMessages - voiceMessages - videoMessages - emojiMessages

      // 估算活跃天数（按月分布估算或从日期列表中提取，由于 C++ 只返回了月份映射，
      // 我们这里暂时返回月份数作为参考，或者如果需要精确天数，原生层需要返回 Set 大小）
      // 为了性能，我们先用月份数，或者后续再优化 C++ 返回 activeDays 计数。
      // 当前 C++ 逻辑中 gs.monthly.size() 就是活跃月份。
      const activeMonths = Object.keys(d.monthly).length

      return {
        success: true,
        data: {
          totalMessages: d.total,
          textMessages,
          imageMessages,
          voiceMessages,
          videoMessages,
          emojiMessages,
          otherMessages: Math.max(0, otherMessages),
          sentMessages: d.sent,
          receivedMessages: d.received,
          firstMessageTime: d.firstTime || null,
          lastMessageTime: d.lastTime || null,
          activeDays: activeMonths * 20, // 粗略估算，或改为返回活跃月份
          messageTypeCounts: d.typeCounts
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

      const result = await wcdbService.getAggregateStats(sessionIds, 0, 0)
      if (!result.success || !result.data) {
        return { success: false, error: result.error || '聚合统计失败' }
      }

      const d = result.data
      const usernames = Object.keys(d.sessions)
      const [displayNames, avatarUrls] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      const rankings: ContactRanking[] = usernames
        .map((username) => {
          const stat = d.sessions[username]
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
            messageCount: stat.total,
            sentCount: stat.sent,
            receivedCount: stat.received,
            lastMessageTime: stat.lastTime || null
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

      const result = await wcdbService.getAggregateStats(sessionIds, 0, 0)
      if (!result.success || !result.data) {
        return { success: false, error: result.error || '聚合统计失败' }
      }

      const d = result.data

      // SQLite strftime('%w') 返回 0=Sun, 1=Mon...6=Sat
      // 前端期望 1=Mon...7=Sun
      const weekdayDistribution: Record<number, number> = {}
      for (const [w, count] of Object.entries(d.weekday)) {
        const sqliteW = parseInt(w, 10)
        const jsW = sqliteW === 0 ? 7 : sqliteW
        weekdayDistribution[jsW] = count as number
      }

      // 补全 24 小时
      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) {
        hourlyDistribution[i] = d.hourly[i] || 0
      }

      return {
        success: true,
        data: {
          hourlyDistribution,
          weekdayDistribution,
          monthlyDistribution: d.monthly
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const analyticsService = new AnalyticsService()
