import { join, dirname, basename, extname } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, watch, promises as fsPromises } from 'fs'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import * as crypto from 'crypto'
import { app, BrowserWindow, dialog } from 'electron'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { MessageCacheService } from './messageCacheService'
import { ContactCacheService, ContactCacheEntry } from './contactCacheService'
import { exportCardDiagnosticsService } from './exportCardDiagnosticsService'
import { emojiCache, emojiDownloading, FRIEND_EXCLUDE_USERNAMES } from './chat/constants'
import { cleanAccountDirName } from './chat/accountUtils'
import {
  buildMessageKey,
  coerceRowNumber,
  compareMessagesByTimeline,
  encodeMessageKeySegment,
  getMessageSourceInfo,
  getRowField,
  getRowInt,
  getRowTimestampSeconds,
  normalizeMessageOrder,
  normalizeTimestampLikeToSeconds,
  normalizeUnsignedIntegerToken,
  parseCompactDateTimeDigitsToSeconds,
  parseDateTimeTextToSeconds,
  resolveMessageIsSend
} from './chat/messageRowUtils'
import {
  mapRowsToMessages,
  mapRowsToMessagesLite
} from './chat/messageMapper'
import {
  cleanString,
  cleanUtf16,
  compactEncodedPayload,
  decodeBinaryContent,
  decodeHtmlEntities,
  decodeMaybeCompressed,
  decodeMessageContent,
  extractXmlValue,
  extractSenderUsernameFromContent,
  getMessageTypeLabel,
  looksLikeHex,
  looksLikeBase64,
  parseCardInfo,
  parseEmojiInfo,
  parseImageDatNameFromRow,
  parseMessageContent,
  parseType49Message,
  parseImageInfo,
  parseVideoFileNameFromRow,
  sanitizeQuotedContent,
  stripSenderPrefix
} from './chat/messageParsing'
import { MyFootprintService } from './chat/myFootprintService'
import type { MyFootprintHost } from './chat/myFootprintHost'
import { SessionStatsService } from './chat/sessionStatsService'
import type { SessionStatsHost } from './chat/sessionStatsHost'
import { MediaAssetsService } from './chat/mediaAssetsService'
import type { MediaAssetsHost } from './chat/mediaAssetsHost'
import { MessageCursorService } from './chat/messageCursorService'
import type { MessageCursorHost } from './chat/messageCursorHost'
import { resolveQuotedMessages as resolveQuotedMessagesImpl } from './chat/quoteResolution'
import { ContactsService } from './chat/contactsService'
import type { ContactsHost } from './chat/contactsHost'
import { SessionDetailService } from './chat/sessionDetailService'
import type { SessionDetailHost } from './chat/sessionDetailHost'


import type {
  ChatSession,
  Contact,
  ContactInfo,
  ExportSessionStats,
  ExportSessionStatsCacheMeta,
  ExportSessionStatsOptions,
  ExportTabCounts,
  GetContactsOptions,
  Message,
  MyFootprintData,
  MyFootprintDiagnostics,
  MyFootprintMentionGroup,
  MyFootprintMentionItem,
  MyFootprintPrivateSegment,
  MyFootprintPrivateSession,
  MyFootprintSummary,
  ResourceMessageItem,
  ResourceMessageType,
  SessionDetail,
  SessionDetailExtra,
  SessionDetailFast,
  SyntheticUnreadState
} from './chat/types'

export type { ChatSession, Contact, ContactInfo, Message } from './chat/types'

class ChatService {
  private configService: ConfigService
  private runtimeConfig?: { dbPath?: string; decryptKey?: string; myWxid?: string }
  private connected = false
  private readonly dbMonitorListeners = new Set<(type: string, json: string) => void>()
  private avatarCache: Map<string, ContactCacheEntry>
  private readonly avatarCacheTtlMs = 10 * 60 * 1000
  private readonly defaultV1AesKey = 'cfcd208495d565ef'
  private readonly contactCacheService: ContactCacheService
  private readonly messageCacheService: MessageCacheService
  // 缓存会话表信息，避免每次查询
  private sessionTablesCache = new Map<string, { tables: Array<{ tableName: string; dbPath: string }>; updatedAt: number }>()
  private messageTableColumnsCache = new Map<string, { columns: Set<string>; updatedAt: number }>()
  private messageName2IdTableCache = new Map<string, string | null>()
  private messageSenderIdCache = new Map<string, string | null>()
  private readonly sessionTablesCacheTtl = 300000 // 5分钟
  private readonly messageTableColumnsCacheTtlMs = 30 * 60 * 1000
  private messageDbCountSnapshotCache: {
    dbPaths: string[]
    dbSignature: string
    updatedAt: number
  } | null = null
  private readonly messageDbCountSnapshotCacheTtlMs = 8000
  private initFailureDialogShown = false
  private syntheticUnreadState = new Map<string, SyntheticUnreadState>()
  private readonly myFootprintService: MyFootprintService
  private readonly sessionStatsService: SessionStatsService
  private readonly mediaAssetsService: MediaAssetsService
  private readonly messageCursorService: MessageCursorService
  private readonly contactsService: ContactsService
  private readonly sessionDetailService: SessionDetailService

  constructor() {
    this.configService = new ConfigService()
    this.contactCacheService = new ContactCacheService(this.configService.getCacheBasePath())
    const persisted = this.contactCacheService.getAllEntries()
    this.avatarCache = new Map(Object.entries(persisted))
    this.messageCacheService = new MessageCacheService(this.configService.getCacheBasePath())
    this.myFootprintService = new MyFootprintService(this.createMyFootprintHost())
    this.sessionStatsService = new SessionStatsService(
      this.createSessionStatsHost(),
      this.configService.getCacheBasePath()
    )
    this.mediaAssetsService = new MediaAssetsService(
      this.createMediaAssetsHost(),
      this.configService.getCacheBasePath()
    )
    this.messageCursorService = new MessageCursorService(
      this.createMessageCursorHost(),
      this.messageCacheService
    )
    this.contactsService = new ContactsService(this.createContactsHost())
    this.sessionDetailService = new SessionDetailService(this.createSessionDetailHost())
  }

