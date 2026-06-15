import { ConfigService } from './config'
import { chatService, type ChatSession, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import { httpService } from './httpService'
import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'

interface SessionBaseline {
  lastTimestamp: number
  unreadCount: number
}

interface PushSessionResult {
  fetched: boolean
  maxFetchedTimestamp: number
  incomingCandidateCount: number
  observedIncomingCount: number
  expectedIncomingCount: number
  retry: boolean
}

interface PushSessionOptions {
  scanRecentRevokes?: boolean
}

type MessagePushEventName = 'message.new' | 'message.revoke'

interface MessagePushPayload {
  event: MessagePushEventName
  sessionId: string
  sessionType: 'private' | 'group' | 'official' | 'other'
  rawid: string
  avatarUrl?: string
  sourceName: string
  groupName?: string
  content: string | null
  timestamp: number
}

const PUSH_CONFIG_KEYS = new Set([
  'messagePushEnabled',
  'messagePushFilterMode',
  'messagePushFilterList',
  'dbPath',
  'decryptKey',
  'myWxid'
])

class MessagePushService {
  private readonly configService: ConfigService
  private readonly sessionBaseline = new Map<string, SessionBaseline>()
  private readonly recentMessageKeys = new Map<string, number>()
  private readonly seenMessageKeys = new Map<string, number>()
  private readonly recentlyRevokedOriginalTokens = new Map<string, number>()
  private readonly seenPrimedSessions = new Set<string>()
  private readonly groupNicknameCache = new Map<string, { nicknames: Record<string, string>; updatedAt: number }>()
  private readonly pushAvatarCacheDir: string
  private readonly pushAvatarDataCache = new Map<string, string>()
  private readonly debounceMs = 350
  private readonly lookbackSeconds = 2
  private readonly recentMessageTtlMs = 10 * 60 * 1000
  private readonly groupNicknameCacheTtlMs = 5 * 60 * 1000
  private readonly messageTableRescanDelayMs = 500
  private readonly recentRevokeScanSeconds = 150
  private readonly directRevokeScanLimit = 20
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private messageTableRescanTimer: ReturnType<typeof setTimeout> | null = null
  private processing = false
  private rerunRequested = false
  private started = false
  private baselineReady = false
  private messageTableScanRequested = false
  private readonly pendingMessageTableNames = new Set<string>()

  constructor() {
    this.configService = ConfigService.getInstance()
    this.pushAvatarCacheDir = path.join(this.configService.getCacheBasePath(), 'push-avatar-files')
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  stop(): void {
    this.started = false
    this.processing = false
    this.rerunRequested = false
    this.resetRuntimeState()
  }

  handleDbMonitorChange(type: string, json: string): void {
    if (!this.started) return
    if (!this.isPushEnabled()) return

    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(json)
    } catch {
      payload = null
    }

    const tableName = String(payload?.table || '').trim()
    const messageTableNames = this.collectMessageTableNamesFromPayload(payload)
    if (this.isSessionTableChange(tableName)) {
      this.scheduleSync()
      return
    }

    if (!tableName && messageTableNames.length === 0) {
      this.scheduleSync()
      return
    }

    if (this.isMessageTableChange(tableName) || messageTableNames.length > 0) {
      this.scheduleSync({
        scanMessageBackedSessions: true,
        messageTableNames
      })
      this.scheduleMessageTableRescan(messageTableNames)
    }
  }

  async handleConfigChanged(key: string): Promise<void> {
    if (!PUSH_CONFIG_KEYS.has(String(key || '').trim())) return
    if (key === 'dbPath' || key === 'decryptKey' || key === 'myWxid') {
      this.resetRuntimeState()
      chatService.close()
    }
    await this.refreshConfiguration(`config:${key}`)
  }

  handleConfigCleared(): void {
    this.resetRuntimeState()
    chatService.close()
  }

  private isPushEnabled(): boolean {
    return this.configService.get('messagePushEnabled') === true
  }

  private resetRuntimeState(): void {
    this.sessionBaseline.clear()
    this.recentMessageKeys.clear()
    this.seenMessageKeys.clear()
    this.recentlyRevokedOriginalTokens.clear()
    this.seenPrimedSessions.clear()
    this.groupNicknameCache.clear()
    this.baselineReady = false
    this.messageTableScanRequested = false
    this.pendingMessageTableNames.clear()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.messageTableRescanTimer) {
      clearTimeout(this.messageTableRescanTimer)
      this.messageTableRescanTimer = null
    }
  }

  private async refreshConfiguration(reason: string): Promise<void> {
    if (!this.isPushEnabled()) {
      this.resetRuntimeState()
      return
    }

    const connectResult = await chatService.connect()
    if (!connectResult.success) {
      console.warn(`[MessagePushService] Bootstrap connect failed (${reason}):`, connectResult.error)
      return
    }

    await this.bootstrapBaseline()
  }

  private async bootstrapBaseline(): Promise<void> {
    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) {
      return
    }
    this.setBaseline(sessionsResult.sessions as ChatSession[])
    this.baselineReady = true
  }

  private scheduleSync(options: { scanMessageBackedSessions?: boolean; messageTableNames?: string[] } = {}): void {
    if (options.scanMessageBackedSessions) {
      this.messageTableScanRequested = true
    }
    for (const tableName of options.messageTableNames || []) {
      const normalized = String(tableName || '').trim()
      if (normalized) this.pendingMessageTableNames.add(normalized)
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flushPendingChanges()
    }, this.debounceMs)
  }

  private scheduleMessageTableRescan(messageTableNames: string[]): void {
    if (this.messageTableRescanTimer) {
      clearTimeout(this.messageTableRescanTimer)
    }

    const tableNames = [...messageTableNames]
    this.messageTableRescanTimer = setTimeout(() => {
      this.messageTableRescanTimer = null
      if (!this.started || !this.isPushEnabled()) return
      this.scheduleSync({
        scanMessageBackedSessions: true,
        messageTableNames: tableNames
      })
    }, this.messageTableRescanDelayMs)
  }

  private async flushPendingChanges(): Promise<void> {
    if (this.processing) {
      this.rerunRequested = true
      return
    }

    this.processing = true
    try {
      if (!this.isPushEnabled()) return
      const scanMessageBackedSessions = this.messageTableScanRequested
      this.messageTableScanRequested = false
      const pendingMessageTableNames = Array.from(this.pendingMessageTableNames)
      this.pendingMessageTableNames.clear()

      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        console.warn('[MessagePushService] Sync connect failed:', connectResult.error)
        return
      }

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        return
      }

      const sessions = sessionsResult.sessions as ChatSession[]
      if (!this.baselineReady) {
        this.setBaseline(sessions)
        this.baselineReady = true
        return
      }

      const previousBaseline = new Map(this.sessionBaseline)
      const messageTableTargetSessionIds = this.resolveMessageTableTargetSessionIds(sessions, pendingMessageTableNames)

      const candidates = sessions.filter((session) => {
        const sessionId = String(session.username || '').trim()
        const previous = previousBaseline.get(session.username)
        if (sessionId && messageTableTargetSessionIds.has(sessionId)) {
          return true
        }
        if (this.shouldInspectSession(previous, session)) {
          return true
        }
        return scanMessageBackedSessions && this.shouldScanMessageBackedSession(previous, session)
      })
      const candidateIds = new Set<string>()
      for (const session of candidates) {
        const sessionId = String(session.username || '').trim()
        if (sessionId) candidateIds.add(sessionId)
        const previous = previousBaseline.get(session.username) || this.sessionBaseline.get(session.username)
        const scanRecentRevokes = this.hasUnreadCountDecreased(previous, session) ||
          (this.hasUnreadCountChanged(previous, session) && this.isRevokeSessionSummary(session)) ||
          (Boolean(sessionId) && messageTableTargetSessionIds.has(sessionId))
        const result = await this.pushSessionMessages(
          session,
          previous,
          { scanRecentRevokes }
        )
        this.updateInspectedBaseline(session, previousBaseline.get(session.username), result)
        if (result.retry) {
          this.rerunRequested = true
        }
      }

      for (const session of sessions) {
        const sessionId = String(session.username || '').trim()
        if (!sessionId || candidateIds.has(sessionId)) continue
        this.updateObservedBaseline(session, previousBaseline.get(sessionId))
      }
    } finally {
      this.processing = false
      if (this.rerunRequested) {
        this.rerunRequested = false
        this.scheduleSync({ scanMessageBackedSessions: this.messageTableScanRequested })
      }
    }
  }

  private setBaseline(sessions: ChatSession[]): void {
    const previousBaseline = new Map(this.sessionBaseline)
    const nextBaseline = new Map<string, SessionBaseline>()
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.sessionBaseline.clear()
    for (const session of sessions) {
      const username = String(session.username || '').trim()
      if (!username) continue
      const previous = previousBaseline.get(username)
      const sessionTimestamp = Number(session.lastTimestamp || 0)
      const initialTimestamp = sessionTimestamp > 0 ? sessionTimestamp : nowSeconds
      nextBaseline.set(username, {
        lastTimestamp: Math.max(sessionTimestamp, Number(previous?.lastTimestamp || 0), previous ? 0 : initialTimestamp),
        unreadCount: Number(session.unreadCount || 0)
      })
    }
    for (const [username, baseline] of nextBaseline.entries()) {
      this.sessionBaseline.set(username, baseline)
    }
  }

  private updateObservedBaseline(session: ChatSession, previous: SessionBaseline | undefined): void {
    const username = String(session.username || '').trim()
    if (!username) return

    const sessionTimestamp = Number(session.lastTimestamp || 0)
    const previousTimestamp = Number(previous?.lastTimestamp || 0)
    this.sessionBaseline.set(username, {
      lastTimestamp: Math.max(sessionTimestamp, previousTimestamp),
      unreadCount: Number(session.unreadCount ?? previous?.unreadCount ?? 0)
    })
  }

  private updateInspectedBaseline(
    session: ChatSession,
    previous: SessionBaseline | undefined,
    result: PushSessionResult
  ): void {
    const username = String(session.username || '').trim()
    if (!username) return

    const previousTimestamp = Number(previous?.lastTimestamp || 0)
    const current = this.sessionBaseline.get(username) || previous || { lastTimestamp: 0, unreadCount: 0 }
    const nextTimestamp = result.retry
      ? previousTimestamp
      : Math.max(previousTimestamp, current.lastTimestamp, result.maxFetchedTimestamp)

    this.sessionBaseline.set(username, {
      lastTimestamp: nextTimestamp,
      unreadCount: result.retry
        ? Number(previous?.unreadCount || 0)
        : Number(session.unreadCount || 0)
    })
  }

  private shouldInspectSession(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }

    const lastTimestamp = Number(session.lastTimestamp || 0)
    const unreadCount = Number(session.unreadCount || 0)

    if (!previous) {
      return unreadCount > 0 && lastTimestamp > 0
    }

    if (this.isRevokeSessionSummary(session) && lastTimestamp >= previous.lastTimestamp) {
      return true
    }

    return lastTimestamp > previous.lastTimestamp || unreadCount !== previous.unreadCount
  }

  private hasUnreadCountChanged(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    if (!previous) return false
    return Number(session.unreadCount || 0) !== Number(previous.unreadCount || 0)
  }

  private hasUnreadCountDecreased(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    if (!previous) return false
    return Number(session.unreadCount || 0) < Number(previous.unreadCount || 0)
  }

  private shouldScanMessageBackedSession(previous: SessionBaseline | undefined, session: ChatSession): boolean {
    const sessionId = String(session.username || '').trim()
    if (!sessionId || sessionId.toLowerCase().includes('placeholder_foldgroup')) {
      return false
    }

    const sessionType = this.getSessionType(sessionId, session)
    if (sessionType === 'private' && !this.isRevokeSessionSummary(session)) {
      return false
    }

    return Boolean(previous) || Number(session.lastTimestamp || 0) > 0
  }

  private async pushSessionMessages(
    session: ChatSession,
    previous: SessionBaseline | undefined,
    options: PushSessionOptions = {}
  ): Promise<PushSessionResult> {
    const previousTimestamp = Math.max(0, Number(previous?.lastTimestamp || 0))
    const previousUnreadCount = Math.max(0, Number(previous?.unreadCount || 0))
    const currentUnreadCount = Math.max(0, Number(session.unreadCount || 0))
    const expectedIncomingCount = previous
      ? Math.max(0, currentUnreadCount - previousUnreadCount)
      : 0
    const since = previous
      ? Math.max(0, previousTimestamp - this.lookbackSeconds)
      : 0
    const newMessagesResult = await chatService.getNewMessages(session.username, since, 1000)
    const fetchedMessages = newMessagesResult.success && Array.isArray(newMessagesResult.messages)
      ? newMessagesResult.messages
      : []
    if (fetchedMessages.length === 0 && !options.scanRecentRevokes) {
      return {
        fetched: false,
        maxFetchedTimestamp: previousTimestamp,
        incomingCandidateCount: 0,
        observedIncomingCount: 0,
        expectedIncomingCount,
        retry: expectedIncomingCount > 0
      }
    }

    const sessionId = String(session.username || '').trim()
    const maxFetchedTimestamp = fetchedMessages.reduce((max, message) => {
      const createTime = Number(message.createTime || 0)
      return Number.isFinite(createTime) && createTime > max ? createTime : max
    }, previousTimestamp)
    const seenPrimed = sessionId ? this.seenPrimedSessions.has(sessionId) : false
    const sameTimestampIncoming: Message[] = []
    const candidateMessages: Message[] = []
    let observedIncomingCount = 0

    for (const message of fetchedMessages) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey) continue
      const createTime = Number(message.createTime || 0)
      const seen = this.isSeenMessage(messageKey)
      const recent = this.isRecentMessage(messageKey)
      const revokeMessage = this.isRevokeSystemMessage(message)

      if (message.isSend !== 1) {
        if (!previous || createTime > previousTimestamp || (seenPrimed && createTime === previousTimestamp)) {
          observedIncomingCount += 1
        }
      }

      if (previous && !seenPrimed && createTime < previousTimestamp) {
        if (revokeMessage && !recent) {
          candidateMessages.push(message)
          continue
        }
        this.rememberSeenMessageKey(messageKey)
        continue
      }

      if (seen || recent) {
        if (seen && !recent && revokeMessage) {
          candidateMessages.push(message)
        }
        continue
      }
      if (message.isSend === 1) continue
      if (previous && !seenPrimed && createTime === previousTimestamp) {
        if (revokeMessage) {
          candidateMessages.push(message)
        } else {
          sameTimestampIncoming.push(message)
        }
        continue
      }

      candidateMessages.push(message)
    }

    const futureIncomingCount = candidateMessages.filter((message) => {
      const createTime = Number(message.createTime || 0)
      return !previous || createTime > previousTimestamp || seenPrimed
    }).length
    const sameTimestampAllowance = previous && !seenPrimed
      ? Math.max(0, expectedIncomingCount - futureIncomingCount)
      : 0
    const selectedSameTimestamp = sameTimestampAllowance > 0
      ? sameTimestampIncoming.slice(-sameTimestampAllowance)
      : []
    const messagesToPush = [...selectedSameTimestamp, ...candidateMessages]
    const suppressedNormalMessageKeys = this.collectSuppressedNormalMessageKeys(messagesToPush, fetchedMessages)
    const incomingCandidateCount = messagesToPush.length

    for (const message of messagesToPush) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey) continue
      if (!this.isRevokeSystemMessage(message) && suppressedNormalMessageKeys.has(messageKey)) {
        this.rememberMessageKey(messageKey)
        continue
      }
      if (!this.isRevokeSystemMessage(message) && this.isRecentlyRevokedOriginal(session.username, message)) {
        this.rememberMessageKey(messageKey)
        this.rememberSeenMessageKey(messageKey)
        continue
      }
      const payload = this.isRevokeSystemMessage(message)
        ? await this.buildRevokePayload(session, message, fetchedMessages)
        : await this.buildPayload(session, message)
      if (!payload) continue
      if (!this.shouldPushPayload(payload)) continue

      httpService.broadcastMessagePush(payload)
      this.rememberMessageKey(messageKey)
      this.bumpSessionBaseline(session.username, message)
    }

    for (const message of fetchedMessages) {
      const messageKey = String(message.messageKey || '').trim()
      if (messageKey) this.rememberSeenMessageKey(messageKey)
    }
    if (sessionId) this.seenPrimedSessions.add(sessionId)

    const recentRevokeResult = options.scanRecentRevokes
      ? await this.pushRecentRevokeMessages(session, previous, fetchedMessages)
      : { pushedCount: 0, maxPushedTimestamp: 0 }

    return {
      fetched: true,
      maxFetchedTimestamp: Math.max(maxFetchedTimestamp, recentRevokeResult.maxPushedTimestamp),
      incomingCandidateCount: incomingCandidateCount + recentRevokeResult.pushedCount,
      observedIncomingCount,
      expectedIncomingCount,
      retry: expectedIncomingCount > 0 && observedIncomingCount < expectedIncomingCount
    }
  }

  private async pushRecentRevokeMessages(
    session: ChatSession,
    previous: SessionBaseline | undefined,
    contextMessages: Message[]
  ): Promise<{ pushedCount: number; maxPushedTimestamp: number }> {
    const sessionId = String(session.username || '').trim()
    if (!sessionId) return { pushedCount: 0, maxPushedTimestamp: 0 }

    const since = this.getRecentRevokeScanSince(session, previous)
    const revokeMessages = await this.getRecentRevokeMessagesFromTables(sessionId, since)
    if (revokeMessages.length === 0) {
      return { pushedCount: 0, maxPushedTimestamp: 0 }
    }

    const mergedMessages = this.mergeMessagesForRevokeLookup(contextMessages, revokeMessages)
    let pushedCount = 0
    let maxPushedTimestamp = 0

    for (const message of revokeMessages) {
      const messageKey = String(message.messageKey || '').trim()
      if (!messageKey || !this.isRevokeSystemMessage(message)) continue
      if (this.isRecentMessage(messageKey)) continue

      const payload = await this.buildRevokePayload(session, message, mergedMessages)
      if (!payload) continue
      if (!this.shouldPushPayload(payload)) continue

      httpService.broadcastMessagePush(payload)
      this.rememberMessageKey(messageKey)
      this.rememberSeenMessageKey(messageKey)
      this.bumpSessionBaseline(sessionId, message)
      pushedCount += 1

      const createTime = Number(message.createTime || 0)
      if (Number.isFinite(createTime) && createTime > maxPushedTimestamp) {
        maxPushedTimestamp = createTime
      }
    }

    return { pushedCount, maxPushedTimestamp }
  }

  private getRecentRevokeScanSince(session: ChatSession, previous: SessionBaseline | undefined): number {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const anchor = Math.max(
      nowSeconds,
      Number(session.lastTimestamp || 0),
      Number(previous?.lastTimestamp || 0)
    )
    return Math.max(0, anchor - this.recentRevokeScanSeconds)
  }

  private async getRecentRevokeMessagesFromTables(sessionId: string, since: number): Promise<Message[]> {
    const tables = await this.getCandidateMessageTables(sessionId, since)
    if (tables.length === 0) return []

    const messages: Message[] = []
    const sinceSeconds = this.toSafeSqlInteger(since)
    for (const table of tables) {
      const sql = [
        `SELECT *, '${this.escapeSqlString(table.dbPath)}' AS _db_path, '${this.escapeSqlString(table.tableName)}' AS table_name`,
        `FROM ${this.quoteSqlIdentifier(table.tableName)}`,
        `WHERE create_time >= ${sinceSeconds}`,
        `AND (local_type IN (10000, 10002) OR message_content LIKE '%撤回%' OR message_content LIKE '%revokemsg%' OR message_content LIKE '%<replacemsg%' OR compress_content LIKE '%撤回%' OR compress_content LIKE '%revokemsg%')`,
        `ORDER BY create_time ASC, sort_seq ASC, local_id ASC`,
        `LIMIT ${this.directRevokeScanLimit}`
      ].join(' ')
      const result = await wcdbService.execQuery('message', table.dbPath, sql)
      if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) continue
      messages.push(...chatService.mapRowsToMessagesForApi(result.rows as Record<string, any>[]))
    }

    return messages
      .filter((message) => this.isRevokeSystemMessage(message))
      .sort((left, right) => this.compareMessagePosition(left, right))
  }

  private async getRecentRevokeContextMessages(sessionId: string, since: number): Promise<Message[]> {
    const tables = await this.getCandidateMessageTables(sessionId, since)
    if (tables.length === 0) return []

    const messages: Message[] = []
    const sinceSeconds = this.toSafeSqlInteger(since)
    for (const table of tables) {
      const sql = [
        `SELECT *, '${this.escapeSqlString(table.dbPath)}' AS _db_path, '${this.escapeSqlString(table.tableName)}' AS table_name`,
        `FROM ${this.quoteSqlIdentifier(table.tableName)}`,
        `WHERE create_time >= ${sinceSeconds}`,
        `ORDER BY create_time ASC, sort_seq ASC, local_id ASC`,
        `LIMIT ${this.directRevokeScanLimit * 4}`
      ].join(' ')
      const result = await wcdbService.execQuery('message', table.dbPath, sql)
      if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) continue
      messages.push(...chatService.mapRowsToMessagesForApi(result.rows as Record<string, any>[]))
    }

    return messages.sort((left, right) => this.compareMessagePosition(left, right))
  }

  private async findMessageByServerIdDirect(
    sessionId: string,
    revokeMessage: Message,
    serverId: string
  ): Promise<Message | undefined> {
    const normalizedServerId = this.normalizeMessageIdToken(serverId)
    if (!normalizedServerId) return undefined

    const source = this.parseMessageKeySource(revokeMessage.messageKey)
    const tables = source
      ? [source]
      : await this.getCandidateMessageTables(sessionId, Math.max(0, Number(revokeMessage.createTime || 0) - 5 * 60))
    const revokeLocalId = Number(revokeMessage.localId || 0)

    for (const table of tables) {
      const serverPredicate = this.buildServerIdPredicate('server_id', normalizedServerId)
      const localFilter = Number.isFinite(revokeLocalId) && revokeLocalId > 0
        ? `AND local_id <> ${this.toSafeSqlInteger(revokeLocalId)}`
        : ''
      const sql = [
        `SELECT *, '${this.escapeSqlString(table.dbPath)}' AS _db_path, '${this.escapeSqlString(table.tableName)}' AS table_name`,
        `FROM ${this.quoteSqlIdentifier(table.tableName)}`,
        `WHERE ${serverPredicate}`,
        localFilter,
        `AND local_type NOT IN (10000, 10002)`,
        `ORDER BY local_id ASC`,
        `LIMIT 1`
      ].filter(Boolean).join(' ')
      const result = await wcdbService.execQuery('message', table.dbPath, sql)
      if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) continue
      const [message] = chatService.mapRowsToMessagesForApi(result.rows as Record<string, any>[])
      if (message && !this.isRevokeSystemMessage(message)) return message
    }

    return undefined
  }

  private async getCandidateMessageTables(
    sessionId: string,
    since: number
  ): Promise<Array<{ dbPath: string; tableName: string }>> {
    const result = await wcdbService.getMessageTableStats(sessionId)
    if (!result.success || !Array.isArray(result.tables)) return []

    const sinceSeconds = Math.max(0, Number(since || 0))
    return result.tables
      .map((table) => ({
        dbPath: String(table?.db_path || table?.dbPath || '').trim(),
        tableName: String(table?.table_name || table?.tableName || '').trim(),
        lastTime: Number(table?.last_time || table?.lastTime || 0)
      }))
      .filter((table) => table.dbPath && table.tableName && (!sinceSeconds || table.lastTime >= sinceSeconds))
      .sort((left, right) => right.lastTime - left.lastTime)
  }

  private mergeMessagesForRevokeLookup(primary: Message[], secondary: Message[]): Message[] {
    const merged: Message[] = []
    const keys = new Set<string>()
    for (const message of [...primary, ...secondary]) {
      const key = String(message.messageKey || '').trim()
      if (key) {
        if (keys.has(key)) continue
        keys.add(key)
      }
      merged.push(message)
    }
    return merged
  }

  private async buildPayload(session: ChatSession, message: Message): Promise<MessagePushPayload | null> {
    const sessionId = String(session.username || '').trim()
    const messageKey = String(message.messageKey || '').trim()
    if (!sessionId || !messageKey) return null

    const isGroup = sessionId.endsWith('@chatroom')
    const sessionType = this.getSessionType(sessionId, session)
    const content = this.getMessageDisplayContent(message)
    const rawid = this.getMessageRawId(message)

    const createTime = Number(message.createTime || 0)

    if (isGroup) {
      const groupInfo = await chatService.getContactAvatar(sessionId)
      const groupName = session.displayName || groupInfo?.displayName || sessionId
      const sourceName = await this.resolveGroupSourceName(sessionId, message, session)
      const avatarUrl = await this.normalizePushAvatarUrl(session.avatarUrl || groupInfo?.avatarUrl)
      return {
        event: 'message.new',
        sessionId,
        sessionType,
        rawid,
        avatarUrl,
        groupName,
        sourceName,
        content,
        timestamp: createTime
      }
    }

    const contactInfo = await chatService.getContactAvatar(sessionId)
    const avatarUrl = await this.normalizePushAvatarUrl(session.avatarUrl || contactInfo?.avatarUrl)
    return {
      event: 'message.new',
      sessionId,
      sessionType,
      rawid,
      avatarUrl,
      sourceName: session.displayName || contactInfo?.displayName || sessionId,
      content,
      timestamp: createTime
    }
  }

  private isRevokeSystemMessage(message: Message): boolean {
    const localType = Number(message.localType || 0)
    const content = `${message.rawContent || ''}\n${message.parsedContent || ''}`
    if (content.includes('revokemsg') || content.includes('<replacemsg')) return true
    if (content.includes('撤回了一条消息') || content.includes('尝试撤回此消息')) return true
    if ((localType === 10000 || localType === 10002) && content.includes('撤回')) return true
    return false
  }

  private isRevokeSessionSummary(session: ChatSession): boolean {
    const lastMsgType = Number(session.lastMsgType || 0)
    const summary = String(session.summary || '').trim()
    return lastMsgType === 10002 || summary.includes('撤回了一条消息') || summary.includes('尝试撤回此消息')
  }

  private isSelfRevokeMessage(message: Message): boolean {
    const content = `${message.rawContent || ''}\n${message.parsedContent || ''}`
    return content.includes('你撤回')
  }

  private async findRevokedOriginalMessage(
    sessionId: string,
    revokeMessage: Message,
    fetchedMessages: Message[],
    revokedMessageId?: string
  ): Promise<Message | undefined> {
    const fromFetched = this.findRevokedOriginalInMessages(fetchedMessages, revokeMessage, revokedMessageId)
    if (fromFetched) return fromFetched

    const createTime = Number(revokeMessage.createTime || 0)
    if (!Number.isFinite(createTime) || createTime <= 0) return undefined

    if (revokedMessageId) {
      const directMessage = await this.findMessageByServerIdDirect(sessionId, revokeMessage, revokedMessageId)
      if (directMessage) return directMessage
    }

    const lookupMessages = await this.getRecentRevokeContextMessages(sessionId, Math.max(0, createTime - 5 * 60))
    if (lookupMessages.length === 0) return undefined
    return this.findRevokedOriginalInMessages(lookupMessages, revokeMessage, revokedMessageId)
  }

  private collectSuppressedNormalMessageKeys(messagesToPush: Message[], fetchedMessages: Message[]): Set<string> {
    const suppressed = new Set<string>()
    const pushKeySet = new Set(messagesToPush.map((message) => String(message.messageKey || '').trim()).filter(Boolean))
    for (const message of messagesToPush) {
      if (!this.isRevokeSystemMessage(message)) continue
      const originalMessage = this.findRevokedOriginalInMessages(fetchedMessages, message, this.extractRevokedMessageId(message))
      const originalKey = String(originalMessage?.messageKey || '').trim()
      if (originalKey && pushKeySet.has(originalKey)) {
        suppressed.add(originalKey)
      }
    }
    return suppressed
  }

  private findRevokedOriginalInMessages(
    messages: Message[],
    revokeMessage: Message,
    revokedMessageId?: string
  ): Message | undefined {
    if (revokedMessageId) {
      const byPlatformId = this.findMessageByPlatformId(messages, revokedMessageId, revokeMessage)
      if (byPlatformId) return byPlatformId
    }
    return this.findNearestMessageBeforeRevoke(messages, revokeMessage)
  }

  private findMessageByPlatformId(messages: Message[], revokedMessageId: string, revokeMessage: Message): Message | undefined {
    const normalizedTarget = this.normalizeMessageIdToken(revokedMessageId)
    if (!normalizedTarget) return undefined

    for (const message of messages) {
      if (message.messageKey === revokeMessage.messageKey) continue
      if (this.isRevokeSystemMessage(message)) continue
      if (this.getMessageIdTokens(message).has(normalizedTarget)) {
        return message
      }
    }
    return undefined
  }

  private findNearestMessageBeforeRevoke(messages: Message[], revokeMessage: Message): Message | undefined {
    const revokeCreateTime = Number(revokeMessage.createTime || 0)
    const revokeSortSeq = Number(revokeMessage.sortSeq || 0)
    const revokeLocalId = Number(revokeMessage.localId || 0)

    let best: Message | undefined
    for (const message of messages) {
      if (message.messageKey === revokeMessage.messageKey) continue
      if (message.isSend === 1) continue
      if (this.isRevokeSystemMessage(message)) continue

      const createTime = Number(message.createTime || 0)
      const sortSeq = Number(message.sortSeq || 0)
      const localId = Number(message.localId || 0)
      if (revokeCreateTime > 0 && createTime > revokeCreateTime) continue
      if (revokeCreateTime > 0 && createTime === revokeCreateTime) {
        if (revokeSortSeq > 0 && sortSeq > revokeSortSeq) continue
        if (revokeSortSeq <= 0 && revokeLocalId > 0 && localId > revokeLocalId) continue
      }

      if (!best || this.compareMessagePosition(message, best) > 0) {
        best = message
      }
    }
    return best
  }

  private compareMessagePosition(left: Message, right: Message): number {
    const leftCreateTime = Number(left.createTime || 0)
    const rightCreateTime = Number(right.createTime || 0)
    if (leftCreateTime !== rightCreateTime) return leftCreateTime - rightCreateTime

    const leftSortSeq = Number(left.sortSeq || 0)
    const rightSortSeq = Number(right.sortSeq || 0)
    if (leftSortSeq !== rightSortSeq) return leftSortSeq - rightSortSeq

    const leftLocalId = Number(left.localId || 0)
    const rightLocalId = Number(right.localId || 0)
    if (leftLocalId !== rightLocalId) return leftLocalId - rightLocalId

    return String(left.messageKey || '').localeCompare(String(right.messageKey || ''))
  }

  private getMessageIdTokens(message: Message): Set<string> {
    const tokens = new Set<string>()
    const add = (value: unknown) => {
      const normalized = this.normalizeMessageIdToken(value)
      if (normalized) tokens.add(normalized)
    }
    add(message.serverIdRaw)
    add(message.serverId)
    add(message.localId)
    const content = String(message.rawContent || '')
    add(this.extractXmlValue(content, 'newmsgid'))
    add(this.extractXmlValue(content, 'msgid'))
    add(this.extractXmlValue(content, 'oldmsgid'))
    add(this.extractXmlValue(content, 'svrid'))
    return tokens
  }

  private extractRevokedMessageId(message: Message): string | undefined {
    const content = String(message.rawContent || message.parsedContent || '')
    const candidates = [
      this.extractXmlValue(content, 'newmsgid'),
      this.extractXmlValue(content, 'msgid'),
      this.extractXmlValue(content, 'oldmsgid'),
      this.extractXmlValue(content, 'svrid'),
      message.serverIdRaw,
      message.serverId
    ]
    for (const candidate of candidates) {
      const normalized = this.normalizeMessageIdToken(candidate)
      if (normalized) return normalized
    }
    return undefined
  }

  private extractRevokerUsername(message: Message): string | undefined {
    const content = String(message.rawContent || '')
    const candidates = [
      this.extractXmlValue(content, 'fromusername'),
      this.extractXmlValue(content, 'session'),
      message.senderUsername
    ]
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim()
      if (normalized) return normalized
    }
    return undefined
  }

  private getRevokeFallbackContent(message: Message): string | null {
    const content = String(message.rawContent || message.parsedContent || '')
    const replacemsg = this.extractXmlValue(content, 'replacemsg')
    if (replacemsg && !replacemsg.includes('撤回了一条消息')) return replacemsg
    return null
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const decoded = this.decodeBasicXmlEntities(String(xml || ''))
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i')
    const match = regex.exec(decoded)
    if (!match) return ''
    return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  }

  private decodeBasicXmlEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  }

  private normalizeMessageIdToken(value: unknown): string {
    const raw = String(value ?? '').trim()
    if (!raw) return ''
    const numeric = /^-?\d+$/.test(raw) ? raw.replace(/^-/, '').replace(/^0+(?=\d)/, '') : raw
    return numeric === '0' ? '' : numeric
  }

  private parseMessageKeySource(messageKey?: string): { dbPath: string; tableName: string } | null {
    const raw = String(messageKey || '').trim()
    if (!raw) return null

    const parts = raw.split(':')
    if (parts.length < 3) return null
    parts.pop()
    const tableName = String(parts.pop() || '').trim()
    const encodedDbPath = parts.join(':')
    if (!tableName || !encodedDbPath) return null

    try {
      const dbPath = decodeURIComponent(encodedDbPath)
      return dbPath ? { dbPath, tableName } : null
    } catch {
      return { dbPath: encodedDbPath, tableName }
    }
  }

  private quoteSqlIdentifier(identifier: string): string {
    return `"${String(identifier || '').replace(/"/g, '""')}"`
  }

  private escapeSqlString(value: string): string {
    return String(value || '').replace(/'/g, "''")
  }

  private toSafeSqlInteger(value: unknown): number {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return 0
    return Math.max(0, Math.floor(numeric))
  }

  private buildServerIdPredicate(columnName: string, serverId: string): string {
    const column = this.quoteSqlIdentifier(columnName)
    const escaped = this.escapeSqlString(serverId)
    if (/^\d+$/.test(serverId)) {
      return `(${column} = ${serverId} OR CAST(${column} AS TEXT) = '${escaped}')`
    }
    return `CAST(${column} AS TEXT) = '${escaped}'`
  }

  private async buildRevokePayload(
    session: ChatSession,
    message: Message,
    fetchedMessages: Message[]
  ): Promise<MessagePushPayload | null> {
    const sessionId = String(session.username || '').trim()
    const messageKey = String(message.messageKey || '').trim()
    if (!sessionId || !messageKey) return null
    if (this.isSelfRevokeMessage(message)) return null

    const revokedMessageId = this.extractRevokedMessageId(message)
    const originalMessage = await this.findRevokedOriginalMessage(sessionId, message, fetchedMessages, revokedMessageId)
    const rawid = this.getDisplayRawId(originalMessage, revokedMessageId, message)
    const originalContent = originalMessage
      ? this.getMessageDisplayContent(originalMessage)
      : this.getRevokeFallbackContent(message)
    const safeContent = String(originalContent || '未知内容').trim() || '未知内容'
    const content = `对方撤回了一条消息（rawid：${rawid}） 内容为“${safeContent}”`
    this.rememberRecentlyRevokedOriginalTokens(sessionId, originalMessage, revokedMessageId, message)
    const isGroup = sessionId.endsWith('@chatroom')
    const sessionType = this.getSessionType(sessionId, session)
    const createTime = Number(message.createTime || 0)

    if (isGroup) {
      const groupInfo = await chatService.getContactAvatar(sessionId)
      const groupName = session.displayName || groupInfo?.displayName || sessionId
      const revokerUsername = this.extractRevokerUsername(message)
      const sourceMessage = revokerUsername ? { ...message, senderUsername: revokerUsername } : message
      const sourceName = await this.resolveGroupSourceName(sessionId, sourceMessage, session)
      const avatarUrl = await this.normalizePushAvatarUrl(session.avatarUrl || groupInfo?.avatarUrl)
      return {
        event: 'message.revoke',
        sessionId,
        sessionType,
        rawid,
        avatarUrl,
        groupName,
        sourceName,
        content,
        timestamp: createTime
      }
    }

    const contactInfo = await chatService.getContactAvatar(sessionId)
    const avatarUrl = await this.normalizePushAvatarUrl(session.avatarUrl || contactInfo?.avatarUrl)
    return {
      event: 'message.revoke',
      sessionId,
      sessionType,
      rawid,
      avatarUrl,
      sourceName: session.displayName || contactInfo?.displayName || sessionId,
      content,
      timestamp: createTime
    }
  }

  private getMessageRawId(message: Message): string {
    return String(message.serverIdRaw || '').trim()
  }

  private getDisplayRawId(originalMessage?: Message, revokedMessageId?: string, revokeMessage?: Message): string {
    const candidates = originalMessage
      ? [originalMessage.serverIdRaw, revokedMessageId]
      : [revokedMessageId, revokeMessage?.serverIdRaw]
    for (const candidate of candidates) {
      const normalized = this.normalizeMessageIdToken(candidate)
      if (normalized) return normalized
    }
    return '未知'
  }

  private rememberRecentlyRevokedOriginalTokens(
    sessionId: string,
    originalMessage?: Message,
    revokedMessageId?: string,
    revokeMessage?: Message
  ): void {
    const keyPrefix = String(sessionId || '').trim()
    if (!keyPrefix) return

    this.pruneRecentlyRevokedOriginalTokens()
    const tokens = new Set<string>()
    const add = (value: unknown) => {
      const normalized = this.normalizeMessageIdToken(value)
      if (normalized) tokens.add(normalized)
    }

    if (originalMessage) {
      add(originalMessage.serverIdRaw)
      add(originalMessage.serverId)
    }
    add(revokedMessageId)
    add(revokeMessage?.serverIdRaw)
    add(revokeMessage?.serverId)

    const now = Date.now()
    for (const token of tokens) {
      this.recentlyRevokedOriginalTokens.set(`${keyPrefix}\u0000${token}`, now)
    }
  }

  private isRecentlyRevokedOriginal(sessionId: string, message: Message): boolean {
    const keyPrefix = String(sessionId || '').trim()
    if (!keyPrefix) return false

    this.pruneRecentlyRevokedOriginalTokens()
    for (const token of this.getMessageIdTokens(message)) {
      if (this.recentlyRevokedOriginalTokens.has(`${keyPrefix}\u0000${token}`)) {
        return true
      }
    }
    return false
  }

  private pruneRecentlyRevokedOriginalTokens(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.recentlyRevokedOriginalTokens.entries()) {
      if (now - timestamp > this.recentMessageTtlMs) {
        this.recentlyRevokedOriginalTokens.delete(key)
      }
    }
  }

  private async normalizePushAvatarUrl(avatarUrl?: string): Promise<string | undefined> {
    const normalized = String(avatarUrl || '').trim()
    if (!normalized) return undefined
    if (!normalized.startsWith('data:image/')) {
      return normalized
    }

    const cached = this.pushAvatarDataCache.get(normalized)
    if (cached) return cached

    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(normalized)
    if (!match) return undefined

    try {
      const mimeType = match[1].toLowerCase()
      const base64Data = match[2]
      const imageBuffer = Buffer.from(base64Data, 'base64')
      if (!imageBuffer.length) return undefined

      const ext = this.getImageExtFromMime(mimeType)
      const hash = createHash('sha1').update(normalized).digest('hex')
      const filePath = path.join(this.pushAvatarCacheDir, `avatar_${hash}.${ext}`)

      await fs.mkdir(this.pushAvatarCacheDir, { recursive: true })
      try {
        await fs.access(filePath)
      } catch {
        await fs.writeFile(filePath, imageBuffer)
      }

      const fileUrl = pathToFileURL(filePath).toString()
      this.pushAvatarDataCache.set(normalized, fileUrl)
      return fileUrl
    } catch {
      return undefined
    }
  }

  private getImageExtFromMime(mimeType: string): string {
    if (mimeType === 'image/png') return 'png'
    if (mimeType === 'image/gif') return 'gif'
    if (mimeType === 'image/webp') return 'webp'
    return 'jpg'
  }

  private getSessionType(sessionId: string, session: ChatSession): MessagePushPayload['sessionType'] {
    if (sessionId.endsWith('@chatroom')) {
      return 'group'
    }
    if (sessionId.startsWith('gh_') || session.type === 'official') {
      return 'official'
    }
    if (session.type === 'friend') {
      return 'private'
    }
    return 'other'
  }

  private shouldPushPayload(payload: MessagePushPayload): boolean {
    const sessionId = String(payload.sessionId || '').trim()
    const filterMode = this.getMessagePushFilterMode()
    if (filterMode === 'all') {
      return true
    }

    const filterList = this.getMessagePushFilterList()
    const listed = filterList.has(sessionId)
    if (filterMode === 'whitelist') {
      return listed
    }
    return !listed
  }

  private getMessagePushFilterMode(): 'all' | 'whitelist' | 'blacklist' {
    const value = this.configService.get('messagePushFilterMode')
    if (value === 'whitelist' || value === 'blacklist') return value
    return 'all'
  }

  private getMessagePushFilterList(): Set<string> {
    const value = this.configService.get('messagePushFilterList')
    if (!Array.isArray(value)) return new Set()
    return new Set(value.map((item) => String(item || '').trim()).filter(Boolean))
  }

  private collectMessageTableNamesFromPayload(payload: Record<string, unknown> | null): string[] {
    const tableNames = new Set<string>()
    const visit = (value: unknown, keyHint = '') => {
      if (value === null || value === undefined) return
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return
        const key = keyHint.toLowerCase()
        if (key.includes('table') && this.isMessageTableChange(trimmed)) {
          tableNames.add(trimmed)
          return
        }
        for (const match of trimmed.matchAll(/\b(?:msg|message)_[a-z0-9_]+/gi)) {
          const tableName = String(match[0] || '').trim()
          if (tableName && this.isMessageTableChange(tableName)) tableNames.add(tableName)
        }
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, keyHint)
        return
      }
      if (typeof value !== 'object') return

      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, key)
      }
    }

    visit(payload)
    return Array.from(tableNames)
  }

  private isSessionTableChange(tableName: string): boolean {
    return String(tableName || '').trim().toLowerCase() === 'session'
  }

  private isMessageTableChange(tableName: string): boolean {
    const normalized = String(tableName || '').trim().toLowerCase()
    if (!normalized) return false
    return normalized === 'message' ||
      normalized === 'msg' ||
      normalized.startsWith('message_') ||
      normalized.startsWith('msg_') ||
      normalized.includes('message')
  }

  private resolveMessageTableTargetSessionIds(sessions: ChatSession[], tableNames: string[]): Set<string> {
    const targets = new Set<string>()
    if (!Array.isArray(tableNames) || tableNames.length === 0) return targets

    const fullHashLookup = new Map<string, string>()
    const shortHashLookup = new Map<string, string | null>()
    for (const session of sessions) {
      const sessionId = String(session.username || '').trim()
      if (!sessionId) continue
      const fullHash = createHash('md5').update(sessionId).digest('hex').toLowerCase()
      fullHashLookup.set(fullHash, sessionId)
      const shortHash = fullHash.slice(0, 16)
      const existing = shortHashLookup.get(shortHash)
      if (existing === undefined) {
        shortHashLookup.set(shortHash, sessionId)
      } else if (existing !== sessionId) {
        shortHashLookup.set(shortHash, null)
      }
    }

    for (const tableName of tableNames) {
      const matched = this.matchSessionIdByMessageTableName(tableName, fullHashLookup, shortHashLookup)
      if (matched) targets.add(matched)
    }
    return targets
  }

  private matchSessionIdByMessageTableName(
    tableName: string,
    fullHashLookup: Map<string, string>,
    shortHashLookup: Map<string, string | null>
  ): string | null {
    const normalized = String(tableName || '').trim().toLowerCase()
    if (!normalized) return null

    const suffix = normalized.startsWith('msg_') ? normalized.slice(4) : ''
    if (suffix) {
      const directFull = fullHashLookup.get(suffix)
      if (directFull) return directFull

      if (suffix.length >= 16) {
        const directShort = shortHashLookup.get(suffix.slice(0, 16))
        if (typeof directShort === 'string') return directShort
      }
    }

    const hashMatch = /[a-f0-9]{32}|[a-f0-9]{16}/i.exec(normalized)
    if (!hashMatch?.[0]) return null
    const hash = hashMatch[0].toLowerCase()
    if (hash.length >= 32) {
      const full = fullHashLookup.get(hash)
      if (full) return full
    }
    const short = shortHashLookup.get(hash.slice(0, 16))
    return typeof short === 'string' ? short : null
  }

  private bumpSessionBaseline(sessionId: string, message: Message): void {
    const key = String(sessionId || '').trim()
    if (!key) return

    const createTime = Number(message.createTime || 0)
    if (!Number.isFinite(createTime) || createTime <= 0) return

    const current = this.sessionBaseline.get(key) || { lastTimestamp: 0, unreadCount: 0 }
    if (createTime > current.lastTimestamp) {
      this.sessionBaseline.set(key, {
        ...current,
        lastTimestamp: createTime
      })
    }
  }

  private getMessageDisplayContent(message: Message): string | null {
    const normalizeTextContent = (value: string | null | undefined): string | null => {
      const text = String(value || '')
      if (!text) return null
      return text.replace(/^[\s]*([a-zA-Z0-9_@-]+):(?!\/\/)(?:\s*(?:\r?\n|<br\s*\/?>)\s*|\s*)/i, '').trim()
    }

    const cleanOfficialPrefix = (value: string | null): string | null => {
      if (!value) return value
      return value.replace(/^\s*\[视频号\]\s*/u, '').trim() || value
    }
    switch (Number(message.localType || 0)) {
      case 1:
        return cleanOfficialPrefix(normalizeTextContent(message.parsedContent || message.rawContent))
      case 3:
        return '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 42:
        return cleanOfficialPrefix(message.cardNickname || '[名片]')
      case 48:
        return '[位置]'
      case 49:
        return cleanOfficialPrefix(message.linkTitle || message.fileName || '[消息]')
      default:
        return cleanOfficialPrefix(normalizeTextContent(message.parsedContent || message.rawContent) || null)
    }
  }

  private async resolveGroupSourceName(chatroomId: string, message: Message, session: ChatSession): Promise<string> {
    const senderUsername = String(message.senderUsername || '').trim()
    if (!senderUsername) {
      return session.lastSenderDisplayName || '未知发送者'
    }

    const groupNicknames = await this.getGroupNicknames(chatroomId)
    const senderKey = senderUsername.toLowerCase()
    const nickname = groupNicknames[senderKey]

    if (nickname) {
      return nickname
    }

    const contactInfo = await chatService.getContactAvatar(senderUsername)
    return contactInfo?.displayName || senderUsername
  }

  private async getGroupNicknames(chatroomId: string): Promise<Record<string, string>> {
    const cacheKey = String(chatroomId || '').trim()
    if (!cacheKey) return {}

    const cached = this.groupNicknameCache.get(cacheKey)
    if (cached && Date.now() - cached.updatedAt < this.groupNicknameCacheTtlMs) {
      return cached.nicknames
    }

    const result = await wcdbService.getGroupNicknames(cacheKey)
    const nicknames = result.success && result.nicknames
      ? this.sanitizeGroupNicknames(result.nicknames)
      : {}
    this.groupNicknameCache.set(cacheKey, { nicknames, updatedAt: Date.now() })
    return nicknames
  }

  private sanitizeGroupNicknames(nicknames: Record<string, string>): Record<string, string> {
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

    const trusted: Record<string, string> = {}
    for (const [memberId, nicknameSet] of buckets.entries()) {
      if (nicknameSet.size !== 1) continue
      trusted[memberId] = Array.from(nicknameSet)[0]
    }
    return trusted
  }

  private isRecentMessage(messageKey: string): boolean {
    this.pruneRecentMessageKeys()
    const timestamp = this.recentMessageKeys.get(messageKey)
    return typeof timestamp === 'number' && Date.now() - timestamp < this.recentMessageTtlMs
  }

  private rememberMessageKey(messageKey: string): void {
    this.recentMessageKeys.set(messageKey, Date.now())
    this.pruneRecentMessageKeys()
  }

  private isSeenMessage(messageKey: string): boolean {
    this.pruneSeenMessageKeys()
    const timestamp = this.seenMessageKeys.get(messageKey)
    return typeof timestamp === 'number' && Date.now() - timestamp < this.recentMessageTtlMs
  }

  private rememberSeenMessageKey(messageKey: string): void {
    this.seenMessageKeys.set(messageKey, Date.now())
    this.pruneSeenMessageKeys()
  }

  private pruneRecentMessageKeys(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.recentMessageKeys.entries()) {
      if (now - timestamp > this.recentMessageTtlMs) {
        this.recentMessageKeys.delete(key)
      }
    }
  }

  private pruneSeenMessageKeys(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.seenMessageKeys.entries()) {
      if (now - timestamp > this.recentMessageTtlMs) {
        this.seenMessageKeys.delete(key)
      }
    }
  }

}

export const messagePushService = new MessagePushService()
