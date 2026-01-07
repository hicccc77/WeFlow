import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

export interface TopContact {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
}

export interface MonthlyTopFriend {
  month: number
  displayName: string
  avatarUrl?: string
  messageCount: number
}

export interface ChatPeakDay {
  date: string
  messageCount: number
  topFriend?: string
  topFriendCount?: number
}

export interface ActivityHeatmap {
  data: number[][]
}

export interface AnnualReportData {
  year: number
  totalMessages: number
  totalFriends: number
  coreFriends: TopContact[]
  monthlyTopFriends: MonthlyTopFriend[]
  peakDay: ChatPeakDay | null
  longestStreak: {
    friendName: string
    days: number
    startDate: string
    endDate: string
  } | null
  activityHeatmap: ActivityHeatmap
  midnightKing: {
    displayName: string
    count: number
    percentage: number
  } | null
  selfAvatarUrl?: string
  mutualFriend: {
    displayName: string
    avatarUrl?: string
    sentCount: number
    receivedCount: number
    ratio: number
  } | null
  socialInitiative: {
    initiatedChats: number
    receivedChats: number
    initiativeRate: number
  } | null
  responseSpeed: {
    avgResponseTime: number
    fastestFriend: string
    fastestTime: number
  } | null
  topPhrases: {
    phrase: string
    count: number
  }[]
}

