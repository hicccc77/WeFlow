import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { join } from 'path'
import { readFile, writeFile, rm } from 'fs/promises'
import { app } from 'electron'
import { createHash } from 'crypto'

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
  wechatId?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

class AnalyticsService {
  private configService: ConfigService
  private fallbackAggregateCache: { key: string; data: any; updatedAt: number } | null = null
  private aggregateCache: { key: string; data: any; updatedAt: number } | null = null
  private aggregatePromise: { key: string; promise: Promise<{ success: boolean; data?: any; source?: string; error?: string }> } | null = null

  constructor() {
    this.configService = new ConfigService()
  }

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase()
  }

  private normalizeExcludedUsernames(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const normalized = value
      .map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '')
      .filter((item) => item.length > 0)
    return Array.from(new Set(normalized))
  }

  private getExcludedUsernamesList(): string[] {
    return this.normalizeExcludedUsernames(this.configService.get('analyticsExcludedUsernames'))
  }

  private getExcludedUsernamesSet(): Set<string> {
    return new Set(this.getExcludedUsernamesList())
  }

  private escapeSqlValue(value: string): string {
    return value.replace(/'/g, "''")
  }

  private async getAliasMap(usernames: string[]): Promise<Record<string, string>> {
    const map: Record<string, string> = {}
    if (usernames.length === 0) return map

    const chunkSize = 200
    for (let i = 0; i < usernames.length; i += chunkSize) {
      const chunk = usernames.slice(i, i + chunkSize)
      const inList = chunk.map((u) => `'${this.escapeSqlValue(u)}'`).join(',')
      if (!inList) continue
      const sql = `
        SELECT username, alias
        FROM contact
        WHERE username IN (${inList})
      `
      const result = await wcdbService.execQuery('contact', null, sql)
      if (!result.success || !result.rows) continue
      for (const row of result.rows as Record<string, any>[]) {
        const username = row.username || ''
        const alias = row.alias || ''
        if (username && alias) {
          map[username] = alias
        }
      }
    }

    return map
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
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

  private async getPrivateSessions(
    cleanedWxid: string,
    excludedUsernames?: Set<string>
  ): Promise<{ usernames: string[]; numericIds: string[] }> {
    const sessionResult = await wcdbService.getSessions()
    if (!sessionResult.success || !sessionResult.sessions) {
      return { usernames: [], numericIds: [] }
    }
    const rows = sessionResult.sessions as Record<string, any>[]
    const excluded = excludedUsernames ?? this.getExcludedUsernamesSet()

    const sample = rows[0]
    void sample

    const sessions = rows.map((row) => {
      const username = row.username || row.user_name || row.userName || ''
      const idValue =
        row.id ??
        row.session_id ??
        row.sessionId ??
        row.sid ??
        row.local_id ??
        row.user_id ??
        row.userId ??
        row.chatroom_id ??
        row.chatroomId ??
        null
      return { username, idValue }
    })
    const usernames = sessions.map((s) => s.username)
    const privateSessions = sessions.filter((s) => {
      if (!this.isPrivateSession(s.username, cleanedWxid)) return false
      if (excluded.size === 0) return true
      return !excluded.has(this.normalizeUsername(s.username))
    })
    const privateUsernames = privateSessions.map((s) => s.username)
    const numericIds = privateSessions
      .map((s) => s.idValue)
      .filter((id) => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))
      .map((id) => String(id))
    return { usernames: privateUsernames, numericIds }
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

  private buildAggregateCacheKey(sessionIds: string[], beginTimestamp: number, endTimestamp: number): string {
    if (sessionIds.length === 0) {
      return `${beginTimestamp}-${endTimestamp}-0-empty`
    }
    const normalized = Array.from(new Set(sessionIds.map((id) => String(id)))).sort()
    const hash = createHash('sha1').update(normalized.join('|')).digest('hex').slice(0, 12)
    return `${beginTimestamp}-${endTimestamp}-${normalized.length}-${hash}`
  }

  private async computeAggregateByCursor(sessionIds: string[], beginTimestamp = 0, endTimestamp = 0): Promise<any> {
    const wxid = this.configService.get('myWxid')
    const cleanedWxid = wxid ? this.cleanAccountDirName(wxid) : ''

    const aggregate = {
      total: 0,
      sent: 0,
      received: 0,
      firstTime: 0,
      lastTime: 0,
      typeCounts: {} as Record<number, number>,
      hourly: {} as Record<number, number>,
      weekday: {} as Record<number, number>,
      daily: {} as Record<string, number>,
      monthly: {} as Record<string, number>,
      sessions: {} as Record<string, { total: number; sent: number; received: number; lastTime: number }>,
      idMap: {}
    }

    for (const sessionId of sessionIds) {
      const sessionStat = { total: 0, sent: 0, received: 0, lastTime: 0 }
      await this.iterateSessionMessages(sessionId, (row) => {
        const createTime = parseInt(row.create_time || row.createTime || row.create_time_ms || '0', 10)
        if (!createTime) return
        if (beginTimestamp > 0 && createTime < beginTimestamp) return
        if (endTimestamp > 0 && createTime > endTimestamp) return

        const localType = parseInt(row.local_type || row.type || '1', 10)
        const isSendRaw = row.computed_is_send ?? row.is_send ?? row.isSend
        let isSend = String(isSendRaw) === '1' || isSendRaw === 1 || isSendRaw === true

        // 如果底层没有提供 is_send，则根据发送者用户名推断
        const senderUsername = row.sender_username || row.senderUsername || row.sender
        if (isSendRaw === undefined || isSendRaw === null) {
          if (senderUsername && (cleanedWxid)) {
            const senderLower = String(senderUsername).toLowerCase()
            const myWxidLower = cleanedWxid.toLowerCase()
            isSend = (
              senderLower === myWxidLower ||
              // 兼容非 wxid 开头的账号（如果文件夹名带后缀，如 custom_backup，而 sender 是 custom）
              (myWxidLower.startsWith(senderLower + '_'))
            )
          }
        }

        aggregate.total += 1
        sessionStat.total += 1

        aggregate.typeCounts[localType] = (aggregate.typeCounts[localType] || 0) + 1

        if (isSend) {
          aggregate.sent += 1
          sessionStat.sent += 1
        } else {
          aggregate.received += 1
          sessionStat.received += 1
        }

        if (aggregate.firstTime === 0 || createTime < aggregate.firstTime) {
          aggregate.firstTime = createTime
        }
        if (createTime > aggregate.lastTime) {
          aggregate.lastTime = createTime
        }
        if (createTime > sessionStat.lastTime) {
          sessionStat.lastTime = createTime
        }

        const date = new Date(createTime * 1000)
        const hour = date.getHours()
        const weekday = date.getDay()
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
        const dayKey = `${monthKey}-${String(date.getDate()).padStart(2, '0')}`

        aggregate.hourly[hour] = (aggregate.hourly[hour] || 0) + 1
        aggregate.weekday[weekday] = (aggregate.weekday[weekday] || 0) + 1
        aggregate.monthly[monthKey] = (aggregate.monthly[monthKey] || 0) + 1
        aggregate.daily[dayKey] = (aggregate.daily[dayKey] || 0) + 1
      }, beginTimestamp, endTimestamp)

      if (sessionStat.total > 0) {
        aggregate.sessions[sessionId] = sessionStat
      }
    }

    return aggregate
  }

  private async getAggregateWithFallback(
    sessionIds: string[],
    beginTimestamp = 0,
    endTimestamp = 0,
    window?: any,
    force = false
  ): Promise<{ success: boolean; data?: any; source?: string; error?: string }> {
    const cacheKey = this.buildAggregateCacheKey(sessionIds, beginTimestamp, endTimestamp)

    if (force) {
      if (this.aggregateCache) this.aggregateCache = null
      if (this.fallbackAggregateCache) this.fallbackAggregateCache = null
    }

    if (!force && this.aggregateCache && this.aggregateCache.key === cacheKey) {
      if (Date.now() - this.aggregateCache.updatedAt < 5 * 60 * 1000) {
        return { success: true, data: this.aggregateCache.data, source: 'cache' }
      }
    }

    // 尝试从文件加载缓存
    if (!force) {
      const fileCache = await this.loadCacheFromFile()
      if (fileCache && fileCache.key === cacheKey) {
        this.aggregateCache = fileCache
        return { success: true, data: fileCache.data, source: 'file-cache' }
      }
    }

    if (this.aggregatePromise && this.aggregatePromise.key === cacheKey) {
      return this.aggregatePromise.promise
    }

    const promise = (async () => {
      const result = await wcdbService.getAggregateStats(sessionIds, beginTimestamp, endTimestamp)
      if (result.success && result.data && result.data.total > 0) {
        this.aggregateCache = { key: cacheKey, data: result.data, updatedAt: Date.now() }
        return { success: true, data: result.data, source: 'dll' }
      }

      if (this.fallbackAggregateCache && this.fallbackAggregateCache.key === cacheKey) {
        if (Date.now() - this.fallbackAggregateCache.updatedAt < 5 * 60 * 1000) {
          return { success: true, data: this.fallbackAggregateCache.data, source: 'cursor-cache' }
        }
      }

      if (window) {
        this.setProgress(window, '原生聚合为0，使用游标统计...', 45)
      }

      const data = await this.computeAggregateByCursor(sessionIds, beginTimestamp, endTimestamp)
      this.fallbackAggregateCache = { key: cacheKey, data, updatedAt: Date.now() }
      this.aggregateCache = { key: cacheKey, data, updatedAt: Date.now() }
      return { success: true, data, source: 'cursor' }
    })()

    this.aggregatePromise = { key: cacheKey, promise }
    try {
      const result = await promise
      // 如果计算成功，同时写入此文件缓存
      if (result.success && result.data && result.source !== 'cache') {
        this.saveCacheToFile({ key: cacheKey, data: this.aggregateCache?.data, updatedAt: Date.now() })
      }
      return result
    } finally {
      if (this.aggregatePromise && this.aggregatePromise.key === cacheKey) {
        this.aggregatePromise = null
      }
    }
  }

  private getCacheFilePath(): string {
    return join(app.getPath('documents'), 'WeFlow', 'analytics_cache.json')
  }

  private async loadCacheFromFile(): Promise<{ key: string; data: any; updatedAt: number } | null> {
    try {
      const raw = await readFile(this.getCacheFilePath(), 'utf-8')
      return JSON.parse(raw)
    } catch { return null }
  }

  private async saveCacheToFile(data: any) {
    try {
      await writeFile(this.getCacheFilePath(), JSON.stringify(data))
    } catch (e) {
      console.error('保存统计缓存失败:', e)
    }
  }

  private normalizeAggregateSessions(
    sessions: Record<string, any> | undefined,
    idMap: Record<string, string> | undefined
  ): Record<string, any> {
    if (!sessions) return {}
    if (!idMap) return sessions
    const keys = Object.keys(sessions)
    if (keys.length === 0) return sessions
    const numericKeys = keys.every((k) => /^\d+$/.test(k))
    if (!numericKeys) return sessions
    const remapped: Record<string, any> = {}
    for (const [id, stat] of Object.entries(sessions)) {
      const username = idMap[id] || id
      remapped[username] = stat
    }
    return remapped
  }

  private async logAggregateDiagnostics(sessionIds: string[]): Promise<void> {
    const samples = sessionIds.slice(0, 5)
    const results = await Promise.all(samples.map(async (sessionId) => {
      const countResult = await wcdbService.getMessageCount(sessionId)
      return { sessionId, success: countResult.success, count: countResult.count, error: countResult.error }
    }))
    void results
  }

  async getExcludedUsernames(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    try {
      return { success: true, data: this.getExcludedUsernamesList() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async setExcludedUsernames(usernames: string[]): Promise<{ success: boolean; data?: string[]; error?: string }> {
    try {
      const normalized = this.normalizeExcludedUsernames(usernames)
      this.configService.set('analyticsExcludedUsernames', normalized)
      await this.clearCache()
      return { success: true, data: normalized }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getExcludeCandidates(): Promise<{ success: boolean; data?: Array<{ username: string; displayName: string; avatarUrl?: string; wechatId?: string }>; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const excluded = this.getExcludedUsernamesSet()
      const sessionInfo = await this.getPrivateSessions(conn.cleanedWxid, new Set())

      const usernames = new Set<string>(sessionInfo.usernames)
      for (const name of excluded) usernames.add(name)

      if (usernames.size === 0) {
        return { success: true, data: [] }
      }

      const usernameList = Array.from(usernames)
      const [displayNames, avatarUrls, aliasMap] = await Promise.all([
        wcdbService.getDisplayNames(usernameList),
        wcdbService.getAvatarUrls(usernameList),
        this.getAliasMap(usernameList)
      ])

      const entries = usernameList.map((username) => {
        const displayName = displayNames.success && displayNames.map
          ? (displayNames.map[username] || username)
          : username
        const avatarUrl = avatarUrls.success && avatarUrls.map
          ? avatarUrls.map[username]
          : undefined
        const alias = aliasMap[username]
        const wechatId = alias || (!username.startsWith('wxid_') ? username : '')
        return { username, displayName, avatarUrl, wechatId }
      })

      return { success: true, data: entries }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getOverallStatistics(force = false): Promise<{ success: boolean; data?: ChatStatistics; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionInfo = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionInfo.usernames.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const { BrowserWindow } = require('electron')
      const win = BrowserWindow.getAllWindows()[0]
      this.setProgress(win, '正在执行原生数据聚合...', 30)

      const result = await this.getAggregateWithFallback(sessionInfo.usernames, 0, 0, win, force)

      if (!result.success || !result.data) {
        return { success: false, error: result.error || '聚合统计失败' }
      }

      this.setProgress(win, '同步分析结果...', 90)
      const d = result.data
      if (d.total === 0 && sessionInfo.usernames.length > 0) {
        await this.logAggregateDiagnostics(sessionInfo.usernames)
      }

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

  async getContactRankings(
    limit: number = 20,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<{ success: boolean; data?: ContactRanking[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const sessionInfo = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionInfo.usernames.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const result = await this.getAggregateWithFallback(sessionInfo.usernames, beginTimestamp, endTimestamp)
      if (!result.success || !result.data) {
        return { success: false, error: result.error || '聚合统计失败' }
      }

      const d = result.data
      const sessions = this.normalizeAggregateSessions(d.sessions, d.idMap)
      const usernames = Object.keys(sessions)
      const [displayNames, avatarUrls, aliasMap] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames),
        this.getAliasMap(usernames)
      ])

      const rankings: ContactRanking[] = usernames
        .map((username) => {
          const stat = sessions[username]
          const displayName = displayNames.success && displayNames.map
            ? (displayNames.map[username] || username)
            : username
          const avatarUrl = avatarUrls.success && avatarUrls.map
            ? avatarUrls.map[username]
            : undefined
          const alias = aliasMap[username] || ''
          const wechatId = alias || (!username.startsWith('wxid_') ? username : '')
          return {
            username,
            displayName,
            avatarUrl,
            wechatId,
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

      const sessionInfo = await this.getPrivateSessions(conn.cleanedWxid)
      if (sessionInfo.usernames.length === 0) {
        return { success: false, error: '未找到消息会话' }
      }

      const result = await this.getAggregateWithFallback(sessionInfo.usernames, 0, 0)
      if (!result.success || !result.data) {
        return { success: false, error: result.error || '聚合统计失败' }
      }

      const d = result.data

      // SQLite strftime('%w') 返回 0=周日, 1=周一...6=周六
      // 前端期望 1=周一...7=周日
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

  async clearCache(): Promise<{ success: boolean; error?: string }> {
    this.aggregateCache = null
    this.fallbackAggregateCache = null
    this.aggregatePromise = null
    try {
      await rm(this.getCacheFilePath(), { force: true })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const analyticsService = new AnalyticsService()
