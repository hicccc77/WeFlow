import * as fs from 'fs'
import * as path from 'path'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

// ChatLab 格式类型定义
interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
}

interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
}

interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
}

class ExportService {
  private configService: ConfigService
  private contactCache: Map<string, { displayName: string; avatarUrl?: string }> = new Map()

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

  private async ensureConnected(): Promise<{ success: boolean; cleanedWxid?: string; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '请先在设置页面配置微信ID' }
    if (!dbPath) return { success: false, error: '请先在设置页面配置数据库路径' }
    if (!decryptKey) return { success: false, error: '请先在设置页面配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true, cleanedWxid }
  }

  private async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
    if (this.contactCache.has(username)) {
      return this.contactCache.get(username)!
    }

    const [displayNames, avatarUrls] = await Promise.all([
      wcdbService.getDisplayNames([username]),
      wcdbService.getAvatarUrls([username])
    ])

    const displayName = displayNames.success && displayNames.map
      ? (displayNames.map[username] || username)
      : username
    const avatarUrl = avatarUrls.success && avatarUrls.map
      ? avatarUrls.map[username]
      : undefined

    const info = { displayName, avatarUrl }
    this.contactCache.set(username, info)
    return info
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    if (localType === 49) {
      const typeMatch = /<type>(\d+)<\/type>/i.exec(content)
      if (typeMatch) {
        const subType = parseInt(typeMatch[1])
        switch (subType) {
          case 6: return 4   // 文件 -> FILE
          case 33:
          case 36: return 24 // 小程序 -> SHARE
          case 57: return 25 // 引用回复 -> REPLY
          default: return 7  // 链接 -> LINK
        }
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99
  }

  /**
   * 解码消息内容
   */
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

  /**
   * 解析消息内容为可读文本
   */
  private parseMessageContent(content: string, localType: number): string | null {
    if (!content) return null

    switch (localType) {
      case 1:
        return this.stripSenderPrefix(content)
      case 3: return '[图片]'
      case 34: return '[语音消息]'
      case 42: return '[名片]'
      case 43: return '[视频]'
      case 47: return '[动画表情]'
      case 48: return '[位置]'
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        return title || '[链接]'
      }
      case 50: return '[通话]'
      case 10000: return this.cleanSystemMessage(content)
      default:
        if (content.includes('<type>57</type>')) {
          const title = this.extractXmlValue(content, 'title')
          return title || '[引用消息]'
        }
        return this.stripSenderPrefix(content) || null
    }
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '')
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private cleanSystemMessage(content: string): string {
    return content
      .replace(/<img[^>]*>/gi, '')
      .replace(/<\/?[a-zA-Z0-9_]+[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim() || '[系统消息]'
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number): string {
    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      42: '名片消息',
      43: '视频消息',
      47: '动画表情',
      48: '位置消息',
      49: '链接消息',
      50: '通话消息',
      10000: '系统消息'
    }
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  private async collectMessages(
    sessionId: string,
    cleanedMyWxid: string,
    dateRange?: { start: number; end: number } | null
  ): Promise<{ rows: any[]; memberSet: Map<string, ChatLabMember>; firstTime: number | null; lastTime: number | null }> {
    const rows: any[] = []
    const memberSet = new Map<string, ChatLabMember>()
    let firstTime: number | null = null
    let lastTime: number | null = null

    const cursor = await wcdbService.openMessageCursor(
      sessionId,
      500,
      true,
      dateRange?.start || 0,
      dateRange?.end || 0
    )
    if (!cursor.success || !cursor.cursor) {
      return { rows, memberSet, firstTime, lastTime }
    }

    try {
      let hasMore = true
      while (hasMore) {
        const batch = await wcdbService.fetchMessageBatch(cursor.cursor)
        if (!batch.success || !batch.rows) break
        for (const row of batch.rows) {
          const createTime = parseInt(row.create_time || '0', 10)
          if (dateRange) {
            if (createTime < dateRange.start || createTime > dateRange.end) continue
          }

          const content = this.decodeMessageContent(row.message_content, row.compress_content)
          const localType = parseInt(row.local_type || row.type || '1', 10)
          const senderUsername = row.sender_username || ''
          const isSendRaw = row.computed_is_send ?? row.is_send ?? '0'
          const isSend = parseInt(isSendRaw, 10) === 1

          const actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
          const memberInfo = await this.getContactInfo(actualSender)
          if (!memberSet.has(actualSender)) {
            memberSet.set(actualSender, {
              platformId: actualSender,
              accountName: memberInfo.displayName
            })
          }

          rows.push({
            createTime,
            localType,
            content,
            senderUsername: actualSender,
            isSend
          })

          if (firstTime === null || createTime < firstTime) firstTime = createTime
          if (lastTime === null || createTime > lastTime) lastTime = createTime
        }
        hasMore = batch.hasMore === true
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor.cursor)
    }

    return { rows, memberSet, firstTime, lastTime }
  }

  /**
   * 导出单个会话为 ChatLab 格式
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)
      const allMessages = collected.rows

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting'
      })

      const chatLabMessages: ChatLabMessage[] = allMessages.map((msg) => {
        const memberInfo = collected.memberSet.get(msg.senderUsername) || {
          platformId: msg.senderUsername,
          accountName: msg.senderUsername
        }
        return {
          sender: msg.senderUsername,
          accountName: memberInfo.accountName,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: this.parseMessageContent(msg.content, msg.localType)
        }
      })

      const chatLabExport: ChatLabExport = {
        chatlab: {
          version: '0.0.1',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'WeFlow'
        },
        meta: {
          name: sessionInfo.displayName,
          platform: 'wechat',
          type: isGroup ? 'group' : 'private',
          ...(isGroup && { groupId: sessionId })
        },
        members: Array.from(collected.memberSet.values()),
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      if (options.format === 'chatlab-jsonl') {
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success || !conn.cleanedWxid) return { success: false, error: conn.error }

      const cleanedMyWxid = conn.cleanedWxid
      const isGroup = sessionId.includes('@chatroom')

      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing'
      })

      const collected = await this.collectMessages(sessionId, cleanedMyWxid, options.dateRange)
      const allMessages: any[] = []

      for (const msg of collected.rows) {
        const senderInfo = await this.getContactInfo(msg.senderUsername)
        const sourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(msg.content || '')
        const source = sourceMatch ? sourceMatch[0] : ''

        allMessages.push({
          localId: allMessages.length + 1,
          createTime: msg.createTime,
          formattedTime: this.formatTimestamp(msg.createTime),
          type: this.getMessageTypeName(msg.localType),
          localType: msg.localType,
          content: this.parseMessageContent(msg.content, msg.localType),
          isSend: msg.isSend ? 1 : 0,
          senderUsername: msg.senderUsername,
          senderDisplayName: senderInfo.displayName,
          source,
          senderAvatarKey: msg.senderUsername
        })
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing'
      })

      const detailedExport = {
        session: {
          wxid: sessionId,
          nickname: sessionInfo.displayName,
          remark: sessionInfo.displayName,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          lastTimestamp: collected.lastTime,
          messageCount: allMessages.length
        },
        messages: allMessages
      }

      fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount: number; failCount: number; error?: string }> {
    let successCount = 0
    let failCount = 0

    try {
      const conn = await this.ensureConnected()
      if (!conn.success) {
        return { success: false, successCount: 0, failCount: sessionIds.length, error: conn.error }
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        const sessionInfo = await this.getContactInfo(sessionId)

        onProgress?.({
          current: i + 1,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting'
        })

        const safeName = sessionInfo.displayName.replace(/[<>:"/\\|?*]/g, '_')
        let ext = '.json'
        if (options.format === 'chatlab-jsonl') ext = '.jsonl'
        const outputPath = path.join(outputDir, `${safeName}${ext}`)

        let result: { success: boolean; error?: string }
        if (options.format === 'json') {
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, options)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, options)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        if (result.success) {
          successCount++
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        phase: 'complete'
      })

      return { success: true, successCount, failCount }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e) }
    }
  }
}

export const exportService = new ExportService()
