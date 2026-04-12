import { join, dirname, basename, extname } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, watch, promises as fsPromises } from 'fs'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import * as fzstd from 'fzstd'
import * as crypto from 'crypto'
import { app, BrowserWindow, dialog } from 'electron'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { MessageCacheService } from './messageCacheService'
import { ContactCacheService, ContactCacheEntry } from './contactCacheService'
import { SessionStatsCacheService, SessionStatsCacheEntry, SessionStatsCacheStats } from './sessionStatsCacheService'
import { GroupMyMessageCountCacheService, GroupMyMessageCountCacheEntry } from './groupMyMessageCountCacheService'
import { exportCardDiagnosticsService } from './exportCardDiagnosticsService'
import { voiceTranscribeService } from './voiceTranscribeService'
import { ImageDecryptService } from './imageDecryptService'
import { CONTACT_REGION_LOOKUP_DATA } from './contactRegionLookupData'
import { LRUCache } from '../utils/LRUCache.js'

export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  messageCountHint?: number
  displayName?: string
  avatarUrl?: string
  lastMsgSender?: string
  lastSenderDisplayName?: string
  selfWxid?: string
  isFolded?: boolean  // 是否已折叠进"折叠的群聊"
  isMuted?: boolean   // 是否开启免打扰
}

export interface Message {
  messageKey: string
  localId: number
  serverId: number
  serverIdRaw?: string
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
  emojiThumbUrl?: string
  emojiEncryptUrl?: string
  emojiAesKey?: string
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
  fileMd5?: string          // 文件 MD5
  xmlType?: string          // XML 中的 type 字段
  appMsgKind?: string       // 归一化 appmsg 类型
  appMsgDesc?: string
  appMsgAppName?: string
  appMsgSourceName?: string
  appMsgSourceUsername?: string
  appMsgThumbUrl?: string
  appMsgMusicUrl?: string
  appMsgDataUrl?: string
  appMsgLocationLabel?: string
  finderNickname?: string
  finderUsername?: string
  finderCoverUrl?: string
  finderAvatar?: string
  finderDuration?: number
  // 位置消息
  locationLat?: number
  locationLng?: number
  locationPoiname?: string
  locationLabel?: string
  // 音乐消息
  musicAlbumUrl?: string
  musicUrl?: string
  // 礼物消息
  giftImageUrl?: string
  giftWish?: string
  giftPrice?: string
  // 名片消息
  cardUsername?: string     // 名片的微信ID
  cardNickname?: string     // 名片的昵称
  cardAvatarUrl?: string    // 名片头像 URL
  // 转账消息
  transferPayerUsername?: string   // 转账付款人
  transferReceiverUsername?: string // 转账收款人
  // 聊天记录
  chatRecordTitle?: string  // 聊天记录标题
  chatRecordList?: Array<{
    datatype: number
    sourcename: string
    sourcetime: string
    sourceheadurl?: string
    datadesc?: string
    datatitle?: string
    fileext?: string
    datasize?: number
    messageuuid?: string
    dataurl?: string
    datathumburl?: string
    datacdnurl?: string
    cdndatakey?: string
    cdnthumbkey?: string
    aeskey?: string
    md5?: string
    fullmd5?: string
    thumbfullmd5?: string
    srcMsgLocalid?: number
    imgheight?: number
    imgwidth?: number
    duration?: number
    chatRecordTitle?: string
    chatRecordDesc?: string
    chatRecordList?: any[]
  }>
  _db_path?: string // 内部字段：记录消息所属数据库路径
}

type ResourceMessageType = 'image' | 'video' | 'voice' | 'file'

interface ResourceMessageItem extends Message {
  sessionId: string
  sessionDisplayName?: string
  resourceType: ResourceMessageType
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
  alias?: string
  labels?: string[]
  detailDescription?: string
  region?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
}

interface GetContactsOptions {
  lite?: boolean
}

interface ExportSessionStats {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
  firstTimestamp?: number
  lastTimestamp?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
}

interface ExportSessionStatsOptions {
  includeRelations?: boolean
  forceRefresh?: boolean
  allowStaleCache?: boolean
  preferAccurateSpecialTypes?: boolean
  cacheOnly?: boolean
}

interface ExportSessionStatsCacheMeta {
  updatedAt: number
  stale: boolean
  includeRelations: boolean
  source: 'memory' | 'disk' | 'fresh'
}

interface ExportTabCounts {
  private: number
  group: number
  official: number
  former_friend: number
}

interface SessionDetailFast {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
}

interface SessionDetailExtra {
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

type SessionDetail = SessionDetailFast & SessionDetailExtra

interface SyntheticUnreadState {
  readTimestamp: number
  scannedTimestamp: number
  latestTimestamp: number
  unreadCount: number
  summaryTimestamp?: number
  summary?: string
  lastMsgType?: number
}

interface MyFootprintSummary {
  private_inbound_people: number
  private_replied_people: number
  private_outbound_people: number
  private_reply_rate: number
  mention_count: number
  mention_group_count: number
}

interface MyFootprintPrivateSession {
  session_id: string
  incoming_count: number
  outgoing_count: number
  replied: boolean
  first_incoming_ts: number
  first_reply_ts: number
  latest_ts: number
  anchor_local_id: number
  anchor_create_time: number
  displayName?: string
  avatarUrl?: string
}

interface MyFootprintPrivateSegment {
  session_id: string
  segment_index: number
  start_ts: number
  end_ts: number
  duration_sec: number
  incoming_count: number
  outgoing_count: number
  message_count: number
  replied: boolean
  first_incoming_ts: number
  first_reply_ts: number
  latest_ts: number
  anchor_local_id: number
  anchor_create_time: number
  displayName?: string
  avatarUrl?: string
}

interface MyFootprintMentionItem {
  session_id: string
  local_id: number
  create_time: number
  sender_username: string
  message_content: string
  source: string
  sessionDisplayName?: string
  senderDisplayName?: string
  senderAvatarUrl?: string
}

interface MyFootprintMentionGroup {
  session_id: string
  count: number
  latest_ts: number
  displayName?: string
  avatarUrl?: string
}

interface MyFootprintDiagnostics {
  truncated: boolean
  scanned_dbs: number
  elapsed_ms: number
  mention_truncated?: boolean
  private_truncated?: boolean
  native_ms?: number
  source_filter_ms?: number
  fallback_ms?: number
  enrich_ms?: number
  pipeline_ms?: number
  fallback_used?: boolean
  private_limit_effective?: number
  mention_candidate_limit?: number
  native_mention_candidates?: number
  source_filtered_mentions?: number
  private_session_count?: number
  group_session_count?: number
  native_passes?: number
  native_group_chunks?: number
}

interface MyFootprintData {
  summary: MyFootprintSummary
  private_sessions: MyFootprintPrivateSession[]
  private_segments: MyFootprintPrivateSegment[]
  mentions: MyFootprintMentionItem[]
  mention_groups: MyFootprintMentionGroup[]
  diagnostics: MyFootprintDiagnostics
}

// 表情包缓存
const emojiCache: Map<string, string> = new Map()
const emojiDownloading: Map<string, Promise<string | null>> = new Map()
const FRIEND_EXCLUDE_USERNAMES = new Set(['medianote', 'floatbottle', 'qmessage', 'qqmail', 'fmessage'])

class ChatService {
  private configService: ConfigService
  private connected = false
  private readonly dbMonitorListeners = new Set<(type: string, json: string) => void>()
  private messageCursors: Map<string, { cursor: number; fetched: number; batchSize: number; startTime?: number; endTime?: number; ascending?: boolean; bufferedMessages?: any[] }> = new Map()
  private messageCursorMutex: boolean = false
  private readonly messageBatchDefault = 50
  private avatarCache: Map<string, ContactCacheEntry>
  private readonly avatarCacheTtlMs = 10 * 60 * 1000
  private readonly defaultV1AesKey = 'cfcd208495d565ef'
  private readonly contactCacheService: ContactCacheService
  private readonly messageCacheService: MessageCacheService
  private readonly sessionStatsCacheService: SessionStatsCacheService
  private readonly groupMyMessageCountCacheService: GroupMyMessageCountCacheService
  private readonly imageDecryptService: ImageDecryptService
  private voiceWavCache: LRUCache<string, Buffer>
  private voiceTranscriptCache: LRUCache<string, string>
  private voiceTranscriptPending = new Map<string, Promise<{ success: boolean; transcript?: string; error?: string }>>()
  private transcriptCacheLoaded = false
  private transcriptCacheDirty = false
  private transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null
  private mediaDbsCache: string[] | null = null
  private mediaDbsCacheTime = 0
  private readonly mediaDbsCacheTtl = 300000 // 5分钟
  private readonly voiceWavCacheMaxEntries = 50
  // 缓存 media.db 的表结构信息
  private mediaDbSchemaCache = new Map<string, {
    voiceTable: string
    dataColumn: string
    chatNameIdColumn?: string
    timeColumn?: string
    name2IdTable?: string
  }>()
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
  private sessionMessageCountCache = new Map<string, { count: number; updatedAt: number }>()
  private sessionMessageCountHintCache = new Map<string, number>()
  private syntheticUnreadState = new Map<string, SyntheticUnreadState>()
  private sessionMessageCountBatchCache: {
    dbSignature: string
    sessionIdsKey: string
    counts: Record<string, number>
    updatedAt: number
  } | null = null
  private sessionMessageCountCacheScope = ''
  private readonly sessionMessageCountCacheTtlMs = 10 * 60 * 1000
  private readonly sessionMessageCountBatchCacheTtlMs = 5 * 60 * 1000
  private sessionDetailFastCache = new Map<string, { detail: SessionDetailFast; updatedAt: number }>()
  private sessionDetailExtraCache = new Map<string, { detail: SessionDetailExtra; updatedAt: number }>()
  private readonly sessionDetailFastCacheTtlMs = 60 * 1000
  private readonly sessionDetailExtraCacheTtlMs = 5 * 60 * 1000
  private sessionStatusCache = new Map<string, { isFolded?: boolean; isMuted?: boolean; updatedAt: number }>()
  private readonly sessionStatusCacheTtlMs = 10 * 60 * 1000
  private sessionStatsCacheScope = ''
  private sessionStatsMemoryCache = new Map<string, SessionStatsCacheEntry>()
  private sessionStatsPendingBasic = new Map<string, Promise<ExportSessionStats>>()
  private sessionStatsPendingFull = new Map<string, Promise<ExportSessionStats>>()
  private allGroupSessionIdsCache: { ids: string[]; updatedAt: number } | null = null
  private readonly sessionStatsCacheTtlMs = 10 * 60 * 1000
  private readonly allGroupSessionIdsCacheTtlMs = 5 * 60 * 1000
  private groupMyMessageCountCacheScope = ''
  private groupMyMessageCountMemoryCache = new Map<string, GroupMyMessageCountCacheEntry>()
  private initFailureDialogShown = false
  private readonly contactExtendedFieldCandidates = [
    'label_list', 'labelList', 'labels', 'label_names', 'labelNames', 'tags', 'tag_list', 'tagList',
    'detail_description', 'detailDescription', 'description', 'desc', 'contact_description', 'contactDescription', 'signature', 'sign',
    'country', 'province', 'city', 'region',
    'profile', 'introduction', 'phone', 'mobile', 'telephone', 'tel', 'vcard', 'card_info', 'cardInfo',
    'extra_buffer', 'extraBuffer'
  ]
  private readonly contactExtendedFieldCandidateSet = new Set(this.contactExtendedFieldCandidates.map((name) => name.toLowerCase()))
  private contactExtendedSelectableColumns: string[] | null = null
  private contactLabelNameMapCache: Map<number, string> | null = null
  private contactLabelNameMapCacheAt = 0
  private readonly contactLabelNameMapCacheTtlMs = 10 * 60 * 1000
  private contactsLoadInFlight: { mode: 'lite' | 'full'; promise: Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> } | null = null
  private contactsMemoryCache = new Map<'lite' | 'full', { scope: string; updatedAt: number; contacts: ContactInfo[] }>()
  private readonly contactsMemoryCacheTtlMs = 3 * 60 * 1000
  private readonly contactDisplayNameCollator = new Intl.Collator('zh-CN')
  private readonly slowGetContactsLogThresholdMs = 1200

