import { join, dirname, basename, extname } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import * as fzstd from 'fzstd'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)
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
  emojiLocalPath?: string  // 本地缓存 castle 路径
  // 引用消息相关
  quotedContent?: string
  quotedSender?: string
  // 图片/视频相关
  imageMd5?: string
  imageDatName?: string
  aesKey?: string
  encrypVer?: number
  cdnThumbUrl?: string
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
  private readonly defaultV1AesKey = 'cfcd208495d565ef'

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
      if (this.connected && wcdbService.isReady()) {
        return { success: true }
      }
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

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    if (this.connected && wcdbService.isReady()) {
      return { success: true }
    }
    const result = await this.connect()
    if (!result.success) {
      this.connected = false
      return { success: false, error: result.error }
    }
    return { success: true }
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
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
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

        const summary = this.cleanString(row.summary || row.digest || row.last_msg || row.lastMsg || '')
        const lastMsgType = parseInt(row.last_msg_type || row.lastMsgType || '0', 10)

        sessions.push({
          username,
          type: parseInt(row.type || '0', 10),
          unreadCount: parseInt(row.unread_count || row.unreadCount || row.unreadcount || '0', 10),
          summary: summary || this.getMessageTypeLabel(lastMsgType),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType,
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
      const now = Date.now()
      const missing: string[] = []

      for (const session of sessions) {
        const cached = this.avatarCache.get(session.username)
        if (cached && now - cached.updatedAt < this.avatarCacheTtlMs) {
          if (cached.displayName) session.displayName = cached.displayName
          if (cached.avatarUrl) {
            session.avatarUrl = cached.avatarUrl
            continue
          }
        }
        missing.push(session.username)
      }

      if (missing.length === 0) return
      const missingSet = new Set(missing)

      const [displayNames, avatarUrls] = await Promise.all([
        wcdbService.getDisplayNames(missing),
        wcdbService.getAvatarUrls(missing)
      ])

      for (const session of sessions) {
        if (!missingSet.has(session.username)) continue
        const displayName = displayNames.success && displayNames.map ? displayNames.map[session.username] : undefined
        const avatarUrl = avatarUrls.success && avatarUrls.map ? avatarUrls.map[session.username] : undefined
        if (displayName) session.displayName = displayName
        if (avatarUrl) session.avatarUrl = avatarUrl
        this.avatarCache.set(session.username, {
          displayName: session.displayName,
          avatarUrl: session.avatarUrl,
          updatedAt: now
        })
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
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const batchSize = Math.max(1, limit || this.messageBatchDefault)
      let state = this.messageCursors.get(sessionId)

      // 只在以下情况重新创建游标:
      // 1. 没有游标状态
      // 2. offset 为 0 (重新加载会话)
      // 3. batchSize 改变
      const needNewCursor = !state || offset === 0 || state.batchSize !== batchSize

      if (needNewCursor) {
        console.log(`[ChatService] 创建新游标: sessionId=${sessionId}, offset=${offset}, batchSize=${batchSize}`)

        // 关闭旧游标
        if (state) {
          try {
            await wcdbService.closeMessageCursor(state.cursor)
          } catch (e) {
            console.warn('[ChatService] 关闭旧游标失败:', e)
          }
        }

        // 创建新游标
        const cursorResult = await wcdbService.openMessageCursor(sessionId, batchSize, false, 0, 0)
        if (!cursorResult.success || !cursorResult.cursor) {
          console.error('[ChatService] 打开消息游标失败:', cursorResult.error)
          return { success: false, error: cursorResult.error || '打开消息游标失败' }
        }

        state = { cursor: cursorResult.cursor, fetched: 0, batchSize }
        this.messageCursors.set(sessionId, state)

        // 如果需要跳过消息(offset > 0),逐批获取但不返回
        if (offset > 0) {
          console.log(`[ChatService] 跳过消息: offset=${offset}`)
          let skipped = 0
          while (skipped < offset) {
            const skipBatch = await wcdbService.fetchMessageBatch(state.cursor)
            if (!skipBatch.success) {
              console.error('[ChatService] 跳过消息批次失败:', skipBatch.error)
              return { success: false, error: skipBatch.error || '跳过消息失败' }
            }
            if (!skipBatch.rows || skipBatch.rows.length === 0) {
              console.log('[ChatService] 跳过时没有更多消息')
              return { success: true, messages: [], hasMore: false }
            }
            skipped += skipBatch.rows.length
            state.fetched += skipBatch.rows.length
            if (!skipBatch.hasMore) {
              console.log('[ChatService] 跳过时已到达末尾')
              return { success: true, messages: [], hasMore: false }
            }
          }
          console.log(`[ChatService] 跳过完成: skipped=${skipped}, fetched=${state.fetched}`)
        }
      } else if (state && offset !== state.fetched) {
        // offset 与 fetched 不匹配,说明状态不一致
        console.warn(`[ChatService] 游标状态不一致: offset=${offset}, fetched=${state.fetched}, 继续使用现有游标`)
        // 不重新创建游标,而是继续使用现有游标
        // 这样可以避免频繁重建导致的问题
      }

      // 确保 state 已初始化
      if (!state) {
        console.error('[ChatService] 游标状态未初始化')
        return { success: false, error: '游标状态未初始化' }
      }

      // 获取当前批次的消息
      console.log(`[ChatService] 获取消息批次: cursor=${state.cursor}, fetched=${state.fetched}`)
      const batch = await wcdbService.fetchMessageBatch(state.cursor)
      if (!batch.success) {
        console.error('[ChatService] 获取消息批次失败:', batch.error)
        return { success: false, error: batch.error || '获取消息失败' }
      }

      if (!batch.rows) {
        console.error('[ChatService] 获取消息失败: 返回数据为空')
        return { success: false, error: '获取消息失败: 返回数据为空' }
      }

      const rows = batch.rows as Record<string, any>[]
      const hasMore = batch.hasMore === true

      const normalized = this.normalizeMessageOrder(this.mapRowsToMessages(rows))

      // 并发检查并修复缺失 CDN URL 的表情包
      const fixPromises: Promise<void>[] = []
      for (const msg of normalized) {
        if (msg.localType === 47 && !msg.emojiCdnUrl && msg.emojiMd5) {
          fixPromises.push(this.fallbackEmoticon(msg))
        }
      }

      if (fixPromises.length > 0) {
        await Promise.allSettled(fixPromises)
      }

      state.fetched += rows.length
      return { success: true, messages: normalized, hasMore }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 尝试从 emoticon.db / emotion.db 恢复表情包 CDN URL
   */
  private async fallbackEmoticon(msg: Message): Promise<void> {
    if (!msg.emojiMd5) return

    try {
      const dbPath = await this.findInternalEmoticonDb()
      if (!dbPath) {
        console.warn(`[ChatService] 表情包数据库未找到，无法恢复: md5=${msg.emojiMd5}`)
        return
      }

      const urlResult = await wcdbService.getEmoticonCdnUrl(dbPath, msg.emojiMd5)
      if (!urlResult.success) {
        console.warn(`[ChatService] 表情包数据库查询失败: md5=${msg.emojiMd5}, db=${dbPath}`, urlResult.error)
        return
      }
      if (urlResult.url) {
        msg.emojiCdnUrl = urlResult.url
        return
      }

      console.warn(`[ChatService] 表情包数据库未命中: md5=${msg.emojiMd5}, db=${dbPath}`)

    } catch (e) {
      console.error(`[ChatService] 恢复表情包失败: md5=${msg.emojiMd5}`, e)
    }
  }

  /**
   * 查找 emoticon.db 路径
   */
  private async findInternalEmoticonDb(): Promise<string | null> {
    const myWxid = this.configService.get('myWxid')
    const rootDbPath = this.configService.get('dbPath')
    if (!myWxid || !rootDbPath) return null

    const accountDir = this.resolveAccountDir(rootDbPath, myWxid)
    if (!accountDir) return null

    const candidates = [
      // 1. 标准结构: root/wxid/db_storage/emoticon
      join(rootDbPath, myWxid, 'db_storage', 'emoticon', 'emoticon.db'),
      join(rootDbPath, myWxid, 'db_storage', 'emotion', 'emoticon.db'),
    ]

    for (const p of candidates) {
      if (existsSync(p)) return p
    }

    return null
  }


  async getLatestMessages(sessionId: string, limit: number = this.messageBatchDefault): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const batchSize = Math.max(1, limit)
      const cursorResult = await wcdbService.openMessageCursor(sessionId, batchSize, false, 0, 0)
      if (!cursorResult.success || !cursorResult.cursor) {
        return { success: false, error: cursorResult.error || '打开消息游标失败' }
      }

      try {
        const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        if (!batch.success || !batch.rows) {
          return { success: false, error: batch.error || '获取消息失败' }
        }
        const normalized = this.normalizeMessageOrder(this.mapRowsToMessages(batch.rows as Record<string, any>[]))

        // 并发检查并修复缺失 CDN URL 的表情包
        const fixPromises: Promise<void>[] = []
        for (const msg of normalized) {
          if (msg.localType === 47 && !msg.emojiCdnUrl && msg.emojiMd5) {
            fixPromises.push(this.fallbackEmoticon(msg))
          }
        }
        if (fixPromises.length > 0) {
          await Promise.allSettled(fixPromises)
        }

        return { success: true, messages: normalized }
      } finally {
        await wcdbService.closeMessageCursor(cursorResult.cursor)
      }
    } catch (e) {
      console.error('ChatService: 获取最新消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private normalizeMessageOrder(messages: Message[]): Message[] {
    if (messages.length < 2) return messages
    const first = messages[0]
    const last = messages[messages.length - 1]
    const firstKey = first.sortSeq || first.createTime || first.localId || 0
    const lastKey = last.sortSeq || last.createTime || last.localId || 0
    if (firstKey > lastKey) {
      return [...messages].reverse()
    }
    return messages
  }

  private getRowField(row: Record<string, any>, keys: string[]): any {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null) return row[key]
    }
    const lowerMap = new Map<string, string>()
    for (const actual of Object.keys(row)) {
      lowerMap.set(actual.toLowerCase(), actual)
    }
    for (const key of keys) {
      const actual = lowerMap.get(key.toLowerCase())
      if (actual && row[actual] !== undefined && row[actual] !== null) {
        return row[actual]
      }
    }
    return undefined
  }

  private getRowInt(row: Record<string, any>, keys: string[], fallback = 0): number {
    const raw = this.getRowField(row, keys)
    if (raw === undefined || raw === null || raw === '') return fallback
    const parsed = this.coerceRowNumber(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private coerceRowNumber(raw: any): number {
    if (raw === undefined || raw === null) return NaN
    if (typeof raw === 'number') return raw
    if (typeof raw === 'bigint') return Number(raw)
    if (Buffer.isBuffer(raw)) {
      return parseInt(raw.toString('utf-8'), 10)
    }
    if (raw instanceof Uint8Array) {
      return parseInt(Buffer.from(raw).toString('utf-8'), 10)
    }
    if (Array.isArray(raw)) {
      return parseInt(Buffer.from(raw).toString('utf-8'), 10)
    }
    if (typeof raw === 'object') {
      if ('value' in raw) return this.coerceRowNumber(raw.value)
      if ('intValue' in raw) return this.coerceRowNumber(raw.intValue)
      if ('low' in raw && 'high' in raw) {
        try {
          const low = BigInt(raw.low >>> 0)
          const high = BigInt(raw.high >>> 0)
          return Number((high << 32n) + low)
        } catch {
          return NaN
        }
      }
      const text = raw.toString ? String(raw) : ''
      if (text && text !== '[object Object]') {
        const parsed = parseInt(text, 10)
        return Number.isFinite(parsed) ? parsed : NaN
      }
      return NaN
    }
    const parsed = parseInt(String(raw), 10)
    return Number.isFinite(parsed) ? parsed : NaN
  }

  private mapRowsToMessages(rows: Record<string, any>[]): Message[] {
    const myWxid = this.configService.get('myWxid')
    const cleanedWxid = myWxid ? this.cleanAccountDirName(myWxid) : null
    const myWxidLower = myWxid ? myWxid.toLowerCase() : null
    const cleanedWxidLower = cleanedWxid ? cleanedWxid.toLowerCase() : null

    const messages: Message[] = []
    for (const row of rows) {
      const content = this.decodeMessageContent(
        this.getRowField(row, [
          'message_content',
          'messageContent',
          'content',
          'msg_content',
          'msgContent',
          'WCDB_CT_message_content',
          'WCDB_CT_messageContent'
        ]),
        this.getRowField(row, [
          'compress_content',
          'compressContent',
          'compressed_content',
          'WCDB_CT_compress_content',
          'WCDB_CT_compressContent'
        ])
      )
      const localType = this.getRowInt(row, ['local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'], 1)
      const isSendRaw = this.getRowField(row, ['computed_is_send', 'computedIsSend', 'is_send', 'isSend', 'WCDB_CT_is_send'])
      let isSend = isSendRaw === null ? null : parseInt(isSendRaw, 10)
      const senderUsername = this.getRowField(row, ['sender_username', 'senderUsername', 'sender', 'WCDB_CT_sender_username']) || null
      const createTime = this.getRowInt(row, ['create_time', 'createTime', 'createtime', 'msg_create_time', 'msgCreateTime', 'msg_time', 'msgTime', 'time', 'WCDB_CT_create_time'], 0)

      if (senderUsername && (myWxidLower || cleanedWxidLower)) {
        const senderLower = String(senderUsername).toLowerCase()
        const expectedIsSend = (senderLower === myWxidLower || senderLower === cleanedWxidLower) ? 1 : 0
        if (isSend === null) {
          isSend = expectedIsSend
        }
      }

      let emojiCdnUrl: string | undefined
      let emojiMd5: string | undefined
      let quotedContent: string | undefined
      let quotedSender: string | undefined
      let imageMd5: string | undefined
      let imageDatName: string | undefined
      let aesKey: string | undefined
      let encrypVer: number | undefined
      let cdnThumbUrl: string | undefined
      let voiceDurationSeconds: number | undefined

      if (localType === 47 && content) {
        const emojiInfo = this.parseEmojiInfo(content)
        emojiCdnUrl = emojiInfo.cdnUrl
        emojiMd5 = emojiInfo.md5
      } else if (localType === 3 && content) {
        const imageInfo = this.parseImageInfo(content)
        imageMd5 = imageInfo.md5
        aesKey = imageInfo.aesKey
        encrypVer = imageInfo.encrypVer
        cdnThumbUrl = imageInfo.cdnThumbUrl
        imageDatName = this.parseImageDatNameFromRow(row)
      } else if (localType === 34 && content) {
        voiceDurationSeconds = this.parseVoiceDurationSeconds(content)
      } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
        const quoteInfo = this.parseQuoteMessage(content)
        quotedContent = quoteInfo.content
        quotedSender = quoteInfo.sender
      }

      messages.push({
        localId: this.getRowInt(row, ['local_id', 'localId', 'LocalId', 'msg_local_id', 'msgLocalId', 'MsgLocalId', 'msg_id', 'msgId', 'MsgId', 'id', 'WCDB_CT_local_id'], 0),
        serverId: this.getRowInt(row, ['server_id', 'serverId', 'ServerId', 'msg_server_id', 'msgServerId', 'MsgServerId', 'WCDB_CT_server_id'], 0),
        localType,
        createTime,
        sortSeq: this.getRowInt(row, ['sort_seq', 'sortSeq', 'seq', 'sequence', 'WCDB_CT_sort_seq'], createTime),
        isSend,
        senderUsername,
        parsedContent: this.parseMessageContent(content, localType),
        rawContent: content,
        emojiCdnUrl,
        emojiMd5,
        quotedContent,
        quotedSender,
        imageMd5,
        imageDatName,
        voiceDurationSeconds,
        aesKey,
        encrypVer,
        cdnThumbUrl
      })
      const last = messages[messages.length - 1]
      if ((last.localType === 3 || last.localType === 34) && (last.localId === 0 || last.createTime === 0)) {
        console.warn('[ChatService] message key missing', {
          localType: last.localType,
          localId: last.localId,
          createTime: last.createTime,
          rowKeys: Object.keys(row)
        })
      }
    }
    return messages
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
    content = this.cleanUtf16(content)

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
      case 266287972401:
        return '[拍一拍]'
      case 81604378673:
        return '[聊天记录]'
      case 8594229559345:
        return '[红包]'
      case 8589934592049:
        return '[转账]'
      default:
        // 检查是否是 type=57 的引用消息
        if (xmlType === '57') {
          const title = this.extractXmlValue(content, 'title')
          return title || '[引用消息]'
        }

        // 尝试从 XML 提取通用 title
        const genericTitle = this.extractXmlValue(content, 'title')
        if (genericTitle && genericTitle.length > 0 && genericTitle.length < 100) {
          return genericTitle
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
      const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /cdnurl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (cdnUrlMatch) {
        cdnUrl = cdnUrlMatch[1].replace(/&amp;/g, '&')
        if (cdnUrl.includes('%')) {
          try {
            cdnUrl = decodeURIComponent(cdnUrl)
          } catch { }
        }
      }

      // 如果没有 cdnurl，尝试 thumburl
      if (!cdnUrl) {
        const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /thumburl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
        if (thumbUrlMatch) {
          cdnUrl = thumbUrlMatch[1].replace(/&amp;/g, '&')
          if (cdnUrl.includes('%')) {
            try {
              cdnUrl = decodeURIComponent(cdnUrl)
            } catch { }
          }
        }
      }

      // 提取 md5
      const md5Match = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) || /md5\s*=\s*([a-fA-F0-9]+)/i.exec(content)
      const md5 = md5Match ? md5Match[1] : undefined

      // 不构造假 URL，只返回真正的 cdnurl
      // 没有 cdnUrl 时保持静默，交由后续回退逻辑处理
      return { cdnUrl, md5 }
    } catch (e) {
      console.error('[ChatService] 表情包解析失败:', e, { xml: content })
      return {}
    }
  }

  /**
   * 解析图片信息
   */
  private parseImageInfo(content: string): { md5?: string; aesKey?: string; encrypVer?: number; cdnThumbUrl?: string } {
    try {
      const md5 =
        this.extractXmlValue(content, 'md5') ||
        this.extractXmlAttribute(content, 'img', 'md5') ||
        undefined
      const aesKey = this.extractXmlAttribute(content, 'img', 'aeskey') || undefined
      const encrypVerStr = this.extractXmlAttribute(content, 'img', 'encrypver') || undefined
      const cdnThumbUrl = this.extractXmlAttribute(content, 'img', 'cdnthumburl') || undefined

      return {
        md5,
        aesKey,
        encrypVer: encrypVerStr ? parseInt(encrypVerStr, 10) : undefined,
        cdnThumbUrl
      }
    } catch {
      return {}
    }
  }

  private parseImageDatNameFromRow(row: Record<string, any>): string | undefined {
    const packed = this.getRowField(row, [
      'packed_info_data',
      'packed_info',
      'packedInfoData',
      'packedInfo',
      'PackedInfoData',
      'PackedInfo',
      'WCDB_CT_packed_info_data',
      'WCDB_CT_packed_info',
      'WCDB_CT_PackedInfoData',
      'WCDB_CT_PackedInfo'
    ])
    const buffer = this.decodePackedInfo(packed)
    if (!buffer || buffer.length === 0) return undefined
    const printable: number[] = []
    for (const byte of buffer) {
      if (byte >= 0x20 && byte <= 0x7e) {
        printable.push(byte)
      } else {
        printable.push(0x20)
      }
    }
    const text = Buffer.from(printable).toString('utf-8')
    const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
    if (match?.[1]) return match[1].toLowerCase()
    const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
    return hexMatch?.[1]?.toLowerCase()
  }

  private decodePackedInfo(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          return Buffer.from(trimmed, 'hex')
        } catch { }
      }
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  private parseVoiceDurationSeconds(content: string): number | undefined {
    if (!content) return undefined
    const match = /(voicelength|length|time|playlength)\s*=\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/i.exec(content)
    if (!match) return undefined
    const raw = parseFloat(match[2])
    if (!Number.isFinite(raw) || raw <= 0) return undefined
    if (raw > 1000) return Math.round(raw / 1000)
    return Math.round(raw)
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

  private getVoiceLookupCandidates(sessionId: string, msg: Message): string[] {
    const candidates: string[] = []
    const add = (value?: string | null) => {
      const trimmed = value?.trim()
      if (!trimmed) return
      if (!candidates.includes(trimmed)) candidates.push(trimmed)
    }
    add(sessionId)
    add(msg.senderUsername)
    add(this.configService.get('myWxid'))
    return candidates
  }

  private async resolveChatNameId(dbPath: string, senderWxid: string): Promise<number | null> {
    const escaped = this.escapeSqlString(senderWxid)
    const name2IdTable = await this.resolveName2IdTableName(dbPath)
    if (!name2IdTable) return null
    const info = await wcdbService.execQuery('media', dbPath, `PRAGMA table_info('${name2IdTable}')`)
    if (!info.success || !info.rows) return null
    const columns = info.rows.map((row) => String(row.name || row.Name || row.column || '')).filter(Boolean)
    const lower = new Map(columns.map((col) => [col.toLowerCase(), col]))
    const column = lower.get('name_id') || lower.get('id') || 'rowid'
    const sql = `SELECT ${column} AS id FROM ${name2IdTable} WHERE user_name = '${escaped}' LIMIT 1`
    const result = await wcdbService.execQuery('media', dbPath, sql)
    if (!result.success || !result.rows || result.rows.length === 0) return null
    const value = result.rows[0]?.id
    if (value === null || value === undefined) return null
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          return Buffer.from(trimmed, 'hex')
        } catch { }
      }
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  private async resolveVoiceInfoColumns(dbPath: string, tableName: string): Promise<{
    dataColumn: string;
    chatNameIdColumn?: string;
    createTimeColumn?: string;
    msgLocalIdColumn?: string;
  } | null> {
    const info = await wcdbService.execQuery('media', dbPath, `PRAGMA table_info('${tableName}')`)
    if (!info.success || !info.rows) return null
    const columns = info.rows.map((row) => String(row.name || row.Name || row.column || '')).filter(Boolean)
    if (columns.length === 0) return null
    const lower = new Map(columns.map((col) => [col.toLowerCase(), col]))
    const dataColumn =
      lower.get('voice_data') ||
      lower.get('buf') ||
      lower.get('voicebuf') ||
      lower.get('data')
    if (!dataColumn) return null
    return {
      dataColumn,
      chatNameIdColumn: lower.get('chat_name_id') || lower.get('chatnameid') || lower.get('chat_nameid'),
      createTimeColumn: lower.get('create_time') || lower.get('createtime') || lower.get('time'),
      msgLocalIdColumn: lower.get('msg_local_id') || lower.get('msglocalid') || lower.get('localid')
    }
  }

  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''")
  }

  private async resolveVoiceInfoTableName(dbPath: string): Promise<string | null> {
    // 1. 优先尝试标准表名 'VoiceInfo'
    const checkStandard = await wcdbService.execQuery(
      'media',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='VoiceInfo'"
    )
    if (checkStandard.success && checkStandard.rows && checkStandard.rows.length > 0) {
      return 'VoiceInfo'
    }

    // 2. 只有在找不到标准表时，才尝试模糊匹配 (兼容性)
    const result = await wcdbService.execQuery(
      'media',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%' ORDER BY name DESC LIMIT 1"
    )
    if (!result.success || !result.rows || result.rows.length === 0) return null
    return result.rows[0]?.name || null
  }

  private async resolveName2IdTableName(dbPath: string): Promise<string | null> {
    const result = await wcdbService.execQuery(
      'media',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%' ORDER BY name DESC LIMIT 1"
    )
    if (!result.success || !result.rows || result.rows.length === 0) return null
    return result.rows[0]?.name || null
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
      47: '[动画表情]',
      48: '[位置]',
      49: '[链接]',
      50: '[通话]',
      10000: '[系统消息]',
      244813135921: '[引用消息]',
      266287972401: '[拍一拍]',
      81604378673: '[聊天记录]',
      154618822705: '[小程序]',
      8594229559345: '[红包]',
      8589934592049: '[转账]',
      34359738417: '[文件]',
      103079215153: '[文件]',
      25769803825: '[文件]'
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

  private extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
    const tagRegex = new RegExp(`<${tagName}[^>]*>`, 'i')
    const tagMatch = tagRegex.exec(xml)
    if (!tagMatch) return ''

    const attrRegex = new RegExp(`${attrName}\\s*=\\s*['"]([^'"]*)['"]`, 'i')
    const attrMatch = attrRegex.exec(tagMatch[0])
    return attrMatch ? attrMatch[1] : ''
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
    return this.cleanUtf16(String(str))
  }

  private cleanUtf16(input: string): string {
    if (!input) return input
    try {
      const cleaned = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      const codeUnits = cleaned.split('').map((c) => c.charCodeAt(0))
      const validUnits: number[] = []
      for (let i = 0; i < codeUnits.length; i += 1) {
        const unit = codeUnits[i]
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (i + 1 < codeUnits.length) {
            const nextUnit = codeUnits[i + 1]
            if (nextUnit >= 0xdc00 && nextUnit <= 0xdfff) {
              validUnits.push(unit, nextUnit)
              i += 1
              continue
            }
          }
          continue
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          continue
        }
        validUnits.push(unit)
      }
      return String.fromCharCode(...validUnits)
    } catch {
      return input.replace(/[^\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F]/g, '')
    }
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
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      return this.decodeBinaryContent(Buffer.from(raw))
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
        } catch { }
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
        const magicLE = data.readUInt32LE(0)
        const magicBE = data.readUInt32BE(0)
        if (magicLE === 0xFD2FB528 || magicBE === 0xFD2FB528) {
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
    const lowered = username.toLowerCase()
    if (lowered.includes('@placeholder') || lowered.includes('foldgroup')) return false
    if (username.startsWith('gh_')) return false

    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders', 'placeholder_foldgroup',
      '@helper_folders', '@placeholder_foldgroup'
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
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return null
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
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return null
      const cached = this.avatarCache.get(username)
      if (cached && cached.avatarUrl && Date.now() - cached.updatedAt < this.avatarCacheTtlMs) {
        return { avatarUrl: cached.avatarUrl, displayName: cached.displayName }
      }

      const contact = await this.getContact(username)
      const avatarResult = await wcdbService.getAvatarUrls([username])
      const avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined
      const displayName = contact?.remark || contact?.nickName || contact?.alias || cached?.displayName || username
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
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
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
      return join(cachePath, 'Emojis')
    }
    // 回退到默认目录
    const documentsPath = app.getPath('documents')
    return join(documentsPath, 'WeFlow', 'Emojis')
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
    if (cached && existsSync(cached)) {
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
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }

    // 检查本地是否已有缓存文件
    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = join(cacheDir, `${cacheKey}${ext}`)
      if (existsSync(filePath)) {
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
      console.error(`[ChatService] 表情包下载异常: url=${cdnUrl}, md5=${md5}`, e)
      emojiDownloading.delete(cacheKey)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 将文件转为 data URL
   */
  private fileToDataUrl(filePath: string): string | null {
    try {
      const ext = extname(filePath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.gif': 'image/gif',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
      }
      const mimeType = mimeTypes[ext] || 'image/gif'
      const data = readFileSync(filePath)
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
          const filePath = join(cacheDir, `${cacheKey}${ext}`)

          try {
            writeFileSync(filePath, buffer)
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
      const ext = extname(pathname).toLowerCase()
      if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return ext
      }
    } catch { }
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
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
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
            dbName: basename(row.db_path || ''),
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
  /**
   * 获取图片数据（解密后的）
   */
  async getImageData(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      if (!this.connected) await this.connect()

      // 1. 获取消息详情以拿到 MD5 和 AES Key
      const msgResult = await this.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) {
        return { success: false, error: '未找到消息' }
      }
      const msg = msgResult.message
      console.info('[ChatService][Image] request', {
        sessionId,
        localId: msg.localId,
        imageMd5: msg.imageMd5,
        imageDatName: msg.imageDatName
      })

      // 2. 确定搜索的基础名
      const baseName = msg.imageMd5 || msg.imageDatName || String(msg.localId)

      // 3. 查找 .dat 文件
      const myWxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!myWxid || !dbPath) return { success: false, error: '配置缺失' }

      const accountDir = dirname(dirname(dbPath)) // dbPath 是 db_storage 里面的路径或同级
      // 实际上 dbPath 指向 db_storage，accountDir 应该是其父目录
      const actualAccountDir = this.resolveAccountDir(dbPath, myWxid)
      if (!actualAccountDir) return { success: false, error: '无法定位账号目录' }

      const datPath = await this.findDatFile(actualAccountDir, baseName)
      if (!datPath) return { success: false, error: '未找到图片源文件 (.dat)' }
      console.info('[ChatService][Image] dat path', datPath)

      // 4. 获取解密密钥
      const xorKeyRaw = this.configService.get('imageXorKey')
      const aesKeyRaw = this.configService.get('imageAesKey') || msg.aesKey

      if (!xorKeyRaw) return { success: false, error: '未配置图片 XOR 密钥，请在设置中自动获取' }

      const xorKey = this.parseXorKey(xorKeyRaw)
      const data = readFileSync(datPath)

      // 5. 解密
      let decrypted: Buffer
      const version = this.getDatVersion(data)

      if (version === 0) {
        decrypted = this.decryptDatV3(data, xorKey)
      } else if (version === 1) {
        const aesKey = this.asciiKey16(this.defaultV1AesKey)
        decrypted = this.decryptDatV4(data, xorKey, aesKey)
      } else {
        const trimmed = String(aesKeyRaw ?? '').trim()
        if (!trimmed || trimmed.length < 16) {
          return { success: false, error: 'V4版本需要16字节AES密钥' }
        }
        const aesKey = this.asciiKey16(trimmed)
        decrypted = this.decryptDatV4(data, xorKey, aesKey)
      }
      console.info('[ChatService][Image] decrypted bytes', decrypted.length)

      // 返回 base64
      return { success: true, data: decrypted.toString('base64') }
    } catch (e) {
      console.error('ChatService: getImageData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getVoiceData(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      const msgResult = await this.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) return { success: false, error: '未找到该消息' }
      const msg = msgResult.message
      if (msg.isSend === 1) {
        return { success: false, error: '暂不支持解密自己发送的语音' }
      }

      const candidates = this.getVoiceLookupCandidates(sessionId, msg)
      if (candidates.length === 0) {
        return { success: false, error: '未找到语音关联账号' }
      }
      console.info('[ChatService][Voice] request', {
        sessionId,
        localId: msg.localId,
        createTime: msg.createTime,
        candidates
      })

      // 2. 查找所有的 media_*.db
      const mediaDbs = await wcdbService.listMediaDbs()
      if (!mediaDbs.success || !mediaDbs.data) return { success: false, error: '获取媒体库失败' }
      console.info('[ChatService][Voice] media dbs', mediaDbs.data)

      // 3. 在所有媒体库中查找该消息的语音数据
      let silkData: Buffer | null = null
      for (const dbPath of mediaDbs.data) {
        const voiceTable = await this.resolveVoiceInfoTableName(dbPath)
        if (!voiceTable) {
          console.warn('[ChatService][Voice] voice table not found', dbPath)
          continue
        }
        const columns = await this.resolveVoiceInfoColumns(dbPath, voiceTable)
        if (!columns) {
          console.warn('[ChatService][Voice] voice columns not found', { dbPath, voiceTable })
          continue
        }
        for (const candidate of candidates) {
          const chatNameId = await this.resolveChatNameId(dbPath, candidate)
          // 策略 1: 使用 ChatNameId + CreateTime (最准确)
          if (chatNameId) {
            let whereClause = ''
            if (columns.chatNameIdColumn && columns.createTimeColumn) {
              whereClause = `${columns.chatNameIdColumn} = ${chatNameId} AND ${columns.createTimeColumn} = ${msg.createTime}`
              const sql = `SELECT ${columns.dataColumn} AS data FROM ${voiceTable} WHERE ${whereClause} LIMIT 1`
              const result = await wcdbService.execQuery('media', dbPath, sql)
              if (result.success && result.rows && result.rows.length > 0) {
                const raw = result.rows[0]?.data
                const decoded = this.decodeVoiceBlob(raw)
                if (decoded && decoded.length > 0) {
                  console.info('[ChatService][Voice] hit by createTime', { dbPath, voiceTable, whereClause, bytes: decoded.length })
                  silkData = decoded
                  break
                }
              }
            }
          }

          // 策略 2: 使用 MsgLocalId (兜底，如果表支持)
          if (columns.msgLocalIdColumn) {
            const whereClause = `${columns.msgLocalIdColumn} = ${msg.localId}`
            const sql = `SELECT ${columns.dataColumn} AS data FROM ${voiceTable} WHERE ${whereClause} LIMIT 1`
            const result = await wcdbService.execQuery('media', dbPath, sql)
            if (result.success && result.rows && result.rows.length > 0) {
              const raw = result.rows[0]?.data
              const decoded = this.decodeVoiceBlob(raw)
              if (decoded && decoded.length > 0) {
                console.info('[ChatService][Voice] hit by localId', { dbPath, voiceTable, whereClause, bytes: decoded.length })
                silkData = decoded
                break
              }
            }
          }
        }
        if (silkData) break
      }

      if (!silkData) return { success: false, error: '未找到语音数据' }

      // 4. 解码 Silk -> PCM -> WAV
      const resourcesPath = app.isPackaged
        ? join(process.resourcesPath, 'resources')
        : join(app.getAppPath(), 'resources')
      const decoderPath = join(resourcesPath, 'silk_v3_decoder.exe')

      if (!existsSync(decoderPath)) {
        return { success: false, error: '找不到语音解码器 (silk_v3_decoder.exe)' }
      }
      console.info('[ChatService][Voice] decoder path', decoderPath)

      const tempDir = app.getPath('temp')
      const silkFile = join(tempDir, `voice_${msgId}.silk`)
      const pcmFile = join(tempDir, `voice_${msgId}.pcm`)

      try {
        writeFileSync(silkFile, silkData)
        // 执行解码: silk_v3_decoder.exe <silk> <pcm> -Fs_API 24000
        console.info('[ChatService][Voice] executing decoder:', decoderPath, [silkFile, pcmFile])
        const { stdout, stderr } = await execFileAsync(
          decoderPath,
          [silkFile, pcmFile, '-Fs_API', '24000'],
          { cwd: dirname(decoderPath) }
        )
        if (stdout && stdout.trim()) console.info('[ChatService][Voice] decoder stdout:', stdout)
        if (stderr && stderr.trim()) console.warn('[ChatService][Voice] decoder stderr:', stderr)

        if (!existsSync(pcmFile)) {
          return { success: false, error: '语音解码失败' }
        }

        const pcmData = readFileSync(pcmFile)
        const wavHeader = this.createWavHeader(pcmData.length, 24000, 1) // 微信语音通常 24kHz
        const wavData = Buffer.concat([wavHeader, pcmData])

        return { success: true, data: wavData.toString('base64') }
      } finally {
        // 清理临时文件
        try { if (existsSync(silkFile)) unlinkSync(silkFile) } catch { }
        try { if (existsSync(pcmFile)) unlinkSync(pcmFile) } catch { }
      }
    } catch (e) {
      console.error('ChatService: getVoiceData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private createWavHeader(pcmLength: number, sampleRate: number = 24000, channels: number = 1): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return header
  }

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      console.info('[ChatService] getMessageById (SQL)', { sessionId, localId })

      // 1. 获取该会话所在的消息表
      // 注意：这里使用 getMessageTableStats 而不是 getMessageTables，因为前者包含 db_path
      const tableStats = await wcdbService.getMessageTableStats(sessionId)
      if (!tableStats.success || !tableStats.tables || tableStats.tables.length === 0) {
        return { success: false, error: '未找到会话消息表' }
      }

      // 2. 遍历表查找消息 (通常只有一个主表，但可能有归档)
      for (const tableInfo of tableStats.tables) {
        const tableName = tableInfo.table_name || tableInfo.name
        const dbPath = tableInfo.db_path
        if (!tableName || !dbPath) continue

        // 构造查询
        const sql = `SELECT * FROM ${tableName} WHERE local_id = ${localId} LIMIT 1`
        const result = await wcdbService.execQuery('message', dbPath, sql)

        if (result.success && result.rows && result.rows.length > 0) {
          const row = result.rows[0]
          const message = this.parseMessage(row)

          if (message.localId !== 0) {
            console.info('[ChatService] getMessageById hit', { tableName, localId: message.localId })
            return { success: true, message }
          }
        }
      }

      return { success: false, error: '未找到消息' }
    } catch (e) {
      console.error('ChatService: getMessageById 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private parseMessage(row: any): Message {
    const rawContent = this.decodeMessageContent(
      this.getRowField(row, [
        'message_content',
        'messageContent',
        'content',
        'msg_content',
        'msgContent',
        'WCDB_CT_message_content',
        'WCDB_CT_messageContent'
      ]),
      this.getRowField(row, [
        'compress_content',
        'compressContent',
        'compressed_content',
        'WCDB_CT_compress_content',
        'WCDB_CT_compressContent'
      ])
    )
    // 这里复用 parseMessagesBatch 里面的解析逻辑，为了简单我这里先写个基础的
    // 实际项目中建议抽取 parseRawMessage(row) 供多处使用
    const msg: Message = {
      localId: this.getRowInt(row, ['local_id', 'localId', 'LocalId', 'msg_local_id', 'msgLocalId', 'MsgLocalId', 'msg_id', 'msgId', 'MsgId', 'id', 'WCDB_CT_local_id'], 0),
      serverId: this.getRowInt(row, ['server_id', 'serverId', 'ServerId', 'msg_server_id', 'msgServerId', 'MsgServerId', 'WCDB_CT_server_id'], 0),
      localType: this.getRowInt(row, ['local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'], 0),
      createTime: this.getRowInt(row, ['create_time', 'createTime', 'createtime', 'msg_create_time', 'msgCreateTime', 'msg_time', 'msgTime', 'time', 'WCDB_CT_create_time'], 0),
      sortSeq: this.getRowInt(row, ['sort_seq', 'sortSeq', 'seq', 'sequence', 'WCDB_CT_sort_seq'], this.getRowInt(row, ['create_time', 'createTime', 'createtime', 'msg_create_time', 'msgCreateTime', 'msg_time', 'msgTime', 'time', 'WCDB_CT_create_time'], 0)),
      isSend: this.getRowInt(row, ['computed_is_send', 'computedIsSend', 'is_send', 'isSend', 'WCDB_CT_is_send'], 0),
      senderUsername: this.getRowField(row, ['sender_username', 'senderUsername', 'sender', 'WCDB_CT_sender_username']) || null,
      rawContent: rawContent,
      parsedContent: this.parseMessageContent(rawContent, this.getRowInt(row, ['local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'], 0))
    }

    if (msg.localId === 0 || msg.createTime === 0) {
      const rawLocalId = this.getRowField(row, ['local_id', 'localId', 'LocalId', 'msg_local_id', 'msgLocalId', 'MsgLocalId', 'msg_id', 'msgId', 'MsgId', 'id', 'WCDB_CT_local_id'])
      const rawCreateTime = this.getRowField(row, ['create_time', 'createTime', 'createtime', 'msg_create_time', 'msgCreateTime', 'msg_time', 'msgTime', 'time', 'WCDB_CT_create_time'])
      console.warn('[ChatService] parseMessage raw keys', {
        rawLocalId,
        rawLocalIdType: rawLocalId ? typeof rawLocalId : 'null',
        val_local_id: row['local_id'],
        val_create_time: row['create_time'],
        rawCreateTime,
        rawCreateTimeType: rawCreateTime ? typeof rawCreateTime : 'null'
      })
    }

    // 图片/语音解析逻辑 (简化示例，实际应调用现有解析方法)
    if (msg.localType === 3) { // Image
      const imgInfo = this.parseImageInfo(rawContent)
      Object.assign(msg, imgInfo)
      msg.imageDatName = this.parseImageDatNameFromRow(row)
    }

    return msg
  }

  private async getMessageByLocalId(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    return this.getMessageById(sessionId, localId)
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const normalized = dbPath.replace(/[\\\\/]+$/, '')
    const dir = dirname(normalized)
    if (basename(normalized).toLowerCase() === 'db_storage') return dir
    if (basename(dir).toLowerCase() === 'db_storage') return dirname(dir)
    return dir // 兜底
  }

  private async findDatFile(accountDir: string, baseName: string): Promise<string | null> {
    const searchPaths = [
      join(accountDir, 'FileStorage', 'Image'),
      join(accountDir, 'FileStorage', 'Image2'),
      join(accountDir, 'FileStorage', 'MsgImg'),
      join(accountDir, 'FileStorage', 'Video')
    ]

    for (const searchPath of searchPaths) {
      if (!existsSync(searchPath)) continue
      const found = this.recursiveSearch(searchPath, baseName.toLowerCase(), 3)
      if (found) return found
    }
    return null
  }

  private recursiveSearch(dir: string, pattern: string, maxDepth: number): string | null {
    if (maxDepth < 0) return null
    try {
      const entries = readdirSync(dir)
      // 优先匹配当前目录文件
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stats = statSync(fullPath)
        if (stats.isFile()) {
          const lowerEntry = entry.toLowerCase()
          if (lowerEntry.includes(pattern) && lowerEntry.endsWith('.dat')) {
            const baseLower = lowerEntry.slice(0, -4)
            if (!this.hasImageVariantSuffix(baseLower)) continue
            return fullPath
          }
        }
      }
      // 递归子目录
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stats = statSync(fullPath)
        if (stats.isDirectory()) {
          const found = this.recursiveSearch(fullPath, pattern, maxDepth - 1)
          if (found) return found
        }
      }
    } catch { }
    return null
  }

  private getDatVersion(data: Buffer): number {
    if (data.length < 6) return 0
    const sigV1 = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07])
    const sigV2 = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    if (data.subarray(0, 6).equals(sigV1)) return 1
    if (data.subarray(0, 6).equals(sigV2)) return 2
    return 0
  }

  private decryptDatV3(data: Buffer, xorKey: number): Buffer {
    const result = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] ^ xorKey
    }
    return result
  }

  private decryptDatV4(data: Buffer, xorKey: number, aesKey: Buffer): Buffer {
    if (data.length < 0x0f) {
      throw new Error('文件太小，无法解析')
    }

    const header = data.subarray(0, 0x0f)
    const payload = data.subarray(0x0f)
    const aesSize = this.bytesToInt32(header.subarray(6, 10))
    const xorSize = this.bytesToInt32(header.subarray(10, 14))

    const remainder = ((aesSize % 16) + 16) % 16
    const alignedAesSize = aesSize + (16 - remainder)
    if (alignedAesSize > payload.length) {
      throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
    }

    const aesData = payload.subarray(0, alignedAesSize)
    let unpadded = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, Buffer.alloc(0))
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
      unpadded = this.strictRemovePadding(decrypted)
    }

    const remaining = payload.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) {
      throw new Error('文件格式异常：XOR 数据长度不合法')
    }

    let rawData = Buffer.alloc(0)
    let xoredData = Buffer.alloc(0)
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) {
        throw new Error('文件格式异常：原始数据长度小于XOR长度')
      }
      rawData = remaining.subarray(0, rawLength)
      const xorData = remaining.subarray(rawLength)
      xoredData = Buffer.alloc(xorData.length)
      for (let i = 0; i < xorData.length; i++) {
        xoredData[i] = xorData[i] ^ xorKey
      }
    } else {
      rawData = remaining
      xoredData = Buffer.alloc(0)
    }

    return Buffer.concat([unpadded, rawData, xoredData])
  }

  private strictRemovePadding(data: Buffer): Buffer {
    if (!data.length) {
      throw new Error('解密结果为空，填充非法')
    }
    const paddingLength = data[data.length - 1]
    if (paddingLength === 0 || paddingLength > 16 || paddingLength > data.length) {
      throw new Error('PKCS7 填充长度非法')
    }
    for (let i = data.length - paddingLength; i < data.length; i++) {
      if (data[i] !== paddingLength) {
        throw new Error('PKCS7 填充内容非法')
      }
    }
    return data.subarray(0, data.length - paddingLength)
  }

  private bytesToInt32(bytes: Buffer): number {
    if (bytes.length !== 4) {
      throw new Error('需要4个字节')
    }
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  private hasImageVariantSuffix(baseLower: string): boolean {
    const suffixes = [
      '.b',
      '.h',
      '.t',
      '.c',
      '.w',
      '.l',
      '_b',
      '_h',
      '_t',
      '_c',
      '_w',
      '_l'
    ]
    return suffixes.some((suffix) => baseLower.endsWith(suffix))
  }

  private asciiKey16(keyString: string): Buffer {
    if (keyString.length < 16) {
      throw new Error('AES密钥至少需要16个字符')
    }
    return Buffer.from(keyString, 'ascii').subarray(0, 16)
  }

  private parseXorKey(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    const cleanHex = String(value ?? '').toLowerCase().replace(/^0x/, '')
    if (!cleanHex) {
      throw new Error('十六进制字符串不能为空')
    }
    const hex = cleanHex.length >= 2 ? cleanHex.substring(0, 2) : cleanHex
    const parsed = parseInt(hex, 16)
    if (Number.isNaN(parsed)) {
      throw new Error('十六进制字符串不能为空')
    }
    return parsed
  }
}

export const chatService = new ChatService()
