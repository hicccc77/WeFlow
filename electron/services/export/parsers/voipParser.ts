export function parseVoipMessage(content: string): string {
  try {
    if (!content) return '[通话]'

    // 提取 msg 内容（中文通话状态）
    const msgMatch = /<msg><!\[CDATA\[(.*?)\]\]><\/msg>/i.exec(content)
    const msg = msgMatch?.[1]?.trim() || ''

    // 提取 room_type（0=视频，1=语音）
    const roomTypeMatch = /<room_type>(\d+)<\/room_type>/i.exec(content)
    const roomType = roomTypeMatch ? parseInt(roomTypeMatch[1], 10) : -1

    // 构建通话类型标签
    let callType: string
    if (roomType === 0) {
      callType = '视频通话'
    } else if (roomType === 1) {
      callType = '语音通话'
    } else {
      callType = '通话'
    }

    // 解析通话状态
    if (msg.includes('通话时长')) {
      const durationMatch = /通话时长\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(msg)
      const duration = durationMatch?.[1] || ''
      if (duration) {
        return `[${callType}] ${duration}`
      }
      return `[${callType}] 已接听`
    } else if (msg.includes('对方无应答')) {
      return `[${callType}] 对方无应答`
    } else if (msg.includes('已取消')) {
      return `[${callType}] 已取消`
    } else if (msg.includes('已在其它设备接听') || msg.includes('已在其他设备接听')) {
      return `[${callType}] 已在其他设备接听`
    } else if (msg.includes('对方已拒绝') || msg.includes('已拒绝')) {
      return `[${callType}] 对方已拒绝`
    } else if (msg.includes('忙线未接听') || msg.includes('忙线')) {
      return `[${callType}] 忙线未接听`
    } else if (msg.includes('未接听')) {
      return `[${callType}] 未接听`
    } else if (msg) {
      return `[${callType}] ${msg}`
    }

    return `[${callType}]`
  } catch (e) {
    return '[通话]'
  }
}