  constructor() {
    this.configService = new ConfigService()
    this.contactCacheService = new ContactCacheService(this.configService.getCacheBasePath())
    const persisted = this.contactCacheService.getAllEntries()
    this.avatarCache = new Map(Object.entries(persisted))
    this.messageCacheService = new MessageCacheService(this.configService.getCacheBasePath())
    this.sessionStatsCacheService = new SessionStatsCacheService(this.configService.getCacheBasePath())
    this.groupMyMessageCountCacheService = new GroupMyMessageCountCacheService(this.configService.getCacheBasePath())
    this.imageDecryptService = new ImageDecryptService()
    // 初始化LRU缓存，限制大小防止内存泄漏
    this.voiceWavCache = new LRUCache(this.voiceWavCacheMaxEntries)
    this.voiceTranscriptCache = new LRUCache(1000) // 最多缓存1000条转写记录
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

  private extractErrorCode(message?: string): number | null {
    const text = String(message || '').trim()
    if (!text) return null
    const match = text.match(/(?:错误码\s*[:：]\s*|\()(-?\d{2,6})(?:\)|\b)/)
    if (!match) return null
    const parsed = Number(match[1])
    return Number.isFinite(parsed) ? parsed : null
  }

  private toCodeOnlyMessage(rawMessage?: string, fallbackCode = -3999): string {
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
        const detailedError = this.toCodeOnlyMessage(await wcdbService.getLastInitError())
        await this.maybeShowInitFailureDialog(detailedError)
        return { success: false, error: detailedError }
      }

      this.connected = true

      // 设置数据库监控
      this.setupDbMonitor()

      // 预热 listMediaDbs 缓存（后台异步执行，不阻塞连接）
      this.warmupMediaDbsCache()

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
        this.mediaDbsCache = [...mediaResult.data]
        this.mediaDbsCacheTime = Date.now()
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
      const normalizedIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
      return await wcdbService.checkMessageAntiRevokeTriggers(normalizedIds)
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
      const normalizedIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
      return await wcdbService.installMessageAntiRevokeTriggers(normalizedIds)
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
      const normalizedIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
      return await wcdbService.uninstallMessageAntiRevokeTriggers(normalizedIds)
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

      // 转换为 ChatSession（先加载缓存，但不等待额外状态查询）
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
          summary: summary || this.getMessageTypeLabel(lastMsgType),
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

        const cachedStatus = this.sessionStatusCache.get(username)
        if (cachedStatus && now - cachedStatus.updatedAt <= this.sessionStatusCacheTtlMs) {
          nextSession.isFolded = cachedStatus.isFolded
          nextSession.isMuted = cachedStatus.isMuted
        }

        sessions.push(nextSession)

        if (typeof messageCountHint === 'number') {
          this.sessionMessageCountHintCache.set(username, messageCountHint)
          this.sessionMessageCountCache.set(username, {
            count: messageCountHint,
            updatedAt: Date.now()
          })
        }
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

  private async addMissingOfficialSessions(sessions: ChatSession[], myWxid?: string): Promise<void> {
    const existing = new Set(sessions.map((session) => String(session.username || '').trim()).filter(Boolean))
    try {
      const contactResult = await wcdbService.getContactsCompact()
      if (!contactResult.success || !Array.isArray(contactResult.contacts)) return

      for (const row of contactResult.contacts as Record<string, any>[]) {
        const username = String(row.username || '').trim()
        if (!username.startsWith('gh_') || existing.has(username)) continue

        sessions.push({
          username,
          type: 0,
          unreadCount: 0,
          summary: '查看公众号历史消息',
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
          this.sessionMessageCountHintCache.set(session.username, session.messageCountHint)
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
        summary = message.parsedContent || message.rawContent || this.getMessageTypeLabel(Number(message.localType || 0))
        break
    }
    return cleanOfficialPrefix(this.cleanString(summary))
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

  async getSessionStatuses(usernames: string[]): Promise<{
    success: boolean
    map?: Record<string, { isFolded?: boolean; isMuted?: boolean }>
    error?: string
  }> {
    try {
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return { success: true, map: {} }
      }

      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const result = await wcdbService.getContactStatus(usernames)
      if (!result.success || !result.map) {
        return { success: false, error: result.error || '获取会话状态失败' }
      }

      const now = Date.now()
      for (const username of usernames) {
        const state = result.map[username] || { isFolded: false, isMuted: false }
        this.sessionStatusCache.set(username, {
          isFolded: Boolean(state.isFolded),
          isMuted: Boolean(state.isMuted),
          updatedAt: now
        })
      }

      return {
        success: true,
        map: result.map as Record<string, { isFolded?: boolean; isMuted?: boolean }>
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
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

  private async countSessionMessageCountsByTableScan(
    sessionIds: string[],
    traceId?: string
  ): Promise<{
    success: boolean
    counts?: Record<string, number>
    error?: string
    dbSignature?: string
  }> {
    const normalizedSessionIds = Array.from(new Set(
      (sessionIds || [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    ))
    if (normalizedSessionIds.length === 0) {
      return { success: true, counts: {}, dbSignature: 'empty' }
    }

    const snapshotResult = await this.getMessageDbCountSnapshot()
    const dbPaths = snapshotResult.success ? (snapshotResult.dbPaths || []) : []
    const dbSignature = snapshotResult.success
      ? (snapshotResult.dbSignature || this.buildMessageDbSignature(dbPaths))
      : this.buildMessageDbSignature(dbPaths)
    const nativeResult = await wcdbService.getSessionMessageCounts(normalizedSessionIds)
    if (!nativeResult.success || !nativeResult.counts) {
      return { success: false, error: nativeResult.error || '获取会话消息总数失败', dbSignature }
    }
    const counts = normalizedSessionIds.reduce<Record<string, number>>((acc, sid) => {
      const raw = nativeResult.counts?.[sid]
      acc[sid] = Number.isFinite(raw) ? Math.max(0, Math.floor(Number(raw))) : 0
      return acc
    }, {})

    this.logExportDiag({
      traceId,
      level: 'debug',
      source: 'backend',
      stepId: 'backend-get-session-message-counts-table-scan',
      stepName: '会话消息总数表扫描',
      status: 'done',
      message: '按 Msg 表聚合统计完成',
      data: {
        dbCount: dbPaths.length,
        requestedSessions: normalizedSessionIds.length
      }
    })

    return { success: true, counts, dbSignature }
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
    const traceId = this.normalizeExportDiagTraceId(options?.traceId)
    const stepStartedAt = this.startExportDiagStep({
      traceId,
      stepId: 'backend-get-session-message-counts',
      stepName: 'ChatService.getSessionMessageCounts',
      message: '开始批量读取会话消息总数',
      data: {
        requestedSessions: Array.isArray(sessionIds) ? sessionIds.length : 0,
        preferHintCache: options?.preferHintCache !== false,
        bypassSessionCache: options?.bypassSessionCache === true
      }
    })
    let success = false
    let errorMessage = ''
    let returnedCounts = 0

    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        errorMessage = connectResult.error || '数据库未连接'
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const normalizedSessionIds = Array.from(
        new Set(
          (sessionIds || [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedSessionIds.length === 0) {
        success = true
        return { success: true, counts: {} }
      }

      const preferHintCache = options?.preferHintCache !== false
      const bypassSessionCache = options?.bypassSessionCache === true

      this.refreshSessionMessageCountCacheScope()
      const counts: Record<string, number> = {}
      const now = Date.now()
      const pendingSessionIds: string[] = []
      const sessionIdsKey = [...normalizedSessionIds].sort().join('\u0001')

      for (const sessionId of normalizedSessionIds) {
        if (!bypassSessionCache) {
          const cached = this.sessionMessageCountCache.get(sessionId)
          if (cached && now - cached.updatedAt <= this.sessionMessageCountCacheTtlMs) {
            counts[sessionId] = cached.count
            continue
          }
        }

        if (preferHintCache) {
          const hintCount = this.sessionMessageCountHintCache.get(sessionId)
          if (typeof hintCount === 'number' && Number.isFinite(hintCount) && hintCount >= 0) {
            counts[sessionId] = Math.floor(hintCount)
            this.sessionMessageCountCache.set(sessionId, {
              count: Math.floor(hintCount),
              updatedAt: now
            })
            continue
          }
        }

        pendingSessionIds.push(sessionId)
      }

      if (pendingSessionIds.length > 0) {
        let tableScanSucceeded = false
        const cachedBatch = this.sessionMessageCountBatchCache
        const cachedBatchFresh = cachedBatch &&
          now - cachedBatch.updatedAt <= this.sessionMessageCountBatchCacheTtlMs

        if (cachedBatchFresh && cachedBatch.sessionIdsKey === sessionIdsKey) {
          const snapshot = await this.getMessageDbCountSnapshot()
          if (snapshot.success && snapshot.dbSignature === cachedBatch.dbSignature) {
            for (const sessionId of pendingSessionIds) {
              const nextCountRaw = cachedBatch.counts[sessionId]
              const nextCount = Number.isFinite(nextCountRaw) ? Math.max(0, Math.floor(nextCountRaw)) : 0
              counts[sessionId] = nextCount
              this.sessionMessageCountCache.set(sessionId, {
                count: nextCount,
                updatedAt: now
              })
            }
            tableScanSucceeded = true
          }
        }

        if (!tableScanSucceeded) {
          const tableScanResult = await this.countSessionMessageCountsByTableScan(pendingSessionIds, traceId)
          if (tableScanResult.success && tableScanResult.counts) {
            const nowTs = Date.now()
            for (const sessionId of pendingSessionIds) {
              const nextCountRaw = tableScanResult.counts[sessionId]
              const nextCount = Number.isFinite(nextCountRaw) ? Math.max(0, Math.floor(nextCountRaw)) : 0
              counts[sessionId] = nextCount
              this.sessionMessageCountCache.set(sessionId, {
                count: nextCount,
                updatedAt: nowTs
              })
            }
            if (tableScanResult.dbSignature) {
              this.sessionMessageCountBatchCache = {
                dbSignature: tableScanResult.dbSignature,
                sessionIdsKey,
                counts: { ...counts },
                updatedAt: nowTs
              }
            }
            tableScanSucceeded = true
          } else {
            this.logExportDiag({
              traceId,
              level: 'warn',
              source: 'backend',
              stepId: 'backend-get-session-message-counts-table-scan',
              stepName: '会话消息总数表扫描',
              status: 'failed',
              message: '按 Msg 表聚合统计失败，回退逐会话统计',
              data: {
                error: tableScanResult.error || '未知错误'
              }
            })
          }
        }

        if (!tableScanSucceeded) {
          const batchSize = 320
          for (let i = 0; i < pendingSessionIds.length; i += batchSize) {
            const batch = pendingSessionIds.slice(i, i + batchSize)
            this.logExportDiag({
              traceId,
              level: 'debug',
              source: 'backend',
              stepId: 'backend-get-session-message-counts-batch',
              stepName: '会话消息总数批次查询',
              status: 'running',
              message: `开始查询批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(pendingSessionIds.length / batchSize) || 1}`,
              data: {
                batchSize: batch.length
              }
            })
            let batchCounts: Record<string, number> = {}
            try {
              const result = await wcdbService.getMessageCounts(batch)
              if (result.success && result.counts) {
                batchCounts = result.counts
              }
            } catch {
              // noop
            }

            const nowTs = Date.now()
            for (const sessionId of batch) {
              const nextCountRaw = batchCounts[sessionId]
              const nextCount = Number.isFinite(nextCountRaw) ? Math.max(0, Math.floor(nextCountRaw)) : 0
              counts[sessionId] = nextCount
              this.sessionMessageCountCache.set(sessionId, {
                count: nextCount,
                updatedAt: nowTs
              })
            }
          }
        }
      }

      returnedCounts = Object.keys(counts).length
      success = true
      return { success: true, counts }
    } catch (e) {
      console.error('ChatService: 批量获取会话消息总数失败:', e)
      errorMessage = String(e)
      return { success: false, error: String(e) }
    } finally {
      this.endExportDiagStep({
        traceId,
        stepId: 'backend-get-session-message-counts',
        stepName: 'ChatService.getSessionMessageCounts',
        startedAt: stepStartedAt,
        success,
        message: success ? '批量会话消息总数读取完成' : '批量会话消息总数读取失败',
        data: success ? { returnedCounts } : { error: errorMessage || '未知错误' }
      })
    }
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(options?: GetContactsOptions): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    const mode: 'lite' | 'full' = options?.lite ? 'lite' : 'full'
    const inFlight = this.contactsLoadInFlight
    if (inFlight && (inFlight.mode === mode || (mode === 'lite' && inFlight.mode === 'full'))) {
      return await inFlight.promise
    }

    const promise = this.getContactsInternal(options)
    this.contactsLoadInFlight = { mode, promise }
    try {
      return await promise
    } finally {
      if (this.contactsLoadInFlight?.promise === promise) {
        this.contactsLoadInFlight = null
      }
    }
  }

  private getContactsCacheScope(): string {
    const dbPath = String(this.configService.get('dbPath') || '').trim()
    const myWxid = String(this.configService.get('myWxid') || '').trim()
    return `${dbPath}::${myWxid}`
  }

  private cloneContacts(contacts: ContactInfo[]): ContactInfo[] {
    return (contacts || []).map((contact) => ({
      ...contact,
      labels: Array.isArray(contact.labels) ? [...contact.labels] : contact.labels
    }))
  }

  private getContactsFromMemoryCache(mode: 'lite' | 'full', scope: string): ContactInfo[] | null {
    const cached = this.contactsMemoryCache.get(mode)
    if (!cached) return null
    if (cached.scope !== scope) return null
    if (Date.now() - cached.updatedAt > this.contactsMemoryCacheTtlMs) return null
    return this.cloneContacts(cached.contacts)
  }

  private setContactsMemoryCache(mode: 'lite' | 'full', scope: string, contacts: ContactInfo[]): void {
    this.contactsMemoryCache.set(mode, {
      scope,
      updatedAt: Date.now(),
      contacts: this.cloneContacts(contacts)
    })
  }

  private async getContactsInternal(options?: GetContactsOptions): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    const isLiteMode = options?.lite === true
    const mode: 'lite' | 'full' = isLiteMode ? 'lite' : 'full'
    const cacheScope = this.getContactsCacheScope()
    const cachedContacts = this.getContactsFromMemoryCache(mode, cacheScope)
    if (cachedContacts) {
      return { success: true, contacts: cachedContacts }
    }
    if (isLiteMode) {
      const fullCachedContacts = this.getContactsFromMemoryCache('full', cacheScope)
      if (fullCachedContacts) {
        return { success: true, contacts: fullCachedContacts }
      }
    }

    const startedAt = Date.now()
    const stageDurations: Array<{ stage: string; ms: number }> = []
    const captureStage = (stage: string, stageStartedAt: number) => {
      stageDurations.push({ stage, ms: Date.now() - stageStartedAt })
    }

    try {
      const connectStartedAt = Date.now()
      const connectResult = await this.ensureConnected()
      captureStage('ensureConnected', connectStartedAt)
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const contactsCompactStartedAt = Date.now()
      const contactResult = await wcdbService.getContactsCompact()
      captureStage('getContactsCompact', contactsCompactStartedAt)

      if (!contactResult.success || !contactResult.contacts) {
        console.error('查询联系人失败:', contactResult.error)
        return { success: false, error: contactResult.error || '查询联系人失败' }
      }

      let rows = contactResult.contacts as Record<string, any>[]
      if (!isLiteMode) {
        const hydrateStartedAt = Date.now()
        rows = await this.hydrateContactsWithExtendedFields(rows)
        captureStage('hydrateContactsWithExtendedFields', hydrateStartedAt)
      }

      // 获取会话表的最后联系时间用于排序
      const sessionsStartedAt = Date.now()
      const lastContactTimeMap = new Map<string, number>()
      const sessionResult = await wcdbService.getSessions()
      captureStage('getSessions', sessionsStartedAt)
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
      const transformStartedAt = Date.now()
      const contacts: (ContactInfo & { lastContactTime: number })[] = []
      let contactLabelNameMap = new Map<number, string>()
      if (!isLiteMode) {
        const labelMapStartedAt = Date.now()
        contactLabelNameMap = await this.getContactLabelNameMap()
        captureStage('getContactLabelNameMap', labelMapStartedAt)
      }
      for (const row of rows) {
        const username = String(row.username || '').trim()

        if (!username) continue

        let type: 'friend' | 'group' | 'official' | 'former_friend' | 'other' = 'other'
        const localType = this.getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], 0)
        const quanPin = String(this.getRowField(row, ['quan_pin', 'quanPin', 'WCDB_CT_quan_pin']) || '').trim()

        if (username.endsWith('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (localType === 1 && !FRIEND_EXCLUDE_USERNAMES.has(username)) {
          type = 'friend'
        } else if (localType === 0 && quanPin) {
          type = 'former_friend'
        } else {
          continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username
        const labels = isLiteMode ? [] : this.parseContactLabels(row, contactLabelNameMap)
        const detailDescription = isLiteMode ? '' : this.getContactSignature(row)
        const region = isLiteMode ? '' : this.getContactRegion(row)

        contacts.push({
          username,
          displayName,
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          alias: row.alias || undefined,
          labels: labels.length > 0 ? labels : undefined,
          detailDescription: detailDescription || undefined,
          region: region || undefined,
          avatarUrl: undefined,
          type,
          lastContactTime: lastContactTimeMap.get(username) || 0
        })
      }
      captureStage('transformContacts', transformStartedAt)


      // 按最近联系时间排序
      const sortStartedAt = Date.now()
      contacts.sort((a, b) => {
        const timeA = a.lastContactTime || 0
        const timeB = b.lastContactTime || 0
        if (timeA && timeB) {
          return timeB - timeA
        }
        if (timeA && !timeB) return -1
        if (!timeA && timeB) return 1
        return this.contactDisplayNameCollator.compare(a.displayName, b.displayName)
      })
      captureStage('sortContacts', sortStartedAt)

      // 移除临时的lastContactTime字段
      const finalizeStartedAt = Date.now()
      const result = contacts.map(({ lastContactTime, ...rest }) => rest)
      captureStage('finalizeResult', finalizeStartedAt)

      const totalMs = Date.now() - startedAt
      if (totalMs >= this.slowGetContactsLogThresholdMs) {
        const stageSummary = stageDurations
          .map((item) => `${item.stage}=${item.ms}ms`)
          .join(', ')
        console.warn(`[ChatService] getContacts(${isLiteMode ? 'lite' : 'full'}) 慢查询 total=${totalMs}ms, ${stageSummary}`)
      }
      this.setContactsMemoryCache(mode, cacheScope, result)
      if (!isLiteMode) {
        this.setContactsMemoryCache('lite', cacheScope, result)
      }
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
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    let releaseMessageCursorMutex: (() => void) | null = null
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const batchSize = Math.max(1, limit || this.messageBatchDefault)

      // 使用互斥锁保护游标状态访问
      while (this.messageCursorMutex) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      this.messageCursorMutex = true
      let mutexReleased = false
      releaseMessageCursorMutex = () => {
        if (mutexReleased) return
        this.messageCursorMutex = false
        mutexReleased = true
      }

      let state = this.messageCursors.get(sessionId)

      // 只在以下情况重新创建游标:
      // 1. 没有游标状态
      // 2. offset 为 0 (重新加载会话)
      // 3. batchSize 改变
      // 4. startTime/endTime 改变（视为全新查询）
      // 5. ascending 改变
      const needNewCursor = !state ||
        offset !== state.fetched || // Offset mismatch -> must reset cursor
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
        // 注意：仅在 offset === 0 时重建游标最安全；
        // 当 startTime/endTime 变化导致重建时，offset 应由前端重置为 0
        state.bufferedMessages = []
        if (offset > 0) {
          console.warn(`[ChatService] 新游标需跳过 ${offset} 条消息（startTime=${startTime}, endTime=${endTime}）`)
          let skipped = 0
          const maxSkipAttempts = Math.ceil(offset / batchSize) + 5 // 防止无限循环
          let attempts = 0
          while (skipped < offset && attempts < maxSkipAttempts) {
            attempts++
            const skipBatch = await wcdbService.fetchMessageBatch(state.cursor)
            if (!skipBatch.success) {
              console.error('[ChatService] 跳过消息批次失败:', skipBatch.error)
              return { success: false, error: skipBatch.error || '跳过消息失败' }
            }
            if (!skipBatch.rows || skipBatch.rows.length === 0) {
              console.warn(`[ChatService] 跳过时数据耗尽: skipped=${skipped}/${offset}`)
              return { success: true, messages: [], hasMore: false, nextOffset: skipped }
            }

            const count = skipBatch.rows.length
            // Check if we overshot the offset
            if (skipped + count > offset) {
              const keepIndex = offset - skipped
              if (keepIndex < count) {
                state.bufferedMessages = skipBatch.rows.slice(keepIndex)
              }
            }

            skipped += count

            // If satisfied offset, break
            if (skipped >= offset) break;

            if (!skipBatch.hasMore) {
              console.warn(`[ChatService] 跳过后无更多数据: skipped=${skipped}/${offset}`)
              return { success: true, messages: [], hasMore: false, nextOffset: skipped }
            }
          }
          if (attempts >= maxSkipAttempts) {
            console.error(`[ChatService] 跳过消息超过最大尝试次数: attempts=${attempts}`)
          }
          state.fetched = offset
          console.log(`[ChatService] 跳过完成: skipped=${skipped}, fetched=${state.fetched}, buffered=${state.bufferedMessages?.length || 0}`)
        }
      }

      // 确保 state 已初始化
      if (!state) {
        console.error('[ChatService] 游标状态未初始化')
        return { success: false, error: '游标状态未初始化' }
      }

      const collected = await this.collectVisibleMessagesFromCursor(
        sessionId,
        state.cursor,
        limit,
        state.bufferedMessages as Record<string, any>[] | undefined
      )
      state.bufferedMessages = collected.bufferedRows
      if (!collected.success) {
        return { success: false, error: collected.error || '获取消息失败' }
      }

      const rawRowsConsumed = collected.rawRowsConsumed || 0
      const filtered = collected.messages || []
      const hasMore = collected.hasMore === true
      state.fetched += rawRowsConsumed
      releaseMessageCursorMutex?.()

      this.messageCacheService.set(sessionId, filtered)
      if (offset === 0 && startTime === 0 && endTime === 0) {
        this.markSyntheticUnreadRead(sessionId, filtered)
      }
      console.log(
        `[ChatService] getMessages session=${sessionId} rawRowsConsumed=${rawRowsConsumed} visibleMessagesReturned=${filtered.length} filteredOut=${collected.filteredOut || 0} nextOffset=${state.fetched} hasMore=${hasMore}`
      )
      return { success: true, messages: filtered, hasMore, nextOffset: state.fetched }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    } finally {
      releaseMessageCursorMutex?.()
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
      // 数据库未命中时，尝试从本地 emoji 缓存目录查找（转发的表情包只有 md5，无 CDN URL）
      this.findEmojiInLocalCache(msg)

    } catch (e) {
      console.error(`[ChatService] 恢复表情包失败: md5=${msg.emojiMd5}`, e)
    }
  }

  /**
   * 从本地 WeFlow emoji 缓存目录按 md5 查找文件
   */
  private findEmojiInLocalCache(msg: Message): void {
    if (!msg.emojiMd5) return
    const cacheDir = this.getEmojiCacheDir()
    if (!existsSync(cacheDir)) return

    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = join(cacheDir, `${msg.emojiMd5}${ext}`)
      if (existsSync(filePath)) {
        msg.emojiLocalPath = filePath
        // 同步写入内存缓存，避免重复查找
        emojiCache.set(msg.emojiMd5, filePath)
        return
      }
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


  async getLatestMessages(sessionId: string, limit: number = this.messageBatchDefault): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
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
        const collected = await this.collectVisibleMessagesFromCursor(sessionId, cursorResult.cursor, limit)
        if (!collected.success) {
          return { success: false, error: collected.error || '获取消息失败' }
        }
        console.log(
          `[ChatService] getLatestMessages session=${sessionId} rawRowsConsumed=${collected.rawRowsConsumed || 0} visibleMessagesReturned=${collected.messages?.length || 0} filteredOut=${collected.filteredOut || 0} nextOffset=${collected.rawRowsConsumed || 0} hasMore=${collected.hasMore === true}`
        )
        return {
          success: true,
          messages: collected.messages,
          hasMore: collected.hasMore,
          nextOffset: collected.rawRowsConsumed || 0
        }
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

  private encodeMessageKeySegment(value: unknown): string {
    const normalized = String(value ?? '').trim()
    return encodeURIComponent(normalized)
  }

  private getMessageSourceInfo(row: Record<string, any>): { dbName?: string; tableName?: string; dbPath?: string } {
    const dbPath = String(row._db_path || row.db_path || '').trim()
    const explicitDbName = String(row.db_name || '').trim()
    const tableName = String(row.table_name || '').trim()
    const dbName = explicitDbName || (dbPath ? basename(dbPath, extname(dbPath)) : '')
    return {
      dbName: dbName || undefined,
      tableName: tableName || undefined,
      dbPath: dbPath || undefined
    }
  }

  private buildMessageKey(input: {
    localId: number
    serverId: number
    createTime: number
    sortSeq: number
    senderUsername?: string | null
    localType: number
    dbName?: string
    tableName?: string
    dbPath?: string
  }): string {
    const localId = Number.isFinite(input.localId) ? Math.max(0, Math.floor(input.localId)) : 0
    const serverId = Number.isFinite(input.serverId) ? Math.max(0, Math.floor(input.serverId)) : 0
    const createTime = Number.isFinite(input.createTime) ? Math.max(0, Math.floor(input.createTime)) : 0
    const sortSeq = Number.isFinite(input.sortSeq) ? Math.max(0, Math.floor(input.sortSeq)) : 0
    const localType = Number.isFinite(input.localType) ? Math.floor(input.localType) : 0
    const senderUsername = this.encodeMessageKeySegment(input.senderUsername || '')
    const dbName = String(input.dbName || '').trim() || (input.dbPath ? basename(input.dbPath, extname(input.dbPath)) : '')
    const tableName = String(input.tableName || '').trim()

    if (localId > 0 && dbName && tableName) {
      return `${this.encodeMessageKeySegment(dbName)}:${this.encodeMessageKeySegment(tableName)}:${localId}`
    }

    if (serverId > 0) {
      return `server:${serverId}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
    }

    return `fallback:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
  }

  private isMessageVisibleForSession(sessionId: string, msg: Message): boolean {
    const isGroupChat = sessionId.includes('@chatroom')
    if (isGroupChat) {
      return true
    }
    if (!msg.senderUsername || msg.senderUsername === sessionId) {
      return true
    }
    if (msg.isSend === 1) {
      return true
    }
    console.warn(`[ChatService] 检测到异常消息: sessionId=${sessionId}, senderUsername=${msg.senderUsername}, localId=${msg.localId}`)
    return false
  }

  private async repairEmojiMessages(messages: Message[]): Promise<void> {
    const fixPromises: Promise<void>[] = []
    for (const msg of messages) {
      if (msg.localType === 47 && !msg.emojiCdnUrl && msg.emojiMd5) {
        fixPromises.push(this.fallbackEmoticon(msg))
      }
    }
    if (fixPromises.length > 0) {
      await Promise.allSettled(fixPromises)
    }
  }

  private async collectVisibleMessagesFromCursor(
    sessionId: string,
    cursor: number,
    limit: number,
    initialRows: Record<string, any>[] = []
  ): Promise<{
    success: boolean
    messages?: Message[]
    hasMore?: boolean
    error?: string
    rawRowsConsumed?: number
    filteredOut?: number
    bufferedRows?: Record<string, any>[]
  }> {
    const visibleMessages: Message[] = []
    let queuedRows = Array.isArray(initialRows) ? initialRows.slice() : []
    let rawRowsConsumed = 0
    let filteredOut = 0
    let cursorMayHaveMore = queuedRows.length > 0

    while (visibleMessages.length < limit) {
      if (queuedRows.length === 0) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) {
          console.error('[ChatService] 获取消息批次失败:', batch.error)
          if (visibleMessages.length === 0) {
            return { success: false, error: batch.error || '获取消息失败' }
          }
          cursorMayHaveMore = false
          break
        }

        const batchRows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        cursorMayHaveMore = batch.hasMore === true
        if (batchRows.length === 0) {
          break
        }
        queuedRows = batchRows
      }

      const rowsToProcess = queuedRows
      queuedRows = []
      const mappedMessages = this.mapRowsToMessages(rowsToProcess)
      for (let index = 0; index < mappedMessages.length; index += 1) {
        const msg = mappedMessages[index]
        rawRowsConsumed += 1
        if (this.isMessageVisibleForSession(sessionId, msg)) {
          visibleMessages.push(msg)
          if (visibleMessages.length >= limit) {
            if (index + 1 < rowsToProcess.length) {
              queuedRows = rowsToProcess.slice(index + 1)
            }
            break
          }
        } else {
          filteredOut += 1
        }
      }

      if (visibleMessages.length >= limit) {
        break
      }

      if (!cursorMayHaveMore) {
        break
      }
    }

    if (filteredOut > 0) {
      console.warn(`[ChatService] 过滤了 ${filteredOut} 条异常消息`)
    }

    const normalized = this.normalizeMessageOrder(visibleMessages)
    await this.repairEmojiMessages(normalized)
    return {
      success: true,
      messages: normalized,
      hasMore: queuedRows.length > 0 || cursorMayHaveMore,
      rawRowsConsumed,
      filteredOut,
      bufferedRows: queuedRows.length > 0 ? queuedRows : undefined
    }
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

  private hasAnyContactExtendedFieldKey(row: Record<string, any>): boolean {
    for (const key of Object.keys(row || {})) {
      if (this.contactExtendedFieldCandidateSet.has(String(key || '').toLowerCase())) {
        return true
      }
    }
    return false
  }

  private async hydrateContactsWithExtendedFields(rows: Record<string, any>[]): Promise<Record<string, any>[]> {
    if (!Array.isArray(rows) || rows.length === 0) return rows
    const hasAnyExtendedFieldKey = rows.some((row) => this.hasAnyContactExtendedFieldKey(row || {}))
    if (hasAnyExtendedFieldKey) {
      // wcdb_get_contacts_compact 可能只给“部分联系人”返回 extra_buffer。
      // 只有在每一行都能拿到可解析的 extra_buffer 时才跳过补偿查询。
      const allRowsHaveUsableExtraBuffer = rows.every((row) => this.toExtraBufferBytes(row || {}) !== null)
      if (allRowsHaveUsableExtraBuffer) return rows
    }

    try {
      let selectableColumns = this.contactExtendedSelectableColumns
      if (!selectableColumns) {
        const tableInfoResult = await wcdbService.execQuery('contact', null, 'PRAGMA table_info(contact)')
        if (!tableInfoResult.success || !Array.isArray(tableInfoResult.rows)) {
          return rows
        }

        const availableColumns = new Map<string, string>()
        for (const tableInfoRow of tableInfoResult.rows as Record<string, any>[]) {
          const rawName = tableInfoRow.name ?? tableInfoRow.column_name ?? tableInfoRow.columnName
          const name = String(rawName || '').trim()
          if (!name) continue
          availableColumns.set(name.toLowerCase(), name)
        }

        const resolvedColumns: string[] = []
        const seenColumns = new Set<string>()
        for (const candidate of this.contactExtendedFieldCandidates) {
          const actual = availableColumns.get(candidate.toLowerCase())
          if (!actual) continue
          const normalized = actual.toLowerCase()
          if (seenColumns.has(normalized)) continue
          seenColumns.add(normalized)
          resolvedColumns.push(actual)
        }

        this.contactExtendedSelectableColumns = resolvedColumns
        selectableColumns = resolvedColumns
      }

      if (selectableColumns.length === 0) return rows

      const selectColumns = ['username', ...selectableColumns]
      const sql = `SELECT ${selectColumns.map((column) => this.quoteSqlIdentifier(column)).join(', ')} FROM contact WHERE username IS NOT NULL AND username != ''`
      const extendedResult = await wcdbService.execQuery('contact', null, sql)
      if (!extendedResult.success || !Array.isArray(extendedResult.rows) || extendedResult.rows.length === 0) {
        return rows
      }

      const extendedByUsername = new Map<string, Record<string, any>>()
      for (const extendedRow of extendedResult.rows as Record<string, any>[]) {
        const username = String(extendedRow.username || '').trim()
        if (!username) continue
        extendedByUsername.set(username, extendedRow)
      }
      if (extendedByUsername.size === 0) return rows

      return rows.map((row) => {
        const username = String(row.username || row.user_name || row.userName || '').trim()
        if (!username) return row
        const extended = extendedByUsername.get(username)
        if (!extended) return row
        return {
          ...extended,
          ...row
        }
      })
    } catch (error) {
      console.warn('联系人扩展字段补偿查询失败:', error)
      return rows
    }
  }

  private async getContactLabelNameMap(): Promise<Map<number, string>> {
    const now = Date.now()
    if (this.contactLabelNameMapCache && now - this.contactLabelNameMapCacheAt <= this.contactLabelNameMapCacheTtlMs) {
      return new Map(this.contactLabelNameMapCache)
    }

    const labelMap = new Map<number, string>()
    try {
      const tableInfoResult = await wcdbService.execQuery('contact', null, 'PRAGMA table_info(contact_label)')
      if (!tableInfoResult.success || !Array.isArray(tableInfoResult.rows) || tableInfoResult.rows.length === 0) {
        this.contactLabelNameMapCache = labelMap
        this.contactLabelNameMapCacheAt = now
        return labelMap
      }

      const availableColumns = new Map<string, string>()
      for (const tableInfoRow of tableInfoResult.rows as Record<string, any>[]) {
        const rawName = tableInfoRow.name ?? tableInfoRow.column_name ?? tableInfoRow.columnName
        const name = String(rawName || '').trim()
        if (!name) continue
        availableColumns.set(name.toLowerCase(), name)
      }

      const pickColumn = (candidates: string[]): string | null => {
        for (const candidate of candidates) {
          const actual = availableColumns.get(candidate.toLowerCase())
          if (actual) return actual
        }
        return null
      }

      const idColumn = pickColumn(['label_id_', 'label_id', 'labelId', 'labelid', 'id'])
      const nameColumn = pickColumn(['label_name_', 'label_name', 'labelName', 'labelname', 'name'])
      if (!idColumn || !nameColumn) {
        this.contactLabelNameMapCache = labelMap
        this.contactLabelNameMapCacheAt = now
        return labelMap
      }

      const sql = `SELECT ${this.quoteSqlIdentifier(idColumn)} AS label_id, ${this.quoteSqlIdentifier(nameColumn)} AS label_name FROM contact_label`
      const result = await wcdbService.execQuery('contact', null, sql)
      if (result.success && Array.isArray(result.rows)) {
        for (const row of result.rows as Record<string, any>[]) {
          const id = Number(String(row.label_id ?? row.labelId ?? '').trim())
          const name = String(row.label_name ?? row.labelName ?? '').trim()
          if (Number.isFinite(id) && id > 0 && name) {
            labelMap.set(Math.floor(id), name)
          }
        }
      }
    } catch (error) {
      console.warn('读取 contact_label 失败:', error)
    }

    this.contactLabelNameMapCache = labelMap
    this.contactLabelNameMapCacheAt = now
    return new Map(labelMap)
  }

  private toExtraBufferBytes(row: Record<string, any>): Buffer | null {
    const raw = this.getRowField(row, ['extra_buffer', 'extraBuffer'])
    if (raw === undefined || raw === null) return null
    if (Buffer.isBuffer(raw)) return raw.length > 0 ? raw : null
    if (raw instanceof Uint8Array) return raw.length > 0 ? Buffer.from(raw) : null
    if (Array.isArray(raw)) {
      const bytes = Buffer.from(raw)
      return bytes.length > 0 ? bytes : null
    }

    const text = String(raw || '').trim()
    if (!text) return null
    const compact = text.replace(/\s+/g, '')
    if (compact.length >= 2 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact)) {
      try {
        const bytes = Buffer.from(compact, 'hex')
        return bytes.length > 0 ? bytes : null
      } catch {
        return null
      }
    }
    return null
  }

  private readProtoVarint(buffer: Buffer, offset: number): { value: number; nextOffset: number } | null {
    if (!buffer || offset < 0 || offset >= buffer.length) return null
    let value = 0
    let shift = 0
    let index = offset
    while (index < buffer.length) {
      const byte = buffer[index]
      index += 1
      value += (byte & 0x7f) * Math.pow(2, shift)
      if ((byte & 0x80) === 0) {
        return { value, nextOffset: index }
      }
      shift += 7
      if (shift > 56) return null
    }
    return null
  }

  private extractExtraBufferTopLevelFieldStrings(row: Record<string, any>, targetField: number): string[] {
    const bytes = this.toExtraBufferBytes(row)
    if (!bytes || !Number.isFinite(targetField) || targetField <= 0) return []
    const values: string[] = []
    let offset = 0
    while (offset < bytes.length) {
      const tagResult = this.readProtoVarint(bytes, offset)
      if (!tagResult) break
      offset = tagResult.nextOffset
      const fieldNumber = Math.floor(tagResult.value / 8)
      const wireType = tagResult.value & 0x07

      if (wireType === 0) {
        const varint = this.readProtoVarint(bytes, offset)
        if (!varint) break
        offset = varint.nextOffset
        continue
      }

      if (wireType === 1) {
        if (offset + 8 > bytes.length) break
        offset += 8
        continue
      }

      if (wireType === 2) {
        const lengthResult = this.readProtoVarint(bytes, offset)
        if (!lengthResult) break
        const payloadLength = Math.floor(lengthResult.value)
        offset = lengthResult.nextOffset
        if (payloadLength < 0 || offset + payloadLength > bytes.length) break
        const payload = bytes.subarray(offset, offset + payloadLength)
        offset += payloadLength
        if (fieldNumber === targetField) {
          const text = payload.toString('utf-8').replace(/\u0000/g, '').trim()
          if (text) values.push(text)
        }
        continue
      }

      if (wireType === 5) {
        if (offset + 4 > bytes.length) break
        offset += 4
        continue
      }

      break
    }
    return values
  }

  private parseContactLabelsFromExtraBuffer(row: Record<string, any>, labelNameMap?: Map<number, string>): string[] {
    const labelNames: string[] = []
    const seen = new Set<string>()
    const texts = this.extractExtraBufferTopLevelFieldStrings(row, 30)
    for (const text of texts) {
      const matches = text.match(/\d+/g) || []
      for (const match of matches) {
        const id = Number(match)
        if (!Number.isFinite(id) || id <= 0) continue
        const labelName = labelNameMap?.get(Math.floor(id))
        if (!labelName) continue
        if (seen.has(labelName)) continue
        seen.add(labelName)
        labelNames.push(labelName)
      }
    }
    return labelNames
  }

  private parseContactLabels(row: Record<string, any>, labelNameMap?: Map<number, string>): string[] {
    const raw = this.getRowField(row, [
      'label_list', 'labelList', 'labels', 'label_names', 'labelNames', 'tags', 'tag_list', 'tagList'
    ])
    const normalizedFromValue = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
      }
      const text = String(value || '').trim()
      if (!text) return []
      return Array.from(new Set(
        text
          .replace(/[；;、|]+/g, ',')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      ))
    }

    const direct = normalizedFromValue(raw)
    if (direct.length > 0) return direct

    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.toLowerCase()
      if (!normalizedKey.includes('label') && !normalizedKey.includes('tag')) continue
      if (normalizedKey.includes('img') || normalizedKey.includes('head')) continue
      const fallback = normalizedFromValue(value)
      if (fallback.length > 0) return fallback
    }

    const extraBufferLabels = this.parseContactLabelsFromExtraBuffer(row, labelNameMap)
    if (extraBufferLabels.length > 0) return extraBufferLabels

    return []
  }

  private getContactSignature(row: Record<string, any>): string {
    const normalize = (raw: unknown): string => {
      const text = String(raw || '').replace(/\u0000/g, '').trim()
      if (!text) return ''
      const lower = text.toLowerCase()
      if (lower === '-' || lower === '--' || lower === '—' || lower === 'null' || lower === 'undefined' || lower === 'none') {
        return ''
      }
      return text
    }

    const value = this.getRowField(row, [
      'signature', 'sign', 'personal_signature', 'personalSignature', 'profile', 'introduction',
      'detail_description', 'detailDescription', 'description', 'desc', 'contact_description', 'contactDescription'
    ])
    const direct = normalize(value)
    if (direct) return direct

    for (const [key, rawValue] of Object.entries(row)) {
      const normalizedKey = key.toLowerCase()
      const isCandidate =
        normalizedKey.includes('sign') ||
        normalizedKey.includes('signature') ||
        normalizedKey.includes('profile') ||
        normalizedKey.includes('intro') ||
        normalizedKey.includes('description') ||
        normalizedKey.includes('detail') ||
        normalizedKey.includes('desc')
      if (!isCandidate) continue
      if (
        normalizedKey.includes('avatar') ||
        normalizedKey.includes('img') ||
        normalizedKey.includes('head') ||
        normalizedKey.includes('label') ||
        normalizedKey.includes('tag')
      ) continue
      const text = normalize(rawValue)
      if (text) return text
    }

    // contact.extra_buffer field 4: 个性签名兜底
    const signatures = this.extractExtraBufferTopLevelFieldStrings(row, 4)
    for (const signature of signatures) {
      const text = normalize(signature)
      if (!text) continue
      return text
    }

    return ''
  }

  private normalizeContactRegionPart(raw: unknown): string {
    const text = String(raw || '').replace(/\u0000/g, '').trim()
    if (!text) return ''
    const lower = text.toLowerCase()
    if (lower === '-' || lower === '--' || lower === '—' || lower === 'null' || lower === 'undefined' || lower === 'none') {
      return ''
    }
    return text
  }

  private normalizeRegionLookupKey(raw: string): string {
    return String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
  }

  private buildRegionLookupCandidates(raw: string): string[] {
    const normalized = this.normalizeRegionLookupKey(raw)
    if (!normalized) return []

    const candidates = new Set<string>([normalized])
    const withoutTrailingDigits = normalized.replace(/\d+$/g, '')
    if (withoutTrailingDigits) candidates.add(withoutTrailingDigits)

    return Array.from(candidates)
  }

  private normalizeChineseProvinceName(raw: string): string {
    const text = String(raw || '').trim()
    if (!text) return ''
    return text
      .replace(/特别行政区$/g, '')
      .replace(/维吾尔自治区$/g, '')
      .replace(/壮族自治区$/g, '')
      .replace(/回族自治区$/g, '')
      .replace(/自治区$/g, '')
      .replace(/省$/g, '')
      .replace(/市$/g, '')
      .trim()
  }

  private normalizeChineseCityName(raw: string): string {
    const text = String(raw || '').trim()
    if (!text) return ''
    return text
      .replace(/特别行政区$/g, '')
      .replace(/自治州$/g, '')
      .replace(/地区$/g, '')
      .replace(/盟$/g, '')
      .replace(/林区$/g, '')
      .replace(/市$/g, '')
      .trim()
  }

  private resolveProvinceLookupKey(raw: string): string {
    const candidates = this.buildRegionLookupCandidates(raw)
    if (candidates.length === 0) return ''

    for (const candidate of candidates) {
      const byName = CONTACT_REGION_LOOKUP_DATA.provinceKeyByName[candidate]
      if (byName) return byName
      if (CONTACT_REGION_LOOKUP_DATA.provinceNameByKey[candidate]) return candidate
    }

    return candidates[0]
  }

  private toChineseCountryName(raw: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''

    const candidates = this.buildRegionLookupCandidates(text)
    for (const candidate of candidates) {
      const mapped = CONTACT_REGION_LOOKUP_DATA.countryNameByKey[candidate]
      if (mapped) return mapped
    }
    return text
  }

  private toChineseProvinceName(raw: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''

    const candidates = this.buildRegionLookupCandidates(text)
    if (candidates.length === 0) return text
    const provinceKey = this.resolveProvinceLookupKey(text)
    const mappedFromCandidates = candidates
      .map((candidate) => CONTACT_REGION_LOOKUP_DATA.provinceNameByKey[candidate])
      .find(Boolean)
    const mapped = CONTACT_REGION_LOOKUP_DATA.provinceNameByKey[provinceKey] || mappedFromCandidates
    if (mapped) return mapped

    if (/[\u4e00-\u9fa5]/.test(text)) {
      return this.normalizeChineseProvinceName(text) || text
    }

    return text
  }

  private toChineseCityName(raw: string, provinceRaw?: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''

    const candidates = this.buildRegionLookupCandidates(text)
    if (candidates.length === 0) return text

    const provinceKey = this.resolveProvinceLookupKey(String(provinceRaw || ''))
    if (provinceKey) {
      const byProvince = CONTACT_REGION_LOOKUP_DATA.cityNameByProvinceKey[provinceKey]
      if (byProvince) {
        for (const candidate of candidates) {
          const mappedInProvince = byProvince[candidate]
          if (mappedInProvince) return mappedInProvince
        }
      }
    }

    for (const candidate of candidates) {
      const mapped = CONTACT_REGION_LOOKUP_DATA.cityNameByKey[candidate]
      if (mapped) return mapped
    }

    if (/[\u4e00-\u9fa5]/.test(text)) {
      return this.normalizeChineseCityName(text) || text
    }

    return text
  }

  private toChineseRegionText(raw: string): string {
    const text = this.normalizeContactRegionPart(raw)
    if (!text) return ''
    const tokens = text
      .split(/[\s,，、/|·]+/)
      .map((item) => this.normalizeContactRegionPart(item))
      .filter(Boolean)
    if (tokens.length === 0) return text

    let provinceContext = ''
    const mapped = tokens.map((token) => {
      const country = this.toChineseCountryName(token)
      if (country !== token) return country

      const province = this.toChineseProvinceName(token)
      if (province !== token) {
        provinceContext = province
        return province
      }

      const city = this.toChineseCityName(token, provinceContext)
      if (city !== token) return city

      return token
    })
    return mapped.join(' ').trim()
  }

  private shouldHideCountryInRegion(country: string, hasProvinceOrCity: boolean): boolean {
    if (!country) return true
    const normalized = country.toLowerCase()
    if (normalized === 'cn' || normalized === 'chn' || normalized === 'china' || normalized === '中国') {
      return hasProvinceOrCity
    }
    return false
  }

  private getContactRegion(row: Record<string, any>): string {
    const pickByTokens = (tokens: string[]): string => {
      for (const [key, value] of Object.entries(row || {})) {
        const normalizedKey = String(key || '').toLowerCase()
        if (!normalizedKey) continue
        if (normalizedKey.includes('avatar') || normalizedKey.includes('img') || normalizedKey.includes('head')) continue
        if (!tokens.some((token) => normalizedKey.includes(token))) continue
        const text = this.normalizeContactRegionPart(value)
        if (text) return text
      }
      return ''
    }

    const directCountry = this.normalizeContactRegionPart(this.getRowField(row, ['country', 'Country'])) || pickByTokens(['country'])
    const directProvince = this.normalizeContactRegionPart(this.getRowField(row, ['province', 'Province'])) || pickByTokens(['province'])
    const directCity = this.normalizeContactRegionPart(this.getRowField(row, ['city', 'City'])) || pickByTokens(['city'])
    const directRegion =
      this.normalizeContactRegionPart(this.getRowField(row, ['region', 'Region', 'location', 'area'])) ||
      pickByTokens(['region', 'location', 'area', 'addr', 'address'])

    if (directRegion) {
      const normalizedRegion = this.toChineseRegionText(directRegion)
      const parts = normalizedRegion
        .split(/\s+/)
        .map((item) => this.normalizeContactRegionPart(item))
        .filter(Boolean)
      if (parts.length > 1 && this.shouldHideCountryInRegion(parts[0], true)) {
        return parts.slice(1).join(' ').trim()
      }
      return normalizedRegion
    }

    const fallbackCountry = this.normalizeContactRegionPart(this.extractExtraBufferTopLevelFieldStrings(row, 5)[0] || '')
    const fallbackProvince = this.normalizeContactRegionPart(this.extractExtraBufferTopLevelFieldStrings(row, 6)[0] || '')
    const fallbackCity = this.normalizeContactRegionPart(this.extractExtraBufferTopLevelFieldStrings(row, 7)[0] || '')

    const country = this.toChineseCountryName(directCountry || fallbackCountry)
    const province = this.toChineseProvinceName(directProvince || fallbackProvince)
    const city = this.toChineseCityName(directCity || fallbackCity, directProvince || fallbackProvince)

    const hasProvinceOrCity = Boolean(province || city)
    const parts: string[] = []
    if (!this.shouldHideCountryInRegion(country, hasProvinceOrCity)) {
      parts.push(country)
    }
    if (province) {
      parts.push(province)
    }
    if (city && city !== province) {
      parts.push(city)
    }

    return parts.join(' ').trim()
  }

  private normalizeUnsignedIntegerToken(raw: any): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined

    if (typeof raw === 'bigint') {
      return raw >= 0n ? raw.toString() : '0'
    }

    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return undefined
      return String(Math.max(0, Math.floor(raw)))
    }

    if (Buffer.isBuffer(raw)) {
      return this.normalizeUnsignedIntegerToken(raw.toString('utf-8').trim())
    }
    if (raw instanceof Uint8Array) {
      return this.normalizeUnsignedIntegerToken(Buffer.from(raw).toString('utf-8').trim())
    }
    if (Array.isArray(raw)) {
      return this.normalizeUnsignedIntegerToken(Buffer.from(raw).toString('utf-8').trim())
    }

    if (typeof raw === 'object') {
      if ('value' in raw) return this.normalizeUnsignedIntegerToken(raw.value)
      if ('intValue' in raw) return this.normalizeUnsignedIntegerToken(raw.intValue)
      if ('low' in raw && 'high' in raw) {
        try {
          const low = BigInt(raw.low >>> 0)
          const high = BigInt(raw.high >>> 0)
          const value = (high << 32n) + low
          return value >= 0n ? value.toString() : '0'
        } catch {
          return undefined
        }
      }
      const text = raw.toString ? String(raw).trim() : ''
      if (text && text !== '[object Object]') {
        return this.normalizeUnsignedIntegerToken(text)
      }
      return undefined
    }

    const text = String(raw).trim()
    if (!text) return undefined
    if (/^\d+$/.test(text)) {
      return text.replace(/^0+(?=\d)/, '') || '0'
    }
    if (/^[+-]?\d+$/.test(text)) {
      try {
        const value = BigInt(text)
        return value >= 0n ? value.toString() : '0'
      } catch {
        return undefined
      }
    }

    const parsed = Number(text)
    if (Number.isFinite(parsed)) {
      return String(Math.max(0, Math.floor(parsed)))
    }
    return undefined
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

  private buildIdentityKeys(raw: string): string[] {
    const value = String(raw || '').trim()
    if (!value) return []
    const lowerRaw = value.toLowerCase()
    const cleaned = this.cleanAccountDirName(value).toLowerCase()
    if (cleaned && cleaned !== lowerRaw) {
      return [cleaned, lowerRaw]
    }
    return [lowerRaw]
  }

  private resolveMessageIsSend(rawIsSend: number | null, senderUsername?: string | null): {
    isSend: number | null
    selfMatched: boolean
    correctedBySelfIdentity: boolean
  } {
    const normalizedRawIsSend = Number.isFinite(rawIsSend as number) ? rawIsSend : null
    const senderKeys = this.buildIdentityKeys(String(senderUsername || ''))
    if (senderKeys.length === 0) {
      return {
        isSend: normalizedRawIsSend,
        selfMatched: false,
        correctedBySelfIdentity: false
      }
    }

    const myWxid = String(this.configService.get('myWxid') || '').trim()
    const selfKeys = this.buildIdentityKeys(myWxid)
    if (selfKeys.length === 0) {
      return {
        isSend: normalizedRawIsSend,
        selfMatched: false,
        correctedBySelfIdentity: false
      }
    }

    const selfMatched = senderKeys.some(senderKey =>
      selfKeys.some(selfKey =>
        senderKey === selfKey ||
        senderKey.startsWith(selfKey + '_') ||
        selfKey.startsWith(senderKey + '_')
      )
    )

    if (selfMatched && normalizedRawIsSend !== 1) {
      return {
        isSend: 1,
        selfMatched: true,
        correctedBySelfIdentity: true
      }
    }

    if (normalizedRawIsSend === null) {
      return {
        isSend: selfMatched ? 1 : 0,
        selfMatched,
        correctedBySelfIdentity: false
      }
    }

    return {
      isSend: normalizedRawIsSend,
      selfMatched,
      correctedBySelfIdentity: false
    }
  }

  private extractGroupMemberUsername(member: any): string {
    if (!member) return ''
    if (typeof member === 'string') return member.trim()
    return String(
      member.username ||
      member.userName ||
      member.user_name ||
      member.encryptUsername ||
      member.encryptUserName ||
      member.encrypt_username ||
      member.originalName ||
      ''
    ).trim()
  }

  private async getFriendIdentitySet(): Promise<Set<string>> {
    const identities = new Set<string>()
    const contactResult = await wcdbService.getContactsCompact()
    if (!contactResult.success || !contactResult.contacts) {
      return identities
    }

    for (const rowAny of contactResult.contacts) {
      const row = rowAny as Record<string, any>
      const username = String(row.username || '').trim()
      if (!username || username.includes('@chatroom') || username.startsWith('gh_')) continue
      if (FRIEND_EXCLUDE_USERNAMES.has(username)) continue

      const localType = this.getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], 0)
      if (localType !== 1) continue

      for (const key of this.buildIdentityKeys(username)) {
        identities.add(key)
      }
    }
    return identities
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
    const myWxid = String(this.configService.get('myWxid') || '')
    const scope = `${dbPath}::${myWxid}`
    if (scope === this.sessionMessageCountCacheScope) {
      this.refreshSessionStatsCacheScope(scope)
      this.refreshGroupMyMessageCountCacheScope(scope)
      return
    }
    this.sessionMessageCountCacheScope = scope
    this.sessionMessageCountCache.clear()
    this.sessionMessageCountHintCache.clear()
    this.sessionMessageCountBatchCache = null
    this.sessionDetailFastCache.clear()
    this.sessionDetailExtraCache.clear()
    this.sessionStatusCache.clear()
    this.sessionTablesCache.clear()
    this.messageTableColumnsCache.clear()
    this.messageDbCountSnapshotCache = null
    this.contactsMemoryCache.clear()
    this.refreshSessionStatsCacheScope(scope)
    this.refreshGroupMyMessageCountCacheScope(scope)
  }

  private refreshGroupMyMessageCountCacheScope(scope: string): void {
    if (scope === this.groupMyMessageCountCacheScope) return
    this.groupMyMessageCountCacheScope = scope
    this.groupMyMessageCountMemoryCache.clear()
  }

  private refreshSessionStatsCacheScope(scope: string): void {
    if (scope === this.sessionStatsCacheScope) return
    this.sessionStatsCacheScope = scope
    this.sessionStatsMemoryCache.clear()
    this.sessionStatsPendingBasic.clear()
    this.sessionStatsPendingFull.clear()
    this.allGroupSessionIdsCache = null
  }

  private buildScopedSessionStatsKey(sessionId: string): string {
    return `${this.sessionStatsCacheScope}::${sessionId}`
  }

  private buildScopedGroupMyMessageCountKey(chatroomId: string): string {
    return `${this.groupMyMessageCountCacheScope}::${chatroomId}`
  }

  private getGroupMyMessageCountHintEntry(
    chatroomId: string
  ): { entry: GroupMyMessageCountCacheEntry; source: 'memory' | 'disk' } | null {
    const scopedKey = this.buildScopedGroupMyMessageCountKey(chatroomId)
    const inMemory = this.groupMyMessageCountMemoryCache.get(scopedKey)
    if (inMemory) {
      return { entry: inMemory, source: 'memory' }
    }

    const persisted = this.groupMyMessageCountCacheService.get(this.groupMyMessageCountCacheScope, chatroomId)
    if (!persisted) return null
    this.groupMyMessageCountMemoryCache.set(scopedKey, persisted)
    return { entry: persisted, source: 'disk' }
  }

  private setGroupMyMessageCountHintEntry(chatroomId: string, messageCount: number, updatedAt?: number): number {
    const nextCount = Number.isFinite(messageCount) ? Math.max(0, Math.floor(messageCount)) : 0
    const nextUpdatedAt = Number.isFinite(updatedAt) ? Math.max(0, Math.floor(updatedAt as number)) : Date.now()
    const scopedKey = this.buildScopedGroupMyMessageCountKey(chatroomId)
    const existing = this.groupMyMessageCountMemoryCache.get(scopedKey)
    if (existing && existing.updatedAt > nextUpdatedAt) {
      return existing.updatedAt
    }

    const entry: GroupMyMessageCountCacheEntry = {
      updatedAt: nextUpdatedAt,
      messageCount: nextCount
    }
    this.groupMyMessageCountMemoryCache.set(scopedKey, entry)
    this.groupMyMessageCountCacheService.set(this.groupMyMessageCountCacheScope, chatroomId, entry)
    return nextUpdatedAt
  }

  private toSessionStatsCacheStats(stats: ExportSessionStats): SessionStatsCacheStats {
    const normalized: SessionStatsCacheStats = {
      totalMessages: Number.isFinite(stats.totalMessages) ? Math.max(0, Math.floor(stats.totalMessages)) : 0,
      voiceMessages: Number.isFinite(stats.voiceMessages) ? Math.max(0, Math.floor(stats.voiceMessages)) : 0,
      imageMessages: Number.isFinite(stats.imageMessages) ? Math.max(0, Math.floor(stats.imageMessages)) : 0,
      videoMessages: Number.isFinite(stats.videoMessages) ? Math.max(0, Math.floor(stats.videoMessages)) : 0,
      emojiMessages: Number.isFinite(stats.emojiMessages) ? Math.max(0, Math.floor(stats.emojiMessages)) : 0,
      transferMessages: Number.isFinite(stats.transferMessages) ? Math.max(0, Math.floor(stats.transferMessages)) : 0,
      redPacketMessages: Number.isFinite(stats.redPacketMessages) ? Math.max(0, Math.floor(stats.redPacketMessages)) : 0,
      callMessages: Number.isFinite(stats.callMessages) ? Math.max(0, Math.floor(stats.callMessages)) : 0
    }

    if (Number.isFinite(stats.firstTimestamp)) normalized.firstTimestamp = Math.max(0, Math.floor(stats.firstTimestamp as number))
    if (Number.isFinite(stats.lastTimestamp)) normalized.lastTimestamp = Math.max(0, Math.floor(stats.lastTimestamp as number))
    if (Number.isFinite(stats.privateMutualGroups)) normalized.privateMutualGroups = Math.max(0, Math.floor(stats.privateMutualGroups as number))
    if (Number.isFinite(stats.groupMemberCount)) normalized.groupMemberCount = Math.max(0, Math.floor(stats.groupMemberCount as number))
    if (Number.isFinite(stats.groupMyMessages)) normalized.groupMyMessages = Math.max(0, Math.floor(stats.groupMyMessages as number))
    if (Number.isFinite(stats.groupActiveSpeakers)) normalized.groupActiveSpeakers = Math.max(0, Math.floor(stats.groupActiveSpeakers as number))
    if (Number.isFinite(stats.groupMutualFriends)) normalized.groupMutualFriends = Math.max(0, Math.floor(stats.groupMutualFriends as number))

    return normalized
  }

  private fromSessionStatsCacheStats(stats: SessionStatsCacheStats): ExportSessionStats {
    return {
      totalMessages: stats.totalMessages,
      voiceMessages: stats.voiceMessages,
      imageMessages: stats.imageMessages,
      videoMessages: stats.videoMessages,
      emojiMessages: stats.emojiMessages,
      transferMessages: stats.transferMessages,
      redPacketMessages: stats.redPacketMessages,
      callMessages: stats.callMessages,
      firstTimestamp: stats.firstTimestamp,
      lastTimestamp: stats.lastTimestamp,
      privateMutualGroups: stats.privateMutualGroups,
      groupMemberCount: stats.groupMemberCount,
      groupMyMessages: stats.groupMyMessages,
      groupActiveSpeakers: stats.groupActiveSpeakers,
      groupMutualFriends: stats.groupMutualFriends
    }
  }

  private supportsRequestedRelation(entry: SessionStatsCacheEntry, includeRelations: boolean): boolean {
    if (!includeRelations) return true
    return entry.includeRelations
  }

  private getSessionStatsCacheEntry(sessionId: string): { entry: SessionStatsCacheEntry; source: 'memory' | 'disk' } | null {
    const scopedKey = this.buildScopedSessionStatsKey(sessionId)
    const inMemory = this.sessionStatsMemoryCache.get(scopedKey)
    if (inMemory) {
      return { entry: inMemory, source: 'memory' }
    }

    const persisted = this.sessionStatsCacheService.get(this.sessionStatsCacheScope, sessionId)
    if (!persisted) return null
    this.sessionStatsMemoryCache.set(scopedKey, persisted)
    return { entry: persisted, source: 'disk' }
  }

  private setSessionStatsCacheEntry(sessionId: string, stats: ExportSessionStats, includeRelations: boolean): number {
    const updatedAt = Date.now()
    const normalizedStats = this.toSessionStatsCacheStats(stats)
    const entry: SessionStatsCacheEntry = {
      updatedAt,
      includeRelations,
      stats: normalizedStats
    }
    const scopedKey = this.buildScopedSessionStatsKey(sessionId)
    this.sessionStatsMemoryCache.set(scopedKey, entry)
    this.sessionStatsCacheService.set(this.sessionStatsCacheScope, sessionId, entry)
    if (sessionId.endsWith('@chatroom') && Number.isFinite(normalizedStats.groupMyMessages)) {
      this.setGroupMyMessageCountHintEntry(sessionId, normalizedStats.groupMyMessages as number, updatedAt)
    }
    return updatedAt
  }

  private deleteSessionStatsCacheEntry(sessionId: string): void {
    const scopedKey = this.buildScopedSessionStatsKey(sessionId)
    this.sessionStatsMemoryCache.delete(scopedKey)
    this.sessionStatsPendingBasic.delete(scopedKey)
    this.sessionStatsPendingFull.delete(scopedKey)
    this.sessionStatsCacheService.delete(this.sessionStatsCacheScope, sessionId)
  }

  private clearSessionStatsCacheForScope(): void {
    this.sessionStatsMemoryCache.clear()
    this.sessionStatsPendingBasic.clear()
    this.sessionStatsPendingFull.clear()
    this.allGroupSessionIdsCache = null
    this.sessionStatsCacheService.clearScope(this.sessionStatsCacheScope)
  }

  private collectSessionIdsFromPayload(payload: unknown): Set<string> {
    const ids = new Set<string>()
    const walk = (value: unknown, keyHint?: string) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, keyHint)
        return
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          walk(v, k)
        }
        return
      }
      if (typeof value !== 'string') return
      const normalized = value.trim()
      if (!normalized) return
      const lowerKey = String(keyHint || '').toLowerCase()
      const keyLooksLikeSession = (
        lowerKey.includes('session') ||
        lowerKey.includes('talker') ||
        lowerKey.includes('username') ||
        lowerKey.includes('chatroom')
      )
      if (!keyLooksLikeSession && !normalized.includes('@chatroom')) {
        return
      }
      ids.add(normalized)
    }
    walk(payload)
    return ids
  }

