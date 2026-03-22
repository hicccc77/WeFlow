// 聊天会话
export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  messageCountHint?: number // 会话总消息数提示（若底层直接可取）
  displayName?: string
  avatarUrl?: string
  lastMsgSender?: string
  lastSenderDisplayName?: string
  selfWxid?: string // Helper field to avoid extra API calls
  isFolded?: boolean  // 是否已折叠进"折叠的群聊"
  isMuted?: boolean   // 是否开启免打扰
  alias?: string      // 微信号
  matchedField?: 'wxid' | 'alias' | 'name' // 搜索匹配的字段
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
  alias?: string
  labels?: string[]
  detailDescription?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
}

// 消息
export interface Message {
  messageKey: string
  localId: number
  serverId: number
  serverIdRaw?: string
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
  emojiLocalPath?: string   // 本地缓存路径（转发表情包无 CDN URL 时使用）
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
  appMsgKind?: string       // 归一化 appmsg 类型
  appMsgDesc?: string
  appMsgAppName?: string
  appMsgSourceName?: string
  appMsgSourceUsername?: string
  appMsgThumbUrl?: string
  appMsgMusicUrl?: string
  appMsgDataUrl?: string
  appMsgLocationLabel?: string
  finderNickname?: string
  finderUsername?: string
  finderCoverUrl?: string   // 视频号封面图
  finderAvatar?: string     // 视频号作者头像
  finderDuration?: number   // 视频号时长(秒)
  // 位置消息
  locationLat?: number      // 纬度
  locationLng?: number      // 经度
  locationPoiname?: string  // 地点名称
  locationLabel?: string    // 详细地址
  // 音乐消息
  musicAlbumUrl?: string    // 专辑封面
  musicUrl?: string         // 播放链接
  // 礼物消息
  giftImageUrl?: string     // 礼物商品图
  giftWish?: string         // 祝福语
  giftPrice?: string        // 价格(分)
  // 转账消息
  transferPayerUsername?: string    // 转账付款方 wxid
  transferReceiverUsername?: string // 转账收款方 wxid
  // 名片消息
  cardUsername?: string     // 名片的微信ID
  cardNickname?: string     // 名片的昵称
  cardAvatarUrl?: string    // 名片头像 URL
  // 聊天记录
  chatRecordTitle?: string  // 聊天记录标题
  chatRecordList?: ChatRecordItem[]  // 聊天记录列表
  _db_path?: string
  // 运行时补充的发送者信息
  senderDisplayName?: string
  senderAvatarUrl?: string
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
  cdndatakey?: string       // CDN 数据 key
  cdnthumbkey?: string      // CDN 缩略图 key
  aeskey?: string           // AES密钥
  md5?: string              // MD5
  fullmd5?: string          // 原图 MD5
  thumbfullmd5?: string     // 缩略图 MD5
  srcMsgLocalid?: number    // 源消息 LocalId
  imgheight?: number        // 图片高度
  imgwidth?: number         // 图片宽度
  duration?: number         // 时长（毫秒）
  chatRecordTitle?: string  // 嵌套聊天记录标题
  chatRecordDesc?: string   // 嵌套聊天记录描述
  chatRecordList?: ChatRecordItem[] // 嵌套聊天记录列表
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
