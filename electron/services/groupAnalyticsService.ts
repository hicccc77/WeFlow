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

      const [displayNames, avatarUrls] = await Promise.all([
        wcdbService.getDisplayNames(groupIds),
        wcdbService.getAvatarUrls(groupIds)
      ])

      const groups: GroupChatInfo[] = []
      for (const groupId of groupIds) {
        const countResult = await wcdbService.getGroupMemberCount(groupId)
        groups.push({
          username: groupId,
          displayName: displayNames.success && displayNames.map
            ? (displayNames.map[groupId] || groupId)
            : groupId,
          memberCount: countResult.success && countResult.count ? countResult.count : 0,
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

      const cursor = await wcdbService.openMessageCursor(
        chatroomId,
        500,
        true,
        startTime || 0,
        endTime || 0
      )
      if (!cursor.success || !cursor.cursor) {
        return { success: false, error: cursor.error || '创建游标失败' }
      }

      const counts = new Map<string, number>()
      try {
        let hasMore = true
        while (hasMore) {
          const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
          if (!batch.success || !batch.rows) break
          for (const row of batch.rows) {
            const sender = row.sender_username || ''
            if (!sender) continue
            counts.set(sender, (counts.get(sender) || 0) + 1)
          }
          hasMore = batch.hasMore === true
        }
      } finally {
        await wcdbService.closeMessageCursor(cursor.cursor)
      }

      const membersResult = await this.getGroupMembers(chatroomId)
      const memberMap = new Map<string, GroupMember>()
      if (membersResult.success && membersResult.data) {
        for (const member of membersResult.data) {
          memberMap.set(member.username, member)
        }
      }

      const rankings: GroupMessageRank[] = Array.from(counts.entries())
        .map(([username, count]) => ({
          member: memberMap.get(username) || { username, displayName: username },
          messageCount: count
        }))
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupActiveHours(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupActiveHours; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0

      const cursor = await wcdbService.openMessageCursor(
        chatroomId,
        500,
        true,
        startTime || 0,
        endTime || 0
      )
      if (!cursor.success || !cursor.cursor) {
        return { success: false, error: cursor.error || '创建游标失败' }
      }

      try {
        let hasMore = true
        while (hasMore) {
          const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
          if (!batch.success || !batch.rows) break
          for (const row of batch.rows) {
            const createTime = parseInt(row.create_time || '0', 10)
            if (!createTime) continue
            const hour = new Date(createTime * 1000).getHours()
            hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1
          }
          hasMore = batch.hasMore === true
        }
      } finally {
        await wcdbService.closeMessageCursor(cursor.cursor)
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

      const typeCounts = new Map<number, number>()
      const mainTypes = new Set([1, 3, 34, 43, 47, 49])
      const typeNames: Record<number, string> = {
        1: '文本',
        3: '图片',
        34: '语音',
        43: '视频',
        47: '表情包',
        49: '链接/文件'
      }

      const cursor = await wcdbService.openMessageCursor(
        chatroomId,
        500,
        true,
        startTime || 0,
        endTime || 0
      )
      if (!cursor.success || !cursor.cursor) {
        return { success: false, error: cursor.error || '创建游标失败' }
      }

      try {
        let hasMore = true
        while (hasMore) {
          const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
          if (!batch.success || !batch.rows) break
          for (const row of batch.rows) {
            const localType = parseInt(row.local_type || row.type || '1', 10)
            if (mainTypes.has(localType)) {
              typeCounts.set(localType, (typeCounts.get(localType) || 0) + 1)
            } else {
              typeCounts.set(-1, (typeCounts.get(-1) || 0) + 1)
            }
          }
          hasMore = batch.hasMore === true
        }
      } finally {
        await wcdbService.closeMessageCursor(cursor.cursor)
      }

      const result: MediaTypeCount[] = Array.from(typeCounts.entries())
        .filter(([, count]) => count > 0)
        .map(([type, count]) => ({
          type,
          name: type === -1 ? '其他' : (typeNames[type] || '其他'),
          count
        }))
        .sort((a, b) => b.count - a.count)

      const total = result.reduce((sum, item) => sum + item.count, 0)
      return { success: true, data: { typeCounts: result, total } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}

export const groupAnalyticsService = new GroupAnalyticsService()
