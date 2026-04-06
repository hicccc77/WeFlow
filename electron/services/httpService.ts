/**
 * HTTP API 服务
 * 提供 ChatLab 标准化格式的消息查询 API
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { URL } from 'url'
import { timingSafeEqual } from 'crypto'
import { chatService, Message } from './chatService'
import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { videoService } from './videoService'
import { imageDecryptService } from './imageDecryptService'
import { groupAnalyticsService } from './groupAnalyticsService'
import { snsService } from './snsService'

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
  mediaPath?: string
}

interface ChatLabData {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

interface ApiMediaOptions {
  enabled: boolean
  exportImages: boolean
  exportVoices: boolean
  exportVideos: boolean
  exportEmojis: boolean
}

type MediaKind = 'image' | 'voice' | 'video' | 'emoji'

interface ApiExportedMedia {
  kind: MediaKind
  fileName: string
  fullPath: string
  relativePath: string
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
  private host: string = '127.0.0.1'
  private running: boolean = false
  private connections: Set<import('net').Socket> = new Set()
  private messagePushClients: Set<http.ServerResponse> = new Set()
  private messagePushHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  private connectionMutex: boolean = false

  constructor() {
    this.configService = ConfigService.getInstance()
  }

  /**
   * 启动 HTTP 服务
   */
  async start(port: number = 5031, host: string = '127.0.0.1'): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.running && this.server) {
      return { success: true, port: this.port }
    }

    this.port = port
    this.host = host

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))

      // 跟踪所有连接，以便关闭时能强制断开
      this.server.on('connection', (socket) => {
        // 使用互斥锁防止并发修改
        if (!this.connectionMutex) {
          this.connectionMutex = true
          this.connections.add(socket)
          this.connectionMutex = false
        }
        
        socket.on('close', () => {
          // 使用互斥锁防止并发修改
          if (!this.connectionMutex) {
            this.connectionMutex = true
            this.connections.delete(socket)
            this.connectionMutex = false
          }
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

      this.server.listen(this.port, this.host, () => {
        this.running = true
        this.startMessagePushHeartbeat()
        console.log(`[HttpService] HTTP API server started on http://${this.host}:${this.port}`)
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
        for (const client of this.messagePushClients) {
          try {
            client.end()
          } catch {}
        }
        this.messagePushClients.clear()
        if (this.messagePushHeartbeatTimer) {
          clearInterval(this.messagePushHeartbeatTimer)
          this.messagePushHeartbeatTimer = null
        }
        // 使用互斥锁保护连接集合操作
        this.connectionMutex = true
        const socketsToClose = Array.from(this.connections)
        this.connections.clear()
        this.connectionMutex = false
        
        // 强制关闭所有活动连接
        for (const socket of socketsToClose) {
          try {
            socket.destroy()
          } catch (err) {
            console.error('[HttpService] Error destroying socket:', err)
          }
        }

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

  getDefaultMediaExportPath(): string {
    return this.getApiMediaExportPath()
  }

  getMessagePushStreamUrl(): string {
    return `http://${this.host}:${this.port}/api/v1/push/messages`
  }

  broadcastMessagePush(payload: Record<string, unknown>): void {
    if (!this.running || this.messagePushClients.size === 0) return
    const eventBody = `event: message.new\ndata: ${JSON.stringify(payload)}\n\n`

    for (const client of Array.from(this.messagePushClients)) {
      try {
        if (client.writableEnded || client.destroyed) {
          this.messagePushClients.delete(client)
          continue
        }
        client.write(eventBody)
      } catch {
        this.messagePushClients.delete(client)
        try { client.end() } catch {}
      }
    }
  }

  async autoStart(): Promise<void> {
    const enabled = this.configService.get('httpApiEnabled')
    if (enabled) {
      const port = Number(this.configService.get('httpApiPort')) || 5031
      const host = String(this.configService.get('httpApiHost') || '127.0.0.1').trim() || '127.0.0.1'
      try {
        await this.start(port, host)
        console.log(`[HttpService] Auto-started on port ${port}`)
      } catch (err) {
        console.error('[HttpService] Auto-start failed:', err)
      }
    }
  }

    /**
     * 解析 POST 请求的 JSON Body
     */
    private async parseBody(req: http.IncomingMessage): Promise<Record<string, any>> {
        if (req.method !== 'POST') return {}
        const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB
        return new Promise((resolve) => {
            let body = ''
            let bodySize = 0
            req.on('data', chunk => {
                bodySize += chunk.length
                if (bodySize > MAX_BODY_SIZE) {
                    req.destroy()
                    resolve({})
                    return
                }
                body += chunk.toString()
            })
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body))
                } catch {
                    resolve({})
                }
            })
            req.on('error', () => resolve({}))
        })
    }

    /**
     * 鉴权拦截器
     */
    private safeEqual(a: string, b: string): boolean {
        const bufA = Buffer.from(a)
        const bufB = Buffer.from(b)
        if (bufA.length !== bufB.length) return false
        return timingSafeEqual(bufA, bufB)
    }

    private verifyToken(req: http.IncomingMessage, url: URL, body: Record<string, any>): boolean {
        const expectedToken = String(this.configService.get('httpApiToken') || '').trim()
        if (!expectedToken) {
            // token 未配置时拒绝所有请求，防止未授权访问
            console.warn('[HttpService] Access denied: httpApiToken not configured')
            return false
        }

        const authHeader = req.headers.authorization
        if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
            const token = authHeader.substring(7).trim()
            if (this.safeEqual(token, expectedToken)) return true
        }

        const queryToken = url.searchParams.get('access_token')
        if (queryToken && this.safeEqual(queryToken.trim(), expectedToken)) return true

        const bodyToken = body['access_token']
        return !!(bodyToken && this.safeEqual(String(bodyToken).trim(), expectedToken))
    }

    /**
     * 处理 HTTP 请求 (重构后)
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // 仅允许本地来源的跨域请求
        const origin = req.headers.origin || ''
        if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin)
            res.setHeader('Vary', 'Origin')
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
        }

        const url = new URL(req.url || '/', `http://${this.host}:${this.port}`)
        const pathname = url.pathname

        try {
            const bodyParams = await this.parseBody(req)

            for (const [key, value] of Object.entries(bodyParams)) {
                if (!url.searchParams.has(key)) {
                    url.searchParams.set(key, String(value))
                }
            }

            if (pathname !== '/health' && pathname !== '/api/v1/health') {
                if (!this.verifyToken(req, url, bodyParams)) {
                    this.sendError(res, 401, 'Unauthorized: Invalid or missing access_token')
                    return
                }
            }

            if (pathname === '/health' || pathname === '/api/v1/health') {
                this.sendJson(res, { status: 'ok' })
            } else if (pathname === '/api/v1/push/messages') {
                this.handleMessagePushStream(req, res)
            } else if (pathname === '/api/v1/messages') {
                await this.handleMessages(url, res)
            } else if (pathname === '/api/v1/sessions') {
                await this.handleSessions(url, res)
            } else if (pathname === '/api/v1/contacts') {
                await this.handleContacts(url, res)
            } else if (pathname === '/api/v1/group-members') {
                await this.handleGroupMembers(url, res)
            } else if (pathname === '/api/v1/sns/timeline') {
                if (req.method !== 'GET') return this.sendMethodNotAllowed(res, 'GET')
                await this.handleSnsTimeline(url, res)
            } else if (pathname === '/api/v1/sns/usernames') {
                if (req.method !== 'GET') return this.sendMethodNotAllowed(res, 'GET')
                await this.handleSnsUsernames(res)
            } else if (pathname === '/api/v1/sns/export/stats') {
                if (req.method !== 'GET') return this.sendMethodNotAllowed(res, 'GET')
                await this.handleSnsExportStats(url, res)
            } else if (pathname === '/api/v1/sns/media/proxy') {
                if (req.method !== 'GET') return this.sendMethodNotAllowed(res, 'GET')
                await this.handleSnsMediaProxy(url, res)
            } else if (pathname === '/api/v1/sns/export') {
                if (req.method !== 'POST') return this.sendMethodNotAllowed(res, 'POST')
                await this.handleSnsExport(url, res)
            } else if (pathname === '/api/v1/sns/block-delete/status') {
                if (req.method !== 'GET') return this.sendMethodNotAllowed(res, 'GET')
                await this.handleSnsBlockDeleteStatus(res)
            } else if (pathname === '/api/v1/sns/block-delete/install') {
                if (req.method !== 'POST') return this.sendMethodNotAllowed(res, 'POST')
                await this.handleSnsBlockDeleteInstall(res)
            } else if (pathname === '/api/v1/sns/block-delete/uninstall') {
                if (req.method !== 'POST') return this.sendMethodNotAllowed(res, 'POST')
                await this.handleSnsBlockDeleteUninstall(res)
            } else if (pathname.startsWith('/api/v1/sns/post/')) {
                if (req.method !== 'DELETE') return this.sendMethodNotAllowed(res, 'DELETE')
                await this.handleSnsDeletePost(pathname, res)
            } else if (pathname.startsWith('/api/v1/media/')) {
                this.handleMediaRequest(pathname, res)
            } else {
                this.sendError(res, 404, 'Not Found')
            }
        } catch (error) {
            console.error('[HttpService] Request error:', error)
            this.sendError(res, 500, String(error))
        }
    }
  private startMessagePushHeartbeat(): void {
    if (this.messagePushHeartbeatTimer) return
    this.messagePushHeartbeatTimer = setInterval(() => {
      for (const client of Array.from(this.messagePushClients)) {
        try {
          if (client.writableEnded || client.destroyed) {
            this.messagePushClients.delete(client)
            continue
          }
          client.write(': ping\n\n')
        } catch {
          this.messagePushClients.delete(client)
          try { client.end() } catch {}
        }
      }
    }, 25000)
  }

  private handleMessagePushStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.configService.get('messagePushEnabled') !== true) {
      this.sendError(res, 403, 'Message push is disabled')
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders?.()
    res.write(`event: ready\ndata: ${JSON.stringify({ success: true, stream: this.getMessagePushStreamUrl() })}\n\n`)

    this.messagePushClients.add(res)

    const cleanup = () => {
      this.messagePushClients.delete(res)
    }

    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  private handleMediaRequest(pathname: string, res: http.ServerResponse): void {
    const mediaBasePath = path.resolve(this.getApiMediaExportPath())
    const relativePath = pathname.replace('/api/v1/media/', '')
    const fullPath = path.resolve(mediaBasePath, relativePath)

    // 防止路径穿越攻击
    if (!fullPath.startsWith(mediaBasePath + path.sep) && fullPath !== mediaBasePath) {
      this.sendError(res, 403, 'Forbidden')
      return
    }

    if (!fs.existsSync(fullPath)) {
      this.sendError(res, 404, 'Media not found')
      return
    }

    const ext = path.extname(fullPath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4'
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream'

    try {
      const fileBuffer = fs.readFileSync(fullPath)
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', fileBuffer.length)
      res.writeHead(200)
      res.end(fileBuffer)
    } catch (e) {
      this.sendError(res, 500, 'Failed to read media file')
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
      // 使用固定 batch 大小（与 limit 相同或最多 500）来减少循环次数
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

          // 处理 offset：跳过前 N 条
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
        const messages = chatService.mapRowsToMessagesForApi(trimmedRows)
        await this.backfillMissingSenderUsernames(talker, messages)
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
   * Query param helpers.
   */
  private parseIntParam(value: string | null, defaultValue: number, min: number, max: number): number {
    const parsed = parseInt(value || '', 10)
    if (!Number.isFinite(parsed)) return defaultValue
    return Math.min(Math.max(parsed, min), max)
  }

  private async backfillMissingSenderUsernames(talker: string, messages: Message[]): Promise<void> {
    if (!talker.endsWith('@chatroom')) return

    const targets = messages.filter((msg) => !String(msg.senderUsername || '').trim())
    if (targets.length === 0) return

    const myWxid = (this.configService.get('myWxid') || '').trim()
    for (const msg of targets) {
      const localId = Number(msg.localId || 0)
      if (Number.isFinite(localId) && localId > 0) {
        try {
          const detail = await wcdbService.getMessageById(talker, localId)
          if (detail.success && detail.message) {
            const hydrated = chatService.mapRowsToMessagesForApi([detail.message])[0]
            if (hydrated?.senderUsername) {
              msg.senderUsername = hydrated.senderUsername
            }
            if ((msg.isSend === null || msg.isSend === undefined) && hydrated?.isSend !== undefined) {
              msg.isSend = hydrated.isSend
            }
            if (!msg.rawContent && hydrated?.rawContent) {
              msg.rawContent = hydrated.rawContent
            }
          }
        } catch (error) {
          console.warn('[HttpService] backfill sender failed:', error)
        }
      }

      if (!msg.senderUsername && msg.isSend === 1 && myWxid) {
        msg.senderUsername = myWxid
      }
    }
  }

  private parseBooleanParam(url: URL, keys: string[], defaultValue: boolean = false): boolean {
    for (const key of keys) {
      const raw = url.searchParams.get(key)
      if (raw === null) continue
      const normalized = raw.trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    }
    return defaultValue
  }

  private parseStringListParam(value: string | null): string[] | undefined {
    if (!value) return undefined
    const values = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    return values.length > 0 ? Array.from(new Set(values)) : undefined
  }

  private parseMediaOptions(url: URL): ApiMediaOptions {
    const mediaEnabled = this.parseBooleanParam(url, ['media', 'meiti'], false)
    if (!mediaEnabled) {
      return {
        enabled: false,
        exportImages: false,
        exportVoices: false,
        exportVideos: false,
        exportEmojis: false
      }
    }

    return {
      enabled: true,
      exportImages: this.parseBooleanParam(url, ['image', 'tupian'], true),
      exportVoices: this.parseBooleanParam(url, ['voice', 'vioce'], true),
      exportVideos: this.parseBooleanParam(url, ['video'], true),
      exportEmojis: this.parseBooleanParam(url, ['emoji'], true)
    }
  }

  private async handleMessages(url: URL, res: http.ServerResponse): Promise<void> {
    const talker = (url.searchParams.get('talker') || '').trim()
    const limit = this.parseIntParam(url.searchParams.get('limit'), 100, 1, 10000)
    const offset = this.parseIntParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    const keyword = (url.searchParams.get('keyword') || '').trim().toLowerCase()
    const startParam = url.searchParams.get('start')
    const endParam = url.searchParams.get('end')
    const chatlab = this.parseBooleanParam(url, ['chatlab'], false)
    const formatParam = (url.searchParams.get('format') || '').trim().toLowerCase()
    const format = formatParam || (chatlab ? 'chatlab' : 'json')
    const mediaOptions = this.parseMediaOptions(url)

    if (!talker) {
      this.sendError(res, 400, 'Missing required parameter: talker')
      return
    }

    if (format !== 'json' && format !== 'chatlab') {
      this.sendError(res, 400, 'Invalid format, supported: json/chatlab')
      return
    }

    const startTime = this.parseTimeParam(startParam)
    const endTime = this.parseTimeParam(endParam, true)
    const queryOffset = keyword ? 0 : offset
    const queryLimit = keyword ? 10000 : limit

    const result = await this.fetchMessagesBatch(talker, queryOffset, queryLimit, startTime, endTime, false)
    if (!result.success || !result.messages) {
      this.sendError(res, 500, result.error || 'Failed to get messages')
      return
    }

    let messages = result.messages
    let hasMore = result.hasMore === true

    if (keyword) {
      const filtered = messages.filter((msg) => {
        const content = (msg.parsedContent || msg.rawContent || '').toLowerCase()
        return content.includes(keyword)
      })
      const endIndex = offset + limit
      hasMore = filtered.length > endIndex
      messages = filtered.slice(offset, endIndex)
    }

    const mediaMap = mediaOptions.enabled
      ? await this.exportMediaForMessages(messages, talker, mediaOptions)
      : new Map<number, ApiExportedMedia>()

    const displayNames = await this.getDisplayNames([talker])
    const talkerName = displayNames[talker] || talker

    if (format === 'chatlab') {
      const chatLabData = await this.convertToChatLab(messages, talker, talkerName, mediaMap)
      this.sendJson(res, {
        ...chatLabData,
        media: {
          enabled: mediaOptions.enabled,
          exportPath: this.getApiMediaExportPath(),
          count: mediaMap.size
        }
      })
      return
    }

    const apiMessages = messages.map((msg) => this.toApiMessage(msg, mediaMap.get(msg.localId)))
    this.sendJson(res, {
      success: true,
      talker,
      count: apiMessages.length,
      hasMore,
      media: {
        enabled: mediaOptions.enabled,
        exportPath: this.getApiMediaExportPath(),
        count: mediaMap.size
      },
      messages: apiMessages
    })
  }

  /**
   * 处理会话列表查询
   * GET /api/v1/sessions?keyword=xxx&limit=100
   */
  private async handleSessions(url: URL, res: http.ServerResponse): Promise<void> {
    const keyword = (url.searchParams.get('keyword') || '').trim()
    const limit = this.parseIntParam(url.searchParams.get('limit'), 100, 1, 10000)

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
    const keyword = (url.searchParams.get('keyword') || '').trim()
    const limit = this.parseIntParam(url.searchParams.get('limit'), 100, 1, 10000)

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
   * 处理群成员查询
   * GET /api/v1/group-members?chatroomId=xxx@chatroom&includeMessageCounts=1&forceRefresh=0
   */
  private async handleGroupMembers(url: URL, res: http.ServerResponse): Promise<void> {
    const chatroomId = (url.searchParams.get('chatroomId') || url.searchParams.get('talker') || '').trim()
    const includeMessageCounts = this.parseBooleanParam(url, ['includeMessageCounts', 'withCounts'], false)
    const forceRefresh = this.parseBooleanParam(url, ['forceRefresh'], false)

    if (!chatroomId) {
      this.sendError(res, 400, 'Missing chatroomId')
      return
    }

    try {
      const result = await groupAnalyticsService.getGroupMembersPanelData(chatroomId, {
        forceRefresh,
        includeMessageCounts
      })
      if (!result.success || !result.data) {
        this.sendError(res, 500, result.error || 'Failed to get group members')
        return
      }

      this.sendJson(res, {
        success: true,
        chatroomId,
        count: result.data.length,
        fromCache: result.fromCache,
        updatedAt: result.updatedAt,
        members: result.data.map((member) => ({
          wxid: member.username,
          displayName: member.displayName,
          nickname: member.nickname || '',
          remark: member.remark || '',
          alias: member.alias || '',
          groupNickname: member.groupNickname || '',
          avatarUrl: member.avatarUrl,
          isOwner: Boolean(member.isOwner),
          isFriend: Boolean(member.isFriend),
          messageCount: Number.isFinite(member.messageCount) ? member.messageCount : 0
        }))
      })
    } catch (error) {
      this.sendError(res, 500, String(error))
    }
  }

  private async handleSnsTimeline(url: URL, res: http.ServerResponse): Promise<void> {
    const limit = this.parseIntParam(url.searchParams.get('limit'), 20, 1, 200)
    const offset = this.parseIntParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    const usernames = this.parseStringListParam(url.searchParams.get('usernames'))
    const keyword = (url.searchParams.get('keyword') || '').trim() || undefined
    const resolveMedia = this.parseBooleanParam(url, ['media', 'resolveMedia', 'meiti'], true)
    const inlineMedia = resolveMedia && this.parseBooleanParam(url, ['inline'], false)
    const replaceMedia = resolveMedia && this.parseBooleanParam(url, ['replace'], true)
    const startTimeRaw = this.parseTimeParam(url.searchParams.get('start'))
    const endTimeRaw = this.parseTimeParam(url.searchParams.get('end'), true)
    const startTime = startTimeRaw > 0 ? startTimeRaw : undefined
    const endTime = endTimeRaw > 0 ? endTimeRaw : undefined

    const result = await snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime)
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to get sns timeline')
      return
    }

    let timeline = result.timeline || []
    if (resolveMedia && timeline.length > 0) {
      timeline = await this.enrichSnsTimelineMedia(timeline, inlineMedia, replaceMedia)
    }

    this.sendJson(res, {
      success: true,
      count: timeline.length,
      timeline
    })
  }

  private async handleSnsUsernames(res: http.ServerResponse): Promise<void> {
    const result = await snsService.getSnsUsernames()
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to get sns usernames')
      return
    }
    this.sendJson(res, {
      success: true,
      usernames: result.usernames || []
    })
  }

  private async handleSnsExportStats(url: URL, res: http.ServerResponse): Promise<void> {
    const fast = this.parseBooleanParam(url, ['fast'], false)
    const result = fast
      ? await snsService.getExportStatsFast()
      : await snsService.getExportStats()
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to get sns export stats')
      return
    }
    this.sendJson(res, result)
  }

  private async handleSnsMediaProxy(url: URL, res: http.ServerResponse): Promise<void> {
    const mediaUrl = (url.searchParams.get('url') || '').trim()
    if (!mediaUrl) {
      this.sendError(res, 400, 'Missing required parameter: url')
      return
    }

    const key = this.toSnsMediaKey(url.searchParams.get('key'))
    const result = await snsService.downloadImage(mediaUrl, key)
    if (!result.success) {
      this.sendError(res, 502, result.error || 'Failed to proxy sns media')
      return
    }

    if (result.data) {
      res.setHeader('Content-Type', result.contentType || 'application/octet-stream')
      res.setHeader('Content-Length', result.data.length)
      res.writeHead(200)
      res.end(result.data)
      return
    }

    if (result.cachePath && fs.existsSync(result.cachePath)) {
      try {
        const stat = fs.statSync(result.cachePath)
        res.setHeader('Content-Type', result.contentType || 'application/octet-stream')
        res.setHeader('Content-Length', stat.size)
        res.writeHead(200)

        const stream = fs.createReadStream(result.cachePath)
        stream.on('error', () => {
          if (!res.headersSent) {
            this.sendError(res, 500, 'Failed to read proxied sns media')
          } else {
            try { res.destroy() } catch {}
          }
        })
        stream.pipe(res)
        return
      } catch (error) {
        console.error('[HttpService] Failed to stream sns media cache:', error)
      }
    }

    this.sendError(res, 502, result.error || 'Failed to proxy sns media')
  }

  private async handleSnsExport(url: URL, res: http.ServerResponse): Promise<void> {
    const outputDir = String(url.searchParams.get('outputDir') || '').trim()
    if (!outputDir) {
      this.sendError(res, 400, 'Missing required field: outputDir')
      return
    }

    const rawFormat = String(url.searchParams.get('format') || 'json').trim().toLowerCase()
    const format = rawFormat === 'arkme-json' ? 'arkmejson' : rawFormat
    if (!['json', 'html', 'arkmejson'].includes(format)) {
      this.sendError(res, 400, 'Invalid format, supported: json/html/arkmejson')
      return
    }

    const usernames = this.parseStringListParam(url.searchParams.get('usernames'))
    const keyword = String(url.searchParams.get('keyword') || '').trim() || undefined
    const startTimeRaw = this.parseTimeParam(url.searchParams.get('start'))
    const endTimeRaw = this.parseTimeParam(url.searchParams.get('end'), true)

    const options: {
      outputDir: string
      format: 'json' | 'html' | 'arkmejson'
      usernames?: string[]
      keyword?: string
      exportMedia?: boolean
      exportImages?: boolean
      exportLivePhotos?: boolean
      exportVideos?: boolean
      startTime?: number
      endTime?: number
    } = {
      outputDir,
      format: format as 'json' | 'html' | 'arkmejson',
      usernames,
      keyword,
      exportMedia: this.parseBooleanParam(url, ['exportMedia'], false)
    }

    if (url.searchParams.has('exportImages')) options.exportImages = this.parseBooleanParam(url, ['exportImages'], false)
    if (url.searchParams.has('exportLivePhotos')) options.exportLivePhotos = this.parseBooleanParam(url, ['exportLivePhotos'], false)
    if (url.searchParams.has('exportVideos')) options.exportVideos = this.parseBooleanParam(url, ['exportVideos'], false)
    if (startTimeRaw > 0) options.startTime = startTimeRaw
    if (endTimeRaw > 0) options.endTime = endTimeRaw

    const result = await snsService.exportTimeline(options)
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to export sns timeline')
      return
    }
    this.sendJson(res, result)
  }

  private async handleSnsBlockDeleteStatus(res: http.ServerResponse): Promise<void> {
    const result = await snsService.checkSnsBlockDeleteTrigger()
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to check sns block-delete status')
      return
    }
    this.sendJson(res, result)
  }

  private async handleSnsBlockDeleteInstall(res: http.ServerResponse): Promise<void> {
    const result = await snsService.installSnsBlockDeleteTrigger()
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to install sns block-delete trigger')
      return
    }
    this.sendJson(res, result)
  }

  private async handleSnsBlockDeleteUninstall(res: http.ServerResponse): Promise<void> {
    const result = await snsService.uninstallSnsBlockDeleteTrigger()
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to uninstall sns block-delete trigger')
      return
    }
    this.sendJson(res, result)
  }

  private async handleSnsDeletePost(pathname: string, res: http.ServerResponse): Promise<void> {
    const postId = decodeURIComponent(pathname.replace('/api/v1/sns/post/', '')).trim()
    if (!postId) {
      this.sendError(res, 400, 'Missing required path parameter: postId')
      return
    }

    const result = await snsService.deleteSnsPost(postId)
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to delete sns post')
      return
    }
    this.sendJson(res, result)
  }

  private toSnsMediaKey(value: unknown): string | number | undefined {
    if (value == null) return undefined
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const text = String(value).trim()
    if (!text) return undefined
    if (/^-?\d+$/.test(text)) return Number(text)
    return text
  }

  private buildSnsMediaProxyUrl(rawUrl: string, key?: string | number): string | undefined {
    const target = String(rawUrl || '').trim()
    if (!target) return undefined
    const params = new URLSearchParams({ url: target })
    if (key !== undefined) params.set('key', String(key))
    return `http://${this.host}:${this.port}/api/v1/sns/media/proxy?${params.toString()}`
  }

  private async resolveSnsMediaUrl(
    rawUrl: string,
    key: string | number | undefined,
    inline: boolean
  ): Promise<{ resolvedUrl?: string; proxyUrl?: string }> {
    const proxyUrl = this.buildSnsMediaProxyUrl(rawUrl, key)
    if (!proxyUrl) return {}
    if (!inline) return { resolvedUrl: proxyUrl, proxyUrl }

    try {
      const resolved = await snsService.proxyImage(rawUrl, key)
      if (resolved.success && resolved.dataUrl) {
        return { resolvedUrl: resolved.dataUrl, proxyUrl }
      }
    } catch (error) {
      console.warn('[HttpService] resolveSnsMediaUrl inline failed:', error)
    }

    return { resolvedUrl: proxyUrl, proxyUrl }
  }

  private async enrichSnsTimelineMedia(posts: any[], inline: boolean, replace: boolean): Promise<any[]> {
    return Promise.all(
      (posts || []).map(async (post) => {
        const mediaList = Array.isArray(post?.media) ? post.media : []
        if (mediaList.length === 0) return post

        const nextMedia = await Promise.all(
          mediaList.map(async (media: any) => {
            const rawUrl = typeof media?.url === 'string' ? media.url : ''
            const rawThumb = typeof media?.thumb === 'string' ? media.thumb : ''
            const mediaKey = this.toSnsMediaKey(media?.key)

            const [urlResolved, thumbResolved] = await Promise.all([
              this.resolveSnsMediaUrl(rawUrl, mediaKey, inline),
              this.resolveSnsMediaUrl(rawThumb, mediaKey, inline)
            ])

            const nextItem: any = {
              ...media,
              rawUrl,
              rawThumb,
              resolvedUrl: urlResolved.resolvedUrl,
              resolvedThumbUrl: thumbResolved.resolvedUrl,
              proxyUrl: urlResolved.proxyUrl,
              proxyThumbUrl: thumbResolved.proxyUrl
            }

            if (replace) {
              nextItem.url = urlResolved.resolvedUrl || rawUrl
              nextItem.thumb = thumbResolved.resolvedUrl || rawThumb
            }

            if (media?.livePhoto && typeof media.livePhoto === 'object') {
              const livePhoto = media.livePhoto
              const rawLiveUrl = typeof livePhoto.url === 'string' ? livePhoto.url : ''
              const rawLiveThumb = typeof livePhoto.thumb === 'string' ? livePhoto.thumb : ''
              const liveKey = this.toSnsMediaKey(livePhoto.key ?? mediaKey)

              const [liveUrlResolved, liveThumbResolved] = await Promise.all([
                this.resolveSnsMediaUrl(rawLiveUrl, liveKey, inline),
                this.resolveSnsMediaUrl(rawLiveThumb, liveKey, inline)
              ])

              const nextLive: any = {
                ...livePhoto,
                rawUrl: rawLiveUrl,
                rawThumb: rawLiveThumb,
                resolvedUrl: liveUrlResolved.resolvedUrl,
                resolvedThumbUrl: liveThumbResolved.resolvedUrl,
                proxyUrl: liveUrlResolved.proxyUrl,
                proxyThumbUrl: liveThumbResolved.proxyUrl
              }

              if (replace) {
                nextLive.url = liveUrlResolved.resolvedUrl || rawLiveUrl
                nextLive.thumb = liveThumbResolved.resolvedUrl || rawLiveThumb
              }

              nextItem.livePhoto = nextLive
            }

            return nextItem
          })
        )

        return {
          ...post,
          media: nextMedia
        }
      })
    )
  }

  private getApiMediaExportPath(): string {
    return path.join(this.configService.getCacheBasePath(), 'api-media')
  }

  private sanitizeFileName(value: string, fallback: string): string {
    const safe = (value || '')
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.+$/g, '')
    return safe || fallback
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  private detectImageExt(buffer: Buffer): string {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
    if (buffer.length >= 6) {
      const sig6 = buffer.subarray(0, 6).toString('ascii')
      if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return '.gif'
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
    if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp'
    return '.jpg'
  }

  private async exportMediaForMessages(
    messages: Message[],
    talker: string,
    options: ApiMediaOptions
  ): Promise<Map<number, ApiExportedMedia>> {
    const mediaMap = new Map<number, ApiExportedMedia>()
    if (!options.enabled || messages.length === 0) {
      return mediaMap
    }

    const sessionDir = path.join(this.getApiMediaExportPath(), this.sanitizeFileName(talker, 'session'))
    this.ensureDir(sessionDir)

    for (const msg of messages) {
      const exported = await this.exportMediaForMessage(msg, talker, sessionDir, options)
      if (exported) {
        mediaMap.set(msg.localId, exported)
      }
    }

    return mediaMap
  }

  private async exportMediaForMessage(
    msg: Message,
    talker: string,
    sessionDir: string,
    options: ApiMediaOptions
  ): Promise<ApiExportedMedia | null> {
    try {
      if (msg.localType === 3 && options.exportImages) {
        const result = await imageDecryptService.decryptImage({
          sessionId: talker,
          imageMd5: msg.imageMd5,
          imageDatName: msg.imageDatName,
          force: true
        })
        if (result.success && result.localPath) {
          let imagePath = result.localPath
          if (imagePath.startsWith('data:')) {
            const base64Match = imagePath.match(/^data:[^;]+;base64,(.+)$/)
            if (base64Match) {
              const imageBuffer = Buffer.from(base64Match[1], 'base64')
              const ext = this.detectImageExt(imageBuffer)
              const fileBase = this.sanitizeFileName(msg.imageMd5 || msg.imageDatName || `image_${msg.localId}`, `image_${msg.localId}`)
              const fileName = `${fileBase}${ext}`
              const targetDir = path.join(sessionDir, 'images')
              const fullPath = path.join(targetDir, fileName)
              this.ensureDir(targetDir)
              if (!fs.existsSync(fullPath)) {
                fs.writeFileSync(fullPath, imageBuffer)
              }
              const relativePath = `${this.sanitizeFileName(talker, 'session')}/images/${fileName}`
              return { kind: 'image', fileName, fullPath, relativePath }
            }
          } else if (fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath)
            const ext = this.detectImageExt(imageBuffer)
            const fileBase = this.sanitizeFileName(msg.imageMd5 || msg.imageDatName || `image_${msg.localId}`, `image_${msg.localId}`)
            const fileName = `${fileBase}${ext}`
            const targetDir = path.join(sessionDir, 'images')
            const fullPath = path.join(targetDir, fileName)
            this.ensureDir(targetDir)
            if (!fs.existsSync(fullPath)) {
              fs.copyFileSync(imagePath, fullPath)
            }
            const relativePath = `${this.sanitizeFileName(talker, 'session')}/images/${fileName}`
            return { kind: 'image', fileName, fullPath, relativePath }
          }
        }
      }

      if (msg.localType === 34 && options.exportVoices) {
        const result = await chatService.getVoiceData(
          talker,
          String(msg.localId),
          msg.createTime || undefined,
          msg.serverId || undefined
        )
        if (result.success && result.data) {
          const fileName = `voice_${msg.localId}.wav`
          const targetDir = path.join(sessionDir, 'voices')
          const fullPath = path.join(targetDir, fileName)
          this.ensureDir(targetDir)
          if (!fs.existsSync(fullPath)) {
            fs.writeFileSync(fullPath, Buffer.from(result.data, 'base64'))
          }
          const relativePath = `${this.sanitizeFileName(talker, 'session')}/voices/${fileName}`
          return { kind: 'voice', fileName, fullPath, relativePath }
        }
      }

      if (msg.localType === 43 && options.exportVideos && msg.videoMd5) {
        const info = await videoService.getVideoInfo(msg.videoMd5)
        if (info.exists && info.videoUrl && fs.existsSync(info.videoUrl)) {
          const ext = path.extname(info.videoUrl) || '.mp4'
          const fileName = `${this.sanitizeFileName(msg.videoMd5, `video_${msg.localId}`)}${ext}`
          const targetDir = path.join(sessionDir, 'videos')
          const fullPath = path.join(targetDir, fileName)
          this.ensureDir(targetDir)
          if (!fs.existsSync(fullPath)) {
            fs.copyFileSync(info.videoUrl, fullPath)
          }
          const relativePath = `${this.sanitizeFileName(talker, 'session')}/videos/${fileName}`
          return { kind: 'video', fileName, fullPath, relativePath }
        }
      }

      if (msg.localType === 47 && options.exportEmojis && msg.emojiCdnUrl) {
        const result = await chatService.downloadEmoji(msg.emojiCdnUrl, msg.emojiMd5)
        if (result.success && result.localPath && fs.existsSync(result.localPath)) {
          const sourceExt = path.extname(result.localPath) || '.gif'
          const fileName = `${this.sanitizeFileName(msg.emojiMd5 || `emoji_${msg.localId}`, `emoji_${msg.localId}`)}${sourceExt}`
          const targetDir = path.join(sessionDir, 'emojis')
          const fullPath = path.join(targetDir, fileName)
          this.ensureDir(targetDir)
          if (!fs.existsSync(fullPath)) {
            fs.copyFileSync(result.localPath, fullPath)
          }
          const relativePath = `${this.sanitizeFileName(talker, 'session')}/emojis/${fileName}`
          return { kind: 'emoji', fileName, fullPath, relativePath }
        }
      }
    } catch (e) {
      console.warn('[HttpService] exportMediaForMessage failed:', e)
    }

    return null
  }

  private toApiMessage(msg: Message, media?: ApiExportedMedia): Record<string, any> {
    return {
      localId: msg.localId,
      serverId: msg.serverId,
      localType: msg.localType,
      createTime: msg.createTime,
      sortSeq: msg.sortSeq,
      isSend: msg.isSend,
      senderUsername: msg.senderUsername,
      content: this.getMessageContent(msg),
      rawContent: msg.rawContent,
      parsedContent: msg.parsedContent,
      mediaType: media?.kind,
      mediaFileName: media?.fileName,
      mediaUrl: media ? `http://${this.host}:${this.port}/api/v1/media/${media.relativePath}` : undefined,
      mediaLocalPath: media?.fullPath
    }
  }

  /**
   * 解析时间参数
   * 支持 YYYYMMDD 格式，返回秒级时间戳
   */
  private parseTimeParam(param: string | null, isEnd: boolean = false): number {
    if (!param) return 0

    // 纯数字且长度为 8，视为 YYYYMMDD
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

  private normalizeAccountId(value: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
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

  private async getAvatarUrls(usernames: string[]): Promise<Record<string, string>> {
    const lookupUsernames = Array.from(new Set(
      usernames.flatMap((username) => {
        const normalized = String(username || '').trim()
        if (!normalized) return []
        const cleaned = this.normalizeAccountId(normalized)
        return cleaned && cleaned !== normalized ? [normalized, cleaned] : [normalized]
      })
    ))

    if (lookupUsernames.length === 0) return {}

    try {
      const result = await wcdbService.getAvatarUrls(lookupUsernames)
      if (result.success && result.map) {
        const avatarMap: Record<string, string> = {}
        for (const [username, avatarUrl] of Object.entries(result.map)) {
          const normalizedUsername = String(username || '').trim()
          const normalizedAvatarUrl = String(avatarUrl || '').trim()
          if (!normalizedUsername || !normalizedAvatarUrl) continue

          avatarMap[normalizedUsername] = normalizedAvatarUrl
          avatarMap[normalizedUsername.toLowerCase()] = normalizedAvatarUrl

          const cleaned = this.normalizeAccountId(normalizedUsername)
          if (cleaned) {
            avatarMap[cleaned] = normalizedAvatarUrl
            avatarMap[cleaned.toLowerCase()] = normalizedAvatarUrl
          }
        }
        return avatarMap
      }
    } catch (e) {
      console.error('[HttpService] Failed to get avatar urls:', e)
    }

    return {}
  }

  private resolveAvatarUrl(avatarMap: Record<string, string>, candidates: Array<string | undefined | null>): string | undefined {
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim()
      if (!normalized) continue

      const cleaned = this.normalizeAccountId(normalized)
      const avatarUrl = avatarMap[normalized]
        || avatarMap[normalized.toLowerCase()]
        || avatarMap[cleaned]
        || avatarMap[cleaned.toLowerCase()]

      if (avatarUrl) return avatarUrl
    }

    return undefined
  }

  private lookupGroupNickname(groupNicknamesMap: Map<string, string>, sender: string): string {
    const key = String(sender || '').trim().toLowerCase()
    if (!key) return ''
    return groupNicknamesMap.get(key) || ''
  }

  private buildTrustedGroupNicknameMap(nicknames: Record<string, string>): Map<string, string> {
    const buckets = new Map<string, Set<string>>()
    for (const [memberIdRaw, nicknameRaw] of Object.entries(nicknames || {})) {
      const memberId = String(memberIdRaw || '').trim().toLowerCase()
      const nickname = String(nicknameRaw || '').trim()
      if (!memberId || !nickname) continue
      const slot = buckets.get(memberId)
      if (slot) {
        slot.add(nickname)
      } else {
        buckets.set(memberId, new Set([nickname]))
      }
    }

    const trusted = new Map<string, string>()
    for (const [memberId, nicknameSet] of buckets.entries()) {
      if (nicknameSet.size !== 1) continue
      trusted.set(memberId, Array.from(nicknameSet)[0])
    }
    return trusted
  }

  private resolveChatLabSenderInfo(
    msg: Message,
    talkerId: string,
    talkerName: string,
    myWxid: string,
    isGroup: boolean,
    senderNames: Record<string, string>,
    groupNicknamesMap: Map<string, string>
  ): { sender: string; accountName: string; groupNickname?: string } {
    let sender = String(msg.senderUsername || '').trim()
    let usedUnknownPlaceholder = false
    const sameAsMe = sender && myWxid && sender.toLowerCase() === myWxid.toLowerCase()
    const isSelf = msg.isSend === 1 || sameAsMe

    if (!sender && isSelf && myWxid) {
      sender = myWxid
    }

    if (!sender) {
      if (msg.localType === 10000 || msg.localType === 266287972401) {
        sender = talkerId
      } else {
        sender = `unknown_sender_${msg.localId || msg.createTime || 0}`
        usedUnknownPlaceholder = true
      }
    }

    const groupNickname = isGroup ? this.lookupGroupNickname(groupNicknamesMap, sender) : ''
    const displayName = senderNames[sender] || groupNickname || (usedUnknownPlaceholder ? '' : sender)
    const accountName = isSelf ? '我' : (displayName || '未知发送者')

    return {
      sender,
      accountName,
      groupNickname: groupNickname || undefined
    }
  }

  /**
   * 转换为 ChatLab 格式
   */
  private async convertToChatLab(
    messages: Message[],
    talkerId: string,
    talkerName: string,
    mediaMap: Map<number, ApiExportedMedia> = new Map()
  ): Promise<ChatLabData> {
    const isGroup = talkerId.endsWith('@chatroom')
    const myWxid = this.configService.get('myWxid') || ''
    const normalizedMyWxid = this.normalizeAccountId(myWxid).toLowerCase()

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
          groupNicknamesMap = this.buildTrustedGroupNicknameMap(result.nicknames)
        }
      } catch (e) {
        console.error('[HttpService] Failed to get group nicknames:', e)
      }
    }

    // 构建成员列表
    const memberMap = new Map<string, ChatLabMember>()
    for (const msg of messages) {
      const senderInfo = this.resolveChatLabSenderInfo(msg, talkerId, talkerName, myWxid, isGroup, senderNames, groupNicknamesMap)
      if (!memberMap.has(senderInfo.sender)) {
        memberMap.set(senderInfo.sender, {
          platformId: senderInfo.sender,
          accountName: senderInfo.accountName,
          groupNickname: senderInfo.groupNickname
        })
      }
    }

    const [memberAvatarMap, myAvatarResult, sessionAvatarInfo] = await Promise.all([
      this.getAvatarUrls(Array.from(memberMap.keys()).filter((sender) => !sender.startsWith('unknown_sender_'))),
      myWxid
        ? chatService.getMyAvatarUrl()
        : Promise.resolve<{ success: boolean; avatarUrl?: string }>({ success: true }),
      isGroup ? chatService.getContactAvatar(talkerId) : Promise.resolve(null)
    ])

    for (const [sender, member] of memberMap.entries()) {
      if (sender.startsWith('unknown_sender_')) continue

      const normalizedSender = this.normalizeAccountId(sender).toLowerCase()
      const isSelfMember = Boolean(normalizedMyWxid && normalizedSender && normalizedSender === normalizedMyWxid)
      const avatarUrl = (isSelfMember ? myAvatarResult.avatarUrl : undefined)
        || this.resolveAvatarUrl(memberAvatarMap, isSelfMember ? [sender, myWxid] : [sender])

      if (avatarUrl) {
        member.avatar = avatarUrl
      }
    }

    // 转换消息
    const chatLabMessages: ChatLabMessage[] = messages.map(msg => {
      const senderInfo = this.resolveChatLabSenderInfo(msg, talkerId, talkerName, myWxid, isGroup, senderNames, groupNicknamesMap)

      return {
        sender: senderInfo.sender,
        accountName: senderInfo.accountName,
        groupNickname: senderInfo.groupNickname,
        timestamp: msg.createTime,
        type: this.mapMessageType(msg.localType, msg),
        content: this.getMessageContent(msg),
        platformMessageId: msg.serverId ? String(msg.serverId) : undefined,
        mediaPath: mediaMap.get(msg.localId) ? `http://${this.host}:${this.port}/api/v1/media/${mediaMap.get(msg.localId)!.relativePath}` : undefined
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
        groupAvatar: isGroup ? sessionAvatarInfo?.avatarUrl : undefined,
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
    const xmlType = this.resolveType49Subtype(msg)

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

  private extractType49Subtype(rawContent: string): string {
    const content = String(rawContent || '')
    if (!content) return ''

    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
    if (appmsgMatch) {
      const appmsgInner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
      if (typeMatch) {
        return typeMatch[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
      }
    }

    const fallbackMatch = /<type>([\s\S]*?)<\/type>/i.exec(content)
    if (fallbackMatch) {
      return fallbackMatch[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }

    return ''
  }

  private resolveType49Subtype(msg: Message): string {
    const xmlType = String(msg.xmlType || '').trim()
    if (xmlType) return xmlType

    const extractedType = this.extractType49Subtype(msg.rawContent)
    if (extractedType) return extractedType

    switch (msg.appMsgKind) {
      case 'official-link':
      case 'link':
        return '5'
      case 'file':
        return '6'
      case 'chat-record':
        return '19'
      case 'miniapp':
        return '33'
      case 'quote':
        return '57'
      case 'transfer':
        return '2000'
      case 'red-packet':
        return '2001'
      case 'music':
        return '3'
      default:
        if (msg.linkUrl) return '5'
        if (msg.fileName) return '6'
        return ''
    }
  }

  private getType49Content(msg: Message): string {
    const subtype = this.resolveType49Subtype(msg)
    const title = msg.linkTitle || msg.fileName || ''

    switch (subtype) {
      case '5':
      case '49':
        return title ? `[链接] ${title}` : '[链接]'
      case '6':
        return title ? `[文件] ${title}` : '[文件]'
      case '19':
        return title ? `[聊天记录] ${title}` : '[聊天记录]'
      case '33':
      case '36':
        return title ? `[小程序] ${title}` : '[小程序]'
      case '57':
        return msg.parsedContent || title || '[引用消息]'
      case '2000':
        return title ? `[转账] ${title}` : '[转账]'
      case '2001':
        return title ? `[红包] ${title}` : '[红包]'
      case '3':
        return title ? `[音乐] ${title}` : '[音乐]'
      default:
        return msg.parsedContent || title || '[消息]'
    }
  }

  /**
   * 获取消息内容
   */
  private getMessageContent(msg: Message): string | null {
    if (msg.localType === 49) {
      return this.getType49Content(msg)
    }

    // 优先使用已解析的内容
    if (msg.parsedContent) {
      return msg.parsedContent
    }

    // 根据类型返回占位符
    switch (msg.localType) {
      case 1:
        return msg.rawContent || null
      case 3:
        return '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 42:
        return msg.cardNickname || '[名片]'
      case 48:
        return '[位置]'
      case 49:
        return this.getType49Content(msg)
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

  private sendMethodNotAllowed(res: http.ServerResponse, allow: string): void {
    res.setHeader('Allow', allow)
    this.sendError(res, 405, `Method Not Allowed. Allowed: ${allow}`)
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
