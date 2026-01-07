import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import * as fzstd from 'fzstd'
import { app } from 'electron'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

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
}

export interface Message {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  // 表情包相关
  emojiCdnUrl?: string
  emojiMd5?: string
  emojiLocalPath?: string  // 本地缓存路径
  // 引用消息相关
  quotedContent?: string
  quotedSender?: string
}

export interface Contact {
  username: string
  alias: string
  remark: string
  nickName: string
}

// 表情包缓存
const emojiCache: Map<string, string> = new Map()
const emojiDownloading: Map<string, Promise<string | null>> = new Map()

class ChatService {
  private configService: ConfigService
  private connected = false
  private messageCursors: Map<string, { cursor: number; fetched: number; batchSize: number }> = new Map()
  private readonly messageBatchDefault = 50
  private avatarCache: Map<string, { avatarUrl?: string; displayName?: string; updatedAt: number }> = new Map()
  private readonly avatarCacheTtlMs = 10 * 60 * 1000

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 清理账号目录名
   */
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

  /**
   * 连接数据库
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      const decryptKey = this.configService.get('decryptKey')
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置微信ID' }
      }
      if (!dbPath) {
        return { success: false, error: '请先在设置页面配置数据库路径' }
      }
      if (!decryptKey) {
        return { success: false, error: '请先在设置页面配置解密密钥' }
      }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const openOk = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
      if (!openOk) {
        return { success: false, error: 'WCDB 打开失败，请检查路径和密钥' }
      }

      this.connected = true
      return { success: true }
    } catch (e) {
      console.error('ChatService: 连接数据库失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    try {
      for (const state of this.messageCursors.values()) {
        wcdbService.closeMessageCursor(state.cursor)
      }
      this.messageCursors.clear()
      wcdbService.close()
    } catch (e) {
      console.error('ChatService: 关闭数据库失败:', e)
    }
    this.connected = false
  }

  /**
   * 获取会话列表
   */
  async getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    try {
      if (!this.connected) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      const result = await wcdbService.getSessions()
      if (!result.success || !result.sessions) {
        return { success: false, error: result.error || '获取会话失败' }
      }
      const rows = result.sessions as Record<string, any>[]
      if (rows.length > 0 && (rows[0]._error || rows[0]._info)) {
        const info = rows[0]
        const detail = info._error || info._info
        const tableInfo = info.table ? ` table=${info.table}` : ''
        const tables = info.tables ? ` tables=${info.tables}` : ''
        const columns = info.columns ? ` columns=${info.columns}` : ''
        return { success: false, error: `会话表异常: ${detail}${tableInfo}${tables}${columns}` }
      }

      // 转换为 ChatSession
      const sessions: ChatSession[] = []
      for (const row of rows) {
        const username =
          row.username ||
          row.user_name ||
          row.userName ||
          row.usrName ||
          row.UsrName ||
          row.talker ||
          row.talker_id ||
          row.talkerId ||
          ''
        
        if (!this.shouldKeepSession(username)) continue

        const sortTs = parseInt(
          row.sort_timestamp ||
          row.sortTimestamp ||
          row.sort_time ||
          row.sortTime ||
          '0',
          10
        )
        const lastTs = parseInt(
          row.last_timestamp ||
          row.lastTimestamp ||
          row.last_msg_time ||
          row.lastMsgTime ||
          String(sortTs),
          10
        )

        sessions.push({
          username,
          type: parseInt(row.type || '0', 10),
          unreadCount: parseInt(row.unread_count || row.unreadCount || row.unreadcount || '0', 10),
          summary: this.cleanString(row.summary || row.digest || row.last_msg || row.lastMsg || ''),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType: parseInt(row.last_msg_type || row.lastMsgType || '0', 10),
          displayName: username
        })
      }

      // 获取联系人信息
      await this.enrichSessionsWithContacts(sessions)

      return { success: true, sessions }
    } catch (e) {
      console.error('ChatService: 获取会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 补充联系人信息
   */
  private async enrichSessionsWithContacts(sessions: ChatSession[]): Promise<void> {
    if (sessions.length === 0) return
    try {
      const usernames = sessions.map(s => s.username)
      const [displayNames, avatarUrls] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      for (const session of sessions) {
        if (displayNames.success && displayNames.map && displayNames.map[session.username]) {
          session.displayName = displayNames.map[session.username]
        }
        if (avatarUrls.success && avatarUrls.map && avatarUrls.map[session.username]) {
          session.avatarUrl = avatarUrls.map[session.username]
        }
      }
    } catch (e) {
      console.error('ChatService: 获取联系人信息失败:', e)
    }
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      if (!this.connected) {
        return { success: false, error: '数据库未连接' }
      }

      const batchSize = Math.max(1, limit || this.messageBatchDefault)
      let state = this.messageCursors.get(sessionId)
      if (!state || offset === 0 || state.batchSize !== batchSize || offset !== state.fetched) {
        if (state) {
          await wcdbService.closeMessageCursor(state.cursor)
        }
        const cursorResult = await wcdbService.openMessageCursor(sessionId, batchSize, false, 0, 0)
        if (!cursorResult.success || !cursorResult.cursor) {
          return { success: false, error: cursorResult.error || '打开消息游标失败' }
        }
        state = { cursor: cursorResult.cursor, fetched: 0, batchSize }
        this.messageCursors.set(sessionId, state)
        if (offset > 0) {
          let skipped = 0
          while (skipped < offset) {
            const batch = await wcdbService.fetchMessageBatch(state.cursor)
            if (!batch.success || !batch.rows || batch.rows.length === 0) break
            skipped += batch.rows.length
            state.fetched += batch.rows.length
            if (!batch.hasMore) break
          }
        }
      }

      const batch = await wcdbService.fetchMessageBatch(state.cursor)
      if (!batch.success || !batch.rows) {
        return { success: false, error: batch.error || '获取消息失败' }
      }

      const rows = batch.rows as Record<string, any>[]
      const hasMore = batch.hasMore === true

      const messages: Message[] = []
      for (const row of rows) {
        const content = this.decodeMessageContent(row.message_content, row.compress_content)
        const localType = parseInt(row.local_type || row.type || '1', 10)
        const isSendRaw = row.computed_is_send ?? row.is_send ?? null
        const isSend = isSendRaw === null ? null : parseInt(isSendRaw, 10)

        let emojiCdnUrl: string | undefined
        let emojiMd5: string | undefined
        let quotedContent: string | undefined
        let quotedSender: string | undefined

        if (localType === 47 && content) {
          const emojiInfo = this.parseEmojiInfo(content)
          emojiCdnUrl = emojiInfo.cdnUrl
          emojiMd5 = emojiInfo.md5
        } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
          const quoteInfo = this.parseQuoteMessage(content)
          quotedContent = quoteInfo.content
          quotedSender = quoteInfo.sender
        }

        messages.push({
          localId: parseInt(row.local_id || '0', 10),
          serverId: parseInt(row.server_id || '0', 10),
          localType,
          createTime: parseInt(row.create_time || '0', 10),
          sortSeq: parseInt(row.sort_seq || '0', 10),
          isSend,
          senderUsername: row.sender_username || null,
          parsedContent: this.parseMessageContent(content, localType),
          rawContent: content,
          emojiCdnUrl,
          emojiMd5,
          quotedContent,
          quotedSender
        })
      }

      messages.reverse()
      state.fetched += rows.length
      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 解析消息内容
   */
  private parseMessageContent(content: string, localType: number): string {
    if (!content) {
      return this.getMessageTypeLabel(localType)
    }

    // 尝试解码 Buffer
    if (Buffer.isBuffer(content)) {
      content = content.toString('utf-8')
    }

    content = this.decodeHtmlEntities(content)

    // 检查 XML type，用于识别引用消息等
    const xmlType = this.extractXmlValue(content, 'type')

    switch (localType) {
      case 1:
        return this.stripSenderPrefix(content)
      case 3:
        return '[图片]'
      case 34:
        return '[语音消息]'
      case 42:
        return '[名片]'
      case 43:
        return '[视频]'
      case 47:
        return '[动画表情]'
      case 48:
        return '[位置]'
      case 49:
        return this.parseType49(content)
      case 50:
        return '[通话]'
      case 10000:
        return this.cleanSystemMessage(content)
      case 244813135921:
        // 引用消息，提取 title
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      default:
        // 检查是否是 type=57 的引用消息
        if (xmlType === '57') {
          const title = this.extractXmlValue(content, 'title')
          return title || '[引用消息]'
        }
        if (content.length > 200) {
          return this.getMessageTypeLabel(localType)
        }
        return this.stripSenderPrefix(content) || this.getMessageTypeLabel(localType)
    }
  }

  private parseType49(content: string): string {
    const title = this.extractXmlValue(content, 'title')
    const type = this.extractXmlValue(content, 'type')
    
    if (title) {
      switch (type) {
        case '5':
        case '49':
          return `[链接] ${title}`
        case '6':
          return `[文件] ${title}`
        case '33':
        case '36':
          return `[小程序] ${title}`
        case '57':
          // 引用消息，title 就是回复的内容
          return title
        default:
          return title
      }
    }
    return '[消息]'
  }

  /**
   * 解析表情包信息
   */
  private parseEmojiInfo(content: string): { cdnUrl?: string; md5?: string } {
    try {
      // 提取 cdnurl
      let cdnUrl: string | undefined
      const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
      if (cdnUrlMatch) {
        cdnUrl = cdnUrlMatch[1].replace(/&amp;/g, '&')
        if (cdnUrl.includes('%')) {
          try {
            cdnUrl = decodeURIComponent(cdnUrl)
          } catch {}
        }
      }

      // 如果没有 cdnurl，尝试 thumburl
      if (!cdnUrl) {
        const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
        if (thumbUrlMatch) {
          cdnUrl = thumbUrlMatch[1].replace(/&amp;/g, '&')
          if (cdnUrl.includes('%')) {
            try {
              cdnUrl = decodeURIComponent(cdnUrl)
            } catch {}
          }
        }
      }

      // 提取 md5
      const md5Match = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      const md5 = md5Match ? md5Match[1] : undefined

      // 不构造假 URL，只返回真正的 cdnurl
      return { cdnUrl, md5 }
    } catch {
      return {}
    }
  }

  /**
   * 解析引用消息
   */
  private parseQuoteMessage(content: string): { content?: string; sender?: string } {
    try {
      // 提取 refermsg 部分
      const referMsgStart = content.indexOf('<refermsg>')
      const referMsgEnd = content.indexOf('</refermsg>')
      
      if (referMsgStart === -1 || referMsgEnd === -1) {
        return {}
      }

      const referMsgXml = content.substring(referMsgStart, referMsgEnd + 11)
      
      // 提取发送者名称
      let displayName = this.extractXmlValue(referMsgXml, 'displayname')
      // 过滤掉 wxid
      if (displayName && this.looksLikeWxid(displayName)) {
        displayName = ''
      }
      
      // 提取引用内容
      const referContent = this.extractXmlValue(referMsgXml, 'content')
      const referType = this.extractXmlValue(referMsgXml, 'type')
      
      // 根据类型渲染引用内容
      let displayContent = referContent
      switch (referType) {
        case '1':
          // 文本消息，清理可能的 wxid
          displayContent = this.sanitizeQuotedContent(referContent)
          break
        case '3':
          displayContent = '[图片]'
          break
        case '34':
          displayContent = '[语音]'
          break
        case '43':
          displayContent = '[视频]'
          break
        case '47':
          displayContent = '[动画表情]'
          break
        case '49':
          displayContent = '[链接]'
          break
        case '42':
          displayContent = '[名片]'
          break
        case '48':
          displayContent = '[位置]'
          break
        default:
          if (!referContent || referContent.includes('wxid_')) {
            displayContent = '[消息]'
          } else {
            displayContent = this.sanitizeQuotedContent(referContent)
          }
      }

      return { 
        content: displayContent, 
        sender: displayName || undefined
      }
    } catch {
      return {}
    }
  }

  /**
   * 判断是否像 wxid
   */
  private looksLikeWxid(text: string): boolean {
    if (!text) return false
    const trimmed = text.trim().toLowerCase()
    if (trimmed.startsWith('wxid_')) return true
    return /^wx[a-z0-9_-]{4,}$/.test(trimmed)
  }

  /**
   * 清理引用内容中的 wxid
   */
  private sanitizeQuotedContent(content: string): string {
    if (!content) return ''
    let result = content
    // 去掉 wxid_xxx
    result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
    // 去掉开头的分隔符
    result = result.replace(/^[\s:：\-]+/, '')
    // 折叠重复分隔符
    result = result.replace(/[:：]{2,}/g, ':')
    result = result.replace(/^[\s:：\-]+/, '')
    // 标准化空白
    result = result.replace(/\s+/g, ' ').trim()
    return result
  }

  private getMessageTypeLabel(localType: number): string {
    const labels: Record<number, string> = {
      1: '[文本]',
      3: '[图片]',
      34: '[语音]',
      42: '[名片]',
      43: '[视频]',
      47: '[表情]',
      48: '[位置]',
      49: '[链接]',
      50: '[通话]',
      10000: '[系统消息]'
    }
    return labels[localType] || '[消息]'
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
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

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
  }

  private decodeHtmlEntities(content: string): string {
    return content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  }

  private cleanString(str: string): string {
    if (!str) return ''
    if (Buffer.isBuffer(str)) {
      str = str.toString('utf-8')
    }
    return String(str).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
  }

  /**
   * 解码消息内容（处理 BLOB 和压缩数据）
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    // 优先使用 compress_content
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  /**
   * 尝试解码可能压缩的内容
   */
  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    
    // 如果是 Buffer/Uint8Array
    if (Buffer.isBuffer(raw)) {
      return this.decodeBinaryContent(raw)
    }
    
    // 如果是字符串
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      
      // 检查是否是 hex 编码
      if (this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) {
          return this.decodeBinaryContent(bytes)
        }
      }
      
      // 检查是否是 base64 编码
      if (this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch {}
      }
      
      // 普通字符串
      return raw
    }
    
