/**
 * HTTP API 服务
 * 提供 ChatLab 标准化格式的消息查询 API
 */
import * as http from 'http'
import { URL } from 'url'
import { chatService, Message } from './chatService'
import { wcdbService } from './wcdbService'
import { ConfigService } from './config'

// ChatLab 格式定义
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
  groupAvatar?: string
  ownerId?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  aliases?: string[]
  avatar?: string
}

interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
  platformMessageId?: string
  replyToMessageId?: string
}

interface ChatLabData {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// ChatLab 消息类型映射
const ChatLabType = {
  TEXT: 0,
  IMAGE: 1,
  VOICE: 2,
  VIDEO: 3,
  FILE: 4,
  EMOJI: 5,
  LINK: 7,
  LOCATION: 8,
  RED_PACKET: 20,
  TRANSFER: 21,
  POKE: 22,
  CALL: 23,
  SHARE: 24,
  REPLY: 25,
  FORWARD: 26,
  CONTACT: 27,
  SYSTEM: 80,
  RECALL: 81,
  OTHER: 99
} as const

class HttpService {
  private server: http.Server | null = null
  private configService: ConfigService
  private port: number = 5031
  private running: boolean = false
  private connections: Set<import('net').Socket> = new Set()

  constructor() {
    this.configService = ConfigService.getInstance()
  }

  /**
   * 启动 HTTP 服务
   */
  async start(port: number = 5031): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.running && this.server) {
      return { success: true, port: this.port }
    }

