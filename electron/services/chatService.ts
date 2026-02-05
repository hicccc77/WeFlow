import { join, dirname, basename, extname } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, watch } from 'fs'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import * as fzstd from 'fzstd'
import * as crypto from 'crypto'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { MessageCacheService } from './messageCacheService'
import { ContactCacheService, ContactCacheEntry } from './contactCacheService'
import { voiceTranscribeService } from './voiceTranscribeService'

type HardlinkState = {
  db: Database.Database
  imageTable?: string
  dirTable?: string
}

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
  selfWxid?: string
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
  content?: string  // 原始XML内容（与rawContent相同，供前端使用）
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
  videoMd5?: string
  aesKey?: string
  encrypVer?: number
  cdnThumbUrl?: string
  voiceDurationSeconds?: number
  // Type 49 细分字段
  linkTitle?: string        // 链接/文件标题
  linkUrl?: string          // 链接 URL
  linkThumb?: string        // 链接缩略图
  fileName?: string         // 文件名
  fileSize?: number         // 文件大小
  fileExt?: string          // 文件扩展名
  xmlType?: string          // XML 中的 type 字段
  // 名片消息
  cardUsername?: string     // 名片的微信ID
  cardNickname?: string     // 名片的昵称
  // 聊天记录
  chatRecordTitle?: string  // 聊天记录标题
  chatRecordList?: Array<{
    datatype: number
    sourcename: string
    sourcetime: string
    datadesc: string
    datatitle?: string
  }>
}

export interface Contact {
  username: string
  alias: string
  remark: string
  nickName: string
}

export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

// 表情包缓存
const emojiCache: Map<string, string> = new Map()
const emojiDownloading: Map<string, Promise<string | null>> = new Map()

class ChatService {
  private configService: ConfigService
  private connected = false
  private messageCursors: Map<string, { cursor: number; fetched: number; batchSize: number; startTime?: number; endTime?: number; ascending?: boolean }> = new Map()
  private readonly messageBatchDefault = 50
  private avatarCache: Map<string, ContactCacheEntry>
  private readonly avatarCacheTtlMs = 10 * 60 * 1000
  private readonly defaultV1AesKey = 'cfcd208495d565ef'
  private hardlinkCache = new Map<string, HardlinkState>()
  private readonly contactCacheService: ContactCacheService
  private readonly messageCacheService: MessageCacheService
  private voiceWavCache = new Map<string, Buffer>()
  private voiceTranscriptCache = new Map<string, string>()
  private voiceTranscriptPending = new Map<string, Promise<{ success: boolean; transcript?: string; error?: string }>>()
  private mediaDbsCache: string[] | null = null
  private mediaDbsCacheTime = 0
  private readonly mediaDbsCacheTtl = 300000 // 5分钟
  private readonly voiceCacheMaxEntries = 50
  // 缓存 media.db 的表结构信息
  private mediaDbSchemaCache = new Map<string, {
    voiceTable: string
    dataColumn: string
    chatNameIdColumn?: string
    timeColumn?: string
    name2IdTable?: string
  }>()
  // 缓存会话表信息，避免每次查询
  private sessionTablesCache = new Map<string, Array<{ tableName: string; dbPath: string }>>()
  private readonly sessionTablesCacheTtl = 300000 // 5分钟

