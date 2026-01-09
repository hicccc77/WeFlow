import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

export interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  avatarUrl?: string
}

export interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
}

export interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

export interface GroupActiveHours {
  hourlyDistribution: Record<number, number>
}

export interface MediaTypeCount {
  type: number
  name: string
  count: number
}

export interface GroupMediaStats {
  typeCounts: MediaTypeCount[]
  total: number
}

class GroupAnalyticsService {
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
    }
    return trimmed
  }

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '未配置微信ID' }
    if (!dbPath) return { success: false, error: '未配置数据库路径' }
    if (!decryptKey) return { success: false, error: '未配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true }
  }

  async getGroupChats(): Promise<{ success: boolean; data?: GroupChatInfo[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const sessionResult = await wcdbService.getSessions()
      if (!sessionResult.success || !sessionResult.sessions) {
        return { success: false, error: sessionResult.error || '获取会话失败' }
      }

      const rows = sessionResult.sessions as Record<string, any>[]
      const groupIds = rows
        .map((row) => row.username || row.user_name || row.userName || '')
        .filter((username) => username.includes('@chatroom'))

      const [displayNames, avatarUrls, memberCounts] = await Promise.all([
        wcdbService.getDisplayNames(groupIds),
        wcdbService.getAvatarUrls(groupIds),
        wcdbService.getGroupMemberCounts(groupIds)
      ])

      const groups: GroupChatInfo[] = []
      for (const groupId of groupIds) {
        groups.push({
          username: groupId,
          displayName: displayNames.success && displayNames.map
            ? (displayNames.map[groupId] || groupId)
            : groupId,
          memberCount: memberCounts.success && memberCounts.map && typeof memberCounts.map[groupId] === 'number'
            ? memberCounts.map[groupId]
            : 0,
          avatarUrl: avatarUrls.success && avatarUrls.map ? avatarUrls.map[groupId] : undefined
        })
      }

      groups.sort((a, b) => b.memberCount - a.memberCount)
      return { success: true, data: groups }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; data?: GroupMember[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupMembers(chatroomId)
      if (!result.success || !result.members) {
        return { success: false, error: result.error || '获取群成员失败' }
      }

      const members = result.members as { username: string; avatarUrl?: string }[]
      const usernames = members.map((m) => m.username)
      const displayNames = await wcdbService.getDisplayNames(usernames)

      const data: GroupMember[] = members.map((m) => ({
        username: m.username,
        displayName: displayNames.success && displayNames.map ? (displayNames.map[m.username] || m.username) : m.username,
        avatarUrl: m.avatarUrl
      }))

      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMessageRanking(chatroomId: string, limit: number = 20, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMessageRank[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const d = result.data
      const sessionData = d.sessions[chatroomId]
      if (!sessionData || !sessionData.senders) return { success: true, data: [] }

      const idMap = d.idMap || {}
      const senderEntries = Object.entries(sessionData.senders as Record<string, number>)

      const rankings: GroupMessageRank[] = senderEntries
        .map(([id, count]) => {
          const username = idMap[id] || id
          return {
            member: { username, displayName: username }, // Display name will be resolved below
            messageCount: count
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      // 批量获取显示名称和头像
      const usernames = rankings.map(r => r.member.username)
      const [names, avatars] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      for (const rank of rankings) {
        if (names.success && names.map && names.map[rank.member.username]) {
          rank.member.displayName = names.map[rank.member.username]
        }
        if (avatars.success && avatars.map && avatars.map[rank.member.username]) {
          rank.member.avatarUrl = avatars.map[rank.member.username]
        }
      }

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupActiveHours(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupActiveHours; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) {
        hourlyDistribution[i] = result.data.hourly[i] || 0
      }

      return { success: true, data: { hourlyDistribution } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMediaStats(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMediaStats; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const typeCountsRaw = result.data.typeCounts as Record<string, number>
      const mainTypes = [1, 3, 34, 43, 47, 49]
      const typeNames: Record<number, string> = {
        1: '文本', 3: '图片', 34: '语音', 43: '视频', 47: '表情包', 49: '链接/文件'
      }

      const countsMap = new Map<number, number>()
      let othersCount = 0

      for (const [typeStr, count] of Object.entries(typeCountsRaw)) {
        const type = parseInt(typeStr, 10)
        if (mainTypes.includes(type)) {
          countsMap.set(type, (countsMap.get(type) || 0) + count)
        } else {
          othersCount += count
        }
      }

      const mediaCounts: MediaTypeCount[] = mainTypes
        .map(type => ({
          type,
          name: typeNames[type],
          count: countsMap.get(type) || 0
        }))
        .filter(item => item.count > 0)

      if (othersCount > 0) {
        mediaCounts.push({ type: -1, name: '其他', count: othersCount })
      }

      mediaCounts.sort((a, b) => b.count - a.count)
      const total = mediaCounts.reduce((sum, item) => sum + item.count, 0)

      return { success: true, data: { typeCounts: mediaCounts, total } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const groupAnalyticsService = new GroupAnalyticsService()