  private handleSessionStatsMonitorChange(type: string, json: string): void {
    this.refreshSessionMessageCountCacheScope()
    if (!this.sessionStatsCacheScope) return

    const normalizedType = String(type || '').toLowerCase()
    if (
      normalizedType.includes('message') ||
      normalizedType.includes('session') ||
      normalizedType.includes('db')
    ) {
      this.messageDbCountSnapshotCache = null
    }
    const maybeJson = String(json || '').trim()
    let ids = new Set<string>()
    if (maybeJson) {
      try {
        ids = this.collectSessionIdsFromPayload(JSON.parse(maybeJson))
      } catch {
        ids = this.collectSessionIdsFromPayload(maybeJson)
      }
    }

    if (ids.size > 0) {
      ids.forEach((sessionId) => this.deleteSessionStatsCacheEntry(sessionId))
      if (Array.from(ids).some((id) => id.includes('@chatroom'))) {
        this.allGroupSessionIdsCache = null
      }
      return
    }

    // 无法定位具体会话时，保守地仅在消息/群成员相关变更时清空当前 scope，避免展示过旧统计。
    if (
      normalizedType.includes('message') ||
      normalizedType.includes('session') ||
      normalizedType.includes('group') ||
      normalizedType.includes('member') ||
      normalizedType.includes('contact')
    ) {
      this.clearSessionStatsCacheForScope()
    }
  }

  private async listAllGroupSessionIds(): Promise<string[]> {
    const now = Date.now()
    if (
      this.allGroupSessionIdsCache &&
      now - this.allGroupSessionIdsCache.updatedAt <= this.allGroupSessionIdsCacheTtlMs
    ) {
      return this.allGroupSessionIdsCache.ids
    }

    const result = await wcdbService.getSessions()
    if (!result.success || !Array.isArray(result.sessions)) {
      return []
    }

    const ids = new Set<string>()
    for (const rowAny of result.sessions) {
      const row = rowAny as Record<string, unknown>
      const usernameRaw = row.username ?? row.userName ?? row.talker ?? row.sessionId
      const username = String(usernameRaw || '').trim()
      if (!username || !username.endsWith('@chatroom')) continue
      ids.add(username)
    }

    const list = Array.from(ids)
    this.allGroupSessionIdsCache = {
      ids: list,
      updatedAt: now
    }
    return list
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

  private async getMessageTableColumns(dbPath: string, tableName: string): Promise<Set<string>> {
    const cacheKey = `${dbPath}\u0001${tableName}`
    const now = Date.now()
    const cached = this.messageTableColumnsCache.get(cacheKey)
    if (cached && now - cached.updatedAt <= this.messageTableColumnsCacheTtlMs) {
      return new Set<string>(cached.columns)
    }

    const result = await wcdbService.getMessageTableColumns(dbPath, tableName)
    if (!result.success || !Array.isArray(result.columns) || result.columns.length === 0) return new Set<string>()

    const columns = new Set<string>()
    for (const columnName of result.columns) {
      const name = String(columnName || '').trim().toLowerCase()
      if (name) columns.add(name)
    }
    this.messageTableColumnsCache.set(cacheKey, {
      columns: new Set<string>(columns),
      updatedAt: now
    })
    return columns
  }

  private pickFirstColumn(columns: Set<string>, candidates: string[]): string | undefined {
    for (const candidate of candidates) {
      const normalized = candidate.toLowerCase()
      if (columns.has(normalized)) return normalized
    }
    return undefined
  }

  private escapeSqlLiteral(value: string): string {
    return String(value || '').replace(/'/g, "''")
  }

  private extractType49XmlTypeForStats(content: string): string {
    if (!content) return ''

    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
    if (appmsgMatch) {
      const appmsgInner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
      if (typeMatch) return String(typeMatch[1] || '').trim()
    }

    return this.extractXmlValue(content, 'type')
  }

  private async collectSpecialMessageCountsByCursorScan(sessionId: string): Promise<{
    transferMessages: number
    redPacketMessages: number
    callMessages: number
  }> {
    const counters = {
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }

    const cursorResult = await wcdbService.openMessageCursorLite(sessionId, 500, false, 0, 0)
    if (!cursorResult.success || !cursorResult.cursor) {
      return counters
    }

    const cursor = cursorResult.cursor
    try {
      while (true) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) break
        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        for (const row of rows) {
          const localType = this.getRowInt(row, ['local_type'], 1)
          if (localType === 50) {
            counters.callMessages += 1
            continue
          }
          if (localType === 8589934592049) {
            counters.transferMessages += 1
            continue
          }
          if (localType === 8594229559345) {
            counters.redPacketMessages += 1
            continue
          }
          if (localType !== 49) continue

          const rawMessageContent = row.message_content
          const rawCompressContent = row.compress_content
          const content = this.decodeMessageContent(rawMessageContent, rawCompressContent)
          const xmlType = this.extractType49XmlTypeForStats(content)
          if (xmlType === '2000') counters.transferMessages += 1
          if (xmlType === '2001') counters.redPacketMessages += 1
        }

        if (!batch.hasMore || rows.length === 0) break
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor)
    }

    return counters
  }

