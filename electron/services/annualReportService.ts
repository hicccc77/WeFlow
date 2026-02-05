import { parentPort } from 'worker_threads'
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
  snsStats?: {
    totalPosts: number
    typeCounts?: Record<string, number>
    topLikers: { username: string; displayName: string; avatarUrl?: string; count: number }[]
    topLiked: { username: string; displayName: string; avatarUrl?: string; count: number }[]
  }
  lostFriend: {
    username: string
    displayName: string
    avatarUrl?: string
    earlyCount: number
    lateCount: number
    periodDesc: string
  } | null
}

class AnnualReportService {
  constructor() {
  }

  private broadcastProgress(status: string, progress: number) {
    if (parentPort) {
      parentPort.postMessage({
        type: 'annualReport:progress',
        data: { status, progress }
      })
    }
  }

  private reportProgress(status: string, progress: number, onProgress?: (status: string, progress: number) => void) {
    if (onProgress) {
      onProgress(status, progress)
      return
    }
    this.broadcastProgress(status, progress)
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
    const cleaned = suffixMatch ? suffixMatch[1] : trimmed
    
    return cleaned
  }

  private async ensureConnectedWithConfig(
    dbPath: string,
    decryptKey: string,
    wxid: string
  ): Promise<{ success: boolean; cleanedWxid?: string; rawWxid?: string; error?: string }> {
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

    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders', 'placeholder_foldgroup',
      '@helper_folders', '@placeholder_foldgroup'
    ]

    return rows
      .map((row) => row.username || row.user_name || row.userName || '')
      .filter((username) => {
        if (!username) return false
        if (username.includes('@chatroom')) return false
        if (username === 'filehelper') return false
        if (username.startsWith('gh_')) return false
        if (username.toLowerCase() === cleanedWxid.toLowerCase()) return false

        for (const prefix of excludeList) {
          if (username.startsWith(prefix) || username === prefix) return false
        }

        if (username.includes('@kefu.openim') || username.includes('@openim')) return false
        if (username.includes('service_')) return false

        return true
      })
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
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
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

