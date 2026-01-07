// 分析数据类型定义

// 聊天统计数据
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
  firstMessageTime: number | null  // Unix timestamp
  lastMessageTime: number | null
  activeDays: number
  messageTypeCounts: Record<number, number>
}

// 时间分布统计
export interface TimeDistribution {
  hourlyDistribution: Record<number, number>  // 0-23
  weekdayDistribution: Record<number, number> // 1-7
  monthlyDistribution: Record<string, number> // YYYY-MM
}

// 联系人排名
export interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

// 消息类型标签映射
export const MESSAGE_TYPE_LABELS: Record<number, string> = {
  1: '文本',
  244813135921: '文本',
  3: '图片',
  34: '语音',
  43: '视频',
  47: '表情',
  48: '位置',
  49: '链接/文件',
  42: '名片',
  10000: '系统消息',
}

// 星期几名称
export const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// 获取消息类型分布（用于图表）
export function getMessageTypeDistribution(stats: ChatStatistics): Record<string, number> {
  if (Object.keys(stats.messageTypeCounts).length > 0) {
    const distribution: Record<string, number> = {}
    
    for (const [type, count] of Object.entries(stats.messageTypeCounts)) {
      const typeNum = parseInt(type)
      const label = MESSAGE_TYPE_LABELS[typeNum] || '其他'
      distribution[label] = (distribution[label] || 0) + count
    }
    
    return distribution
  }
  
  return {
    '文本': stats.textMessages,
    '图片': stats.imageMessages,
    '语音': stats.voiceMessages,
    '视频': stats.videoMessages,
    '表情': stats.emojiMessages,
    '其他': stats.otherMessages,
  }
}

// 计算聊天时长（天数）
export function getChatDurationDays(stats: ChatStatistics): number {
  if (!stats.firstMessageTime || !stats.lastMessageTime) return 0
  const diffMs = (stats.lastMessageTime - stats.firstMessageTime) * 1000
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1
}

// 平均每天消息数
export function getAverageMessagesPerDay(stats: ChatStatistics): number {
  const days = getChatDurationDays(stats)
  if (days === 0) return 0
  return stats.totalMessages / days
}
