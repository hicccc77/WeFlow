// 消息类型映射：localType -> ChatLab type
export const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  34359738417: 7,  // 文件消息变体 -> LINK
  103079215153: 7, // 文件消息变体 -> LINK
  25769803825: 7,  // 文件消息变体 -> LINK
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

// 与 chatService 的资源消息识别保持一致，覆盖多种文件消息 localType。
export const FILE_APP_LOCAL_TYPES = [49, 34359738417, 103079215153, 25769803825] as const
export const FILE_APP_LOCAL_TYPE_SET = new Set<number>(FILE_APP_LOCAL_TYPES)

export const TXT_COLUMN_DEFINITIONS: Array<{ id: string; label: string }> = [
  { id: 'index', label: '序号' },
  { id: 'time', label: '时间' },
  { id: 'senderRole', label: '发送者身份' },
  { id: 'messageType', label: '消息类型' },
  { id: 'content', label: '内容' },
  { id: 'senderNickname', label: '发送者昵称' },
  { id: 'senderAccountId', label: '发送者账号ID' },
  { id: 'senderRemark', label: '发送者备注' }
]
