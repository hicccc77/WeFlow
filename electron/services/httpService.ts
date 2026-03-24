/**
 * HTTP API 服务
 * 提供 ChatLab 标准化格式的消息查询 API
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { URL } from 'url'
import { chatService, Message } from './chatService'
import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { videoService } from './videoService'
import { imageDecryptService } from './imageDecryptService'
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
  private running: boolean = false
  private connections: Set<import('net').Socket> = new Set()
  private connectionMutex: boolean = false

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

  /**
   * 处理 HTTP 请求
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
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
      } else if (pathname.startsWith('/api/v1/media/')) {
        this.handleMediaRequest(pathname, res)
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
        await this.handleSnsExport(req, res)
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
      } else {
        this.sendError(res, 404, 'Not Found')
      }
    } catch (error) {
      console.error('[HttpService] Request error:', error)
      this.sendError(res, 500, String(error))
    }
  }

  private handleMediaRequest(pathname: string, res: http.ServerResponse): void {
    const mediaBasePath = this.getApiMediaExportPath()
    const relativePath = pathname.replace('/api/v1/media/', '')
    const fullPath = path.join(mediaBasePath, relativePath)

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

  private parseStringListParam(value: string | null): string[] | undefined {
    if (!value) return undefined
    const values = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    return values.length > 0 ? Array.from(new Set(values)) : undefined
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      const maxSize = 1024 * 1024

      req.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buf.length
        if (size > maxSize) {
          reject(new Error('Request body too large'))
          req.destroy()
          return
        }
        chunks.push(buf)
      })

      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (!raw) return resolve({})
        try {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return resolve({})
          }
          resolve(parsed as Record<string, unknown>)
        } catch {
          reject(new Error('Invalid JSON body'))
        }
      })

      req.on('error', (err) => reject(err))
    })
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

  private async handleSnsTimeline(url: URL, res: http.ServerResponse): Promise<void> {
    const limit = this.parseIntParam(url.searchParams.get('limit'), 20, 1, 200)
    const offset = this.parseIntParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    const usernames = this.parseStringListParam(url.searchParams.get('usernames'))
    const keyword = (url.searchParams.get('keyword') || '').trim() || undefined
    const startTimeRaw = this.parseTimeParam(url.searchParams.get('start'))
    const endTimeRaw = this.parseTimeParam(url.searchParams.get('end'), true)
    const startTime = startTimeRaw > 0 ? startTimeRaw : undefined
    const endTime = endTimeRaw > 0 ? endTimeRaw : undefined

    const result = await snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime)
    if (!result.success) {
      this.sendError(res, 500, result.error || 'Failed to get sns timeline')
      return
    }

    this.sendJson(res, {
      success: true,
      count: result.timeline?.length || 0,
      timeline: result.timeline || []
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

    const keyRaw = (url.searchParams.get('key') || '').trim()
    const key = keyRaw ? (/^-?\d+$/.test(keyRaw) ? Number(keyRaw) : keyRaw) : undefined
    const result = await snsService.downloadImage(mediaUrl, key)
    if (!result.success || !result.data) {
      this.sendError(res, 502, result.error || 'Failed to proxy sns media')
      return
    }

    res.setHeader('Content-Type', result.contentType || 'application/octet-stream')
    res.setHeader('Content-Length', result.data.length)
    res.writeHead(200)
    res.end(result.data)
  }

  private async handleSnsExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await this.parseJsonBody(req)
    } catch (e) {
      this.sendError(res, 400, String(e))
      return
    }

    const outputDir = String(body.outputDir || '').trim()
    if (!outputDir) {
      this.sendError(res, 400, 'Missing required field: outputDir')
      return
    }

    const rawFormat = String(body.format || 'json').trim().toLowerCase()
    const format = rawFormat === 'arkme-json' ? 'arkmejson' : rawFormat
    if (!['json', 'html', 'arkmejson'].includes(format)) {
      this.sendError(res, 400, 'Invalid format, supported: json/html/arkmejson')
      return
    }

    const usernames = Array.isArray(body.usernames)
      ? body.usernames.map((item) => String(item || '').trim()).filter(Boolean)
      : this.parseStringListParam(typeof body.usernames === 'string' ? body.usernames : null)
    const keyword = String(body.keyword || '').trim() || undefined

    const startCandidate = body.start ?? body.startTime
    const endCandidate = body.end ?? body.endTime
    const startTimeRaw = startCandidate == null ? 0 : this.parseTimeParam(String(startCandidate))
    const endTimeRaw = endCandidate == null ? 0 : this.parseTimeParam(String(endCandidate), true)

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
      exportMedia: Boolean(body.exportMedia)
    }

    if (typeof body.exportImages === 'boolean') options.exportImages = body.exportImages
    if (typeof body.exportLivePhotos === 'boolean') options.exportLivePhotos = body.exportLivePhotos
    if (typeof body.exportVideos === 'boolean') options.exportVideos = body.exportVideos
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
      mediaUrl: media ? `http://127.0.0.1:${this.port}/api/v1/media/${media.relativePath}` : undefined,
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
  private async convertToChatLab(
    messages: Message[],
    talkerId: string,
    talkerName: string,
    mediaMap: Map<number, ApiExportedMedia> = new Map()
  ): Promise<ChatLabData> {
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
        platformMessageId: msg.serverId ? String(msg.serverId) : undefined,
        mediaPath: mediaMap.get(msg.localId) ? `http://127.0.0.1:${this.port}/api/v1/media/${mediaMap.get(msg.localId)!.relativePath}` : undefined
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