  constructor() {
    this.configService = new ConfigService()
    this.contactCacheService = new ContactCacheService(this.configService.get('cachePath'))
    const persisted = this.contactCacheService.getAllEntries()
    this.avatarCache = new Map(Object.entries(persisted))
    this.messageCacheService = new MessageCacheService(this.configService.get('cachePath'))
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
    const cleaned = suffixMatch ? suffixMatch[1] : trimmed

    return cleaned
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

      // 设置数据库监控
      this.setupDbMonitor()

      // 预热 listMediaDbs 缓存（后台异步执行，不阻塞连接）
      this.warmupMediaDbsCache()

      return { success: true }
    } catch (e) {
      console.error('ChatService: 连接数据库失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private monitorSetup = false

  private setupDbMonitor() {
    if (this.monitorSetup) return
    this.monitorSetup = true

    // 使用 C++ DLL 内部的文件监控 (ReadDirectoryChangesW)
    // 这种方式更高效，且不占用 JS 线程，并能直接监听 session/message 目录变更
    wcdbService.setMonitor((type, json) => {
      // 广播给所有渲染进程窗口
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('wcdb-change', { type, json })
        }
      })
    })
  }

  /**
   * 预热 media 数据库列表缓存（后台异步执行）
   */
  private async warmupMediaDbsCache(): Promise<void> {
    try {
      const result = await wcdbService.listMediaDbs()
      if (result.success && result.data) {
        this.mediaDbsCache = result.data as string[]
        this.mediaDbsCacheTime = Date.now()
      }
    } catch (e) {
      // 静默失败，不影响主流程
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
   * 获取会话列表（优化：先返回基础数据，不等待联系人信息加载）
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

      // 转换为 ChatSession（先加载缓存，但不等待数据库查询）
      const sessions: ChatSession[] = []
      const now = Date.now()
      const myWxid = this.configService.get('myWxid')

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

        // 先尝试从缓存获取联系人信息（快速路径）
        let displayName = username
        let avatarUrl: string | undefined = undefined
        const cached = this.avatarCache.get(username)
        if (cached) {
          displayName = cached.displayName || username
          avatarUrl = cached.avatarUrl
        }

        sessions.push({
          username,
          type: parseInt(row.type || '0', 10),
          unreadCount: parseInt(row.unread_count || row.unreadCount || row.unreadcount || '0', 10),
          summary: summary || this.getMessageTypeLabel(lastMsgType),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType,
          displayName,
          avatarUrl,
          lastMsgSender: row.last_msg_sender, // 数据库返回字段
          lastSenderDisplayName: row.last_sender_display_name, // 数据库返回字段
          selfWxid: myWxid
        })
      }

      // 不等待联系人信息加载，直接返回基础会话列表
      // 前端可以异步调用 enrichSessionsWithContacts 来补充信息
      return { success: true, sessions }
    } catch (e) {
      console.error('ChatService: 获取会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 异步补充会话列表的联系人信息（公开方法，供前端调用）
   */
  async enrichSessionsContactInfo(usernames: string[]): Promise<{
    success: boolean
    contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
    error?: string
  }> {
    try {
      if (usernames.length === 0) {
        return { success: true, contacts: {} }
      }

      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const now = Date.now()
      const missing: string[] = []
      const result: Record<string, { displayName?: string; avatarUrl?: string }> = {}
      const updatedEntries: Record<string, ContactCacheEntry> = {}

      // 检查缓存
      for (const username of usernames) {
        const cached = this.avatarCache.get(username)
        // 如果缓存有效且有头像，直接使用；如果没有头像，也需要重新尝试获取
        // 额外检查：如果头像是无效的 hex 格式（以 ffd8 开头），也需要重新获取
        const isValidAvatar = cached?.avatarUrl &&
          !cached.avatarUrl.includes('base64,ffd8') // 检测错误的 hex 格式
        if (cached && now - cached.updatedAt < this.avatarCacheTtlMs && isValidAvatar) {
          result[username] = {
            displayName: cached.displayName,
            avatarUrl: cached.avatarUrl
          }
        } else {
          missing.push(username)
        }
      }

      // 批量查询缺失的联系人信息
      if (missing.length > 0) {
        const [displayNames, avatarUrls] = await Promise.all([
          wcdbService.getDisplayNames(missing),
          wcdbService.getAvatarUrls(missing)
        ])

        // 收集没有头像 URL 的用户名
        const missingAvatars: string[] = []

        for (const username of missing) {
          const displayName = displayNames.success && displayNames.map ? displayNames.map[username] : undefined
          let avatarUrl = avatarUrls.success && avatarUrls.map ? avatarUrls.map[username] : undefined

          // 如果没有头像 URL，记录下来稍后从 head_image.db 获取
          if (!avatarUrl) {
            missingAvatars.push(username)
          }

          const cacheEntry: ContactCacheEntry = {
            displayName: displayName || username,
            avatarUrl,
            updatedAt: now
          }
          result[username] = { displayName, avatarUrl }
          // 更新缓存并记录持久化
          this.avatarCache.set(username, cacheEntry)
          updatedEntries[username] = cacheEntry
        }

        // 从 head_image.db 获取缺失的头像
        if (missingAvatars.length > 0) {
          const headImageAvatars = await this.getAvatarsFromHeadImageDb(missingAvatars)
          for (const username of missingAvatars) {
            const avatarUrl = headImageAvatars[username]
            if (avatarUrl) {
              result[username].avatarUrl = avatarUrl
              const cached = this.avatarCache.get(username)
              if (cached) {
                cached.avatarUrl = avatarUrl
                updatedEntries[username] = cached
              }
            }
          }
        }

        if (Object.keys(updatedEntries).length > 0) {
          this.contactCacheService.setEntries(updatedEntries)
        }
      }
      return { success: true, contacts: result }
    } catch (e) {
      console.error('ChatService: 补充联系人信息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 从 head_image.db 批量获取头像（转换为 base64 data URL）
   */
  private async getAvatarsFromHeadImageDb(usernames: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    if (usernames.length === 0) return result

    try {
      const dbPath = this.configService.get('dbPath')
      const wxid = this.configService.get('myWxid')
      if (!dbPath || !wxid) return result

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) return result

      // head_image.db 可能在不同位置
      const headImageDbPaths = [
        join(accountDir, 'db_storage', 'head_image', 'head_image.db'),
        join(accountDir, 'db_storage', 'head_image.db'),
        join(accountDir, 'head_image.db')
      ]

      let headImageDbPath: string | null = null
      for (const path of headImageDbPaths) {
        if (existsSync(path)) {
          headImageDbPath = path
          break
        }
      }

      if (!headImageDbPath) return result

      // 使用 wcdbService.execQuery 查询加密的 head_image.db
      for (const username of usernames) {
        try {
          const escapedUsername = username.replace(/'/g, "''")
          const queryResult = await wcdbService.execQuery(
            'media',
            headImageDbPath,
            `SELECT image_buffer FROM head_image WHERE username = '${escapedUsername}' LIMIT 1`
          )

          if (queryResult.success && queryResult.rows && queryResult.rows.length > 0) {
            const row = queryResult.rows[0] as any
            if (row?.image_buffer) {
              let base64Data: string
              if (typeof row.image_buffer === 'string') {
                // WCDB 返回的 BLOB 是十六进制字符串，需要转换为 base64
                if (row.image_buffer.toLowerCase().startsWith('ffd8')) {
                  const buffer = Buffer.from(row.image_buffer, 'hex')
                  base64Data = buffer.toString('base64')
                } else {
                  base64Data = row.image_buffer
                }
              } else if (Buffer.isBuffer(row.image_buffer)) {
                base64Data = row.image_buffer.toString('base64')
              } else if (Array.isArray(row.image_buffer)) {
                base64Data = Buffer.from(row.image_buffer).toString('base64')
              } else {
                continue
              }
              result[username] = `data:image/jpeg;base64,${base64Data}`
            }
          }
        } catch {
          // 静默处理单个用户的错误
        }
      }
    } catch (e) {
      console.error('从 head_image.db 获取头像失败:', e)
    }

    return result
  }

  /**
   * 补充联系人信息（私有方法，保持向后兼容）
   */
  private async enrichSessionsWithContacts(sessions: ChatSession[]): Promise<void> {
    if (sessions.length === 0) return
    try {
      const usernames = sessions.map(s => s.username)
      const result = await this.enrichSessionsContactInfo(usernames)
      if (result.success && result.contacts) {
        for (const session of sessions) {
          const contact = result.contacts![session.username]
          if (contact) {
            if (contact.displayName) session.displayName = contact.displayName
            if (contact.avatarUrl) session.avatarUrl = contact.avatarUrl
          }
        }
      }
    } catch (e) {
      console.error('ChatService: 获取联系人信息失败:', e)
    }
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      // 使用execQuery直接查询加密的contact.db
      // kind='contact', path=null表示使用已打开的contact.db
      const contactQuery = `
        SELECT username, remark, nick_name, alias, local_type
        FROM contact
      `


      const contactResult = await wcdbService.execQuery('contact', null, contactQuery)

      if (!contactResult.success || !contactResult.rows) {
        console.error('查询联系人失败:', contactResult.error)
        return { success: false, error: contactResult.error || '查询联系人失败' }
      }


      const rows = contactResult.rows as Record<string, any>[]

      // 调试：显示前5条数据样本

      rows.slice(0, 5).forEach((row, idx) => {

      })

      // 调试：统计local_type分布
      const localTypeStats = new Map<number, number>()
      rows.forEach(row => {
        const lt = row.local_type || 0
        localTypeStats.set(lt, (localTypeStats.get(lt) || 0) + 1)
      })


      // 获取会话表的最后联系时间用于排序
      const lastContactTimeMap = new Map<string, number>()
      const sessionResult = await wcdbService.getSessions()
      if (sessionResult.success && sessionResult.sessions) {
        for (const session of sessionResult.sessions as any[]) {
          const username = session.username || session.user_name || session.userName || ''
          const timestamp = session.sort_timestamp || session.sortTimestamp || 0
          if (username && timestamp) {
            lastContactTimeMap.set(username, timestamp)
          }
        }
      }

      // 转换为ContactInfo
      const contacts: (ContactInfo & { lastContactTime: number })[] = []

      for (const row of rows) {
        const username = row.username || ''

        // 过滤系统账号和特殊账号 - 完全复制cipher的逻辑
        if (!username) continue
        if (username === 'filehelper' || username === 'fmessage' || username === 'floatbottle' ||
          username === 'medianote' || username === 'newsapp' || username.startsWith('fake_') ||
          username === 'weixin' || username === 'qmessage' || username === 'qqmail' ||
          username === 'tmessage' || username.startsWith('wxid_') === false &&
          username.includes('@') === false && username.startsWith('gh_') === false &&
          /^[a-zA-Z0-9_-]+$/.test(username) === false) {
          continue
        }

        // 判断类型 - 正确规则：wxid开头且有alias的是好友
        let type: 'friend' | 'group' | 'official' | 'other' = 'other'
        const localType = row.local_type || 0

        if (username.includes('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (localType === 3 || localType === 4) {
          type = 'official'
        } else if (username.startsWith('wxid_') && row.alias) {
          // wxid开头且有alias的是好友
          type = 'friend'
        } else if (localType === 1) {
          // local_type=1 也是好友
          type = 'friend'
        } else if (localType === 2) {
          // local_type=2 是群成员但非好友，跳过
          continue
        } else if (localType === 0) {
          // local_type=0 可能是好友或其他，检查是否有备注或昵称
          if (row.remark || row.nick_name) {
            type = 'friend'
          } else {
            continue
          }
        } else {
          // 其他未知类型，跳过
          continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username

        contacts.push({
          username,
          displayName,
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          avatarUrl: undefined,
          type,
          lastContactTime: lastContactTimeMap.get(username) || 0
        })
      }




      // 按最近联系时间排序
      contacts.sort((a, b) => {
        const timeA = a.lastContactTime || 0
        const timeB = b.lastContactTime || 0
        if (timeA && timeB) {
          return timeB - timeA
        }
        if (timeA && !timeB) return -1
        if (!timeA && timeB) return 1
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      })

      // 移除临时的lastContactTime字段
      const result = contacts.map(({ lastContactTime, ...rest }) => rest)


      return { success: true, contacts: result }
    } catch (e) {
      console.error('ChatService: 获取通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50,
    startTime: number = 0,
    endTime: number = 0,
    ascending: boolean = false
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
      // 4. startTime 改变
      // 5. ascending 改变
      const needNewCursor = !state ||
        offset === 0 ||
        state.batchSize !== batchSize ||
        state.startTime !== startTime ||
        state.endTime !== endTime ||
        state.ascending !== ascending

      if (needNewCursor) {
        // 关闭旧游标
        if (state) {
          try {
            await wcdbService.closeMessageCursor(state.cursor)
          } catch (e) {
            console.warn('[ChatService] 关闭旧游标失败:', e)
          }
        }

        // 创建新游标
        // 注意：WeFlow 数据库中的 create_time 是以秒为单位的
        const beginTimestamp = startTime > 10000000000 ? Math.floor(startTime / 1000) : startTime
        const endTimestamp = endTime > 10000000000 ? Math.floor(endTime / 1000) : endTime
        const cursorResult = await wcdbService.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)
        if (!cursorResult.success || !cursorResult.cursor) {
          console.error('[ChatService] 打开消息游标失败:', cursorResult.error)
          return { success: false, error: cursorResult.error || '打开消息游标失败' }
        }

        state = { cursor: cursorResult.cursor, fetched: 0, batchSize, startTime, endTime, ascending }
        this.messageCursors.set(sessionId, state)

        // 如果需要跳过消息(offset > 0),逐批获取但不返回
        if (offset > 0) {

          let skipped = 0
          while (skipped < offset) {
            const skipBatch = await wcdbService.fetchMessageBatch(state.cursor)
            if (!skipBatch.success) {
              console.error('[ChatService] 跳过消息批次失败:', skipBatch.error)
              return { success: false, error: skipBatch.error || '跳过消息失败' }
            }
            if (!skipBatch.rows || skipBatch.rows.length === 0) {

              return { success: true, messages: [], hasMore: false }
            }
            skipped += skipBatch.rows.length
            state.fetched += skipBatch.rows.length
            if (!skipBatch.hasMore) {

              return { success: true, messages: [], hasMore: false }
            }
          }

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
      this.messageCacheService.set(sessionId, normalized)
      return { success: true, messages: normalized, hasMore }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getCachedSessionMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      if (!sessionId) return { success: true, messages: [] }
      const entry = this.messageCacheService.get(sessionId)
      if (!entry || !Array.isArray(entry.messages)) {
        return { success: true, messages: [] }
      }
      return { success: true, messages: entry.messages.slice() }
    } catch (error) {
      console.error('ChatService: 获取缓存消息失败:', error)
      return { success: false, error: String(error) }
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

  async getNewMessages(sessionId: string, minTime: number, limit: number = this.messageBatchDefault): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const res = await wcdbService.getNewMessages(sessionId, minTime, limit)
      if (!res.success || !res.messages) {
        return { success: false, error: res.error || '获取新消息失败' }
      }

      // 转换为 Message 对象
      const messages = this.mapRowsToMessages(res.messages as Record<string, any>[])
      const normalized = this.normalizeMessageOrder(messages)

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
    } catch (e) {
      console.error('ChatService: 获取增量消息失败:', e)
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
      const rawMessageContent = this.getRowField(row, [
        'message_content',
        'messageContent',
        'content',
        'msg_content',
        'msgContent',
        'WCDB_CT_message_content',
        'WCDB_CT_messageContent'
      ]);
      const rawCompressContent = this.getRowField(row, [
        'compress_content',
        'compressContent',
        'compressed_content',
        'WCDB_CT_compress_content',
        'WCDB_CT_compressContent'
      ]);

      const content = this.decodeMessageContent(rawMessageContent, rawCompressContent);
      const localType = this.getRowInt(row, ['local_type', 'localType', 'type', 'msg_type', 'msgType', 'WCDB_CT_local_type'], 1)
      const isSendRaw = this.getRowField(row, ['computed_is_send', 'computedIsSend', 'is_send', 'isSend', 'WCDB_CT_is_send'])
      let isSend = isSendRaw === null ? null : parseInt(isSendRaw, 10)
      const senderUsername = this.getRowField(row, ['sender_username', 'senderUsername', 'sender', 'WCDB_CT_sender_username']) || null
      const createTime = this.getRowInt(row, ['create_time', 'createTime', 'createtime', 'msg_create_time', 'msgCreateTime', 'msg_time', 'msgTime', 'time', 'WCDB_CT_create_time'], 0)

      if (senderUsername && (myWxidLower || cleanedWxidLower)) {
        const senderLower = String(senderUsername).toLowerCase()
        const expectedIsSend = (
          senderLower === myWxidLower ||
          senderLower === cleanedWxidLower ||
          // 兼容非 wxid 开头的账号（如果文件夹名带后缀，如 custom_backup，而 sender 是 custom）
          (myWxidLower && myWxidLower.startsWith(senderLower + '_')) ||
          (cleanedWxidLower && cleanedWxidLower.startsWith(senderLower + '_'))
        ) ? 1 : 0
        if (isSend === null) {
          isSend = expectedIsSend
          // [DEBUG] Issue #34: 记录 isSend 推断过程
          if (expectedIsSend === 0 && localType === 1) {
            // 仅在被判为接收且是文本消息时记录，避免刷屏
            // 
          }
        }
      } else if (senderUsername && !myWxid) {
        // [DEBUG] Issue #34: 未配置 myWxid，无法判断是否发送
        if (messages.length < 5) {
          console.warn(`[ChatService] Warning: myWxid not set. Cannot determine if message is sent by me. sender=${senderUsername}`)
        }
      }

      let emojiCdnUrl: string | undefined
      let emojiMd5: string | undefined
      let quotedContent: string | undefined
      let quotedSender: string | undefined
      let imageMd5: string | undefined
      let imageDatName: string | undefined
      let videoMd5: string | undefined
      let aesKey: string | undefined
      let encrypVer: number | undefined
      let cdnThumbUrl: string | undefined
      let voiceDurationSeconds: number | undefined
      // Type 49 细分字段
      let linkTitle: string | undefined
      let linkUrl: string | undefined
      let linkThumb: string | undefined
      let fileName: string | undefined
      let fileSize: number | undefined
      let fileExt: string | undefined
      let xmlType: string | undefined
      // 名片消息
      let cardUsername: string | undefined
      let cardNickname: string | undefined
      // 聊天记录
      let chatRecordTitle: string | undefined
      let chatRecordList: Array<{
        datatype: number
        sourcename: string
        sourcetime: string
        datadesc: string
        datatitle?: string
      }> | undefined

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
      } else if (localType === 43 && content) {
        // 视频消息
        videoMd5 = this.parseVideoMd5(content)
      } else if (localType === 34 && content) {
        voiceDurationSeconds = this.parseVoiceDurationSeconds(content)
      } else if (localType === 42 && content) {
        // 名片消息
        const cardInfo = this.parseCardInfo(content)
        cardUsername = cardInfo.username
        cardNickname = cardInfo.nickname
      } else if (localType === 49 && content) {
        // Type 49 消息（链接、文件、小程序、转账等）
        const type49Info = this.parseType49Message(content)
        xmlType = type49Info.xmlType
        linkTitle = type49Info.linkTitle
        linkUrl = type49Info.linkUrl
        linkThumb = type49Info.linkThumb
        fileName = type49Info.fileName
        fileSize = type49Info.fileSize
        fileExt = type49Info.fileExt
        chatRecordTitle = type49Info.chatRecordTitle
        chatRecordList = type49Info.chatRecordList
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
        videoMd5,
        voiceDurationSeconds,
        aesKey,
        encrypVer,
        cdnThumbUrl,
        linkTitle,
        linkUrl,
        linkThumb,
        fileName,
        fileSize,
        fileExt,
        xmlType,
        cardUsername,
        cardNickname,
        chatRecordTitle,
        chatRecordList
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
        return this.parseVoipMessage(content)
      case 10000:
        return this.cleanSystemMessage(content)
      case 244813135921:
        // 引用消息，提取 title
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      case 266287972401:
        return this.cleanPatMessage(content)
      case 81604378673:
        return '[聊天记录]'
      case 8594229559345:
        return '[红包]'
      case 8589934592049:
        return '[转账]'
      default:
        // 检查是否是 type=87 的群公告消息
        if (xmlType === '87') {
          const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
          if (textAnnouncement) {
            return `[群公告] ${textAnnouncement}`
          }
          return '[群公告]'
        }

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

    // 群公告消息（type 87）特殊处理
    if (type === '87') {
      const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
      if (textAnnouncement) {
        return `[群公告] ${textAnnouncement}`
      }
      return '[群公告]'
    }

    if (title) {
      switch (type) {
        case '5':
        case '49':
          return `[链接] ${title}`
        case '6':
          return `[文件] ${title}`
        case '19':
          return `[聊天记录] ${title}`
        case '33':
        case '36':
          return `[小程序] ${title}`
        case '57':
          // 引用消息，title 就是回复的内容
          return title
        case '2000':
          return `[转账] ${title}`
        default:
          return title
      }
    }

    // 如果没有 title，根据 type 返回默认标签
    switch (type) {
      case '6':
        return '[文件]'
      case '19':
        return '[聊天记录]'
      case '33':
      case '36':
        return '[小程序]'
      case '2000':
        return '[转账]'
      case '87':
        return '[群公告]'
      default:
        return '[消息]'
    }
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

  /**
   * 解析视频MD5
   * 注意：提取 md5 字段用于查询 hardlink.db，获取实际视频文件名
   */
  private parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    try {
      // 提取 md5，这是用于查询 hardlink.db 的值
      const md5 =
        this.extractXmlAttribute(content, 'videomsg', 'md5') ||
        this.extractXmlValue(content, 'md5') ||
        undefined

      return md5?.toLowerCase()
    } catch {
      return undefined
    }
  }

  /**
   * 解析通话消息
   * 格式: <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[...]]></msg><room_type>0/1</room_type>...</VoIPBubbleMsg></voipmsg>
   * room_type: 0 = 语音通话, 1 = 视频通话
   * msg 状态: 通话时长 XX:XX, 对方无应答, 已取消, 已在其它设备接听, 对方已拒绝 等
   */
  private parseVoipMessage(content: string): string {
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
        // 已接听的通话，提取时长
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
        // 其他状态直接使用 msg 内容
        return `[${callType}] ${msg}`
      }

      return `[${callType}]`
    } catch (e) {
      console.error('[ChatService] Failed to parse VOIP message:', e)
      return '[通话]'
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

  /**
   * 解析名片消息
   * 格式: <msg username="wxid_xxx" nickname="昵称" ... />
   */
  private parseCardInfo(content: string): { username?: string; nickname?: string } {
    try {
      if (!content) return {}

      // 提取 username
      const username = this.extractXmlAttribute(content, 'msg', 'username') || undefined

      // 提取 nickname
      const nickname = this.extractXmlAttribute(content, 'msg', 'nickname') || undefined

      return { username, nickname }
    } catch (e) {
      console.error('[ChatService] 名片解析失败:', e)
      return {}
    }
  }

  /**
   * 解析 Type 49 消息（链接、文件、小程序、转账等）
   * 根据 <appmsg><type>X</type> 区分不同类型
   */
  private parseType49Message(content: string): {
    xmlType?: string
    linkTitle?: string
    linkUrl?: string
    linkThumb?: string
    fileName?: string
    fileSize?: number
    fileExt?: string
    chatRecordTitle?: string
    chatRecordList?: Array<{
      datatype: number
      sourcename: string
      sourcetime: string
      datadesc: string
      datatitle?: string
    }>
  } {
    try {
      if (!content) return {}

      // 提取 appmsg 中的 type
      const xmlType = this.extractXmlValue(content, 'type')
      if (!xmlType) return {}

      const result: any = { xmlType }

      // 提取通用字段
      const title = this.extractXmlValue(content, 'title')
      const url = this.extractXmlValue(content, 'url')

      switch (xmlType) {
        case '6': {
          // 文件消息
          result.fileName = title || this.extractXmlValue(content, 'filename')
          result.linkTitle = result.fileName

          // 提取文件大小
          const fileSizeStr = this.extractXmlValue(content, 'totallen') ||
            this.extractXmlValue(content, 'filesize')
          if (fileSizeStr) {
            const size = parseInt(fileSizeStr, 10)
            if (!isNaN(size)) {
              result.fileSize = size
            }
          }

          // 提取文件扩展名
          const fileExt = this.extractXmlValue(content, 'fileext')
          if (fileExt) {
            result.fileExt = fileExt
          } else if (result.fileName) {
            // 从文件名提取扩展名
            const match = /\.([^.]+)$/.exec(result.fileName)
            if (match) {
              result.fileExt = match[1]
            }
          }
          break
        }

        case '19': {
          // 聊天记录
          result.chatRecordTitle = title || '聊天记录'

          // 解析聊天记录列表
          const recordList: Array<{
            datatype: number
            sourcename: string
            sourcetime: string
            datadesc: string
            datatitle?: string
          }> = []

          // 查找所有 <recorditem> 标签
          const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
          let match: RegExpExecArray | null

          while ((match = recordItemRegex.exec(content)) !== null) {
            const itemXml = match[1]

            const datatypeStr = this.extractXmlValue(itemXml, 'datatype')
            const sourcename = this.extractXmlValue(itemXml, 'sourcename')
            const sourcetime = this.extractXmlValue(itemXml, 'sourcetime')
            const datadesc = this.extractXmlValue(itemXml, 'datadesc')
            const datatitle = this.extractXmlValue(itemXml, 'datatitle')

            if (sourcename && datadesc) {
              recordList.push({
                datatype: datatypeStr ? parseInt(datatypeStr, 10) : 0,
                sourcename,
                sourcetime: sourcetime || '',
                datadesc,
                datatitle: datatitle || undefined
              })
            }
          }

          if (recordList.length > 0) {
            result.chatRecordList = recordList
          }
          break
        }

        case '33':
        case '36': {
          // 小程序
          result.linkTitle = title
          result.linkUrl = url

          // 提取缩略图
          const thumbUrl = this.extractXmlValue(content, 'thumburl') ||
            this.extractXmlValue(content, 'cdnthumburl')
          if (thumbUrl) {
            result.linkThumb = thumbUrl
          }
          break
        }

        case '2000': {
          // 转账
          result.linkTitle = title || '[转账]'

          // 可以提取转账金额等信息
          const payMemo = this.extractXmlValue(content, 'pay_memo')
          const feedesc = this.extractXmlValue(content, 'feedesc')

          if (payMemo) {
            result.linkTitle = payMemo
          } else if (feedesc) {
            result.linkTitle = feedesc
          }
          break
        }

        default: {
          // 其他类型，提取通用字段
          result.linkTitle = title
          result.linkUrl = url

          const thumbUrl = this.extractXmlValue(content, 'thumburl') ||
            this.extractXmlValue(content, 'cdnthumburl')
          if (thumbUrl) {
            result.linkThumb = thumbUrl
          }
        }
      }

      return result
    } catch (e) {
      console.error('[ChatService] Type 49 消息解析失败:', e)
      return {}
    }
  }

  //手动查找 media_*.db 文件（当 WCDB DLL 不支持 listMediaDbs 时的 fallback）
  private async findMediaDbsManually(): Promise<string[]> {
    try {
      const dbPath = this.configService.get('dbPath')
      const myWxid = this.configService.get('myWxid')
      if (!dbPath || !myWxid) return []

      // 可能的目录结构：
      // 1. dbPath 直接指向 db_storage: D:\weixin\WeChat Files\wxid_xxx\db_storage
      // 2. dbPath 指向账号目录: D:\weixin\WeChat Files\wxid_xxx
      // 3. dbPath 指向 WeChat Files: D:\weixin\WeChat Files
      // 4. dbPath 指向微信根目录: D:\weixin
      // 5. dbPath 指向非标准目录: D:\weixin\xwechat_files

      const searchDirs: string[] = []

      // 尝试1: dbPath 本身就是 db_storage
      if (basename(dbPath).toLowerCase() === 'db_storage') {
        searchDirs.push(dbPath)
      }

      // 尝试2: dbPath/db_storage
      const dbStorage1 = join(dbPath, 'db_storage')
      if (existsSync(dbStorage1)) {
        searchDirs.push(dbStorage1)
      }

      // 尝试3: dbPath/WeChat Files/[wxid]/db_storage
      const wechatFiles = join(dbPath, 'WeChat Files')
      if (existsSync(wechatFiles)) {
        const wxidDir = join(wechatFiles, myWxid)
        if (existsSync(wxidDir)) {
          const dbStorage2 = join(wxidDir, 'db_storage')
          if (existsSync(dbStorage2)) {
            searchDirs.push(dbStorage2)
          }
        }
      }

      // 尝试4: 如果 dbPath 已经包含 WeChat Files，直接在其中查找
      if (dbPath.includes('WeChat Files')) {
        const parts = dbPath.split(path.sep)
        const wechatFilesIndex = parts.findIndex(p => p === 'WeChat Files')
        if (wechatFilesIndex >= 0) {
          const wechatFilesPath = parts.slice(0, wechatFilesIndex + 1).join(path.sep)
          const wxidDir = join(wechatFilesPath, myWxid)
          if (existsSync(wxidDir)) {
            const dbStorage3 = join(wxidDir, 'db_storage')
            if (existsSync(dbStorage3) && !searchDirs.includes(dbStorage3)) {
              searchDirs.push(dbStorage3)
            }
          }
        }
      }

      // 尝试5: 直接尝试 dbPath/[wxid]/db_storage (适用于 xwechat_files 等非标准目录名)
      const wxidDirDirect = join(dbPath, myWxid)
      if (existsSync(wxidDirDirect)) {
        const dbStorage5 = join(wxidDirDirect, 'db_storage')
        if (existsSync(dbStorage5) && !searchDirs.includes(dbStorage5)) {
          searchDirs.push(dbStorage5)
        }
      }

      // 在所有可能的目录中查找 media_*.db
      const mediaDbFiles: string[] = []
      for (const dir of searchDirs) {
        if (!existsSync(dir)) continue

        // 直接在当前目录查找
        const entries = readdirSync(dir)
        for (const entry of entries) {
          if (entry.toLowerCase().startsWith('media_') && entry.toLowerCase().endsWith('.db')) {
            const fullPath = join(dir, entry)
            if (existsSync(fullPath) && statSync(fullPath).isFile()) {
              if (!mediaDbFiles.includes(fullPath)) {
                mediaDbFiles.push(fullPath)
              }
            }
          }
        }

        // 也检查子目录（特别是 message 子目录）
        for (const entry of entries) {
          const subDir = join(dir, entry)
          if (existsSync(subDir) && statSync(subDir).isDirectory()) {
            try {
              const subEntries = readdirSync(subDir)
              for (const subEntry of subEntries) {
                if (subEntry.toLowerCase().startsWith('media_') && subEntry.toLowerCase().endsWith('.db')) {
                  const fullPath = join(subDir, subEntry)
                  if (existsSync(fullPath) && statSync(fullPath).isFile()) {
                    if (!mediaDbFiles.includes(fullPath)) {
                      mediaDbFiles.push(fullPath)
                    }
                  }
                }
              }
            } catch (e) {
              // 忽略无法访问的子目录
            }
          }
        }
      }

      return mediaDbFiles
    } catch (e) {
      console.error('[ChatService] 手动查找 media 数据库失败:', e)
      return []
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
    // 匹配 <tagName ... attrName="value" ... /> 或 <tagName ... attrName="value" ...>
    const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"']`, 'i')
    const match = regex.exec(xml)
    return match ? match[1] : ''
  }

  private cleanSystemMessage(content: string): string {
    // 移除 XML 声明
    let cleaned = content.replace(/<\?xml[^?]*\?>/gi, '')
    // 移除所有 XML/HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 移除尾部的数字（如撤回消息后的时间戳）
    cleaned = cleaned.replace(/\d+\s*$/, '')
    // 清理多余空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned || '[系统消息]'
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
   * 清理拍一拍消息
   * 格式示例: 我拍了拍 "梨绒" ງ໐໐໓ ຖiງht620000wxid_...
   */
  private cleanPatMessage(content: string): string {
    if (!content) return '[拍一拍]'

    // 1. 尝试匹配标准的 "A拍了拍B" 格式
    // 这里的正则比较宽泛，为了兼容不同的语言环境
    const match = /^(.+?拍了拍.+?)(?:[\r\n]|$|ງ|wxid_)/.exec(content)
    if (match) {
      return `[拍一拍] ${match[1].trim()}`
    }

    // 2. 如果匹配失败，尝试清理掉疑似的 garbage (wxid, 乱码)
    let cleaned = content.replace(/wxid_[a-zA-Z0-9_-]+/g, '') // 移除 wxid
    cleaned = cleaned.replace(/[ງ໐໓ຖiht]+/g, ' ') // 移除已知的乱码字符
    cleaned = cleaned.replace(/\d{6,}/g, '') // 移除长数字
    cleaned = cleaned.replace(/\s+/g, ' ').trim() // 清理空格

    // 移除不可见字符
    cleaned = this.cleanUtf16(cleaned)

    // 如果清理后还有内容，返回
    if (cleaned && cleaned.length > 1 && !cleaned.includes('xml')) {
      return `[拍一拍] ${cleaned}`
    }

    return '[拍一拍]'
  }

  /**
   * 解码消息内容（处理 BLOB 和压缩数据）
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    // 优先使用 compress_content
    let content = this.decodeMaybeCompressed(compressContent, 'compress_content')
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent, 'message_content')
    }
    return content
  }

  /**
   * 尝试解码可能压缩的内容
   */
  private decodeMaybeCompressed(raw: any, fieldName: string = 'unknown'): string {
    if (!raw) return ''

    // 

    // 如果是 Buffer/Uint8Array
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      return this.decodeBinaryContent(Buffer.from(raw), String(raw))
    }

    // 如果是字符串
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''

      // 检查是否是 hex 编码
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) {
          const result = this.decodeBinaryContent(bytes, raw)
          // 
          return result
        }
      }

      // 检查是否是 base64 编码
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes, raw)
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
  private decodeBinaryContent(data: Buffer, fallbackValue?: string): string {
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

      // 如果提供了 fallbackValue，且解码结果看起来像二进制垃圾，则返回 fallbackValue
      if (fallbackValue && replacementCount > 0) {
        // 
        return fallbackValue
      }

      // 尝试 latin1 解码
      return data.toString('latin1')
    } catch {
      return fallbackValue || ''
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
      // 检查缓存是否有效，且头像不是错误的 hex 格式
      const isValidAvatar = cached?.avatarUrl && !cached.avatarUrl.includes('base64,ffd8')
      if (cached && isValidAvatar && Date.now() - cached.updatedAt < this.avatarCacheTtlMs) {
        return { avatarUrl: cached.avatarUrl, displayName: cached.displayName }
      }

      const contact = await this.getContact(username)
      const avatarResult = await wcdbService.getAvatarUrls([username])
      const avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined
      const displayName = contact?.remark || contact?.nickName || contact?.alias || cached?.displayName || username
      const cacheEntry: ContactCacheEntry = {
        avatarUrl,
        displayName,
        updatedAt: Date.now()
      }
      this.avatarCache.set(username, cacheEntry)
      this.contactCacheService.setEntries({ [username]: cacheEntry })
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
      // 增加 'self' 作为兜底标识符，微信有时将个人信息存储在 'self' 记录中
      const fetchList = Array.from(new Set([myWxid, cleanedWxid, 'self']))

      const result = await wcdbService.getAvatarUrls(fetchList)

      if (result.success && result.map) {
        // 按优先级尝试匹配
        const avatarUrl = result.map[myWxid] || result.map[cleanedWxid] || result.map['self']
        if (avatarUrl) {
          return { success: true, avatarUrl }
        }
        return { success: true, avatarUrl: undefined }
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
  /**
   * 获取语音缓存目录
   */
  private getVoiceCacheDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) {
      return join(cachePath, 'Voices')
    }
    // 回退到默认目录
    const documentsPath = app.getPath('documents')
    return join(documentsPath, 'WeFlow', 'Voices')
  }

  private getEmojiCacheDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) {
      return join(cachePath, 'Emojis')
    }
    // 回退到默认目录
    const documentsPath = app.getPath('documents')
    return join(documentsPath, 'WeFlow', 'Emojis')
  }

  clearCaches(options?: { includeMessages?: boolean; includeContacts?: boolean; includeEmojis?: boolean }): { success: boolean; error?: string } {
    const includeMessages = options?.includeMessages !== false
    const includeContacts = options?.includeContacts !== false
    const includeEmojis = options?.includeEmojis !== false
    const errors: string[] = []

    if (includeContacts) {
      this.avatarCache.clear()
      this.contactCacheService.clear()
    }

    if (includeMessages) {
      this.messageCacheService.clear()
      this.voiceWavCache.clear()
      this.voiceTranscriptCache.clear()
      this.voiceTranscriptPending.clear()
    }

    for (const state of this.hardlinkCache.values()) {
      try {
        state.db?.close()
      } catch { }
    }
    this.hardlinkCache.clear()

    if (includeEmojis) {
      emojiCache.clear()
      emojiDownloading.clear()
      const emojiDir = this.getEmojiCacheDir()
      try {
        fs.rmSync(emojiDir, { recursive: true, force: true })
      } catch (error) {
        errors.push(String(error))
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') }
    }
    return { success: true }
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

      const datPath = await this.findDatFile(actualAccountDir, baseName, sessionId)
      if (!datPath) return { success: false, error: '未找到图片源文件 (.dat)' }

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

      // 返回 base64
      return { success: true, data: decrypted.toString('base64') }
    } catch (e) {
      console.error('ChatService: getImageData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * getVoiceData (绕过WCDB的buggy getVoiceData，直接用execQuery读取)
   */
  async getVoiceData(sessionId: string, msgId: string, createTime?: number, serverId?: string | number, senderWxidOpt?: string): Promise<{ success: boolean; data?: string; error?: string }> {
    const startTime = Date.now()
    try {
      const localId = parseInt(msgId, 10)
      if (isNaN(localId)) {
        return { success: false, error: '无效的消息ID' }
      }

      let msgCreateTime = createTime
      let senderWxid: string | null = senderWxidOpt || null

      // 如果前端没传 createTime，才需要查询消息（这个很慢）
      if (!msgCreateTime) {
        const t1 = Date.now()
        const msgResult = await this.getMessageByLocalId(sessionId, localId)
        const t2 = Date.now()


        if (msgResult.success && msgResult.message) {
          const msg = msgResult.message as any
          msgCreateTime = msg.createTime
          senderWxid = msg.senderUsername || null
        }
      }

      if (!msgCreateTime) {
        return { success: false, error: '未找到消息时间戳' }
      }

      // 使用 sessionId + createTime 作为缓存key
      const cacheKey = `${sessionId}_${msgCreateTime}`

      // 检查 WAV 内存缓存
      const wavCache = this.voiceWavCache.get(cacheKey)
      if (wavCache) {

        return { success: true, data: wavCache.toString('base64') }
      }

      // 检查 WAV 文件缓存
      const voiceCacheDir = this.getVoiceCacheDir()
      const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
      if (existsSync(wavFilePath)) {
        try {
          const wavData = readFileSync(wavFilePath)
          // 同时缓存到内存
          this.cacheVoiceWav(cacheKey, wavData)

          return { success: true, data: wavData.toString('base64') }
        } catch (e) {
          console.error('[Voice] 读取缓存文件失败:', e)
        }
      }

      // 构建查找候选
      const candidates: string[] = []
      const myWxid = this.configService.get('myWxid') as string

      // 如果有 senderWxid，优先使用（群聊中最重要）
      if (senderWxid) {
        candidates.push(senderWxid)
      }

      // sessionId（1对1聊天时是对方wxid，群聊时是群id）
      if (sessionId && !candidates.includes(sessionId)) {
        candidates.push(sessionId)
      }

      // 我的wxid（兜底）
      if (myWxid && !candidates.includes(myWxid)) {
        candidates.push(myWxid)
      }

      const t3 = Date.now()
      // 从数据库读取 silk 数据
      const silkData = await this.getVoiceDataFromMediaDb(msgCreateTime, candidates)
      const t4 = Date.now()


      if (!silkData) {
        return { success: false, error: '未找到语音数据 (请确保已在微信中播放过该语音)' }
      }

      const t5 = Date.now()
      // 使用 silk-wasm 解码
      const pcmData = await this.decodeSilkToPcm(silkData, 24000)
      const t6 = Date.now()


      if (!pcmData) {
        return { success: false, error: 'Silk 解码失败' }
      }

      const t7 = Date.now()
      // PCM -> WAV
      const wavData = this.createWavBuffer(pcmData, 24000)
      const t8 = Date.now()


      // 缓存 WAV 数据到内存
      this.cacheVoiceWav(cacheKey, wavData)

      // 缓存 WAV 数据到文件（异步，不阻塞返回）
      this.cacheVoiceWavToFile(cacheKey, wavData)


      return { success: true, data: wavData.toString('base64') }
    } catch (e) {
      console.error('ChatService: getVoiceData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 缓存 WAV 数据到文件（异步）
   */
  private async cacheVoiceWavToFile(cacheKey: string, wavData: Buffer): Promise<void> {
    try {
      const voiceCacheDir = this.getVoiceCacheDir()
      if (!existsSync(voiceCacheDir)) {
        mkdirSync(voiceCacheDir, { recursive: true })
      }

      const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
      writeFileSync(wavFilePath, wavData)
    } catch (e) {
      console.error('[Voice] 缓存文件失败:', e)
    }
  }

  /**
   * 通过 WCDB 的 execQuery 直接查询 media.db（绕过有bug的getVoiceData接口）
   * 策略：批量查询 + 多种兜底方案
   */
  private async getVoiceDataFromMediaDb(createTime: number, candidates: string[]): Promise<Buffer | null> {
    const startTime = Date.now()
    try {
      const t1 = Date.now()
      // 获取所有 media 数据库（永久缓存，直到应用重启）
      let mediaDbFiles: string[]
      if (this.mediaDbsCache) {
        mediaDbFiles = this.mediaDbsCache

      } else {
        const mediaDbsResult = await wcdbService.listMediaDbs()
        const t2 = Date.now()


        let files = mediaDbsResult.success && mediaDbsResult.data ? (mediaDbsResult.data as string[]) : []

        // Fallback: 如果 WCDB DLL 没找到，手动查找
        if (files.length === 0) {
          console.warn('[Voice] listMediaDbs returned empty, trying manual search')
          files = await this.findMediaDbsManually()
        }

        if (files.length === 0) {
          console.error('[Voice] No media DBs found')
          return null
        }

        mediaDbFiles = files
        this.mediaDbsCache = mediaDbFiles // 永久缓存
      }

      // 在所有 media 数据库中查找
      for (const dbPath of mediaDbFiles) {
        try {
          // 检查缓存
          let schema = this.mediaDbSchemaCache.get(dbPath)

          if (!schema) {
            const t3 = Date.now()
            // 第一次查询，获取表结构并缓存
            const tablesResult = await wcdbService.execQuery('media', dbPath,
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
            )
            const t4 = Date.now()


            if (!tablesResult.success || !tablesResult.rows || tablesResult.rows.length === 0) {
              continue
            }

            const voiceTable = tablesResult.rows[0].name

            const t5 = Date.now()
            const columnsResult = await wcdbService.execQuery('media', dbPath,
              `PRAGMA table_info('${voiceTable}')`
            )
            const t6 = Date.now()


            if (!columnsResult.success || !columnsResult.rows) {
              continue
            }

            // 创建列名映射（原始名称 -> 小写名称）
            const columnMap = new Map<string, string>()
            for (const c of columnsResult.rows) {
              const name = String(c.name || '')
              if (name) {
                columnMap.set(name.toLowerCase(), name)
              }
            }

            // 查找数据列（使用原始列名）
            const dataColumnLower = ['voice_data', 'buf', 'voicebuf', 'data'].find(n => columnMap.has(n))
            const dataColumn = dataColumnLower ? columnMap.get(dataColumnLower) : undefined

            if (!dataColumn) {
              continue
            }

            // 查找 chat_name_id 列
            const chatNameIdColumnLower = ['chat_name_id', 'chatnameid', 'chat_nameid'].find(n => columnMap.has(n))
            const chatNameIdColumn = chatNameIdColumnLower ? columnMap.get(chatNameIdColumnLower) : undefined

            // 查找时间列
            const timeColumnLower = ['create_time', 'createtime', 'time'].find(n => columnMap.has(n))
            const timeColumn = timeColumnLower ? columnMap.get(timeColumnLower) : undefined

            const t7 = Date.now()
            // 查找 Name2Id 表
            const name2IdTablesResult = await wcdbService.execQuery('media', dbPath,
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'"
            )
            const t8 = Date.now()


            const name2IdTable = (name2IdTablesResult.success && name2IdTablesResult.rows && name2IdTablesResult.rows.length > 0)
              ? name2IdTablesResult.rows[0].name
              : undefined

            schema = {
              voiceTable,
              dataColumn,
              chatNameIdColumn,
              timeColumn,
              name2IdTable
            }

            // 缓存表结构
            this.mediaDbSchemaCache.set(dbPath, schema)
          }

          // 策略1: 通过 chat_name_id + create_time 查找（最准确）
          if (schema.chatNameIdColumn && schema.timeColumn && schema.name2IdTable) {
            const t9 = Date.now()
            // 批量获取所有 candidates 的 chat_name_id（减少查询次数）
            const candidatesStr = candidates.map(c => `'${c.replace(/'/g, "''")}'`).join(',')
            const name2IdResult = await wcdbService.execQuery('media', dbPath,
              `SELECT user_name, rowid FROM ${schema.name2IdTable} WHERE user_name IN (${candidatesStr})`
            )
            const t10 = Date.now()


            if (name2IdResult.success && name2IdResult.rows && name2IdResult.rows.length > 0) {
              // 构建 chat_name_id 列表
              const chatNameIds = name2IdResult.rows.map((r: any) => r.rowid)
              const chatNameIdsStr = chatNameIds.join(',')

              const t11 = Date.now()
              // 一次查询所有可能的语音
              const voiceResult = await wcdbService.execQuery('media', dbPath,
                `SELECT ${schema.dataColumn} AS data FROM ${schema.voiceTable} WHERE ${schema.chatNameIdColumn} IN (${chatNameIdsStr}) AND ${schema.timeColumn} = ${createTime} LIMIT 1`
              )
              const t12 = Date.now()


              if (voiceResult.success && voiceResult.rows && voiceResult.rows.length > 0) {
                const row = voiceResult.rows[0]
                const silkData = this.decodeVoiceBlob(row.data)
                if (silkData) {

                  return silkData
                }
              }
            }
          }

          // 策略2: 只通过 create_time 查找（兜底）
          if (schema.timeColumn) {
            const t13 = Date.now()
            const voiceResult = await wcdbService.execQuery('media', dbPath,
              `SELECT ${schema.dataColumn} AS data FROM ${schema.voiceTable} WHERE ${schema.timeColumn} = ${createTime} LIMIT 1`
            )
            const t14 = Date.now()


            if (voiceResult.success && voiceResult.rows && voiceResult.rows.length > 0) {
              const row = voiceResult.rows[0]
              const silkData = this.decodeVoiceBlob(row.data)
              if (silkData) {

                return silkData
              }
            }
          }

          // 策略3: 时间范围查找（±5秒，处理时间戳不精确的情况）
          if (schema.timeColumn) {
            const t15 = Date.now()
            const voiceResult = await wcdbService.execQuery('media', dbPath,
              `SELECT ${schema.dataColumn} AS data FROM ${schema.voiceTable} WHERE ${schema.timeColumn} BETWEEN ${createTime - 5} AND ${createTime + 5} ORDER BY ABS(${schema.timeColumn} - ${createTime}) LIMIT 1`
            )
            const t16 = Date.now()


            if (voiceResult.success && voiceResult.rows && voiceResult.rows.length > 0) {
              const row = voiceResult.rows[0]
              const silkData = this.decodeVoiceBlob(row.data)
              if (silkData) {

                return silkData
              }
            }
          }
        } catch (e) {
          // 静默失败，继续尝试下一个数据库
        }
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 检查语音是否已有缓存（只检查内存，不查询数据库）
   */
  async resolveVoiceCache(sessionId: string, msgId: string): Promise<{ success: boolean; hasCache: boolean; data?: string }> {
    try {
      // 直接用 msgId 生成 cacheKey，不查询数据库
      // 注意：这里的 cacheKey 可能不准确（因为没有 createTime），但只是用来快速检查缓存
      // 如果缓存未命中，用户点击时会重新用正确的 cacheKey 查询
      const cacheKey = this.getVoiceCacheKey(sessionId, msgId)

      // 检查内存缓存
      const inMemory = this.voiceWavCache.get(cacheKey)
      if (inMemory) {
        return { success: true, hasCache: true, data: inMemory.toString('base64') }
      }

      return { success: true, hasCache: false }
    } catch (e) {
      return { success: false, hasCache: false }
    }
  }

  async getVoiceData_Legacy(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      const msgResult = await this.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) return { success: false, error: '未找到该消息' }
      const msg = msgResult.message
      if (msg.isSend === 1) {
        console.info('[ChatService][Voice] self-sent voice, continue decrypt flow')
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
      let mediaDbs = await wcdbService.listMediaDbs()
      // Fallback: 如果 WCDB DLL 不支持 listMediaDbs，手动查找
      if (!mediaDbs.success || !mediaDbs.data || mediaDbs.data.length === 0) {
        const manualMediaDbs = await this.findMediaDbsManually()
        if (manualMediaDbs.length > 0) {
          mediaDbs = { success: true, data: manualMediaDbs }
        } else {
          return { success: false, error: '未找到媒体库文件 (media_*.db)' }
        }
      }

      // 3. 在所有媒体库中查找该消息的语音数据
      let silkData: Buffer | null = null
      for (const dbPath of (mediaDbs.data || [])) {
        const voiceTable = await this.resolveVoiceInfoTableName(dbPath)
        if (!voiceTable) {
          continue
        }
        const columns = await this.resolveVoiceInfoColumns(dbPath, voiceTable)
        if (!columns) {
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

        // 策略 3: 只使用 CreateTime (兜底)
        if (!silkData && columns.createTimeColumn) {
          const whereClause = `${columns.createTimeColumn} = ${msg.createTime}`
          const sql = `SELECT ${columns.dataColumn} AS data FROM ${voiceTable} WHERE ${whereClause} LIMIT 1`
          const result = await wcdbService.execQuery('media', dbPath, sql)
          if (result.success && result.rows && result.rows.length > 0) {
            const raw = result.rows[0]?.data
            const decoded = this.decodeVoiceBlob(raw)
            if (decoded && decoded.length > 0) {
              console.info('[ChatService][Voice] hit by createTime only', { dbPath, voiceTable, whereClause, bytes: decoded.length })
              silkData = decoded
            }
          }
        }
        if (silkData) break
      }

      if (!silkData) return { success: false, error: '未找到语音数据' }

      // 4. 使用 silk-wasm 解码
      try {
        const pcmData = await this.decodeSilkToPcm(silkData, 24000)
        if (!pcmData) {
          return { success: false, error: 'Silk 解码失败' }
        }

        // PCM -> WAV
        const wavData = this.createWavBuffer(pcmData, 24000)

        // 缓存 WAV 数据 (内存缓存)
        const cacheKey = this.getVoiceCacheKey(sessionId, msgId)
        this.cacheVoiceWav(cacheKey, wavData)

        return { success: true, data: wavData.toString('base64') }
      } catch (e) {
        console.error('[ChatService][Voice] decoding error:', e)
        return { success: false, error: '语音解码失败: ' + String(e) }
      }
    } catch (e) {
      console.error('ChatService: getVoiceData 失败:', e)
      return { success: false, error: String(e) }
    }
  }



  /**
   * 解码 Silk 数据为 PCM (silk-wasm)
   */
  private async decodeSilkToPcm(silkData: Buffer, sampleRate: number): Promise<Buffer | null> {
    try {
      let wasmPath: string
      if (app.isPackaged) {
        wasmPath = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        if (!existsSync(wasmPath)) {
          wasmPath = join(process.resourcesPath, 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        }
      } else {
        wasmPath = join(app.getAppPath(), 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
      }

      if (!existsSync(wasmPath)) {
        console.error('[ChatService][Voice] silk.wasm not found at:', wasmPath)
        return null
      }

      const silkWasm = require('silk-wasm')
      if (!silkWasm || !silkWasm.decode) {
        console.error('[ChatService][Voice] silk-wasm module invalid')
        return null
      }

      const result = await silkWasm.decode(silkData, sampleRate)
      return Buffer.from(result.data)
    } catch (e) {
      console.error('[ChatService][Voice] internal decode error:', e)
      return null
    }
  }

  /**
   * 创建 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
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
    return Buffer.concat([header, pcmData])
  }

  async getVoiceTranscript(
    sessionId: string,
    msgId: string,
    createTime?: number,
    onPartial?: (text: string) => void,
    senderWxid?: string
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const startTime = Date.now()


    try {
      let msgCreateTime = createTime
      let serverId: string | number | undefined

      // 如果前端没传 createTime，才需要查询消息（这个很慢）
      if (!msgCreateTime) {
        const t1 = Date.now()
        const msgResult = await this.getMessageById(sessionId, parseInt(msgId, 10))
        const t2 = Date.now()


        if (msgResult.success && msgResult.message) {
          msgCreateTime = msgResult.message.createTime
          serverId = msgResult.message.serverId

        }
      }

      if (!msgCreateTime) {
        console.error(`[Transcribe] 未找到消息时间戳`)
        return { success: false, error: '未找到消息时间戳' }
      }

      // 使用正确的 cacheKey（包含 createTime）
      const cacheKey = this.getVoiceCacheKey(sessionId, msgId, msgCreateTime)


      // 检查转写缓存
      const cached = this.voiceTranscriptCache.get(cacheKey)
      if (cached) {

        return { success: true, transcript: cached }
      }

      // 检查是否正在转写
      const pending = this.voiceTranscriptPending.get(cacheKey)
      if (pending) {

        return pending
      }

      const task = (async () => {
        try {
          // 检查内存中是否有 WAV 数据
          let wavData = this.voiceWavCache.get(cacheKey)
          if (wavData) {

          } else {
            // 检查文件缓存
            const voiceCacheDir = this.getVoiceCacheDir()
            const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
            if (existsSync(wavFilePath)) {
              try {
                wavData = readFileSync(wavFilePath)

                // 同时缓存到内存
                this.cacheVoiceWav(cacheKey, wavData)
              } catch (e) {
                console.error(`[Transcribe] 读取缓存文件失败:`, e)
              }
            }
          }

          if (!wavData) {

            const t3 = Date.now()
            // 调用 getVoiceData 获取并解码
            const voiceResult = await this.getVoiceData(sessionId, msgId, msgCreateTime, serverId, senderWxid)
            const t4 = Date.now()


            if (!voiceResult.success || !voiceResult.data) {
              console.error(`[Transcribe] 语音解码失败: ${voiceResult.error}`)
              return { success: false, error: voiceResult.error || '语音解码失败' }
            }
            wavData = Buffer.from(voiceResult.data, 'base64')

          }

          // 转写

          const t5 = Date.now()
          const result = await voiceTranscribeService.transcribeWavBuffer(wavData, (text) => {

            onPartial?.(text)
          })
          const t6 = Date.now()


          if (result.success && result.transcript) {

            this.cacheVoiceTranscript(cacheKey, result.transcript)
          } else {
            console.error(`[Transcribe] 转写失败: ${result.error}`)
          }


          return result
        } catch (error) {
          console.error(`[Transcribe] 异常:`, error)
          return { success: false, error: String(error) }
        } finally {
          this.voiceTranscriptPending.delete(cacheKey)
        }
      })()

      this.voiceTranscriptPending.set(cacheKey, task)
      return task
    } catch (error) {
      console.error(`[Transcribe] 外层异常:`, error)
      return { success: false, error: String(error) }
    }
  }



  private getVoiceCacheKey(sessionId: string, msgId: string, createTime?: number): string {
    // 优先使用 createTime 作为key，避免不同会话中localId相同导致的混乱
    if (createTime) {
      return `${sessionId}_${createTime}`
    }
    return `${sessionId}_${msgId}`
  }

  private cacheVoiceWav(cacheKey: string, wavData: Buffer): void {
    this.voiceWavCache.set(cacheKey, wavData)
    if (this.voiceWavCache.size > this.voiceCacheMaxEntries) {
      const oldestKey = this.voiceWavCache.keys().next().value
      if (oldestKey) this.voiceWavCache.delete(oldestKey)
    }
  }

  private cacheVoiceTranscript(cacheKey: string, transcript: string): void {
    this.voiceTranscriptCache.set(cacheKey, transcript)
    if (this.voiceTranscriptCache.size > this.voiceCacheMaxEntries) {
      const oldestKey = this.voiceTranscriptCache.keys().next().value
      if (oldestKey) this.voiceTranscriptCache.delete(oldestKey)
    }
  }

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      // 1. 尝试从缓存获取会话表信息
      let tables = this.sessionTablesCache.get(sessionId)

      if (!tables) {
        // 缓存未命中，查询数据库
        const tableStats = await wcdbService.getMessageTableStats(sessionId)
        if (!tableStats.success || !tableStats.tables || tableStats.tables.length === 0) {
          return { success: false, error: '未找到会话消息表' }
        }

        // 提取表信息并缓存
        tables = tableStats.tables
          .map(t => ({
            tableName: t.table_name || t.name,
            dbPath: t.db_path
          }))
          .filter(t => t.tableName && t.dbPath) as Array<{ tableName: string; dbPath: string }>

        if (tables.length > 0) {
          this.sessionTablesCache.set(sessionId, tables)
          // 设置过期清理
          setTimeout(() => {
            this.sessionTablesCache.delete(sessionId)
          }, this.sessionTablesCacheTtl)
        }
      }

      // 2. 遍历表查找消息 (通常只有一个主表，但可能有归档)
      for (const { tableName, dbPath } of tables) {
        // 构造查询
        const sql = `SELECT * FROM ${tableName} WHERE local_id = ${localId} LIMIT 1`
        const result = await wcdbService.execQuery('message', dbPath, sql)

        if (result.success && result.rows && result.rows.length > 0) {
          const row = result.rows[0]
          const message = this.parseMessage(row)

          if (message.localId !== 0) {
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
      content: rawContent,  // 添加原始内容供视频MD5解析使用
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

    // 如果 dbPath 本身指向 db_storage 目录下的文件（如某个 .db 文件）
    // 则向上回溯到账号目录
    if (basename(normalized).toLowerCase() === 'db_storage') {
      return dirname(normalized)
    }
    const dir = dirname(normalized)
    if (basename(dir).toLowerCase() === 'db_storage') {
      return dirname(dir)
    }

    // 否则，dbPath 应该是数据库根目录（如 xwechat_files）
    // 账号目录应该是 {dbPath}/{wxid}
    const accountDirWithWxid = join(normalized, wxid)
    if (existsSync(accountDirWithWxid)) {
      return accountDirWithWxid
    }

    // 兜底：返回 dbPath 本身（可能 dbPath 已经是账号目录）
    return normalized
  }

  private async findDatFile(accountDir: string, baseName: string, sessionId?: string): Promise<string | null> {
    const normalized = this.normalizeDatBase(baseName)
    if (this.looksLikeMd5(normalized)) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, normalized, sessionId)
      if (hardlinkPath) return hardlinkPath
    }

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

  private looksLikeMd5(value: string): boolean {
    return /^[a-fA-F0-9]{16,32}$/.test(value)
  }

  private normalizeDatBase(name: string): string {
    let base = name.toLowerCase()
    if (base.endsWith('.dat') || base.endsWith('.jpg')) {
      base = base.slice(0, -4)
    }
    while (/[._][a-z]$/.test(base)) {
      base = base.slice(0, -2)
    }
    return base
  }

  private hasXVariant(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private resolveHardlinkPath(accountDir: string, md5: string, sessionId?: string): string | null {
    try {
      const hardlinkPath = join(accountDir, 'hardlink.db')
      if (!existsSync(hardlinkPath)) return null

      const state = this.getHardlinkState(accountDir, hardlinkPath)
      if (!state.imageTable) return null

      const row = state.db
        .prepare(`SELECT dir1, dir2, file_name FROM ${state.imageTable} WHERE md5 = ? LIMIT 1`)
        .get(md5) as { dir1?: string; dir2?: string; file_name?: string } | undefined

      if (!row) return null
      const dir1 = row.dir1 as string | undefined
      const dir2 = row.dir2 as string | undefined
      const fileName = row.file_name as string | undefined
      if (!dir1 || !dir2 || !fileName) return null
      const lowerFileName = fileName.toLowerCase()
      if (lowerFileName.endsWith('.dat')) {
        const baseLower = lowerFileName.slice(0, -4)
        if (!this.hasXVariant(baseLower)) return null
      }

      let dirName = dir2
      if (state.dirTable && sessionId) {
        try {
          const dirRow = state.db
            .prepare(`SELECT dir_name FROM ${state.dirTable} WHERE dir_id = ? AND username = ? LIMIT 1`)
            .get(dir2, sessionId) as { dir_name?: string } | undefined
          if (dirRow?.dir_name) dirName = dirRow.dir_name as string
        } catch { }
      }

      const fullPath = join(accountDir, dir1, dirName, fileName)
      if (existsSync(fullPath)) return fullPath

      const withDat = `${fullPath}.dat`
      if (existsSync(withDat)) return withDat
    } catch { }
    return null
  }

  private getHardlinkState(accountDir: string, hardlinkPath: string): HardlinkState {
    const cached = this.hardlinkCache.get(accountDir)
    if (cached) return cached

    const db = new Database(hardlinkPath, { readonly: true, fileMustExist: true })
    const imageRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'image_hardlink_info%' ORDER BY name DESC LIMIT 1")
      .get() as { name?: string } | undefined
    const dirRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1")
      .get() as { name?: string } | undefined
    const state: HardlinkState = {
      db,
      imageTable: imageRow?.name as string | undefined,
      dirTable: dirRow?.name as string | undefined
    }
    this.hardlinkCache.set(accountDir, state)
    return state
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
    let unpadded: Buffer = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, Buffer.alloc(0))
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
      unpadded = this.strictRemovePadding(decrypted) as Buffer
    }

    const remaining = payload.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) {
      throw new Error('文件格式异常：XOR 数据长度不合法')
    }

    let rawData: Buffer = Buffer.alloc(0)
    let xoredData: Buffer = Buffer.alloc(0)
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) {
        throw new Error('文件格式异常：原始数据长度小于XOR长度')
      }
      rawData = remaining.subarray(0, rawLength) as Buffer
      const xorData = remaining.subarray(rawLength)
      xoredData = Buffer.alloc(xorData.length)
      for (let i = 0; i < xorData.length; i++) {
        xoredData[i] = xorData[i] ^ xorKey
      }
    } else {
      rawData = remaining as Buffer
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

  async execQuery(kind: string, path: string | null, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      return wcdbService.execQuery(kind, path, sql)
    } catch (e) {
      console.error('ChatService: 执行自定义查询失败:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const chatService = new ChatService()