  private formatDateYmd(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  private async computeLongestStreak(
    sessionIds: string[],
    beginTimestamp: number,
    endTimestamp: number,
    onProgress?: (status: string, progress: number) => void,
    progressStart: number = 0,
    progressEnd: number = 0
  ): Promise<{ sessionId: string; days: number; start: Date | null; end: Date | null }> {
    let bestSessionId = ''
    let bestDays = 0
    let bestStart: Date | null = null
    let bestEnd: Date | null = null
    let lastProgressAt = 0
    let lastProgressSent = progressStart

    const shouldReportProgress = onProgress && progressEnd > progressStart && sessionIds.length > 0
    let apiTimeMs = 0
    let jsTimeMs = 0

    for (let i = 0; i < sessionIds.length; i++) {
      const sessionId = sessionIds[i]
      const openStart = Date.now()
      const cursor = await wcdbService.openMessageCursorLite(sessionId, 2000, true, beginTimestamp, endTimestamp)
      apiTimeMs += Date.now() - openStart
      if (!cursor.success || !cursor.cursor) continue

      let lastDayIndex: number | null = null
      let currentStreak = 0
      let currentStart: Date | null = null
      let maxStreak = 0
      let maxStart: Date | null = null
      let maxEnd: Date | null = null

      try {
        let hasMore = true
        while (hasMore) {
          const fetchStart = Date.now()
          const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
          apiTimeMs += Date.now() - fetchStart
          if (!batch.success || !batch.rows) break

          const processStart = Date.now()
          for (const row of batch.rows) {
            const createTime = parseInt(row.create_time || '0', 10)
            if (!createTime) continue

            const dt = new Date(createTime * 1000)
            const dayDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
            const dayIndex = Math.floor(dayDate.getTime() / 86400000)

            if (lastDayIndex !== null && dayIndex === lastDayIndex) continue

            if (lastDayIndex !== null && dayIndex - lastDayIndex === 1) {
              currentStreak++
            } else {
              currentStreak = 1
              currentStart = dayDate
            }

            if (currentStreak > maxStreak) {
              maxStreak = currentStreak
              maxStart = currentStart
              maxEnd = dayDate
            }

            lastDayIndex = dayIndex
          }
          jsTimeMs += Date.now() - processStart

          hasMore = batch.hasMore === true
          await new Promise(resolve => setImmediate(resolve))
        }
      } finally {
        const closeStart = Date.now()
        await wcdbService.closeMessageCursor(cursor.cursor)
        apiTimeMs += Date.now() - closeStart
      }

      if (maxStreak > bestDays) {
        bestDays = maxStreak
        bestSessionId = sessionId
        bestStart = maxStart
        bestEnd = maxEnd
      }

      if (shouldReportProgress) {
        const now = Date.now()
        if (now - lastProgressAt > 250) {
          const ratio = Math.min(1, (i + 1) / sessionIds.length)
          const progress = Math.floor(progressStart + ratio * (progressEnd - progressStart))
          if (progress > lastProgressSent) {
            lastProgressSent = progress
            lastProgressAt = now
            const label = `${i + 1}/${sessionIds.length}`
            const timing = (apiTimeMs > 0 || jsTimeMs > 0)
              ? `, DB ${(apiTimeMs / 1000).toFixed(1)}s / JS ${(jsTimeMs / 1000).toFixed(1)}s`
              : ''
            onProgress?.(`计算连续聊天... (${label}${timing})`, progress)
          }
        }
      }
    }

    return { sessionId: bestSessionId, days: bestDays, start: bestStart, end: bestEnd }
  }

  async getAvailableYears(params: { dbPath: string; decryptKey: string; wxid: string }): Promise<{ success: boolean; data?: number[]; error?: string }> {
    try {
      const conn = await this.ensureConnectedWithConfig(params.dbPath, params.decryptKey, params.wxid)
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionIds = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const fastYears = await wcdbService.getAvailableYears(sessionIds)
      if (fastYears.success && fastYears.data) {
        return { success: true, data: fastYears.data }
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

  async generateReportWithConfig(params: {
    year: number
    wxid: string
    dbPath: string
    decryptKey: string
    onProgress?: (status: string, progress: number) => void
  }): Promise<{ success: boolean; data?: AnnualReportData; error?: string }> {
    try {
      const { year, wxid, dbPath, decryptKey, onProgress } = params
      this.reportProgress('正在连接数据库...', 5, onProgress)
      const conn = await this.ensureConnectedWithConfig(dbPath, decryptKey, wxid)
      if (!conn.success || !conn.cleanedWxid || !conn.rawWxid) return { success: false, error: conn.error }

      const cleanedWxid = conn.cleanedWxid
      const rawWxid = conn.rawWxid
      const sessionIds = await this.getPrivateSessions(cleanedWxid)
      if (sessionIds.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      this.reportProgress('加载会话列表...', 15, onProgress)

      const isAllTime = year <= 0
      const reportYear = isAllTime ? 0 : year
      const startTime = isAllTime ? 0 : Math.floor(new Date(year, 0, 1).getTime() / 1000)
      const endTime = isAllTime ? 0 : Math.floor(new Date(year, 11, 31, 23, 59, 59).getTime() / 1000)

      const now = new Date()
      // 全局统计始终使用自然年范围 (Jan 1st - Now/YearEnd)
      const actualStartTime = startTime
      const actualEndTime = endTime

      let totalMessages = 0
      const contactStats = new Map<string, { sent: number; received: number }>()
      const monthlyStats = new Map<string, Map<number, number>>()
      const dailyStats = new Map<string, number>()
      const dailyContactStats = new Map<string, Map<string, number>>()
      const heatmapData: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
      const midnightStats = new Map<string, number>()
      let longestStreakSessionId = ''
      let longestStreakDays = 0
      let longestStreakStart: Date | null = null
      let longestStreakEnd: Date | null = null

      const conversationStarts = new Map<string, { initiated: number; received: number }>()
      const responseTimeStats = new Map<string, number[]>()
      const phraseCount = new Map<string, number>()
      const lastMessageTime = new Map<string, { time: number; isSent: boolean }>()

      const CONVERSATION_GAP = 3600

      this.reportProgress('统计会话消息...', 20, onProgress)
      const result = await wcdbService.getAnnualReportStats(sessionIds, actualStartTime, actualEndTime)
      if (!result.success || !result.data) {
        return { success: false, error: result.error ? `基础统计失败: ${result.error}` : '基础统计失败' }
      }

      const d = result.data
      totalMessages = d.total
      this.reportProgress('汇总基础统计...', 25, onProgress)

      const totalMessagesForProgress = totalMessages > 0 ? totalMessages : sessionIds.length
      let processedMessages = 0
      let lastProgressSent = 0
      let lastProgressAt = 0

      // 填充基础统计
      for (const [sid, stat] of Object.entries(d.sessions)) {
        const s = stat as any
        contactStats.set(sid, { sent: s.sent, received: s.received })

        const mMap = new Map<number, number>()
        for (const [m, c] of Object.entries(s.monthly || {})) {
          mMap.set(parseInt(m, 10), c as number)
        }
        monthlyStats.set(sid, mMap)
      }

      // 填充全局分布，并锁定峰值日期以减少逐日消息统计
      let peakDayKey = ''
      let peakDayCount = 0
      for (const [day, count] of Object.entries(d.daily)) {
        const c = count as number
        dailyStats.set(day, c)
        if (c > peakDayCount) {
          peakDayCount = c
          peakDayKey = day
        }
      }

      let useSqlExtras = false
      let responseStatsFromSql: Record<string, { avg?: number; fastest?: number; count?: number }> | null = null
      let topPhrasesFromSql: { phrase: string; count: number }[] | null = null
      let streakComputedInLoop = false

      let peakDayBegin = 0
      let peakDayEnd = 0
      if (peakDayKey) {
        const start = new Date(`${peakDayKey}T00:00:00`).getTime()
        if (!Number.isNaN(start)) {
          peakDayBegin = Math.floor(start / 1000)
          peakDayEnd = peakDayBegin + 24 * 3600 - 1
        }
      }

      this.reportProgress('加载扩展统计... (初始化)', 30, onProgress)
      const extras = await wcdbService.getAnnualReportExtras(sessionIds, actualStartTime, actualEndTime, peakDayBegin, peakDayEnd)
      if (extras.success && extras.data) {
        this.reportProgress('加载扩展统计... (解析热力图)', 32, onProgress)
        const extrasData = extras.data as any
        const heatmap = extrasData.heatmap as number[][] | undefined
        if (Array.isArray(heatmap) && heatmap.length === 7) {
          for (let w = 0; w < 7; w++) {
            if (Array.isArray(heatmap[w])) {
              for (let h = 0; h < 24; h++) {
                heatmapData[w][h] = heatmap[w][h] || 0
              }
            }
          }
        }

        this.reportProgress('加载扩展统计... (解析夜聊统计)', 33, onProgress)
        const midnight = extrasData.midnight as Record<string, number> | undefined
        if (midnight) {
          for (const [sid, count] of Object.entries(midnight)) {
            midnightStats.set(sid, count as number)
          }
        }

        this.reportProgress('加载扩展统计... (解析对话发起)', 34, onProgress)
        const conversation = extrasData.conversation as Record<string, { initiated: number; received: number }> | undefined
        if (conversation) {
          for (const [sid, stats] of Object.entries(conversation)) {
            conversationStarts.set(sid, { initiated: stats.initiated || 0, received: stats.received || 0 })
          }
        }

        this.reportProgress('加载扩展统计... (解析响应速度)', 35, onProgress)
        responseStatsFromSql = extrasData.response || null

        this.reportProgress('加载扩展统计... (解析峰值日)', 36, onProgress)
        const peakDayCounts = extrasData.peakDay as Record<string, number> | undefined
        if (peakDayKey && peakDayCounts) {
          const dayMap = new Map<string, number>()
          for (const [sid, count] of Object.entries(peakDayCounts)) {
            dayMap.set(sid, count as number)
          }
          if (dayMap.size > 0) {
            dailyContactStats.set(peakDayKey, dayMap)
          }
        }

        this.reportProgress('加载扩展统计... (解析常用语)', 37, onProgress)
        const sqlPhrases = extrasData.topPhrases as { phrase: string; count: number }[] | undefined
        if (Array.isArray(sqlPhrases) && sqlPhrases.length > 0) {
          topPhrasesFromSql = sqlPhrases
        }

        const streak = extrasData.streak as { sessionId?: string; days?: number; startDate?: string; endDate?: string } | undefined
        if (streak && streak.sessionId && streak.days && streak.days > 0) {
          longestStreakSessionId = streak.sessionId
          longestStreakDays = streak.days
          longestStreakStart = streak.startDate ? new Date(`${streak.startDate}T00:00:00`) : null
          longestStreakEnd = streak.endDate ? new Date(`${streak.endDate}T00:00:00`) : null
          if (longestStreakStart && !Number.isNaN(longestStreakStart.getTime()) &&
            longestStreakEnd && !Number.isNaN(longestStreakEnd.getTime())) {
            streakComputedInLoop = true
          }
        }

        useSqlExtras = true
        this.reportProgress('加载扩展统计... (完成)', 40, onProgress)
      } else if (!extras.success) {
        const reason = extras.error ? ` (${extras.error})` : ''
        this.reportProgress(`扩展统计失败，转入完整分析...${reason}`, 30, onProgress)
      }

      if (!useSqlExtras) {
        // 注意：原生层目前未返回交叉维度 heatmapData[weekday][hour]，
        // 这里的 heatmapData 仍然需要通过下面的遍历来精确填充。

        // 考虑到 Annual Report 需要一些复杂的序列特征（响应速度、对话发起）和文本特征（常用语），
        // 我们仍然保留一次轻量级循环，但因为有了原生统计，我们可以分步进行，或者如果数据量极大则跳过某些步骤。
        // 为保持功能完整，我们进行深度集成的轻量遍历：
        for (let i = 0; i < sessionIds.length; i++) {
          const sessionId = sessionIds[i]
          const cursor = await wcdbService.openMessageCursorLite(sessionId, 1000, true, actualStartTime, actualEndTime)
          if (!cursor.success || !cursor.cursor) continue

          let lastDayIndex: number | null = null
          let currentStreak = 0
          let currentStart: Date | null = null
          let maxStreak = 0
          let maxStart: Date | null = null
          let maxEnd: Date | null = null

          try {
            let hasMore = true
            while (hasMore) {
              const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
              if (!batch.success || !batch.rows) break

              for (const row of batch.rows) {
                const createTime = parseInt(row.create_time || '0', 10)
                if (!createTime) continue

                const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
                let isSent = parseInt(isSendRaw, 10) === 1
                const localType = parseInt(row.local_type || row.type || '1', 10)

                // 兼容逻辑
                if (isSendRaw === undefined || isSendRaw === null || isSendRaw === '0') {
                  const sender = String(row.sender_username || row.sender || row.talker || '').toLowerCase()
                  if (sender) {
                    const rawLower = rawWxid.toLowerCase()
                    const cleanedLower = cleanedWxid.toLowerCase()
                    if (sender === rawLower || sender === cleanedLower ||
                      rawLower.startsWith(sender + '_') || cleanedLower.startsWith(sender + '_')) {
                      isSent = true
                    }
                  }
                }

                // 响应速度 & 对话发起
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
                      if (!responseTimeStats.has(sessionId)) responseTimeStats.set(sessionId, [])
                      responseTimeStats.get(sessionId)!.push(responseTime)
                    }
                  }
                }
                lastMessageTime.set(sessionId, { time: createTime, isSent })

                // 常用语
                if ((localType === 1 || localType === 244813135921) && isSent) {
                  const content = this.decodeMessageContent(row.message_content, row.compress_content)
                  const text = String(content).trim()
                  if (text.length >= 2 && text.length <= 20 &&
                    !text.includes('http') && !text.includes('<') &&
                    !text.startsWith('[') && !text.startsWith('<?xml')) {
                    phraseCount.set(text, (phraseCount.get(text) || 0) + 1)
                  }
                }

                // 交叉维度补全
                const dt = new Date(createTime * 1000)
                const weekdayIndex = dt.getDay() === 0 ? 6 : dt.getDay() - 1
                heatmapData[weekdayIndex][dt.getHours()]++

                const dayDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
                const dayIndex = Math.floor(dayDate.getTime() / 86400000)
                if (lastDayIndex === null || dayIndex !== lastDayIndex) {
                  if (lastDayIndex !== null && dayIndex - lastDayIndex === 1) {
                    currentStreak++
                  } else {
                    currentStreak = 1
                    currentStart = dayDate
                  }
                  if (currentStreak > maxStreak) {
                    maxStreak = currentStreak
                    maxStart = currentStart
                    maxEnd = dayDate
                  }
                  lastDayIndex = dayIndex
                }

                if (dt.getHours() >= 0 && dt.getHours() < 6) {
                  midnightStats.set(sessionId, (midnightStats.get(sessionId) || 0) + 1)
                }

                if (peakDayKey) {
                  const dayKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
                  if (dayKey === peakDayKey) {
                    if (!dailyContactStats.has(dayKey)) dailyContactStats.set(dayKey, new Map())
                    const dayContactMap = dailyContactStats.get(dayKey)!
                    dayContactMap.set(sessionId, (dayContactMap.get(sessionId) || 0) + 1)
                  }
                }

                if (totalMessagesForProgress > 0) {
                  processedMessages++
                }
              }
              hasMore = batch.hasMore === true

              const now = Date.now()
              if (now - lastProgressAt > 200) {
                let progress = 30
                if (totalMessagesForProgress > 0) {
                  const ratio = Math.min(1, processedMessages / totalMessagesForProgress)
                  progress = 30 + Math.floor(ratio * 50)
                } else {
                  const ratio = Math.min(1, (i + 1) / sessionIds.length)
                  progress = 30 + Math.floor(ratio * 50)
                }
                if (progress > lastProgressSent) {
                  lastProgressSent = progress
                  lastProgressAt = now
                  let label = `${i + 1}/${sessionIds.length}`
                  if (totalMessagesForProgress > 0) {
                    const done = Math.min(processedMessages, totalMessagesForProgress)
                    label = `${done}/${totalMessagesForProgress}`
                  }
                  this.reportProgress(`分析聊天记录... (${label})`, progress, onProgress)
                }
              }
              await new Promise(resolve => setImmediate(resolve))
            }
          } finally {
            await wcdbService.closeMessageCursor(cursor.cursor)
          }

          if (maxStreak > longestStreakDays) {
            longestStreakDays = maxStreak
            longestStreakSessionId = sessionId
            longestStreakStart = maxStart
            longestStreakEnd = maxEnd
          }
        }
        streakComputedInLoop = true
      }

      if (!streakComputedInLoop) {
        this.reportProgress('计算连续聊天...', 45, onProgress)
        const streakResult = await this.computeLongestStreak(sessionIds, actualStartTime, actualEndTime, onProgress, 45, 75)
        if (streakResult.days > longestStreakDays) {
          longestStreakDays = streakResult.days
          longestStreakSessionId = streakResult.sessionId
          longestStreakStart = streakResult.start
          longestStreakEnd = streakResult.end
        }
      }

      // 获取朋友圈统计
      this.reportProgress('分析朋友圈数据...', 75, onProgress)
      let snsStatsResult: {
        totalPosts: number
        typeCounts?: Record<string, number>
        topLikers: { username: string; displayName: string; avatarUrl?: string; count: number }[]
        topLiked: { username: string; displayName: string; avatarUrl?: string; count: number }[]
      } | undefined

      const snsStats = await wcdbService.getSnsAnnualStats(actualStartTime, actualEndTime)

      if (snsStats.success && snsStats.data) {
        const d = snsStats.data
        const usersToFetch = new Set<string>()
        d.topLikers?.forEach((u: any) => usersToFetch.add(u.username))
        d.topLiked?.forEach((u: any) => usersToFetch.add(u.username))

        const snsUserIds = Array.from(usersToFetch)
        const [snsDisplayNames, snsAvatarUrls] = await Promise.all([
          wcdbService.getDisplayNames(snsUserIds),
          wcdbService.getAvatarUrls(snsUserIds)
        ])

        const getSnsUserInfo = (username: string) => ({
          displayName: snsDisplayNames.success && snsDisplayNames.map ? (snsDisplayNames.map[username] || username) : username,
          avatarUrl: snsAvatarUrls.success && snsAvatarUrls.map ? snsAvatarUrls.map[username] : undefined
        })

        snsStatsResult = {
          totalPosts: d.totalPosts || 0,
          typeCounts: d.typeCounts,
          topLikers: (d.topLikers || []).map((u: any) => ({ ...u, ...getSnsUserInfo(u.username) })),
          topLiked: (d.topLiked || []).map((u: any) => ({ ...u, ...getSnsUserInfo(u.username) }))
        }
      }

      this.reportProgress('整理联系人信息...', 85, onProgress)

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
      if (longestStreakSessionId && longestStreakDays > 0 && longestStreakStart && longestStreakEnd) {
        const info = contactInfoMap.get(longestStreakSessionId)
        longestStreak = {
          friendName: info?.displayName || longestStreakSessionId,
          days: longestStreakDays,
          startDate: this.formatDateYmd(longestStreakStart),
          endDate: this.formatDateYmd(longestStreakEnd)
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

      this.reportProgress('生成报告...', 95, onProgress)

      let responseSpeed: AnnualReportData['responseSpeed'] = null
      if (responseStatsFromSql && Object.keys(responseStatsFromSql).length > 0) {
        let totalSum = 0
        let totalCount = 0
        let fastestFriendId = ''
        let fastestAvgTime = Infinity
        for (const [sessionId, stats] of Object.entries(responseStatsFromSql)) {
          const count = stats.count || 0
          const avg = stats.avg || 0
          if (count <= 0 || avg <= 0) continue
          totalSum += avg * count
          totalCount += count
          if (avg < fastestAvgTime) {
            fastestAvgTime = avg
            fastestFriendId = sessionId
          }
        }
        if (totalCount > 0) {
          const avgResponseTime = totalSum / totalCount
          const fastestInfo = contactInfoMap.get(fastestFriendId)
          responseSpeed = {
            avgResponseTime: Math.round(avgResponseTime),
            fastestFriend: fastestInfo?.displayName || fastestFriendId,
            fastestTime: Math.round(fastestAvgTime)
          }
        }
      } else {
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
      }

      const topPhrases = topPhrasesFromSql && topPhrasesFromSql.length > 0
        ? topPhrasesFromSql
        : Array.from(phraseCount.entries())
          .filter(([_, count]) => count >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 32)
          .map(([phrase, count]) => ({ phrase, count }))

      // 曾经的好朋友 (Once Best Friend / Lost Friend)
      let lostFriend: AnnualReportData['lostFriend'] = null
      let maxEarlyCount = 80  // 最低门槛
      let bestEarlyCount = 0
      let bestLateCount = 0
      let bestSid = ''
      let bestPeriodDesc = ''

      const currentMonthIndex = new Date().getMonth() + 1 // 1-12

      const currentYearNum = now.getFullYear()

      if (isAllTime) {
        const days = Object.keys(d.daily).sort()
        if (days.length >= 2) {
          const firstDay = Math.floor(new Date(days[0]).getTime() / 1000)
          const lastDay = Math.floor(new Date(days[days.length - 1]).getTime() / 1000)
          const midPoint = Math.floor((firstDay + lastDay) / 2)

          this.reportProgress('分析历史趋势 (1/2)...', 86, onProgress)
          const earlyRes = await wcdbService.getAggregateStats(sessionIds, 0, midPoint)
          this.reportProgress('分析历史趋势 (2/2)...', 88, onProgress)
          const lateRes = await wcdbService.getAggregateStats(sessionIds, midPoint, 0)

          if (earlyRes.success && lateRes.success && earlyRes.data) {
            const earlyData = earlyRes.data.sessions || {}
            const lateData = (lateRes.data?.sessions) || {}
            for (const sid of sessionIds) {
              const e = earlyData[sid] || { sent: 0, received: 0 }
              const l = lateData[sid] || { sent: 0, received: 0 }
              const early = (e.sent || 0) + (e.received || 0)
              const late = (l.sent || 0) + (l.received || 0)
              if (early > 100 && early > late * 5) {
                // 选择前期消息量最多的
                if (early > maxEarlyCount) {
                  maxEarlyCount = early
                  bestEarlyCount = early
                  bestLateCount = late
                  bestSid = sid
                  bestPeriodDesc = '这段时间以来'
                }
              }
            }
          }
        }
      } else if (year === currentYearNum) {
        // 当前年份：独立获取过去12个月的滚动数据
        this.reportProgress('分析近期好友趋势...', 86, onProgress)
        // 往前数12个月的起点、中点、终点
        const rollingStart = Math.floor(new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime() / 1000)
        const rollingMid = Math.floor(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime() / 1000)
        const rollingEnd = Math.floor(now.getTime() / 1000)

        const earlyRes = await wcdbService.getAggregateStats(sessionIds, rollingStart, rollingMid - 1)
        const lateRes = await wcdbService.getAggregateStats(sessionIds, rollingMid, rollingEnd)

        if (earlyRes.success && lateRes.success && earlyRes.data) {
          const earlyData = earlyRes.data.sessions || {}
          const lateData = lateRes.data?.sessions || {}
          for (const sid of sessionIds) {
            const e = earlyData[sid] || { sent: 0, received: 0 }
            const l = lateData[sid] || { sent: 0, received: 0 }
            const early = (e.sent || 0) + (e.received || 0)
            const late = (l.sent || 0) + (l.received || 0)
            if (early > 80 && early > late * 5) {
              // 选择前期消息量最多的
              if (early > maxEarlyCount) {
                maxEarlyCount = early
                bestEarlyCount = early
                bestLateCount = late
                bestSid = sid
                bestPeriodDesc = '去年的这个时候'
              }
            }
          }
        }
      } else {
        // 指定完整年份 (1-6 vs 7-12)
        for (const [sid, stat] of Object.entries(d.sessions)) {
          const s = stat as any
          const mWeights = s.monthly || {}
          let early = 0
          let late = 0
          for (let m = 1; m <= 6; m++) early += mWeights[m] || 0
          for (let m = 7; m <= 12; m++) late += mWeights[m] || 0

          if (early > 80 && early > late * 5) {
            // 选择前期消息量最多的
            if (early > maxEarlyCount) {
              maxEarlyCount = early
              bestEarlyCount = early
              bestLateCount = late
              bestSid = sid
              bestPeriodDesc = `${year}年上半年`
            }
          }
        }
      }

      if (bestSid) {
        let info = contactInfoMap.get(bestSid)
        // 如果 contactInfoMap 中没有该联系人，则单独获取
        if (!info) {
          const [displayNameRes, avatarUrlRes] = await Promise.all([
            wcdbService.getDisplayNames([bestSid]),
            wcdbService.getAvatarUrls([bestSid])
          ])
          info = {
            displayName: displayNameRes.success && displayNameRes.map ? (displayNameRes.map[bestSid] || bestSid) : bestSid,
            avatarUrl: avatarUrlRes.success && avatarUrlRes.map ? avatarUrlRes.map[bestSid] : undefined
          }
        }
        lostFriend = {
          username: bestSid,
          displayName: info?.displayName || bestSid,
          avatarUrl: info?.avatarUrl,
          earlyCount: bestEarlyCount,
          lateCount: bestLateCount,
          periodDesc: bestPeriodDesc
        }
      }

      const reportData: AnnualReportData = {
        year: reportYear,
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
        topPhrases,
        snsStats: snsStatsResult,
        lostFriend
      }

      return { success: true, data: reportData }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const annualReportService = new AnnualReportService()