    return ''
  }

  /**
   * 解码二进制内容（处理 zstd 压缩）
   */
  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    
    try {
      // 检查是否是 zstd 压缩数据 (magic number: 0xFD2FB528)
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          // zstd 压缩，需要解压
          try {
            const decompressed = fzstd.decompress(data)
            return Buffer.from(decompressed).toString('utf-8')
          } catch (e) {
            console.error('zstd 解压失败:', e)
          }
        }
      }
      
      // 尝试直接 UTF-8 解码
      const decoded = data.toString('utf-8')
      // 检查是否有太多替换字符
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      
      // 尝试 latin1 解码
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  /**
   * 检查是否像 hex 编码
   */
  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  /**
   * 检查是否像 base64 编码
   */
  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  private shouldKeepSession(username: string): boolean {
    if (!username) return false
    if (username.startsWith('gh_')) return false
    
    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm'
    ]
    
    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }

    if (username.includes('@kefu.openim') || username.includes('@openim')) return false
    if (username.includes('service_')) return false

    return true
  }

  async getContact(username: string): Promise<Contact | null> {
    try {
      const result = await wcdbService.getContact(username)
      if (!result.success || !result.contact) return null
      return {
        username: result.contact.username || username,
        alias: result.contact.alias || '',
        remark: result.contact.remark || '',
        nickName: result.contact.nickName || ''
      }
    } catch {
      return null
    }
  }

  /**
   * 获取联系人头像和显示名称（用于群聊消息）
   */
  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string } | null> {
    if (!username) return null

    try {
      const cached = this.avatarCache.get(username)
      if (cached && Date.now() - cached.updatedAt < this.avatarCacheTtlMs) {
        return { avatarUrl: cached.avatarUrl, displayName: cached.displayName }
      }

      const contact = await this.getContact(username)
      const avatarResult = await wcdbService.getAvatarUrls([username])
      const avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined
      const displayName = contact?.remark || contact?.nickName || contact?.alias || username
      this.avatarCache.set(username, { avatarUrl, displayName, updatedAt: Date.now() })
      return { avatarUrl, displayName }
    } catch {
      return null
    }
  }

  /**
   * 获取当前用户的头像 URL
   */
  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    try {
      if (!this.connected) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      const myWxid = this.configService.get('myWxid')
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      const cleanedWxid = this.cleanAccountDirName(myWxid)
      const result = await wcdbService.getAvatarUrls([myWxid, cleanedWxid])
      if (result.success && result.map) {
        const avatarUrl = result.map[myWxid] || result.map[cleanedWxid]
        return { success: true, avatarUrl }
      }
      return { success: true, avatarUrl: undefined }
    } catch (e) {
      console.error('ChatService: 获取当前用户头像失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取表情包缓存目录
   */
  private getEmojiCacheDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) {
      return path.join(cachePath, 'Emojis')
    }
    // 回退到默认目录
    const documentsPath = app.getPath('documents')
    return path.join(documentsPath, 'WeFlow', 'Emojis')
  }

  /**
   * 下载并缓存表情包
   */
  async downloadEmoji(cdnUrl: string, md5?: string): Promise<{ success: boolean; localPath?: string; error?: string }> {
    if (!cdnUrl) {
      return { success: false, error: '无效的 CDN URL' }
    }

    // 生成缓存 key
    const cacheKey = md5 || this.hashString(cdnUrl)
    
    // 检查内存缓存
    const cached = emojiCache.get(cacheKey)
    if (cached && fs.existsSync(cached)) {
      // 读取文件并转为 data URL
      const dataUrl = this.fileToDataUrl(cached)
      if (dataUrl) {
        return { success: true, localPath: dataUrl }
      }
    }

    // 检查是否正在下载
    const downloading = emojiDownloading.get(cacheKey)
    if (downloading) {
      const result = await downloading
      if (result) {
        const dataUrl = this.fileToDataUrl(result)
        if (dataUrl) {
          return { success: true, localPath: dataUrl }
        }
      }
      return { success: false, error: '下载失败' }
    }

    // 确保缓存目录存在
    const cacheDir = this.getEmojiCacheDir()
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // 检查本地是否已有缓存文件
    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = path.join(cacheDir, `${cacheKey}${ext}`)
      if (fs.existsSync(filePath)) {
        emojiCache.set(cacheKey, filePath)
        const dataUrl = this.fileToDataUrl(filePath)
        if (dataUrl) {
          return { success: true, localPath: dataUrl }
        }
      }
    }

    // 开始下载
    const downloadPromise = this.doDownloadEmoji(cdnUrl, cacheKey, cacheDir)
    emojiDownloading.set(cacheKey, downloadPromise)

    try {
      const localPath = await downloadPromise
      emojiDownloading.delete(cacheKey)
      
      if (localPath) {
        emojiCache.set(cacheKey, localPath)
        const dataUrl = this.fileToDataUrl(localPath)
        if (dataUrl) {
          return { success: true, localPath: dataUrl }
        }
      }
      return { success: false, error: '下载失败' }
    } catch (e) {
      emojiDownloading.delete(cacheKey)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 将文件转为 data URL
   */
  private fileToDataUrl(filePath: string): string | null {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.gif': 'image/gif',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
      }
      const mimeType = mimeTypes[ext] || 'image/gif'
      const data = fs.readFileSync(filePath)
      return `data:${mimeType};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  /**
   * 执行表情包下载
   */
  private doDownloadEmoji(url: string, cacheKey: string, cacheDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      const protocol = url.startsWith('https') ? https : http
      
      const request = protocol.get(url, (response) => {
        // 处理重定向
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            this.doDownloadEmoji(redirectUrl, cacheKey, cacheDir).then(resolve)
            return
          }
        }

        if (response.statusCode !== 200) {
          resolve(null)
          return
        }

        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.length === 0) {
            resolve(null)
            return
          }

          // 检测文件类型
          const ext = this.detectImageExtension(buffer) || this.getExtFromUrl(url) || '.gif'
          const filePath = path.join(cacheDir, `${cacheKey}${ext}`)

          try {
            fs.writeFileSync(filePath, buffer)
            resolve(filePath)
          } catch {
            resolve(null)
          }
        })
        response.on('error', () => resolve(null))
      })

      request.on('error', () => resolve(null))
      request.setTimeout(10000, () => {
        request.destroy()
        resolve(null)
      })
    })
  }

  /**
   * 检测图片格式
   */
  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null

    // GIF
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return '.gif'
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return '.png'
    }
    // JPEG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return '.jpg'
    }
    // WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return '.webp'
    }

    return null
  }

  /**
   * 从 URL 获取扩展名
   */
  private getExtFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname
      const ext = path.extname(pathname).toLowerCase()
      if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return ext
      }
    } catch {}
    return null
  }

  /**
   * 简单的字符串哈希
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * 获取会话详情信息
   */
  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: {
      wxid: string
      displayName: string
      remark?: string
      nickName?: string
      alias?: string
      avatarUrl?: string
      messageCount: number
      firstMessageTime?: number
      latestMessageTime?: number
      messageTables: { dbName: string; tableName: string; count: number }[]
    }
    error?: string
  }> {
    try {
      if (!this.connected) {
        return { success: false, error: '数据库未连接' }
      }

      let displayName = sessionId
      let remark: string | undefined
      let nickName: string | undefined
      let alias: string | undefined
      let avatarUrl: string | undefined

      const contactResult = await wcdbService.getContact(sessionId)
      if (contactResult.success && contactResult.contact) {
        remark = contactResult.contact.remark || undefined
        nickName = contactResult.contact.nickName || undefined
        alias = contactResult.contact.alias || undefined
        displayName = remark || nickName || alias || sessionId
      }
      const avatarResult = await wcdbService.getAvatarUrls([sessionId])
      if (avatarResult.success && avatarResult.map) {
        avatarUrl = avatarResult.map[sessionId]
      }

      const countResult = await wcdbService.getMessageCount(sessionId)
      const totalMessageCount = countResult.success && countResult.count ? countResult.count : 0

      let firstMessageTime: number | undefined
      let latestMessageTime: number | undefined

      const earliestCursor = await wcdbService.openMessageCursor(sessionId, 1, true, 0, 0)
      if (earliestCursor.success && earliestCursor.cursor) {
        const batch = await wcdbService.fetchMessageBatch(earliestCursor.cursor)
        if (batch.success && batch.rows && batch.rows.length > 0) {
          firstMessageTime = parseInt(batch.rows[0].create_time || '0', 10) || undefined
        }
        await wcdbService.closeMessageCursor(earliestCursor.cursor)
      }

      const latestCursor = await wcdbService.openMessageCursor(sessionId, 1, false, 0, 0)
      if (latestCursor.success && latestCursor.cursor) {
        const batch = await wcdbService.fetchMessageBatch(latestCursor.cursor)
        if (batch.success && batch.rows && batch.rows.length > 0) {
          latestMessageTime = parseInt(batch.rows[0].create_time || '0', 10) || undefined
        }
        await wcdbService.closeMessageCursor(latestCursor.cursor)
      }

      const messageTables: { dbName: string; tableName: string; count: number }[] = []
      const tableStats = await wcdbService.getMessageTableStats(sessionId)
      if (tableStats.success && tableStats.tables) {
        for (const row of tableStats.tables) {
          messageTables.push({
            dbName: path.basename(row.db_path || ''),
            tableName: row.table_name || '',
            count: parseInt(row.count || '0', 10)
          })
        }
      }

      return {
        success: true,
        detail: {
          wxid: sessionId,
          displayName,
          remark,
          nickName,
          alias,
          avatarUrl,
          messageCount: totalMessageCount,
          firstMessageTime,
          latestMessageTime,
          messageTables
        }
      }
    } catch (e) {
      console.error('ChatService: 获取会话详情失败:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const chatService = new ChatService()