  private async collectSessionExportStatsByCursorScan(
    sessionId: string,
    selfIdentitySet: Set<string>
  ): Promise<ExportSessionStats> {
    const stats: ExportSessionStats = {
      totalMessages: 0,
      voiceMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      emojiMessages: 0,
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }
    if (sessionId.endsWith('@chatroom')) {
      stats.groupMyMessages = 0
      stats.groupActiveSpeakers = 0
    }

    const senderIdentities = new Set<string>()
    const cursorResult = await wcdbService.openMessageCursorLite(sessionId, 500, false, 0, 0)
    if (!cursorResult.success || !cursorResult.cursor) {
      return stats
    }

    const cursor = cursorResult.cursor
    try {
      while (true) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) {
          break
        }

        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        for (const row of rows) {
          stats.totalMessages += 1

          const localType = this.getRowInt(row, ['local_type'], 1)
          if (localType === 34) stats.voiceMessages += 1
          if (localType === 3) stats.imageMessages += 1
          if (localType === 43) stats.videoMessages += 1
          if (localType === 47) stats.emojiMessages += 1
          if (localType === 50) stats.callMessages += 1
          if (localType === 8589934592049) stats.transferMessages += 1
          if (localType === 8594229559345) stats.redPacketMessages += 1
          if (localType === 49) {
            const rawMessageContent = row.message_content
            const rawCompressContent = row.compress_content
            const content = this.decodeMessageContent(rawMessageContent, rawCompressContent)
            const xmlType = this.extractType49XmlTypeForStats(content)
            if (xmlType === '2000') stats.transferMessages += 1
            if (xmlType === '2001') stats.redPacketMessages += 1
          }

          const createTime = this.getRowInt(
            row,
            ['create_time'],
            0
          )
          if (createTime > 0) {
            if (stats.firstTimestamp === undefined || createTime < stats.firstTimestamp) {
              stats.firstTimestamp = createTime
            }
            if (stats.lastTimestamp === undefined || createTime > stats.lastTimestamp) {
              stats.lastTimestamp = createTime
            }
          }

          if (sessionId.endsWith('@chatroom')) {
            const sender = String(row.sender_username || '').trim()
            const senderKeys = this.buildIdentityKeys(sender)
            if (senderKeys.length > 0) {
              senderIdentities.add(senderKeys[0])
              if (senderKeys.some((key) => selfIdentitySet.has(key))) {
                stats.groupMyMessages = (stats.groupMyMessages || 0) + 1
              }
            } else {
              const isSend = this.coerceRowNumber(row.computed_is_send ?? row.is_send)
              if (Number.isFinite(isSend) && isSend === 1) {
                stats.groupMyMessages = (stats.groupMyMessages || 0) + 1
              }
            }
          }
        }

        if (!batch.hasMore || rows.length === 0) {
          break
        }
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor)
    }

    if (sessionId.endsWith('@chatroom')) {
      stats.groupActiveSpeakers = senderIdentities.size
      if (Number.isFinite(stats.groupMyMessages)) {
        this.setGroupMyMessageCountHintEntry(sessionId, stats.groupMyMessages as number)
      }
    }
    return stats
  }

  private async collectSessionExportStats(
    sessionId: string,
    selfIdentitySet: Set<string>,
    preferAccurateSpecialTypes: boolean = false
  ): Promise<ExportSessionStats> {
    const stats: ExportSessionStats = {
      totalMessages: 0,
      voiceMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      emojiMessages: 0,
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }
    const isGroup = sessionId.endsWith('@chatroom')
    if (isGroup) {
      stats.groupMyMessages = 0
      stats.groupActiveSpeakers = 0
    }

    const nativeResult = await wcdbService.getSessionMessageTypeStats(sessionId, 0, 0)
    if (!nativeResult.success || !nativeResult.data) {
      return this.collectSessionExportStatsByCursorScan(sessionId, selfIdentitySet)
    }

    const data = nativeResult.data as Record<string, any>
    stats.totalMessages = Math.max(0, Math.floor(Number(data.total_messages || 0)))
    stats.voiceMessages = Math.max(0, Math.floor(Number(data.voice_messages || 0)))
    stats.imageMessages = Math.max(0, Math.floor(Number(data.image_messages || 0)))
    stats.videoMessages = Math.max(0, Math.floor(Number(data.video_messages || 0)))
    stats.emojiMessages = Math.max(0, Math.floor(Number(data.emoji_messages || 0)))
    stats.callMessages = Math.max(0, Math.floor(Number(data.call_messages || 0)))
    stats.transferMessages = Math.max(0, Math.floor(Number(data.transfer_messages || 0)))
    stats.redPacketMessages = Math.max(0, Math.floor(Number(data.red_packet_messages || 0)))

    const firstTs = Math.max(0, Math.floor(Number(data.first_timestamp || 0)))
    const lastTs = Math.max(0, Math.floor(Number(data.last_timestamp || 0)))
    if (firstTs > 0) stats.firstTimestamp = firstTs
    if (lastTs > 0) stats.lastTimestamp = lastTs

    if (preferAccurateSpecialTypes) {
      try {
        const preciseCounters = await this.collectSpecialMessageCountsByCursorScan(sessionId)
        stats.transferMessages = preciseCounters.transferMessages
        stats.redPacketMessages = preciseCounters.redPacketMessages
        stats.callMessages = preciseCounters.callMessages
      } catch {
        // 保留 native 聚合结果作为兜底
      }
    }

    if (isGroup) {
      stats.groupMyMessages = Math.max(0, Math.floor(Number(data.group_my_messages || 0)))
      stats.groupActiveSpeakers = Math.max(0, Math.floor(Number(data.group_sender_count || 0)))
      if (Number.isFinite(stats.groupMyMessages)) {
        this.setGroupMyMessageCountHintEntry(sessionId, stats.groupMyMessages as number)
      }
    }
    return stats
  }

  private toExportSessionStatsFromNativeTypeRow(sessionId: string, row: Record<string, any>): ExportSessionStats {
    const stats: ExportSessionStats = {
      totalMessages: Math.max(0, Math.floor(Number(row?.total_messages || 0))),
      voiceMessages: Math.max(0, Math.floor(Number(row?.voice_messages || 0))),
      imageMessages: Math.max(0, Math.floor(Number(row?.image_messages || 0))),
      videoMessages: Math.max(0, Math.floor(Number(row?.video_messages || 0))),
      emojiMessages: Math.max(0, Math.floor(Number(row?.emoji_messages || 0))),
      callMessages: Math.max(0, Math.floor(Number(row?.call_messages || 0))),
      transferMessages: Math.max(0, Math.floor(Number(row?.transfer_messages || 0))),
      redPacketMessages: Math.max(0, Math.floor(Number(row?.red_packet_messages || 0)))
    }

    const firstTs = Math.max(0, Math.floor(Number(row?.first_timestamp || 0)))
    const lastTs = Math.max(0, Math.floor(Number(row?.last_timestamp || 0)))
    if (firstTs > 0) stats.firstTimestamp = firstTs
    if (lastTs > 0) stats.lastTimestamp = lastTs

    if (sessionId.endsWith('@chatroom')) {
      stats.groupMyMessages = Math.max(0, Math.floor(Number(row?.group_my_messages || 0)))
      stats.groupActiveSpeakers = Math.max(0, Math.floor(Number(row?.group_sender_count || 0)))
      if (Number.isFinite(stats.groupMyMessages)) {
        this.setGroupMyMessageCountHintEntry(sessionId, stats.groupMyMessages as number)
      }
    }
    return stats
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

  private async buildGroupRelationStats(
    groupSessionIds: string[],
    privateSessionIds: string[],
    selfIdentitySet: Set<string>
  ): Promise<{
    privateMutualGroupMap: Record<string, number>
    groupMutualFriendMap: Record<string, number>
  }> {
    const privateMutualGroupMap: Record<string, number> = {}
    const groupMutualFriendMap: Record<string, number> = {}
    if (groupSessionIds.length === 0) {
      return { privateMutualGroupMap, groupMutualFriendMap }
    }

    const privateIndex = new Map<string, Set<string>>()
    for (const sessionId of privateSessionIds) {
      for (const key of this.buildIdentityKeys(sessionId)) {
        const set = privateIndex.get(key) || new Set<string>()
        set.add(sessionId)
        privateIndex.set(key, set)
      }
      privateMutualGroupMap[sessionId] = 0
    }

    const friendIdentitySet = await this.getFriendIdentitySet()
    await this.forEachWithConcurrency(groupSessionIds, 4, async (groupId) => {
      const membersResult = await wcdbService.getGroupMembers(groupId)
      if (!membersResult.success || !membersResult.members) {
        groupMutualFriendMap[groupId] = 0
        return
      }

      const touchedPrivateSessions = new Set<string>()
      const friendMembers = new Set<string>()

      for (const member of membersResult.members) {
        const username = this.extractGroupMemberUsername(member)
        const identityKeys = this.buildIdentityKeys(username)
        if (identityKeys.length === 0) continue
        const canonical = identityKeys[0]

        if (!selfIdentitySet.has(canonical) && friendIdentitySet.has(canonical)) {
          friendMembers.add(canonical)
        }

        for (const key of identityKeys) {
          const linked = privateIndex.get(key)
          if (!linked) continue
          for (const sessionId of linked) {
            touchedPrivateSessions.add(sessionId)
          }
        }
      }

      groupMutualFriendMap[groupId] = friendMembers.size
      for (const sessionId of touchedPrivateSessions) {
        privateMutualGroupMap[sessionId] = (privateMutualGroupMap[sessionId] || 0) + 1
      }
    })

    return { privateMutualGroupMap, groupMutualFriendMap }
  }

  private buildEmptyExportSessionStats(sessionId: string, includeRelations: boolean): ExportSessionStats {
    const isGroup = sessionId.endsWith('@chatroom')
    const stats: ExportSessionStats = {
      totalMessages: 0,
      voiceMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      emojiMessages: 0,
      transferMessages: 0,
      redPacketMessages: 0,
      callMessages: 0
    }
    if (isGroup) {
      stats.groupMyMessages = 0
      stats.groupActiveSpeakers = 0
      stats.groupMemberCount = 0
      if (includeRelations) {
        stats.groupMutualFriends = 0
      }
    } else if (includeRelations) {
      stats.privateMutualGroups = 0
    }
    return stats
  }

  private async computeSessionExportStats(
    sessionId: string,
    selfIdentitySet: Set<string>,
    includeRelations: boolean,
    preferAccurateSpecialTypes: boolean = false
  ): Promise<ExportSessionStats> {
    const stats = await this.collectSessionExportStats(sessionId, selfIdentitySet, preferAccurateSpecialTypes)
    const isGroup = sessionId.endsWith('@chatroom')

    if (isGroup) {
      const memberCountsResult = await wcdbService.getGroupMemberCounts([sessionId])
      const memberCountMap = memberCountsResult.success && memberCountsResult.map ? memberCountsResult.map : {}
      stats.groupMemberCount = typeof memberCountMap[sessionId] === 'number' ? Math.max(0, Math.floor(memberCountMap[sessionId])) : 0
    }

    if (includeRelations) {
      if (isGroup) {
        try {
          const { groupMutualFriendMap } = await this.buildGroupRelationStats([sessionId], [], selfIdentitySet)
          stats.groupMutualFriends = groupMutualFriendMap[sessionId] || 0
        } catch {
          stats.groupMutualFriends = 0
        }
      } else {
        const allGroups = await this.listAllGroupSessionIds()
        if (allGroups.length === 0) {
          stats.privateMutualGroups = 0
        } else {
          try {
            const { privateMutualGroupMap } = await this.buildGroupRelationStats(allGroups, [sessionId], selfIdentitySet)
            stats.privateMutualGroups = privateMutualGroupMap[sessionId] || 0
          } catch {
            stats.privateMutualGroups = 0
          }
        }
      }
    }

    return stats
  }

  private async computeSessionExportStatsBatch(
    sessionIds: string[],
    includeRelations: boolean,
    selfIdentitySet: Set<string>,
    preferAccurateSpecialTypes: boolean = false
  ): Promise<Record<string, ExportSessionStats>> {
    const normalizedSessionIds = Array.from(
      new Set(
        (sessionIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    )
    const result: Record<string, ExportSessionStats> = {}
    if (normalizedSessionIds.length === 0) {
      return result
    }

    const groupSessionIds = normalizedSessionIds.filter(sessionId => sessionId.endsWith('@chatroom'))
    const privateSessionIds = normalizedSessionIds.filter(sessionId => !sessionId.endsWith('@chatroom'))

    let memberCountMap: Record<string, number> = {}
    const shouldLoadGroupMemberCount = groupSessionIds.length > 0 && (includeRelations || normalizedSessionIds.length === 1)
    if (shouldLoadGroupMemberCount) {
      try {
        const memberCountsResult = await wcdbService.getGroupMemberCounts(groupSessionIds)
        memberCountMap = memberCountsResult.success && memberCountsResult.map ? memberCountsResult.map : {}
      } catch {
        memberCountMap = {}
      }
    }

    let privateMutualGroupMap: Record<string, number> = {}
    let groupMutualFriendMap: Record<string, number> = {}
    if (includeRelations) {
      let relationGroupSessionIds: string[] = []
      if (privateSessionIds.length > 0) {
        const allGroups = await this.listAllGroupSessionIds()
        relationGroupSessionIds = Array.from(new Set([...allGroups, ...groupSessionIds]))
      } else if (groupSessionIds.length > 0) {
        relationGroupSessionIds = groupSessionIds
      }

      if (relationGroupSessionIds.length > 0) {
        try {
          const relation = await this.buildGroupRelationStats(
            relationGroupSessionIds,
            privateSessionIds,
            selfIdentitySet
          )
          privateMutualGroupMap = relation.privateMutualGroupMap || {}
          groupMutualFriendMap = relation.groupMutualFriendMap || {}
        } catch {
          privateMutualGroupMap = {}
          groupMutualFriendMap = {}
        }
      }
    }

    const nativeBatchStats: Record<string, ExportSessionStats> = {}
    let hasNativeBatchStats = false
    if (!preferAccurateSpecialTypes) {
      try {
        const quickMode = !includeRelations && normalizedSessionIds.length > 1
        const nativeBatch = await wcdbService.getSessionMessageTypeStatsBatch(normalizedSessionIds, {
          beginTimestamp: 0,
          endTimestamp: 0,
          quickMode,
          includeGroupSenderCount: true
        })
        if (nativeBatch.success && nativeBatch.data) {
          for (const sessionId of normalizedSessionIds) {
            const row = nativeBatch.data?.[sessionId] as Record<string, any> | undefined
            if (!row || typeof row !== 'object') continue
            nativeBatchStats[sessionId] = this.toExportSessionStatsFromNativeTypeRow(sessionId, row)
          }
          hasNativeBatchStats = Object.keys(nativeBatchStats).length > 0
        } else {
          console.warn('[fallback-exec] getSessionMessageTypeStatsBatch failed, fallback to per-session stats path')
        }
      } catch (error) {
        console.warn('[fallback-exec] getSessionMessageTypeStatsBatch exception, fallback to per-session stats path:', error)
      }
    }

    await this.forEachWithConcurrency(normalizedSessionIds, 3, async (sessionId) => {
      try {
        const stats = hasNativeBatchStats && nativeBatchStats[sessionId]
          ? { ...nativeBatchStats[sessionId] }
          : await this.collectSessionExportStats(sessionId, selfIdentitySet, preferAccurateSpecialTypes)
        if (sessionId.endsWith('@chatroom')) {
          if (shouldLoadGroupMemberCount) {
            stats.groupMemberCount = typeof memberCountMap[sessionId] === 'number'
              ? Math.max(0, Math.floor(memberCountMap[sessionId]))
              : 0
          }
          if (includeRelations) {
            stats.groupMutualFriends = typeof groupMutualFriendMap[sessionId] === 'number'
              ? Math.max(0, Math.floor(groupMutualFriendMap[sessionId]))
              : 0
          }
        } else if (includeRelations) {
          stats.privateMutualGroups = typeof privateMutualGroupMap[sessionId] === 'number'
            ? Math.max(0, Math.floor(privateMutualGroupMap[sessionId]))
            : 0
        }
        result[sessionId] = stats
      } catch {
        result[sessionId] = this.buildEmptyExportSessionStats(sessionId, includeRelations)
      }
    })

    return result
  }

  private async getOrComputeSessionExportStats(
    sessionId: string,
    includeRelations: boolean,
    selfIdentitySet: Set<string>,
    preferAccurateSpecialTypes: boolean = false
  ): Promise<ExportSessionStats> {
    if (preferAccurateSpecialTypes) {
      return this.computeSessionExportStats(sessionId, selfIdentitySet, includeRelations, true)
    }

    const scopedKey = this.buildScopedSessionStatsKey(sessionId)

    if (!includeRelations) {
      const pendingFull = this.sessionStatsPendingFull.get(scopedKey)
      if (pendingFull) return pendingFull
      const pendingBasic = this.sessionStatsPendingBasic.get(scopedKey)
      if (pendingBasic) return pendingBasic
    } else {
      const pendingFull = this.sessionStatsPendingFull.get(scopedKey)
      if (pendingFull) return pendingFull
    }

    const targetMap = includeRelations ? this.sessionStatsPendingFull : this.sessionStatsPendingBasic
    const pending = this.computeSessionExportStats(sessionId, selfIdentitySet, includeRelations, false)
    targetMap.set(scopedKey, pending)
    try {
      return await pending
    } finally {
      targetMap.delete(scopedKey)
    }
  }

  /**
   * HTTP API 复用消息解析逻辑，确保和应用内展示一致。
   */
  mapRowsToMessagesForApi(rows: Record<string, any>[]): Message[] {
    return this.mapRowsToMessages(rows)
  }

  private mapRowsToMessages(rows: Record<string, any>[]): Message[] {
    const myWxid = this.configService.get('myWxid')

    const messages: Message[] = []
    for (const row of rows) {
      const sourceInfo = this.getMessageSourceInfo(row)
      const rawMessageContent = row.message_content
      const rawCompressContent = row.compress_content

      const content = this.decodeMessageContent(rawMessageContent, rawCompressContent);
      const localType = this.getRowInt(row, ['local_type'], 1)
      const isSendRaw = row.computed_is_send ?? row.is_send
      const parsedRawIsSend = isSendRaw === null ? null : parseInt(isSendRaw, 10)
      const senderUsername = row.sender_username
        || this.extractSenderUsernameFromContent(content)
        || null
      const { isSend } = this.resolveMessageIsSend(parsedRawIsSend, senderUsername)
      const createTime = this.getRowInt(row, ['create_time'], 0)

      if (senderUsername && !myWxid) {
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
      let fileMd5: string | undefined
      let xmlType: string | undefined
      let appMsgKind: string | undefined
      let appMsgDesc: string | undefined
      let appMsgAppName: string | undefined
      let appMsgSourceName: string | undefined
      let appMsgSourceUsername: string | undefined
      let appMsgThumbUrl: string | undefined
      let appMsgMusicUrl: string | undefined
      let appMsgDataUrl: string | undefined
      let appMsgLocationLabel: string | undefined
      let finderNickname: string | undefined
      let finderUsername: string | undefined
      let finderCoverUrl: string | undefined
      let finderAvatar: string | undefined
      let finderDuration: number | undefined
      let locationLat: number | undefined
      let locationLng: number | undefined
      let locationPoiname: string | undefined
      let locationLabel: string | undefined
      let musicAlbumUrl: string | undefined
      let musicUrl: string | undefined
      let giftImageUrl: string | undefined
      let giftWish: string | undefined
      let giftPrice: string | undefined
      // 名片消息
      let cardUsername: string | undefined
      let cardNickname: string | undefined
      let cardAvatarUrl: string | undefined
      // 转账消息
      let transferPayerUsername: string | undefined
      let transferReceiverUsername: string | undefined
      // 聊天记录
      let chatRecordTitle: string | undefined
      let chatRecordList: Array<{
        datatype: number
        sourcename: string
        sourcetime: string
        sourceheadurl?: string
        datadesc?: string
        datatitle?: string
        fileext?: string
        datasize?: number
        messageuuid?: string
        dataurl?: string
        datathumburl?: string
        datacdnurl?: string
        cdndatakey?: string
        cdnthumbkey?: string
        aeskey?: string
        md5?: string
        fullmd5?: string
        thumbfullmd5?: string
        srcMsgLocalid?: number
        imgheight?: number
        imgwidth?: number
        duration?: number
        chatRecordTitle?: string
        chatRecordDesc?: string
        chatRecordList?: any[]
      }> | undefined

      if (localType === 47 && content) {
        const emojiInfo = this.parseEmojiInfo(content)
        emojiCdnUrl = emojiInfo.cdnUrl
        emojiMd5 = emojiInfo.md5
        cdnThumbUrl = emojiInfo.thumbUrl // 复用 cdnThumbUrl 字段或使用 emojiThumbUrl
        // 注意：Message 接口定义的 emojiThumbUrl，这里我们统一一下
        // 如果 Message 接口有 emojiThumbUrl，则使用它
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
        cardAvatarUrl = cardInfo.avatarUrl
      } else if (localType === 48 && content) {
        // 位置消息
        const latStr = this.extractXmlAttribute(content, 'location', 'x') || this.extractXmlAttribute(content, 'location', 'latitude')
        const lngStr = this.extractXmlAttribute(content, 'location', 'y') || this.extractXmlAttribute(content, 'location', 'longitude')
        if (latStr) { const v = parseFloat(latStr); if (Number.isFinite(v)) locationLat = v }
        if (lngStr) { const v = parseFloat(lngStr); if (Number.isFinite(v)) locationLng = v }
        locationLabel = this.extractXmlAttribute(content, 'location', 'label') || this.extractXmlValue(content, 'label') || undefined
        locationPoiname = this.extractXmlAttribute(content, 'location', 'poiname') || this.extractXmlValue(content, 'poiname') || undefined
      } else if ((localType === 49 || localType === 8589934592049) && content) {
        // Type 49 消息（链接、文件、小程序、转账等），8589934592049 也是转账类型
        const type49Info = this.parseType49Message(content)
        xmlType = type49Info.xmlType
        linkTitle = type49Info.linkTitle
        linkUrl = type49Info.linkUrl
        linkThumb = type49Info.linkThumb
        fileName = type49Info.fileName
        fileSize = type49Info.fileSize
        fileExt = type49Info.fileExt
        fileMd5 = type49Info.fileMd5
        chatRecordTitle = type49Info.chatRecordTitle
        chatRecordList = type49Info.chatRecordList
        transferPayerUsername = type49Info.transferPayerUsername
        transferReceiverUsername = type49Info.transferReceiverUsername
        // 引用消息（appmsg type=57）的 quotedContent/quotedSender
        if (type49Info.quotedContent !== undefined) quotedContent = type49Info.quotedContent
        if (type49Info.quotedSender !== undefined) quotedSender = type49Info.quotedSender
      } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
        const quoteInfo = this.parseQuoteMessage(content)
        quotedContent = quoteInfo.content
        quotedSender = quoteInfo.sender
      }

      const looksLikeAppMsg = Boolean(content && (content.includes('<appmsg') || content.includes('&lt;appmsg')))
      if (looksLikeAppMsg) {
        const type49Info = this.parseType49Message(content)
        xmlType = xmlType || type49Info.xmlType
        linkTitle = linkTitle || type49Info.linkTitle
        linkUrl = linkUrl || type49Info.linkUrl
        linkThumb = linkThumb || type49Info.linkThumb
        fileName = fileName || type49Info.fileName
        fileSize = fileSize ?? type49Info.fileSize
        fileExt = fileExt || type49Info.fileExt
        fileMd5 = fileMd5 || type49Info.fileMd5
        appMsgKind = appMsgKind || type49Info.appMsgKind
        appMsgDesc = appMsgDesc || type49Info.appMsgDesc
        appMsgAppName = appMsgAppName || type49Info.appMsgAppName
        appMsgSourceName = appMsgSourceName || type49Info.appMsgSourceName
        appMsgSourceUsername = appMsgSourceUsername || type49Info.appMsgSourceUsername
        appMsgThumbUrl = appMsgThumbUrl || type49Info.appMsgThumbUrl
        appMsgMusicUrl = appMsgMusicUrl || type49Info.appMsgMusicUrl
        appMsgDataUrl = appMsgDataUrl || type49Info.appMsgDataUrl
        appMsgLocationLabel = appMsgLocationLabel || type49Info.appMsgLocationLabel
        finderNickname = finderNickname || type49Info.finderNickname
        finderUsername = finderUsername || type49Info.finderUsername
        finderCoverUrl = finderCoverUrl || type49Info.finderCoverUrl
        finderAvatar = finderAvatar || type49Info.finderAvatar
        finderDuration = finderDuration ?? type49Info.finderDuration
        locationLat = locationLat ?? type49Info.locationLat
        locationLng = locationLng ?? type49Info.locationLng
        locationPoiname = locationPoiname || type49Info.locationPoiname
        locationLabel = locationLabel || type49Info.locationLabel
        musicAlbumUrl = musicAlbumUrl || type49Info.musicAlbumUrl
        musicUrl = musicUrl || type49Info.musicUrl
        giftImageUrl = giftImageUrl || type49Info.giftImageUrl
        giftWish = giftWish || type49Info.giftWish
        giftPrice = giftPrice || type49Info.giftPrice
        chatRecordTitle = chatRecordTitle || type49Info.chatRecordTitle
        chatRecordList = chatRecordList || type49Info.chatRecordList
        transferPayerUsername = transferPayerUsername || type49Info.transferPayerUsername
        transferReceiverUsername = transferReceiverUsername || type49Info.transferReceiverUsername
        if (!quotedContent && type49Info.quotedContent !== undefined) quotedContent = type49Info.quotedContent
        if (!quotedSender && type49Info.quotedSender !== undefined) quotedSender = type49Info.quotedSender
      }

      const localId = this.getRowInt(row, ['local_id'], 0)
      const serverIdRaw = this.normalizeUnsignedIntegerToken(row.server_id)
      const serverId = this.getRowInt(row, ['server_id'], 0)
      const sortSeq = this.getRowInt(row, ['sort_seq'], createTime)

      messages.push({
        messageKey: this.buildMessageKey({
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
        fileMd5,
        xmlType,
        appMsgKind,
        appMsgDesc,
        appMsgAppName,
        appMsgSourceName,
        appMsgSourceUsername,
        appMsgThumbUrl,
        appMsgMusicUrl,
        appMsgDataUrl,
        appMsgLocationLabel,
        finderNickname,
        finderUsername,
        finderCoverUrl,
        finderAvatar,
        finderDuration,
        locationLat,
        locationLng,
        locationPoiname,
        locationLabel,
        musicAlbumUrl,
        musicUrl,
        giftImageUrl,
        giftWish,
        giftPrice,
        cardUsername,
        cardNickname,
        cardAvatarUrl,
        transferPayerUsername,
        transferReceiverUsername,
        chatRecordTitle,
        chatRecordList,
        _db_path: sourceInfo.dbPath
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
    const looksLikeAppMsg = content.includes('<appmsg') || content.includes('&lt;appmsg')

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
      case 48: {
        const label =
          this.extractXmlAttribute(content, 'location', 'label') ||
          this.extractXmlAttribute(content, 'location', 'poiname') ||
          this.extractXmlValue(content, 'label') ||
          this.extractXmlValue(content, 'poiname')
        return label ? `[位置] ${label}` : '[位置]'
      }
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

        if (looksLikeAppMsg) {
          return this.parseType49(content)
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
    // 从 appmsg 直接子节点提取 type，避免匹配到 refermsg 内部的 <type>
    let type = ''
    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
    if (appmsgMatch) {
      const inner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(inner)
      if (typeMatch) type = typeMatch[1].trim()
    }
    if (!type) type = this.extractXmlValue(content, 'type')
    const normalized = content.toLowerCase()
    const locationLabel =
      this.extractXmlAttribute(content, 'location', 'label') ||
      this.extractXmlAttribute(content, 'location', 'poiname') ||
      this.extractXmlValue(content, 'label') ||
      this.extractXmlValue(content, 'poiname')
    const isFinder =
      type === '51' ||
      normalized.includes('<finder') ||
      normalized.includes('finderusername') ||
      normalized.includes('finderobjectid')
    const isRedPacket = type === '2001' || normalized.includes('hongbao')
    const isMusic =
      type === '3' ||
      normalized.includes('<musicurl>') ||
      normalized.includes('<playurl>') ||
      normalized.includes('<dataurl>')

    // 群公告消息（type 87）特殊处理
    if (type === '87') {
      const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
      if (textAnnouncement) {
        return `[群公告] ${textAnnouncement}`
      }
      return '[群公告]'
    }

    if (isFinder) {
      return title ? `[视频号] ${title}` : '[视频号]'
    }
    if (isRedPacket) {
      return title ? `[红包] ${title}` : '[红包]'
    }
    if (locationLabel) {
      return `[位置] ${locationLabel}`
    }
    if (isMusic) {
      return title ? `[音乐] ${title}` : '[音乐]'
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
        case '53':
          return `[接龙] ${title.split(/\r?\n/).map(line => line.trim()).find(Boolean) || title}`
        case '2000':
          return `[转账] ${title}`
        case '2001':
          return `[红包] ${title}`
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
      case '2001':
        return '[红包]'
      case '3':
        return '[音乐]'
      case '5':
      case '49':
        return '[链接]'
      case '87':
        return '[群公告]'
      case '53':
        return '[接龙]'
      default:
        return '[消息]'
    }
  }

  /**
   * 解析表情包信息
   */
  private parseEmojiInfo(content: string): { cdnUrl?: string; md5?: string; thumbUrl?: string; encryptUrl?: string; aesKey?: string } {
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

      // 提取 thumburl
      let thumbUrl: string | undefined
      const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /thumburl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (thumbUrlMatch) {
        thumbUrl = thumbUrlMatch[1].replace(/&amp;/g, '&')
        if (thumbUrl.includes('%')) {
          try {
            thumbUrl = decodeURIComponent(thumbUrl)
          } catch { }
        }
      }

      // 提取 md5
      const md5Match = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) || /md5\s*=\s*([a-fA-F0-9]+)/i.exec(content)
      const md5 = md5Match ? md5Match[1] : undefined

      // 提取 encrypturl
      let encryptUrl: string | undefined
      const encryptUrlMatch = /encrypturl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /encrypturl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (encryptUrlMatch) {
        encryptUrl = encryptUrlMatch[1].replace(/&amp;/g, '&')
        if (encryptUrl.includes('%')) {
          try {
            encryptUrl = decodeURIComponent(encryptUrl)
          } catch { }
        }
      }

      // 提取 aeskey
      const aesKeyMatch = /aeskey\s*=\s*['"]([a-zA-Z0-9]+)['"]/i.exec(content) || /aeskey\s*=\s*([a-zA-Z0-9]+)/i.exec(content)
      const aesKey = aesKeyMatch ? aesKeyMatch[1] : undefined

      return { cdnUrl, md5, thumbUrl, encryptUrl, aesKey }
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
      // 优先取 md5 属性（收到的视频）
      const md5 = this.extractXmlAttribute(content, 'videomsg', 'md5')
      if (md5) return md5.toLowerCase()

      // 自己发的视频没有 md5，只有 rawmd5
      const rawMd5 = this.extractXmlAttribute(content, 'videomsg', 'rawmd5')
      if (rawMd5) return rawMd5.toLowerCase()

      // 兜底：<md5> 标签
      const tagMd5 = this.extractXmlValue(content, 'md5')
      if (tagMd5) return tagMd5.toLowerCase()

      return undefined
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
    const packed = row.packed_info_data
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
      const normalizedContent = this.decodeHtmlEntities(content || '')
      // 提取 refermsg 部分
      const referMsgStart = normalizedContent.indexOf('<refermsg>')
      const referMsgEnd = normalizedContent.indexOf('</refermsg>')

      if (referMsgStart === -1 || referMsgEnd === -1) {
        return {}
      }

      const referMsgXml = normalizedContent.substring(referMsgStart, referMsgEnd + 11)

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
          // 文本消息优先取“部分引用”字段，缺失时再回退到完整 content
          displayContent = this.extractPreferredQuotedText(referMsgXml)
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

  private extractPreferredQuotedText(referMsgXml: string): string {
    if (!referMsgXml) return ''

    const sources = [this.decodeHtmlEntities(referMsgXml)]
    const rawMsgSource = this.extractXmlValue(referMsgXml, 'msgsource')
    if (rawMsgSource) {
      const decodedMsgSource = this.decodeHtmlEntities(rawMsgSource)
      if (decodedMsgSource) {
        sources.push(decodedMsgSource)
      }
    }

    const fullContent = this.sanitizeQuotedContent(this.extractXmlValue(sources[0] || referMsgXml, 'content'))
    const partialText = this.extractPartialQuotedText(sources[0] || referMsgXml, fullContent)
    if (partialText) return partialText

    const candidateTags = [
      'selectedcontent',
      'selectedtext',
      'selectcontent',
      'selecttext',
      'quotecontent',
      'quotetext',
      'partcontent',
      'parttext',
      'excerpt',
      'summary',
      'preview'
    ]

    for (const source of sources) {
      for (const tag of candidateTags) {
        const value = this.sanitizeQuotedContent(this.extractXmlValue(source, tag))
        if (value) return value
      }
    }

    return fullContent
  }

  private extractPartialQuotedText(xml: string, fullContent: string): string {
    if (!xml || !fullContent) return ''

    const startChar = this.extractXmlValue(xml, 'start')
    const endChar = this.extractXmlValue(xml, 'end')
    const startIndexRaw = this.extractXmlValue(xml, 'startindex')
    const endIndexRaw = this.extractXmlValue(xml, 'endindex')
    const startIndex = Number.parseInt(startIndexRaw, 10)
    const endIndex = Number.parseInt(endIndexRaw, 10)

    if (startChar && endChar) {
      const startPos = fullContent.indexOf(startChar)
      if (startPos !== -1) {
        const endPos = fullContent.indexOf(endChar, startPos + startChar.length - 1)
        if (endPos !== -1 && endPos >= startPos) {
          const sliced = fullContent.slice(startPos, endPos + endChar.length).trim()
          if (sliced) return sliced
        }
      }
    }

    if (Number.isFinite(startIndex) && Number.isFinite(endIndex) && endIndex >= startIndex) {
      const chars = Array.from(fullContent)
      const sliced = chars.slice(startIndex, endIndex + 1).join('').trim()
      if (sliced) return sliced
    }

    return ''
  }

  /**
   * 解析名片消息
   * 格式: <msg username="wxid_xxx" nickname="昵称" ... />
   */
  private parseCardInfo(content: string): { username?: string; nickname?: string; avatarUrl?: string } {
    try {
      if (!content) return {}

      // 提取 username
      const username = this.extractXmlAttribute(content, 'msg', 'username') || undefined

      // 提取 nickname
      const nickname = this.extractXmlAttribute(content, 'msg', 'nickname') || undefined

      // 提取头像
      const avatarUrl = this.extractXmlAttribute(content, 'msg', 'bigheadimgurl') ||
        this.extractXmlAttribute(content, 'msg', 'smallheadimgurl') || undefined

      return { username, nickname, avatarUrl }
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
    quotedContent?: string
    quotedSender?: string
    linkTitle?: string
    linkUrl?: string
    linkThumb?: string
    appMsgKind?: string
    appMsgDesc?: string
    appMsgAppName?: string
    appMsgSourceName?: string
    appMsgSourceUsername?: string
    appMsgThumbUrl?: string
    appMsgMusicUrl?: string
    appMsgDataUrl?: string
    appMsgLocationLabel?: string
    finderNickname?: string
    finderUsername?: string
    finderCoverUrl?: string
    finderAvatar?: string
    finderDuration?: number
    locationLat?: number
    locationLng?: number
    locationPoiname?: string
    locationLabel?: string
    musicAlbumUrl?: string
    musicUrl?: string
    giftImageUrl?: string
    giftWish?: string
    giftPrice?: string
    cardAvatarUrl?: string
    fileName?: string
    fileSize?: number
    fileExt?: string
    fileMd5?: string
    transferPayerUsername?: string
    transferReceiverUsername?: string
    chatRecordTitle?: string
    chatRecordList?: Array<{
      datatype: number
      sourcename: string
      sourcetime: string
      sourceheadurl?: string
      datadesc?: string
      datatitle?: string
      fileext?: string
      datasize?: number
      messageuuid?: string
      dataurl?: string
      datathumburl?: string
      datacdnurl?: string
      cdndatakey?: string
      cdnthumbkey?: string
      aeskey?: string
      md5?: string
      fullmd5?: string
      thumbfullmd5?: string
      srcMsgLocalid?: number
      imgheight?: number
      imgwidth?: number
      duration?: number
      chatRecordTitle?: string
      chatRecordDesc?: string
      chatRecordList?: any[]
    }>
  } {
    try {
      if (!content) return {}

      // 提取 appmsg 直接子节点的 type，避免匹配到 refermsg 内部的 <type>
      // 先尝试从 <appmsg>...</appmsg> 块内提取，再用正则跳过嵌套标签
      let xmlType = ''
      const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
      if (appmsgMatch) {
        // 在 appmsg 内容中，找第一个 <type> 但跳过在子元素内部的（如 refermsg > type）
        // 策略：去掉所有嵌套块（refermsg、patMsg 等），再提取 type
        const appmsgInner = appmsgMatch[1]
          .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
          .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
        const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
        if (typeMatch) xmlType = typeMatch[1].trim()
      }
      if (!xmlType) xmlType = this.extractXmlValue(content, 'type')
      if (!xmlType) return {}

      const result: any = { xmlType }

      // 提取通用字段
      const title = this.extractXmlValue(content, 'title')
      const url = this.extractXmlValue(content, 'url')
      const desc = this.extractXmlValue(content, 'des') || this.extractXmlValue(content, 'description')
      const appName = this.extractXmlValue(content, 'appname')
      const sourceName = this.extractXmlValue(content, 'sourcename')
      const sourceUsername = this.extractXmlValue(content, 'sourceusername')
      const thumbUrl =
        this.extractXmlValue(content, 'thumburl') ||
        this.extractXmlValue(content, 'cdnthumburl') ||
        this.extractXmlValue(content, 'cover') ||
        this.extractXmlValue(content, 'coverurl') ||
        this.extractXmlValue(content, 'thumb_url')
      const musicUrl =
        this.extractXmlValue(content, 'musicurl') ||
        this.extractXmlValue(content, 'playurl') ||
        this.extractXmlValue(content, 'songalbumurl')
      const dataUrl = this.extractXmlValue(content, 'dataurl') || this.extractXmlValue(content, 'lowurl')
      const locationLabel =
        this.extractXmlAttribute(content, 'location', 'label') ||
        this.extractXmlAttribute(content, 'location', 'poiname') ||
        this.extractXmlValue(content, 'label') ||
        this.extractXmlValue(content, 'poiname')
      const finderUsername =
        this.extractXmlValue(content, 'finderusername') ||
        this.extractXmlValue(content, 'finder_username') ||
        this.extractXmlValue(content, 'finderuser')
      const finderNickname =
        this.extractXmlValue(content, 'findernickname') ||
        this.extractXmlValue(content, 'finder_nickname')
      const normalized = content.toLowerCase()
      const isFinder = xmlType === '51'
      const isRedPacket = xmlType === '2001'
      const isMusic = xmlType === '3'
      const isLocation = Boolean(locationLabel)

      result.linkTitle = title || undefined
      result.linkUrl = url || undefined
      result.linkThumb = thumbUrl || undefined
      result.appMsgDesc = desc || undefined
      result.appMsgAppName = appName || undefined
      result.appMsgSourceName = sourceName || undefined
      result.appMsgSourceUsername = sourceUsername || undefined
      result.appMsgThumbUrl = thumbUrl || undefined
      result.appMsgMusicUrl = musicUrl || undefined
      result.appMsgDataUrl = dataUrl || undefined
      result.appMsgLocationLabel = locationLabel || undefined
      result.finderUsername = finderUsername || undefined
      result.finderNickname = finderNickname || undefined

      // 视频号封面/头像/时长
      if (isFinder) {
        const finderCover =
          this.extractXmlValue(content, 'thumbUrl') ||
          this.extractXmlValue(content, 'coverUrl') ||
          this.extractXmlValue(content, 'thumburl') ||
          this.extractXmlValue(content, 'coverurl')
        if (finderCover) result.finderCoverUrl = finderCover
        const finderAvatar = this.extractXmlValue(content, 'avatar')
        if (finderAvatar) result.finderAvatar = finderAvatar
        const durationStr = this.extractXmlValue(content, 'videoPlayDuration') || this.extractXmlValue(content, 'duration')
        if (durationStr) {
          const d = parseInt(durationStr, 10)
          if (Number.isFinite(d) && d > 0) result.finderDuration = d
        }
      }

      // 位置经纬度
      if (isLocation) {
        const latAttr = this.extractXmlAttribute(content, 'location', 'x') || this.extractXmlAttribute(content, 'location', 'latitude')
        const lngAttr = this.extractXmlAttribute(content, 'location', 'y') || this.extractXmlAttribute(content, 'location', 'longitude')
        if (latAttr) { const v = parseFloat(latAttr); if (Number.isFinite(v)) result.locationLat = v }
        if (lngAttr) { const v = parseFloat(lngAttr); if (Number.isFinite(v)) result.locationLng = v }
        result.locationPoiname = this.extractXmlAttribute(content, 'location', 'poiname') || locationLabel || undefined
        result.locationLabel = this.extractXmlAttribute(content, 'location', 'label') || undefined
      }

      // 音乐专辑封面
      if (isMusic) {
        const albumUrl = this.extractXmlValue(content, 'songalbumurl')
        if (albumUrl) result.musicAlbumUrl = albumUrl
        result.musicUrl = musicUrl || dataUrl || url || undefined
      }

      // 礼物消息
      const isGift = xmlType === '115'
      if (isGift) {
        result.giftWish = this.extractXmlValue(content, 'wishmessage') || undefined
        result.giftImageUrl = this.extractXmlValue(content, 'skuimgurl') || undefined
        result.giftPrice = this.extractXmlValue(content, 'skuprice') || undefined
      }

      if (isFinder) {
        result.appMsgKind = 'finder'
      } else if (isRedPacket) {
        result.appMsgKind = 'red-packet'
      } else if (isGift) {
        result.appMsgKind = 'gift'
      } else if (isLocation) {
        result.appMsgKind = 'location'
      } else if (isMusic) {
        result.appMsgKind = 'music'
      } else if (xmlType === '33' || xmlType === '36') {
        result.appMsgKind = 'miniapp'
      } else if (xmlType === '6') {
        result.appMsgKind = 'file'
      } else if (xmlType === '19') {
        result.appMsgKind = 'chat-record'
      } else if (xmlType === '2000') {
        result.appMsgKind = 'transfer'
      } else if (xmlType === '87') {
        result.appMsgKind = 'announcement'
      } else if (xmlType === '57') {
        // 引用回复消息，解析 refermsg
        result.appMsgKind = 'quote'
        const quoteInfo = this.parseQuoteMessage(content)
        result.quotedContent = quoteInfo.content
        result.quotedSender = quoteInfo.sender
      } else if (xmlType === '53') {
        result.appMsgKind = 'solitaire'
      } else if ((xmlType === '5' || xmlType === '49') && (sourceUsername?.startsWith('gh_') || appName?.includes('公众号') || sourceName)) {
        result.appMsgKind = 'official-link'
      } else if (url) {
        result.appMsgKind = 'link'
      } else {
        result.appMsgKind = 'card'
      }

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
          const fileMd5 = this.extractXmlValue(content, 'md5') || this.extractXmlValue(content, 'filemd5')
          if (fileExt) {
            result.fileExt = fileExt
          } else if (result.fileName) {
            // 从文件名提取扩展名
            const match = /\.([^.]+)$/.exec(result.fileName)
            if (match) {
              result.fileExt = match[1]
            }
          }
          if (fileMd5) {
            result.fileMd5 = fileMd5.toLowerCase()
          }
          break
        }

        case '19': {
          // 聊天记录
          result.chatRecordTitle = title || '聊天记录'
          const recordList = this.parseForwardChatRecordList(content)
          if (recordList && recordList.length > 0) {
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

          // 提取转账双方 wxid
          const payerUsername = this.extractXmlValue(content, 'payer_username')
          const receiverUsername = this.extractXmlValue(content, 'receiver_username')
          if (payerUsername) {
            result.transferPayerUsername = payerUsername
          }
          if (receiverUsername) {
            result.transferReceiverUsername = receiverUsername
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

  private parseForwardChatRecordList(content: string): any[] | undefined {
    const normalized = this.decodeHtmlEntities(content || '')
    if (!normalized.includes('<recorditem') && !normalized.includes('<dataitem')) {
      return undefined
    }

    const items: any[] = []
    const dedupe = new Set<string>()
    const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
    let recordItemMatch: RegExpExecArray | null
    while ((recordItemMatch = recordItemRegex.exec(normalized)) !== null) {
      const parsed = this.parseForwardChatRecordContainer(recordItemMatch[1] || '')
      for (const item of parsed) {
        const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
        if (!dedupe.has(key)) {
          dedupe.add(key)
          items.push(item)
        }
      }
    }

    if (items.length === 0 && normalized.includes('<dataitem')) {
      const parsed = this.parseForwardChatRecordContainer(normalized)
      for (const item of parsed) {
        const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
        if (!dedupe.has(key)) {
          dedupe.add(key)
          items.push(item)
        }
      }
    }

    return items.length > 0 ? items : undefined
  }

  private extractTopLevelXmlElements(source: string, tagName: string): Array<{ attrs: string; inner: string }> {
    const xml = source || ''
    if (!xml) return []

    const pattern = new RegExp(`<(/?)${tagName}\\b([^>]*)>`, 'gi')
    const result: Array<{ attrs: string; inner: string }> = []
    let match: RegExpExecArray | null
    let depth = 0
    let openEnd = -1
    let openStart = -1
    let openAttrs = ''

    while ((match = pattern.exec(xml)) !== null) {
      const isClosing = match[1] === '/'
      const attrs = match[2] || ''
      const rawTag = match[0] || ''
      const selfClosing = !isClosing && /\/\s*>$/.test(rawTag)

      if (!isClosing) {
        if (depth === 0) {
          openStart = match.index
          openEnd = pattern.lastIndex
          openAttrs = attrs
        }
        if (!selfClosing) {
          depth += 1
        } else if (depth === 0 && openEnd >= 0) {
          result.push({ attrs: openAttrs, inner: '' })
          openStart = -1
          openEnd = -1
          openAttrs = ''
        }
        continue
      }

      if (depth <= 0) continue
      depth -= 1
      if (depth === 0 && openEnd >= 0 && openStart >= 0) {
        result.push({
          attrs: openAttrs,
          inner: xml.slice(openEnd, match.index)
        })
        openStart = -1
        openEnd = -1
        openAttrs = ''
      }
    }

    return result
  }

  private parseForwardChatRecordContainer(containerXml: string): any[] {
    const source = containerXml || ''
    if (!source) return []

    const segments: string[] = [source]
    const decodedContainer = this.decodeHtmlEntities(source)
    if (decodedContainer !== source) {
      segments.push(decodedContainer)
    }

    const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g
    let cdataMatch: RegExpExecArray | null
    while ((cdataMatch = cdataRegex.exec(source)) !== null) {
      const cdataInner = cdataMatch[1] || ''
      if (!cdataInner) continue
      segments.push(cdataInner)
      const decodedInner = this.decodeHtmlEntities(cdataInner)
      if (decodedInner !== cdataInner) {
        segments.push(decodedInner)
      }
    }

    const items: any[] = []
    const seen = new Set<string>()
    for (const segment of segments) {
      if (!segment) continue
      const dataItems = this.extractTopLevelXmlElements(segment, 'dataitem')
      for (const dataItem of dataItems) {
        const parsed = this.parseForwardChatRecordDataItem(dataItem.inner || '', dataItem.attrs || '')
        if (!parsed) continue
        const key = `${parsed.datatype}|${parsed.sourcename}|${parsed.sourcetime}|${parsed.datadesc || ''}|${parsed.datatitle || ''}|${parsed.messageuuid || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          items.push(parsed)
        }
      }
    }

    if (items.length > 0) return items
    const fallback = this.parseForwardChatRecordDataItem(source, '')
    return fallback ? [fallback] : []
  }

  private parseForwardChatRecordDataItem(itemXml: string, attrs: string): any | null {
    const datatypeMatch = /datatype\s*=\s*["']?(\d+)["']?/i.exec(attrs || '')
    const datatype = datatypeMatch ? parseInt(datatypeMatch[1], 10) : parseInt(this.extractXmlValue(itemXml, 'datatype') || '0', 10)
    const sourcename = this.decodeHtmlEntities(this.extractXmlValue(itemXml, 'sourcename') || '')
    const sourcetime = this.extractXmlValue(itemXml, 'sourcetime') || ''
    const sourceheadurl = this.extractXmlValue(itemXml, 'sourceheadurl') || undefined
    const datadesc = this.decodeHtmlEntities(
      this.extractXmlValue(itemXml, 'datadesc') ||
      this.extractXmlValue(itemXml, 'content') ||
      ''
    ) || undefined
    const datatitle = this.decodeHtmlEntities(this.extractXmlValue(itemXml, 'datatitle') || '') || undefined
    const fileext = this.extractXmlValue(itemXml, 'fileext') || undefined
    const datasize = parseInt(this.extractXmlValue(itemXml, 'datasize') || '0', 10) || undefined
    const messageuuid = this.extractXmlValue(itemXml, 'messageuuid') || undefined
    const dataurl = this.decodeHtmlEntities(this.extractXmlValue(itemXml, 'dataurl') || '') || undefined
    const datathumburl = this.decodeHtmlEntities(
      this.extractXmlValue(itemXml, 'datathumburl') ||
      this.extractXmlValue(itemXml, 'thumburl') ||
      this.extractXmlValue(itemXml, 'cdnthumburl') ||
      ''
    ) || undefined
    const datacdnurl = this.decodeHtmlEntities(
      this.extractXmlValue(itemXml, 'datacdnurl') ||
      this.extractXmlValue(itemXml, 'cdnurl') ||
      this.extractXmlValue(itemXml, 'cdndataurl') ||
      ''
    ) || undefined
    const cdndatakey = this.extractXmlValue(itemXml, 'cdndatakey') || undefined
    const cdnthumbkey = this.extractXmlValue(itemXml, 'cdnthumbkey') || undefined
    const aeskey = this.decodeHtmlEntities(
      this.extractXmlValue(itemXml, 'aeskey') ||
      this.extractXmlValue(itemXml, 'qaeskey') ||
      ''
    ) || undefined
    const md5 = this.extractXmlValue(itemXml, 'md5') || this.extractXmlValue(itemXml, 'datamd5') || undefined
    const fullmd5 = this.extractXmlValue(itemXml, 'fullmd5') || undefined
    const thumbfullmd5 = this.extractXmlValue(itemXml, 'thumbfullmd5') || undefined
    const srcMsgLocalid = parseInt(this.extractXmlValue(itemXml, 'srcMsgLocalid') || '0', 10) || undefined
    const imgheight = parseInt(this.extractXmlValue(itemXml, 'imgheight') || '0', 10) || undefined
    const imgwidth = parseInt(this.extractXmlValue(itemXml, 'imgwidth') || '0', 10) || undefined
    const duration = parseInt(this.extractXmlValue(itemXml, 'duration') || '0', 10) || undefined
    const nestedRecordXml = this.extractXmlValue(itemXml, 'recordxml') || undefined
    const chatRecordTitle = this.decodeHtmlEntities(
      (nestedRecordXml && this.extractXmlValue(nestedRecordXml, 'title')) ||
      datatitle ||
      ''
    ) || undefined
    const chatRecordDesc = this.decodeHtmlEntities(
      (nestedRecordXml && this.extractXmlValue(nestedRecordXml, 'desc')) ||
      datadesc ||
      ''
    ) || undefined
    const chatRecordList =
      datatype === 17 && nestedRecordXml
        ? this.parseForwardChatRecordContainer(nestedRecordXml)
        : undefined

    if (!(datatype || sourcename || datadesc || datatitle || messageuuid || srcMsgLocalid)) return null

    return {
      datatype: Number.isFinite(datatype) ? datatype : 0,
      sourcename,
      sourcetime,
      sourceheadurl,
      datadesc,
      datatitle,
      fileext,
      datasize,
      messageuuid,
      dataurl,
      datathumburl,
      datacdnurl,
      cdndatakey,
      cdnthumbkey,
      aeskey,
      md5,
      fullmd5,
      thumbfullmd5,
      srcMsgLocalid,
      imgheight,
      imgwidth,
      duration,
      chatRecordTitle,
      chatRecordDesc,
      chatRecordList
    }
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
      || this.extractSenderUsernameFromContent(rawContent)
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
      266287972401: '拍一拍',
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
    return content.replace(/^[\s]*([a-zA-Z0-9_@-]+):(?!\/\/)(?:\s*(?:\r?\n|<br\s*\/?>)\s*|\s*)/i, '')
  }

  private extractSenderUsernameFromContent(content: string): string | null {
    if (!content) return null

    const normalized = this.cleanUtf16(this.decodeHtmlEntities(String(content)))
    const match = /^\s*([a-zA-Z0-9_@-]{4,}):(?!\/\/)\s*(?:\r?\n|<br\s*\/?>)/i.exec(normalized)
    if (!match?.[1]) return null

    const candidate = match[1].trim()
    return candidate || null
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
   * 格式示例:
   *   纯文本: 我拍了拍 "XX" 
   *   XML: <msg><appmsg...><title>"XX"拍了拍"XX"相信未来!</title>...</msg>
   */
  private cleanPatMessage(content: string): string {
    if (!content) return '拍一拍'

    // 1. 优先从 XML <title> 标签提取内容
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(content)
    if (titleMatch) {
      const title = titleMatch[1]
        .replace(/<!\[CDATA\[/g, '')
        .replace(/\]\]>/g, '')
        .trim()
      if (title) {
        return title
      }
    }

    // 2. 尝试匹配标准的 "A拍了拍B" 格式
    const match = /^(.+?拍了拍.+?)(?:[\r\n]|$|ງ|wxid_)/.exec(content)
    if (match) {
      return match[1].trim()
    }

    // 3. 如果匹配失败，尝试清理掉疑似的 garbage (wxid, 乱码)
    let cleaned = content.replace(/wxid_[a-zA-Z0-9_-]+/g, '') // 移除 wxid
    cleaned = cleaned.replace(/[ງ໐໓ຖiht]+/g, ' ') // 移除已知的乱码字符
    cleaned = cleaned.replace(/\d{6,}/g, '') // 移除长数字
    cleaned = cleaned.replace(/\s+/g, ' ').trim() // 清理空格

    // 移除不可见字符
    cleaned = this.cleanUtf16(cleaned)

    // 如果清理后还有内容，返回
    if (cleaned && cleaned.length > 1 && !cleaned.includes('xml')) {
      return cleaned
    }

    return '拍一拍'
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
      const compactRaw = this.compactEncodedPayload(raw)

      // 检查是否是 hex 编码
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (compactRaw.length > 16 && this.looksLikeHex(compactRaw)) {
        const bytes = Buffer.from(compactRaw, 'hex')
        if (bytes.length > 0) {
          const result = this.decodeBinaryContent(bytes, raw)
          // 
          return result
        }
      }

      // 检查是否是 base64 编码
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (compactRaw.length > 16 && this.looksLikeBase64(compactRaw)) {
        try {
          const bytes = Buffer.from(compactRaw, 'base64')
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
    const compact = this.compactEncodedPayload(s)
    if (compact.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(compact)
  }

  /**
   * 检查是否像 base64 编码
   */
  private looksLikeBase64(s: string): boolean {
    const compact = this.compactEncodedPayload(s)
    if (compact.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(compact)
  }

  private compactEncodedPayload(raw: string): string {
    return String(raw || '').replace(/\s+/g, '').trim()
  }

  private shouldKeepSession(username: string): boolean {
    if (!username) return false
    const lowered = username.toLowerCase()
    // 排除所有 placeholder 会话（包括折叠群）
    if (lowered.includes('@placeholder')) return false
    if (username.startsWith('gh_')) return false

    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders',
      '@helper_folders'
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
      const myWxid = this.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

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
      this.contactsMemoryCache.clear()
    }

    if (includeMessages) {
      this.messageCacheService.clear()
      this.voiceWavCache.clear()
      this.voiceTranscriptCache.clear()
      this.voiceTranscriptPending.clear()
    }

    if (includeMessages || includeContacts) {
      this.sessionStatsMemoryCache.clear()
      this.sessionStatsPendingBasic.clear()
      this.sessionStatsPendingFull.clear()
      this.allGroupSessionIdsCache = null
      this.sessionStatsCacheService.clearAll()
      this.groupMyMessageCountMemoryCache.clear()
      this.groupMyMessageCountCacheService.clearAll()
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

  /**
   * 获取会话详情信息
   */
  async getSessionDetailFast(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailFast
    error?: string
  }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      this.refreshSessionMessageCountCacheScope()

      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) {
        return { success: false, error: '会话ID不能为空' }
      }

      const now = Date.now()
      const cachedDetail = this.sessionDetailFastCache.get(normalizedSessionId)
      if (cachedDetail && now - cachedDetail.updatedAt <= this.sessionDetailFastCacheTtlMs) {
        return { success: true, detail: cachedDetail.detail }
      }

      let displayName = normalizedSessionId
      let remark: string | undefined
      let nickName: string | undefined
      let alias: string | undefined
      let avatarUrl: string | undefined
      const cachedContact = this.avatarCache.get(normalizedSessionId)
      if (cachedContact) {
        displayName = cachedContact.displayName || normalizedSessionId
        if (this.isValidAvatarUrl(cachedContact.avatarUrl)) {
          avatarUrl = cachedContact.avatarUrl
        }
      }

      const contactPromise = wcdbService.getContact(normalizedSessionId)
      const avatarPromise = avatarUrl
        ? Promise.resolve({ success: true, map: { [normalizedSessionId]: avatarUrl } })
        : wcdbService.getAvatarUrls([normalizedSessionId])

      let messageCount: number | undefined
      const cachedCount = this.sessionMessageCountCache.get(normalizedSessionId)
      if (cachedCount && now - cachedCount.updatedAt <= this.sessionMessageCountCacheTtlMs) {
        messageCount = cachedCount.count
      } else {
        const hintCount = this.sessionMessageCountHintCache.get(normalizedSessionId)
        if (typeof hintCount === 'number' && Number.isFinite(hintCount) && hintCount >= 0) {
          messageCount = Math.floor(hintCount)
          this.sessionMessageCountCache.set(normalizedSessionId, {
            count: messageCount,
            updatedAt: now
          })
        }
      }

      const messageCountPromise = Number.isFinite(messageCount)
        ? Promise.resolve<{ success: boolean; count?: number }>({
          success: true,
          count: Math.max(0, Math.floor(messageCount as number))
        })
        : wcdbService.getMessageCount(normalizedSessionId)

      const [contactResult, avatarResult, messageCountResult] = await Promise.allSettled([
        contactPromise,
        avatarPromise,
        messageCountPromise
      ])

      if (contactResult.status === 'fulfilled' && contactResult.value.success && contactResult.value.contact) {
        remark = contactResult.value.contact.remark || undefined
        nickName = contactResult.value.contact.nickName || undefined
        alias = contactResult.value.contact.alias || undefined
        displayName = remark || nickName || alias || displayName
      }

      if (avatarResult.status === 'fulfilled' && avatarResult.value.success && avatarResult.value.map) {
        const avatarCandidate = avatarResult.value.map[normalizedSessionId]
        if (this.isValidAvatarUrl(avatarCandidate)) {
          avatarUrl = avatarCandidate
        }
      }
      if (!avatarUrl) {
        const headImageAvatars = await this.getAvatarsFromHeadImageDb([normalizedSessionId])
        const fallbackAvatarUrl = headImageAvatars[normalizedSessionId]
        if (this.isValidAvatarUrl(fallbackAvatarUrl)) {
          avatarUrl = fallbackAvatarUrl
        }
      }

      if (!Number.isFinite(messageCount)) {
        messageCount = messageCountResult.status === 'fulfilled' &&
          messageCountResult.value.success &&
          Number.isFinite(messageCountResult.value.count)
          ? Math.max(0, Math.floor(messageCountResult.value.count || 0))
          : 0
        this.sessionMessageCountCache.set(normalizedSessionId, {
          count: messageCount,
          updatedAt: Date.now()
        })
      }

      const detail: SessionDetailFast = {
        wxid: normalizedSessionId,
        displayName,
        remark,
        nickName,
        alias,
        avatarUrl,
        messageCount: Math.max(0, Math.floor(messageCount || 0))
      }

      this.sessionDetailFastCache.set(normalizedSessionId, {
        detail,
        updatedAt: Date.now()
      })

      return { success: true, detail }
    } catch (e) {
      console.error('ChatService: 获取会话详情快速信息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getSessionDetailExtra(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailExtra
    error?: string
  }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      this.refreshSessionMessageCountCacheScope()

      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) {
        return { success: false, error: '会话ID不能为空' }
      }

      const now = Date.now()
      const cachedDetail = this.sessionDetailExtraCache.get(normalizedSessionId)
      if (cachedDetail && now - cachedDetail.updatedAt <= this.sessionDetailExtraCacheTtlMs) {
        return { success: true, detail: cachedDetail.detail }
      }

      const tableStatsResult = await wcdbService.getMessageTableStats(normalizedSessionId)

      const messageTables: { dbName: string; tableName: string; count: number }[] = []
      let firstMessageTime: number | undefined
      let latestMessageTime: number | undefined
      if (tableStatsResult.success && tableStatsResult.tables) {
        for (const row of tableStatsResult.tables) {
          messageTables.push({
            dbName: basename(row.db_path || ''),
            tableName: row.table_name || '',
            count: parseInt(row.count || '0', 10)
          })

          const firstTs = this.getRowInt(
            row,
            ['first_timestamp', 'firstTimestamp', 'first_time', 'firstTime', 'min_create_time', 'minCreateTime'],
            0
          )
          if (firstTs > 0 && (firstMessageTime === undefined || firstTs < firstMessageTime)) {
            firstMessageTime = firstTs
          }

          const lastTs = this.getRowInt(
            row,
            ['last_timestamp', 'lastTimestamp', 'last_time', 'lastTime', 'max_create_time', 'maxCreateTime'],
            0
          )
          if (lastTs > 0 && (latestMessageTime === undefined || lastTs > latestMessageTime)) {
            latestMessageTime = lastTs
          }
        }
      }

      const detail: SessionDetailExtra = {
        firstMessageTime,
        latestMessageTime,
        messageTables
      }

      this.sessionDetailExtraCache.set(normalizedSessionId, {
        detail,
        updatedAt: Date.now()
      })

      return {
        success: true,
        detail
      }
    } catch (e) {
      console.error('ChatService: 获取会话详情补充统计失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetail
    error?: string
  }> {
    try {
      const fastResult = await this.getSessionDetailFast(sessionId)
      if (!fastResult.success || !fastResult.detail) {
        return { success: false, error: fastResult.error || '获取会话详情失败' }
      }

      const extraResult = await this.getSessionDetailExtra(sessionId)
      const detail: SessionDetail = {
        ...fastResult.detail,
        firstMessageTime: extraResult.success ? extraResult.detail?.firstMessageTime : undefined,
        latestMessageTime: extraResult.success ? extraResult.detail?.latestMessageTime : undefined,
        messageTables: extraResult.success && extraResult.detail?.messageTables
          ? extraResult.detail.messageTables
          : []
      }

      return { success: true, detail }
    } catch (e) {
      console.error('ChatService: 获取会话详情失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getGroupMyMessageCountHint(chatroomId: string): Promise<{
    success: boolean
    count?: number
    updatedAt?: number
    source?: 'memory' | 'disk'
    error?: string
  }> {
    try {
      this.refreshSessionMessageCountCacheScope()
      const normalizedChatroomId = String(chatroomId || '').trim()
      if (!normalizedChatroomId || !normalizedChatroomId.endsWith('@chatroom')) {
        return { success: false, error: '群聊ID无效' }
      }

      const cached = this.getGroupMyMessageCountHintEntry(normalizedChatroomId)
      if (!cached) return { success: true }
      return {
        success: true,
        count: cached.entry.messageCount,
        updatedAt: cached.entry.updatedAt,
        source: cached.source
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async setGroupMyMessageCountHint(
    chatroomId: string,
    messageCount: number,
    updatedAt?: number
  ): Promise<{ success: boolean; updatedAt?: number; error?: string }> {
    try {
      this.refreshSessionMessageCountCacheScope()
      const normalizedChatroomId = String(chatroomId || '').trim()
      if (!normalizedChatroomId || !normalizedChatroomId.endsWith('@chatroom')) {
        return { success: false, error: '群聊ID无效' }
      }
      const savedAt = this.setGroupMyMessageCountHintEntry(normalizedChatroomId, messageCount, updatedAt)
      return { success: true, updatedAt: savedAt }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getExportSessionStats(sessionIds: string[], options: ExportSessionStatsOptions = {}): Promise<{
    success: boolean
    data?: Record<string, ExportSessionStats>
    cache?: Record<string, ExportSessionStatsCacheMeta>
    needsRefresh?: string[]
    error?: string
  }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      this.refreshSessionMessageCountCacheScope()

      const includeRelations = options.includeRelations ?? true
      const forceRefresh = options.forceRefresh === true
      const allowStaleCache = options.allowStaleCache === true
      const preferAccurateSpecialTypes = options.preferAccurateSpecialTypes === true
      const cacheOnly = options.cacheOnly === true

      const normalizedSessionIds = Array.from(
        new Set(
          (sessionIds || [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedSessionIds.length === 0) {
        return { success: true, data: {}, cache: {} }
      }

      const resultMap: Record<string, ExportSessionStats> = {}
      const cacheMeta: Record<string, ExportSessionStatsCacheMeta> = {}
      const needsRefreshSet = new Set<string>()
      const pendingSessionIds: string[] = []
      const now = Date.now()

      for (const sessionId of normalizedSessionIds) {
        const groupMyMessagesHint = sessionId.endsWith('@chatroom')
          ? this.getGroupMyMessageCountHintEntry(sessionId)
          : null
        const cachedResult = this.getSessionStatsCacheEntry(sessionId)
        const canUseCache = cacheOnly || (!forceRefresh && !preferAccurateSpecialTypes)
        if (canUseCache && cachedResult && this.supportsRequestedRelation(cachedResult.entry, includeRelations)) {
          const stale = now - cachedResult.entry.updatedAt > this.sessionStatsCacheTtlMs
          if (!stale || allowStaleCache || cacheOnly) {
            resultMap[sessionId] = this.fromSessionStatsCacheStats(cachedResult.entry.stats)
            if (groupMyMessagesHint && Number.isFinite(groupMyMessagesHint.entry.messageCount)) {
              resultMap[sessionId].groupMyMessages = groupMyMessagesHint.entry.messageCount
            }
            cacheMeta[sessionId] = {
              updatedAt: cachedResult.entry.updatedAt,
              stale,
              includeRelations: cachedResult.entry.includeRelations,
              source: cachedResult.source
            }
            if (stale) {
              needsRefreshSet.add(sessionId)
            }
            continue
          }
        }
        // allowStaleCache/cacheOnly 仅对“已有缓存”生效；无缓存会话不会直接算重查询。
        if (canUseCache && allowStaleCache && cachedResult) {
          needsRefreshSet.add(sessionId)
          continue
        }
        if (cacheOnly) {
          continue
        }
        pendingSessionIds.push(sessionId)
      }

      if (pendingSessionIds.length > 0) {
        const myWxid = this.configService.get('myWxid') || ''
        const selfIdentitySet = new Set<string>(this.buildIdentityKeys(myWxid))
        let usedBatchedCompute = false
        if (pendingSessionIds.length === 1) {
          const sessionId = pendingSessionIds[0]
          try {
            const stats = await this.getOrComputeSessionExportStats(sessionId, includeRelations, selfIdentitySet, preferAccurateSpecialTypes)
            resultMap[sessionId] = stats
            const updatedAt = this.setSessionStatsCacheEntry(sessionId, stats, includeRelations)
            cacheMeta[sessionId] = {
              updatedAt,
              stale: false,
              includeRelations,
              source: 'fresh'
            }
            usedBatchedCompute = true
          } catch {
            usedBatchedCompute = false
          }
        } else {
          try {
            const batchedStatsMap = await this.computeSessionExportStatsBatch(
              pendingSessionIds,
              includeRelations,
              selfIdentitySet,
              preferAccurateSpecialTypes
            )
            for (const sessionId of pendingSessionIds) {
              const stats = batchedStatsMap[sessionId]
              if (!stats) continue
              resultMap[sessionId] = stats
              const updatedAt = this.setSessionStatsCacheEntry(sessionId, stats, includeRelations)
              cacheMeta[sessionId] = {
                updatedAt,
                stale: false,
                includeRelations,
                source: 'fresh'
              }
            }
            usedBatchedCompute = true
          } catch {
            usedBatchedCompute = false
          }
        }

        if (!usedBatchedCompute) {
          await this.forEachWithConcurrency(pendingSessionIds, 3, async (sessionId) => {
            try {
              const stats = await this.getOrComputeSessionExportStats(sessionId, includeRelations, selfIdentitySet, preferAccurateSpecialTypes)
              resultMap[sessionId] = stats
              const updatedAt = this.setSessionStatsCacheEntry(sessionId, stats, includeRelations)
              cacheMeta[sessionId] = {
                updatedAt,
                stale: false,
                includeRelations,
                source: 'fresh'
              }
            } catch {
              resultMap[sessionId] = this.buildEmptyExportSessionStats(sessionId, includeRelations)
            }
          })
        }
      }

      const response: {
        success: boolean
        data?: Record<string, ExportSessionStats>
        cache?: Record<string, ExportSessionStatsCacheMeta>
        needsRefresh?: string[]
      } = {
        success: true,
        data: resultMap,
        cache: cacheMeta
      }
      if (needsRefreshSet.size > 0) {
        response.needsRefresh = Array.from(needsRefreshSet)
      }
      return response
    } catch (e) {
      console.error('ChatService: 获取导出会话统计失败:', e)
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

      // 1. 获取消息详情
      const msgResult = await this.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) {
        return { success: false, error: '未找到消息' }
      }
      const msg = msgResult.message

      // 2. 使用 imageDecryptService 解密图片
      const result = await this.imageDecryptService.decryptImage({
        sessionId,
        imageMd5: msg.imageMd5,
        imageDatName: msg.imageDatName || String(msg.localId),
        force: false
      })

      if (!result.success || !result.localPath) {
        return { success: false, error: result.error || '图片解密失败' }
      }

      // 3. 读取解密后的文件并转成 base64
      // 如果已经是 data URL，直接返回 base64 部分
      if (result.localPath.startsWith('data:')) {
        const base64Data = result.localPath.split(',')[1]
        return { success: true, data: base64Data }
      }

      // localPath 是 file:// URL，需要转换成文件路径
      const filePath = result.localPath.startsWith('file://')
        ? result.localPath.replace(/^file:\/\//, '')
        : result.localPath

      const imageData = readFileSync(filePath)
      return { success: true, data: imageData.toString('base64') }
    } catch (e) {
      console.error('ChatService: getImageData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * getVoiceData（主用批量专属接口读取语音数据）
   */
  async getVoiceData(sessionId: string, msgId: string, createTime?: number, serverId?: string | number, senderWxidOpt?: string): Promise<{ success: boolean; data?: string; error?: string }> {
    const startTime = Date.now()
    const verboseVoiceTrace = process.env.WEFLOW_VOICE_TRACE === '1'
    const msgCreateTimeLabel = (value?: number): string => {
      return Number.isFinite(Number(value)) ? String(Math.floor(Number(value))) : '无'
    }
    const lookupPath: string[] = []
    const logLookupPath = (status: 'success' | 'fail', error?: string): void => {
      const timeline = lookupPath.map((step, idx) => `${idx + 1}.${step}`).join(' -> ')
      if (status === 'success') {
        if (verboseVoiceTrace) {
          console.info(`[Voice] 定位流程成功: ${timeline}`)
        }
      } else {
        console.warn(`[Voice] 定位流程失败${error ? `(${error})` : ''}: ${timeline}`)
      }
    }

    try {
      lookupPath.push(`会话=${sessionId}, 消息=${msgId}, 传入createTime=${msgCreateTimeLabel(createTime)}, serverId=${String(serverId || 0)}`)
      lookupPath.push(`消息来源提示=${senderWxidOpt || '无'}`)

      const localId = parseInt(msgId, 10)
      if (isNaN(localId)) {
        logLookupPath('fail', '无效的消息ID')
        return { success: false, error: '无效的消息ID' }
      }

      let msgCreateTime = createTime
      let senderWxid: string | null = senderWxidOpt || null
      let resolvedServerId: string | number = this.normalizeUnsignedIntegerToken(serverId) || 0
      let locatedMsg: Message | null = null
      let rejectedNonVoiceLookup = false

      lookupPath.push(`初始解析localId=${localId}成功`)

      // 已提供强键(createTime + serverId)时，直接走语音定位，避免 localId 反查噪音与误导
      const hasStrongInput = Number.isFinite(Number(msgCreateTime)) && Number(msgCreateTime) > 0
        && Boolean(this.normalizeUnsignedIntegerToken(serverId))

      if (hasStrongInput) {
        lookupPath.push('调用入参已具备强键(createTime+serverId)，跳过localId反查')
      } else {
        const t1 = Date.now()
        const msgResult = await this.getMessageByLocalId(sessionId, localId)
        const t2 = Date.now()
        lookupPath.push(`消息反查耗时=${t2 - t1}ms`)
        if (!msgResult.success || !msgResult.message) {
          lookupPath.push('未命中: getMessageByLocalId')
        } else {
          const dbMsg = msgResult.message as Message
          const locatedServerId = this.normalizeUnsignedIntegerToken(dbMsg.serverIdRaw ?? dbMsg.serverId)
          const incomingServerId = this.normalizeUnsignedIntegerToken(serverId)
          lookupPath.push(`命中消息定位: localId=${dbMsg.localId}, createTime=${dbMsg.createTime}, sender=${dbMsg.senderUsername || ''}, serverId=${locatedServerId || '0'}, localType=${dbMsg.localType}, voice时长=${dbMsg.voiceDurationSeconds ?? 0}`)

          if (incomingServerId && locatedServerId && incomingServerId !== locatedServerId) {
            lookupPath.push(`serverId纠正: input=${incomingServerId}, db=${locatedServerId}`)
          }

          // localId 在不同表可能重复，反查命中非语音时不覆盖调用侧入参
          if (Number(dbMsg.localType) === 34) {
            locatedMsg = dbMsg
            msgCreateTime = dbMsg.createTime || msgCreateTime
            senderWxid = dbMsg.senderUsername || senderWxid || null
            if (locatedServerId) {
              resolvedServerId = locatedServerId
            }
          } else {
            rejectedNonVoiceLookup = true
            lookupPath.push('消息反查命中但localType!=34，忽略反查覆盖，继续使用调用入参定位')
          }
        }
      }

      if (!msgCreateTime) {
        lookupPath.push('定位失败: 未找到消息时间戳')
        logLookupPath('fail', '未找到消息时间戳')
        return { success: false, error: '未找到消息时间戳' }
      }
      if (!locatedMsg) {
        lookupPath.push(rejectedNonVoiceLookup
          ? `定位结果: 反查命中非语音并已忽略, createTime=${msgCreateTime}, sender=${senderWxid || '无'}`
          : `定位结果: 未走消息反查流程, createTime=${msgCreateTime}, sender=${senderWxid || '无'}`)
      } else {
        lookupPath.push(`定位结果: 语音消息被确认 localId=${localId}, createTime=${msgCreateTime}, sender=${senderWxid || '无'}`)
      }
      lookupPath.push(`最终serverId=${String(resolvedServerId || 0)}`)

      if (verboseVoiceTrace) {
        if (locatedMsg) {
          console.log('[Voice] 定位到的具体语音消息:', {
            sessionId,
            msgId,
            localId: locatedMsg.localId,
            createTime: locatedMsg.createTime,
            senderUsername: locatedMsg.senderUsername,
            serverId: locatedMsg.serverIdRaw || locatedMsg.serverId,
            localType: locatedMsg.localType,
            voiceDurationSeconds: locatedMsg.voiceDurationSeconds
          })
        } else {
          console.log('[Voice] 定位到的语音消息:', {
            sessionId,
            msgId,
            localId,
            createTime: msgCreateTime,
            senderUsername: senderWxid,
            serverId: resolvedServerId
          })
        }
      }

      // 使用 sessionId + createTime + msgId 作为缓存 key，避免同秒语音串音
      const cacheKey = this.getVoiceCacheKey(sessionId, String(localId), msgCreateTime)

      // 检查 WAV 内存缓存
      const wavCache = this.voiceWavCache.get(cacheKey)
      if (wavCache) {
        lookupPath.push('命中内存WAV缓存')
        logLookupPath('success', '内存缓存')
        return { success: true, data: wavCache.toString('base64') }
      }

      // 检查 WAV 文件缓存
      const voiceCacheDir = this.getVoiceCacheDir()
      const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
      if (existsSync(wavFilePath)) {
        try {
          const wavData = readFileSync(wavFilePath)
          this.cacheVoiceWav(cacheKey, wavData)
          lookupPath.push('命中磁盘WAV缓存')
          logLookupPath('success', '磁盘缓存')
          return { success: true, data: wavData.toString('base64') }
        } catch (e) {
          lookupPath.push('命中磁盘WAV缓存但读取失败')
          console.error('[Voice] 读取缓存文件失败:', e)
        }
      }
      lookupPath.push('缓存未命中，进入DB定位')

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
      lookupPath.push(`定位候选链=${JSON.stringify(candidates)}`)

      const t3 = Date.now()
      // 从数据库读取 silk 数据
      const silkData = await this.getVoiceDataFromMediaDb(sessionId, msgCreateTime, localId, resolvedServerId || 0, candidates, lookupPath, myWxid)
      const t4 = Date.now()
      lookupPath.push(`DB定位耗时=${t4 - t3}ms`)


      if (!silkData) {
        logLookupPath('fail', '未找到语音数据')
        return { success: false, error: '未找到语音数据 (请确保已在微信中播放过该语音)' }
      }
      lookupPath.push('语音二进制定位完成')

      const t5 = Date.now()
      // 使用 silk-wasm 解码
      const pcmData = await this.decodeSilkToPcm(silkData, 24000)
      const t6 = Date.now()
      lookupPath.push(`silk解码耗时=${t6 - t5}ms`)


      if (!pcmData) {
        logLookupPath('fail', 'Silk解码失败')
        return { success: false, error: 'Silk 解码失败' }
      }
      lookupPath.push('silk解码成功')

      const t7 = Date.now()
      // PCM -> WAV
      const wavData = this.createWavBuffer(pcmData, 24000)
      const t8 = Date.now()
      lookupPath.push(`WAV转码耗时=${t8 - t7}ms`)


      // 缓存 WAV 数据到内存
      this.cacheVoiceWav(cacheKey, wavData)

      // 缓存 WAV 数据到文件（异步，不阻塞返回）
      this.cacheVoiceWavToFile(cacheKey, wavData)

      lookupPath.push(`总耗时=${t8 - startTime}ms`)
      logLookupPath('success')

      return { success: true, data: wavData.toString('base64') }
    } catch (e) {
      lookupPath.push(`异常: ${String(e)}`)
      logLookupPath('fail', String(e))
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
      await fsPromises.mkdir(voiceCacheDir, { recursive: true })
      const wavFilePath = join(voiceCacheDir, `${cacheKey}.wav`)
      await fsPromises.writeFile(wavFilePath, wavData)
    } catch (e) {
      console.error('[Voice] 缓存文件失败:', e)
    }
  }

  /**
   * 通过 WCDB 专属接口查询语音数据
   * 策略：批量查询 + 单条 native 兜底
   */
  private async getVoiceDataFromMediaDb(
    sessionId: string,
    createTime: number,
    localId: number,
    svrId: string | number,
    candidates: string[],
    lookupPath?: string[],
    myWxid?: string
  ): Promise<Buffer | null> {
    try {
      const candidatesList = Array.isArray(candidates)
        ? candidates.filter((value, index, arr) => {
          const key = String(value || '').trim()
          return Boolean(key) && arr.findIndex(v => String(v || '').trim() === key) === index
        })
        : []
      const createTimeInt = Math.max(0, Math.floor(Number(createTime || 0)))
      const localIdInt = Math.max(0, Math.floor(Number(localId || 0)))
      const svrIdToken = svrId || 0

      const plans: Array<{ label: string; list: string[] }> = []
      if (candidatesList.length > 0) {
        const strict = String(myWxid || '').trim()
          ? candidatesList.filter(item => item !== String(myWxid || '').trim())
          : candidatesList.slice()
        if (strict.length > 0 && strict.length !== candidatesList.length) {
          plans.push({ label: 'strict(no-self)', list: strict })
        }
        plans.push({ label: 'full', list: candidatesList })
      } else {
        plans.push({ label: 'empty', list: [] })
      }

      lookupPath?.push(`构建音频查询参数 createTime=${createTimeInt}, localId=${localIdInt}, svrId=${svrIdToken}, plans=${plans.map(p => `${p.label}:${p.list.length}`).join('|')}`)

      for (const plan of plans) {
        lookupPath?.push(`尝试候选集[${plan.label}]=${JSON.stringify(plan.list)}`)
        // 先走单条 native：svr_id 通过 int64 直传，避免 batch JSON 的大整数精度/解析差异
        lookupPath?.push(`先尝试单条查询(${plan.label})`)
        const single = await wcdbService.getVoiceData(
          sessionId,
          createTimeInt,
          plan.list,
          localIdInt,
          svrIdToken
        )
        lookupPath?.push(`单条查询(${plan.label})结果: success=${single.success}, hasHex=${Boolean(single.hex)}`)
        if (single.success && single.hex) {
          const decoded = this.decodeVoiceBlob(single.hex)
          if (decoded && decoded.length > 0) {
            lookupPath?.push(`单条查询(${plan.label})解码成功`)
            return decoded
          }
          lookupPath?.push(`单条查询(${plan.label})解码为空`)
        }

        const batchResult = await wcdbService.getVoiceDataBatch([{
          session_id: sessionId,
          create_time: createTimeInt,
          local_id: localIdInt,
          svr_id: svrIdToken,
          candidates: plan.list
        }])
        lookupPath?.push(`批量查询(${plan.label})结果: success=${batchResult.success}, rows=${Array.isArray(batchResult.rows) ? batchResult.rows.length : 0}`)
        if (!batchResult.success) {
          lookupPath?.push(`批量查询(${plan.label})失败: ${batchResult.error || '无错误信息'}`)
        }

        if (batchResult.success && Array.isArray(batchResult.rows) && batchResult.rows.length > 0) {
          const hex = String(batchResult.rows[0]?.hex || '').trim()
          lookupPath?.push(`命中批量结果(${plan.label})[0], hexLen=${hex.length}`)
          if (hex) {
            const decoded = this.decodeVoiceBlob(hex)
            if (decoded && decoded.length > 0) {
              lookupPath?.push(`批量结果(${plan.label})解码成功`)
              return decoded
            }
            lookupPath?.push(`批量结果(${plan.label})解码为空`)
          }
        } else {
          lookupPath?.push(`批量结果(${plan.label})未命中`)
        }
      }

      lookupPath?.push('音频定位失败：未命中任何结果')
      return null
    } catch (e) {
      lookupPath?.push(`音频定位异常: ${String(e)}`)
      return null
    }
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
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) return { success: true, prepared: 0 }
      if (!Array.isArray(messages) || messages.length === 0) return { success: true, prepared: 0 }

      const myWxid = String(this.configService.get('myWxid') || '').trim()
      const nowPrepared = new Set<string>()
      const pending: Array<{
        cacheKey: string
        request: { session_id: string; create_time: number; local_id: number; svr_id: string | number; candidates: string[] }
      }> = []

      for (const item of messages) {
        const localId = Math.max(0, Math.floor(Number(item?.localId || 0)))
        const createTime = Math.max(0, Math.floor(Number(item?.createTime || 0)))
        if (!localId || !createTime) continue

        const cacheKey = this.getVoiceCacheKey(normalizedSessionId, String(localId), createTime)
        if (nowPrepared.has(cacheKey)) continue
        nowPrepared.add(cacheKey)

        const inMemory = this.voiceWavCache.get(cacheKey)
        if (inMemory && inMemory.length > 0) continue

        const wavFilePath = join(this.getVoiceCacheDir(), `${cacheKey}.wav`)
        if (existsSync(wavFilePath)) {
          try {
            const wavData = readFileSync(wavFilePath)
            if (wavData.length > 0) {
              this.cacheVoiceWav(cacheKey, wavData)
              continue
            }
          } catch {
            // ignore corrupted cache file
          }
        }

        const senderWxid = String(item?.senderWxid || '').trim()
        const candidates: string[] = []
        if (senderWxid) candidates.push(senderWxid)
        if (!candidates.includes(normalizedSessionId)) candidates.push(normalizedSessionId)
        if (myWxid && !candidates.includes(myWxid)) candidates.push(myWxid)

        pending.push({
          cacheKey,
          request: {
            session_id: normalizedSessionId,
            create_time: createTime,
            local_id: localId,
            svr_id: item?.serverId || 0,
            candidates
          }
        })
      }

      if (pending.length === 0) {
        return { success: true, prepared: nowPrepared.size }
      }

      const chunkSize = Math.max(8, Math.min(128, Math.floor(Number(options?.chunkSize || 48))))
      const decodeConcurrency = Math.max(1, Math.min(6, Math.floor(Number(options?.decodeConcurrency || 3))))
      let prepared = nowPrepared.size - pending.length

      for (let i = 0; i < pending.length; i += chunkSize) {
        const chunk = pending.slice(i, i + chunkSize)
        const batchResult = await wcdbService.getVoiceDataBatch(chunk.map(item => item.request))
        if (!batchResult.success || !Array.isArray(batchResult.rows)) {
          continue
        }

        const byIndex = new Map<number, string>()
        for (const row of batchResult.rows as Array<Record<string, any>>) {
          const idx = Number.parseInt(String(row?.index ?? ''), 10)
          const hex = String(row?.hex || '').trim()
          if (!Number.isFinite(idx) || idx < 0 || !hex) continue
          byIndex.set(idx, hex)
        }

        const readyItems: Array<{ cacheKey: string; hex: string }> = []
        for (let rowIdx = 0; rowIdx < chunk.length; rowIdx += 1) {
          const hex = byIndex.get(rowIdx)
          if (!hex) continue
          readyItems.push({ cacheKey: chunk[rowIdx].cacheKey, hex })
        }

        await this.forEachWithConcurrency(readyItems, decodeConcurrency, async (item) => {
          const silkData = this.decodeVoiceBlob(item.hex)
          if (!silkData || silkData.length === 0) return

          const pcmData = await this.decodeSilkToPcm(silkData, 24000)
          if (!pcmData || pcmData.length === 0) return

          const wavData = this.createWavBuffer(pcmData, 24000)
          this.cacheVoiceWav(item.cacheKey, wavData)
          this.cacheVoiceWavToFile(item.cacheKey, wavData)
          prepared += 1
        })
      }

      return { success: true, prepared }
    } catch (e) {
      return { success: false, error: String(e) }
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
      const senderWxid = msg.senderUsername || undefined
      return this.getVoiceData(sessionId, msgId, msg.createTime, msg.serverIdRaw || msg.serverId, senderWxid)
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

    // 确保磁盘缓存已加载
    this.loadTranscriptCacheIfNeeded()

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
          serverId = msgResult.message.serverIdRaw || msgResult.message.serverId

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
    // createTime + msgId 可避免同会话同秒多条语音互相覆盖
    if (createTime) {
      return `${sessionId}_${createTime}_${msgId}`
    }
    return `${sessionId}_${msgId}`
  }

  private cacheVoiceWav(cacheKey: string, wavData: Buffer): void {
    this.voiceWavCache.set(cacheKey, wavData)
    // LRU缓存会自动处理大小限制，无需手动清理
  }

  /** 获取持久化转写缓存文件路径 */
  private getTranscriptCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    const base = cachePath || join(app.getPath('documents'), 'WeFlow')
    return join(base, 'Voices', 'transcripts.json')
  }

  /** 首次访问时从磁盘加载转写缓存 */
  private loadTranscriptCacheIfNeeded(): void {
    if (this.transcriptCacheLoaded) return
    this.transcriptCacheLoaded = true
    try {
      const filePath = this.getTranscriptCachePath()
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8')
        const data = JSON.parse(raw) as Record<string, string>
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'string') this.voiceTranscriptCache.set(k, v)
        }
        console.log(`[Transcribe] 从磁盘加载了 ${this.voiceTranscriptCache.size} 条转写缓存`)
      }
    } catch (e) {
      console.error('[Transcribe] 加载转写缓存失败:', e)
    }
  }

  /** 将转写缓存持久化到磁盘（防抖 3 秒） */
  private scheduleTranscriptFlush(): void {
    if (this.transcriptFlushTimer) return
    this.transcriptFlushTimer = setTimeout(() => {
      this.transcriptFlushTimer = null
      this.flushTranscriptCache()
    }, 3000)
  }

  /** 立即写入转写缓存到磁盘 */
  flushTranscriptCache(): void {
    if (!this.transcriptCacheDirty) return
    try {
      const filePath = this.getTranscriptCachePath()
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const obj: Record<string, string> = {}
      for (const [k, v] of this.voiceTranscriptCache) obj[k] = v
      writeFileSync(filePath, JSON.stringify(obj), 'utf-8')
      this.transcriptCacheDirty = false
    } catch (e) {
      console.error('[Transcribe] 写入转写缓存失败:', e)
    }
  }

  private cacheVoiceTranscript(cacheKey: string, transcript: string): void {
    this.voiceTranscriptCache.set(cacheKey, transcript)
    this.transcriptCacheDirty = true
    this.scheduleTranscriptFlush()
  }

  /**
   * 检查某个语音消息是否已有缓存的转写结果
   */
  hasTranscriptCache(sessionId: string, msgId: string, createTime?: number): boolean {
    this.loadTranscriptCacheIfNeeded()
    const cacheKey = this.getVoiceCacheKey(sessionId, msgId, createTime)
    return this.voiceTranscriptCache.has(cacheKey)
  }

  /**
   * 批量统计转写缓存命中数（按会话维度）。
   * 仅基于本地 transcripts cache key 统计，用于导出前快速预估。
   */
  getCachedVoiceTranscriptCountMap(sessionIds: string[]): Record<string, number> {
    this.loadTranscriptCacheIfNeeded()
    const normalizedIds = Array.from(
      new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))
    )
    const targetSet = new Set(normalizedIds)
    const countMap: Record<string, number> = {}
    for (const sessionId of normalizedIds) {
      countMap[sessionId] = 0
    }
    if (targetSet.size === 0) return countMap

    for (const key of this.voiceTranscriptCache.keys()) {
      const rawKey = String(key || '')
      if (!rawKey) continue
      // 新 key: `${sessionId}_${createTime}_${msgId}`；旧 key: `${sessionId}_${createTime}`
      const matchNew = /^(.*)_(\d+)_(\d+)$/.exec(rawKey)
      const matchOld = matchNew ? null : /^(.*)_(\d+)$/.exec(rawKey)
      const sessionId = String((matchNew ? matchNew[1] : (matchOld ? matchOld[1] : '')) || '').trim()
      if (!sessionId || !targetSet.has(sessionId)) continue
      countMap[sessionId] = (countMap[sessionId] || 0) + 1
    }

    return countMap
  }

  /**
   * 获取某会话的所有语音消息（localType=34），用于批量转写
   */
  async getAllVoiceMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getMessagesByType(sessionId, 34, false, 0, 0)
      if (!result.success || !Array.isArray(result.rows)) {
        return { success: false, error: result.error || '查询语音消息失败' }
      }

      let allVoiceMessages: Message[] = this.mapRowsToMessages(result.rows as Record<string, any>[])

      // 按 createTime 降序排序
      allVoiceMessages.sort((a, b) => b.createTime - a.createTime)

      // 去重
      const seen = new Set<string>()
      allVoiceMessages = allVoiceMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${allVoiceMessages.length} 条语音消息（去重后）`)
      return { success: true, messages: allVoiceMessages }
    } catch (e) {
      console.error('[ChatService] 获取所有语音消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取某会话中有消息的日期列表
   * 返回 YYYY-MM-DD 格式的日期字符串数组
   */
  /**
   * 获取某会话的全部图片消息（用于聊天页批量图片解密）
   */
  async getAllImageMessages(
    sessionId: string
  ): Promise<{ success: boolean; images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getMessagesByType(sessionId, 3, false, 0, 0)
      if (!result.success || !Array.isArray(result.rows)) {
        return { success: false, error: result.error || '查询图片消息失败' }
      }

      const mapped = this.mapRowsToMessages(result.rows as Record<string, any>[])
      let allImages: Array<{ imageMd5?: string; imageDatName?: string; createTime?: number }> = mapped
        .filter(msg => msg.localType === 3)
        .map(msg => ({
          imageMd5: msg.imageMd5 || undefined,
          imageDatName: msg.imageDatName || undefined,
          createTime: msg.createTime || undefined
        }))
        .filter(img => Boolean(img.imageMd5 || img.imageDatName))

      allImages.sort((a, b) => (b.createTime || 0) - (a.createTime || 0))

      const seen = new Set<string>()
      allImages = allImages.filter(img => {
        const key = img.imageMd5 || img.imageDatName || ''
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${allImages.length} 条图片消息（去重后）`)
      return { success: true, images: allImages }
    } catch (e) {
      console.error('[ChatService] 获取全部图片消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private resolveResourceType(message: Message): ResourceMessageType | null {
    if (message.localType === 3) return 'image'
    if (message.localType === 43) return 'video'
    if (message.localType === 34) return 'voice'
    if (
      message.localType === 49 ||
      message.localType === 34359738417 ||
      message.localType === 103079215153 ||
      message.localType === 25769803825
    ) {
      if (message.appMsgKind === 'file' || message.xmlType === '6') return 'file'
      if (message.localType !== 49) return 'file'
    }
    return null
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
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const requestedTypes = Array.isArray(options?.types)
        ? options.types.filter((type): type is ResourceMessageType => ['image', 'video', 'voice', 'file'].includes(type))
        : []
      const typeSet = new Set<ResourceMessageType>(requestedTypes.length > 0 ? requestedTypes : ['image', 'video', 'voice', 'file'])

      const beginTimestamp = Number(options?.beginTimestamp || 0)
      const endTimestamp = Number(options?.endTimestamp || 0)
      const offset = Math.max(0, Number(options?.offset || 0))
      const limitRaw = Number(options?.limit || 0)
      const limit = Number.isFinite(limitRaw) ? Math.min(2000, Math.max(1, Math.floor(limitRaw || 300))) : 300

      const sessionsResult = await this.getSessions()
      if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) {
        return { success: false, error: sessionsResult.error || '获取会话失败' }
      }

      const sessionNameMap = new Map<string, string>()
      sessionsResult.sessions.forEach((session) => {
        sessionNameMap.set(session.username, session.displayName || session.username)
      })

      const requestedSessionId = String(options?.sessionId || '').trim()
      const sortedSessions = [...sessionsResult.sessions].sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))
      const targetSessionIds = requestedSessionId
        ? [requestedSessionId]
        : sortedSessions.map((session) => session.username)

      const localTypes: number[] = []
      if (typeSet.has('image')) localTypes.push(3)
      if (typeSet.has('video')) localTypes.push(43)
      if (typeSet.has('voice')) localTypes.push(34)
      if (typeSet.has('file')) {
        localTypes.push(49, 34359738417, 103079215153, 25769803825)
      }
      const uniqueLocalTypes = Array.from(new Set(localTypes))

      const allItems: ResourceMessageItem[] = []
      const dedup = new Set<string>()
      const targetCount = offset + limit
      const candidateBuffer = Math.max(180, limit)
      const perTypeFetch = requestedSessionId
        ? Math.min(2000, Math.max(200, targetCount * 2))
        : (beginTimestamp > 0 || endTimestamp > 0 ? 140 : 90)
      const maxSessionScan = requestedSessionId
        ? 1
        : (beginTimestamp > 0 || endTimestamp > 0 ? 240 : 80)
      const scanSessionIds = targetSessionIds.slice(0, maxSessionScan)

      let maybeHasMore = targetSessionIds.length > scanSessionIds.length
      let stopEarly = false

      for (const sessionId of scanSessionIds) {
        const batchRows = await Promise.all(
          uniqueLocalTypes.map((localType) =>
            wcdbService.getMessagesByType(sessionId, localType, false, perTypeFetch, 0)
          )
        )
        for (const result of batchRows) {
          if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) continue
          if (result.rows.length >= perTypeFetch) maybeHasMore = true

          const mapped = this.mapRowsToMessages(result.rows as Record<string, any>[])
          for (const message of mapped) {
            const resourceType = this.resolveResourceType(message)
            if (!resourceType || !typeSet.has(resourceType)) continue
            if (beginTimestamp > 0 && message.createTime < beginTimestamp) continue
            if (endTimestamp > 0 && message.createTime > endTimestamp) continue

            const dedupKey = `${sessionId}:${message.localId}:${message.serverId}:${message.createTime}:${message.localType}`
            if (dedup.has(dedupKey)) continue
            dedup.add(dedupKey)

            allItems.push({
              ...message,
              sessionId,
              sessionDisplayName: sessionNameMap.get(sessionId) || sessionId,
              resourceType
            })
          }
        }

        if (allItems.length >= targetCount + candidateBuffer) {
          stopEarly = true
          maybeHasMore = true
          break
        }
      }

      allItems.sort((a, b) => {
        const timeDiff = (b.createTime || 0) - (a.createTime || 0)
        if (timeDiff !== 0) return timeDiff
        return (b.localId || 0) - (a.localId || 0)
      })

      const total = allItems.length
      const start = Math.min(offset, total)
      const end = Math.min(start + limit, total)

      return {
        success: true,
        items: allItems.slice(start, end),
        total,
        hasMore: end < total || maybeHasMore || stopEarly
      }
    } catch (e) {
      console.error('[ChatService] 获取资源消息失败:', e)
      return { success: false, error: String(e) }
    }
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

      console.log(`[ChatService] 会话 ${sessionId} 共有 ${dates.length} 个有消息的日期`)
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

      console.log(`[ChatService] 会话 ${sessionId} 获取到 ${Object.keys(counts).length} 个日期的消息计数`)
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
  ): Promise<{ success: boolean; data?: MyFootprintData; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const begin = this.normalizeTimestampSeconds(beginTimestamp)
      const end = this.normalizeTimestampSeconds(endTimestamp)
      const normalizedEnd = begin > 0 && end > 0 && end < begin ? begin : end
      const mentionLimitRaw = Number(options?.mentionLimit ?? 0)
      const privateLimitRaw = Number(options?.privateLimit ?? 0)
      const mentionLimit = Number.isFinite(mentionLimitRaw) && mentionLimitRaw >= 0
        ? Math.floor(mentionLimitRaw)
        : 0
      const privateLimit = Number.isFinite(privateLimitRaw) && privateLimitRaw >= 0
        ? Math.floor(privateLimitRaw)
        : 0

      let myWxid = String(options?.myWxid || '').trim()
      if (!myWxid) {
        myWxid = String(this.configService.get('myWxid') || '').trim()
      }
      if (!myWxid) {
        return { success: false, error: '未识别当前账号 wxid' }
      }

      let privateSessionIds = Array.isArray(options?.privateSessionIds)
        ? options!.privateSessionIds!.map((value) => String(value || '').trim()).filter(Boolean)
        : []
      let groupSessionIds = Array.isArray(options?.groupSessionIds)
        ? options!.groupSessionIds!.map((value) => String(value || '').trim()).filter(Boolean)
        : []
      const hasExplicitGroupScope = Array.isArray(options?.groupSessionIds)
        && options!.groupSessionIds!.some((value) => String(value || '').trim().length > 0)

      if (privateSessionIds.length === 0 && groupSessionIds.length === 0) {
        const sessionsResult = await wcdbService.getSessions()
        if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) {
          return { success: false, error: sessionsResult.error || '读取会话列表失败' }
        }
        for (const session of sessionsResult.sessions as Array<Record<string, any>>) {
          const sessionId = String(session.username || session.user_name || '').trim()
          if (!sessionId) continue
          const sessionLastTs = this.normalizeTimestampSeconds(
            Number(session.lastTimestamp || session.sortTimestamp || 0)
          )
          if (sessionId.endsWith('@chatroom')) {
            groupSessionIds.push(sessionId)
          } else {
            if (!this.shouldKeepSession(sessionId)) continue
            if (begin > 0 && sessionLastTs > 0 && sessionLastTs < begin) continue
            privateSessionIds.push(sessionId)
          }
        }
      }

      privateSessionIds = Array.from(new Set(
        privateSessionIds
          .map((value) => String(value || '').trim())
          .filter((value) => value && !value.endsWith('@chatroom') && this.shouldKeepSession(value))
      ))
      groupSessionIds = Array.from(new Set(
        groupSessionIds
          .map((value) => String(value || '').trim())
          .filter((value) => value && value.endsWith('@chatroom'))
      ))
      if (!hasExplicitGroupScope) {
        groupSessionIds = await this.resolveMyFootprintGroupSessionIds(groupSessionIds, begin, normalizedEnd)
      }

      privateSessionIds = await this.filterMyFootprintPrivateSessions(privateSessionIds)

      let data: MyFootprintData | null = null
      const effectivePrivateLimit = privateLimit
      // native 候选上限：0 表示不截断候选，确保前端 source 二次过滤有完整输入
      const nativeMentionCandidateLimit = 0
      let nativePasses = 0
      const candidateLimitUsed = nativeMentionCandidateLimit
      let nativeGroupChunks = 0

      const runNativePass = async (passOptions: {
        label: string
        passPrivateSessionIds: string[]
        passGroupSessionIds: string[]
        candidateLimit: number
        passPrivateLimit: number
      }): Promise<MyFootprintData> => {
        nativePasses += 1
        const nativeResult = await wcdbService.getMyFootprintStats({
          beginTimestamp: begin,
          endTimestamp: normalizedEnd,
          myWxid,
          privateSessionIds: passOptions.passPrivateSessionIds,
          groupSessionIds: passOptions.passGroupSessionIds,
          mentionLimit: passOptions.candidateLimit,
          privateLimit: passOptions.passPrivateLimit,
          mentionMode: options?.mentionMode || 'text_at_me'
        })
        if (!nativeResult.success || !nativeResult.data) {
          throw new Error(nativeResult.error || '获取我的足迹统计失败')
        }
        const normalized = this.normalizeMyFootprintData(nativeResult.data)
        return normalized
      }

      const runGroupPasses = async (targetGroupSessionIds: string[]): Promise<{ raw: MyFootprintData | null; chunks: number }> => {
        if (!Array.isArray(targetGroupSessionIds) || targetGroupSessionIds.length === 0) {
          return { raw: null, chunks: 0 }
        }
        const singleGroupThresholdRaw = Number(process.env.WEFLOW_MY_FOOTPRINT_SINGLE_GROUP_THRESHOLD || 40)
        const singleGroupThreshold = Number.isFinite(singleGroupThresholdRaw) && singleGroupThresholdRaw >= 1
          ? Math.floor(singleGroupThresholdRaw)
          : 40

        let aggregated: MyFootprintData | null = null
        let chunks = 0
        if (targetGroupSessionIds.length <= singleGroupThreshold) {
          chunks = targetGroupSessionIds.length
          for (const sessionId of targetGroupSessionIds) {
            const chunkRaw = await runNativePass({
              label: `group-single:${sessionId}`,
              passPrivateSessionIds: [],
              passGroupSessionIds: [sessionId],
              candidateLimit: candidateLimitUsed,
              passPrivateLimit: 0
            })
            aggregated = aggregated
              ? this.mergeMyFootprintMentionResult(aggregated, chunkRaw)
              : chunkRaw
          }
        } else {
          const groupChunks = splitGroupSessionsForNative(targetGroupSessionIds)
          chunks = groupChunks.length
          for (const chunk of groupChunks) {
            const chunkRaw = await runNativePass({
              label: `group-chunk:${chunk[0] || ''}..(${chunk.length})`,
              passPrivateSessionIds: [],
              passGroupSessionIds: chunk,
              candidateLimit: candidateLimitUsed,
              passPrivateLimit: 0
            })
            aggregated = aggregated
              ? this.mergeMyFootprintMentionResult(aggregated, chunkRaw)
              : chunkRaw
          }
        }
        return { raw: aggregated, chunks }
      }

      const splitGroupSessionsForNative = (sessionIds: string[]): string[][] => {
        const normalized = Array.from(new Set(
          (sessionIds || [])
            .map((value) => String(value || '').trim())
            .filter((value) => value.endsWith('@chatroom'))
        ))
        if (normalized.length === 0) return []

        // 规避 native options_json 可能存在的固定缓冲上限：按 payload 字节安全分块。
        // 这不是降级或裁剪范围，而是完整遍历所有群并做结果合并。
        const maxBytesRaw = Number(process.env.WEFLOW_MY_FOOTPRINT_GROUP_OPTIONS_MAX_BYTES || 900)
        const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw >= 512
          ? Math.floor(maxBytesRaw)
          : 900
        const estimateBytes = (groups: string[]): number => Buffer.byteLength(JSON.stringify({
          begin,
          end: normalizedEnd,
          my_wxid: myWxid,
          private_session_ids: [],
          group_session_ids: groups,
          mention_limit: candidateLimitUsed,
          private_limit: 0,
          mention_mode: options?.mentionMode || 'text_at_me'
        }), 'utf8')

        const chunks: string[][] = []
        let current: string[] = []
        for (const sessionId of normalized) {
          if (current.length === 0) {
            current.push(sessionId)
            continue
          }
          const next = [...current, sessionId]
          if (estimateBytes(next) > maxBytes) {
            chunks.push(current)
            current = [sessionId]
          } else {
            current = next
          }
        }
        if (current.length > 0) chunks.push(current)
        return chunks
      }

      let privateNativeRaw: MyFootprintData | null = null
      let mentionNativeRaw: MyFootprintData | null = null

      if (privateSessionIds.length > 0) {
        privateNativeRaw = await runNativePass({
          label: 'private',
          passPrivateSessionIds: privateSessionIds,
          passGroupSessionIds: [],
          candidateLimit: 0,
          passPrivateLimit: effectivePrivateLimit
        })
      }

      if (groupSessionIds.length > 0) {
        const firstPass = await runGroupPasses(groupSessionIds)
        mentionNativeRaw = firstPass.raw
        nativeGroupChunks = firstPass.chunks

        if ((mentionNativeRaw?.mentions.length || 0) === 0) {
          const probeIndexes = Array.from(new Set([
            0,
            Math.floor(groupSessionIds.length / 2),
            groupSessionIds.length - 1
          ])).filter((index) => index >= 0 && index < groupSessionIds.length)
          let probeHit = false
          for (const index of probeIndexes) {
            const sessionId = groupSessionIds[index]
            const probeRaw = await runNativePass({
              label: `group-probe:${sessionId}`,
              passPrivateSessionIds: [],
              passGroupSessionIds: [sessionId],
              candidateLimit: candidateLimitUsed,
              passPrivateLimit: 0
            })
            if (probeRaw.mentions.length > 0 || probeRaw.summary.mention_count > 0) {
              probeHit = true
              break
            }
          }

          if (probeHit) {
            await wcdbService.getSessions().catch(() => ({ success: false }))
            const retryPass = await runGroupPasses(groupSessionIds)
            mentionNativeRaw = retryPass.raw
            nativeGroupChunks = retryPass.chunks
          }
        }
      }

      let nativeRaw = privateNativeRaw || mentionNativeRaw || this.normalizeMyFootprintData({})
      if (privateNativeRaw && mentionNativeRaw) {
        nativeRaw = this.mergeMyFootprintMentionResult(privateNativeRaw, mentionNativeRaw)
      }

      data = this.filterMyFootprintMentionsBySource(nativeRaw, myWxid, mentionLimit)

      if (privateSessionIds.length > 0 && data.private_segments.length === 0) {
        const privateSegments = await this.rebuildMyFootprintPrivateSegments({
          begin,
          end: normalizedEnd,
          myWxid,
          privateSessionIds
        })
        if (privateSegments.length > 0) {
          data = {
            ...data,
            private_segments: privateSegments
          }
        }
      }

      if (data.mentions.length === 0) {
        if (this.shouldRunMyFootprintHeavyDebug()) {
          const privatePassRawMentions = privateNativeRaw?.mentions.length || 0
          const mentionPassRawMentions = mentionNativeRaw?.mentions.length || 0
          console.warn(
            `[MyFootprint][diag] zero filtered mentions begin=${begin} end=${normalizedEnd} groups=${groupSessionIds.length} raw=${nativeRaw.mentions.length} splitRaw(private=${privatePassRawMentions},group=${mentionPassRawMentions}) passes=${nativePasses} groupChunks=${nativeGroupChunks}`
          )
          await this.printMyFootprintNativeLogs('zero_filtered_mentions')
          await this.logMyFootprintNativeQuickProbe({
            begin,
            end: normalizedEnd,
            myWxid,
            groupSessionIds,
            mentionMode: options?.mentionMode || 'text_at_me'
          })
          await this.logMyFootprintZeroMentionDebug({
            begin,
            end: normalizedEnd,
            myWxid,
            groupSessionIds,
            nativeData: nativeRaw
          })
        }
      }

      const enriched = await this.enrichMyFootprintData(data)
      return { success: true, data: enriched }
    } catch (error) {
      console.error('[ChatService] 获取我的足迹统计失败:', error)
      return { success: false, error: String(error) }
    }
  }

  private async logMyFootprintNativeQuickProbe(params: {
    begin: number
    end: number
    myWxid: string
    groupSessionIds: string[]
    mentionMode: string
  }): Promise<void> {
    try {
      const groups = Array.from(new Set(
        (params.groupSessionIds || [])
          .map((value) => String(value || '').trim())
          .filter((value) => value.endsWith('@chatroom'))
      ))
      if (groups.length === 0) {
        console.warn('[MyFootprint][native-quick] skipped: no groups')
        return
      }
      const indices = Array.from(new Set([
        0,
        Math.floor(groups.length / 2),
        groups.length - 1
      ])).filter((index) => index >= 0 && index < groups.length)

      for (const index of indices) {
        const sessionId = groups[index]
        const result = await wcdbService.getMyFootprintStats({
          beginTimestamp: params.begin,
          endTimestamp: params.end,
          myWxid: params.myWxid,
          privateSessionIds: [],
          groupSessionIds: [sessionId],
          mentionLimit: 0,
          privateLimit: 0,
          mentionMode: params.mentionMode
        })
        if (!result.success || !result.data) {
          console.warn(
            `[MyFootprint][native-quick][${index + 1}/${groups.length}][${sessionId}] fail err=${result.error || 'unknown'}`
          )
          continue
        }
        const raw = this.normalizeMyFootprintData(result.data)
        console.warn(
          `[MyFootprint][native-quick][${index + 1}/${groups.length}][${sessionId}] mentions=${raw.mentions.length} mentionGroups=${raw.mention_groups.length} summaryMention=${raw.summary.mention_count} diagScanned=${raw.diagnostics.scanned_dbs} diagElapsed=${raw.diagnostics.elapsed_ms}`
        )
      }
    } catch (error) {
      console.warn('[MyFootprint][native-quick] exception:', error)
    }
  }

  private async rebuildMyFootprintPrivateSegments(params: {
    begin: number
    end: number
    myWxid: string
    privateSessionIds: string[]
  }): Promise<MyFootprintPrivateSegment[]> {
    const sessionGapSeconds = 10 * 60
    const segments: MyFootprintPrivateSegment[] = []

    type WorkingSegment = {
      segment_index: number
      start_ts: number
      end_ts: number
      incoming_count: number
      outgoing_count: number
      first_incoming_ts: number
      first_reply_ts: number
      anchor_local_id: number
      anchor_create_time: number
      latest_local_id: number
      latest_create_time: number
    }

    for (const sessionId of params.privateSessionIds) {
      const cursorResult = await wcdbService.openMessageCursorLite(
        sessionId,
        360,
        true,
        params.begin,
        params.end
      )
      if (!cursorResult.success || !cursorResult.cursor) continue

      let segmentCursor = 0
      let active: WorkingSegment | null = null
      let lastMessageTs = 0
      const commit = () => {
        if (!active) return
        const startTs = active.start_ts > 0 ? active.start_ts : active.anchor_create_time
        const endTs = active.end_ts > 0 ? active.end_ts : startTs
        const incoming = Math.max(0, active.incoming_count)
        const outgoing = Math.max(0, active.outgoing_count)
        const messageCount = incoming + outgoing
        if (startTs > 0 && messageCount > 0) {
          segments.push({
            session_id: sessionId,
            segment_index: active.segment_index,
            start_ts: startTs,
            end_ts: endTs,
            duration_sec: Math.max(0, endTs - startTs),
            incoming_count: incoming,
            outgoing_count: outgoing,
            message_count: messageCount,
            replied: incoming > 0 && outgoing > 0,
            first_incoming_ts: active.first_incoming_ts,
            first_reply_ts: active.first_reply_ts,
            latest_ts: endTs,
            anchor_local_id: active.anchor_local_id,
            anchor_create_time: startTs
          })
        }
        active = null
      }

      let hasMore = true
      try {
        while (hasMore) {
          const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
          if (!batchResult.success || !Array.isArray(batchResult.rows)) break
          hasMore = Boolean(batchResult.hasMore)

          for (const row of batchResult.rows as Array<Record<string, any>>) {
            const createTime = this.toSafeInt(row.create_time, 0)
            const localId = this.toSafeInt(row.local_id, 0)
            const isSend = this.resolveFootprintRowIsSend(row, params.myWxid)

            if (createTime > 0) {
              const needNew = !active || (lastMessageTs > 0 && createTime - lastMessageTs > sessionGapSeconds)
              if (needNew) {
                commit()
                segmentCursor += 1
                active = {
                  segment_index: segmentCursor,
                  start_ts: createTime,
                  end_ts: createTime,
                  incoming_count: 0,
                  outgoing_count: 0,
                  first_incoming_ts: 0,
                  first_reply_ts: 0,
                  anchor_local_id: localId,
                  anchor_create_time: createTime,
                  latest_local_id: localId,
                  latest_create_time: createTime
                }
              }
            } else if (!active) {
              segmentCursor += 1
              active = {
                segment_index: segmentCursor,
                start_ts: 0,
                end_ts: 0,
                incoming_count: 0,
                outgoing_count: 0,
                first_incoming_ts: 0,
                first_reply_ts: 0,
                anchor_local_id: localId,
                anchor_create_time: 0,
                latest_local_id: localId,
                latest_create_time: 0
              }
            }

            if (isSend) {
              if (active) {
                active.outgoing_count += 1
                if (
                  createTime > 0
                  && active.first_incoming_ts > 0
                  && createTime >= active.first_incoming_ts
                  && active.first_reply_ts <= 0
                ) {
                  active.first_reply_ts = createTime
                }
              }
            } else if (active) {
              active.incoming_count += 1
              if (active.first_incoming_ts <= 0 || (createTime > 0 && createTime < active.first_incoming_ts)) {
                active.first_incoming_ts = createTime
              }
            }

            if (active && createTime > 0) {
              active.end_ts = createTime
              active.latest_create_time = createTime
              active.latest_local_id = localId
              lastMessageTs = createTime
            }
          }
        }
      } finally {
        await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
      }

      commit()
    }

    return segments.sort((a, b) => {
      if (a.start_ts !== b.start_ts) return a.start_ts - b.start_ts
      if (a.session_id !== b.session_id) return a.session_id.localeCompare(b.session_id)
      return a.segment_index - b.segment_index
    })
  }

  async exportMyFootprint(
    beginTimestamp: number,
    endTimestamp: number,
    format: 'csv' | 'json',
    filePath: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const normalizedFormat = String(format || '').toLowerCase() === 'csv' ? 'csv' : 'json'
      const targetPath = String(filePath || '').trim()
      if (!targetPath) {
        return { success: false, error: '导出路径不能为空' }
      }

      const statsResult = await this.getMyFootprintStats(beginTimestamp, endTimestamp)
      if (!statsResult.success || !statsResult.data) {
        return { success: false, error: statsResult.error || '导出前获取统计失败' }
      }

      mkdirSync(dirname(targetPath), { recursive: true })
      if (normalizedFormat === 'json') {
        writeFileSync(targetPath, JSON.stringify(statsResult.data, null, 2), 'utf-8')
      } else {
        const csv = this.buildMyFootprintCsv(statsResult.data)
        writeFileSync(targetPath, `\uFEFF${csv}`, 'utf-8')
      }

      return { success: true, filePath: targetPath }
    } catch (error) {
      console.error('[ChatService] 导出我的足迹失败:', error)
      return { success: false, error: String(error) }
    }
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

  private normalizeTimestampSeconds(value: number): number {
    const numeric = Number(value || 0)
    if (!Number.isFinite(numeric) || numeric <= 0) return 0
    return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric)
  }

  private toSafeInt(value: unknown, fallback = 0): number {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private toSafeNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private resolveFootprintRowIsSend(row: Record<string, any>, myWxid: string): boolean {
    const raw = row.computed_is_send ?? row.is_send
    if (raw === 1 || raw === '1' || raw === true || raw === 'true') return true
    if (raw === 0 || raw === '0' || raw === false || raw === 'false') return false
    const senderUsername = String(row.sender_username || row.senderUsername || '').trim()
    return Boolean(senderUsername && myWxid && senderUsername === myWxid)
  }

  private splitAtUserList(raw: string): string[] {
    const tokens = String(raw || '')
      .split(/[,\s;|]+/g)
      .map((token) => token.trim().replace(/^@+/, '').replace(/^["']+|["']+$/g, ''))
      .filter(Boolean)
    return Array.from(new Set(tokens))
  }

  private containsAtSign(text: string): boolean {
    if (!text) return false
    return text.includes('@') || text.includes('＠')
  }

  private footprintMessageLikelyContainsAt(rawContent: unknown): boolean {
    if (rawContent === null || rawContent === undefined) return false
    const text = typeof rawContent === 'string' ? rawContent : String(rawContent || '')
    return this.containsAtSign(text)
  }

  private matchesMyFootprintIdentity(rawToken: string, identitySet: Set<string>): boolean {
    const token = String(rawToken || '').trim().replace(/^@+/, '')
    if (!token) return false

    const normalizedCandidates = new Set<string>()
    const addCandidate = (value: string) => {
      const normalized = String(value || '').trim().toLowerCase()
      if (!normalized) return
      normalizedCandidates.add(normalized)
    }

    addCandidate(token)
    addCandidate(token.replace(/@chatroom$/i, ''))
    addCandidate(token.replace(/@openim$/i, ''))

    for (const candidate of normalizedCandidates) {
      if (!candidate) continue
      for (const selfId of identitySet) {
        if (!selfId) continue
        if (candidate === selfId) return true
        if (candidate.startsWith(`${selfId}_`) || selfId.startsWith(`${candidate}_`)) return true
      }
    }
    return false
  }

  private buildMyFootprintIdentitySet(myWxid: string): Set<string> {
    const set = new Set<string>()
    const add = (value: string) => {
      const normalized = String(value || '').trim().toLowerCase()
      if (!normalized) return
      set.add(normalized)
    }

    const raw = String(myWxid || '').trim()
    add(raw)
    add(this.cleanAccountDirName(raw))
    for (const key of this.buildIdentityKeys(raw)) {
      add(key)
    }
    return set
  }

  private buildFootprintSourceCandidates(source: unknown): string[] {
    const sourceCandidates: string[] = []
    const seen = new Set<string>()
    const pushCandidate = (value: unknown) => {
      const normalized = this.cleanUtf16(String(value || '').trim())
      if (!normalized) return
      if (seen.has(normalized)) return
      seen.add(normalized)
      sourceCandidates.push(normalized)
    }

    const rawSource = typeof source === 'string'
      ? source
      : Buffer.isBuffer(source) || source instanceof Uint8Array
        ? Buffer.from(source).toString('utf-8')
        : typeof source === 'object' && source !== null && Array.isArray((source as { data?: unknown }).data)
          ? Buffer.from((source as { data: number[] }).data).toString('utf-8')
          : String(source || '')
    const normalizedSource = String(rawSource || '').trim()
    pushCandidate(normalizedSource)
    if (normalizedSource.includes('&')) {
      pushCandidate(this.decodeHtmlEntities(normalizedSource))
    }

    const sourceLooksEncoded = normalizedSource.length > 16
      && (this.looksLikeHex(normalizedSource) || this.looksLikeBase64(normalizedSource))
    if (sourceLooksEncoded) {
      const decodedFromText = this.decodeMaybeCompressed(normalizedSource, 'footprint_source')
      pushCandidate(decodedFromText)
      if (decodedFromText.includes('&')) {
        pushCandidate(this.decodeHtmlEntities(decodedFromText))
      }
    } else if (typeof source !== 'string') {
      const decodedFromBinary = this.decodeMaybeCompressed(source, 'footprint_source')
      pushCandidate(decodedFromBinary)
      if (decodedFromBinary.includes('&')) {
        pushCandidate(this.decodeHtmlEntities(decodedFromBinary))
      }
    }

    return sourceCandidates
  }

  private normalizeFootprintSourceForOutput(source: unknown): string {
    if (source === null || source === undefined) return ''
    if (typeof source === 'string') return source.trim()
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
      return this.decodeBinaryContent(Buffer.from(source), '').trim()
    }
    if (typeof source === 'object' && source !== null && Array.isArray((source as { data?: unknown }).data)) {
      return this.decodeBinaryContent(Buffer.from((source as { data: number[] }).data), '').trim()
    }
    return String(source || '').trim()
  }

  private extractAtUserListTokensFromSource(source: unknown, prebuiltCandidates?: string[]): string[] {
    const tokens = new Set<string>()
    const sourceCandidates = Array.isArray(prebuiltCandidates) && prebuiltCandidates.length > 0
      ? prebuiltCandidates
      : this.buildFootprintSourceCandidates(source)
    const addTokens = (values: string[]) => {
      for (const value of values) {
        const normalized = String(value || '').trim()
        if (!normalized) continue
        tokens.add(normalized)
      }
    }

    const xmlPattern = /<atuserlist[^>]*>([\s\S]*?)<\/atuserlist>/gi
    const cdataPattern = /<!\[CDATA\[([\s\S]*?)\]\]>/i
    for (const candidateSource of sourceCandidates) {
      if (!candidateSource.toLowerCase().includes('atuserlist')) continue

      const trimmedCandidateSource = candidateSource.trim()
      const maybeJson = trimmedCandidateSource.startsWith('{')
        || trimmedCandidateSource.startsWith('[')
        || trimmedCandidateSource.includes('"atuserlist"')
      if (maybeJson) {
        try {
          const parsed = JSON.parse(candidateSource)
          const atUserList = parsed?.atuserlist
          if (Array.isArray(atUserList)) {
            const values = atUserList
              .map((item: unknown) => this.splitAtUserList(String(item || '')))
              .flat()
            addTokens(values)
          }
          if (typeof atUserList === 'string') {
            addTokens(this.splitAtUserList(atUserList))
          }
        } catch {
          // ignore JSON parse error and continue fallback parsing
        }
      }

      const jsonMatch = candidateSource.match(/"atuserlist"\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|[^,}\s]+)/i)
      if (jsonMatch) {
        const jsonCandidate = String(jsonMatch[1] || '').trim()
        if (jsonCandidate.startsWith('[')) {
          try {
            const arr = JSON.parse(jsonCandidate)
            if (Array.isArray(arr)) {
              const values = arr
                .map((item) => this.splitAtUserList(String(item || '')))
                .flat()
              addTokens(values)
            }
          } catch {
            // ignore array parse error
          }
        }
        const unquoted = jsonCandidate.replace(/^["']+|["']+$/g, '')
        addTokens(this.splitAtUserList(unquoted))
      }

      xmlPattern.lastIndex = 0
      let xmlMatch: RegExpExecArray | null
      while ((xmlMatch = xmlPattern.exec(candidateSource)) !== null) {
        let xmlValue = String(xmlMatch[1] || '')
        const cdataMatch = xmlValue.match(cdataPattern)
        if (cdataMatch?.[1]) {
          xmlValue = cdataMatch[1]
        }
        addTokens(this.splitAtUserList(xmlValue))
      }
    }

    return Array.from(tokens)
  }

  private sourceAtUserListContains(source: unknown, myWxid: string): boolean {
    const selfIdentitySet = this.buildMyFootprintIdentitySet(myWxid)
    return this.sourceAtUserListContainsWithIdentitySet(source, selfIdentitySet)
  }

  private sourceAtUserListContainsWithIdentitySet(source: unknown, selfIdentitySet: Set<string>): boolean {
    if (selfIdentitySet.size === 0) return false
    if (typeof source === 'string') {
      const raw = source.trim()
      if (!raw) return false
      const loweredRaw = raw.toLowerCase()
      if (loweredRaw.includes('atuserlist')) {
        for (const identity of selfIdentitySet) {
          if (identity && loweredRaw.includes(identity)) {
            return true
          }
        }
        const quickXmlMatch = raw.match(/<atuserlist[^>]*>([\s\S]*?)<\/atuserlist>/i)
        if (quickXmlMatch?.[1]) {
          const inner = quickXmlMatch[1]
          const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1] || inner
          const quickTokens = this.splitAtUserList(cdata)
          if (quickTokens.some((token) => this.matchesMyFootprintIdentity(token, selfIdentitySet))) {
            return true
          }
        }
      } else if (raw.length <= 16 || (!this.looksLikeHex(raw) && !this.looksLikeBase64(raw))) {
        return false
      }
    }
    const sourceCandidates = this.buildFootprintSourceCandidates(source)
    for (const candidate of sourceCandidates) {
      const normalized = String(candidate || '').toLowerCase()
      if (!normalized || !normalized.includes('atuserlist')) continue
      for (const identity of selfIdentitySet) {
        if (identity && normalized.includes(identity)) {
          return true
        }
      }
    }
    const tokens = this.extractAtUserListTokensFromSource(source, sourceCandidates)
    if (tokens.length === 0) return false
    return tokens.some((token) => this.matchesMyFootprintIdentity(token, selfIdentitySet))
  }

  private async resolveMyFootprintGroupSessionIds(
    groupSessionIds: string[],
    beginTimestamp = 0,
    endTimestamp = 0
  ): Promise<string[]> {
    const normalized = Array.from(new Set(
      (groupSessionIds || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value.endsWith('@chatroom'))
    ))
    const begin = this.normalizeTimestampSeconds(beginTimestamp)
    const end = this.normalizeTimestampSeconds(endTimestamp)
    void begin
    void end

    const merged: string[] = []
    const seen = new Set<string>()
    const sessionLastTsMap = new Map<string, number>()
    const hasSessionRank = new Set<string>()
    const shouldKeepByLastTs = (sessionId: string, preferKeepUnknown: boolean): boolean => {
      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) return false
      const lastTs = this.normalizeTimestampSeconds(sessionLastTsMap.get(normalizedSessionId) || 0)
      const known = hasSessionRank.has(normalizedSessionId)
      if (!known) return preferKeepUnknown || begin <= 0
      if (begin > 0 && lastTs > 0 && lastTs < begin) return false
      return true
    }
    const push = (value: string) => {
      const normalizedValue = String(value || '').trim()
      if (!normalizedValue || !normalizedValue.endsWith('@chatroom')) return
      if (seen.has(normalizedValue)) return
      seen.add(normalizedValue)
      merged.push(normalizedValue)
    }

    try {
      const sessionsResult = await this.getSessions()
      if (sessionsResult.success && Array.isArray(sessionsResult.sessions)) {
        const rankedGroups = sessionsResult.sessions
          .map((session) => {
            const sessionId = String(session?.username || '').trim()
            const lastTs = this.normalizeTimestampSeconds(
              Number(session?.lastTimestamp || session?.sortTimestamp || 0)
            )
            if (sessionId.endsWith('@chatroom')) {
              hasSessionRank.add(sessionId)
              sessionLastTsMap.set(sessionId, lastTs)
            }
            return { sessionId, lastTs }
          })
          .filter((item) => item.sessionId.endsWith('@chatroom'))
          .filter((item) => shouldKeepByLastTs(item.sessionId, false))
          .sort((a, b) => {
            if (a.lastTs !== b.lastTs) return b.lastTs - a.lastTs
            return a.sessionId.localeCompare(b.sessionId)
          })
        for (const item of rankedGroups) {
          push(item.sessionId)
        }
      }
    } catch {
      // ignore session-based scope resolution failure
    }

    try {
      const contactGroups = await this.listMyFootprintGroupSessionIdsFromContact()
      for (const sessionId of contactGroups) {
        if (!shouldKeepByLastTs(sessionId, false)) continue
        push(sessionId)
      }
    } catch {
      // ignore contact-based scope resolution failure
    }

    for (const sessionId of normalized) {
      if (!shouldKeepByLastTs(sessionId, true)) continue
      push(sessionId)
    }

    return merged.length > 0 ? merged : normalized
  }

  private async listMyFootprintGroupSessionIdsFromContact(): Promise<string[]> {
    try {
      const result = await wcdbService.execQuery(
        'contact',
        null,
        "SELECT username FROM contact WHERE username IS NOT NULL AND username != '' AND username LIKE '%@chatroom'"
      )
      if (!result.success || !Array.isArray(result.rows)) {
        return []
      }

      return Array.from(new Set(
        (result.rows as Array<Record<string, any>>)
          .map((row) => String(this.getRowField(row, ['username', 'user_name', 'userName']) || '').trim())
          .filter((value) => value.endsWith('@chatroom'))
      ))
    } catch {
      return []
    }
  }

  private async filterMyFootprintPrivateSessions(privateSessionIds: string[]): Promise<string[]> {
    const normalized = Array.from(new Set(
      (privateSessionIds || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.endsWith('@chatroom'))
    ))
    if (normalized.length === 0) return normalized

    try {
      const officialSessionIds = await this.getMyFootprintOfficialSessionIdSet(normalized)
      if (officialSessionIds.size === 0) return normalized
      return normalized.filter((sessionId) => !officialSessionIds.has(sessionId))
    } catch {
      return normalized
    }
  }

  private async getMyFootprintOfficialSessionIdSet(privateSessionIds: string[]): Promise<Set<string>> {
    const officialSessionIds = new Set<string>()
    const normalized = Array.from(new Set(
      (privateSessionIds || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.endsWith('@chatroom'))
    ))
    if (normalized.length === 0) return officialSessionIds

    for (const sessionId of normalized) {
      if (sessionId.startsWith('gh_')) {
        officialSessionIds.add(sessionId)
      }
    }

    const chunkSize = 320
    const buildInListSql = (values: string[]) => values
      .map((value) => `'${this.escapeSqlString(value)}'`)
      .join(',')

    try {
      const bizInfoTableResult = await wcdbService.execQuery(
        'contact',
        null,
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name)='biz_info' LIMIT 1"
      )
      const bizInfoTableName = bizInfoTableResult.success && Array.isArray(bizInfoTableResult.rows)
        ? String((bizInfoTableResult.rows[0] as Record<string, any> | undefined)?.name || '').trim()
        : ''
      if (bizInfoTableName) {
        const tableSqlName = this.quoteSqlIdentifier(bizInfoTableName)
        for (let index = 0; index < normalized.length; index += chunkSize) {
          const batch = normalized.slice(index, index + chunkSize)
          if (batch.length === 0) continue
          const inListSql = buildInListSql(batch)
          const sql = `SELECT username FROM ${tableSqlName} WHERE username IN (${inListSql})`
          const result = await wcdbService.execQuery('contact', null, sql)
          if (!result.success || !Array.isArray(result.rows)) continue
          for (const row of result.rows as Array<Record<string, any>>) {
            const username = String(this.getRowField(row, ['username', 'user_name', 'userName']) || '').trim()
            if (username) officialSessionIds.add(username)
          }
        }
      }
    } catch {
      // ignore biz_info lookup failure
    }

    try {
      const tableInfo = await wcdbService.execQuery('contact', null, 'PRAGMA table_info(contact)')
      if (tableInfo.success && Array.isArray(tableInfo.rows)) {
        const availableColumns = new Map<string, string>()
        for (const row of tableInfo.rows as Array<Record<string, any>>) {
          const rawName = row.name ?? row.column_name ?? row.columnName
          const name = String(rawName || '').trim()
          if (!name) continue
          availableColumns.set(name.toLowerCase(), name)
        }

        const pickColumn = (candidates: string[]): string | null => {
          for (const candidate of candidates) {
            const actual = availableColumns.get(candidate.toLowerCase())
            if (actual) return actual
          }
          return null
        }

        const usernameColumn = pickColumn(['username', 'user_name', 'userName'])
        const officialFlagColumns = [
          pickColumn(['verify_flag', 'verifyFlag', 'verifyflag']),
          pickColumn(['verify_status', 'verifyStatus']),
          pickColumn(['verify_type', 'verifyType']),
          pickColumn(['biz_type', 'bizType']),
          pickColumn(['brand_flag', 'brandFlag']),
          pickColumn(['service_type', 'serviceType'])
        ].filter((column): column is string => Boolean(column))

        if (usernameColumn && officialFlagColumns.length > 0) {
          const selectColumns = Array.from(new Set([usernameColumn, ...officialFlagColumns]))
          const selectSql = selectColumns.map((column) => this.quoteSqlIdentifier(column)).join(', ')
          for (let index = 0; index < normalized.length; index += chunkSize) {
            const batch = normalized.slice(index, index + chunkSize)
            if (batch.length === 0) continue
            const inListSql = buildInListSql(batch)
            const sql = `SELECT ${selectSql} FROM contact WHERE ${this.quoteSqlIdentifier(usernameColumn)} IN (${inListSql})`
            const result = await wcdbService.execQuery('contact', null, sql)
            if (!result.success || !Array.isArray(result.rows)) continue
            for (const row of result.rows as Array<Record<string, any>>) {
              const username = String(this.getRowField(row, [usernameColumn, 'username', 'user_name', 'userName']) || '').trim()
              if (!username) continue
              const hasOfficialFlag = officialFlagColumns.some((column) => (
                this.isTruthyMyFootprintOfficialFlag(this.getRowField(row, [column]))
              ))
              if (hasOfficialFlag) {
                officialSessionIds.add(username)
              }
            }
          }
        }
      }
    } catch {
      // ignore contact-flag lookup failure
    }

    return officialSessionIds
  }

  private isTruthyMyFootprintOfficialFlag(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) && value > 0

    const normalized = String(value || '').trim().toLowerCase()
    if (!normalized) return false
    if (normalized === '0' || normalized === 'false' || normalized === 'null' || normalized === 'undefined') {
      return false
    }

    const numeric = Number(normalized)
    if (Number.isFinite(numeric)) {
      return numeric > 0
    }
    return true
  }

  private normalizeMyFootprintData(raw: any): MyFootprintData {
    const summaryRaw = raw?.summary || {}
    const privateSessionsRaw = Array.isArray(raw?.private_sessions) ? raw.private_sessions : []
    const privateSegmentsRaw = Array.isArray(raw?.private_segments) ? raw.private_segments : []
    const mentionsRaw = Array.isArray(raw?.mentions) ? raw.mentions : []
    const mentionGroupsRaw = Array.isArray(raw?.mention_groups) ? raw.mention_groups : []
    const diagnosticsRaw = raw?.diagnostics || {}

    const summary: MyFootprintSummary = {
      private_inbound_people: this.toSafeInt(summaryRaw.private_inbound_people, 0),
      private_replied_people: this.toSafeInt(summaryRaw.private_replied_people, 0),
      private_outbound_people: this.toSafeInt(summaryRaw.private_outbound_people, 0),
      private_reply_rate: this.toSafeNumber(summaryRaw.private_reply_rate, 0),
      mention_count: this.toSafeInt(summaryRaw.mention_count, 0),
      mention_group_count: this.toSafeInt(summaryRaw.mention_group_count, 0)
    }

    const private_sessions: MyFootprintPrivateSession[] = privateSessionsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      incoming_count: this.toSafeInt(item?.incoming_count, 0),
      outgoing_count: this.toSafeInt(item?.outgoing_count, 0),
      replied: Boolean(item?.replied),
      first_incoming_ts: this.toSafeInt(item?.first_incoming_ts, 0),
      first_reply_ts: this.toSafeInt(item?.first_reply_ts, 0),
      latest_ts: this.toSafeInt(item?.latest_ts, 0),
      anchor_local_id: this.toSafeInt(item?.anchor_local_id, 0),
      anchor_create_time: this.toSafeInt(item?.anchor_create_time, 0)
    })).filter((item) => item.session_id)

    const private_segments: MyFootprintPrivateSegment[] = privateSegmentsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      segment_index: this.toSafeInt(item?.segment_index, 0),
      start_ts: this.toSafeInt(item?.start_ts, 0),
      end_ts: this.toSafeInt(item?.end_ts, 0),
      duration_sec: this.toSafeInt(item?.duration_sec, 0),
      incoming_count: this.toSafeInt(item?.incoming_count, 0),
      outgoing_count: this.toSafeInt(item?.outgoing_count, 0),
      message_count: this.toSafeInt(item?.message_count, 0),
      replied: Boolean(item?.replied),
      first_incoming_ts: this.toSafeInt(item?.first_incoming_ts, 0),
      first_reply_ts: this.toSafeInt(item?.first_reply_ts, 0),
      latest_ts: this.toSafeInt(item?.latest_ts, 0),
      anchor_local_id: this.toSafeInt(item?.anchor_local_id, 0),
      anchor_create_time: this.toSafeInt(item?.anchor_create_time, 0),
      displayName: String(item?.displayName || '').trim() || undefined,
      avatarUrl: String(item?.avatarUrl || '').trim() || undefined
    })).filter((item) => item.session_id && item.start_ts > 0)

    const mentions: MyFootprintMentionItem[] = mentionsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      local_id: this.toSafeInt(item?.local_id, 0),
      create_time: this.toSafeInt(item?.create_time, 0),
      sender_username: String(item?.sender_username || '').trim(),
      message_content: String(item?.message_content || ''),
      source: String(item?.source || '')
    })).filter((item) => item.session_id)

    const mention_groups: MyFootprintMentionGroup[] = mentionGroupsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      count: this.toSafeInt(item?.count, 0),
      latest_ts: this.toSafeInt(item?.latest_ts, 0)
    })).filter((item) => item.session_id)

    const diagnostics: MyFootprintDiagnostics = {
      truncated: Boolean(diagnosticsRaw.truncated),
      scanned_dbs: this.toSafeInt(diagnosticsRaw.scanned_dbs, 0),
      elapsed_ms: this.toSafeInt(diagnosticsRaw.elapsed_ms, 0),
      mention_truncated: Boolean(diagnosticsRaw.mention_truncated),
      private_truncated: Boolean(diagnosticsRaw.private_truncated)
    }

    return {
      summary,
      private_sessions,
      private_segments,
      mentions,
      mention_groups,
      diagnostics
    }
  }

  private filterMyFootprintMentionsBySource(data: MyFootprintData, myWxid: string, mentionLimit: number): MyFootprintData {
    const identitySet = this.buildMyFootprintIdentitySet(myWxid)
    if (identitySet.size === 0) {
      return {
        ...data,
        summary: {
          ...data.summary,
          mention_count: 0,
          mention_group_count: 0
        },
        mentions: [],
        mention_groups: []
      }
    }

    const sourceMatchCache = new Map<string, boolean>()
    const filteredMentions = data.mentions.filter((item) => {
      const sourceKey = String(item.source || '')
      const cachedMatched = sourceMatchCache.get(sourceKey)
      if (cachedMatched !== undefined) return cachedMatched
      const matched = this.sourceAtUserListContainsWithIdentitySet(item.source, identitySet)
      if (sourceMatchCache.size < 4096) {
        sourceMatchCache.set(sourceKey, matched)
      }
      return matched
    })
      .sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time - a.create_time
        return b.local_id - a.local_id
      })

    let truncatedByFrontendLimit = false
    if (mentionLimit > 0 && filteredMentions.length > mentionLimit) {
      filteredMentions.length = mentionLimit
      truncatedByFrontendLimit = true
    }

    const mentionGroupMap = new Map<string, MyFootprintMentionGroup>()
    for (const mention of filteredMentions) {
      const group = mentionGroupMap.get(mention.session_id) || {
        session_id: mention.session_id,
        count: 0,
        latest_ts: 0
      }
      group.count += 1
      if (mention.create_time > group.latest_ts) group.latest_ts = mention.create_time
      mentionGroupMap.set(mention.session_id, group)
    }

    const filteredMentionGroups = Array.from(mentionGroupMap.values())
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
        return a.session_id.localeCompare(b.session_id)
      })

    const nextSummary: MyFootprintSummary = {
      ...data.summary,
      mention_count: filteredMentions.length,
      mention_group_count: filteredMentionGroups.length
    }

    return {
      ...data,
      summary: nextSummary,
      mentions: filteredMentions,
      mention_groups: filteredMentionGroups,
      diagnostics: {
        ...data.diagnostics,
        truncated: Boolean(data.diagnostics.truncated || truncatedByFrontendLimit)
      }
    }
  }

  private mergeMyFootprintMentionResult(base: MyFootprintData, mentionResult: MyFootprintData): MyFootprintData {
    const mentionMap = new Map<string, MyFootprintMentionItem>()
    const pushMention = (item: MyFootprintMentionItem) => {
      const key = `${item.session_id}#${item.local_id}#${item.create_time}`
      mentionMap.set(key, item)
    }
    for (const item of base.mentions) pushMention(item)
    for (const item of mentionResult.mentions) pushMention(item)

    const mergedMentions = Array.from(mentionMap.values())
      .sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time - a.create_time
        return b.local_id - a.local_id
      })

    const mentionGroupMetaMap = new Map<string, Pick<MyFootprintMentionGroup, 'displayName' | 'avatarUrl'>>()
    const pushGroupMeta = (group: MyFootprintMentionGroup) => {
      const prev = mentionGroupMetaMap.get(group.session_id) || {}
      mentionGroupMetaMap.set(group.session_id, {
        displayName: group.displayName || prev.displayName,
        avatarUrl: group.avatarUrl || prev.avatarUrl
      })
    }
    for (const group of base.mention_groups) pushGroupMeta(group)
    for (const group of mentionResult.mention_groups) pushGroupMeta(group)

    const mentionGroupMap = new Map<string, MyFootprintMentionGroup>()
    for (const mention of mergedMentions) {
      const current = mentionGroupMap.get(mention.session_id) || {
        session_id: mention.session_id,
        count: 0,
        latest_ts: 0
      }
      current.count += 1
      if (mention.create_time > current.latest_ts) {
        current.latest_ts = mention.create_time
      }
      mentionGroupMap.set(mention.session_id, current)
    }

    const mergedMentionGroups = Array.from(mentionGroupMap.values())
      .map((group) => {
        const meta = mentionGroupMetaMap.get(group.session_id)
        return {
          ...group,
          displayName: meta?.displayName,
          avatarUrl: meta?.avatarUrl
        }
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
        return a.session_id.localeCompare(b.session_id)
      })

    return {
      ...base,
      summary: {
        ...base.summary,
        mention_count: mergedMentions.length,
        mention_group_count: mergedMentionGroups.length
      },
      private_segments: mentionResult.private_segments.length > 0
        ? mentionResult.private_segments
        : base.private_segments,
      mentions: mergedMentions,
      mention_groups: mergedMentionGroups,
      diagnostics: {
        ...base.diagnostics,
        truncated: Boolean(base.diagnostics.truncated || mentionResult.diagnostics.truncated),
        scanned_dbs: Math.max(base.diagnostics.scanned_dbs || 0, mentionResult.diagnostics.scanned_dbs || 0),
        elapsed_ms: Math.max(base.diagnostics.elapsed_ms || 0, mentionResult.diagnostics.elapsed_ms || 0)
      }
    }
  }

  private shouldRunMyFootprintHeavyDebug(): boolean {
    const flag = String(process.env.WEFLOW_MY_FOOTPRINT_DEBUG || '').trim().toLowerCase()
    return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
  }

  private async logMyFootprintZeroMentionDebug(params: {
    begin: number
    end: number
    myWxid: string
    groupSessionIds: string[]
    nativeData: MyFootprintData
  }): Promise<void> {
    try {
      const identityKeySet = this.buildMyFootprintIdentitySet(params.myWxid)
      const identitySet = Array.from(identityKeySet)
      console.warn(
        `[MyFootprint][debug] zero mentions: myWxid=${params.myWxid} identityKeys=${identitySet.join('|')} groups=${params.groupSessionIds.length} nativeMentions=${params.nativeData.mentions.length} nativeMentionGroups=${params.nativeData.mention_groups.length} scannedDbs=${params.nativeData.diagnostics.scanned_dbs}`
      )

      if (params.nativeData.mentions.length > 0) {
        const samples = params.nativeData.mentions.slice(0, 5).map((item) => {
          const tokens = this.extractAtUserListTokensFromSource(item.source)
          const matched = tokens.some((token) => this.matchesMyFootprintIdentity(token, identityKeySet))
          return {
            sessionId: item.session_id,
            localId: item.local_id,
            createTime: item.create_time,
            tokens,
            matched
          }
        })
        console.warn(`[MyFootprint][debug] native mention samples=${JSON.stringify(samples)}`)
      }

      const allGroups = params.groupSessionIds
      console.warn(`[MyFootprint][debug] start group scan: totalGroups=${allGroups.length}`)
      let skippedNoTableGroups = 0
      let sqlProbeCount = 0
      let nativeSingleProbeCount = 0
      for (let index = 0; index < allGroups.length; index += 1) {
        const sessionId = allGroups[index]
        const cursorResult = await wcdbService.openMessageCursorLite(
          sessionId,
          120,
          false,
          params.begin,
          params.end
        )
        if (!cursorResult.success || !cursorResult.cursor) {
          const openCursorError = String(cursorResult.error || 'unknown')
          if (openCursorError.includes('-3')) {
            skippedNoTableGroups += 1
            console.warn(`[MyFootprint][debug][${index + 1}/${allGroups.length}][${sessionId}] skipped(no message table): ${openCursorError}`)
          } else {
            console.warn(`[MyFootprint][debug][${index + 1}/${allGroups.length}][${sessionId}] open cursor failed: ${openCursorError}`)
          }
          continue
        }

        let rows = 0
        let atContentRows = 0
        let sourcePresentRows = 0
        let atUserListRows = 0
        let matchedRows = 0
        const unmatchedSamples: Array<{
          localId: number
          createTime: number
          tokens: string[]
          sourcePreview: string
        }> = []

        let hasMore = true
        try {
          while (hasMore && rows < 200) {
            const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
            if (!batchResult.success || !Array.isArray(batchResult.rows)) {
              break
            }
            hasMore = Boolean(batchResult.hasMore)
            for (const row of batchResult.rows as Array<Record<string, any>>) {
              rows += 1
              if (rows > 200) break

              const messageContentRaw = row.message_content ?? row.messageContent ?? row.content
              const hasAtInContent = this.footprintMessageLikelyContainsAt(messageContentRaw)
              if (hasAtInContent) atContentRows += 1

              const sourceRaw = row.source ?? row.msg_source ?? row.message_source
              if (sourceRaw !== null && sourceRaw !== undefined && String(sourceRaw).trim().length > 0) {
                sourcePresentRows += 1
              }
              if (!hasAtInContent) continue

              const tokens = this.extractAtUserListTokensFromSource(sourceRaw)
              if (tokens.length > 0) atUserListRows += 1
              const matched = tokens.some((token) => this.matchesMyFootprintIdentity(token, identityKeySet))
              if (matched) {
                matchedRows += 1
              } else if (tokens.length > 0 && unmatchedSamples.length < 3) {
                const sourceDecoded = this.decodeMaybeCompressed(sourceRaw, 'footprint_source') || String(sourceRaw || '')
                unmatchedSamples.push({
                  localId: this.toSafeInt(row.local_id, 0),
                  createTime: this.toSafeInt(row.create_time, 0),
                  tokens,
                  sourcePreview: sourceDecoded.replace(/\s+/g, ' ').slice(0, 260)
                })
              }
            }
          }
        } finally {
          await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
        }

        console.warn(
          `[MyFootprint][debug][${index + 1}/${allGroups.length}][${sessionId}] rows=${rows} atContentRows=${atContentRows} sourcePresentRows=${sourcePresentRows} atUserListRows=${atUserListRows} matchedRows=${matchedRows}`
        )
        if (unmatchedSamples.length > 0) {
          console.warn(`[MyFootprint][debug][${sessionId}] unmatchedSamples=${JSON.stringify(unmatchedSamples)}`)
        }

        if ((matchedRows > 0 || atContentRows > 0 || atUserListRows > 0) && sqlProbeCount < 6) {
          sqlProbeCount += 1
          await this.logMyFootprintNativeSqlProbe(sessionId, params.begin, params.end)
        }
        if (matchedRows > 0 && nativeSingleProbeCount < 4) {
          nativeSingleProbeCount += 1
          await this.logMyFootprintNativeSingleGroupProbe(sessionId, params.begin, params.end, params.myWxid)
        }
      }
      if (skippedNoTableGroups > 0) {
        console.warn(`[MyFootprint][debug] skippedNoTableGroups=${skippedNoTableGroups}/${allGroups.length}`)
      }
    } catch (error) {
      console.warn('[MyFootprint][debug] zero mention diagnostics failed:', error)
    }
  }

  private async printMyFootprintNativeLogs(tag: string): Promise<void> {
    try {
      const logsResult = await wcdbService.getLogs()
      if (!logsResult.success || !Array.isArray(logsResult.logs)) {
        console.warn(`[MyFootprint][native-log][${tag}] getLogs failed: ${logsResult.error || 'unknown'}`)
        return
      }

      const logs = logsResult.logs
        .map((line) => String(line || '').trim())
        .filter(Boolean)
      const keywords = [
        'wcdb_get_my_footprint_stats',
        'message_db_cache_refresh',
        'open_message_cursor',
        'open_message_cursor_lite',
        'cursor_init',
        'schema mismatch',
        'no message db',
        'get_sessions'
      ]
      const related = logs.filter((line) => {
        const lowered = line.toLowerCase()
        return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()))
      })

      console.warn(
        `[MyFootprint][native-log][${tag}] total=${logs.length} related=${related.length}`
      )
      const tail = related.slice(-240)
      for (const line of tail) {
        console.warn(`[MyFootprint][native-log] ${line}`)
      }
    } catch (error) {
      console.warn(`[MyFootprint][native-log][${tag}] exception:`, error)
    }
  }

  private async logMyFootprintNativeSqlProbe(sessionId: string, begin: number, end: number): Promise<void> {
    try {
      const tables = await this.getSessionMessageTables(sessionId)
      if (!Array.isArray(tables) || tables.length === 0) {
        console.warn(`[MyFootprint][sql-probe][${sessionId}] no tables`)
        return
      }

      const beginTs = this.normalizeTimestampSeconds(begin)
      const endTs = this.normalizeTimestampSeconds(end)
      const clauseTime = [
        beginTs > 0 ? `"create_time" >= ${beginTs}` : '',
        endTs > 0 ? `"create_time" <= ${endTs}` : ''
      ].filter(Boolean).join(' AND ')
      const whereParts: string[] = []
      if (clauseTime) whereParts.push(clauseTime)
      whereParts.push(`"source" IS NOT NULL`)
      whereParts.push(`"source" != ''`)
      whereParts.push(`(("message_content" IS NOT NULL AND "message_content" != '' AND (instr("message_content", '@') > 0 OR instr("message_content", '＠') > 0)) OR instr(lower("source"), 'atuserlist') > 0)`)
      const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : ''

      let total = 0
      for (const table of tables) {
        const tableName = String(table.tableName || '').trim()
        const dbPath = String(table.dbPath || '').trim()
        if (!tableName || !dbPath) continue
        const sql = `SELECT COUNT(1) AS cnt FROM ${this.quoteSqlIdentifier(tableName)}${whereSql}`
        const result = await wcdbService.execQuery('message', dbPath, sql)
        if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) {
          console.warn(`[MyFootprint][sql-probe][${sessionId}] query failed db=${dbPath} table=${tableName} err=${result.error || 'unknown'}`)
          continue
        }
        const cnt = this.toSafeInt((result.rows[0] as Record<string, any>).cnt, 0)
        total += cnt
        if (cnt > 0) {
          console.warn(`[MyFootprint][sql-probe][${sessionId}] db=${dbPath} table=${tableName} cnt=${cnt}`)
        }
      }
      console.warn(`[MyFootprint][sql-probe][${sessionId}] total=${total}`)
    } catch (error) {
      console.warn(`[MyFootprint][sql-probe][${sessionId}] exception:`, error)
    }
  }

  private async logMyFootprintNativeSingleGroupProbe(sessionId: string, begin: number, end: number, myWxid: string): Promise<void> {
    try {
      const probeResult = await wcdbService.getMyFootprintStats({
        beginTimestamp: begin,
        endTimestamp: end,
        myWxid,
        privateSessionIds: [],
        groupSessionIds: [sessionId],
        mentionLimit: 0,
        privateLimit: 0,
        mentionMode: 'text_at_me'
      })
      if (!probeResult.success || !probeResult.data) {
        console.warn(`[MyFootprint][single-native][${sessionId}] failed err=${probeResult.error || 'unknown'}`)
        return
      }

      const raw = this.normalizeMyFootprintData(probeResult.data)
      const first = raw.mentions[0]
      console.warn(
        `[MyFootprint][single-native][${sessionId}] mentions=${raw.mentions.length} groups=${raw.mention_groups.length} truncated=${raw.diagnostics.truncated} firstLocalId=${first?.local_id || 0} firstTs=${first?.create_time || 0}`
      )
    } catch (error) {
      console.warn(`[MyFootprint][single-native][${sessionId}] exception:`, error)
    }
  }

  private async getMyFootprintStatsByCursorFallback(params: {
    begin: number
    end: number
    myWxid: string
    privateSessionIds: string[]
    groupSessionIds: string[]
    mentionLimit: number
    privateLimit: number
    skipPrivateScan?: boolean
    mentionScanLimitPerGroup?: number
  }): Promise<{ success: boolean; data?: MyFootprintData; error?: string }> {
    const startedAt = Date.now()
    let truncated = false

    try {
      const privateSessionMap = new Map<string, MyFootprintPrivateSession>()
      type PrivateSegmentWorking = {
        segment_index: number
        start_ts: number
        end_ts: number
        incoming_count: number
        outgoing_count: number
        first_incoming_ts: number
        first_reply_ts: number
        anchor_local_id: number
        anchor_create_time: number
        latest_local_id: number
        latest_create_time: number
      }
      const privateSegments: MyFootprintPrivateSegment[] = []
      const mentionGroupsMap = new Map<string, MyFootprintMentionGroup>()
      const mentions: MyFootprintMentionItem[] = []
      const mentionIdentitySet = this.buildMyFootprintIdentitySet(params.myWxid)
      const mentionSourceMatchCache = new Map<string, boolean>()
      const mentionScanLimit = Number.isFinite(params.mentionScanLimitPerGroup as number)
        ? Math.max(60, Math.floor(Number(params.mentionScanLimitPerGroup)))
        : Math.max(params.mentionLimit * 12, 4000)
      const privateScanLimitPerSession = Math.max(
        120,
        Math.min(
          600,
          Math.floor((params.privateLimit * 2) / Math.max(params.privateSessionIds.length || 1, 1))
        )
      )
      const privateBatchSize = Math.min(200, privateScanLimitPerSession)
      const privateSessionGapSeconds = 10 * 60
      const mentionBatchSize = 360
      const skipPrivateScan = params.skipPrivateScan === true

      if (!skipPrivateScan) for (const sessionId of params.privateSessionIds) {
        const cursorResult = await wcdbService.openMessageCursorLite(
          sessionId,
          privateBatchSize,
          true,
          params.begin,
          params.end
        )
        if (!cursorResult.success || !cursorResult.cursor) continue

        const stat: MyFootprintPrivateSession = {
          session_id: sessionId,
          incoming_count: 0,
          outgoing_count: 0,
          replied: false,
          first_incoming_ts: 0,
          first_reply_ts: 0,
          latest_ts: 0,
          anchor_local_id: 0,
          anchor_create_time: 0
        }
        let segmentCursor = 0
        let activeSegment: PrivateSegmentWorking | null = null
        let lastSegmentMessageTs = 0
        const commitActiveSegment = () => {
          if (!activeSegment) return

          const normalizedStart = activeSegment.start_ts > 0 ? activeSegment.start_ts : activeSegment.anchor_create_time
          const normalizedEnd = activeSegment.end_ts > 0 ? activeSegment.end_ts : normalizedStart
          const incomingCount = Math.max(0, activeSegment.incoming_count)
          const outgoingCount = Math.max(0, activeSegment.outgoing_count)
          const messageCount = incomingCount + outgoingCount
          if (normalizedStart > 0 && messageCount > 0) {
            privateSegments.push({
              session_id: sessionId,
              segment_index: activeSegment.segment_index,
              start_ts: normalizedStart,
              end_ts: normalizedEnd,
              duration_sec: Math.max(0, normalizedEnd - normalizedStart),
              incoming_count: incomingCount,
              outgoing_count: outgoingCount,
              message_count: messageCount,
              replied: incomingCount > 0 && outgoingCount > 0,
              first_incoming_ts: activeSegment.first_incoming_ts,
              first_reply_ts: activeSegment.first_reply_ts,
              latest_ts: normalizedEnd,
              anchor_local_id: activeSegment.anchor_local_id,
              anchor_create_time: normalizedStart
            })
          }
          activeSegment = null
        }

        let processed = 0
        let hasMore = true
        try {
          while (hasMore) {
            const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
            if (!batchResult.success || !Array.isArray(batchResult.rows)) {
              break
            }
            hasMore = Boolean(batchResult.hasMore)
            for (const row of batchResult.rows as Array<Record<string, any>>) {
              if (processed >= privateScanLimitPerSession) {
                if (hasMore || batchResult.rows.length > 0) truncated = true
                hasMore = false
                break
              }
              processed += 1

              const createTime = this.toSafeInt(row.create_time, 0)
              const localId = this.toSafeInt(row.local_id, 0)
              const isSend = this.resolveFootprintRowIsSend(row, params.myWxid)

              if (createTime > 0) {
                const startNewSegment = !activeSegment
                  || (lastSegmentMessageTs > 0 && createTime - lastSegmentMessageTs > privateSessionGapSeconds)
                if (startNewSegment) {
                  commitActiveSegment()
                  segmentCursor += 1
                  activeSegment = {
                    segment_index: segmentCursor,
                    start_ts: createTime,
                    end_ts: createTime,
                    incoming_count: 0,
                    outgoing_count: 0,
                    first_incoming_ts: 0,
                    first_reply_ts: 0,
                    anchor_local_id: localId,
                    anchor_create_time: createTime,
                    latest_local_id: localId,
                    latest_create_time: createTime
                  }
                }
              } else if (!activeSegment) {
                segmentCursor += 1
                activeSegment = {
                  segment_index: segmentCursor,
                  start_ts: 0,
                  end_ts: 0,
                  incoming_count: 0,
                  outgoing_count: 0,
                  first_incoming_ts: 0,
                  first_reply_ts: 0,
                  anchor_local_id: localId,
                  anchor_create_time: 0,
                  latest_local_id: localId,
                  latest_create_time: 0
                }
              }

              if (isSend) {
                stat.outgoing_count += 1
                if (
                  createTime > 0
                  && stat.first_incoming_ts > 0
                  && createTime >= stat.first_incoming_ts
                  && stat.first_reply_ts <= 0
                ) {
                  stat.first_reply_ts = createTime
                }
                if (activeSegment) {
                  activeSegment.outgoing_count += 1
                  if (
                    createTime > 0
                    && activeSegment.first_incoming_ts > 0
                    && createTime >= activeSegment.first_incoming_ts
                    && activeSegment.first_reply_ts <= 0
                  ) {
                    activeSegment.first_reply_ts = createTime
                  }
                }
              } else {
                stat.incoming_count += 1
                if (stat.first_incoming_ts <= 0 || (createTime > 0 && createTime < stat.first_incoming_ts)) {
                  stat.first_incoming_ts = createTime
                }
                if (activeSegment) {
                  activeSegment.incoming_count += 1
                  if (activeSegment.first_incoming_ts <= 0 || (createTime > 0 && createTime < activeSegment.first_incoming_ts)) {
                    activeSegment.first_incoming_ts = createTime
                  }
                }
              }

              if (stat.latest_ts <= 0 || createTime > stat.latest_ts || (createTime === stat.latest_ts && localId > stat.anchor_local_id)) {
                stat.latest_ts = createTime
                stat.anchor_local_id = localId
                stat.anchor_create_time = createTime
              }

              if (activeSegment && createTime > 0) {
                activeSegment.end_ts = createTime
                activeSegment.latest_create_time = createTime
                activeSegment.latest_local_id = localId
                lastSegmentMessageTs = createTime
              }
            }
          }
          if (hasMore) truncated = true
        } finally {
          await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
        }
        commitActiveSegment()
        stat.replied = stat.incoming_count > 0 && stat.outgoing_count > 0

        if (stat.incoming_count > 0 || stat.outgoing_count > 0 || stat.latest_ts > 0) {
          privateSessionMap.set(sessionId, stat)
        }
      }

      for (const sessionId of params.groupSessionIds) {
        if (mentions.length >= params.mentionLimit) {
          truncated = true
          break
        }
        const cursorResult = await wcdbService.openMessageCursorLite(
          sessionId,
          mentionBatchSize,
          false,
          params.begin,
          params.end
        )
        if (!cursorResult.success || !cursorResult.cursor) continue

        let scanned = 0
        let hasMore = true
        try {
          while (hasMore && scanned < mentionScanLimit) {
            const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
            if (!batchResult.success || !Array.isArray(batchResult.rows)) {
              break
            }
            hasMore = Boolean(batchResult.hasMore)
            for (const row of batchResult.rows as Array<Record<string, any>>) {
              if (mentions.length >= params.mentionLimit) {
                truncated = true
                hasMore = false
                break
              }
              scanned += 1
              const messageContentRaw = row.message_content ?? row.messageContent ?? row.content
              if (!this.footprintMessageLikelyContainsAt(messageContentRaw)) continue
              const sourceRaw = row.source ?? row.msg_source ?? row.message_source
              let sourceMatched = false
              if (typeof sourceRaw === 'string') {
                const sourceKey = sourceRaw
                const cachedMatched = mentionSourceMatchCache.get(sourceKey)
                if (cachedMatched !== undefined) {
                  sourceMatched = cachedMatched
                } else {
                  sourceMatched = this.sourceAtUserListContainsWithIdentitySet(sourceRaw, mentionIdentitySet)
                  if (mentionSourceMatchCache.size < 8192) {
                    mentionSourceMatchCache.set(sourceKey, sourceMatched)
                  }
                }
              } else {
                sourceMatched = this.sourceAtUserListContainsWithIdentitySet(sourceRaw, mentionIdentitySet)
              }
              if (!sourceMatched) continue
              const normalizedSource = this.normalizeFootprintSourceForOutput(sourceRaw)

              let senderUsername = String(row.sender_username || row.senderUsername || '').trim()
              if (!senderUsername && row._db_path && row.real_sender_id) {
                senderUsername = await this.resolveMessageSenderUsernameById(
                  String(row._db_path),
                  row.real_sender_id
                ) || ''
              }

              const mention: MyFootprintMentionItem = {
                session_id: sessionId,
                local_id: this.toSafeInt(row.local_id, 0),
                create_time: this.toSafeInt(row.create_time, 0),
                sender_username: senderUsername,
                message_content: String(row.message_content || row.messageContent || ''),
                source: normalizedSource
              }
              mentions.push(mention)

              const group = mentionGroupsMap.get(sessionId) || {
                session_id: sessionId,
                count: 0,
                latest_ts: 0
              }
              group.count += 1
              if (mention.create_time > group.latest_ts) group.latest_ts = mention.create_time
              mentionGroupsMap.set(sessionId, group)
            }
          }
          if (hasMore || scanned >= mentionScanLimit) {
            truncated = true
          }
        } finally {
          await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
        }
      }

      mentions.sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time - a.create_time
        return b.local_id - a.local_id
      })
      if (mentions.length > params.mentionLimit) {
        mentions.length = params.mentionLimit
        truncated = true
      }

      const private_sessions = Array.from(privateSessionMap.values())
        .sort((a, b) => {
          if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
          return a.session_id.localeCompare(b.session_id)
        })
      const private_segments = [...privateSegments]
        .sort((a, b) => {
          if (a.start_ts !== b.start_ts) return a.start_ts - b.start_ts
          if (a.session_id !== b.session_id) return a.session_id.localeCompare(b.session_id)
          return a.segment_index - b.segment_index
        })
      const mention_groups = Array.from(mentionGroupsMap.values())
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count
          if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
          return a.session_id.localeCompare(b.session_id)
        })

      const private_inbound_people = private_sessions.filter((item) => item.incoming_count > 0).length
      const private_replied_people = private_sessions.filter((item) => item.replied).length
      const private_outbound_people = private_sessions.filter((item) => item.outgoing_count > 0).length
      const mention_count = mention_groups.reduce((sum, item) => sum + item.count, 0)
      const mention_group_count = mention_groups.length

      const summary: MyFootprintSummary = {
        private_inbound_people,
        private_replied_people,
        private_outbound_people,
        private_reply_rate: private_inbound_people > 0 ? private_replied_people / private_inbound_people : 0,
        mention_count,
        mention_group_count
      }

      const diagnostics: MyFootprintDiagnostics = {
        truncated,
        scanned_dbs: 0,
        elapsed_ms: Math.max(0, Date.now() - startedAt)
      }

      return {
        success: true,
        data: {
          summary,
          private_sessions,
          private_segments,
          mentions,
          mention_groups,
          diagnostics
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  private async enrichMyFootprintData(data: MyFootprintData): Promise<MyFootprintData> {
    try {
      const sessionIds = Array.from(new Set([
        ...data.private_sessions.map((item) => item.session_id),
        ...data.private_segments.map((item) => item.session_id),
        ...data.mention_groups.map((item) => item.session_id),
        ...data.mentions.map((item) => item.session_id)
      ].filter(Boolean)))
      const senderUsernames = Array.from(new Set(
        data.mentions
          .map((item) => item.sender_username)
          .filter((value) => String(value || '').trim())
      ))

      const usernames = Array.from(new Set([...sessionIds, ...senderUsernames]))
      if (usernames.length === 0) return data

      const enrichResult = await this.enrichSessionsContactInfo(usernames)
      if (!enrichResult.success || !enrichResult.contacts) return data
      const contacts = enrichResult.contacts

      const nextPrivateSessions = data.private_sessions.map((item) => {
        const contact = contacts[item.session_id]
        return {
          ...item,
          displayName: contact?.displayName || item.displayName,
          avatarUrl: contact?.avatarUrl || item.avatarUrl
        }
      })
      const nextPrivateSegments = data.private_segments.map((item) => {
        const contact = contacts[item.session_id]
        return {
          ...item,
          displayName: contact?.displayName || item.displayName,
          avatarUrl: contact?.avatarUrl || item.avatarUrl
        }
      })

      const nextMentionGroups = data.mention_groups.map((item) => {
        const contact = contacts[item.session_id]
        return {
          ...item,
          displayName: contact?.displayName || item.displayName,
          avatarUrl: contact?.avatarUrl || item.avatarUrl
        }
      })

      const nextMentions = await Promise.all(data.mentions.map(async (item) => {
        const sessionContact = contacts[item.session_id]
        const senderContact = item.sender_username ? contacts[item.sender_username] : undefined

        let normalizedContent = this.normalizeMyFootprintMentionContent(item.message_content)
        if (this.isLikelyUnreadableFootprintContent(normalizedContent) && item.session_id && item.local_id > 0) {
          const detailResult = await this.getMessageById(item.session_id, item.local_id)
          if (detailResult.success && detailResult.message) {
            const detailMessage = detailResult.message
            const detailRaw = String(
              detailMessage.rawContent
              || detailMessage.content
              || detailMessage.parsedContent
              || ''
            )
            const resolvedFromDetail = this.normalizeMyFootprintMentionContent(detailRaw)
            if (resolvedFromDetail && !this.isLikelyUnreadableFootprintContent(resolvedFromDetail)) {
              normalizedContent = resolvedFromDetail
            } else {
              const parsedFallback = String(detailMessage.parsedContent || '').trim()
              if (parsedFallback && !this.isLikelyUnreadableFootprintContent(parsedFallback)) {
                normalizedContent = parsedFallback
              }
            }
          }
        }

        return {
          ...item,
          message_content: normalizedContent,
          sessionDisplayName: sessionContact?.displayName || item.sessionDisplayName,
          senderDisplayName: senderContact?.displayName || item.senderDisplayName || item.sender_username,
          senderAvatarUrl: senderContact?.avatarUrl || item.senderAvatarUrl
        }
      }))

      return {
        ...data,
        private_sessions: nextPrivateSessions,
        private_segments: nextPrivateSegments,
        mention_groups: nextMentionGroups,
        mentions: nextMentions
      }
    } catch (error) {
      console.error('[ChatService] 补充我的足迹展示信息失败:', error)
      return data
    }
  }

  private normalizeMyFootprintMentionContent(rawContent: unknown): string {
    const decodedRaw = this.decodeMaybeCompressed(rawContent, 'footprint_message_content')
    let content = String(decodedRaw || rawContent || '')
    if (!content) return ''

    content = this.cleanUtf16(this.decodeHtmlEntities(content)).trim()
    if (!content) return ''

    const looksLikeXml = content.includes('<appmsg')
      || content.includes('&lt;appmsg')
      || content.includes('<msg')
      || content.includes('&lt;msg')

    if (looksLikeXml) {
      const xml = this.decodeHtmlEntities(content)
      const type49Info = this.parseType49Message(xml)

      if (type49Info.appMsgKind === 'quote') {
        const title = this.stripSenderPrefix(this.extractXmlValue(xml, 'title'))
        const quotedSender = String(type49Info.quotedSender || '').trim()
        const quotedContent = this.sanitizeQuotedContent(String(type49Info.quotedContent || '').trim())
        if (title) {
          if (quotedContent) {
            return `${title}\n\n引用：${quotedSender ? `${quotedSender}：` : ''}${quotedContent}`
          }
          return title
        }
        if (quotedContent) {
          return quotedSender ? `${quotedSender}：${quotedContent}` : quotedContent
        }
      }

      const parsed = this.parseMessageContent(xml, 49)
      const normalizedParsed = this.stripSenderPrefix(String(parsed || '').trim())
      if (normalizedParsed && normalizedParsed !== '[链接]' && normalizedParsed !== '[消息]') {
        return normalizedParsed
      }

      const xmlTitle = this.stripSenderPrefix(this.extractXmlValue(xml, 'title'))
      if (xmlTitle) return xmlTitle
    }

    return this.stripSenderPrefix(content)
  }

  private isLikelyUnreadableFootprintContent(content: string): boolean {
    const text = String(content || '').trim()
    if (!text) return false
    const compact = this.compactEncodedPayload(text)
    if (compact.length <= 80) return false
    if (this.looksLikeHex(compact)) return true
    if (this.looksLikeBase64(compact) && !compact.includes('<') && !compact.includes('>')) return true
    return false
  }

  private formatFootprintTime(timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
    const date = new Date(timestamp * 1000)
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    const hh = `${date.getHours()}`.padStart(2, '0')
    const mm = `${date.getMinutes()}`.padStart(2, '0')
    const ss = `${date.getSeconds()}`.padStart(2, '0')
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
  }

  private escapeCsvCell(value: unknown): string {
    const text = String(value ?? '')
    if (!text) return ''
    if (!/[",\n\r]/.test(text)) return text
    return `"${text.replace(/"/g, '""')}"`
  }

  private buildMyFootprintCsv(data: MyFootprintData): string {
    const lines: string[] = []
    const pushRow = (...columns: unknown[]) => {
      lines.push(columns.map((value) => this.escapeCsvCell(value)).join(','))
    }

    pushRow('模块', '指标', '数值')
    pushRow('summary', '私聊找我人数', data.summary.private_inbound_people)
    pushRow('summary', '我回复人数', data.summary.private_replied_people)
    pushRow('summary', '我主动联系人数', data.summary.private_outbound_people)
    pushRow('summary', '私聊回复率', data.summary.private_reply_rate)
    pushRow('summary', '@我次数', data.summary.mention_count)
    pushRow('summary', '@我群聊数', data.summary.mention_group_count)
    pushRow('summary', '诊断:是否截断', data.diagnostics.truncated ? 'true' : 'false')
    pushRow('summary', '诊断:扫描分库数', data.diagnostics.scanned_dbs)
    pushRow('summary', '诊断:耗时ms', data.diagnostics.elapsed_ms)

    lines.push('')
    pushRow('private_sessions', 'session_id', 'display_name', 'incoming_count', 'outgoing_count', 'replied', 'first_incoming_ts', 'first_reply_ts', 'latest_ts', 'anchor_local_id', 'anchor_create_time')
    for (const row of data.private_sessions) {
      pushRow(
        'private_sessions',
        row.session_id,
        row.displayName || '',
        row.incoming_count,
        row.outgoing_count,
        row.replied ? 'true' : 'false',
        this.formatFootprintTime(row.first_incoming_ts),
        this.formatFootprintTime(row.first_reply_ts),
        this.formatFootprintTime(row.latest_ts),
        row.anchor_local_id,
        row.anchor_create_time
      )
    }

    lines.push('')
    pushRow(
      'private_segments',
      'session_id',
      'display_name',
      'segment_index',
      'start_ts',
      'end_ts',
      'duration_sec',
      'incoming_count',
      'outgoing_count',
      'message_count',
      'replied',
      'first_incoming_ts',
      'first_reply_ts',
      'latest_ts',
      'anchor_local_id',
      'anchor_create_time'
    )
    for (const row of data.private_segments) {
      pushRow(
        'private_segments',
        row.session_id,
        row.displayName || '',
        row.segment_index,
        this.formatFootprintTime(row.start_ts),
        this.formatFootprintTime(row.end_ts),
        row.duration_sec,
        row.incoming_count,
        row.outgoing_count,
        row.message_count,
        row.replied ? 'true' : 'false',
        this.formatFootprintTime(row.first_incoming_ts),
        this.formatFootprintTime(row.first_reply_ts),
        this.formatFootprintTime(row.latest_ts),
        row.anchor_local_id,
        row.anchor_create_time
      )
    }

    lines.push('')
    pushRow('mentions', 'session_id', 'session_display_name', 'local_id', 'create_time', 'sender_username', 'sender_display_name', 'message_content', 'source')
    for (const row of data.mentions) {
      pushRow(
        'mentions',
        row.session_id,
        row.sessionDisplayName || '',
        row.local_id,
        this.formatFootprintTime(row.create_time),
        row.sender_username,
        row.senderDisplayName || '',
        row.message_content,
        row.source
      )
    }

    lines.push('')
    pushRow('mention_groups', 'session_id', 'display_name', 'count', 'latest_ts')
    for (const row of data.mention_groups) {
      pushRow(
        'mention_groups',
        row.session_id,
        row.displayName || '',
        row.count,
        this.formatFootprintTime(row.latest_ts)
      )
    }

    return lines.join('\n')
  }

  private async parseMessage(row: any, options?: { source?: 'search' | 'detail'; sessionId?: string }): Promise<Message> {
    const sourceInfo = this.getMessageSourceInfo(row)
    const rawContent = this.decodeMessageContent(
      row.message_content,
      row.compress_content
    )
    // 这里复用 parseMessagesBatch 里面的解析逻辑，为了简单我这里先写个基础的
    // 实际项目中建议抽取 parseRawMessage(row) 供多处使用
    const localId = this.getRowInt(row, ['local_id'], 0)
    const serverIdRaw = this.normalizeUnsignedIntegerToken(row.server_id)
    const serverId = this.getRowInt(row, ['server_id'], 0)
    const localType = this.getRowInt(row, ['local_type'], 0)
    const createTime = this.getRowInt(row, ['create_time'], 0)
    const sortSeq = this.getRowInt(row, ['sort_seq'], createTime)
    const rawIsSend = row.computed_is_send ?? row.is_send
    const senderUsername = await this.resolveSenderUsernameForMessageRow(row, rawContent)
    const sendState = this.resolveMessageIsSend(rawIsSend === null ? null : parseInt(rawIsSend, 10), senderUsername)
    const msg: Message = {
      messageKey: this.buildMessageKey({
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
      parsedContent: this.parseMessageContent(rawContent, localType),
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
      const imgInfo = this.parseImageInfo(rawContent)
      Object.assign(msg, imgInfo)
      msg.imageDatName = this.parseImageDatNameFromRow(row)
    } else if (msg.localType === 47) { // Emoji
      const emojiInfo = this.parseEmojiInfo(rawContent)
      msg.emojiCdnUrl = emojiInfo.cdnUrl
      msg.emojiMd5 = emojiInfo.md5
      msg.emojiThumbUrl = emojiInfo.thumbUrl
      msg.emojiEncryptUrl = emojiInfo.encryptUrl
      msg.emojiAesKey = emojiInfo.aesKey
    } else if (msg.localType === 42) {
      const cardInfo = this.parseCardInfo(rawContent)
      msg.cardUsername = cardInfo.username
      msg.cardNickname = cardInfo.nickname
      msg.cardAvatarUrl = cardInfo.avatarUrl
    }

    if (rawContent && (rawContent.includes('<appmsg') || rawContent.includes('&lt;appmsg'))) {
      Object.assign(msg, this.parseType49Message(rawContent))
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
      await this.fallbackEmoticon(msg)
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