    this.port = port

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))

      // 跟踪所有连接，以便关闭时能强制断开
      this.server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => {
          this.connections.delete(socket)
        })
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[HttpService] Port ${this.port} is already in use`)
          resolve({ success: false, error: `Port ${this.port} is already in use` })
        } else {
          console.error('[HttpService] Server error:', err)
          resolve({ success: false, error: err.message })
        }
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        this.running = true
        console.log(`[HttpService] HTTP API server started on http://127.0.0.1:${this.port}`)
        resolve({ success: true, port: this.port })
      })
    })
  }

  /**
   * 停止 HTTP 服务
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // 强制关闭所有活动连接
        for (const socket of this.connections) {
          socket.destroy()
        }
        this.connections.clear()

        this.server.close(() => {
          this.running = false
          this.server = null
          console.log('[HttpService] HTTP API server stopped')
          resolve()
        })
      } else {
        this.running = false
        resolve()
      }
    })
  }

  /**
   * 检查服务是否运行
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * 获取当前端口
   */
  getPort(): number {
    return this.port
  }

  /**
   * 处理 HTTP 请求
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
    const pathname = url.pathname

    try {
      // 路由处理
      if (pathname === '/health' || pathname === '/api/v1/health') {
        this.sendJson(res, { status: 'ok' })
      } else if (pathname === '/api/v1/messages') {
        await this.handleMessages(url, res)
      } else if (pathname === '/api/v1/sessions') {
        await this.handleSessions(url, res)
      } else if (pathname === '/api/v1/contacts') {
        await this.handleContacts(url, res)
      } else {
        this.sendError(res, 404, 'Not Found')
      }
    } catch (error) {
      console.error('[HttpService] Request error:', error)
      this.sendError(res, 500, String(error))
    }
  }

  /**
   * 批量获取消息（循环游标直到满足 limit）
   * 绕过 chatService 的单 batch 限制，直接操作 wcdbService 游标
   */
  private async fetchMessagesBatch(
    talker: string,
    offset: number,
    limit: number,
    startTime: number,
    endTime: number,
    ascending: boolean
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      // 使用固定 batch 大小（与 limit 相同或最大 500）来减少循环次数
      const batchSize = Math.min(limit, 500)
      const beginTimestamp = startTime > 10000000000 ? Math.floor(startTime / 1000) : startTime
      const endTimestamp = endTime > 10000000000 ? Math.floor(endTime / 1000) : endTime

      const cursorResult = await wcdbService.openMessageCursor(talker, batchSize, ascending, beginTimestamp, endTimestamp)
      if (!cursorResult.success || !cursorResult.cursor) {
        return { success: false, error: cursorResult.error || '打开消息游标失败' }
      }

      const cursor = cursorResult.cursor
      try {
        const allRows: Record<string, any>[] = []
        let hasMore = true
        let skipped = 0

        // 循环获取消息，处理 offset 跳过 + limit 累积
        while (allRows.length < limit && hasMore) {
          const batch = await wcdbService.fetchMessageBatch(cursor)
          if (!batch.success || !batch.rows || batch.rows.length === 0) {
            hasMore = false
            break
          }

          let rows = batch.rows
          hasMore = batch.hasMore === true

          // 处理 offset: 跳过前 N 条
          if (skipped < offset) {
            const remaining = offset - skipped
            if (remaining >= rows.length) {
              skipped += rows.length
              continue
            }
            rows = rows.slice(remaining)
            skipped = offset
          }

          allRows.push(...rows)
        }

        const trimmedRows = allRows.slice(0, limit)
        const finalHasMore = hasMore || allRows.length > limit
        const messages = this.mapRowsToMessagesSimple(trimmedRows)
        return { success: true, messages, hasMore: finalHasMore }
      } finally {
        await wcdbService.closeMessageCursor(cursor)
      }
    } catch (e) {
      console.error('[HttpService] fetchMessagesBatch error:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 简单的行数据到 Message 映射（用于 API 输出）
   */
  private mapRowsToMessagesSimple(rows: Record<string, any>[]): Message[] {
    const myWxid = this.configService.get('myWxid') || ''
    const messages: Message[] = []

    for (const row of rows) {
      const content = this.getField(row, ['message_content', 'messageContent', 'content', 'msg_content', 'WCDB_CT_message_content']) || ''
      const localType = parseInt(this.getField(row, ['local_type', 'localType', 'type', 'msg_type', 'WCDB_CT_local_type']) || '1', 10)
      const isSendRaw = this.getField(row, ['computed_is_send', 'computedIsSend', 'is_send', 'isSend', 'WCDB_CT_is_send'])
      const senderUsername = this.getField(row, ['sender_username', 'senderUsername', 'sender', 'WCDB_CT_sender_username']) || ''
      const createTime = parseInt(this.getField(row, ['create_time', 'createTime', 'msg_create_time', 'WCDB_CT_create_time']) || '0', 10)
      const localId = parseInt(this.getField(row, ['local_id', 'localId', 'WCDB_CT_local_id', 'rowid']) || '0', 10)
      const serverId = this.getField(row, ['server_id', 'serverId', 'WCDB_CT_server_id']) || ''

      let isSend: number
      if (isSendRaw !== null && isSendRaw !== undefined) {
        isSend = parseInt(isSendRaw, 10)
      } else if (senderUsername && myWxid) {
        isSend = senderUsername.toLowerCase() === myWxid.toLowerCase() ? 1 : 0
      } else {
        isSend = 0
      }

      // 解析消息内容中的特殊字段
      let parsedContent = content
      let xmlType: string | undefined
      let linkTitle: string | undefined
      let fileName: string | undefined
      let emojiCdnUrl: string | undefined
      let emojiMd5: string | undefined
      let imageMd5: string | undefined
      let videoMd5: string | undefined
      let cardNickname: string | undefined

      if (localType === 49 && content) {
        // 提取 type 子标签
        const typeMatch = /<type>(\d+)<\/type>/i.exec(content)
        if (typeMatch) xmlType = typeMatch[1]
        // 提取 title
        const titleMatch = /<title>([^<]*)<\/title>/i.exec(content)
        if (titleMatch) linkTitle = titleMatch[1]
        // 提取文件名
        const fnMatch = /<title>([^<]*)<\/title>/i.exec(content)
        if (fnMatch) fileName = fnMatch[1]
      }

      if (localType === 47 && content) {
        const cdnMatch = /cdnurl\s*=\s*"([^"]+)"/i.exec(content)
        if (cdnMatch) emojiCdnUrl = cdnMatch[1]
        const md5Match = /md5\s*=\s*"([^"]+)"/i.exec(content)
        if (md5Match) emojiMd5 = md5Match[1]
      }

      messages.push({
        localId,
        talker: '',
        localType,
        createTime,
        sortSeq: createTime,
        content: parsedContent,
        isSend,
        senderUsername,
        serverId: serverId ? parseInt(serverId, 10) || 0 : 0,
        rawContent: content,
        parsedContent: content,
        emojiCdnUrl,
        emojiMd5,
        imageMd5,
        videoMd5,
        xmlType,
        linkTitle,
        fileName,
        cardNickname
      } as Message)
    }

    return messages
  }

  /**
   * 从行数据中获取字段值（兼容多种字段名）
   */
  private getField(row: Record<string, any>, keys: string[]): string | null {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null) {
        return String(row[key])
      }
    }
    return null
  }

  /**
   * 处理消息查询
   * GET /api/v1/messages?talker=xxx&limit=100&start=20260101&chatlab=1
   */
  private async handleMessages(url: URL, res: http.ServerResponse): Promise<void> {
    const talker = url.searchParams.get('talker')
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 10000)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)
    const startParam = url.searchParams.get('start')
    const endParam = url.searchParams.get('end')
    const chatlab = url.searchParams.get('chatlab') === '1'
    const formatParam = url.searchParams.get('format')
    const format = formatParam || (chatlab ? 'chatlab' : 'json')

    if (!talker) {
      this.sendError(res, 400, 'Missing required parameter: talker')
      return
    }

    // 解析时间参数 (支持 YYYYMMDD 格式)
    const startTime = this.parseTimeParam(startParam)
    const endTime = this.parseTimeParam(endParam, true)

    // 使用批量获取方法，绕过 chatService 的单 batch 限制
    const result = await this.fetchMessagesBatch(talker, offset, limit, startTime, endTime, true)
    if (!result.success || !result.messages) {
      this.sendError(res, 500, result.error || 'Failed to get messages')
      return
    }

    if (format === 'chatlab') {
      // 获取会话显示名
      const displayNames = await this.getDisplayNames([talker])
      const talkerName = displayNames[talker] || talker

      const chatLabData = await this.convertToChatLab(result.messages, talker, talkerName)
      this.sendJson(res, chatLabData)
    } else {
      // 返回原始消息格式
      this.sendJson(res, {
        success: true,
        talker,
        count: result.messages.length,
        hasMore: result.hasMore,
        messages: result.messages
      })
    }
  }

  /**
   * 处理会话列表查询
   * GET /api/v1/sessions?keyword=xxx&limit=100
   */
  private async handleSessions(url: URL, res: http.ServerResponse): Promise<void> {
    const keyword = url.searchParams.get('keyword') || ''
    const limit = parseInt(url.searchParams.get('limit') || '100', 10)

    try {
      const sessions = await chatService.getSessions()
      if (!sessions.success || !sessions.sessions) {
        this.sendError(res, 500, sessions.error || 'Failed to get sessions')
        return
      }

      let filteredSessions = sessions.sessions
      if (keyword) {
        const lowerKeyword = keyword.toLowerCase()
        filteredSessions = sessions.sessions.filter(s => 
          s.username.toLowerCase().includes(lowerKeyword) ||
          (s.displayName && s.displayName.toLowerCase().includes(lowerKeyword))
        )
      }

      // 应用 limit
      const limitedSessions = filteredSessions.slice(0, limit)

      this.sendJson(res, {
        success: true,
        count: limitedSessions.length,
        sessions: limitedSessions.map(s => ({
          username: s.username,
          displayName: s.displayName,
          type: s.type,
          lastTimestamp: s.lastTimestamp,
          unreadCount: s.unreadCount
        }))
      })
    } catch (error) {
      this.sendError(res, 500, String(error))
    }
  }

  /**
   * 处理联系人查询
   * GET /api/v1/contacts?keyword=xxx&limit=100
   */
  private async handleContacts(url: URL, res: http.ServerResponse): Promise<void> {
    const keyword = url.searchParams.get('keyword') || ''
    const limit = parseInt(url.searchParams.get('limit') || '100', 10)

    try {
      const contacts = await chatService.getContacts()
      if (!contacts.success || !contacts.contacts) {
        this.sendError(res, 500, contacts.error || 'Failed to get contacts')
        return
      }

      let filteredContacts = contacts.contacts
      if (keyword) {
        const lowerKeyword = keyword.toLowerCase()
        filteredContacts = contacts.contacts.filter(c =>
          c.username.toLowerCase().includes(lowerKeyword) ||
          (c.nickname && c.nickname.toLowerCase().includes(lowerKeyword)) ||
          (c.remark && c.remark.toLowerCase().includes(lowerKeyword)) ||
          (c.displayName && c.displayName.toLowerCase().includes(lowerKeyword))
        )
      }

      const limited = filteredContacts.slice(0, limit)

      this.sendJson(res, {
        success: true,
        count: limited.length,
        contacts: limited
      })
    } catch (error) {
      this.sendError(res, 500, String(error))
    }
  }

  /**
   * 解析时间参数
   * 支持 YYYYMMDD 格式，返回秒级时间戳
   */
  private parseTimeParam(param: string | null, isEnd: boolean = false): number {
    if (!param) return 0

    // 纯数字且长度为8，视为 YYYYMMDD
    if (/^\d{8}$/.test(param)) {
      const year = parseInt(param.slice(0, 4), 10)
      const month = parseInt(param.slice(4, 6), 10) - 1
      const day = parseInt(param.slice(6, 8), 10)
      const date = new Date(year, month, day)
      if (isEnd) {
        // 结束时间设为当天 23:59:59
        date.setHours(23, 59, 59, 999)
      }
      return Math.floor(date.getTime() / 1000)
    }

    // 纯数字，视为时间戳
    if (/^\d+$/.test(param)) {
      const ts = parseInt(param, 10)
      // 如果是毫秒级时间戳，转为秒级
      return ts > 10000000000 ? Math.floor(ts / 1000) : ts
    }

    return 0
  }

  /**
   * 获取显示名称
   */
  private async getDisplayNames(usernames: string[]): Promise<Record<string, string>> {
    try {
      const result = await wcdbService.getDisplayNames(usernames)
      if (result.success && result.map) {
        return result.map
      }
    } catch (e) {
      console.error('[HttpService] Failed to get display names:', e)
    }
    // 返回空对象，调用方会使用 username 作为备用
    return {}
  }

  /**
   * 转换为 ChatLab 格式
   */
  private async convertToChatLab(messages: Message[], talkerId: string, talkerName: string): Promise<ChatLabData> {
    const isGroup = talkerId.endsWith('@chatroom')
    const myWxid = this.configService.get('myWxid') || ''

    // 收集所有发送者
    const senderSet = new Set<string>()
    for (const msg of messages) {
      if (msg.senderUsername) {
        senderSet.add(msg.senderUsername)
      }
    }

    // 获取发送者显示名
    const senderNames = await this.getDisplayNames(Array.from(senderSet))

    // 获取群昵称（如果是群聊）
    let groupNicknamesMap = new Map<string, string>()
    if (isGroup) {
      try {
        const result = await wcdbService.getGroupNicknames(talkerId)
        if (result.success && result.nicknames) {
          groupNicknamesMap = new Map(Object.entries(result.nicknames))
        }
      } catch (e) {
        console.error('[HttpService] Failed to get group nicknames:', e)
      }
    }

    // 构建成员列表
    const memberMap = new Map<string, ChatLabMember>()
    for (const msg of messages) {
      const sender = msg.senderUsername || ''
      if (sender && !memberMap.has(sender)) {
        const displayName = senderNames[sender] || sender
        const isSelf = sender === myWxid || sender.toLowerCase() === myWxid.toLowerCase()
        // 获取群昵称（尝试多种方式）
        const groupNickname = isGroup 
          ? (groupNicknamesMap.get(sender) || groupNicknamesMap.get(sender.toLowerCase()) || '')
          : ''
        memberMap.set(sender, {
          platformId: sender,
          accountName: isSelf ? '我' : displayName,
          groupNickname: groupNickname || undefined
        })
      }
    }

    // 转换消息
    const chatLabMessages: ChatLabMessage[] = messages.map(msg => {
      const sender = msg.senderUsername || ''
      const isSelf = msg.isSend === 1 || sender === myWxid
      const accountName = isSelf ? '我' : (senderNames[sender] || sender)
      // 获取该发送者的群昵称
      const groupNickname = isGroup 
        ? (groupNicknamesMap.get(sender) || groupNicknamesMap.get(sender.toLowerCase()) || '')
        : ''

      return {
        sender,
        accountName,
        groupNickname: groupNickname || undefined,
        timestamp: msg.createTime,
        type: this.mapMessageType(msg.localType, msg),
        content: this.getMessageContent(msg),
        platformMessageId: msg.serverId ? String(msg.serverId) : undefined
      }
    })

    return {
      chatlab: {
        version: '0.0.2',
        exportedAt: Math.floor(Date.now() / 1000),
        generator: 'WeFlow'
      },
      meta: {
        name: talkerName,
        platform: 'wechat',
        type: isGroup ? 'group' : 'private',
        groupId: isGroup ? talkerId : undefined,
        ownerId: myWxid || undefined
      },
      members: Array.from(memberMap.values()),
      messages: chatLabMessages
    }
  }

  /**
   * 映射 WeChat 消息类型到 ChatLab 类型
   */
  private mapMessageType(localType: number, msg: Message): number {
    switch (localType) {
      case 1: // 文本
        return ChatLabType.TEXT
      case 3: // 图片
        return ChatLabType.IMAGE
      case 34: // 语音
        return ChatLabType.VOICE
      case 43: // 视频
        return ChatLabType.VIDEO
      case 47: // 动画表情
        return ChatLabType.EMOJI
      case 48: // 位置
        return ChatLabType.LOCATION
      case 42: // 名片
        return ChatLabType.CONTACT
      case 50: // 语音/视频通话
        return ChatLabType.CALL
      case 10000: // 系统消息
        return ChatLabType.SYSTEM
      case 49: // 复合消息
        return this.mapType49(msg)
      case 244813135921: // 引用消息
        return ChatLabType.REPLY
      case 266287972401: // 拍一拍
        return ChatLabType.POKE
      case 8594229559345: // 红包
        return ChatLabType.RED_PACKET
      case 8589934592049: // 转账
        return ChatLabType.TRANSFER
      default:
        return ChatLabType.OTHER
    }
  }

  /**
   * 映射 Type 49 子类型
   */
  private mapType49(msg: Message): number {
    const xmlType = msg.xmlType

    switch (xmlType) {
      case '5': // 链接
      case '49':
        return ChatLabType.LINK
      case '6': // 文件
        return ChatLabType.FILE
      case '19': // 聊天记录
        return ChatLabType.FORWARD
      case '33': // 小程序
      case '36':
        return ChatLabType.SHARE
      case '57': // 引用消息
        return ChatLabType.REPLY
      case '2000': // 转账
        return ChatLabType.TRANSFER
      case '2001': // 红包
        return ChatLabType.RED_PACKET
      default:
        return ChatLabType.OTHER
    }
  }

  /**
   * 获取消息内容
   */
  private getMessageContent(msg: Message): string | null {
    // 优先使用已解析的内容
    if (msg.parsedContent) {
      return msg.parsedContent
    }

    // 根据类型返回占位符
    switch (msg.localType) {
      case 1:
        return msg.rawContent || null
      case 3:
        return msg.imageMd5 || '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return msg.videoMd5 || '[视频]'
      case 47:
        return msg.emojiCdnUrl || msg.emojiMd5 || '[表情]'
      case 42:
        return msg.cardNickname || '[名片]'
      case 48:
        return '[位置]'
      case 49:
        return msg.linkTitle || msg.fileName || '[消息]'
      default:
        return msg.rawContent || null
    }
  }

  /**
   * 发送 JSON 响应
   */
  private sendJson(res: http.ServerResponse, data: any): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.writeHead(200)
    res.end(JSON.stringify(data, null, 2))
  }

  /**
   * 发送错误响应
   */
  private sendError(res: http.ServerResponse, code: number, message: string): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.writeHead(code)
    res.end(JSON.stringify({ error: message }))
  }
}

export const httpService = new HttpService()