  private createSessionDetailHost(): SessionDetailHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getCacheScope: () => {
        const dbPath = String(this.configService.get('dbPath') || '')
        const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
        return `${dbPath}::${myWxid}`
      },
      getMessageDbCountSnapshot: (forceRefresh) => this.getMessageDbCountSnapshot(forceRefresh),
      buildMessageDbSignature: (dbPaths) => this.buildMessageDbSignature(dbPaths),
      normalizeExportDiagTraceId: (traceId) => this.normalizeExportDiagTraceId(traceId),
      logExportDiag: (input) => this.logExportDiag(input),
      startExportDiagStep: (input) => this.startExportDiagStep(input),
      endExportDiagStep: (input) => this.endExportDiagStep(input),
      getAvatarCacheEntry: (username) => this.avatarCache.get(username),
      isValidAvatarUrl: (url) => this.isValidAvatarUrl(url),
      getAvatarsFromHeadImageDb: (usernames) => this.getAvatarsFromHeadImageDb(usernames)
    }
  }

  private createContactsHost(): ContactsHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getDbPath: () => String(this.configService.get('dbPath') || ''),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      isEnterpriseOpenimUsername: (username) => this.isEnterpriseOpenimUsername(username),
      isAllowedEnterpriseOpenimByLocalType: (username, localType) =>
        this.isAllowedEnterpriseOpenimByLocalType(username, localType),
      quoteSqlIdentifier: (identifier) => this.quoteSqlIdentifier(identifier)
    }
  }

  private createMessageCursorHost(): MessageCursorHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      resolveQuotedMessages: (messages, sessionId) => this.resolveQuotedMessages(messages, sessionId),
      markSyntheticUnreadRead: (sessionId, messages) => this.markSyntheticUnreadRead(sessionId, messages),
      chatServiceLog: (message, meta) => this.chatServiceLog(message, meta),
      resolveAccountDir: (dbPath, wxid) => this.resolveAccountDir(dbPath, wxid),
      getConfigString: (key: string) => String(this.configService.get(key as 'cachePath' | 'dbPath' | 'myWxid') || ''),
      getEmojiCacheDir: () => this.getEmojiCacheDir()
    }
  }

  private createMediaAssetsHost(): MediaAssetsHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      connect: () => this.connect(),
      isConnected: () => this.connected,
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      getConfigString: (key: string) => String(this.configService.get(key as 'cachePath' | 'dbPath' | 'myWxid') || ''),
      getMessageByLocalId: (sessionId, localId) => this.getMessageByLocalId(sessionId, localId),
      getSessions: () => this.getSessions(),
      forEachWithConcurrency: (items, limit, worker) => this.forEachWithConcurrency(items, limit, worker),
      chatServiceLog: (message, meta) => this.chatServiceLog(message, meta)
    }
  }

  private createSessionStatsHost(): SessionStatsHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getCacheScope: () => {
        const dbPath = String(this.configService.get('dbPath') || '')
        const myWxid = String(this.configService.getMyWxidCleaned() || '')
        return `${dbPath}::${myWxid}`
      },
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim()
    }
  }

  private createMyFootprintHost(): MyFootprintHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      getConfig: (key: string) => this.configService.get(key),
      getSessions: () => this.getSessions(),
      getSessionMessageTables: (sessionId) => this.getSessionMessageTables(sessionId),
      getMessageById: (sessionId, localId) => this.getMessageById(sessionId, localId),
      parseMessage: (row, options) => this.parseMessage(row, options),
      enrichSessionsContactInfo: (usernames, options) => this.enrichSessionsContactInfo(usernames, options),
      quoteSqlIdentifier: (identifier) => this.quoteSqlIdentifier(identifier),
      getSessionLocalType: (row) => this.getSessionLocalType(row),
      loadContactLocalTypeMapForEnterpriseOpenim: (usernames) =>
        this.loadContactLocalTypeMapForEnterpriseOpenim(usernames),
      isEnterpriseOpenimUsername: (username) => this.isEnterpriseOpenimUsername(username),
      shouldKeepSession: (username, localType) => this.shouldKeepSession(username, localType),
      escapeSqlString: (value) => this.escapeSqlString(value),
      resolveMessageSenderUsernameById: (dbPath, senderId) =>
        this.resolveMessageSenderUsernameById(dbPath, senderId)
    }
  }

  setRuntimeConfig(config: { dbPath?: string; decryptKey?: string; myWxid?: string }): void {
    this.runtimeConfig = config
  }

  /**
   * 判断头像 URL 是否可用，过滤历史缓存里的错误 hex 数据。
   */
  private isValidAvatarUrl(avatarUrl?: string): avatarUrl is string {
    const normalized = String(avatarUrl || '').trim()
    if (!normalized) return false
    const normalizedLower = normalized.toLowerCase()
    if (normalizedLower.includes('base64,ffd8')) return false
    if (normalizedLower.startsWith('ffd8')) return false
    return true
  }

  private extractErrorCode(message?: string | null): number | null {
    const text = String(message || '').trim()
    if (!text) return null
    const match = text.match(/(?:错误码\s*[:：]\s*|\()(-?\d{2,6})(?:\)|\b)/)
    if (!match) return null
    const parsed = Number(match[1])
    return Number.isFinite(parsed) ? parsed : null
  }

  private toCodeOnlyMessage(rawMessage?: string | null, fallbackCode = -3999): string {
    const code = this.extractErrorCode(rawMessage) ?? fallbackCode
    return `错误码: ${code}`
  }

  private async maybeShowInitFailureDialog(errorMessage: string): Promise<void> {
    if (!app.isPackaged) return
    if (this.initFailureDialogShown) return

    const code = this.extractErrorCode(errorMessage)
    if (code === null) return
    const isSecurityCode =
      code === -101 ||
      code === -102 ||
      code === -2299 ||
      code === -2301 ||
      code === -2302 ||
      code === -1006 ||
      (code <= -2201 && code >= -2212)
    if (!isSecurityCode) return

    this.initFailureDialogShown = true
    const detail = [
      `错误码: ${code}`
    ].join('\n')

    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'WeFlow 启动失败',
        message: '启动失败，请反馈错误码。',
        detail,
        buttons: ['确定'],
        noLink: true
      })
    } catch {
      // 弹窗失败不阻断主流程
    }
  }

  /**
   * 连接数据库
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = String(this.runtimeConfig?.myWxid || this.configService.get('myWxid') || '').trim()
      const dbPath = String(this.runtimeConfig?.dbPath || this.configService.get('dbPath') || '').trim()
      const decryptKey = String(this.runtimeConfig?.decryptKey || this.configService.get('decryptKey') || '').trim()
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置微信ID' }
      }
      if (!dbPath) {
        return { success: false, error: '请先在设置页面配置数据库路径' }
      }
      if (!decryptKey) {
        return { success: false, error: '请先在设置页面配置解密密钥' }
      }

      if (this.connected && wcdbService.isReady()) {
        return { success: true }
      }

      // 使用 ConfigService 统一解析账号目录
      const accountDir = this.configService.getAccountDir(dbPath, wxid)
      if (!accountDir) {
        return { success: false, error: '未找到账号目录，请检查数据库路径和微信ID配置' }
      }

      const openOk = await wcdbService.open(accountDir, decryptKey)
      if (!openOk) {
        const detailedError = this.toCodeOnlyMessage(await wcdbService.getLastInitError())
        await this.maybeShowInitFailureDialog(detailedError)
        return { success: false, error: detailedError }
      }

      this.connected = true

      // 设置数据库监控
      this.setupDbMonitor()

      // 预热 listMediaDbs 缓存（后台异步执行，不阻塞连接）
      void this.mediaAssetsService.warmupMediaDbsCache()

      return { success: true }
    } catch (e) {
      console.error('ChatService: 连接数据库失败:', e)
      return { success: false, error: this.toCodeOnlyMessage(String(e), -3998) }
    }
  }

  private monitorSetup = false

  addDbMonitorListener(listener: (type: string, json: string) => void): () => void {
    this.dbMonitorListeners.add(listener)
    return () => {
      this.dbMonitorListeners.delete(listener)
    }
  }

  private setupDbMonitor() {
    if (this.monitorSetup) return
    this.monitorSetup = true

    // 使用 C++数据服务内部的文件监控 (ReadDirectoryChangesW)
    // 这种方式更高效，且不占用 JS 线程，并能直接监听 session/message 目录变更
    wcdbService.setMonitor((type, json) => {
      this.handleSessionStatsMonitorChange(type, json)
      for (const listener of this.dbMonitorListeners) {
        try {
          listener(type, json)
        } catch (error) {
          console.error('[ChatService] 数据库监听回调失败:', error)
        }
      }
      const windows = BrowserWindow.getAllWindows()
      // 广播给所有渲染进程窗口
      windows.forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('wcdb-change', { type, json })
        }
      })
    })
  }

  async warmupMessageDbSnapshot(): Promise<{ success: boolean; messageDbCount?: number; mediaDbCount?: number; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const [messageSnapshot, mediaResult] = await Promise.all([
        this.getMessageDbCountSnapshot(true),
        wcdbService.listMediaDbs()
      ])

      let messageDbCount = 0
      if (messageSnapshot.success && Array.isArray(messageSnapshot.dbPaths)) {
        messageDbCount = messageSnapshot.dbPaths.length
      }

      let mediaDbCount = 0
      if (mediaResult.success && Array.isArray(mediaResult.data)) {
        this.mediaAssetsService.applyMediaDbList(mediaResult.data)
        mediaDbCount = mediaResult.data.length
      }

      if (!messageSnapshot.success && !mediaResult.success) {
        return {
          success: false,
          error: messageSnapshot.error || mediaResult.error || '初始化消息库索引失败'
        }
      }

      return { success: true, messageDbCount, mediaDbCount }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    if (this.connected && wcdbService.isReady()) {
      return { success: true }
    }
    if (!wcdbService.isReady()) {
      this.monitorSetup = false
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
      this.messageCursorService.closeAllCursors()
      wcdbService.close()
    } catch (e) {
      console.error('ChatService: 关闭数据库失败:', e)
    }
    this.connected = false
    this.monitorSetup = false
  }

  /**
   * 修改消息内容
   */
  async updateMessage(sessionId: string, localId: number, createTime: number, newContent: string): Promise<{ success: boolean; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      return await wcdbService.updateMessage(sessionId, localId, createTime, newContent)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 删除消息
   */
  async deleteMessage(sessionId: string, localId: number, createTime: number, dbPathHint?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      return await wcdbService.deleteMessage(sessionId, localId, createTime, dbPathHint)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async checkAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>
    error?: string
  }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      const { validIds, invalidRows } = await this.filterAntiRevokeSessionIds(sessionIds)
      const result = validIds.length > 0
        ? await wcdbService.checkMessageAntiRevokeTriggers(validIds)
        : { success: true, rows: [] }
      if (!result.success) return result
      return { success: true, rows: [...(result.rows || []), ...invalidRows] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async installAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>
    error?: string
  }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      const { validIds, invalidRows } = await this.filterAntiRevokeSessionIds(sessionIds)
      const result = validIds.length > 0
        ? await wcdbService.installMessageAntiRevokeTriggers(validIds)
        : { success: true, rows: [] }
      if (!result.success) return result
      return { success: true, rows: [...(result.rows || []), ...invalidRows] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async uninstallAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; error?: string }>
    error?: string
  }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      const { validIds, invalidRows } = await this.filterAntiRevokeSessionIds(sessionIds)
      const result = validIds.length > 0
        ? await wcdbService.uninstallMessageAntiRevokeTriggers(validIds)
        : { success: true, rows: [] }
      if (!result.success) return result
      return { success: true, rows: [...(result.rows || []), ...invalidRows] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
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
      this.refreshSessionMessageCountCacheScope()

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

      const openimLocalTypeMap = await this.loadContactLocalTypeMapForEnterpriseOpenim(rows.map((row) =>
        String(
          row.username ||
          row.user_name ||
          row.userName ||
          row.usrName ||
          row.UsrName ||
          row.talker ||
          row.talker_id ||
          row.talkerId ||
          ''
        ).trim()
      ))

      // 转换为 ChatSession（先加载缓存，但不等待额外状态查询）
      const sessions: ChatSession[] = []
      const now = Date.now()
      const myWxid = this.configService.getMyWxidCleaned()

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

        let sessionLocalType = this.getSessionLocalType(row)
        if (!Number.isFinite(sessionLocalType) && this.isEnterpriseOpenimUsername(username)) {
          sessionLocalType = openimLocalTypeMap.get(username)
        }
        if (!this.shouldKeepSession(username, sessionLocalType)) continue

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

        const summary = cleanString(row.summary || row.digest || row.last_msg || row.lastMsg || '')
        const lastMsgType = parseInt(row.last_msg_type || row.lastMsgType || '0', 10)
        const messageCountHintRaw =
          row.message_count ??
          row.messageCount ??
          row.msg_count ??
          row.msgCount ??
          row.total_count ??
          row.totalCount ??
          row.n_msg ??
          row.nMsg ??
          row.message_num ??
          row.messageNum
        const parsedMessageCountHint = Number(messageCountHintRaw)
        const messageCountHint = Number.isFinite(parsedMessageCountHint) && parsedMessageCountHint >= 0
          ? Math.floor(parsedMessageCountHint)
          : undefined

        // 先尝试从缓存获取联系人信息（快速路径）
        let displayName = username
        let avatarUrl: string | undefined = undefined
        const cached = this.avatarCache.get(username)
        if (cached) {
          displayName = cached.displayName || username
          avatarUrl = cached.avatarUrl
        }

        const nextSession: ChatSession = {
          username,
          type: parseInt(row.type || '0', 10),
          unreadCount: parseInt(row.unread_count || row.unreadCount || row.unreadcount || '0', 10),
          summary: summary || getMessageTypeLabel(lastMsgType),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType,
          messageCountHint,
          displayName,
          avatarUrl,
          lastMsgSender: row.last_msg_sender,
          lastSenderDisplayName: row.last_sender_display_name,
          selfWxid: myWxid
        }

        this.sessionDetailService.applyCachedStatusToSession(nextSession, username, now)

        sessions.push(nextSession)

        this.sessionDetailService.seedMessageCountHint(username, messageCountHint)
      }

      await this.addMissingOfficialSessions(sessions, myWxid)
      await this.applySyntheticUnreadCounts(sessions)
      sessions.sort((a, b) => Number(b.sortTimestamp || b.lastTimestamp || 0) - Number(a.sortTimestamp || a.lastTimestamp || 0))

      // 不等待联系人信息加载，直接返回基础会话列表
      // 前端可以异步调用 enrichSessionsWithContacts 来补充信息
      return { success: true, sessions }
    } catch (e) {
      console.error('ChatService: 获取会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getAntiRevokeSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    try {
      const result = await this.getSessions()
      if (!result.success || !Array.isArray(result.sessions)) {
        return { success: false, error: result.error || '获取会话失败' }
      }

      return {
        success: true,
        sessions: result.sessions.filter((session) => !String(session.username || '').startsWith('gh_'))
      }
    } catch (e) {
      console.error('ChatService: 获取防撤回会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async markAllSessionsRead(): Promise<{ success: boolean; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }
      const result = await wcdbService.markAllSessionsRead()
      if (result.success) {
        this.syntheticUnreadState.clear()
      }
      return result
    } catch (e) {
      console.error('ChatService: 一键已读失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private getSessionUsername(row: Record<string, any>): string {
    return String(
      row.username ||
      row.user_name ||
      row.userName ||
      row.usrName ||
      row.UsrName ||
      row.talker ||
      row.talker_id ||
      row.talkerId ||
      ''
    ).trim()
  }

  private isAntiRevokeContactRow(username: string, row: Record<string, any>): boolean {
    if (!username) return false
    if (username.endsWith('@chatroom')) return true
    if (username.startsWith('gh_')) return false

    const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
    const lowered = username.toLowerCase()
    if (this.isEnterpriseOpenimUsername(username)) {
      return this.isAllowedEnterpriseOpenimByLocalType(username, localType)
    }
    if (lowered.startsWith('weixin') && lowered !== 'weixin') return true
    return localType === 1 && !FRIEND_EXCLUDE_USERNAMES.has(username)
  }

  private async loadAntiRevokeContactMap(usernames: string[]): Promise<Map<string, { displayName?: string }>> {
    const targets = Array.from(new Set((usernames || []).map((value) => String(value || '').trim()).filter(Boolean)))
    const map = new Map<string, { displayName?: string }>()
    if (targets.length === 0) return map

    try {
      const contactResult = await wcdbService.getContactsCompact(targets)
      if (!contactResult.success || !Array.isArray(contactResult.contacts)) return map

      for (const row of contactResult.contacts as Record<string, any>[]) {
        const username = String(row.username || '').trim()
        if (!username || !this.isAntiRevokeContactRow(username, row)) continue
        map.set(username, {
          displayName: String(row.remark || row.nick_name || row.nickName || row.alias || username).trim()
        })
      }
    } catch {
      return map
    }

    return map
  }

  private async hasAntiRevokeMessageTables(sessionId: string): Promise<boolean> {
    try {
      const tableStatsResult = await wcdbService.getMessageTableStats(sessionId)
      if (!tableStatsResult.success || !Array.isArray(tableStatsResult.tables)) return false
      return tableStatsResult.tables.some((row: Record<string, any>) => {
        const tableName = String(row.table_name || row.tableName || '').trim()
        return tableName.length > 0
      })
    } catch {
      return false
    }
  }

  private async buildAntiRevokeSessionsFromRows(rows: Record<string, any>[]): Promise<ChatSession[]> {
    if (rows.length > 0 && (rows[0]._error || rows[0]._info)) return []

    const candidateRows: Array<{ username: string; row: Record<string, any> }> = []
    const privateCandidateIds: string[] = []
    const openimLocalTypeMap = await this.loadContactLocalTypeMapForEnterpriseOpenim(rows.map((row) => this.getSessionUsername(row)))

    for (const row of rows) {
      const username = this.getSessionUsername(row)
      if (!username) continue

      let sessionLocalType = this.getSessionLocalType(row)
      if (!Number.isFinite(sessionLocalType) && this.isEnterpriseOpenimUsername(username)) {
        sessionLocalType = openimLocalTypeMap.get(username)
      }
      if (!this.shouldKeepSession(username, sessionLocalType)) continue

      if (username.endsWith('@chatroom')) {
        candidateRows.push({ username, row })
      } else {
        privateCandidateIds.push(username)
        candidateRows.push({ username, row })
      }
    }

    const contactMap = await this.loadAntiRevokeContactMap(privateCandidateIds)
    const sessions: ChatSession[] = []
    const myWxid = this.configService.getMyWxidCleaned()
    const now = Date.now()

    for (const { username, row } of candidateRows) {
      const isGroup = username.endsWith('@chatroom')
      if (!isGroup && !contactMap.has(username)) continue
      if (!await this.hasAntiRevokeMessageTables(username)) continue

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
      const summary = cleanString(row.summary || row.digest || row.last_msg || row.lastMsg || '')
      const lastMsgType = parseInt(row.last_msg_type || row.lastMsgType || '0', 10)
      const cached = this.avatarCache.get(username)
      const contact = contactMap.get(username)

      const session: ChatSession = {
        username,
        type: parseInt(row.type || '0', 10),
        unreadCount: parseInt(row.unread_count || row.unreadCount || row.unreadcount || '0', 10),
        summary: summary || getMessageTypeLabel(lastMsgType),
        sortTimestamp: sortTs,
        lastTimestamp: lastTs,
        lastMsgType,
        displayName: contact?.displayName || cached?.displayName || username,
        avatarUrl: cached?.avatarUrl,
        lastMsgSender: row.last_msg_sender,
        lastSenderDisplayName: row.last_sender_display_name,
        selfWxid: myWxid
      }

      this.sessionDetailService.applyCachedStatusToSession(session, username, now)

      sessions.push(session)
    }

    return sessions
  }

  private async filterAntiRevokeSessionIds(sessionIds: string[]): Promise<{
    validIds: string[]
    invalidRows: Array<{ sessionId: string; success: false; error: string }>
  }> {
    const normalizedIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
    if (normalizedIds.length === 0) return { validIds: [], invalidRows: [] }

    const sessionsResult = await this.getAntiRevokeSessions()
    const allowedIds = new Set((sessionsResult.sessions || []).map((session) => session.username))
    const validIds = normalizedIds.filter((sessionId) => allowedIds.has(sessionId))
    const invalidRows = normalizedIds
      .filter((sessionId) => !allowedIds.has(sessionId))
      .map((sessionId) => ({
        sessionId,
        success: false as const,
        error: '该会话不是联系人或群聊，或不存在可安装防撤回的消息表'
      }))

    return { validIds, invalidRows }
  }

  private async addMissingOfficialSessions(sessions: ChatSession[], myWxid?: string): Promise<void> {
    const existing = new Set(sessions.map((session) => String(session.username || '').trim()).filter(Boolean))
    try {
      const contactResult = await wcdbService.getContactsCompact()
      if (!contactResult.success || !Array.isArray(contactResult.contacts)) return

      for (const row of contactResult.contacts as Record<string, any>[]) {
        const username = String(row.username || '').trim()
        if (!username || existing.has(username)) continue
        const lowered = username.toLowerCase()
        const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
        const isOfficial = username.startsWith('gh_')
        const isSpecialWeixin = lowered.startsWith('weixin') && lowered !== 'weixin'
        const isSpecialOpenim = this.isAllowedEnterpriseOpenimByLocalType(username, localType)
        if (!isOfficial && !isSpecialWeixin && !isSpecialOpenim) continue

        sessions.push({
          username,
          type: 0,
          unreadCount: 0,
          summary: isOfficial ? '查看公众号历史消息' : '暂无会话记录',
          sortTimestamp: 0,
          lastTimestamp: 0,
          lastMsgType: 0,
          displayName: row.remark || row.nick_name || row.alias || username,
          avatarUrl: undefined,
          selfWxid: myWxid
        })
        existing.add(username)
      }
    } catch (error) {
      console.warn('[ChatService] 补充公众号会话失败:', error)
    }
  }

  private shouldUseSyntheticUnread(sessionId: string): boolean {
    const normalized = String(sessionId || '').trim()
    return normalized.startsWith('gh_')
  }

  private async getSessionMessageStatsSnapshot(sessionId: string): Promise<{ total: number; latestTimestamp: number }> {
    const tableStatsResult = await wcdbService.getMessageTableStats(sessionId)
    if (!tableStatsResult.success || !Array.isArray(tableStatsResult.tables)) {
      return { total: 0, latestTimestamp: 0 }
    }

    let total = 0
    let latestTimestamp = 0
    for (const row of tableStatsResult.tables as Record<string, any>[]) {
      const count = Number(row.count ?? row.message_count ?? row.messageCount ?? 0)
      if (Number.isFinite(count) && count > 0) {
        total += Math.floor(count)
      }

      const latest = Number(
        row.last_timestamp ??
        row.lastTimestamp ??
        row.last_time ??
        row.lastTime ??
        row.max_create_time ??
        row.maxCreateTime ??
        0
      )
      if (Number.isFinite(latest) && latest > latestTimestamp) {
        latestTimestamp = Math.floor(latest)
      }
    }

    return { total, latestTimestamp }
  }

  private async applySyntheticUnreadCounts(sessions: ChatSession[]): Promise<void> {
    const candidates = sessions.filter((session) => this.shouldUseSyntheticUnread(session.username))
    if (candidates.length === 0) return

    for (const session of candidates) {
      try {
        const snapshot = await this.getSessionMessageStatsSnapshot(session.username)
        const latestTimestamp = Math.max(
          Number(session.lastTimestamp || 0),
          Number(session.sortTimestamp || 0),
          snapshot.latestTimestamp
        )
        if (latestTimestamp > 0) {
          session.lastTimestamp = latestTimestamp
          session.sortTimestamp = Math.max(Number(session.sortTimestamp || 0), latestTimestamp)
        }
        if (snapshot.total > 0) {
          session.messageCountHint = Math.max(Number(session.messageCountHint || 0), snapshot.total)
          this.sessionDetailService.setMessageCountHint(session.username, session.messageCountHint)
        }

        let state = this.syntheticUnreadState.get(session.username)
        if (!state) {
          const initialUnread = await this.getInitialSyntheticUnreadState(session.username, latestTimestamp)
          state = {
            readTimestamp: latestTimestamp,
            scannedTimestamp: latestTimestamp,
            latestTimestamp,
            unreadCount: initialUnread.count
          }
          if (initialUnread.latestMessage) {
            state.summary = this.getSessionSummaryFromMessage(initialUnread.latestMessage)
            state.summaryTimestamp = Number(initialUnread.latestMessage.createTime || latestTimestamp)
            state.lastMsgType = Number(initialUnread.latestMessage.localType || 0)
          }
          this.syntheticUnreadState.set(session.username, state)
        }

        let latestMessageForSummary: Message | undefined
        if (latestTimestamp > state.scannedTimestamp) {
          const newMessagesResult = await this.getNewMessages(
            session.username,
            Math.max(0, state.scannedTimestamp),
            1000
          )
          if (newMessagesResult.success && Array.isArray(newMessagesResult.messages)) {
            let nextUnread = state.unreadCount
            let nextScannedTimestamp = state.scannedTimestamp
            for (const message of newMessagesResult.messages) {
              const createTime = Number(message.createTime || 0)
              if (!Number.isFinite(createTime) || createTime <= state.scannedTimestamp) continue
              if (message.isSend === 1) continue
              nextUnread += 1
              latestMessageForSummary = message
              if (createTime > nextScannedTimestamp) {
                nextScannedTimestamp = Math.floor(createTime)
              }
            }
            state.unreadCount = nextUnread
            state.scannedTimestamp = Math.max(nextScannedTimestamp, latestTimestamp)
          } else {
            state.scannedTimestamp = latestTimestamp
          }
        }

        state.latestTimestamp = Math.max(state.latestTimestamp, latestTimestamp)
        if (latestMessageForSummary) {
          const summary = this.getSessionSummaryFromMessage(latestMessageForSummary)
          if (summary) {
            state.summary = summary
            state.summaryTimestamp = Number(latestMessageForSummary.createTime || latestTimestamp)
            state.lastMsgType = Number(latestMessageForSummary.localType || 0)
          }
        }
        if (state.summary) {
          session.summary = state.summary
          session.lastMsgType = Number(state.lastMsgType || session.lastMsgType || 0)
        }
        session.unreadCount = Math.max(Number(session.unreadCount || 0), state.unreadCount)
      } catch (error) {
        console.warn(`[ChatService] 合成公众号未读失败: ${session.username}`, error)
      }
    }
  }

  private getSessionSummaryFromMessage(message: Message): string {
    const cleanOfficialPrefix = (value: string): string => value.replace(/^\s*\[视频号\]\s*/u, '').trim()
    let summary = ''
    switch (Number(message.localType || 0)) {
      case 1:
        summary = message.parsedContent || message.rawContent || ''
        break
      case 3:
        summary = '[图片]'
        break
      case 34:
        summary = '[语音]'
        break
      case 43:
        summary = '[视频]'
        break
      case 47:
        summary = '[表情]'
        break
      case 42:
        summary = message.cardNickname || '[名片]'
        break
      case 48:
        summary = '[位置]'
        break
      case 49:
        summary = message.linkTitle || message.fileName || message.parsedContent || '[消息]'
        break
      default:
        summary = message.parsedContent || message.rawContent || getMessageTypeLabel(Number(message.localType || 0))
        break
    }
    return cleanOfficialPrefix(cleanString(summary))
  }

  private async getInitialSyntheticUnreadState(sessionId: string, latestTimestamp: number): Promise<{
    count: number
    latestMessage?: Message
  }> {
    const normalizedLatest = Number(latestTimestamp || 0)
    if (!Number.isFinite(normalizedLatest) || normalizedLatest <= 0) return { count: 0 }

    const nowSeconds = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSeconds - normalizedLatest) > 10 * 60) {
      return { count: 0 }
    }

    const result = await this.getNewMessages(sessionId, Math.max(0, Math.floor(normalizedLatest) - 1), 20)
    if (!result.success || !Array.isArray(result.messages)) return { count: 0 }
    const unreadMessages = result.messages.filter((message) => {
      const createTime = Number(message.createTime || 0)
      return Number.isFinite(createTime) &&
        createTime >= normalizedLatest &&
        message.isSend !== 1
    })
    return {
      count: unreadMessages.length,
      latestMessage: unreadMessages[unreadMessages.length - 1]
    }
  }

  private markSyntheticUnreadRead(sessionId: string, messages: Message[] = []): void {
    const normalized = String(sessionId || '').trim()
    if (!this.shouldUseSyntheticUnread(normalized)) return

    let latestTimestamp = 0
    const state = this.syntheticUnreadState.get(normalized)
    if (state) latestTimestamp = Math.max(latestTimestamp, state.latestTimestamp, state.scannedTimestamp)
    for (const message of messages) {
      const createTime = Number(message.createTime || 0)
      if (Number.isFinite(createTime) && createTime > latestTimestamp) {
        latestTimestamp = Math.floor(createTime)
      }
    }

    this.syntheticUnreadState.set(normalized, {
      readTimestamp: latestTimestamp,
      scannedTimestamp: latestTimestamp,
      latestTimestamp,
      unreadCount: 0,
      summary: state?.summary,
      summaryTimestamp: state?.summaryTimestamp,
      lastMsgType: state?.lastMsgType
    })
  }


  /**
   * 异步补充会话列表的联系人信息（公开方法，供前端调用）
   */
  async enrichSessionsContactInfo(
    usernames: string[],
    options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
  ): Promise<{
    success: boolean
    contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
    error?: string
  }> {
    try {
      const normalizedUsernames = Array.from(
        new Set(
          (usernames || [])
            .map((username) => String(username || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedUsernames.length === 0) {
        return { success: true, contacts: {} }
      }
      const skipDisplayName = options?.skipDisplayName === true
      const onlyMissingAvatar = options?.onlyMissingAvatar === true

      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const now = Date.now()
      const missing: string[] = []
      const result: Record<string, { displayName?: string; avatarUrl?: string }> = {}
      const updatedEntries: Record<string, ContactCacheEntry> = {}

      // 检查缓存
      for (const username of normalizedUsernames) {
        const cached = this.avatarCache.get(username)
        const isValidAvatar = this.isValidAvatarUrl(cached?.avatarUrl)
        const cachedAvatarUrl = isValidAvatar ? cached?.avatarUrl : undefined
        if (onlyMissingAvatar && cachedAvatarUrl) {
          result[username] = {
            displayName: skipDisplayName ? undefined : cached?.displayName,
            avatarUrl: cachedAvatarUrl
          }
          continue
        }
        // 如果缓存有效且有头像，直接使用；如果没有头像，也需要重新尝试获取
        // 额外检查：如果头像是无效的 hex 格式（以 ffd8 开头），也需要重新获取
        if (cached && now - cached.updatedAt < this.avatarCacheTtlMs && isValidAvatar) {
          result[username] = {
            displayName: skipDisplayName ? undefined : cached.displayName,
            avatarUrl: cachedAvatarUrl
          }
        } else {
          missing.push(username)
        }
      }

      // 批量查询缺失的联系人信息
      if (missing.length > 0) {
        const displayNames = skipDisplayName
          ? null
          : await wcdbService.getDisplayNames(missing)
        const avatarUrls = await wcdbService.getAvatarUrls(missing)

        // 收集没有头像 URL 的用户名
        const missingAvatars: string[] = []

        for (const username of missing) {
          const previous = this.avatarCache.get(username)
          const displayName = displayNames?.success && displayNames.map
            ? displayNames.map[username]
            : undefined
          let avatarUrl = avatarUrls.success && avatarUrls.map ? avatarUrls.map[username] : undefined

          // 如果没有头像 URL，记录下来稍后从 head_image.db 获取
          if (!avatarUrl) {
            missingAvatars.push(username)
          }

          const cacheEntry: ContactCacheEntry = {
            displayName: displayName || previous?.displayName || username,
            avatarUrl,
            updatedAt: now
          }
          result[username] = {
            displayName: skipDisplayName ? undefined : (displayName || previous?.displayName),
            avatarUrl
          }
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
      const normalizedUsernames = Array.from(
        new Set(
          usernames
            .map((username) => String(username || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedUsernames.length === 0) return result

      const batchSize = 320
      for (let i = 0; i < normalizedUsernames.length; i += batchSize) {
        const batch = normalizedUsernames.slice(i, i + batchSize)
        if (batch.length === 0) continue

        const queryResult = await wcdbService.getHeadImageBuffers(batch)
        if (!queryResult.success || !queryResult.map) continue

        for (const [username, rawHex] of Object.entries(queryResult.map)) {
          const hex = String(rawHex || '').trim()
          if (!username || !hex) continue
          try {
            const base64Data = Buffer.from(hex, 'hex').toString('base64')
            if (base64Data) {
              result[username] = `data:image/jpeg;base64,${base64Data}`
            }
          } catch {
            // ignore invalid blob hex
          }
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
   * 获取联系人类型数量（好友、群聊、公众号、曾经的好友）
   */
  async getContactTypeCounts(): Promise<{ success: boolean; counts?: ExportTabCounts; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const result = await wcdbService.getContactTypeCounts()
      if (!result.success || !result.counts) {
        return { success: false, error: result.error || '获取联系人类型数量失败' }
      }

      const counts: ExportTabCounts = {
        private: Number(result.counts.private || 0),
        group: Number(result.counts.group || 0),
        official: Number(result.counts.official || 0),
        former_friend: Number(result.counts.former_friend || 0)
      }

      return { success: true, counts }
    } catch (e) {
      console.error('ChatService: 获取联系人类型数量失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取导出页会话分类数量（轻量接口，优先用于顶部 Tab 数量展示）
   */
  async getExportTabCounts(): Promise<{ success: boolean; counts?: ExportTabCounts; error?: string }> {
    return this.getContactTypeCounts()
  }

  private async listMessageDbPathsForCount(): Promise<{ success: boolean; dbPaths?: string[]; error?: string }> {
    try {
      const result = await wcdbService.listMessageDbs()
      if (!result.success) {
        return { success: false, error: result.error || '获取消息数据库列表失败' }
      }
      const normalized = Array.from(new Set(
        (result.data || [])
          .map(pathItem => String(pathItem || '').trim())
          .filter(Boolean)
      ))
      return { success: true, dbPaths: normalized }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private buildMessageDbSignature(dbPaths: string[]): string {
    if (!Array.isArray(dbPaths) || dbPaths.length === 0) return 'empty'
    const parts: string[] = []
    const sortedPaths = [...dbPaths].sort()
    for (const dbPath of sortedPaths) {
      try {
        const stat = statSync(dbPath)
        parts.push(`${dbPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      } catch {
        parts.push(`${dbPath}:missing`)
      }
    }
    return parts.join('|')
  }

  private buildSessionHashLookup(sessionIds: string[]): {
    full32: Map<string, string>
    short16: Map<string, string | null>
  } {
    const full32 = new Map<string, string>()
    const short16 = new Map<string, string | null>()
    for (const sessionId of sessionIds) {
      const hash = crypto.createHash('md5').update(sessionId).digest('hex').toLowerCase()
      full32.set(hash, sessionId)
      const shortHash = hash.slice(0, 16)
      const existing = short16.get(shortHash)
      if (existing === undefined) {
        short16.set(shortHash, sessionId)
      } else if (existing !== sessionId) {
        short16.set(shortHash, null)
      }
    }
    return { full32, short16 }
  }

  private matchSessionIdByTableName(
    tableName: string,
    hashLookup: {
      full32: Map<string, string>
      short16: Map<string, string | null>
    }
  ): string | null {
    const normalized = String(tableName || '').trim().toLowerCase()
    if (!normalized.startsWith('msg_')) return null
    const suffix = normalized.slice(4)

    const directFull = hashLookup.full32.get(suffix)
    if (directFull) return directFull

    if (suffix.length >= 16) {
      const shortCandidate = hashLookup.short16.get(suffix.slice(0, 16))
      if (typeof shortCandidate === 'string') return shortCandidate
    }

    const hashMatch = normalized.match(/[a-f0-9]{32}|[a-f0-9]{16}/i)
    if (!hashMatch || !hashMatch[0]) return null
    const matchedHash = hashMatch[0].toLowerCase()
    if (matchedHash.length >= 32) {
      const full = hashLookup.full32.get(matchedHash)
      if (full) return full
    }
    const short = hashLookup.short16.get(matchedHash.slice(0, 16))
    return typeof short === 'string' ? short : null
  }

  private quoteSqlIdentifier(identifier: string): string {
    return `"${String(identifier || '').replace(/"/g, '""')}"`
  }


  /**
   * 获取通讯录列表
   */
  async getContacts(options?: GetContactsOptions): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    return this.contactsService.getContacts(options)
  }

  /**
   * 批量获取会话消息总数（轻量接口，用于列表优先排序）
   */
  async getSessionMessageCounts(
    sessionIds: string[],
    options?: { preferHintCache?: boolean; bypassSessionCache?: boolean; traceId?: string }
  ): Promise<{
    success: boolean
    counts?: Record<string, number>
    error?: string
  }> {
    return this.sessionDetailService.getSessionMessageCounts(sessionIds, options)
  }

  async getSessionStatuses(usernames: string[]): Promise<{
    success: boolean
    map?: Record<string, { isFolded?: boolean; isMuted?: boolean }>
    error?: string
  }> {
    return this.sessionDetailService.getSessionStatuses(usernames)
  }

  async getSessionDetailFast(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailFast
    error?: string
  }> {
    return this.sessionDetailService.getSessionDetailFast(sessionId)
  }

  async getSessionDetailExtra(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailExtra
    error?: string
  }> {
    return this.sessionDetailService.getSessionDetailExtra(sessionId)
  }

  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetail
    error?: string
  }> {
    return this.sessionDetailService.getSessionDetail(sessionId)
  }

  async getGroupMyMessageCountHint(chatroomId: string): Promise<{
    success: boolean
    count?: number
    updatedAt?: number
    source?: 'memory' | 'disk'
    error?: string
  }> {
    return this.sessionStatsService.getGroupMyMessageCountHint(chatroomId)
  }

  async setGroupMyMessageCountHint(
    chatroomId: string,
    messageCount: number,
    updatedAt?: number
  ): Promise<{ success: boolean; updatedAt?: number; error?: string }> {
    return this.sessionStatsService.setGroupMyMessageCountHint(chatroomId, messageCount, updatedAt)
  }

  async getExportSessionStats(sessionIds: string[], options: ExportSessionStatsOptions = {}): Promise<{
    success: boolean
    data?: Record<string, ExportSessionStats>
    cache?: Record<string, ExportSessionStatsCacheMeta>
    needsRefresh?: string[]
    error?: string
  }> {
    return this.sessionStatsService.getExportSessionStats(sessionIds, options)
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
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    return this.messageCursorService.getMessages(sessionId, offset, limit, startTime, endTime, ascending)
  }

  async getCachedSessionMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.messageCursorService.getCachedSessionMessages(sessionId)
  }

  async getLatestMessages(
    sessionId: string,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    return this.messageCursorService.getLatestMessages(sessionId, limit)
  }

  async getNewMessages(
    sessionId: string,
    minTime: number,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.messageCursorService.getNewMessages(sessionId, minTime, limit)
  }



  private normalizeExportDiagTraceId(traceId?: string): string {
    const normalized = String(traceId || '').trim()
    return normalized
  }

  private logExportDiag(input: {
    traceId?: string
    source?: 'backend' | 'main' | 'frontend' | 'worker'
    level?: 'debug' | 'info' | 'warn' | 'error'
    message: string
    stepId?: string
    stepName?: string
    status?: 'running' | 'done' | 'failed' | 'timeout'
    durationMs?: number
    data?: Record<string, unknown>
  }): void {
    const traceId = this.normalizeExportDiagTraceId(input.traceId)
    if (!traceId) return
    exportCardDiagnosticsService.log({
      traceId,
      source: input.source || 'backend',
      level: input.level || 'info',
      message: input.message,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status,
      durationMs: input.durationMs,
      data: input.data
    })
  }

  private startExportDiagStep(input: {
    traceId?: string
    stepId: string
    stepName: string
    message: string
    data?: Record<string, unknown>
  }): number {
    const startedAt = Date.now()
    const traceId = this.normalizeExportDiagTraceId(input.traceId)
    if (traceId) {
      exportCardDiagnosticsService.stepStart({
        traceId,
        stepId: input.stepId,
        stepName: input.stepName,
        source: 'backend',
        message: input.message,
        data: input.data
      })
    }
    return startedAt
  }

  private endExportDiagStep(input: {
    traceId?: string
    stepId: string
    stepName: string
    startedAt: number
    success: boolean
    message?: string
    data?: Record<string, unknown>
  }): void {
    const traceId = this.normalizeExportDiagTraceId(input.traceId)
    if (!traceId) return
    exportCardDiagnosticsService.stepEnd({
      traceId,
      stepId: input.stepId,
      stepName: input.stepName,
      source: 'backend',
      status: input.success ? 'done' : 'failed',
      message: input.message || (input.success ? `${input.stepName} 完成` : `${input.stepName} 失败`),
      durationMs: Math.max(0, Date.now() - input.startedAt),
      data: input.data
    })
  }

  private refreshSessionMessageCountCacheScope(): void {
    const dbPath = String(this.configService.get('dbPath') || '')
    const myWxid = String(this.configService.getMyWxidCleaned() || '')
    const scope = `${dbPath}::${myWxid}`
    this.sessionStatsService.refreshCacheScope(scope)
    if (!this.sessionDetailService.onAccountScopeChanged(scope)) {
      return
    }
    this.sessionTablesCache.clear()
    this.messageTableColumnsCache.clear()
    this.messageDbCountSnapshotCache = null
    this.contactsService.clearMemoryCache()
  }

  private handleSessionStatsMonitorChange(type: string, json: string): void {
    this.refreshSessionMessageCountCacheScope()
    const normalizedType = String(type || '').toLowerCase()
    if (
      normalizedType.includes('message') ||
      normalizedType.includes('session') ||
      normalizedType.includes('db')
    ) {
      this.messageDbCountSnapshotCache = null
    }
    this.sessionStatsService.handleDbMonitorChange(type, json)
  }

  private async forEachWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    if (items.length === 0) return
    const concurrency = Math.max(1, Math.min(limit, items.length))
    let index = 0

    const runners = Array.from({ length: concurrency }, async () => {
      while (true) {
        const current = index
        index += 1
        if (current >= items.length) return
        await worker(items[current])
      }
    })

    await Promise.all(runners)
  }

  private async getMessageDbCountSnapshot(forceRefresh = false): Promise<{
    success: boolean
    dbPaths?: string[]
    dbSignature?: string
    error?: string
  }> {
    const now = Date.now()
    if (!forceRefresh && this.messageDbCountSnapshotCache) {
      if (now - this.messageDbCountSnapshotCache.updatedAt <= this.messageDbCountSnapshotCacheTtlMs) {
        return {
          success: true,
          dbPaths: [...this.messageDbCountSnapshotCache.dbPaths],
          dbSignature: this.messageDbCountSnapshotCache.dbSignature
        }
      }
    }

    const dbPathsResult = await this.listMessageDbPathsForCount()
    if (!dbPathsResult.success || !dbPathsResult.dbPaths) {
      return { success: false, error: dbPathsResult.error || '获取消息数据库列表失败' }
    }
    const dbPaths = dbPathsResult.dbPaths
    const dbSignature = this.buildMessageDbSignature(dbPaths)
    this.messageDbCountSnapshotCache = {
      dbPaths: [...dbPaths],
      dbSignature,
      updatedAt: now
    }
    return { success: true, dbPaths, dbSignature }
  }

  private async getSessionMessageTables(sessionId: string): Promise<Array<{ tableName: string; dbPath: string }>> {
    const now = Date.now()
    const cached = this.sessionTablesCache.get(sessionId)
    if (cached && now - cached.updatedAt <= this.sessionTablesCacheTtl && cached.tables.length > 0) {
      return cached.tables
    }
    if (cached) {
      this.sessionTablesCache.delete(sessionId)
    }

    const tableStats = await wcdbService.getMessageTableStats(sessionId)
    if (!tableStats.success || !tableStats.tables || tableStats.tables.length === 0) {
      return []
    }

    const tables = tableStats.tables
      .map(t => ({ tableName: t.table_name || t.name, dbPath: t.db_path }))
      .filter(t => t.tableName && t.dbPath) as Array<{ tableName: string; dbPath: string }>

    if (tables.length > 0) {
      this.sessionTablesCache.set(sessionId, {
        tables,
        updatedAt: now
      })
    }
    return tables
  }



  /**
   * HTTP API 复用消息解析逻辑，确保和应用内展示一致。
   */
  
  mapRowsToMessagesLiteForApi(rows: Record<string, any>[]): Message[] {
    const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
    return mapRowsToMessagesLite(rows, myWxid)
  }

  mapRowsToMessagesForApi(rows: Record<string, any>[], sessionId: string): Message[] {
    const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
    return mapRowsToMessages(rows, sessionId, myWxid)
  }

  private isChatQuoteDebugEnabled(): boolean {
    if (String(process.env.WEFLOW_CHAT_QUOTE_DEBUG || '').trim() === '1') return true
    return this.configService.get('chatQuoteDebugLogEnabled') === true
  }

  private shouldLogChatServiceVerbose(): boolean {
    return this.configService.get('logEnabled') === true
  }

  private chatServiceLog(message: string, meta?: unknown): void {
    if (!this.shouldLogChatServiceVerbose()) return
    if (meta !== undefined) {
      console.log(`[ChatService] ${message}`, meta)
    } else {
      console.log(`[ChatService] ${message}`)
    }
  }

  private debugQuoteLog(message: string, meta?: unknown): void {
    if (!this.isChatQuoteDebugEnabled()) return
    if (meta !== undefined) {
      console.log(`[DEBUG] ${message}`, meta)
    } else {
      console.log(`[DEBUG] ${message}`)
    }
  }

  async resolveQuotedMessages(messages: Message[], sessionId: string): Promise<void> {
    return resolveQuotedMessagesImpl(messages, sessionId, (message, meta) => this.debugQuoteLog(message, meta))
  }

  //手动查找 media_*.db 文件（当 WCDB数据服务不支持 listMediaDbs 时的 fallback）
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


  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''")
  }

  private async resolveMessageName2IdTableName(dbPath: string): Promise<string | null> {
    const normalizedDbPath = String(dbPath || '').trim()
    if (!normalizedDbPath) return null
    if (this.messageName2IdTableCache.has(normalizedDbPath)) {
      return this.messageName2IdTableCache.get(normalizedDbPath) || null
    }

    // fallback-exec: 当前缺少按 message.db 反查 Name2Id 表名的专属接口
    const result = await wcdbService.execQuery(
      'message',
      normalizedDbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%' ORDER BY name DESC LIMIT 1"
    )
    const tableName = result.success && result.rows && result.rows.length > 0
      ? String(result.rows[0]?.name || '').trim() || null
      : null
    this.messageName2IdTableCache.set(normalizedDbPath, tableName)
    return tableName
  }

  private async resolveMessageSenderUsernameById(dbPath: string, senderId: unknown): Promise<string | null> {
    const normalizedDbPath = String(dbPath || '').trim()
    const numericSenderId = Number.parseInt(String(senderId ?? '').trim(), 10)
    if (!normalizedDbPath || !Number.isFinite(numericSenderId) || numericSenderId <= 0) {
      return null
    }

    const cacheKey = `${normalizedDbPath}::${numericSenderId}`
    if (this.messageSenderIdCache.has(cacheKey)) {
      return this.messageSenderIdCache.get(cacheKey) || null
    }

    const name2IdTable = await this.resolveMessageName2IdTableName(normalizedDbPath)
    if (!name2IdTable) {
      this.messageSenderIdCache.set(cacheKey, null)
      return null
    }

    const escapedTableName = String(name2IdTable).replace(/"/g, '""')
    // fallback-exec: 当前缺少按 rowid -> user_name 的 message.db 专属接口
    const result = await wcdbService.execQuery(
      'message',
      normalizedDbPath,
      `SELECT user_name FROM "${escapedTableName}" WHERE rowid = ${numericSenderId} LIMIT 1`
    )
    const username = result.success && result.rows && result.rows.length > 0
      ? String(result.rows[0]?.user_name || result.rows[0]?.userName || '').trim() || null
      : null
    this.messageSenderIdCache.set(cacheKey, username)
    return username
  }

  private async resolveSenderUsernameForMessageRow(
    row: Record<string, any>,
    rawContent: string
  ): Promise<string | null> {
    const directSender = row.sender_username
      || extractSenderUsernameFromContent(rawContent)
    if (directSender) {
      return directSender
    }

    const dbPath = row._db_path
    const realSenderId = row.real_sender_id
    if (!dbPath || realSenderId === null || realSenderId === undefined || String(realSenderId).trim() === '') {
      return null
    }

    return this.resolveMessageSenderUsernameById(String(dbPath), realSenderId)
  }

  /**
   * 判断是否像 wxid
   */

  private getSessionLocalType(row: Record<string, any>): number | undefined {
    const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
    return Number.isFinite(localType) ? Math.floor(localType) : undefined
  }

  private async loadContactLocalTypeMapForEnterpriseOpenim(usernames: string[]): Promise<Map<string, number>> {
    const normalizedUsernames = Array.from(new Set(
      (usernames || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && this.isEnterpriseOpenimUsername(value))
    ))
    const localTypeMap = new Map<string, number>()
    if (normalizedUsernames.length === 0) {
      return localTypeMap
    }
    try {
      const contactResult = await wcdbService.getContactsCompact(normalizedUsernames)
      if (!contactResult.success || !Array.isArray(contactResult.contacts)) {
        return localTypeMap
      }
      for (const row of contactResult.contacts as Record<string, any>[]) {
        const username = String(row.username || '').trim()
        if (!username) continue
        const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
        if (!Number.isFinite(localType)) continue
        localTypeMap.set(username, Math.floor(localType))
      }
    } catch {
      return localTypeMap
    }
    return localTypeMap
  }

  private isEnterpriseOpenimUsername(username: string): boolean {
    const lowered = String(username || '').trim().toLowerCase()
    return lowered.includes('@openim') && !lowered.includes('@kefu.openim')
  }

  private isAllowedEnterpriseOpenimByLocalType(username: string, localType?: number): boolean {
    if (!this.isEnterpriseOpenimUsername(username)) return false
    return Number.isFinite(localType) && Math.floor(localType as number) === 5
  }

  private shouldKeepSession(username: string, localType?: number): boolean {
    if (!username) return false
    const lowered = username.toLowerCase()
    // 排除所有 placeholder 会话（包括折叠群）
    if (lowered.includes('@placeholder')) return false
    if (username.startsWith('gh_')) return false

    if (lowered === 'weixin') return false

    const excludeList = [
      'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders',
      '@helper_folders'
    ]

    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }

    if (username.includes('@kefu.openim')) return false
    // 全局约束：企业 openim 仅允许 localType=5。
    if (this.isEnterpriseOpenimUsername(username)) {
      return this.isAllowedEnterpriseOpenimByLocalType(username, localType)
    }
    if (username.includes('service_')) return false

    return true
  }

  async getContact(username: string): Promise<Contact | null> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return null
      const result = await wcdbService.getContact(username)
      if (!result.success || !result.contact) return null
      const contact = result.contact as Record<string, any>
      let alias = String(contact.alias || contact.Alias || '')
      //数据服务有时不返回 alias 字段，补一条直接 SQL 查询兜底
      if (!alias) {
        try {
          const aliasResult = await wcdbService.getContactAliasMap([username])
          if (aliasResult.success && aliasResult.map && aliasResult.map[username]) {
            alias = String(aliasResult.map[username] || '')
          }
        } catch {
          // 兜底失败不影响主流程
        }
      }
      return {
        username: String(contact.username || contact.user_name || contact.userName || username || ''),
        alias,
        remark: String(contact.remark || contact.Remark || ''),
        // 兼容不同表结构字段，避免 nick_name 丢失导致侧边栏退化到 wxid。
        nickName: String(contact.nickName || contact.nick_name || contact.nickname || contact.NickName || '')
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
      const isValidAvatar = this.isValidAvatarUrl(cached?.avatarUrl)
      if (cached && isValidAvatar && Date.now() - cached.updatedAt < this.avatarCacheTtlMs) {
        return { avatarUrl: cached.avatarUrl, displayName: cached.displayName }
      }

      const contact = await this.getContact(username)
      const avatarResult = await wcdbService.getAvatarUrls([username])
      let avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined
      if (!this.isValidAvatarUrl(avatarUrl)) {
        avatarUrl = undefined
      }
      if (!avatarUrl) {
        const headImageAvatars = await this.getAvatarsFromHeadImageDb([username])
        const fallbackAvatarUrl = headImageAvatars[username]
        if (this.isValidAvatarUrl(fallbackAvatarUrl)) {
          avatarUrl = fallbackAvatarUrl
        }
      }
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
   * 解析转账消息中的付款方和收款方显示名称
   * 优先使用群昵称，群昵称为空时回退到微信昵称/备注
   */
  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { payerName: payerUsername, receiverName: receiverUsername }
      }

      // 如果是群聊，尝试获取群昵称
      const groupNicknames = new Map<string, string>()
      if (chatroomId.endsWith('@chatroom')) {
        const nickResult = await wcdbService.getGroupNicknames(chatroomId)
        if (nickResult.success && nickResult.nicknames) {
          const nicknameBuckets = new Map<string, Set<string>>()
          for (const [memberIdRaw, nicknameRaw] of Object.entries(nickResult.nicknames)) {
            const memberId = String(memberIdRaw || '').trim().toLowerCase()
            const nickname = String(nicknameRaw || '').trim()
            if (!memberId || !nickname) continue
            const slot = nicknameBuckets.get(memberId)
            if (slot) {
              slot.add(nickname)
            } else {
              nicknameBuckets.set(memberId, new Set([nickname]))
            }
          }
          for (const [memberId, nicknameSet] of nicknameBuckets.entries()) {
            if (nicknameSet.size !== 1) continue
            groupNicknames.set(memberId, Array.from(nicknameSet)[0])
          }
        }
      }

      const lookupGroupNickname = (username?: string | null): string => {
        const key = String(username || '').trim().toLowerCase()
        if (!key) return ''
        return groupNicknames.get(key) || ''
      }

      // 获取当前用户 wxid，用于识别"自己"
      const myWxid = this.configService.getMyWxidCleaned()
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      // 解析付款方名称：自己 > 群昵称 > 备注 > 昵称 > alias > wxid
      const resolveName = async (username: string): Promise<string> => {
        // 特判：如果是当前用户自己（contact 表通常不包含自己）
        if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
          // 先查群昵称中是否有自己
          const myGroupNick = lookupGroupNickname(username) || lookupGroupNickname(myWxid)
          if (myGroupNick) return myGroupNick
          // 尝试从缓存获取自己的昵称
          const cached = this.avatarCache.get(username) || this.avatarCache.get(myWxid)
          if (cached?.displayName) return cached.displayName
          return '我'
        }

        // 先查群昵称
        const groupNick = lookupGroupNickname(username)
        if (groupNick) return groupNick

        // 再查联系人信息
        const contact = await this.getContact(username)
        if (contact) {
          return contact.remark || contact.nickName || contact.alias || username
        }

        // 兜底：查缓存
        const cached = this.avatarCache.get(username)
        if (cached?.displayName) return cached.displayName

        return username
      }

      const [payerName, receiverName] = await Promise.all([
        resolveName(payerUsername),
        resolveName(receiverUsername)
      ])

      return { payerName, receiverName }
    } catch {
      return { payerName: payerUsername, receiverName: receiverUsername }
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

      const myWxid = this.configService.getMyWxidCleaned()
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      const cleanedWxid = cleanAccountDirName(myWxid)
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
      this.contactsService.clearMemoryCache()
    }

    if (includeMessages) {
      this.messageCacheService.clear()
      this.mediaAssetsService.clearVoiceCaches()
    }

    if (includeMessages || includeContacts) {
      this.sessionStatsService.clearCaches()
    }

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
      return { success: true, localPath: cached }
    }

    // 检查是否正在下载
    const downloading = emojiDownloading.get(cacheKey)
    if (downloading) {
      const result = await downloading
      if (result) {
        return { success: true, localPath: result }
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
        return { success: true, localPath: filePath }
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
        return { success: true, localPath }
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

  async getImageData(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.mediaAssetsService.getImageData(sessionId, msgId)
  }

  async getVoiceData(
    sessionId: string,
    msgId: string,
    createTime?: number,
    serverId?: string | number,
    senderWxidOpt?: string
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.mediaAssetsService.getVoiceData(sessionId, msgId, createTime, serverId, senderWxidOpt)
  }

  async preloadVoiceDataBatch(
    sessionId: string,
    messages: Array<{
      localId?: number | string
      createTime?: number | string
      serverId?: number | string
      senderWxid?: string | null
    }>,
    options?: { chunkSize?: number; decodeConcurrency?: number }
  ): Promise<{ success: boolean; prepared?: number; error?: string }> {
    return this.mediaAssetsService.preloadVoiceDataBatch(sessionId, messages, options)
  }

  async resolveVoiceCache(
    sessionId: string,
    msgId: string
  ): Promise<{ success: boolean; hasCache: boolean; data?: string }> {
    return this.mediaAssetsService.resolveVoiceCache(sessionId, msgId)
  }

  async getVoiceData_Legacy(
    sessionId: string,
    msgId: string
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.mediaAssetsService.getVoiceData_Legacy(sessionId, msgId)
  }

  async getVoiceTranscript(
    sessionId: string,
    msgId: string,
    createTime?: number,
    onPartial?: (text: string) => void,
    senderWxid?: string
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return this.mediaAssetsService.getVoiceTranscript(sessionId, msgId, createTime, onPartial, senderWxid)
  }

  flushTranscriptCache(): void {
    this.mediaAssetsService.flushTranscriptCache()
  }

  hasTranscriptCache(sessionId: string, msgId: string, createTime?: number): boolean {
    return this.mediaAssetsService.hasTranscriptCache(sessionId, msgId, createTime)
  }

  getCachedVoiceTranscriptCountMap(sessionIds: string[]): Record<string, number> {
    return this.mediaAssetsService.getCachedVoiceTranscriptCountMap(sessionIds)
  }

  async getAllVoiceMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.mediaAssetsService.getAllVoiceMessages(sessionId)
  }

  async getAllImageMessages(
    sessionId: string
  ): Promise<{
    success: boolean
    images?: { imageMd5?: string; imageOriginSourceMd5?: string; imageDatName?: string; createTime?: number }[]
    error?: string
  }> {
    return this.mediaAssetsService.getAllImageMessages(sessionId)
  }

  async getResourceMessages(options?: {
    sessionId?: string
    types?: ResourceMessageType[]
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }): Promise<{
    success: boolean
    items?: ResourceMessageItem[]
    total?: number
    hasMore?: boolean
    error?: string
  }> {
    return this.mediaAssetsService.getResourceMessages(options)
  }

  async getMessageDates(sessionId: string): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getMessageDates(sessionId)
      if (!result.success) {
        throw new Error(result.error || '查询失败')
      }

      const dates = result.dates || []

      this.chatServiceLog(`会话 ${sessionId} 共有 ${dates.length} 个有消息的日期`)
      return { success: true, dates }
    } catch (e) {
      console.error('[ChatService] 获取消息日期失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getMessageDateCounts(sessionId: string): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getSessionMessageDateCounts(sessionId)
      if (!result.success || !result.counts) {
        return { success: false, error: result.error || '查询每日消息数失败' }
      }
      const counts = result.counts

      this.chatServiceLog(`会话 ${sessionId} 获取到 ${Object.keys(counts).length} 个日期的消息计数`)
      return { success: true, counts }
    } catch (error) {
      console.error('[ChatService] 获取每日消息数失败:', error)
      return { success: false, error: String(error) }
    }
  }

  async getMyFootprintStats(
    beginTimestamp: number,
    endTimestamp: number,
    options?: {
      myWxid?: string
      privateSessionIds?: string[]
      groupSessionIds?: string[]
      mentionLimit?: number
      privateLimit?: number
      mentionMode?: 'text_at_me' | string
    }
  ) {
    return this.myFootprintService.getMyFootprintStats(beginTimestamp, endTimestamp, options)
  }

  async exportMyFootprint(
    beginTimestamp: number,
    endTimestamp: number,
    format: 'csv' | 'json',
    filePath: string
  ) {
    return this.myFootprintService.exportMyFootprint(beginTimestamp, endTimestamp, format, filePath)
  }

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      const nativeResult = await wcdbService.getMessageById(sessionId, localId)
      if (nativeResult.success && nativeResult.message) {
        const message = await this.parseMessage(nativeResult.message as Record<string, any>, { source: 'detail', sessionId })
        if (message.localId !== 0) return { success: true, message }
      }
      return { success: false, error: nativeResult.error || '未找到消息' }
    } catch (e) {
      console.error('ChatService: getMessageById 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async searchMessages(keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const result = await wcdbService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
      if (!result.success || !result.messages) {
        return { success: false, error: result.error || '搜索失败' }
      }
      const messages: Message[] = []
      const isGroupSearch = Boolean(String(sessionId || '').trim().endsWith('@chatroom'))

      for (const row of result.messages) {
        let message = await this.parseMessage(row, { source: 'search', sessionId })
        const resolvedSessionId = String(sessionId || row._session_id || '').trim()
        const needsDetailHydration = isGroupSearch &&
          Boolean(sessionId) &&
          message.localId > 0 &&
          (!message.senderUsername || message.isSend === null)

        if (needsDetailHydration && sessionId) {
          const detail = await this.getMessageById(sessionId, message.localId)
          if (detail.success && detail.message) {
            message = {
              ...message,
              ...detail.message,
              parsedContent: message.parsedContent || detail.message.parsedContent,
              rawContent: message.rawContent || detail.message.rawContent,
              content: message.content || detail.message.content
            }
          }
        }

        if (resolvedSessionId) {
          ;(message as Message & { sessionId?: string }).sessionId = resolvedSessionId
        }
        messages.push(message)
      }

      return { success: true, messages }
    } catch (e) {
      console.error('ChatService: searchMessages 失败:', e)
      return { success: false, error: String(e) }
    }
  }


  private async parseMessage(row: any, options?: { source?: 'search' | 'detail'; sessionId?: string }): Promise<Message> {
    const sourceInfo = getMessageSourceInfo(row)
    const rawContent = decodeMessageContent(
      row.message_content,
      row.compress_content
    )
    // 这里复用 parseMessagesBatch 里面的解析逻辑，为了简单我这里先写个基础的
    // 实际项目中建议抽取 parseRawMessage(row) 供多处使用
    const localId = getRowInt(row, ['local_id'], 0)
    const serverIdRaw = normalizeUnsignedIntegerToken(row.server_id)
    const serverId = getRowInt(row, ['server_id'], 0)
    const localType = getRowInt(row, ['local_type'], 0)
    const createTime = getRowTimestampSeconds(row, ['create_time', 'createTime', 'msg_time', 'msgTime', 'time'], 0)
    const sortSeq = getRowInt(row, ['sort_seq'], createTime > 0 ? createTime * 1000 : 0)
    const rawIsSend = row.computed_is_send ?? row.is_send
    const senderUsername = await this.resolveSenderUsernameForMessageRow(row, rawContent)
    const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
    const sendState = resolveMessageIsSend(rawIsSend === null ? null : parseInt(rawIsSend, 10), senderUsername, myWxid)
    const msg: Message = {
      messageKey: buildMessageKey({
        localId,
        serverId,
        createTime,
        sortSeq,
        senderUsername,
        localType,
        ...sourceInfo
      }),
      localId,
      serverId,
      serverIdRaw,
      localType,
      createTime,
      sortSeq,
      isSend: sendState.isSend,
      senderUsername,
      rawContent: rawContent,
      content: rawContent,  // 添加原始内容供视频MD5解析使用
      parsedContent: parseMessageContent(rawContent, localType),
      _db_path: sourceInfo.dbPath
    }

    if (msg.localId === 0 || msg.createTime === 0) {
      const rawLocalId = row.local_id
      const rawCreateTime = row.create_time
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
      const imgInfo = parseImageInfo(rawContent)
      msg.imageMd5 = imgInfo.md5
      msg.imageOriginSourceMd5 = imgInfo.originSourceMd5
      msg.aesKey = imgInfo.aesKey
      msg.encrypVer = imgInfo.encrypVer
      msg.cdnThumbUrl = imgInfo.cdnThumbUrl
      msg.imageDatName = parseImageDatNameFromRow(row)
    } else if (msg.localType === 43) { // Video
      msg.videoMd5 = parseVideoFileNameFromRow(row, rawContent)
    } else if (msg.localType === 47) { // Emoji
      const emojiInfo = parseEmojiInfo(rawContent)
      msg.emojiCdnUrl = emojiInfo.cdnUrl
      msg.emojiMd5 = emojiInfo.md5
      msg.emojiThumbUrl = emojiInfo.thumbUrl
      msg.emojiEncryptUrl = emojiInfo.encryptUrl
      msg.emojiAesKey = emojiInfo.aesKey
    } else if (msg.localType === 42) {
      const cardInfo = parseCardInfo(rawContent)
      msg.cardUsername = cardInfo.username
      msg.cardNickname = cardInfo.nickname
      msg.cardAvatarUrl = cardInfo.avatarUrl
    }

    if (rawContent && (rawContent.includes('<appmsg') || rawContent.includes('&lt;appmsg'))) {
      Object.assign(msg, parseType49Message(rawContent))
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
      // fallback-exec: 仅用于诊断/低频兼容，不作为业务主路径
      return wcdbService.execQuery(kind, path, sql)
    } catch (e) {
      console.error('ChatService: 执行自定义查询失败:', e)
      return { success: false, error: String(e) }
    }
  }


  /**
   * 下载表情包文件（用于导出，返回文件路径）
   */
  async downloadEmojiFile(msg: Message): Promise<string | null> {
    if (!msg.emojiMd5) return null
    let url = msg.emojiCdnUrl

    // 尝试获取 URL
    if (!url && msg.emojiEncryptUrl) {
      console.warn('[ChatService] Emoji has only encryptUrl:', msg.emojiMd5)
    }

    if (!url) {
      await this.messageCursorService.repairEmoticonFallback(msg)
      url = msg.emojiCdnUrl
    }

    if (!url) return null

    // Reuse existing downloadEmoji method
    const result = await this.downloadEmoji(url, msg.emojiMd5)
    if (result.success && result.localPath) {
      return result.localPath
    }
    return null
  }
}

export const chatService = new ChatService()
