// 聊天会话
export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  displayName?: string
  avatarUrl?: string
  lastMsgSender?: string
  lastSenderDisplayName?: string
  selfWxid?: string // Helper field to avoid extra API calls
}

// 联系人
export interface Contact {
  id: number
  username: string
  localType: number
  alias: string
  remark: string
  nickName: string
  bigHeadUrl: string
  smallHeadUrl: string
}

export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

// 消息
export interface Message {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent?: string  // 原始消息内容（保留用于兼容）
  content?: string  // 原始消息内容（XML）
  imageMd5?: string
  imageDatName?: string
  emojiCdnUrl?: string
  emojiMd5?: string
  voiceDurationSeconds?: number
  videoMd5?: string
  // 引用消息
  quotedContent?: string
  quotedSender?: string
  // Type 49 细分字段
  linkTitle?: string        // 链接/文件标题
  linkUrl?: string          // 链接 URL
  linkThumb?: string        // 链接缩略图
  fileName?: string         // 文件名
  fileSize?: number         // 文件大小
  fileExt?: string          // 文件扩展名
  xmlType?: string          // XML 中的 type 字段
  // 转账消息
  transferPayerUsername?: string    // 转账付款方 wxid
  transferReceiverUsername?: string // 转账收款方 wxid
  // 名片消息
  cardUsername?: string     // 名片的微信ID
  cardNickname?: string     // 名片的昵称
  // 聊天记录
  chatRecordTitle?: string  // 聊天记录标题
  chatRecordList?: ChatRecordItem[]  // 聊天记录列表
}

// 聊天记录项
export interface ChatRecordItem {
  datatype: number          // 消息类型
  sourcename: string        // 发送者
  sourcetime: string        // 时间
  sourceheadurl?: string    // 发送者头像
  datadesc?: string         // 内容描述
  datatitle?: string        // 标题
  fileext?: string          // 文件扩展名
  datasize?: number         // 文件大小
  messageuuid?: string      // 消息UUID
  dataurl?: string          // 数据URL
  datathumburl?: string     // 缩略图URL
  datacdnurl?: string       // CDN URL
  aeskey?: string           // AES密钥
  md5?: string              // MD5
  imgheight?: number        // 图片高度
  imgwidth?: number         // 图片宽度
  duration?: number         // 时长（毫秒）
}


// 分析数据
export interface AnalyticsData {
  totalMessages: number
  totalDays: number
  myMessages: number
  otherMessages: number
  messagesByType: Record<number, number>
  messagesByHour: number[]
  messagesByDay: number[]
}