class AnnualReportService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]
    return trimmed
  }

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; rawWxid?: string; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '未配置微信ID' }
    if (!dbPath) return { success: false, error: '未配置数据库路径' }
    if (!decryptKey) return { success: false, error: '未配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid, rawWxid: wxid }
  }

  private async getPrivateSessions(cleanedWxid: string): Promise<string[]> {
    const sessionResult = await wcdbService.getSessions()
    if (!sessionResult.success || !sessionResult.sessions) return []
    const rows = sessionResult.sessions as Record<string, any>[]
    return rows
      .map((row) => row.username || row.user_name || row.userName || '')
      .filter((username) =>
        username &&
        !username.includes('@chatroom') &&
        username !== 'filehelper' &&
        !username.startsWith('gh_') &&
        username.toLowerCase() !== cleanedWxid.toLowerCase()
      )
  }

  private async getEdgeMessageTime(sessionId: string, ascending: boolean): Promise<number | null> {
    const cursor = await wcdbService.openMessageCursor(sessionId, 1, ascending, 0, 0)
    if (!cursor.success || !cursor.cursor) return null
    try {
      const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
      if (!batch.success || !batch.rows || batch.rows.length === 0) return null
      const ts = parseInt(batch.rows[0].create_time || '0', 10)
      return ts > 0 ? ts : null
    } finally {
      await wcdbService.closeMessageCursor(cursor.cursor)
    }
  }

  private decodeMessageContent(messageContent: any, compressContent: any): string {
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      if (this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      if (this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch {
          return raw
        }
      }
      return raw
    }
    return ''
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    try {
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          const fzstd = require('fzstd')
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        }
      }
      const decoded = data.toString('utf-8')
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  async getAvailableYears(): Promise<{ success: boolean; data?: number[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionIds = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const years = new Set<number>()
      for (const sessionId of sessionIds) {
        const first = await this.getEdgeMessageTime(sessionId, true)
        const last = await this.getEdgeMessageTime(sessionId, false)
        if (!first && !last) continue

        const minYear = new Date((first || last || 0) * 1000).getFullYear()
        const maxYear = new Date((last || first || 0) * 1000).getFullYear()
        for (let y = minYear; y <= maxYear; y++) {
          if (y >= 2010 && y <= new Date().getFullYear()) years.add(y)
        }
      }

      const sortedYears = Array.from(years).sort((a, b) => b - a)
      return { success: true, data: sortedYears }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async generateReport(year: number): Promise<{ success: boolean; data?: AnnualReportData; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid || !conn.rawWxid) return { success: false, error: conn.error }

      const cleanedWxid = conn.cleanedWxid
      const rawWxid = conn.rawWxid
      const sessionIds = await this.getPrivateSessions(cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const startTime = Math.floor(new Date(year, 0, 1).getTime() / 1000)
      const endTime = Math.floor(new Date(year, 11, 31, 23, 59, 59).getTime() / 1000)

      let totalMessages = 0
      const contactStats = new Map<string, { sent: number; received: number }>()
      const monthlyStats = new Map<string, Map<number, number>>()
      const dailyStats = new Map<string, number>()
      const dailyContactStats = new Map<string, Map<string, number>>()
      const heatmapData: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
      const midnightStats = new Map<string, number>()

      const conversationStarts = new Map<string, { initiated: number; received: number }>()
      const responseTimeStats = new Map<string, number[]>()
      const phraseCount = new Map<string, number>()
      const lastMessageTime = new Map<string, { time: number; isSent: boolean }>()

      const CONVERSATION_GAP = 3600

      for (const sessionId of sessionIds) {
        const cursor = await wcdbService.openMessageCursor(sessionId, 500, true, startTime, endTime)
        if (!cursor.success || !cursor.cursor) continue

        try {
          let hasMore = true
          while (hasMore) {
            const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
            if (!batch.success || !batch.rows) break

            for (const row of batch.rows) {
              const createTime = parseInt(row.create_time || '0', 10)
              if (!createTime) continue

              totalMessages++

              const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
              const isSent = parseInt(isSendRaw, 10) === 1
              const localType = parseInt(row.local_type || row.type || '1', 10)
              const content = this.decodeMessageContent(row.message_content, row.compress_content)

              if (!contactStats.has(sessionId)) {
                contactStats.set(sessionId, { sent: 0, received: 0 })
              }
              const stats = contactStats.get(sessionId)!
              if (isSent) stats.sent++
              else stats.received++

              if (!conversationStarts.has(sessionId)) {
                conversationStarts.set(sessionId, { initiated: 0, received: 0 })
              }
              const convStats = conversationStarts.get(sessionId)!

              const lastMsg = lastMessageTime.get(sessionId)
              if (!lastMsg || (createTime - lastMsg.time) > CONVERSATION_GAP) {
                if (isSent) convStats.initiated++
                else convStats.received++
              } else if (lastMsg.isSent !== isSent) {
                if (isSent && !lastMsg.isSent) {
                  const responseTime = createTime - lastMsg.time
                  if (responseTime > 0 && responseTime < 86400) {
                    if (!responseTimeStats.has(sessionId)) {
                      responseTimeStats.set(sessionId, [])
                    }
                    responseTimeStats.get(sessionId)!.push(responseTime)
                  }
                }
              }
              lastMessageTime.set(sessionId, { time: createTime, isSent })

              if ((localType === 1 || localType === 244813135921) && isSent) {
                const text = String(content).trim()
                if (text.length >= 2 && text.length <= 20 &&
                    !text.includes('http') &&
                    !text.includes('<') &&
                    !text.startsWith('[') &&
                    !text.startsWith('<?xml')) {
                  phraseCount.set(text, (phraseCount.get(text) || 0) + 1)
                }
              }

              if (!monthlyStats.has(sessionId)) {
                monthlyStats.set(sessionId, new Map())
              }
              const month = new Date(createTime * 1000).getMonth() + 1
              const monthMap = monthlyStats.get(sessionId)!
              monthMap.set(month, (monthMap.get(month) || 0) + 1)

              const d = new Date(createTime * 1000)
              const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
              dailyStats.set(dayKey, (dailyStats.get(dayKey) || 0) + 1)

              if (!dailyContactStats.has(dayKey)) {
                dailyContactStats.set(dayKey, new Map())
              }
              const dayContactMap = dailyContactStats.get(dayKey)!
              dayContactMap.set(sessionId, (dayContactMap.get(sessionId) || 0) + 1)

              const weekdayIndex = (() => {
                const jsWeekday = d.getDay()
                return jsWeekday === 0 ? 6 : jsWeekday - 1
              })()
              heatmapData[weekdayIndex][d.getHours()]++

              const hour = d.getHours()
              if (hour >= 0 && hour < 6) {
                midnightStats.set(sessionId, (midnightStats.get(sessionId) || 0) + 1)
              }
            }

            hasMore = batch.hasMore === true
          }
        } finally {
          await wcdbService.closeMessageCursor(cursor.cursor)
        }
      }

      const contactIds = Array.from(contactStats.keys())
      const [displayNames, avatarUrls] = await Promise.all([
        wcdbService.getDisplayNames(contactIds),
        wcdbService.getAvatarUrls(contactIds)
      ])

      const contactInfoMap = new Map<string, { displayName: string; avatarUrl?: string }>()
      for (const sessionId of contactIds) {
        contactInfoMap.set(sessionId, {
          displayName: displayNames.success && displayNames.map ? (displayNames.map[sessionId] || sessionId) : sessionId,
          avatarUrl: avatarUrls.success && avatarUrls.map ? avatarUrls.map[sessionId] : undefined
        })
      }

      const selfAvatarResult = await wcdbService.getAvatarUrls([rawWxid, cleanedWxid])
      const selfAvatarUrl = selfAvatarResult.success && selfAvatarResult.map
        ? (selfAvatarResult.map[rawWxid] || selfAvatarResult.map[cleanedWxid])
        : undefined

      const coreFriends: TopContact[] = Array.from(contactStats.entries())
        .map(([sessionId, stats]) => {
          const info = contactInfoMap.get(sessionId)
          return {
            username: sessionId,
            displayName: info?.displayName || sessionId,
            avatarUrl: info?.avatarUrl,
            messageCount: stats.sent + stats.received,
            sentCount: stats.sent,
            receivedCount: stats.received
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, 3)

      const monthlyTopFriends: MonthlyTopFriend[] = []
      for (let month = 1; month <= 12; month++) {
        let maxCount = 0
        let topSessionId = ''
        for (const [sessionId, monthMap] of monthlyStats.entries()) {
          const count = monthMap.get(month) || 0
          if (count > maxCount) {
            maxCount = count
            topSessionId = sessionId
          }
        }
        const info = contactInfoMap.get(topSessionId)
        monthlyTopFriends.push({
          month,
          displayName: info?.displayName || (topSessionId ? topSessionId : '暂无'),
          avatarUrl: info?.avatarUrl,
          messageCount: maxCount
        })
      }

      let peakDay: ChatPeakDay | null = null
      let maxDayCount = 0
      for (const [day, count] of dailyStats.entries()) {
        if (count > maxDayCount) {
          maxDayCount = count
          const dayContactMap = dailyContactStats.get(day)
          let topFriend = ''
          let topFriendCount = 0
          if (dayContactMap) {
            for (const [sessionId, c] of dayContactMap.entries()) {
              if (c > topFriendCount) {
                topFriendCount = c
                topFriend = contactInfoMap.get(sessionId)?.displayName || sessionId
              }
            }
          }
          peakDay = { date: day, messageCount: count, topFriend, topFriendCount }
        }
      }

      let midnightKing: AnnualReportData['midnightKing'] = null
      const totalMidnight = Array.from(midnightStats.values()).reduce((a, b) => a + b, 0)
      if (totalMidnight > 0) {
        let maxMidnight = 0
        let midnightSessionId = ''
        for (const [sessionId, count] of midnightStats.entries()) {
          if (count > maxMidnight) {
            maxMidnight = count
            midnightSessionId = sessionId
          }
        }
        const info = contactInfoMap.get(midnightSessionId)
        midnightKing = {
          displayName: info?.displayName || midnightSessionId,
          count: maxMidnight,
          percentage: Math.round((maxMidnight / totalMidnight) * 1000) / 10
        }
      }

      let longestStreak: AnnualReportData['longestStreak'] = null
      for (const [sessionId, monthMap] of monthlyStats.entries()) {
        const totalCount = Array.from(monthMap.values()).reduce((a, b) => a + b, 0)
        if (totalCount > 100) {
          const info = contactInfoMap.get(sessionId)
          if (!longestStreak || totalCount > (longestStreak.days * 10)) {
            longestStreak = {
              friendName: info?.displayName || sessionId,
              days: Math.min(365, Math.floor(totalCount / 10)),
              startDate: `${year}-01-01`,
              endDate: `${year}-12-31`
            }
          }
        }
      }

      let mutualFriend: AnnualReportData['mutualFriend'] = null
      let bestRatioDiff = Infinity
      for (const [sessionId, stats] of contactStats.entries()) {
        if (stats.sent >= 50 && stats.received >= 50) {
          const ratio = stats.sent / stats.received
          const ratioDiff = Math.abs(ratio - 1)
          if (ratioDiff < bestRatioDiff) {
            bestRatioDiff = ratioDiff
            const info = contactInfoMap.get(sessionId)
            mutualFriend = {
              displayName: info?.displayName || sessionId,
              avatarUrl: info?.avatarUrl,
              sentCount: stats.sent,
              receivedCount: stats.received,
              ratio: Math.round(ratio * 100) / 100
            }
          }
        }
      }

      let socialInitiative: AnnualReportData['socialInitiative'] = null
      let totalInitiated = 0
      let totalReceived = 0
      for (const stats of conversationStarts.values()) {
        totalInitiated += stats.initiated
        totalReceived += stats.received
      }
      const totalConversations = totalInitiated + totalReceived
      if (totalConversations > 0) {
        socialInitiative = {
          initiatedChats: totalInitiated,
          receivedChats: totalReceived,
          initiativeRate: Math.round((totalInitiated / totalConversations) * 1000) / 10
        }
      }

      let responseSpeed: AnnualReportData['responseSpeed'] = null
      const allResponseTimes: number[] = []
      let fastestFriendId = ''
      let fastestAvgTime = Infinity
      for (const [sessionId, times] of responseTimeStats.entries()) {
        if (times.length >= 10) {
          allResponseTimes.push(...times)
          const avgTime = times.reduce((a, b) => a + b, 0) / times.length
          if (avgTime < fastestAvgTime) {
            fastestAvgTime = avgTime
            fastestFriendId = sessionId
          }
        }
      }
      if (allResponseTimes.length > 0) {
        const avgResponseTime = allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length
        const fastestInfo = contactInfoMap.get(fastestFriendId)
        responseSpeed = {
          avgResponseTime: Math.round(avgResponseTime),
          fastestFriend: fastestInfo?.displayName || fastestFriendId,
          fastestTime: Math.round(fastestAvgTime)
        }
      }

      const topPhrases = Array.from(phraseCount.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 32)
        .map(([phrase, count]) => ({ phrase, count }))

      const reportData: AnnualReportData = {
        year,
        totalMessages,
        totalFriends: contactStats.size,
        coreFriends,
        monthlyTopFriends,
        peakDay,
        longestStreak,
        activityHeatmap: { data: heatmapData },
        midnightKing,
        selfAvatarUrl,
        mutualFriend,
        socialInitiative,
        responseSpeed,
        topPhrases
      }

      return { success: true, data: reportData }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const annualReportService = new AnnualReportService()
