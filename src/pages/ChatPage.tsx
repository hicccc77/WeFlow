import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, MessageSquare, AlertCircle, Loader2, RefreshCw, X, ChevronDown, ChevronLeft, Info, Calendar, Database, Hash, Play, Pause, Image as ImageIcon, Link, Mic, CheckCircle, Copy, Check, CheckSquare, Download, BarChart3, Edit2, Trash2, BellOff, Users, FolderClosed, UserCheck, Crown } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { useChatStore } from '../stores/chatStore'
import { useBatchTranscribeStore } from '../stores/batchTranscribeStore'
import { useBatchImageDecryptStore } from '../stores/batchImageDecryptStore'
import type { ChatSession, Message } from '../types/models'
import { getEmojiPath } from 'wechat-emojis'
import { VoiceTranscribeDialog } from '../components/VoiceTranscribeDialog'
import { LivePhotoIcon } from '../components/LivePhotoIcon'
import { AnimatedStreamingText } from '../components/AnimatedStreamingText'
import JumpToDateDialog from '../components/JumpToDateDialog'
import * as configService from '../services/config'
import {
  emitOpenSingleExport,
  onExportSessionStatus,
  onSingleExportDialogStatus,
  requestExportSessionStatus
} from '../services/exportBridge'
import './ChatPage.scss'

// 系统消息类型常量
const SYSTEM_MESSAGE_TYPES = [
  10000,        // 系统消息
  266287972401, // 拍一拍
]

interface XmlField {
  key: string;
  value: string;
  type: 'attr' | 'node';
  tagName?: string;
  path: string;
}

interface BatchImageDecryptCandidate {
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

// 尝试解析 XML 为可编辑字段
function parseXmlToFields(xml: string): XmlField[] {
  const fields: XmlField[] = []
  if (!xml || !xml.includes('<')) return []
  try {
    const parser = new DOMParser()
    // 包装一下确保是单一根节点
    const wrappedXml = xml.trim().startsWith('<?xml') ? xml : `<root>${xml}</root>`
    const doc = parser.parseFromString(wrappedXml, 'text/xml')
    const errorNode = doc.querySelector('parsererror')
    if (errorNode) return []

    const walk = (node: Node, path: string = '') => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        if (element.tagName === 'root') {
          node.childNodes.forEach((child, index) => walk(child, path))
          return
        }

        const currentPath = path ? `${path} > ${element.tagName}` : element.tagName

        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes[i]
          fields.push({
            key: attr.name,
            value: attr.value,
            type: 'attr',
            tagName: element.tagName,
            path: `${currentPath}[@${attr.name}]`
          })
        }

        if (element.childNodes.length === 1 && element.childNodes[0].nodeType === Node.TEXT_NODE) {
          const text = element.textContent?.trim() || ''
          if (text) {
            fields.push({
              key: element.tagName,
              value: text,
              type: 'node',
              path: currentPath
            })
          }
        } else {
          node.childNodes.forEach((child, index) => walk(child, `${currentPath}[${index}]`))
        }
      }
    }
    doc.childNodes.forEach((node, index) => walk(node, ''))
  } catch (e) {
    console.warn('[XML Parse] Failed:', e)
  }
  return fields
}

// 将编辑后的字段同步回 XML
function updateXmlWithFields(xml: string, fields: XmlField[]): string {
  try {
    const parser = new DOMParser()
    const wrappedXml = xml.trim().startsWith('<?xml') ? xml : `<root>${xml}</root>`
    const doc = parser.parseFromString(wrappedXml, 'text/xml')
    const errorNode = doc.querySelector('parsererror')
    if (errorNode) return xml

    fields.forEach(f => {
      if (f.type === 'attr') {
        const elements = doc.getElementsByTagName(f.tagName!)
        if (elements.length > 0) {
          elements[0].setAttribute(f.key, f.value)
        }
      } else {
        const elements = doc.getElementsByTagName(f.key)
        if (elements.length > 0 && (elements[0].childNodes.length <= 1)) {
          elements[0].textContent = f.value
        }
      }
    })

    let result = new XMLSerializer().serializeToString(doc)
    if (!xml.trim().startsWith('<?xml')) {
      result = result.replace('<root>', '').replace('</root>', '').replace('<root/>', '')
    }
    return result
  } catch (e) {
    return xml
  }
}

// 判断是否为系统消息
function isSystemMessage(localType: number): boolean {
  return SYSTEM_MESSAGE_TYPES.includes(localType)
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

// 清理消息内容的辅助函数
function cleanMessageContent(content: string): string {
  if (!content) return ''
  return content.trim()
}

const CHAT_SESSION_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CHAT_SESSION_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CHAT_SESSION_PREVIEW_LIMIT_PER_SESSION = 30
const CHAT_SESSION_PREVIEW_MAX_SESSIONS = 18
const CHAT_SESSION_WINDOW_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const CHAT_SESSION_WINDOW_CACHE_MAX_SESSIONS = 30
const CHAT_SESSION_WINDOW_CACHE_MAX_MESSAGES = 300
const GROUP_MEMBERS_PANEL_CACHE_TTL_MS = 10 * 60 * 1000

function buildChatSessionListCacheKey(scope: string): string {
  return `weflow.chat.sessions.v1::${scope || 'default'}`
}

function buildChatSessionPreviewCacheKey(scope: string): string {
  return `weflow.chat.preview.v1::${scope || 'default'}`
}

function normalizeChatCacheScope(dbPath: unknown, wxid: unknown): string {
  const db = String(dbPath || '').trim()
  const id = String(wxid || '').trim()
  if (!db && !id) return 'default'
  return `${db}::${id}`
}

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function formatYmdDateFromSeconds(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp * 1000)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatYmdHmDateTime(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const h = `${d.getHours()}`.padStart(2, '0')
  const min = `${d.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

interface ChatPageProps {
  standaloneSessionWindow?: boolean
  initialSessionId?: string | null
}


interface SessionDetail {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  transferMessages?: number
  redPacketMessages?: number
  callMessages?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
  relationStatsLoaded?: boolean
  statsUpdatedAt?: number
  statsStale?: boolean
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

interface SessionExportMetric {
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

interface SessionExportCacheMeta {
  updatedAt: number
  stale: boolean
  includeRelations: boolean
  source: 'memory' | 'disk' | 'fresh'
}

interface GroupPanelMember {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
  isOwner?: boolean
  isFriend: boolean
  messageCount: number
}

interface SessionListCachePayload {
  updatedAt: number
  sessions: ChatSession[]
}

interface SessionPreviewCacheEntry {
  updatedAt: number
  messages: Message[]
}

interface SessionPreviewCachePayload {
  updatedAt: number
  entries: Record<string, SessionPreviewCacheEntry>
}

interface GroupMembersPanelCacheEntry {
  updatedAt: number
  members: GroupPanelMember[]
  includeMessageCounts: boolean
}

interface SessionWindowCacheEntry {
  updatedAt: number
  messages: Message[]
  currentOffset: number
  hasMoreMessages: boolean
  hasMoreLater: boolean
  jumpStartTime: number
  jumpEndTime: number
}

interface LoadMessagesOptions {
  preferLatestPath?: boolean
  deferGroupSenderWarmup?: boolean
  forceInitialLimit?: number
  switchRequestSeq?: number
}

// 全局头像加载队列管理器已移至 src/utils/AvatarLoadQueue.ts
// 全局头像加载队列管理器已移至 src/utils/AvatarLoadQueue.ts
import { avatarLoadQueue } from '../utils/AvatarLoadQueue'
import { Avatar } from '../components/Avatar'

// 头像组件 - 支持骨架屏加载和懒加载（优化：限制并发，使用 memo 避免不必要的重渲染）
// 会话项组件（使用 memo 优化，避免不必要的重渲染）
const SessionItem = React.memo(function SessionItem({
  session,
  isActive,
  onSelect,
  formatTime
}: {
  session: ChatSession
  isActive: boolean
  onSelect: (session: ChatSession) => void
  formatTime: (timestamp: number) => string
}) {
  const timeText = useMemo(() =>
    formatTime(session.lastTimestamp || session.sortTimestamp),
    [formatTime, session.lastTimestamp, session.sortTimestamp]
  )

  const isFoldEntry = session.username.toLowerCase().includes('placeholder_foldgroup')

  // 折叠入口：专属名称和图标
  if (isFoldEntry) {
    return (
      <div
        className={`session-item fold-entry`}
        onClick={() => onSelect(session)}
      >
        <div className="fold-entry-avatar">
          <FolderClosed size={22} />
        </div>
        <div className="session-info">
          <div className="session-top">
            <span className="session-name">折叠的群聊</span>
          </div>
          <div className="session-bottom">
            <span className="session-summary">{session.summary || ''}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`session-item ${isActive ? 'active' : ''} ${session.isMuted ? 'muted' : ''}`}
      onClick={() => onSelect(session)}
    >
      <Avatar
        src={session.avatarUrl}
        name={session.displayName || session.username}
        size={48}
        className={session.username.includes('@chatroom') ? 'group' : ''}
      />
      <div className="session-info">
        <div className="session-top">
          <span className="session-name">{session.displayName || session.username}</span>
          <span className="session-time">{timeText}</span>
        </div>
        <div className="session-bottom">
          <span className="session-summary">{session.summary || '暂无消息'}</span>
          <div className="session-badges">
            {session.isMuted && <BellOff size={12} className="mute-icon" />}
            {session.unreadCount > 0 && (
              <span className={`unread-badge ${session.isMuted ? 'muted' : ''}`}>
                {session.unreadCount > 99 ? '99+' : session.unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  return (
    prevProps.session.username === nextProps.session.username &&
    prevProps.session.displayName === nextProps.session.displayName &&
    prevProps.session.avatarUrl === nextProps.session.avatarUrl &&
    prevProps.session.summary === nextProps.session.summary &&
    prevProps.session.unreadCount === nextProps.session.unreadCount &&
    prevProps.session.lastTimestamp === nextProps.session.lastTimestamp &&
    prevProps.session.sortTimestamp === nextProps.session.sortTimestamp &&
    prevProps.session.isMuted === nextProps.session.isMuted &&
    prevProps.isActive === nextProps.isActive
  )
})



function ChatPage(props: ChatPageProps) {
  const { standaloneSessionWindow = false, initialSessionId = null } = props
  const normalizedInitialSessionId = useMemo(() => String(initialSessionId || '').trim(), [initialSessionId])
  const navigate = useNavigate()

  const {
    isConnected,
    isConnecting,
    connectionError,
    sessions,
    filteredSessions,
    currentSessionId,
    isLoadingSessions,
    messages,
    isLoadingMessages,
    isLoadingMore,
    hasMoreMessages,
    searchKeyword,
    setConnected,
    setConnecting,
    setConnectionError,
    setSessions,
    setFilteredSessions,
    setCurrentSession,
    setLoadingSessions,
    setMessages,
    appendMessages,
    setLoadingMessages,
    setLoadingMore,
    setHasMoreMessages,
    hasMoreLater,
    setHasMoreLater,
    setSearchKeyword
  } = useChatStore()

  const messageListRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  const getMessageKey = useCallback((msg: Message): string => {
    if (msg.localId && msg.localId > 0) return `l:${msg.localId}`
    return `t:${msg.createTime}:${msg.sortSeq || 0}:${msg.serverId || 0}`
  }, [])
  const initialRevealTimerRef = useRef<number | null>(null)
  const sessionListRef = useRef<HTMLDivElement>(null)
  const [currentOffset, setCurrentOffset] = useState(0)
  const [jumpStartTime, setJumpStartTime] = useState(0)
  const [jumpEndTime, setJumpEndTime] = useState(0)
  const [showJumpDialog, setShowJumpDialog] = useState(false)
  const isDateJumpRef = useRef(false)
  const [messageDates, setMessageDates] = useState<Set<string>>(new Set())
  const [loadingDates, setLoadingDates] = useState(false)
  const messageDatesCache = useRef<Map<string, Set<string>>>(new Map())
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [myWxid, setMyWxid] = useState<string | undefined>(undefined)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [isResizing, setIsResizing] = useState(false)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [showGroupMembersPanel, setShowGroupMembersPanel] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isLoadingDetailExtra, setIsLoadingDetailExtra] = useState(false)
  const [isRefreshingDetailStats, setIsRefreshingDetailStats] = useState(false)
  const [isLoadingRelationStats, setIsLoadingRelationStats] = useState(false)
  const [groupPanelMembers, setGroupPanelMembers] = useState<GroupPanelMember[]>([])
  const [isLoadingGroupMembers, setIsLoadingGroupMembers] = useState(false)
  const [groupMembersError, setGroupMembersError] = useState<string | null>(null)
  const [groupMembersLoadingHint, setGroupMembersLoadingHint] = useState('')
  const [isRefreshingGroupMembers, setIsRefreshingGroupMembers] = useState(false)
  const [groupMemberSearchKeyword, setGroupMemberSearchKeyword] = useState('')
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [highlightedMessageKeys, setHighlightedMessageKeys] = useState<string[]>([])
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false)
  const [foldedView, setFoldedView] = useState(false) // 是否在"折叠的群聊"视图
  const [hasInitialMessages, setHasInitialMessages] = useState(false)
  const [isSessionSwitching, setIsSessionSwitching] = useState(false)
  const [noMessageTable, setNoMessageTable] = useState(false)
  const [fallbackDisplayName, setFallbackDisplayName] = useState<string | null>(null)
  const [showVoiceTranscribeDialog, setShowVoiceTranscribeDialog] = useState(false)
  const [pendingVoiceTranscriptRequest, setPendingVoiceTranscriptRequest] = useState<{ sessionId: string; messageId: string } | null>(null)
  const [inProgressExportSessionIds, setInProgressExportSessionIds] = useState<Set<string>>(new Set())
  const [isPreparingExportDialog, setIsPreparingExportDialog] = useState(false)
  const [exportPrepareHint, setExportPrepareHint] = useState('')

  // 消息右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, message: Message } | null>(null)
  const [showMessageInfo, setShowMessageInfo] = useState<Message | null>(null)
  const [editingMessage, setEditingMessage] = useState<{ message: Message, content: string } | null>(null)

  // 多选模式
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedMessages, setSelectedMessages] = useState<Set<number>>(new Set())

  // 编辑消息额外状态
  const [editMode, setEditMode] = useState<'raw' | 'fields'>('raw')
  const [tempFields, setTempFields] = useState<XmlField[]>([])

  // 批量语音转文字相关状态（进度/结果 由全局 store 管理）
  const { isBatchTranscribing, progress: batchTranscribeProgress, showToast: showBatchProgress, startTranscribe, updateProgress, finishTranscribe, setShowToast: setShowBatchProgress } = useBatchTranscribeStore()
  const { isBatchDecrypting, progress: batchDecryptProgress, startDecrypt, updateProgress: updateDecryptProgress, finishDecrypt, setShowToast: setShowBatchDecryptToast } = useBatchImageDecryptStore()
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [batchVoiceCount, setBatchVoiceCount] = useState(0)
  const [batchVoiceMessages, setBatchVoiceMessages] = useState<Message[] | null>(null)
  const [batchVoiceDates, setBatchVoiceDates] = useState<string[]>([])
  const [batchSelectedDates, setBatchSelectedDates] = useState<Set<string>>(new Set())
  const [showBatchDecryptConfirm, setShowBatchDecryptConfirm] = useState(false)
  const [batchImageMessages, setBatchImageMessages] = useState<BatchImageDecryptCandidate[] | null>(null)
  const [batchImageDates, setBatchImageDates] = useState<string[]>([])
  const [batchImageSelectedDates, setBatchImageSelectedDates] = useState<Set<string>>(new Set())
  const [batchDecryptConcurrency, setBatchDecryptConcurrency] = useState(6)
  const [showConcurrencyDropdown, setShowConcurrencyDropdown] = useState(false)

  // 批量删除相关状态
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0 })
  const [cancelDeleteRequested, setCancelDeleteRequested] = useState(false)

  // 自定义删除确认对话框
  const [deleteConfirm, setDeleteConfirm] = useState<{
    show: boolean;
    mode: 'single' | 'batch';
    message?: Message;
    count?: number;
  }>({ show: false, mode: 'single' })

  // 联系人信息加载控制
  const isEnrichingRef = useRef(false)
  const enrichCancelledRef = useRef(false)
  const isScrollingRef = useRef(false)
  const sessionScrollTimeoutRef = useRef<number | null>(null)


  const highlightedMessageSet = useMemo(() => new Set(highlightedMessageKeys), [highlightedMessageKeys])
  const messageKeySetRef = useRef<Set<string>>(new Set())
  const lastMessageTimeRef = useRef(0)
  const sessionMapRef = useRef<Map<string, ChatSession>>(new Map())
  const sessionsRef = useRef<ChatSession[]>([])
  const currentSessionRef = useRef<string | null>(null)
  const pendingSessionLoadRef = useRef<string | null>(null)
  const sessionSwitchRequestSeqRef = useRef(0)
  const initialLoadRequestedSessionRef = useRef<string | null>(null)
  const prevSessionRef = useRef<string | null>(null)
  const isLoadingMessagesRef = useRef(false)
  const isLoadingMoreRef = useRef(false)
  const isConnectedRef = useRef(false)
  const isRefreshingRef = useRef(false)
  const searchKeywordRef = useRef('')
  const preloadImageKeysRef = useRef<Set<string>>(new Set())
  const lastPreloadSessionRef = useRef<string | null>(null)
  const detailRequestSeqRef = useRef(0)
  const groupMembersRequestSeqRef = useRef(0)
  const groupMembersPanelCacheRef = useRef<Map<string, GroupMembersPanelCacheEntry>>(new Map())
  const hasInitializedGroupMembersRef = useRef(false)
  const chatCacheScopeRef = useRef('default')
  const previewCacheRef = useRef<Record<string, SessionPreviewCacheEntry>>({})
  const sessionWindowCacheRef = useRef<Map<string, SessionWindowCacheEntry>>(new Map())
  const previewPersistTimerRef = useRef<number | null>(null)
  const sessionListPersistTimerRef = useRef<number | null>(null)
  const pendingExportRequestIdRef = useRef<string | null>(null)
  const exportPrepareLongWaitTimerRef = useRef<number | null>(null)

  const isGroupChatSession = useCallback((username: string) => {
    return username.includes('@chatroom')
  }, [])

  const clearExportPrepareState = useCallback(() => {
    pendingExportRequestIdRef.current = null
    setIsPreparingExportDialog(false)
    setExportPrepareHint('')
    if (exportPrepareLongWaitTimerRef.current) {
      window.clearTimeout(exportPrepareLongWaitTimerRef.current)
      exportPrepareLongWaitTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    const unsubscribe = onExportSessionStatus((payload) => {
      const ids = Array.isArray(payload?.inProgressSessionIds)
        ? payload.inProgressSessionIds
          .filter((id): id is string => typeof id === 'string')
          .map(id => id.trim())
          .filter(Boolean)
        : []
      setInProgressExportSessionIds(new Set(ids))
    })

    requestExportSessionStatus()
    const timer = window.setTimeout(() => {
      requestExportSessionStatus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = onSingleExportDialogStatus((payload) => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : ''
      if (!requestId || requestId !== pendingExportRequestIdRef.current) return

      if (payload.status === 'initializing') {
        setExportPrepareHint('正在准备导出模块（首次会稍慢，通常 1-3 秒）')
        if (exportPrepareLongWaitTimerRef.current) {
          window.clearTimeout(exportPrepareLongWaitTimerRef.current)
        }
        exportPrepareLongWaitTimerRef.current = window.setTimeout(() => {
          if (pendingExportRequestIdRef.current !== requestId) return
          setExportPrepareHint('仍在准备导出模块，请稍候...')
        }, 8000)
        return
      }

      if (payload.status === 'opened') {
        clearExportPrepareState()
        return
      }

      if (payload.status === 'failed') {
        const message = (typeof payload.message === 'string' && payload.message.trim())
          ? payload.message.trim()
          : '导出模块初始化失败，请重试'
        clearExportPrepareState()
        window.alert(message)
      }
    })

    return () => {
      unsubscribe()
      if (exportPrepareLongWaitTimerRef.current) {
        window.clearTimeout(exportPrepareLongWaitTimerRef.current)
        exportPrepareLongWaitTimerRef.current = null
      }
    }
  }, [clearExportPrepareState])

  useEffect(() => {
    if (!isPreparingExportDialog || !currentSessionId) return
    if (!inProgressExportSessionIds.has(currentSessionId)) return
    clearExportPrepareState()
  }, [clearExportPrepareState, currentSessionId, inProgressExportSessionIds, isPreparingExportDialog])

  // 加载当前用户头像
  const loadMyAvatar = useCallback(async () => {
    try {
      const result = await window.electronAPI.chat.getMyAvatarUrl()
      if (result.success && result.avatarUrl) {
        setMyAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载用户头像失败:', e)
    }
  }, [])

  const resolveChatCacheScope = useCallback(async (): Promise<string> => {
    try {
      const [dbPath, myWxid] = await Promise.all([
        window.electronAPI.config.get('dbPath'),
        window.electronAPI.config.get('myWxid')
      ])
      const scope = normalizeChatCacheScope(dbPath, myWxid)
      chatCacheScopeRef.current = scope
      return scope
    } catch {
      chatCacheScopeRef.current = 'default'
      return 'default'
    }
  }, [])

  const loadPreviewCacheFromStorage = useCallback((scope: string): Record<string, SessionPreviewCacheEntry> => {
    try {
      const cacheKey = buildChatSessionPreviewCacheKey(scope)
      const payload = safeParseJson<SessionPreviewCachePayload>(window.localStorage.getItem(cacheKey))
      if (!payload || typeof payload.updatedAt !== 'number' || !payload.entries) {
        return {}
      }
      if (Date.now() - payload.updatedAt > CHAT_SESSION_PREVIEW_CACHE_TTL_MS) {
        return {}
      }
      return payload.entries
    } catch {
      return {}
    }
  }, [])

  const persistPreviewCacheToStorage = useCallback((scope: string, entries: Record<string, SessionPreviewCacheEntry>) => {
    try {
      const cacheKey = buildChatSessionPreviewCacheKey(scope)
      const payload: SessionPreviewCachePayload = {
        updatedAt: Date.now(),
        entries
      }
      window.localStorage.setItem(cacheKey, JSON.stringify(payload))
    } catch {
      // ignore cache write failures
    }
  }, [])

  const persistSessionPreviewCache = useCallback((sessionId: string, previewMessages: Message[]) => {
    const id = String(sessionId || '').trim()
    if (!id || !Array.isArray(previewMessages) || previewMessages.length === 0) return

    const trimmed = previewMessages.slice(-CHAT_SESSION_PREVIEW_LIMIT_PER_SESSION)
    const currentEntries = { ...previewCacheRef.current }
    currentEntries[id] = {
      updatedAt: Date.now(),
      messages: trimmed
    }

    const sortedIds = Object.entries(currentEntries)
      .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
      .map(([entryId]) => entryId)

    const keptIds = new Set(sortedIds.slice(0, CHAT_SESSION_PREVIEW_MAX_SESSIONS))
    const compactEntries: Record<string, SessionPreviewCacheEntry> = {}
    for (const [entryId, entry] of Object.entries(currentEntries)) {
      if (keptIds.has(entryId)) {
        compactEntries[entryId] = entry
      }
    }

    previewCacheRef.current = compactEntries
    if (previewPersistTimerRef.current !== null) {
      window.clearTimeout(previewPersistTimerRef.current)
    }
    previewPersistTimerRef.current = window.setTimeout(() => {
      persistPreviewCacheToStorage(chatCacheScopeRef.current, previewCacheRef.current)
      previewPersistTimerRef.current = null
    }, 220)
  }, [persistPreviewCacheToStorage])

  const hydrateSessionPreview = useCallback(async (sessionId: string) => {
    const id = String(sessionId || '').trim()
    if (!id) return

    const localEntry = previewCacheRef.current[id]
    if (
      localEntry &&
      Array.isArray(localEntry.messages) &&
      localEntry.messages.length > 0 &&
      Date.now() - localEntry.updatedAt <= CHAT_SESSION_PREVIEW_CACHE_TTL_MS
    ) {
      setMessages(localEntry.messages.slice())
      setHasInitialMessages(true)
      return
    }

    try {
      const result = await window.electronAPI.chat.getCachedMessages(id)
      if (!result.success || !Array.isArray(result.messages) || result.messages.length === 0) {
        return
      }
      if (currentSessionRef.current !== id && pendingSessionLoadRef.current !== id) return
      setMessages(result.messages)
      setHasInitialMessages(true)
      persistSessionPreviewCache(id, result.messages)
    } catch {
      // ignore preview cache errors
    }
  }, [persistSessionPreviewCache, setMessages])

  const saveSessionWindowCache = useCallback((sessionId: string, entry: Omit<SessionWindowCacheEntry, 'updatedAt'>) => {
    const id = String(sessionId || '').trim()
    if (!id || !Array.isArray(entry.messages) || entry.messages.length === 0) return

    const trimmedMessages = entry.messages.length > CHAT_SESSION_WINDOW_CACHE_MAX_MESSAGES
      ? entry.messages.slice(-CHAT_SESSION_WINDOW_CACHE_MAX_MESSAGES)
      : entry.messages.slice()

    const cache = sessionWindowCacheRef.current
    cache.set(id, {
      updatedAt: Date.now(),
      ...entry,
      messages: trimmedMessages,
      currentOffset: trimmedMessages.length
    })

    if (cache.size <= CHAT_SESSION_WINDOW_CACHE_MAX_SESSIONS) return

    const sortedByTime = [...cache.entries()]
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))

    for (const [key] of sortedByTime) {
      if (cache.size <= CHAT_SESSION_WINDOW_CACHE_MAX_SESSIONS) break
      cache.delete(key)
    }
  }, [])

  const restoreSessionWindowCache = useCallback((sessionId: string): boolean => {
    const id = String(sessionId || '').trim()
    if (!id) return false

    const cache = sessionWindowCacheRef.current
    const entry = cache.get(id)
    if (!entry) return false
    if (Date.now() - entry.updatedAt > CHAT_SESSION_WINDOW_CACHE_TTL_MS) {
      cache.delete(id)
      return false
    }
    if (!Array.isArray(entry.messages) || entry.messages.length === 0) {
      cache.delete(id)
      return false
    }

    // LRU: 命中后更新时间
    cache.set(id, {
      ...entry,
      updatedAt: Date.now(),
      messages: entry.messages.slice()
    })

    setMessages(entry.messages.slice())
    setCurrentOffset(entry.messages.length)
    setHasMoreMessages(entry.hasMoreMessages !== false)
    setHasMoreLater(entry.hasMoreLater === true)
    setJumpStartTime(entry.jumpStartTime || 0)
    setJumpEndTime(entry.jumpEndTime || 0)
    setNoMessageTable(false)
    setHasInitialMessages(true)
    return true
  }, [
    setMessages,
    setHasMoreMessages,
    setHasMoreLater,
    setCurrentOffset,
    setJumpStartTime,
    setJumpEndTime,
    setNoMessageTable,
    setHasInitialMessages
  ])

  const hydrateSessionListCache = useCallback((scope: string): boolean => {
    try {
      const cacheKey = buildChatSessionListCacheKey(scope)
      const payload = safeParseJson<SessionListCachePayload>(window.localStorage.getItem(cacheKey))
      if (!payload || typeof payload.updatedAt !== 'number' || !Array.isArray(payload.sessions)) {
        previewCacheRef.current = loadPreviewCacheFromStorage(scope)
        return false
      }
      previewCacheRef.current = loadPreviewCacheFromStorage(scope)
      if (Date.now() - payload.updatedAt > CHAT_SESSION_LIST_CACHE_TTL_MS) {
        return false
      }
      if (!Array.isArray(sessionsRef.current) || sessionsRef.current.length === 0) {
        setSessions(payload.sessions)
        sessionsRef.current = payload.sessions
        return payload.sessions.length > 0
      }
      return false
    } catch {
      previewCacheRef.current = loadPreviewCacheFromStorage(scope)
      return false
    }
  }, [loadPreviewCacheFromStorage, setSessions])

  const persistSessionListCache = useCallback((scope: string, nextSessions: ChatSession[]) => {
    try {
      const cacheKey = buildChatSessionListCacheKey(scope)
      const payload: SessionListCachePayload = {
        updatedAt: Date.now(),
        sessions: nextSessions
      }
      window.localStorage.setItem(cacheKey, JSON.stringify(payload))
    } catch {
      // ignore cache write failures
    }
  }, [])

  const applySessionDetailStats = useCallback((
    sessionId: string,
    metric: SessionExportMetric,
    cacheMeta?: SessionExportCacheMeta,
    relationLoadedOverride?: boolean
  ) => {
    setSessionDetail((prev) => {
      if (!prev || prev.wxid !== sessionId) return prev
      const relationLoaded = relationLoadedOverride ?? Boolean(prev.relationStatsLoaded)
      return {
        ...prev,
        messageCount: Number.isFinite(metric.totalMessages) ? metric.totalMessages : prev.messageCount,
        voiceMessages: Number.isFinite(metric.voiceMessages) ? metric.voiceMessages : prev.voiceMessages,
        imageMessages: Number.isFinite(metric.imageMessages) ? metric.imageMessages : prev.imageMessages,
        videoMessages: Number.isFinite(metric.videoMessages) ? metric.videoMessages : prev.videoMessages,
        emojiMessages: Number.isFinite(metric.emojiMessages) ? metric.emojiMessages : prev.emojiMessages,
        transferMessages: Number.isFinite(metric.transferMessages) ? metric.transferMessages : prev.transferMessages,
        redPacketMessages: Number.isFinite(metric.redPacketMessages) ? metric.redPacketMessages : prev.redPacketMessages,
        callMessages: Number.isFinite(metric.callMessages) ? metric.callMessages : prev.callMessages,
        groupMemberCount: Number.isFinite(metric.groupMemberCount) ? metric.groupMemberCount : prev.groupMemberCount,
        groupMyMessages: Number.isFinite(metric.groupMyMessages) ? metric.groupMyMessages : prev.groupMyMessages,
        groupActiveSpeakers: Number.isFinite(metric.groupActiveSpeakers) ? metric.groupActiveSpeakers : prev.groupActiveSpeakers,
        privateMutualGroups: relationLoaded && Number.isFinite(metric.privateMutualGroups)
          ? metric.privateMutualGroups
          : prev.privateMutualGroups,
        groupMutualFriends: relationLoaded && Number.isFinite(metric.groupMutualFriends)
          ? metric.groupMutualFriends
          : prev.groupMutualFriends,
        relationStatsLoaded: relationLoaded,
        statsUpdatedAt: cacheMeta?.updatedAt ?? prev.statsUpdatedAt,
        statsStale: typeof cacheMeta?.stale === 'boolean' ? cacheMeta.stale : prev.statsStale,
        firstMessageTime: Number.isFinite(metric.firstTimestamp) ? metric.firstTimestamp : prev.firstMessageTime,
        latestMessageTime: Number.isFinite(metric.lastTimestamp) ? metric.lastTimestamp : prev.latestMessageTime
      }
    })
  }, [])

  // 加载会话详情
  const loadSessionDetail = useCallback(async (sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return

    const requestSeq = ++detailRequestSeqRef.current
    const mappedSession = sessionMapRef.current.get(normalizedSessionId) || sessionsRef.current.find((s) => s.username === normalizedSessionId)
    const hintedCount = typeof mappedSession?.messageCountHint === 'number' && Number.isFinite(mappedSession.messageCountHint) && mappedSession.messageCountHint >= 0
      ? Math.floor(mappedSession.messageCountHint)
      : undefined

    setIsRefreshingDetailStats(false)
    setIsLoadingRelationStats(false)
    setSessionDetail((prev) => {
      const sameSession = prev?.wxid === normalizedSessionId
      return {
        wxid: normalizedSessionId,
        displayName: mappedSession?.displayName || prev?.displayName || normalizedSessionId,
        remark: sameSession ? prev?.remark : undefined,
        nickName: sameSession ? prev?.nickName : undefined,
        alias: sameSession ? prev?.alias : undefined,
        avatarUrl: mappedSession?.avatarUrl || (sameSession ? prev?.avatarUrl : undefined),
        messageCount: hintedCount ?? (sameSession ? prev.messageCount : Number.NaN),
        voiceMessages: sameSession ? prev?.voiceMessages : undefined,
        imageMessages: sameSession ? prev?.imageMessages : undefined,
        videoMessages: sameSession ? prev?.videoMessages : undefined,
        emojiMessages: sameSession ? prev?.emojiMessages : undefined,
        transferMessages: sameSession ? prev?.transferMessages : undefined,
        redPacketMessages: sameSession ? prev?.redPacketMessages : undefined,
        callMessages: sameSession ? prev?.callMessages : undefined,
        privateMutualGroups: sameSession ? prev?.privateMutualGroups : undefined,
        groupMemberCount: sameSession ? prev?.groupMemberCount : undefined,
        groupMyMessages: sameSession ? prev?.groupMyMessages : undefined,
        groupActiveSpeakers: sameSession ? prev?.groupActiveSpeakers : undefined,
        groupMutualFriends: sameSession ? prev?.groupMutualFriends : undefined,
        relationStatsLoaded: sameSession ? prev?.relationStatsLoaded : false,
        statsUpdatedAt: sameSession ? prev?.statsUpdatedAt : undefined,
        statsStale: sameSession ? prev?.statsStale : undefined,
        firstMessageTime: sameSession ? prev?.firstMessageTime : undefined,
        latestMessageTime: sameSession ? prev?.latestMessageTime : undefined,
        messageTables: sameSession && Array.isArray(prev?.messageTables) ? prev.messageTables : []
      }
    })
    setIsLoadingDetail(true)
    setIsLoadingDetailExtra(true)

    if (normalizedSessionId.includes('@chatroom')) {
      void (async () => {
        try {
          const hintResult = await window.electronAPI.chat.getGroupMyMessageCountHint(normalizedSessionId)
          if (requestSeq !== detailRequestSeqRef.current) return
          if (!hintResult.success || !Number.isFinite(hintResult.count)) return
          const hintedMyCount = Math.max(0, Math.floor(hintResult.count as number))
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              groupMyMessages: hintedMyCount
            }
          })
        } catch {
          // ignore hint errors
        }
      })()
    }

    try {
      const result = await window.electronAPI.chat.getSessionDetailFast(normalizedSessionId)
      if (requestSeq !== detailRequestSeqRef.current) return
      if (result.success && result.detail) {
        setSessionDetail((prev) => ({
          wxid: normalizedSessionId,
          displayName: result.detail!.displayName || prev?.displayName || normalizedSessionId,
          remark: result.detail!.remark,
          nickName: result.detail!.nickName,
          alias: result.detail!.alias,
          avatarUrl: result.detail!.avatarUrl || prev?.avatarUrl,
          messageCount: Number.isFinite(result.detail!.messageCount) ? result.detail!.messageCount : prev?.messageCount ?? Number.NaN,
          voiceMessages: prev?.voiceMessages,
          imageMessages: prev?.imageMessages,
          videoMessages: prev?.videoMessages,
          emojiMessages: prev?.emojiMessages,
          transferMessages: prev?.transferMessages,
          redPacketMessages: prev?.redPacketMessages,
          callMessages: prev?.callMessages,
          privateMutualGroups: prev?.privateMutualGroups,
          groupMemberCount: prev?.groupMemberCount,
          groupMyMessages: prev?.groupMyMessages,
          groupActiveSpeakers: prev?.groupActiveSpeakers,
          groupMutualFriends: prev?.groupMutualFriends,
          relationStatsLoaded: prev?.relationStatsLoaded,
          statsUpdatedAt: prev?.statsUpdatedAt,
          statsStale: prev?.statsStale,
          firstMessageTime: prev?.firstMessageTime,
          latestMessageTime: prev?.latestMessageTime,
          messageTables: Array.isArray(prev?.messageTables) ? (prev?.messageTables || []) : []
        }))
      }
    } catch (e) {
      console.error('加载会话详情失败:', e)
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingDetail(false)
      }
    }

    try {
      const [extraResultSettled, statsResultSettled] = await Promise.allSettled([
        window.electronAPI.chat.getSessionDetailExtra(normalizedSessionId),
        window.electronAPI.chat.getExportSessionStats(
          [normalizedSessionId],
          { includeRelations: false, forceRefresh: true, preferAccurateSpecialTypes: true }
        )
      ])

      if (requestSeq !== detailRequestSeqRef.current) return

      if (extraResultSettled.status === 'fulfilled' && extraResultSettled.value.success) {
        const detail = extraResultSettled.value.detail
        if (detail) {
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              firstMessageTime: detail.firstMessageTime,
              latestMessageTime: detail.latestMessageTime,
              messageTables: Array.isArray(detail.messageTables) ? detail.messageTables : []
            }
          })
        }
      }

      let refreshIncludeRelations = false
      if (statsResultSettled.status === 'fulfilled' && statsResultSettled.value.success) {
        const metric = statsResultSettled.value.data?.[normalizedSessionId] as SessionExportMetric | undefined
        const cacheMeta = statsResultSettled.value.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
        refreshIncludeRelations = Boolean(cacheMeta?.includeRelations)
        if (metric) {
          applySessionDetailStats(normalizedSessionId, metric, cacheMeta, refreshIncludeRelations)
        } else if (cacheMeta) {
          setSessionDetail((prev) => {
            if (!prev || prev.wxid !== normalizedSessionId) return prev
            return {
              ...prev,
              relationStatsLoaded: refreshIncludeRelations || prev.relationStatsLoaded,
              statsUpdatedAt: cacheMeta.updatedAt,
              statsStale: cacheMeta.stale
            }
          })
        }
      }
    } catch (e) {
      console.error('加载会话详情补充统计失败:', e)
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingDetailExtra(false)
      }
    }
  }, [applySessionDetailStats])

  const loadRelationStats = useCallback(async () => {
    const normalizedSessionId = String(currentSessionId || '').trim()
    if (!normalizedSessionId || isLoadingRelationStats) return

    const requestSeq = detailRequestSeqRef.current
    setIsLoadingRelationStats(true)
    try {
      const relationResult = await window.electronAPI.chat.getExportSessionStats(
        [normalizedSessionId],
        { includeRelations: true, forceRefresh: true, preferAccurateSpecialTypes: true }
      )
      if (requestSeq !== detailRequestSeqRef.current) return

      const metric = relationResult.success && relationResult.data
        ? relationResult.data[normalizedSessionId] as SessionExportMetric | undefined
        : undefined
      const cacheMeta = relationResult.success
        ? relationResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
        : undefined
      if (metric) {
        applySessionDetailStats(normalizedSessionId, metric, cacheMeta, true)
      }

      const needRefresh = relationResult.success &&
        Array.isArray(relationResult.needsRefresh) &&
        relationResult.needsRefresh.includes(normalizedSessionId)

      if (needRefresh) {
        setIsRefreshingDetailStats(true)
        void (async () => {
          try {
            const freshResult = await window.electronAPI.chat.getExportSessionStats(
              [normalizedSessionId],
              { includeRelations: true, forceRefresh: true, preferAccurateSpecialTypes: true }
            )
            if (requestSeq !== detailRequestSeqRef.current) return
            if (freshResult.success && freshResult.data) {
              const freshMetric = freshResult.data[normalizedSessionId] as SessionExportMetric | undefined
              const freshMeta = freshResult.cache?.[normalizedSessionId] as SessionExportCacheMeta | undefined
              if (freshMetric) {
                applySessionDetailStats(normalizedSessionId, freshMetric, freshMeta, true)
              }
            }
          } catch (error) {
            console.error('刷新会话关系统计失败:', error)
          } finally {
            if (requestSeq === detailRequestSeqRef.current) {
              setIsRefreshingDetailStats(false)
            }
          }
        })()
      }
    } catch (error) {
      console.error('加载会话关系统计失败:', error)
    } finally {
      if (requestSeq === detailRequestSeqRef.current) {
        setIsLoadingRelationStats(false)
      }
    }
  }, [applySessionDetailStats, currentSessionId, isLoadingRelationStats])

  const normalizeGroupPanelMembers = useCallback((payload: GroupPanelMember[]): GroupPanelMember[] => {
    const membersPayload = Array.isArray(payload) ? payload : []
    return membersPayload
      .map((member: GroupPanelMember): GroupPanelMember | null => {
        const username = String(member.username || '').trim()
        if (!username) return null
        const preferredName = String(
          member.groupNickname ||
          member.remark ||
          member.displayName ||
          member.nickname ||
          username
        )

        return {
          username,
          displayName: preferredName,
          avatarUrl: member.avatarUrl,
          nickname: member.nickname,
          alias: member.alias,
          remark: member.remark,
          groupNickname: member.groupNickname,
          isOwner: Boolean(member.isOwner),
          isFriend: Boolean(member.isFriend),
          messageCount: Number.isFinite(member.messageCount) ? Math.max(0, Math.floor(member.messageCount)) : 0
        }
      })
      .filter((member: GroupPanelMember | null): member is GroupPanelMember => Boolean(member))
      .sort((a: GroupPanelMember, b: GroupPanelMember) => {
        const ownerDiff = Number(Boolean(b.isOwner)) - Number(Boolean(a.isOwner))
        if (ownerDiff !== 0) return ownerDiff

        const friendDiff = Number(b.isFriend) - Number(a.isFriend)
        if (friendDiff !== 0) return friendDiff

        if (a.messageCount !== b.messageCount) return b.messageCount - a.messageCount
        return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
      })
  }, [])

  const normalizeWxidLikeIdentity = useCallback((value?: string): string => {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''
    const lowered = trimmed.toLowerCase()
    if (lowered.startsWith('wxid_')) {
      const matched = lowered.match(/^(wxid_[^_]+)/i)
      return matched ? matched[1].toLowerCase() : lowered
    }
    const suffixMatch = lowered.match(/^(.+)_([a-z0-9]{4})$/i)
    return suffixMatch ? suffixMatch[1].toLowerCase() : lowered
  }, [])

  const isSelfGroupMember = useCallback((memberUsername?: string): boolean => {
    const selfRaw = String(myWxid || '').trim().toLowerCase()
    const selfNormalized = normalizeWxidLikeIdentity(myWxid)
    if (!selfRaw && !selfNormalized) return false
    const memberRaw = String(memberUsername || '').trim().toLowerCase()
    const memberNormalized = normalizeWxidLikeIdentity(memberUsername)
    return Boolean(
      (selfRaw && memberRaw && selfRaw === memberRaw) ||
      (selfNormalized && memberNormalized && selfNormalized === memberNormalized)
    )
  }, [myWxid, normalizeWxidLikeIdentity])

  const resolveMyGroupMessageCountFromMembers = useCallback((members: GroupPanelMember[]): number | undefined => {
    if (!myWxid) return undefined

    for (const member of members) {
      if (!isSelfGroupMember(member.username)) continue
      if (Number.isFinite(member.messageCount)) {
        return Math.max(0, Math.floor(member.messageCount))
      }
      return 0
    }

    return undefined
  }, [isSelfGroupMember, myWxid])

  const syncGroupMyMessagesFromMembers = useCallback((chatroomId: string, members: GroupPanelMember[]) => {
    const myMessageCount = resolveMyGroupMessageCountFromMembers(members)
    if (!Number.isFinite(myMessageCount)) return

    setSessionDetail((prev) => {
      if (!prev || prev.wxid !== chatroomId || !prev.wxid.includes('@chatroom')) return prev
      return {
        ...prev,
        groupMyMessages: myMessageCount as number
      }
    })
  }, [resolveMyGroupMessageCountFromMembers])

  const updateGroupMembersPanelCache = useCallback((
    chatroomId: string,
    members: GroupPanelMember[],
    includeMessageCounts: boolean
  ) => {
    groupMembersPanelCacheRef.current.set(chatroomId, {
      updatedAt: Date.now(),
      members,
      includeMessageCounts
    })
    if (groupMembersPanelCacheRef.current.size > 80) {
      const oldestEntry = Array.from(groupMembersPanelCacheRef.current.entries())
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (oldestEntry) {
        groupMembersPanelCacheRef.current.delete(oldestEntry[0])
      }
    }
  }, [])

  const syncGroupMembersMyCountFromDetail = useCallback((chatroomId: string, myMessageCount: number) => {
    if (!chatroomId || !chatroomId.includes('@chatroom')) return
    const normalizedCount = Number.isFinite(myMessageCount) ? Math.max(0, Math.floor(myMessageCount)) : 0

    const patchMembers = (members: GroupPanelMember[]): { changed: boolean; members: GroupPanelMember[] } => {
      if (!Array.isArray(members) || members.length === 0) {
        return { changed: false, members }
      }
      let changed = false
      const patched = members.map((member) => {
        if (!isSelfGroupMember(member.username)) return member
        if (member.messageCount === normalizedCount) return member
        changed = true
        return {
          ...member,
          messageCount: normalizedCount
        }
      })
      if (!changed) return { changed: false, members }
      return { changed: true, members: normalizeGroupPanelMembers(patched) }
    }

    const cached = groupMembersPanelCacheRef.current.get(chatroomId)
    if (cached && cached.members.length > 0) {
      const patchedCache = patchMembers(cached.members)
      if (patchedCache.changed) {
        updateGroupMembersPanelCache(chatroomId, patchedCache.members, true)
      }
    }

    setGroupPanelMembers((prev) => {
      const patched = patchMembers(prev)
      if (!patched.changed) return prev
      return patched.members
    })
  }, [
    isSelfGroupMember,
    normalizeGroupPanelMembers,
    updateGroupMembersPanelCache
  ])

  const getGroupMembersPanelDataWithTimeout = useCallback(async (
    chatroomId: string,
    options: { forceRefresh?: boolean; includeMessageCounts?: boolean },
    timeoutMs: number
  ) => {
    let timeoutTimer: number | null = null
    try {
      const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) => {
        timeoutTimer = window.setTimeout(() => {
          resolve({ success: false, error: '加载群成员超时，请稍后重试' })
        }, timeoutMs)
      })
      return await Promise.race([
        window.electronAPI.groupAnalytics.getGroupMembersPanelData(chatroomId, options),
        timeoutPromise
      ])
    } finally {
      if (timeoutTimer) {
        window.clearTimeout(timeoutTimer)
      }
    }
  }, [])

  const loadGroupMembersPanel = useCallback(async (chatroomId: string) => {
    if (!chatroomId || !isGroupChatSession(chatroomId)) return

    const requestSeq = ++groupMembersRequestSeqRef.current
    const now = Date.now()
    const cached = groupMembersPanelCacheRef.current.get(chatroomId)
    const cacheFresh = Boolean(cached && now - cached.updatedAt < GROUP_MEMBERS_PANEL_CACHE_TTL_MS)
    const hasCachedMembers = Boolean(cached && cached.members.length > 0)
    const hasFreshMessageCounts = Boolean(cacheFresh && cached?.includeMessageCounts)
    let startedBackgroundRefresh = false

    const refreshMessageCountsInBackground = (forceRefresh: boolean) => {
      startedBackgroundRefresh = true
      setIsRefreshingGroupMembers(true)
      void (async () => {
        try {
          const countsResult = await getGroupMembersPanelDataWithTimeout(
            chatroomId,
            { forceRefresh, includeMessageCounts: true },
            25000
          )
          if (requestSeq !== groupMembersRequestSeqRef.current) return
          if (!countsResult.success || !Array.isArray(countsResult.data)) {
            setGroupMembersError('成员列表已加载，发言统计稍后再试')
            return
          }

          const membersWithCounts = normalizeGroupPanelMembers(countsResult.data as GroupPanelMember[])
          setGroupPanelMembers(membersWithCounts)
          syncGroupMyMessagesFromMembers(chatroomId, membersWithCounts)
          setGroupMembersError(null)
          updateGroupMembersPanelCache(chatroomId, membersWithCounts, true)
          hasInitializedGroupMembersRef.current = true
        } catch {
          if (requestSeq !== groupMembersRequestSeqRef.current) return
          setGroupMembersError('成员列表已加载，发言统计稍后再试')
        } finally {
          if (requestSeq === groupMembersRequestSeqRef.current) {
            setIsRefreshingGroupMembers(false)
          }
        }
      })()
    }

    if (cacheFresh && cached) {
      setGroupPanelMembers(cached.members)
      if (cached.includeMessageCounts) {
        syncGroupMyMessagesFromMembers(chatroomId, cached.members)
      }
      setGroupMembersError(null)
      setGroupMembersLoadingHint('')
      setIsLoadingGroupMembers(false)
      hasInitializedGroupMembersRef.current = true
      if (!hasFreshMessageCounts) {
        refreshMessageCountsInBackground(false)
      } else {
        setIsRefreshingGroupMembers(false)
      }
      return
    }

    setGroupMembersError(null)
    if (hasCachedMembers && cached) {
      setGroupPanelMembers(cached.members)
      if (cached.includeMessageCounts) {
        syncGroupMyMessagesFromMembers(chatroomId, cached.members)
      }
      setIsRefreshingGroupMembers(true)
      setGroupMembersLoadingHint('')
      setIsLoadingGroupMembers(false)
    } else {
      setGroupPanelMembers([])
      setIsRefreshingGroupMembers(false)
      setIsLoadingGroupMembers(true)
      setGroupMembersLoadingHint(
        hasInitializedGroupMembersRef.current
          ? '加载群成员中...'
          : '首次加载群成员，正在初始化索引（可能需要几秒）'
      )
    }

    try {
      const membersResult = await getGroupMembersPanelDataWithTimeout(
        chatroomId,
        { includeMessageCounts: false, forceRefresh: false },
        12000
      )
      if (requestSeq !== groupMembersRequestSeqRef.current) return

      if (!membersResult.success || !Array.isArray(membersResult.data)) {
        if (!hasCachedMembers) {
          setGroupPanelMembers([])
        }
        setGroupMembersError(membersResult.error || (hasCachedMembers ? '刷新群成员失败，已显示缓存数据' : '加载群成员失败'))
        return
      }

      const members = normalizeGroupPanelMembers(membersResult.data as GroupPanelMember[])
      setGroupPanelMembers(members)
      setGroupMembersError(null)
      updateGroupMembersPanelCache(chatroomId, members, false)
      hasInitializedGroupMembersRef.current = true
      refreshMessageCountsInBackground(false)
    } catch (e) {
      if (requestSeq !== groupMembersRequestSeqRef.current) return
      if (!hasCachedMembers) {
        setGroupPanelMembers([])
      }
      setGroupMembersError(hasCachedMembers ? '刷新群成员失败，已显示缓存数据' : String(e))
    } finally {
      if (requestSeq === groupMembersRequestSeqRef.current) {
        setIsLoadingGroupMembers(false)
        setGroupMembersLoadingHint('')
        if (!startedBackgroundRefresh) {
          setIsRefreshingGroupMembers(false)
        }
      }
    }
  }, [
    getGroupMembersPanelDataWithTimeout,
    isGroupChatSession,
    syncGroupMyMessagesFromMembers,
    normalizeGroupPanelMembers,
    updateGroupMembersPanelCache
  ])

  const toggleGroupMembersPanel = useCallback(() => {
    if (!currentSessionId || !isGroupChatSession(currentSessionId)) return
    if (showGroupMembersPanel) {
      setShowGroupMembersPanel(false)
      return
    }
    setShowDetailPanel(false)
    setShowGroupMembersPanel(true)
  }, [currentSessionId, showGroupMembersPanel, isGroupChatSession])

  // 切换详情面板
  const toggleDetailPanel = useCallback(() => {
    if (showDetailPanel) {
      setShowDetailPanel(false)
      return
    }
    setShowGroupMembersPanel(false)
    setShowDetailPanel(true)
    if (currentSessionId) {
      void loadSessionDetail(currentSessionId)
    }
  }, [showDetailPanel, currentSessionId, loadSessionDetail])

  useEffect(() => {
    if (!showGroupMembersPanel) return
    if (!currentSessionId || !isGroupChatSession(currentSessionId)) {
      setShowGroupMembersPanel(false)
      return
    }
    setGroupMemberSearchKeyword('')
    void loadGroupMembersPanel(currentSessionId)
  }, [showGroupMembersPanel, currentSessionId, loadGroupMembersPanel, isGroupChatSession])

  useEffect(() => {
    const chatroomId = String(sessionDetail?.wxid || '').trim()
    if (!chatroomId || !chatroomId.includes('@chatroom')) return
    if (!Number.isFinite(sessionDetail?.groupMyMessages)) return
    syncGroupMembersMyCountFromDetail(chatroomId, sessionDetail!.groupMyMessages as number)
  }, [sessionDetail?.groupMyMessages, sessionDetail?.wxid, syncGroupMembersMyCountFromDetail])

  // 复制字段值到剪贴板
  const handleCopyField = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1500)
    } catch {
      // fallback
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1500)
    }
  }, [])

  // 连接数据库
  const connect = useCallback(async () => {
    setConnecting(true)
    setConnectionError(null)
    try {
      const scopePromise = resolveChatCacheScope()
      const result = await window.electronAPI.chat.connect()
      if (result.success) {
        setConnected(true)
        const wxidPromise = window.electronAPI.config.get('myWxid')
        await Promise.all([scopePromise, loadSessions(), loadMyAvatar()])
        // 获取 myWxid 用于匹配个人头像
        const wxid = await wxidPromise
        if (wxid) setMyWxid(wxid as string)
      } else {
        setConnectionError(result.error || '连接失败')
      }
    } catch (e) {
      setConnectionError(String(e))
    } finally {
      setConnecting(false)
    }
  }, [loadMyAvatar, resolveChatCacheScope])

  const handleAccountChanged = useCallback(async () => {
    senderAvatarCache.clear()
    senderAvatarLoading.clear()
    preloadImageKeysRef.current.clear()
    lastPreloadSessionRef.current = null
    pendingSessionLoadRef.current = null
    initialLoadRequestedSessionRef.current = null
    sessionSwitchRequestSeqRef.current += 1
    sessionWindowCacheRef.current.clear()
    setIsSessionSwitching(false)
    setSessionDetail(null)
    setIsRefreshingDetailStats(false)
    setIsLoadingRelationStats(false)
    setShowDetailPanel(false)
    setShowGroupMembersPanel(false)
    setGroupPanelMembers([])
    setGroupMembersError(null)
    setGroupMembersLoadingHint('')
    setIsRefreshingGroupMembers(false)
    setGroupMemberSearchKeyword('')
    groupMembersRequestSeqRef.current += 1
    groupMembersPanelCacheRef.current.clear()
    hasInitializedGroupMembersRef.current = false
    setIsLoadingGroupMembers(false)
    setCurrentSession(null)
    setSessions([])
    setFilteredSessions([])
    setMessages([])
    setSearchKeyword('')
    setConnectionError(null)
    setConnected(false)
    setConnecting(false)
    setHasMoreMessages(true)
    setHasMoreLater(false)
    const scope = await resolveChatCacheScope()
    hydrateSessionListCache(scope)
    await connect()
  }, [
    connect,
    resolveChatCacheScope,
    hydrateSessionListCache,
    setConnected,
    setConnecting,
    setConnectionError,
    setCurrentSession,
    setFilteredSessions,
    setHasMoreLater,
    setHasMoreMessages,
    setMessages,
    setSearchKeyword,
    setSessionDetail,
    setShowDetailPanel,
    setShowGroupMembersPanel,
    setSessions
  ])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const scope = await resolveChatCacheScope()
      if (cancelled) return
      hydrateSessionListCache(scope)
    })()

    return () => {
      cancelled = true
    }
  }, [resolveChatCacheScope, hydrateSessionListCache])

  // 同步 currentSessionId 到 ref
  useEffect(() => {
    currentSessionRef.current = currentSessionId
  }, [currentSessionId])

  const hydrateSessionStatuses = useCallback(async (sessionList: ChatSession[]) => {
    const usernames = sessionList.map((s) => s.username).filter(Boolean)
    if (usernames.length === 0) return

    try {
      const result = await window.electronAPI.chat.getSessionStatuses(usernames)
      if (!result.success || !result.map) return

      const statusMap = result.map
      const { sessions: latestSessions } = useChatStore.getState()
      if (!Array.isArray(latestSessions) || latestSessions.length === 0) return

      let hasChanges = false
      const updatedSessions = latestSessions.map((session) => {
        const status = statusMap[session.username]
        if (!status) return session

        const nextIsFolded = status.isFolded ?? session.isFolded
        const nextIsMuted = status.isMuted ?? session.isMuted
        if (nextIsFolded === session.isFolded && nextIsMuted === session.isMuted) {
          return session
        }

        hasChanges = true
        return {
          ...session,
          isFolded: nextIsFolded,
          isMuted: nextIsMuted
        }
      })

      if (hasChanges) {
        setSessions(updatedSessions)
      }
    } catch (e) {
      console.warn('会话状态补齐失败:', e)
    }
  }, [setSessions])

  // 加载会话列表（优化：先返回基础数据，异步加载联系人信息）
  const loadSessions = async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      setIsRefreshingSessions(true)
    } else {
      setLoadingSessions(true)
    }
    try {
      const scope = await resolveChatCacheScope()
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        // 确保 sessions 是数组
        const sessionsArray = Array.isArray(result.sessions) ? result.sessions : []
        const nextSessions = options?.silent ? mergeSessions(sessionsArray) : sessionsArray
        // 确保 nextSessions 也是数组
        if (Array.isArray(nextSessions)) {


          setSessions(nextSessions)
          sessionsRef.current = nextSessions
          persistSessionListCache(scope, nextSessions)
          void hydrateSessionStatuses(nextSessions)
          // 立即启动联系人信息加载，不再延迟 500ms
          void enrichSessionsContactInfo(nextSessions)
        } else {
          console.error('mergeSessions returned non-array:', nextSessions)
          setSessions(sessionsArray)
          sessionsRef.current = sessionsArray
          persistSessionListCache(scope, sessionsArray)
          void hydrateSessionStatuses(sessionsArray)
          void enrichSessionsContactInfo(sessionsArray)
        }
      } else if (!result.success) {
        setConnectionError(result.error || '获取会话失败')
      }
    } catch (e) {
      console.error('加载会话失败:', e)
      setConnectionError('加载会话失败')
    } finally {
      if (options?.silent) {
        setIsRefreshingSessions(false)
      } else {
        setLoadingSessions(false)
      }
    }
  }

  // 分批异步加载联系人信息（优化性能：防止重复加载，滚动时暂停，只在空闲时加载）
  const enrichSessionsContactInfo = async (sessions: ChatSession[]) => {
    if (sessions.length === 0) return

    // 防止重复加载
    if (isEnrichingRef.current) {

      return
    }

    isEnrichingRef.current = true
    enrichCancelledRef.current = false


    const totalStart = performance.now()

    // 移除初始 500ms 延迟，让后台加载与 UI 渲染并行

    // 检查是否被取消
    if (enrichCancelledRef.current) {
      isEnrichingRef.current = false
      return
    }

    try {
      // 找出需要加载联系人信息的会话（没有头像或者没有显示名称的）
      const needEnrich = sessions.filter(s => !s.avatarUrl || !s.displayName || s.displayName === s.username)
      if (needEnrich.length === 0) {

        isEnrichingRef.current = false
        return
      }



      // 批量补齐联系人，平衡吞吐和 UI 流畅性
      const batchSize = 8
      let loadedCount = 0

      for (let i = 0; i < needEnrich.length; i += batchSize) {
        // 如果正在滚动，暂停加载
        if (isScrollingRef.current) {

          // 等待滚动结束
          while (isScrollingRef.current && !enrichCancelledRef.current) {
            await new Promise(resolve => setTimeout(resolve, 120))
          }
          if (enrichCancelledRef.current) break
        }

        // 检查是否被取消
        if (enrichCancelledRef.current) break

        const batchStart = performance.now()
        const batch = needEnrich.slice(i, i + batchSize)
        const usernames = batch.map(s => s.username)

        // 使用 requestIdleCallback 延迟执行，避免阻塞UI
        await new Promise<void>((resolve) => {
          if ('requestIdleCallback' in window) {
            window.requestIdleCallback(() => {
              void loadContactInfoBatch(usernames).then(() => resolve())
            }, { timeout: 700 })
          } else {
            setTimeout(() => {
              void loadContactInfoBatch(usernames).then(() => resolve())
            }, 80)
          }
        })

        loadedCount += batch.length
        const batchTime = performance.now() - batchStart
        if (batchTime > 200) {
          console.warn(`[性能监控] 批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(needEnrich.length / batchSize)} 耗时: ${batchTime.toFixed(2)}ms (已加载: ${loadedCount}/${needEnrich.length})`)
        }

        // 批次间延迟，给UI更多时间（DLL调用可能阻塞，需要更长的延迟）
        if (i + batchSize < needEnrich.length && !enrichCancelledRef.current) {
          const delay = isScrollingRef.current ? 260 : 120
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }

      const totalTime = performance.now() - totalStart
      if (!enrichCancelledRef.current) {

      } else {

      }
    } catch (e) {
      console.error('加载联系人信息失败:', e)
    } finally {
      isEnrichingRef.current = false
    }
  }

  // 联系人信息更新队列（防抖批量更新，避免频繁重渲染）
  const contactUpdateQueueRef = useRef<Map<string, { displayName?: string; avatarUrl?: string }>>(new Map())
  const contactUpdateTimerRef = useRef<number | null>(null)
  const lastUpdateTimeRef = useRef(0)

  // 批量更新联系人信息（防抖，减少重渲染次数，增加延迟避免阻塞滚动）
  const flushContactUpdates = useCallback(() => {
    if (contactUpdateTimerRef.current) {
      clearTimeout(contactUpdateTimerRef.current)
      contactUpdateTimerRef.current = null
    }

    // 使用短防抖，让头像和昵称更快补齐但依然避免频繁重渲染
    contactUpdateTimerRef.current = window.setTimeout(() => {
      const updates = contactUpdateQueueRef.current
      if (updates.size === 0) return

      const now = Date.now()
      // 如果距离上次更新太近（小于250ms），继续延迟
      if (now - lastUpdateTimeRef.current < 250) {
        contactUpdateTimerRef.current = window.setTimeout(() => {
          flushContactUpdates()
        }, 250 - (now - lastUpdateTimeRef.current))
        return
      }

      const { sessions: currentSessions } = useChatStore.getState()
      if (!Array.isArray(currentSessions)) return

      let hasChanges = false
      const updatedSessions = currentSessions.map(session => {
        const update = updates.get(session.username)
        if (update) {
          const newDisplayName = update.displayName || session.displayName || session.username
          const newAvatarUrl = update.avatarUrl || session.avatarUrl
          if (newDisplayName !== session.displayName || newAvatarUrl !== session.avatarUrl) {
            hasChanges = true
            return {
              ...session,
              displayName: newDisplayName,
              avatarUrl: newAvatarUrl
            }
          }
        }
        return session
      })

      if (hasChanges) {
        const updateStart = performance.now()
        setSessions(updatedSessions)
        lastUpdateTimeRef.current = Date.now()
        const updateTime = performance.now() - updateStart
        if (updateTime > 50) {
          console.warn(`[性能监控] setSessions更新耗时: ${updateTime.toFixed(2)}ms, 更新了 ${updates.size} 个联系人`)
        }
      }

      updates.clear()
      contactUpdateTimerRef.current = null
    }, 120)
  }, [setSessions])

  // 加载一批联系人信息并更新会话列表（优化：使用队列批量更新）
  const loadContactInfoBatch = async (usernames: string[]) => {
    const startTime = performance.now()
    try {
      // 在 DLL 调用前让出控制权（使用 setTimeout 0 代替 setImmediate）
      await new Promise(resolve => setTimeout(resolve, 0))

      const dllStart = performance.now()
      const result = await window.electronAPI.chat.enrichSessionsContactInfo(usernames) as {
        success: boolean
        contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
        error?: string
      }
      const dllTime = performance.now() - dllStart

      // DLL 调用后再次让出控制权
      await new Promise(resolve => setTimeout(resolve, 0))

      const totalTime = performance.now() - startTime
      if (dllTime > 50 || totalTime > 100) {
        console.warn(`[性能监控] DLL调用耗时: ${dllTime.toFixed(2)}ms, 总耗时: ${totalTime.toFixed(2)}ms, usernames: ${usernames.length}`)
      }

      if (result.success && result.contacts) {
        // 将更新加入队列，用于侧边栏更新
        const contacts = result.contacts || {}
        for (const [username, contact] of Object.entries(contacts)) {
          contactUpdateQueueRef.current.set(username, contact)

          // 如果是自己的信息且当前个人头像为空，同步更新
          if (myWxid && username === myWxid && contact.avatarUrl && !myAvatarUrl) {

            setMyAvatarUrl(contact.avatarUrl)
          }

          // 【核心优化】同步更新全局发送者头像缓存，供 MessageBubble 使用
          senderAvatarCache.set(username, {
            avatarUrl: contact.avatarUrl,
            displayName: contact.displayName
          })
        }
        // 触发批量更新
        flushContactUpdates()
      }
    } catch (e) {
      console.error('加载联系人信息批次失败:', e)
    }
  }

  // 刷新会话列表
  const handleRefresh = async () => {
    setJumpStartTime(0)
    setJumpEndTime(0)
    setHasMoreLater(false)
    await loadSessions({ silent: true })
  }

  // 刷新当前会话消息（增量更新新消息）
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false)

  /**
   * 极速增量刷新：基于最后一条消息时间戳，获取后续新消息
   * (由用户建议：记住上一条消息时间，自动取之后的并渲染，然后后台兜底全量同步)
   */
  const handleIncrementalRefresh = async () => {
    if (!currentSessionId || isRefreshingRef.current) return
    isRefreshingRef.current = true
    setIsRefreshingMessages(true)

    // 找出当前已渲染消息中的最大时间戳（使用 getState 获取最新状态，避免闭包过时导致重复）
    const currentMessages = useChatStore.getState().messages || []
    const lastMsg = currentMessages[currentMessages.length - 1]
    const minTime = lastMsg?.createTime || 0

    // 1. 优先执行增量查询并渲染（第一步）
    try {
      const result = await (window.electronAPI.chat as any).getNewMessages(currentSessionId, minTime) as {
        success: boolean;
        messages?: Message[];
        error?: string
      }

      if (result.success && result.messages && result.messages.length > 0) {
        // 过滤去重：必须对比实时的状态，防止在 handleRefreshMessages 运行期间导致的冲突
        const latestMessages = useChatStore.getState().messages || []
        const existingKeys = new Set(latestMessages.map(getMessageKey))
        const newOnes = result.messages.filter(m => !existingKeys.has(getMessageKey(m)))

        if (newOnes.length > 0) {
          appendMessages(newOnes, false)
          flashNewMessages(newOnes.map(getMessageKey))
          // 滚动到底部
          requestAnimationFrame(() => {
            if (messageListRef.current) {
              messageListRef.current.scrollTop = messageListRef.current.scrollHeight
            }
          })
        }
      }
    } catch (e) {
      console.warn('[IncrementalRefresh] 失败，将依赖全量同步兜底:', e)
    } finally {
      isRefreshingRef.current = false
      setIsRefreshingMessages(false)
    }
  }

  const handleRefreshMessages = async () => {
    if (!currentSessionId || isRefreshingRef.current) return
    setJumpStartTime(0)
    setJumpEndTime(0)
    setHasMoreLater(false)
    setIsRefreshingMessages(true)
    isRefreshingRef.current = true
    try {
      // 获取最新消息并增量添加
      const result = await window.electronAPI.chat.getLatestMessages(currentSessionId, 50) as {
        success: boolean;
        messages?: Message[];
        error?: string
      }
      if (!result.success || !result.messages) {
        return
      }
      // 使用实时状态进行去重对比
      const latestMessages = useChatStore.getState().messages || []
      const existing = new Set(latestMessages.map(getMessageKey))
      const lastMsg = latestMessages[latestMessages.length - 1]
      const lastTime = lastMsg?.createTime ?? 0

      const newMessages = result.messages.filter((msg) => {
        const key = getMessageKey(msg)
        if (existing.has(key)) return false
        // 这里的 lastTime 仅作参考过滤，主要的去重靠 key
        if (lastTime > 0 && msg.createTime < lastTime - 3600) return false // 仅过滤 1 小时之前的冗余请求
        return true
      })
      if (newMessages.length > 0) {
        appendMessages(newMessages, false)
        flashNewMessages(newMessages.map(getMessageKey))
        // 滚动到底部
        requestAnimationFrame(() => {
          if (messageListRef.current) {
            messageListRef.current.scrollTop = messageListRef.current.scrollHeight
          }
        })
      }
    } catch (e) {
      console.error('刷新消息失败:', e)
    } finally {
      isRefreshingRef.current = false
      setIsRefreshingMessages(false)
    }
  }
  // 消息批量大小控制（保持稳定，避免游标反复重建）
  const currentBatchSizeRef = useRef(50)

  const warmupGroupSenderProfiles = useCallback((usernames: string[], defer = false) => {
    if (!Array.isArray(usernames) || usernames.length === 0) return

    const runWarmup = () => {
      const batchPromise = loadContactInfoBatch(usernames)
      usernames.forEach(username => {
        if (!senderAvatarLoading.has(username)) {
          senderAvatarLoading.set(username, batchPromise.then(() => senderAvatarCache.get(username) || null))
        }
      })
      batchPromise.finally(() => {
        usernames.forEach(username => senderAvatarLoading.delete(username))
      })
    }

    if (defer) {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => {
          runWarmup()
        }, { timeout: 1200 })
      } else {
        globalThis.setTimeout(runWarmup, 120)
      }
      return
    }

    runWarmup()
  }, [loadContactInfoBatch])

  // 加载消息
  const loadMessages = async (
    sessionId: string,
    offset = 0,
    startTime = 0,
    endTime = 0,
    ascending = false,
    options: LoadMessagesOptions = {}
  ) => {
    const listEl = messageListRef.current
    const session = sessionMapRef.current.get(sessionId)
    const unreadCount = session?.unreadCount ?? 0

    let messageLimit = currentBatchSizeRef.current

    if (offset === 0) {
      const preferredLimit = Number.isFinite(options.forceInitialLimit)
        ? Math.max(10, Math.floor(options.forceInitialLimit as number))
        : (unreadCount > 99 ? 30 : 40)
      currentBatchSizeRef.current = preferredLimit
      messageLimit = preferredLimit
    } else {
      // 同一会话内保持固定批量，避免后端游标因 batch 改变而重建
      messageLimit = currentBatchSizeRef.current
    }


    if (offset === 0) {
      setLoadingMessages(true)
      // 切会话时保留旧内容作为过渡，避免大面积闪烁
      setHasInitialMessages(true)
    } else {
      setLoadingMore(true)
    }

    // 记录加载前的第一条消息元素
    const firstMsgEl = listEl?.querySelector('.message-wrapper') as HTMLElement | null

    try {
      const useLatestPath = offset === 0 && startTime === 0 && endTime === 0 && !ascending && options.preferLatestPath
      const result = (useLatestPath
        ? await window.electronAPI.chat.getLatestMessages(sessionId, messageLimit)
        : await window.electronAPI.chat.getMessages(sessionId, offset, messageLimit, startTime, endTime, ascending)
      ) as {
        success: boolean;
        messages?: Message[];
        hasMore?: boolean;
        error?: string
      }
      if (options.switchRequestSeq && options.switchRequestSeq !== sessionSwitchRequestSeqRef.current) {
        return
      }
      if (currentSessionRef.current !== sessionId) {
        return
      }
      if (result.success && result.messages) {
        if (offset === 0) {
          setMessages(result.messages)
          persistSessionPreviewCache(sessionId, result.messages)
          if (result.messages.length === 0) {
            setNoMessageTable(true)
            setHasMoreMessages(false)
          }

          // 群聊发送者信息补齐改为非阻塞执行，避免影响首屏切换
          const isGroup = sessionId.includes('@chatroom')
          if (isGroup && result.messages.length > 0) {
            const unknownSenders = [...new Set(result.messages
              .filter(m => m.isSend !== 1 && m.senderUsername && !senderAvatarCache.has(m.senderUsername))
              .map(m => m.senderUsername as string)
            )]
            if (unknownSenders.length > 0) {
              warmupGroupSenderProfiles(unknownSenders, options.deferGroupSenderWarmup === true)
            }
          }

          // 日期跳转时滚动到顶部，否则滚动到底部
          requestAnimationFrame(() => {
            if (messageListRef.current) {
              if (isDateJumpRef.current) {
                messageListRef.current.scrollTop = 0
                isDateJumpRef.current = false
              } else {
                messageListRef.current.scrollTop = messageListRef.current.scrollHeight
              }
            }
          })
        } else {
          appendMessages(result.messages, true)

          // 加载更多也同样处理发送者信息预取
          const isGroup = sessionId.includes('@chatroom')
          if (isGroup) {
            const unknownSenders = [...new Set(result.messages
              .filter(m => m.isSend !== 1 && m.senderUsername && !senderAvatarCache.has(m.senderUsername))
              .map(m => m.senderUsername as string)
            )]
            if (unknownSenders.length > 0) {
              warmupGroupSenderProfiles(unknownSenders, false)
            }
          }

          // 加载更多后保持位置：让之前的第一条消息保持在原来的视觉位置
          if (firstMsgEl && listEl) {
            requestAnimationFrame(() => {
              listEl.scrollTop = firstMsgEl.offsetTop - 80
            })
          }
        }
        // 日期跳转(ascending=true)：不往上加载更早的，往下加载更晚的
        if (ascending) {
          setHasMoreMessages(false)
          setHasMoreLater(result.hasMore ?? false)
        } else {
          setHasMoreMessages(result.hasMore ?? false)
          if (offset === 0) {
            if (endTime > 0) {
              setHasMoreLater(true)
            } else {
              setHasMoreLater(false)
            }
          }
        }
        setCurrentOffset(offset + result.messages.length)
      } else if (!result.success) {
        setNoMessageTable(true)
        setHasMoreMessages(false)
      }
    } catch (e) {
      console.error('加载消息失败:', e)
      setConnectionError('加载消息失败')
      setHasMoreMessages(false)
      if (offset === 0 && currentSessionRef.current === sessionId) {
        setMessages([])
      }
    } finally {
      setLoadingMessages(false)
      setLoadingMore(false)
      if (offset === 0 && pendingSessionLoadRef.current === sessionId) {
        if (!options.switchRequestSeq || options.switchRequestSeq === sessionSwitchRequestSeqRef.current) {
          pendingSessionLoadRef.current = null
          initialLoadRequestedSessionRef.current = null
          setIsSessionSwitching(false)
        }
      }
    }
  }

  // 加载更晚的消息
  const loadLaterMessages = useCallback(async () => {
    if (!currentSessionId || isLoadingMore || isLoadingMessages || messages.length === 0) return

    setLoadingMore(true)
    try {
      const lastMsg = messages[messages.length - 1]
      // 从最后一条消息的时间开始往后找
      const result = await window.electronAPI.chat.getMessages(currentSessionId, 0, 50, lastMsg.createTime, 0, true) as {
        success: boolean;
        messages?: Message[];
        hasMore?: boolean;
        error?: string
      }

      if (result.success && result.messages) {
        // 过滤掉已经在列表中的重复消息
        const existingKeys = messageKeySetRef.current
        const newMsgs = result.messages.filter(m => !existingKeys.has(getMessageKey(m)))

        if (newMsgs.length > 0) {
          appendMessages(newMsgs, false)
        }
        setHasMoreLater(result.hasMore ?? false)
      }
    } catch (e) {
      console.error('加载后续消息失败:', e)
    } finally {
      setLoadingMore(false)
    }
  }, [currentSessionId, isLoadingMore, isLoadingMessages, messages, getMessageKey, appendMessages, setHasMoreLater, setLoadingMore])

  const refreshSessionIncrementally = useCallback(async (sessionId: string, switchRequestSeq?: number) => {
    const currentMessages = useChatStore.getState().messages || []
    const lastMsg = currentMessages[currentMessages.length - 1]
    const minTime = lastMsg?.createTime || 0
    if (!sessionId || minTime <= 0) return

    try {
      const result = await window.electronAPI.chat.getNewMessages(sessionId, minTime, 120) as {
        success: boolean
        messages?: Message[]
        error?: string
      }
      if (switchRequestSeq && switchRequestSeq !== sessionSwitchRequestSeqRef.current) return
      if (currentSessionRef.current !== sessionId) return
      if (!result.success || !Array.isArray(result.messages) || result.messages.length === 0) return

      const latestMessages = useChatStore.getState().messages || []
      const existing = new Set(latestMessages.map(getMessageKey))
      const newMessages = result.messages.filter((msg) => !existing.has(getMessageKey(msg)))
      if (newMessages.length > 0) {
        appendMessages(newMessages, false)
      }
    } catch (error) {
      console.warn('[SessionCache] 增量刷新失败:', error)
    }
  }, [appendMessages, getMessageKey])

  // 选择会话
  const selectSessionById = useCallback((sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId || normalizedSessionId === currentSessionId) return
    const switchRequestSeq = sessionSwitchRequestSeqRef.current + 1
    sessionSwitchRequestSeqRef.current = switchRequestSeq

    setCurrentSession(normalizedSessionId, { preserveMessages: false })
    setNoMessageTable(false)

    const restoredFromWindowCache = restoreSessionWindowCache(normalizedSessionId)
    if (restoredFromWindowCache) {
      pendingSessionLoadRef.current = null
      initialLoadRequestedSessionRef.current = null
      setIsSessionSwitching(false)
      void refreshSessionIncrementally(normalizedSessionId, switchRequestSeq)
    } else {
      pendingSessionLoadRef.current = normalizedSessionId
      initialLoadRequestedSessionRef.current = normalizedSessionId
      setIsSessionSwitching(true)
      void hydrateSessionPreview(normalizedSessionId)
      setCurrentOffset(0)
      setJumpStartTime(0)
      setJumpEndTime(0)
      void loadMessages(normalizedSessionId, 0, 0, 0, false, {
        preferLatestPath: true,
        deferGroupSenderWarmup: true,
        forceInitialLimit: 30,
        switchRequestSeq
      })
    }
    // 切换会话后回到正常聊天窗口：收起详情侧栏，详情需手动再次展开
    setShowDetailPanel(false)
    setShowGroupMembersPanel(false)
    setGroupMemberSearchKeyword('')
    setGroupMembersError(null)
    setGroupMembersLoadingHint('')
    setIsRefreshingGroupMembers(false)
    groupMembersRequestSeqRef.current += 1
    setIsLoadingGroupMembers(false)
    setSessionDetail(null)
    setIsRefreshingDetailStats(false)
    setIsLoadingRelationStats(false)
  }, [
    currentSessionId,
    setCurrentSession,
    restoreSessionWindowCache,
    refreshSessionIncrementally,
    hydrateSessionPreview,
    loadMessages
  ])

  // 选择会话
  const handleSelectSession = (session: ChatSession) => {
    // 点击折叠群入口，切换到折叠群视图
    if (session.username.toLowerCase().includes('placeholder_foldgroup')) {
      setFoldedView(true)
      return
    }
    selectSessionById(session.username)
  }

  // 搜索过滤
  const handleSearch = (keyword: string) => {
    setSearchKeyword(keyword)
  }

  // 关闭搜索框
  const handleCloseSearch = () => {
    setSearchKeyword('')
  }

  // 滚动加载更多 + 显示/隐藏回到底部按钮（优化：节流，避免频繁执行）
  const scrollTimeoutRef = useRef<number | null>(null)
  const handleScroll = useCallback(() => {
    if (!messageListRef.current) return

    // 节流：延迟执行，避免滚动时频繁计算
    if (scrollTimeoutRef.current) {
      cancelAnimationFrame(scrollTimeoutRef.current)
    }

    scrollTimeoutRef.current = requestAnimationFrame(() => {
      if (!messageListRef.current) return

      const { scrollTop, clientHeight, scrollHeight } = messageListRef.current

      // 显示回到底部按钮：距离底部超过 300px
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      setShowScrollToBottom(distanceFromBottom > 300)

      // 预加载：当滚动到顶部 30% 区域时开始加载
      if (!isLoadingMore && !isLoadingMessages && hasMoreMessages && currentSessionId) {
        const threshold = clientHeight * 0.3
        if (scrollTop < threshold) {
          loadMessages(currentSessionId, currentOffset, jumpStartTime, jumpEndTime)
        }
      }

      // 预加载更晚的消息
      if (!isLoadingMore && !isLoadingMessages && hasMoreLater && currentSessionId) {
        const threshold = clientHeight * 0.3
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight
        if (distanceFromBottom < threshold) {
          loadLaterMessages()
        }
      }
    })
  }, [isLoadingMore, isLoadingMessages, hasMoreMessages, hasMoreLater, currentSessionId, currentOffset, jumpStartTime, jumpEndTime, loadMessages, loadLaterMessages])


  const isSameSession = useCallback((prev: ChatSession, next: ChatSession): boolean => {
    return (
      prev.username === next.username &&
      prev.type === next.type &&
      prev.unreadCount === next.unreadCount &&
      prev.summary === next.summary &&
      prev.sortTimestamp === next.sortTimestamp &&
      prev.lastTimestamp === next.lastTimestamp &&
      prev.lastMsgType === next.lastMsgType &&
      prev.displayName === next.displayName &&
      prev.avatarUrl === next.avatarUrl
    )
  }, [])

  const mergeSessions = useCallback((nextSessions: ChatSession[]) => {
    // 确保输入是数组
    if (!Array.isArray(nextSessions)) {
      console.warn('mergeSessions: nextSessions is not an array:', nextSessions)
      return Array.isArray(sessionsRef.current) ? sessionsRef.current : []
    }
    if (!Array.isArray(sessionsRef.current) || sessionsRef.current.length === 0) {
      return nextSessions
    }
    const prevMap = new Map(sessionsRef.current.map((s) => [s.username, s]))
    return nextSessions.map((next) => {
      const prev = prevMap.get(next.username)
      if (!prev) return next
      return isSameSession(prev, next) ? prev : next
    })
  }, [isSameSession])

  const flashNewMessages = useCallback((keys: string[]) => {
    if (keys.length === 0) return
    setHighlightedMessageKeys((prev) => [...prev, ...keys])
    window.setTimeout(() => {
      setHighlightedMessageKeys((prev) => prev.filter((k) => !keys.includes(k)))
    }, 2500)
  }, [])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: 'smooth'
      })
    }
  }, [])

  // 拖动调节侧边栏宽度
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)

    const startX = e.clientX
    const startWidth = sidebarWidth

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      const newWidth = Math.min(Math.max(startWidth + delta, 200), 400)
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [sidebarWidth])

  // 初始化连接
  useEffect(() => {
    if (!isConnected && !isConnecting) {
      connect()
    }

    // 组件卸载时清理
    return () => {
      avatarLoadQueue.clear()
      if (previewPersistTimerRef.current !== null) {
        window.clearTimeout(previewPersistTimerRef.current)
        previewPersistTimerRef.current = null
      }
      if (sessionListPersistTimerRef.current !== null) {
        window.clearTimeout(sessionListPersistTimerRef.current)
        sessionListPersistTimerRef.current = null
      }
      if (contactUpdateTimerRef.current) {
        clearTimeout(contactUpdateTimerRef.current)
      }
      if (sessionScrollTimeoutRef.current) {
        clearTimeout(sessionScrollTimeoutRef.current)
      }
      contactUpdateQueueRef.current.clear()
      enrichCancelledRef.current = true
      isEnrichingRef.current = false
    }
  }, [])

  useEffect(() => {
    const handleChange = () => {
      void handleAccountChanged()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [handleAccountChanged])

  useEffect(() => {
    const nextSet = new Set<string>()
    for (const msg of messages) {
      nextSet.add(getMessageKey(msg))
    }
    messageKeySetRef.current = nextSet
    const lastMsg = messages[messages.length - 1]
    lastMessageTimeRef.current = lastMsg?.createTime ?? 0
  }, [messages, getMessageKey])

  useEffect(() => {
    currentSessionRef.current = currentSessionId
  }, [currentSessionId])

  useEffect(() => {
    if (currentSessionId !== lastPreloadSessionRef.current) {
      preloadImageKeysRef.current.clear()
      lastPreloadSessionRef.current = currentSessionId
    }
  }, [currentSessionId])

  useEffect(() => {
    if (!currentSessionId || messages.length === 0) return
    const preloadEdgeCount = 40
    const maxPreload = 30
    const head = messages.slice(0, preloadEdgeCount)
    const tail = messages.slice(-preloadEdgeCount)
    const candidates = [...head, ...tail]
    const queued = preloadImageKeysRef.current
    const seen = new Set<string>()
    const payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }> = []
    for (const msg of candidates) {
      if (payloads.length >= maxPreload) break
      if (msg.localType !== 3) continue
      const cacheKey = msg.imageMd5 || msg.imageDatName || `local:${msg.localId}`
      if (!msg.imageMd5 && !msg.imageDatName) continue
      if (imageDataUrlCache.has(cacheKey)) continue
      const taskKey = `${currentSessionId}|${cacheKey}`
      if (queued.has(taskKey) || seen.has(taskKey)) continue
      queued.add(taskKey)
      seen.add(taskKey)
      payloads.push({
        sessionId: currentSessionId,
        imageMd5: msg.imageMd5 || undefined,
        imageDatName: msg.imageDatName
      })
    }
    if (payloads.length > 0) {
      window.electronAPI.image.preload(payloads).catch(() => { })
    }
  }, [currentSessionId, messages])

  useEffect(() => {
    const nextMap = new Map<string, ChatSession>()
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        nextMap.set(session.username, session)
      }
    }
    sessionMapRef.current = nextMap
  }, [sessions])

  useEffect(() => {
    sessionsRef.current = Array.isArray(sessions) ? sessions : []
  }, [sessions])

  useEffect(() => {
    isLoadingMessagesRef.current = isLoadingMessages
    isLoadingMoreRef.current = isLoadingMore
  }, [isLoadingMessages, isLoadingMore])

  useEffect(() => {
    if (initialRevealTimerRef.current !== null) {
      window.clearTimeout(initialRevealTimerRef.current)
      initialRevealTimerRef.current = null
    }
    if (!isLoadingMessages) {
      if (messages.length === 0) {
        setHasInitialMessages(true)
      } else {
        initialRevealTimerRef.current = window.setTimeout(() => {
          setHasInitialMessages(true)
          initialRevealTimerRef.current = null
        }, 120)
      }
    }
  }, [isLoadingMessages, messages.length])

  useEffect(() => {
    if (currentSessionId !== prevSessionRef.current) {
      prevSessionRef.current = currentSessionId
      setNoMessageTable(false)
      if (initialRevealTimerRef.current !== null) {
        window.clearTimeout(initialRevealTimerRef.current)
        initialRevealTimerRef.current = null
      }
      if (messages.length === 0) {
        setHasInitialMessages(false)
      } else if (!isLoadingMessages) {
        setHasInitialMessages(true)
      }
    }
  }, [currentSessionId, messages.length, isLoadingMessages])

  useEffect(() => {
    if (currentSessionId && messages.length === 0 && !isLoadingMessages && !isLoadingMore && !noMessageTable) {
      if (pendingSessionLoadRef.current === currentSessionId) return
      if (initialLoadRequestedSessionRef.current === currentSessionId) return
      initialLoadRequestedSessionRef.current = currentSessionId
      setHasInitialMessages(false)
      void loadMessages(currentSessionId, 0, 0, 0, false, {
        preferLatestPath: true,
        deferGroupSenderWarmup: true,
        forceInitialLimit: 30
      })
    }
  }, [currentSessionId, messages.length, isLoadingMessages, isLoadingMore, noMessageTable])

  useEffect(() => {
    return () => {
      if (initialRevealTimerRef.current !== null) {
        window.clearTimeout(initialRevealTimerRef.current)
        initialRevealTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    isConnectedRef.current = isConnected
  }, [isConnected])

  useEffect(() => {
    searchKeywordRef.current = searchKeyword
  }, [searchKeyword])

  useEffect(() => {
    if (!currentSessionId || !Array.isArray(messages) || messages.length === 0) return
    persistSessionPreviewCache(currentSessionId, messages)
    saveSessionWindowCache(currentSessionId, {
      messages,
      currentOffset,
      hasMoreMessages,
      hasMoreLater,
      jumpStartTime,
      jumpEndTime
    })
  }, [
    currentSessionId,
    messages,
    currentOffset,
    hasMoreMessages,
    hasMoreLater,
    jumpStartTime,
    jumpEndTime,
    persistSessionPreviewCache,
    saveSessionWindowCache
  ])

  useEffect(() => {
    if (!Array.isArray(sessions) || sessions.length === 0) return
    if (sessionListPersistTimerRef.current !== null) {
      window.clearTimeout(sessionListPersistTimerRef.current)
    }
    sessionListPersistTimerRef.current = window.setTimeout(() => {
      persistSessionListCache(chatCacheScopeRef.current, sessions)
      sessionListPersistTimerRef.current = null
    }, 260)
  }, [sessions, persistSessionListCache])

  // 普通视图：隐藏 isFolded 的群，保留 placeholder_foldgroup 入口
  useEffect(() => {
    if (!Array.isArray(sessions)) {
      setFilteredSessions([])
      return
    }
    const visible = sessions.filter(s => {
      if (s.isFolded && !s.username.toLowerCase().includes('placeholder_foldgroup')) return false
      return true
    })
    if (!searchKeyword.trim()) {
      setFilteredSessions(visible)
      return
    }
    const lower = searchKeyword.toLowerCase()
    setFilteredSessions(visible.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    ))
  }, [sessions, searchKeyword, setFilteredSessions])

  // 折叠群列表（独立计算，供折叠 panel 使用）
  const foldedSessions = useMemo(() => {
    if (!Array.isArray(sessions)) return []
    const folded = sessions.filter(s => s.isFolded)
    if (!searchKeyword.trim() || !foldedView) return folded
    const lower = searchKeyword.toLowerCase()
    return folded.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    )
  }, [sessions, searchKeyword, foldedView])

  const hasSessionRecords = Array.isArray(sessions) && sessions.length > 0
  const shouldShowSessionsSkeleton = isLoadingSessions && !hasSessionRecords
  const isSessionListSyncing = (isLoadingSessions || isRefreshingSessions) && hasSessionRecords


  // 格式化会话时间（相对时间）- 使用 useMemo 缓存，避免每次渲染都计算
  const formatSessionTime = useCallback((timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return ''

    const now = Date.now()
    const msgTime = timestamp * 1000
    const diff = now - msgTime

    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes}分钟前`
    if (hours < 24) return `${hours}小时前`

    // 超过24小时显示日期
    const date = new Date(msgTime)
    const nowDate = new Date()

    if (date.getFullYear() === nowDate.getFullYear()) {
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }, [])

  // 获取当前会话信息（从通讯录跳转时可能不在 sessions 列表中，构造 fallback）
  const currentSession = (() => {
    const found = Array.isArray(sessions) ? sessions.find(s => s.username === currentSessionId) : undefined
    if (found || !currentSessionId) return found
    return {
      username: currentSessionId,
      type: 0,
      unreadCount: 0,
      summary: '',
      sortTimestamp: 0,
      lastTimestamp: 0,
      lastMsgType: 0,
      displayName: fallbackDisplayName || currentSessionId,
    } as ChatSession
  })()
  const filteredGroupPanelMembers = useMemo(() => {
    const keyword = groupMemberSearchKeyword.trim().toLowerCase()
    if (!keyword) return groupPanelMembers
    return groupPanelMembers.filter((member) => {
      const fields = [
        member.username,
        member.displayName,
        member.groupNickname,
        member.remark,
        member.nickname,
        member.alias
      ]
      return fields.some(field => String(field || '').toLowerCase().includes(keyword))
    })
  }, [groupMemberSearchKeyword, groupPanelMembers])
  const isCurrentSessionExporting = Boolean(currentSessionId && inProgressExportSessionIds.has(currentSessionId))
  const isExportActionBusy = isCurrentSessionExporting || isPreparingExportDialog

  useEffect(() => {
    if (!standaloneSessionWindow) return
    if (!normalizedInitialSessionId) return
    if (!isConnected || isConnecting) return
    if (currentSessionId === normalizedInitialSessionId) return
    selectSessionById(normalizedInitialSessionId)
  }, [
    standaloneSessionWindow,
    normalizedInitialSessionId,
    isConnected,
    isConnecting,
    currentSessionId,
    selectSessionById
  ])

  // 从通讯录跳转时，会话不在列表中，主动加载联系人显示名称
  useEffect(() => {
    if (!currentSessionId) return
    const found = Array.isArray(sessions) ? sessions.find(s => s.username === currentSessionId) : undefined
    if (found) {
      setFallbackDisplayName(null)
      return
    }
    loadContactInfoBatch([currentSessionId]).then(() => {
      const cached = senderAvatarCache.get(currentSessionId)
      if (cached?.displayName) setFallbackDisplayName(cached.displayName)
    })
  }, [currentSessionId, sessions])

  // 渲染日期分隔
  const shouldShowDateDivider = (msg: Message, prevMsg?: Message): boolean => {
    if (!prevMsg) return true
    const date = new Date(msg.createTime * 1000).toDateString()
    const prevDate = new Date(prevMsg.createTime * 1000).toDateString()
    return date !== prevDate
  }

  const formatDateDivider = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知时间'
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) return '今天'

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) return '昨天'

    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  const handleRequireModelDownload = useCallback((sessionId: string, messageId: string) => {
    setPendingVoiceTranscriptRequest({ sessionId, messageId })
    setShowVoiceTranscribeDialog(true)
  }, [])

  // 批量语音转文字
  const handleBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) return
    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) {
      alert('未找到当前会话')
      return
    }
    if (isBatchTranscribing) return

    const result = await window.electronAPI.chat.getAllVoiceMessages(currentSessionId)
    if (!result.success || !result.messages) {
      alert(`获取语音消息失败: ${result.error || '未知错误'}`)
      return
    }

    const voiceMessages: Message[] = result.messages
    if (voiceMessages.length === 0) {
      alert('当前会话没有语音消息')
      return
    }

    const dateSet = new Set<string>()
    voiceMessages.forEach(m => dateSet.add(new Date(m.createTime * 1000).toISOString().slice(0, 10)))
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a))

    setBatchVoiceMessages(voiceMessages)
    setBatchVoiceCount(voiceMessages.length)
    setBatchVoiceDates(sortedDates)
    setBatchSelectedDates(new Set(sortedDates))
    setShowBatchConfirm(true)
  }, [sessions, currentSessionId, isBatchTranscribing])

  const handleBatchDecrypt = useCallback(async () => {
    if (!currentSessionId || isBatchDecrypting) return
    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) {
      alert('未找到当前会话')
      return
    }

    const result = await window.electronAPI.chat.getAllImageMessages(currentSessionId)
    if (!result.success || !result.images) {
      alert(`获取图片消息失败: ${result.error || '未知错误'}`)
      return
    }

    if (result.images.length === 0) {
      alert('当前会话没有图片消息')
      return
    }

    const dateSet = new Set<string>()
    result.images.forEach((img: BatchImageDecryptCandidate) => {
      if (img.createTime) dateSet.add(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    })
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a))

    setBatchImageMessages(result.images)
    setBatchImageDates(sortedDates)
    setBatchImageSelectedDates(new Set(sortedDates))
    setShowBatchDecryptConfirm(true)
  }, [currentSessionId, isBatchDecrypting, sessions])

  const handleExportCurrentSession = useCallback(() => {
    if (!currentSessionId) return
    if (inProgressExportSessionIds.has(currentSessionId) || isPreparingExportDialog) return

    const requestId = `chat-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sessionName = currentSession?.displayName || currentSession?.username || currentSessionId
    pendingExportRequestIdRef.current = requestId
    setIsPreparingExportDialog(true)
    setExportPrepareHint('')
    if (exportPrepareLongWaitTimerRef.current) {
      window.clearTimeout(exportPrepareLongWaitTimerRef.current)
      exportPrepareLongWaitTimerRef.current = null
    }
    emitOpenSingleExport({
      sessionId: currentSessionId,
      sessionName,
      requestId
    })
  }, [currentSession, currentSessionId, inProgressExportSessionIds, isPreparingExportDialog])

  const handleGroupAnalytics = useCallback(() => {
    if (!currentSessionId || !isGroupChatSession(currentSessionId)) return
    navigate('/group-analytics', {
      state: {
        preselectGroupIds: [currentSessionId]
      }
    })
  }, [currentSessionId, navigate, isGroupChatSession])

  // 确认批量转写
  const confirmBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) return

    const selected = batchSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const messages = batchVoiceMessages
    if (!messages || messages.length === 0) {
      setShowBatchConfirm(false)
      return
    }

    const voiceMessages = messages.filter(m =>
      selected.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    )
    if (voiceMessages.length === 0) {
      alert('所选日期下没有语音消息')
      return
    }

    setShowBatchConfirm(false)
    setBatchVoiceMessages(null)
    setBatchVoiceDates([])
    setBatchSelectedDates(new Set())

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return

    startTranscribe(voiceMessages.length, session.displayName || session.username)

    // 检查模型状态
    const modelStatus = await window.electronAPI.whisper.getModelStatus()
    if (!modelStatus?.exists) {
      alert('SenseVoice 模型未下载，请先在设置中下载模型')
      finishTranscribe(0, 0)
      return
    }

    let successCount = 0
    let failCount = 0
    let completedCount = 0
    const concurrency = 10

    const transcribeOne = async (msg: Message) => {
      try {
        const result = await window.electronAPI.chat.getVoiceTranscript(
          session.username,
          String(msg.localId),
          msg.createTime
        )
        return { success: result.success }
      } catch {
        return { success: false }
      }
    }

    for (let i = 0; i < voiceMessages.length; i += concurrency) {
      const batch = voiceMessages.slice(i, i + concurrency)
      const results = await Promise.all(batch.map(msg => transcribeOne(msg)))

      results.forEach(result => {
        if (result.success) successCount++
        else failCount++
        completedCount++
        updateProgress(completedCount, voiceMessages.length)
      })
    }

    finishTranscribe(successCount, failCount)
  }, [sessions, currentSessionId, batchSelectedDates, batchVoiceMessages, startTranscribe, updateProgress, finishTranscribe])

  // 批量转写：按日期的消息数量
  const batchCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchVoiceMessages) return map
    batchVoiceMessages.forEach(m => {
      const d = new Date(m.createTime * 1000).toISOString().slice(0, 10)
      map.set(d, (map.get(d) || 0) + 1)
    })
    return map
  }, [batchVoiceMessages])

  // 批量转写：选中日期对应的语音条数
  const batchSelectedMessageCount = useMemo(() => {
    if (!batchVoiceMessages) return 0
    return batchVoiceMessages.filter(m =>
      batchSelectedDates.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchVoiceMessages, batchSelectedDates])

  const toggleBatchDate = useCallback((date: string) => {
    setBatchSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchDates = useCallback(() => setBatchSelectedDates(new Set(batchVoiceDates)), [batchVoiceDates])
  const clearAllBatchDates = useCallback(() => setBatchSelectedDates(new Set()), [])

  const confirmBatchDecrypt = useCallback(async () => {
    if (!currentSessionId) return

    const selected = batchImageSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const images = (batchImageMessages || []).filter(img =>
      img.createTime && selected.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    )
    if (images.length === 0) {
      alert('所选日期下没有图片消息')
      return
    }

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return

    setShowBatchDecryptConfirm(false)
    setBatchImageMessages(null)
    setBatchImageDates([])
    setBatchImageSelectedDates(new Set())

    startDecrypt(images.length, session.displayName || session.username)

    let successCount = 0
    let failCount = 0
    let completed = 0
    const concurrency = batchDecryptConcurrency

    const decryptOne = async (img: typeof images[0]) => {
      try {
        const r = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: img.imageMd5,
          imageDatName: img.imageDatName,
          force: true
        })
        if (r?.success) successCount++
        else failCount++
      } catch {
        failCount++
      }
      completed++
      updateDecryptProgress(completed, images.length)
    }

    // 并发池：同时跑 concurrency 个任务
    const pool: Promise<void>[] = []
    for (const img of images) {
      const p = decryptOne(img)
      pool.push(p)
      if (pool.length >= concurrency) {
        await Promise.race(pool)
        // 移除已完成的
        for (let j = pool.length - 1; j >= 0; j--) {
          const settled = await Promise.race([pool[j].then(() => true), Promise.resolve(false)])
          if (settled) pool.splice(j, 1)
        }
      }
    }
    await Promise.all(pool)

    finishDecrypt(successCount, failCount)
  }, [batchImageMessages, batchImageSelectedDates, batchDecryptConcurrency, currentSessionId, finishDecrypt, sessions, startDecrypt, updateDecryptProgress])

  const batchImageCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchImageMessages) return map
    batchImageMessages.forEach(img => {
      if (!img.createTime) return
      const d = new Date(img.createTime * 1000).toISOString().slice(0, 10)
      map.set(d, (map.get(d) ?? 0) + 1)
    })
    return map
  }, [batchImageMessages])

  const batchImageSelectedCount = useMemo(() => {
    if (!batchImageMessages) return 0
    return batchImageMessages.filter(img =>
      img.createTime && batchImageSelectedDates.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchImageMessages, batchImageSelectedDates])

  const toggleBatchImageDate = useCallback((date: string) => {
    setBatchImageSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchImageDates = useCallback(() => setBatchImageSelectedDates(new Set(batchImageDates)), [batchImageDates])
  const clearAllBatchImageDates = useCallback(() => setBatchImageSelectedDates(new Set()), [])

  const lastSelectedIdRef = useRef<number | null>(null)

  const handleToggleSelection = useCallback((localId: number, isShiftKey: boolean = false) => {
    setSelectedMessages(prev => {
      const next = new Set(prev)

      // Range selection with Shift key
      if (isShiftKey && lastSelectedIdRef.current !== null && lastSelectedIdRef.current !== localId) {
        const currentMsgs = useChatStore.getState().messages || []
        const idx1 = currentMsgs.findIndex(m => m.localId === lastSelectedIdRef.current)
        const idx2 = currentMsgs.findIndex(m => m.localId === localId)

        if (idx1 !== -1 && idx2 !== -1) {
          const start = Math.min(idx1, idx2)
          const end = Math.max(idx1, idx2)
          for (let i = start; i <= end; i++) {
            next.add(currentMsgs[i].localId)
          }
        }
      } else {
        // Normal toggle
        if (next.has(localId)) {
          next.delete(localId)
          lastSelectedIdRef.current = null // Reset last selection on uncheck? Or keep? Usually keep last interaction.
        } else {
          next.add(localId)
          lastSelectedIdRef.current = localId
        }
      }
      return next
    })
  }, [])

  const formatBatchDateLabel = useCallback((dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number)
    return `${y}年${m}月${d}日`
  }, [])

  // 消息右键菜单处理
  const handleContextMenu = useCallback((e: React.MouseEvent, message: Message) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      message
    })
  }, [])

  // 关闭右键菜单
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null)
    }
    window.addEventListener('click', handleClick)
    return () => {
      window.removeEventListener('click', handleClick)
    }
  }, [])

  // 删除消息 - 触发确认弹窗
  const handleDelete = useCallback((target: { message: Message } | null = null) => {
    const msg = target?.message || contextMenu?.message
    if (!currentSessionId || !msg) return

    setDeleteConfirm({
      show: true,
      mode: 'single',
      message: msg
    })
    setContextMenu(null)
  }, [contextMenu, currentSessionId])

  // 执行单条删除动作
  const performSingleDelete = async (msg: Message) => {
    try {
      const dbPathHint = (msg as any)._db_path
      const result = await (window as any).electronAPI.chat.deleteMessage(currentSessionId, msg.localId, msg.createTime, dbPathHint)
      if (result.success) {
        const currentMessages = useChatStore.getState().messages || []
        const newMessages = currentMessages.filter(m => m.localId !== msg.localId)
        useChatStore.getState().setMessages(newMessages)
      } else {
        alert('删除失败: ' + (result.error || '原因未知'))
      }
    } catch (e) {
      console.error(e)
      alert('删除异常: ' + String(e))
    }
  }

  // 修改消息
  const handleEditMessage = useCallback(() => {
    if (contextMenu) {
      // 允许编辑所有类型的消息
      // 如果是文本消息(1)，使用 parsedContent
      // 如果是其他类型(如系统消息 10000)，使用 rawContent 或 content 作为 XML 源码编辑
      const isText = contextMenu.message.localType === 1
      const rawXml = contextMenu.message.content || (contextMenu.message as any).rawContent || contextMenu.message.parsedContent || ''

      const contentToEdit = isText
        ? cleanMessageContent(contextMenu.message.parsedContent)
        : rawXml

      if (!isText) {
        const fields = parseXmlToFields(rawXml)
        setTempFields(fields)
        setEditMode(fields.length > 0 ? 'fields' : 'raw')
      } else {
        setEditMode('raw')
        setTempFields([])
      }

      setEditingMessage({
        message: contextMenu.message,
        content: contentToEdit
      })
      setContextMenu(null)
    }
  }, [contextMenu])

  // 确认修改消息
  const handleSaveEdit = useCallback(async () => {
    if (editingMessage && currentSessionId) {
      let finalContent = editingMessage.content

      // 如果是字段编辑模式，先同步回 XML
      if (editMode === 'fields' && tempFields.length > 0) {
        finalContent = updateXmlWithFields(editingMessage.content, tempFields)
      }

      if (!finalContent.trim()) {
        handleDelete({ message: editingMessage.message })
        setEditingMessage(null)
        return
      }

      try {
        const result = await (window as any).electronAPI.chat.updateMessage(currentSessionId, editingMessage.message.localId, editingMessage.message.createTime, finalContent)
        if (result.success) {
          const currentMessages = useChatStore.getState().messages || []
          const newMessages = currentMessages.map(m => {
            if (m.localId === editingMessage.message.localId) {
              return { ...m, parsedContent: finalContent, content: finalContent, rawContent: finalContent }
            }
            return m
          })
          useChatStore.getState().setMessages(newMessages)
          setEditingMessage(null)
        } else {
          alert('修改失败: ' + result.error)
        }
      } catch (e) {
        alert('修改异常: ' + String(e))
      }
    }
  }, [editingMessage, currentSessionId, editMode, tempFields, handleDelete])

  // 用于在异步循环中获取最新的取消状态
  const cancelDeleteRef = useRef(false)

  const handleBatchDelete = () => {
    if (selectedMessages.size === 0) {
      alert('请先选择要删除的消息')
      return
    }
    if (!currentSessionId) return

    setDeleteConfirm({
      show: true,
      mode: 'batch',
      count: selectedMessages.size
    })
  }

  const performBatchDelete = async () => {
    setIsDeleting(true)
    setDeleteProgress({ current: 0, total: selectedMessages.size })
    setCancelDeleteRequested(false)
    cancelDeleteRef.current = false

    try {
      const currentMessages = useChatStore.getState().messages || []
      const selectedIds = Array.from(selectedMessages)
      const deletedIds = new Set<number>()

      for (let i = 0; i < selectedIds.length; i++) {
        if (cancelDeleteRef.current) break

        const id = selectedIds[i]
        const msgObj = currentMessages.find(m => m.localId === id)
        const dbPathHint = (msgObj as any)?._db_path
        const createTime = msgObj?.createTime || 0

        try {
          const result = await (window as any).electronAPI.chat.deleteMessage(currentSessionId, id, createTime, dbPathHint)
          if (result.success) {
            deletedIds.add(id)
          }
        } catch (err) {
          console.error(`删除消息 ${id} 失败:`, err)
        }

        setDeleteProgress({ current: i + 1, total: selectedIds.length })
      }

      const finalMessages = (useChatStore.getState().messages || []).filter(m => !deletedIds.has(m.localId))
      useChatStore.getState().setMessages(finalMessages)

      setIsSelectionMode(false)
      setSelectedMessages(new Set())

      if (cancelDeleteRef.current) {
        alert(`操作已中止。已删除 ${deletedIds.size} 条，剩余记录保留。`)
      }
    } catch (e) {
      alert('批量删除出现错误: ' + String(e))
      console.error(e)
    } finally {
      setIsDeleting(false)
      setCancelDeleteRequested(false)
      cancelDeleteRef.current = false
    }
  }

  return (
    <div className={`chat-page ${isResizing ? 'resizing' : ''} ${standaloneSessionWindow ? 'standalone session-only' : ''}`}>
      {/* 自定义删除确认对话框 */}
      {deleteConfirm.show && (
        <div className="delete-confirm-overlay">
          <div className="delete-confirm-card">
            <div className="confirm-icon">
              <Trash2 size={32} color="var(--danger)" />
            </div>
            <div className="confirm-content">
              <h3>确认删除</h3>
              <p>
                {deleteConfirm.mode === 'single'
                  ? '确定要删除这条消息吗？此操作不可恢复。'
                  : `确定要删除选中的 ${deleteConfirm.count} 条消息吗？`}
              </p>
            </div>
            <div className="confirm-actions">
              <button
                className="btn-secondary"
                onClick={() => setDeleteConfirm({ ...deleteConfirm, show: false })}
              >
                取消
              </button>
              <button
                className="btn-danger-filled"
                onClick={() => {
                  setDeleteConfirm({ ...deleteConfirm, show: false });
                  if (deleteConfirm.mode === 'single' && deleteConfirm.message) {
                    performSingleDelete(deleteConfirm.message);
                  } else if (deleteConfirm.mode === 'batch') {
                    performBatchDelete();
                  }
                }}
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量删除进度遮罩 */}
      {isDeleting && (
        <div className="delete-progress-overlay">
          <div className="delete-progress-card">
            <div className="progress-header">
              <h3>正在彻底删除消息...</h3>
              <span className="count">{deleteProgress.current} / {deleteProgress.total}</span>
            </div>
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${(deleteProgress.current / deleteProgress.total) * 100}%` }}
              />
            </div>
            <div className="progress-footer">
              <p>请勿关闭应用或切换会话，确保所有副本都被清理。</p>
              <button
                className="cancel-delete-btn"
                onClick={() => {
                  setCancelDeleteRequested(true)
                  cancelDeleteRef.current = true
                }}
                disabled={cancelDeleteRequested}
              >
                {cancelDeleteRequested ? '正在停止...' : '中止删除'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 左侧会话列表 */}
      {!standaloneSessionWindow && (
      <div
        className="session-sidebar"
        ref={sidebarRef}
        style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
      >
        <div className={`session-header session-header-viewport ${foldedView ? 'folded' : ''}`}>
          {/* 普通 header */}
          <div className="session-header-panel main-header">
            <div className="search-row">
              <div className="search-box expanded">
                <Search size={14} />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="搜索"
                  value={searchKeyword}
                  onChange={(e) => handleSearch(e.target.value)}
                />
                {searchKeyword && (
                  <button className="close-search" onClick={handleCloseSearch}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <button className="icon-btn refresh-btn" onClick={handleRefresh} disabled={isLoadingSessions || isRefreshingSessions}>
                <RefreshCw size={16} className={(isLoadingSessions || isRefreshingSessions) ? 'spin' : ''} />
              </button>
              {isSessionListSyncing && (
                <div className="session-sync-indicator">
                  <Loader2 size={12} className="spin" />
                  <span>同步中</span>
                </div>
              )}
            </div>
          </div>
          {/* 折叠群 header */}
          <div className="session-header-panel folded-header">
            <div className="folded-view-header">
              <button className="icon-btn back-btn" onClick={() => setFoldedView(false)}>
                <ChevronLeft size={18} />
              </button>
              <span className="folded-view-title">
                <Users size={14} />
                折叠的群聊
              </span>
            </div>
          </div>
        </div>

        {connectionError && (
          <div className="connection-error">
            <AlertCircle size={16} />
            <span>{connectionError}</span>
            <button onClick={connect}>重试</button>
          </div>
        )}

        {/* ... (previous content) ... */}
        {shouldShowSessionsSkeleton ? (
          <div className="loading-sessions">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton-item">
                <div className="skeleton-avatar" />
                <div className="skeleton-content">
                  <div className="skeleton-line" />
                  <div className="skeleton-line" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={`session-list-viewport ${foldedView ? 'folded' : ''}`}>
            {/* 普通会话列表 */}
            <div className="session-list-panel main-panel">
              {Array.isArray(filteredSessions) && filteredSessions.length > 0 ? (
                <div
                  className="session-list"
                  ref={sessionListRef}
                  onScroll={() => {
                    isScrollingRef.current = true
                    if (sessionScrollTimeoutRef.current) {
                      clearTimeout(sessionScrollTimeoutRef.current)
                    }
                    sessionScrollTimeoutRef.current = window.setTimeout(() => {
                      isScrollingRef.current = false
                      sessionScrollTimeoutRef.current = null
                    }, 200)
                  }}
                >
                  {filteredSessions.map(session => (
                    <SessionItem
                      key={session.username}
                      session={session}
                      isActive={currentSessionId === session.username}
                      onSelect={handleSelectSession}
                      formatTime={formatSessionTime}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-sessions">
                  <MessageSquare />
                  <p>暂无会话</p>
                  <p className="hint">检查你的数据库配置</p>
                </div>
              )}
            </div>

            {/* 折叠群列表 */}
            <div className="session-list-panel folded-panel">
              {foldedSessions.length > 0 ? (
                <div className="session-list">
                  {foldedSessions.map(session => (
                    <SessionItem
                      key={session.username}
                      session={session}
                      isActive={currentSessionId === session.username}
                      onSelect={handleSelectSession}
                      formatTime={formatSessionTime}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-sessions">
                  <Users size={32} />
                  <p>没有折叠的群聊</p>
                </div>
              )}
            </div>
          </div>
        )}


      </div>
      )}

      {/* 拖动调节条 */}
      {!standaloneSessionWindow && <div className="resize-handle" onMouseDown={handleResizeStart} />}

      {/* 右侧消息区域 */}
      <div className="message-area">
        {currentSession ? (
          <>
            <div className="message-header">
              <Avatar
                src={currentSession.avatarUrl}
                name={currentSession.displayName || currentSession.username}
                size={40}
                className={isGroupChatSession(currentSession.username) ? 'group session-avatar' : 'session-avatar'}
              />
              <div className="header-info">
                <h3>{currentSession.displayName || currentSession.username}</h3>
                {isGroupChatSession(currentSession.username) && (
                  <div className="header-subtitle">群聊</div>
                )}
              </div>
              <div className="header-actions">
                {isGroupChatSession(currentSession.username) && (
                  <button
                    className="icon-btn group-analytics-btn"
                    onClick={handleGroupAnalytics}
                    title="群聊分析"
                  >
                    <BarChart3 size={18} />
                  </button>
                )}
                {isGroupChatSession(currentSession.username) && (
                  <button
                    className={`icon-btn group-members-btn ${showGroupMembersPanel ? 'active' : ''}`}
                    onClick={toggleGroupMembersPanel}
                    title="群成员"
                  >
                    <Users size={18} />
                  </button>
                )}
                <button
                  className={`icon-btn export-session-btn${isExportActionBusy ? ' exporting' : ''}`}
                  onClick={handleExportCurrentSession}
                  disabled={!currentSessionId || isExportActionBusy}
                  title={isCurrentSessionExporting ? '导出中' : isPreparingExportDialog ? '正在准备导出模块' : '导出当前会话'}
                >
                  {isExportActionBusy ? (
                    <Loader2 size={18} className="spin" />
                  ) : (
                    <Download size={18} />
                  )}
                </button>
                <button
                  className={`icon-btn batch-transcribe-btn${isBatchTranscribing ? ' transcribing' : ''}`}
                  onClick={() => {
                    if (isBatchTranscribing) {
                      setShowBatchProgress(true)
                    } else {
                      handleBatchTranscribe()
                    }
                  }}
                  disabled={!currentSessionId}
                  title={isBatchTranscribing ? `批量转写中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})，点击查看进度` : '批量语音转文字'}
                >
                  {isBatchTranscribing ? (
                    <Loader2 size={18} className="spin" />
                  ) : (
                    <Mic size={18} />
                  )}
                </button>
                <button
                  className={`icon-btn batch-decrypt-btn${isBatchDecrypting ? ' transcribing' : ''}`}
                  onClick={() => {
                    if (isBatchDecrypting) {
                      setShowBatchDecryptToast(true)
                    } else {
                      handleBatchDecrypt()
                    }
                  }}
                  disabled={!currentSessionId}
                  title={isBatchDecrypting
                    ? `批量解密中 (${batchDecryptProgress.current}/${batchDecryptProgress.total})，点击查看进度`
                    : '批量解密图片'}
                >
                  {isBatchDecrypting ? (
                    <Loader2 size={18} className="spin" />
                  ) : (
                    <ImageIcon size={18} />
                  )}
                </button>
                <button
                  className="icon-btn jump-to-time-btn"
                  onClick={async () => {
                    setShowJumpDialog(true)
                    if (!currentSessionId) return
                    // 检查缓存
                    const cached = messageDatesCache.current.get(currentSessionId)
                    if (cached) {
                      setMessageDates(cached)
                      return
                    }
                    // 获取消息日期
                    setMessageDates(new Set()) // 清除旧数据
                    setLoadingDates(true)
                    try {
                      const result = await (window as any).electronAPI.chat.getMessageDates(currentSessionId)
                      if (result?.success && result.dates) {
                        const dateSet = new Set<string>(result.dates)
                        setMessageDates(dateSet)
                        messageDatesCache.current.set(currentSessionId, dateSet)
                      }
                    } catch (e) {
                      console.error('获取消息日期失败:', e)
                    } finally {
                      setLoadingDates(false)
                    }
                  }}
                  title="跳转到指定时间"
                >
                  <Calendar size={18} />
                </button>
                <JumpToDateDialog
                  isOpen={showJumpDialog}
                  onClose={() => setShowJumpDialog(false)}
                  onSelect={(date) => {
                    if (!currentSessionId) return
                    const start = Math.floor(date.setHours(0, 0, 0, 0) / 1000)
                    const end = Math.floor(date.setHours(23, 59, 59, 999) / 1000)
                    isDateJumpRef.current = true
                    setCurrentOffset(0)
                    setJumpStartTime(start)
                    setJumpEndTime(end)
                    loadMessages(currentSessionId, 0, start, end, true)
                  }}
                  messageDates={messageDates}
                  loadingDates={loadingDates}
                />
                <button
                  className="icon-btn refresh-messages-btn"
                  onClick={handleRefreshMessages}
                  disabled={isRefreshingMessages || isLoadingMessages}
                  title="刷新消息"
                >
                  <RefreshCw size={18} className={isRefreshingMessages ? 'spin' : ''} />
                </button>
                <button
                  className={`icon-btn detail-btn ${showDetailPanel ? 'active' : ''}`}
                  onClick={toggleDetailPanel}
                  title="会话详情"
                >
                  <Info size={18} />
                </button>
              </div>
            </div>

            {isPreparingExportDialog && exportPrepareHint && (
              <div className="export-prepare-hint" role="status" aria-live="polite">
                <Loader2 size={14} className="spin" />
                <span>{exportPrepareHint}</span>
              </div>
            )}

            <div className={`message-content-wrapper ${hasInitialMessages ? 'loaded' : 'loading'} ${isSessionSwitching ? 'switching' : ''}`}>
              {isLoadingMessages && (!hasInitialMessages || isSessionSwitching) && (
                <div className="loading-messages loading-overlay">
                  <Loader2 size={24} />
                  <span>{isSessionSwitching ? '切换会话中...' : '加载消息中...'}</span>
                </div>
              )}
              <div
                className={`message-list ${hasInitialMessages ? 'loaded' : 'loading'}`}
                ref={messageListRef}
                onScroll={handleScroll}
              >
                {hasMoreMessages && (
                  <div className={`load-more-trigger ${isLoadingMore ? 'loading' : ''}`}>
                    {isLoadingMore ? (
                      <>
                        <Loader2 size={14} />
                        <span>加载更多...</span>
                      </>
                    ) : (
                      <span>向上滚动加载更多</span>
                    )}
                  </div>
                )}

                {!isLoadingMessages && messages.length === 0 && !hasMoreMessages && (
                  <div className="empty-chat-inline">
                    <MessageSquare size={32} />
                    <span>该联系人没有聊天记录</span>
                  </div>
                )}

                {(messages || []).map((msg, index) => {
                  const prevMsg = index > 0 ? messages[index - 1] : undefined
                  const showDateDivider = shouldShowDateDivider(msg, prevMsg)

                  // 显示时间:第一条消息,或者与上一条消息间隔超过5分钟
                  const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
                  const isSent = msg.isSend === 1
                  const isSystem = isSystemMessage(msg.localType)

                  // 系统消息居中显示
                  const wrapperClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')

                  const messageKey = getMessageKey(msg)
                  return (
                    <div key={messageKey} className={`message-wrapper ${wrapperClass} ${highlightedMessageSet.has(messageKey) ? 'new-message' : ''}`}>
                      {showDateDivider && (
                        <div className="date-divider">
                          <span>{formatDateDivider(msg.createTime)}</span>
                        </div>
                      )}
                      <MessageBubble
                        message={msg}
                        session={currentSession}
                        showTime={!showDateDivider && showTime}
                        myAvatarUrl={myAvatarUrl}
                        isGroupChat={isGroupChatSession(currentSession.username)}
                        onRequireModelDownload={handleRequireModelDownload}
                        onContextMenu={handleContextMenu}
                        isSelectionMode={isSelectionMode}
                        isSelected={selectedMessages.has(msg.localId)}
                        onToggleSelection={handleToggleSelection}
                      />
                    </div>
                  )
                })}

                {hasMoreLater && (
                  <div className={`load-more-trigger later ${isLoadingMore ? 'loading' : ''}`}>
                    {isLoadingMore ? (
                      <>
                        <Loader2 size={14} />
                        <span>正在加载后续消息...</span>
                      </>
                    ) : (
                      <span>向下滚动查看更新消息</span>
                    )}
                  </div>
                )}

                {/* 回到底部按钮 */}
                <div className={`scroll-to-bottom ${showScrollToBottom ? 'show' : ''}`} onClick={scrollToBottom}>
                  <ChevronDown size={16} />
                  <span>回到底部</span>
                </div>
              </div>

              {/* 群成员面板 */}
              {showGroupMembersPanel && isGroupChatSession(currentSession.username) && (
                <div className="detail-panel group-members-panel">
                  <div className="detail-header">
                    <h4>群成员</h4>
                    <button className="close-btn" onClick={() => setShowGroupMembersPanel(false)}>
                      <X size={16} />
                    </button>
                  </div>

                  <div className="group-members-toolbar">
                    <span className="group-members-count">共 {groupPanelMembers.length} 人</span>
                    <div className="group-members-search">
                      <Search size={14} />
                      <input
                        type="text"
                        value={groupMemberSearchKeyword}
                        onChange={(event) => setGroupMemberSearchKeyword(event.target.value)}
                        placeholder="搜索成员"
                      />
                    </div>
                  </div>

                  {isRefreshingGroupMembers && (
                    <div className="group-members-status" role="status" aria-live="polite">
                      <Loader2 size={14} className="spin" />
                      <span>正在统计成员发言数...</span>
                    </div>
                  )}
                  {groupMembersError && groupPanelMembers.length > 0 && (
                    <div className="group-members-status warning" role="status" aria-live="polite">
                      <span>{groupMembersError}</span>
                    </div>
                  )}

                  {isLoadingGroupMembers ? (
                    <div className="detail-loading">
                      <Loader2 size={20} className="spin" />
                      <span>{groupMembersLoadingHint || '加载群成员中...'}</span>
                    </div>
                  ) : groupMembersError && groupPanelMembers.length === 0 ? (
                    <div className="detail-empty">{groupMembersError}</div>
                  ) : filteredGroupPanelMembers.length === 0 ? (
                    <div className="detail-empty">{groupMemberSearchKeyword.trim() ? '暂无匹配成员' : '暂无群成员数据'}</div>
                  ) : (
                    <div className="group-members-list">
                      {filteredGroupPanelMembers.map((member) => (
                        <div key={member.username} className="group-member-item">
                          <div className="group-member-main">
                            <Avatar
                              src={member.avatarUrl}
                              name={member.displayName || member.username}
                              size={34}
                              className="group-member-avatar"
                            />
                            <div className="group-member-meta">
                              <div className="group-member-name-row">
                                <span className="group-member-name" title={member.displayName || member.username}>
                                  {member.displayName || member.username}
                                </span>
                                <div className="group-member-badges">
                                  {member.isOwner && (
                                    <span className="member-flag owner" title="群主">
                                      <Crown size={12} />
                                    </span>
                                  )}
                                  {member.isFriend && (
                                    <span className="member-flag friend" title="好友">
                                      <UserCheck size={12} />
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span className="group-member-id" title={member.alias || member.username}>
                                {member.alias || member.username}
                              </span>
                            </div>
                          </div>
                          <span className="group-member-count">{member.messageCount.toLocaleString()} 条</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 会话详情面板 */}
              {showDetailPanel && (
                <div className="detail-panel">
                  <div className="detail-header">
                    <h4>会话详情</h4>
                    <button className="close-btn" onClick={() => setShowDetailPanel(false)}>
                      <X size={16} />
                    </button>
                  </div>
                  {isLoadingDetail && !sessionDetail ? (
                    <div className="detail-loading">
                      <Loader2 size={20} className="spin" />
                      <span>加载中...</span>
                    </div>
                  ) : sessionDetail ? (
                    <div className="detail-content">
                      <div className="detail-section">
                        <div className="detail-item">
                          <Hash size={14} />
                          <span className="label">微信ID</span>
                          <span className="value">{sessionDetail.wxid}</span>
                          <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.wxid, 'wxid')}>
                            {copiedField === 'wxid' ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        </div>
                        {sessionDetail.remark && (
                          <div className="detail-item">
                            <span className="label">备注</span>
                            <span className="value">{sessionDetail.remark}</span>
                            <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.remark!, 'remark')}>
                              {copiedField === 'remark' ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        )}
                        {sessionDetail.nickName && (
                          <div className="detail-item">
                            <span className="label">昵称</span>
                            <span className="value">{sessionDetail.nickName}</span>
                            <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.nickName!, 'nickName')}>
                              {copiedField === 'nickName' ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        )}
                        {sessionDetail.alias && (
                          <div className="detail-item">
                            <span className="label">微信号</span>
                            <span className="value">{sessionDetail.alias}</span>
                            <button className="copy-btn" title="复制" onClick={() => handleCopyField(sessionDetail.alias!, 'alias')}>
                              {copiedField === 'alias' ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="detail-section">
                        <div className="section-title">
                          <MessageSquare size={14} />
                          <span>消息统计（导出口径）</span>
                        </div>
                        <div className="detail-stats-meta">
                          {isRefreshingDetailStats
                            ? '统计刷新中...'
                            : sessionDetail.statsUpdatedAt
                              ? `${sessionDetail.statsStale ? '缓存于' : '更新于'} ${formatYmdHmDateTime(sessionDetail.statsUpdatedAt)}${sessionDetail.statsStale ? '（将后台刷新）' : ''}`
                              : (isLoadingDetailExtra ? '统计加载中...' : '暂无统计缓存')}
                        </div>
                        <div className="detail-item">
                          <span className="label">消息总数</span>
                          <span className="value highlight">
                            {Number.isFinite(sessionDetail.messageCount)
                              ? sessionDetail.messageCount.toLocaleString()
                              : ((isLoadingDetail || isLoadingDetailExtra) ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">语音</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.voiceMessages)
                              ? (sessionDetail.voiceMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">图片</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.imageMessages)
                              ? (sessionDetail.imageMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">视频</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.videoMessages)
                              ? (sessionDetail.videoMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">表情包</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.emojiMessages)
                              ? (sessionDetail.emojiMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">转账消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.transferMessages)
                              ? (sessionDetail.transferMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">红包消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.redPacketMessages)
                              ? (sessionDetail.redPacketMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <span className="label">通话消息数</span>
                          <span className="value">
                            {Number.isFinite(sessionDetail.callMessages)
                              ? (sessionDetail.callMessages as number).toLocaleString()
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        {sessionDetail.wxid.includes('@chatroom') ? (
                          <>
                            <div className="detail-item">
                              <span className="label">我发的消息数</span>
                              <span className="value">
                                {Number.isFinite(sessionDetail.groupMyMessages)
                                  ? (sessionDetail.groupMyMessages as number).toLocaleString()
                                  : (isLoadingDetailExtra ? '统计中...' : '—')}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="label">群人数</span>
                              <span className="value">
                                {Number.isFinite(sessionDetail.groupMemberCount)
                                  ? (sessionDetail.groupMemberCount as number).toLocaleString()
                                  : (isLoadingDetailExtra ? '统计中...' : '—')}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="label">群发言人数</span>
                              <span className="value">
                                {Number.isFinite(sessionDetail.groupActiveSpeakers)
                                  ? (sessionDetail.groupActiveSpeakers as number).toLocaleString()
                                  : (isLoadingDetailExtra ? '统计中...' : '—')}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="label">群共同好友数</span>
                              <span className="value">
                                {sessionDetail.relationStatsLoaded
                                  ? (Number.isFinite(sessionDetail.groupMutualFriends)
                                    ? (sessionDetail.groupMutualFriends as number).toLocaleString()
                                    : '—')
                                  : (
                                    <button
                                      className="detail-inline-btn"
                                      onClick={() => { void loadRelationStats() }}
                                      disabled={isLoadingRelationStats || isLoadingDetailExtra}
                                    >
                                      {isLoadingRelationStats ? '加载中...' : '点击加载'}
                                    </button>
                                  )}
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="detail-item">
                            <span className="label">共同群聊数</span>
                            <span className="value">
                              {sessionDetail.relationStatsLoaded
                                ? (Number.isFinite(sessionDetail.privateMutualGroups)
                                  ? (sessionDetail.privateMutualGroups as number).toLocaleString()
                                  : '—')
                                : (
                                  <button
                                    className="detail-inline-btn"
                                    onClick={() => { void loadRelationStats() }}
                                    disabled={isLoadingRelationStats || isLoadingDetailExtra}
                                  >
                                    {isLoadingRelationStats ? '加载中...' : '点击加载'}
                                  </button>
                                )}
                            </span>
                          </div>
                        )}
                        <div className="detail-item">
                          <Calendar size={14} />
                          <span className="label">首条消息</span>
                          <span className="value">
                            {sessionDetail.firstMessageTime
                              ? formatYmdDateFromSeconds(sessionDetail.firstMessageTime)
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                        <div className="detail-item">
                          <Calendar size={14} />
                          <span className="label">最新消息</span>
                          <span className="value">
                            {sessionDetail.latestMessageTime
                              ? formatYmdDateFromSeconds(sessionDetail.latestMessageTime)
                              : (isLoadingDetailExtra ? '统计中...' : '—')}
                          </span>
                        </div>
                      </div>

                      <div className="detail-section">
                        <div className="section-title">
                          <Database size={14} />
                          <span>数据库分布</span>
                        </div>
                        {Array.isArray(sessionDetail.messageTables) && sessionDetail.messageTables.length > 0 ? (
                          <div className="table-list">
                            {sessionDetail.messageTables.map((t, i) => (
                              <div key={i} className="table-item">
                                <span className="db-name">{t.dbName}</span>
                                <span className="table-count">{t.count.toLocaleString()} 条</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="detail-table-placeholder">
                            {isLoadingDetailExtra ? '统计中...' : '暂无统计数据'}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="detail-empty">暂无详情</div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="empty-chat">
            <MessageSquare />
            <p>{standaloneSessionWindow ? '会话加载中或暂无会话记录' : '选择一个会话开始查看聊天记录'}</p>
            {standaloneSessionWindow && connectionError && <p className="hint">{connectionError}</p>}
          </div>
        )}
      </div>

      {/* 语音转文字模型下载弹窗 */}
      {showVoiceTranscribeDialog && (
        <VoiceTranscribeDialog
          onClose={() => {
            setShowVoiceTranscribeDialog(false)
            setPendingVoiceTranscriptRequest(null)
          }}
          onDownloadComplete={async () => {
            setShowVoiceTranscribeDialog(false)
            // 下载完成后，触发页面刷新让组件重新尝试转写
            // 通过更新缓存触发组件重新检查
            if (pendingVoiceTranscriptRequest) {
              // 清除缓存中的请求标记，让组件可以重新尝试
              const cacheKey = `voice-transcript:${pendingVoiceTranscriptRequest.messageId}`
              // 不直接调用转写，而是让组件自己重试
              // 通过触发一个自定义事件来通知所有 MessageBubble 组件
              window.dispatchEvent(new CustomEvent('model-downloaded', {
                detail: { messageId: pendingVoiceTranscriptRequest.messageId }
              }))
            }
            setPendingVoiceTranscriptRequest(null)
          }}
        />
      )}

      {/* 批量转写确认对话框 */}
      {showBatchConfirm && createPortal(
        <div className="batch-modal-overlay" onClick={() => setShowBatchConfirm(false)}>
          <div className="batch-modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="batch-modal-header">
              <Mic size={20} />
              <h3>批量语音转文字</h3>
            </div>
            <div className="batch-modal-body">
              <p>选择要转写的日期（仅显示有语音的日期），然后开始转写。</p>
              {batchVoiceDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={selectAllBatchDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={clearAllBatchDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {batchVoiceDates.map(dateStr => {
                      const count = batchCountByDate.get(dateStr) ?? 0
                      const checked = batchSelectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <label className="batch-date-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleBatchDate(dateStr)}
                            />
                            <span className="batch-date-label">{formatBatchDateLabel(dateStr)}</span>
                            <span className="batch-date-count">{count} 条语音</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              <div className="batch-info">
                <div className="info-item">
                  <span className="label">已选:</span>
                  <span className="value">{batchSelectedDates.size} 天有语音，共 {batchSelectedMessageCount} 条语音</span>
                </div>
                <div className="info-item">
                  <span className="label">预计耗时:</span>
                  <span className="value">约 {Math.ceil(batchSelectedMessageCount * 2 / 60)} 分钟</span>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>批量转写可能需要较长时间，转写过程中可以继续使用其他功能。已转写过的语音会自动跳过。</span>
              </div>
            </div>
            <div className="batch-modal-footer">
              <button className="btn-secondary" onClick={() => setShowBatchConfirm(false)}>
                取消
              </button>
              <button className="btn-primary batch-transcribe-start-btn" onClick={confirmBatchTranscribe}>
                <Mic size={16} />
                开始转写
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* 消息右键菜单 */}
      {showBatchDecryptConfirm && createPortal(
        <div className="batch-modal-overlay" onClick={() => setShowBatchDecryptConfirm(false)}>
          <div className="batch-modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="batch-modal-header">
              <ImageIcon size={20} />
              <h3>批量解密图片</h3>
            </div>
            <div className="batch-modal-body">
              <p>选择要解密的日期（仅显示有图片的日期），然后开始解密。</p>
              {batchImageDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={selectAllBatchImageDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={clearAllBatchImageDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {batchImageDates.map(dateStr => {
                      const count = batchImageCountByDate.get(dateStr) ?? 0
                      const checked = batchImageSelectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <label className="batch-date-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleBatchImageDate(dateStr)}
                            />
                            <span className="batch-date-label">{formatBatchDateLabel(dateStr)}</span>
                            <span className="batch-date-count">{count} 张图片</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              <div className="batch-info">
                <div className="info-item">
                  <span className="label">已选:</span>
                  <span className="value">{batchImageSelectedDates.size} 天，共 {batchImageSelectedCount} 张图片</span>
                </div>
                <div className="info-item">
                  <span className="label">并发数:</span>
                  <div className="batch-concurrency-field">
                    <button
                      type="button"
                      className={`batch-concurrency-trigger ${showConcurrencyDropdown ? 'open' : ''}`}
                      onClick={() => setShowConcurrencyDropdown(!showConcurrencyDropdown)}
                    >
                      <span>{batchDecryptConcurrency === 1 ? '1（最慢，最稳）' : batchDecryptConcurrency === 6 ? '6（推荐）' : batchDecryptConcurrency === 20 ? '20（最快，可能卡顿）' : String(batchDecryptConcurrency)}</span>
                      <ChevronDown size={14} />
                    </button>
                    {showConcurrencyDropdown && (
                      <div className="batch-concurrency-dropdown">
                        {[
                          { value: 1, label: '1（最慢，最稳）' },
                          { value: 3, label: '3' },
                          { value: 6, label: '6（推荐）' },
                          { value: 10, label: '10' },
                          { value: 20, label: '20（最快，可能卡顿）' },
                        ].map(opt => (
                          <button
                            key={opt.value}
                            type="button"
                            className={`batch-concurrency-option ${batchDecryptConcurrency === opt.value ? 'active' : ''}`}
                            onClick={() => { setBatchDecryptConcurrency(opt.value); setShowConcurrencyDropdown(false) }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>批量解密可能需要较长时间，进行中会在右下角显示非阻塞进度浮层。</span>
              </div>
            </div>
            <div className="batch-modal-footer">
              <button className="btn-secondary" onClick={() => setShowBatchDecryptConfirm(false)}>
                取消
              </button>
              <button className="btn-primary" onClick={confirmBatchDecrypt}>
                <ImageIcon size={16} />
                开始解密
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {contextMenu && createPortal(
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)}
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998 }} />
          <div
            className="context-menu"
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              zIndex: 9999
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-item" onClick={handleEditMessage}>
              <Edit2 size={16} />
              <span>{contextMenu.message.localType === 1 ? '修改消息' : '编辑源码'}</span>
            </div>
            <div className="menu-item" onClick={() => {
              setIsSelectionMode(true)
              setSelectedMessages(new Set([contextMenu.message.localId]))
              setContextMenu(null)
            }}>
              <CheckSquare size={16} />
              <span>多选</span>
            </div>
            <div className="menu-item delete" onClick={(e) => { e.stopPropagation(); handleDelete() }}>
              <Trash2 size={16} />
              <span>删除消息</span>
            </div>
            <div className="menu-item" onClick={() => { setShowMessageInfo(contextMenu.message); setContextMenu(null) }}>
              <Info size={16} />
              <span>查看消息信息</span>
            </div>
          </div>
        </>,
        document.body
      )}

      {/* 消息信息弹窗 */}
      {showMessageInfo && createPortal(
        <div className="message-info-overlay" onClick={() => setShowMessageInfo(null)}>
          <div className="message-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="detail-header">
              <h4>消息详情</h4>
              <button className="close-btn" onClick={() => setShowMessageInfo(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="detail-content">
              <div className="detail-section">
                <div className="detail-item">
                  <Hash size={14} />
                  <span className="label">Local ID</span>
                  <span className="value">{showMessageInfo.localId}</span>
                  <button className="copy-btn" title="复制" onClick={() => handleCopyField(String(showMessageInfo.localId), 'msgLocalId')}>
                    {copiedField === 'msgLocalId' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <div className="detail-item">
                  <Hash size={14} />
                  <span className="label">Server ID</span>
                  <span className="value">{showMessageInfo.serverId}</span>
                </div>
                <div className="detail-item">
                  <span className="label">消息类型</span>
                  <span className="value highlight">{showMessageInfo.localType}</span>
                </div>
                <div className="detail-item">
                  <span className="label">发送者</span>
                  <span className="value">{showMessageInfo.senderUsername || '-'}</span>
                  {showMessageInfo.senderUsername && (
                    <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.senderUsername!, 'msgSender')}>
                      {copiedField === 'msgSender' ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
                </div>
                <div className="detail-item">
                  <Calendar size={14} />
                  <span className="label">创建时间</span>
                  <span className="value">{new Date(showMessageInfo.createTime * 1000).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <span className="label">发送状态</span>
                  <span className="value">{showMessageInfo.isSend === 1 ? '发送' : '接收'}</span>
                </div>
              </div>

              {(showMessageInfo.imageMd5 || showMessageInfo.videoMd5 || showMessageInfo.voiceDurationSeconds != null) && (
                <div className="detail-section">
                  <div className="section-title">
                    <ImageIcon size={14} />
                    <span>媒体信息</span>
                  </div>
                  {showMessageInfo.imageMd5 && (
                    <div className="detail-item">
                      <span className="label">Image MD5</span>
                      <span className="value mono">{showMessageInfo.imageMd5}</span>
                      <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.imageMd5!, 'imgMd5')}>
                        {copiedField === 'imgMd5' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                  {showMessageInfo.imageDatName && (
                    <div className="detail-item">
                      <span className="label">DAT 文件</span>
                      <span className="value mono">{showMessageInfo.imageDatName}</span>
                    </div>
                  )}
                  {showMessageInfo.videoMd5 && (
                    <div className="detail-item">
                      <span className="label">Video MD5</span>
                      <span className="value mono">{showMessageInfo.videoMd5}</span>
                      <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.videoMd5!, 'vidMd5')}>
                        {copiedField === 'vidMd5' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                  {showMessageInfo.voiceDurationSeconds != null && (
                    <div className="detail-item">
                      <Mic size={14} />
                      <span className="label">语音时长</span>
                      <span className="value">{showMessageInfo.voiceDurationSeconds}秒</span>
                    </div>
                  )}
                </div>
              )}

              {(showMessageInfo.emojiMd5 || showMessageInfo.emojiCdnUrl) && (
                <div className="detail-section">
                  <div className="section-title">
                    <span>表情包信息</span>
                  </div>
                  {showMessageInfo.emojiMd5 && (
                    <div className="detail-item">
                      <span className="label">MD5</span>
                      <span className="value mono">{showMessageInfo.emojiMd5}</span>
                    </div>
                  )}
                  {showMessageInfo.emojiCdnUrl && (
                    <div className="detail-item">
                      <span className="label">CDN URL</span>
                      <span className="value mono">{showMessageInfo.emojiCdnUrl}</span>
                    </div>
                  )}
                </div>
              )}

              {showMessageInfo.localType !== 1 && (showMessageInfo.rawContent || showMessageInfo.content) && (
                <div className="detail-section">
                  <div className="section-title">
                    <span>原始消息内容</span>
                    <button className="copy-btn" title="复制" onClick={() => handleCopyField(showMessageInfo.rawContent || showMessageInfo.content || '', 'rawContent')}>
                      {copiedField === 'rawContent' ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  <div className="raw-content-box">
                    <pre>{showMessageInfo.rawContent || showMessageInfo.content}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 修改消息弹窗 */}
      {editingMessage && createPortal(
        <div className="modal-overlay">
          <div className="modal-content edit-message-modal">
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>{editingMessage.message.localType === 1 ? '修改消息' : '编辑消息'}</h3>
              <button className="close-btn" onClick={() => setEditingMessage(null)}>
                <X size={16} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              {editMode === 'raw' ? (
                <textarea
                  className="edit-message-textarea"
                  style={{ fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
                  value={editingMessage.content}
                  onChange={(e) => setEditingMessage({ ...editingMessage, content: e.target.value })}
                  rows={editingMessage.message.localType === 1 ? 8 : 15}
                />
              ) : (
                <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {tempFields.map((field, idx) => (
                    <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                          {field.tagName ? field.tagName : '节点'}: <span style={{ color: 'var(--primary)' }}>{field.key}</span>
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', opacity: 0.6 }}>
                          {field.type === 'attr' ? '属性' : '文本内容'}
                        </span>
                      </div>
                      <input
                        type="text"
                        value={field.value}
                        onChange={(e) => {
                          const newFields = [...tempFields]
                          newFields[idx].value = e.target.value
                          setTempFields(newFields)
                        }}
                        style={{
                          background: 'var(--bg-tertiary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '6px',
                          padding: '10px 12px',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          outline: 'none',
                          width: '100%',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <div>
                {editingMessage.message.localType !== 1 && tempFields.length > 0 && (
                  <button
                    onClick={() => setEditMode(editMode === 'raw' ? 'fields' : 'raw')}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      background: editMode === 'fields' ? 'var(--primary)' : 'transparent',
                      color: editMode === 'fields' ? '#fff' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    {editMode === 'raw' ? '可视化编辑' : '源码编辑'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn-secondary" onClick={() => setEditingMessage(null)}>取消</button>
                <button className="btn-primary" onClick={handleSaveEdit}>保存</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 底部多选操作栏 */}
      {isSelectionMode && (
        <div style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'var(--bg-secondary)', // Use system background
          color: 'var(--text-primary)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          borderRadius: '12px',
          padding: '12px 24px',
          display: 'flex',
          gap: '20px',
          zIndex: 1000,
          alignItems: 'center',
          border: '1px solid var(--border-color)', // Subtle border
          backdropFilter: 'blur(10px)'
        }}>
          <span style={{ fontSize: '14px', fontWeight: 500 }}>已选 {selectedMessages.size} 条</span>
          <div style={{ width: '1px', height: '16px', background: 'var(--border-color)' }}></div>
          <button
            className="btn-danger"
            onClick={handleBatchDelete}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: '#fa5151',
              color: 'white',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500
            }}
          >
            删除
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              setIsSelectionMode(false)
              setSelectedMessages(new Set())
            }}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}

// 全局语音播放管理器：同一时间只能播放一条语音
const globalVoiceManager = {
  currentAudio: null as HTMLAudioElement | null,
  currentStopCallback: null as (() => void) | null,
  play(audio: HTMLAudioElement, onStop: () => void) {
    // 停止当前正在播放的语音
    if (this.currentAudio && this.currentAudio !== audio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentStopCallback?.()
    }
    this.currentAudio = audio
    this.currentStopCallback = onStop
  },
  stop(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null
      this.currentStopCallback = null
    }
  },
}

// 前端表情包缓存
const emojiDataUrlCache = new Map<string, string>()
const imageDataUrlCache = new Map<string, string>()
const voiceDataUrlCache = new Map<string, string>()
const voiceTranscriptCache = new Map<string, string>()
const senderAvatarCache = new Map<string, { avatarUrl?: string; displayName?: string }>()
const senderAvatarLoading = new Map<string, Promise<{ avatarUrl?: string; displayName?: string } | null>>()

// 引用消息中的动画表情组件
function QuotedEmoji({ cdnUrl, md5 }: { cdnUrl: string; md5?: string }) {
  const cacheKey = md5 || cdnUrl
  const [localPath, setLocalPath] = useState<string | undefined>(() => emojiDataUrlCache.get(cacheKey))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (localPath || loading || error) return
    setLoading(true)
    window.electronAPI.chat.downloadEmoji(cdnUrl, md5).then((result: { success: boolean; localPath?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setLocalPath(result.localPath)
      } else {
        setError(true)
      }
    }).catch(() => setError(true)).finally(() => setLoading(false))
  }, [cdnUrl, md5, cacheKey, localPath, loading, error])

  if (error || (!loading && !localPath)) return <span className="quoted-type-label">[动画表情]</span>
  if (loading) return <span className="quoted-type-label">[动画表情]</span>
  return <img src={localPath} alt="动画表情" className="quoted-emoji-image" />
}

// 消息气泡组件
function MessageBubble({
  message,
  session,
  showTime,
  myAvatarUrl,
  isGroupChat,
  onRequireModelDownload,
  onContextMenu,
  isSelectionMode,
  isSelected,
  onToggleSelection
}: {
  message: Message;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  isGroupChat?: boolean;
  onRequireModelDownload?: (sessionId: string, messageId: string) => void;
  onContextMenu?: (e: React.MouseEvent, message: Message) => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (localId: number, isShiftKey?: boolean) => void;
}) {
  const isSystem = isSystemMessage(message.localType)
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isCard = message.localType === 42
  const isCall = message.localType === 50
  const isType49 = message.localType === 49
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)

  // State variables...
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const imageAutoDecryptTriggered = useRef(false)
  const imageAutoHdTriggered = useRef<string | null>(null)
  const [imageInView, setImageInView] = useState(false)
  const imageForceHdAttempted = useRef<string | null>(null)
  const imageForceHdPending = useRef(false)
  const [imageLiveVideoPath, setImageLiveVideoPath] = useState<string | undefined>(undefined)
  const [voiceError, setVoiceError] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [isVoicePlaying, setIsVoicePlaying] = useState(false)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const [voiceTranscriptLoading, setVoiceTranscriptLoading] = useState(false)
  const [voiceTranscriptError, setVoiceTranscriptError] = useState(false)
  const voiceTranscriptRequestedRef = useRef(false)
  const [autoTranscribeVoice, setAutoTranscribeVoice] = useState(true)
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0)
  const [voiceDuration, setVoiceDuration] = useState(0)
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>([])
  const voiceAutoDecryptTriggered = useRef(false)

  // 转账消息双方名称
  const [transferPayerName, setTransferPayerName] = useState<string | undefined>(undefined)
  const [transferReceiverName, setTransferReceiverName] = useState<string | undefined>(undefined)

  // 视频相关状态
  const [videoLoading, setVideoLoading] = useState(false)
  const [videoInfo, setVideoInfo] = useState<{ videoUrl?: string; coverUrl?: string; thumbUrl?: string; exists: boolean } | null>(null)
  const videoContainerRef = useRef<HTMLElement>(null)
  const [isVideoVisible, setIsVideoVisible] = useState(false)
  const [videoMd5, setVideoMd5] = useState<string | null>(null)

  // 解析视频 MD5
  useEffect(() => {
    if (!isVideo) return





    // 优先使用数据库中的 videoMd5
    if (message.videoMd5) {

      setVideoMd5(message.videoMd5)
      return
    }

    // 尝试从多个可能的字段获取原始内容
    const contentToUse = message.content || (message as any).rawContent || message.parsedContent
    if (contentToUse) {

      window.electronAPI.video.parseVideoMd5(contentToUse).then((result: { success: boolean; md5?: string; error?: string }) => {

        if (result && result.success && result.md5) {

          setVideoMd5(result.md5)
        } else {
          console.error('[Video Debug] Failed to parse MD5:', result)
        }
      }).catch((err: unknown) => {
        console.error('[Video Debug] Parse error:', err)
      })
    }
  }, [isVideo, message.videoMd5, message.content, message.parsedContent])

  // 加载自动转文字配置
  useEffect(() => {
    const loadConfig = async () => {
      const enabled = await configService.getAutoTranscribeVoice()
      setAutoTranscribeVoice(enabled)
    }
    loadConfig()
  }, [])

  // 从缓存获取表情包 data URL
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => emojiDataUrlCache.get(cacheKey) || message.emojiLocalPath
  )
  const imageCacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`
  const [imageLocalPath, setImageLocalPath] = useState<string | undefined>(
    () => imageDataUrlCache.get(imageCacheKey)
  )
  const voiceCacheKey = `voice:${message.localId}`
  const [voiceDataUrl, setVoiceDataUrl] = useState<string | undefined>(
    () => voiceDataUrlCache.get(voiceCacheKey)
  )
  const voiceTranscriptCacheKey = `voice-transcript:${message.localId}`
  const [voiceTranscript, setVoiceTranscript] = useState<string | undefined>(
    () => voiceTranscriptCache.get(voiceTranscriptCacheKey)
  )

  const formatTime = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知时间'
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const detectImageMimeFromBase64 = useCallback((base64: string): string => {
    try {
      const head = window.atob(base64.slice(0, 48))
      const bytes = new Uint8Array(head.length)
      for (let i = 0; i < head.length; i++) {
        bytes[i] = head.charCodeAt(i)
      }
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp'
      }
    } catch { }
    return 'image/jpeg'
  }, [])

  // 获取头像首字母
  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    const chars = [...name]
    return chars[0] || '?'
  }

  // 下载表情包
  const downloadEmoji = () => {
    if (!message.emojiCdnUrl || emojiLoading) return

    // 先检查缓存
    const cached = emojiDataUrlCache.get(cacheKey)
    if (cached) {
      setEmojiLocalPath(cached)
      setEmojiError(false)
      return
    }

    setEmojiLoading(true)
    setEmojiError(false)
    window.electronAPI.chat.downloadEmoji(message.emojiCdnUrl, message.emojiMd5).then((result: { success: boolean; localPath?: string; error?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setEmojiLocalPath(result.localPath)
      } else {
        setEmojiError(true)
      }
    }).catch(() => {
      setEmojiError(true)
    }).finally(() => {
      setEmojiLoading(false)
    })
  }

  // 群聊中获取发送者信息 (如果自己发的没头像，也尝试拉取)
  useEffect(() => {
    if (message.senderUsername && (isGroupChat || (isSent && !myAvatarUrl))) {
      const sender = message.senderUsername
      const cached = senderAvatarCache.get(sender)
      if (cached) {
        setSenderAvatarUrl(cached.avatarUrl)
        setSenderName(cached.displayName)
        return
      }
      const pending = senderAvatarLoading.get(sender)
      if (pending) {
        pending.then((result: { avatarUrl?: string; displayName?: string } | null) => {
          if (result) {
            setSenderAvatarUrl(result.avatarUrl)
            setSenderName(result.displayName)
          }
        })
        return
      }
      const request = window.electronAPI.chat.getContactAvatar(sender)
      senderAvatarLoading.set(sender, request)
      request.then((result: { avatarUrl?: string; displayName?: string } | null) => {
        if (result) {
          senderAvatarCache.set(sender, result)
          setSenderAvatarUrl(result.avatarUrl)
          setSenderName(result.displayName)
        }
      }).catch(() => { }).finally(() => {
        senderAvatarLoading.delete(sender)
      })
    }
  }, [isGroupChat, isSent, message.senderUsername, myAvatarUrl])

  // 解析转账消息的付款方和收款方显示名称
  useEffect(() => {
    const payerWxid = (message as any).transferPayerUsername
    const receiverWxid = (message as any).transferReceiverUsername
    if (!payerWxid && !receiverWxid) return
    // 仅对转账消息类型处理
    if (message.localType !== 49 && message.localType !== 8589934592049) return

    window.electronAPI.chat.resolveTransferDisplayNames(
      session.username,
      payerWxid || '',
      receiverWxid || ''
    ).then((result: { payerName: string; receiverName: string }) => {
      if (result) {
        setTransferPayerName(result.payerName)
        setTransferReceiverName(result.receiverName)
      }
    }).catch(() => { })
  }, [(message as any).transferPayerUsername, (message as any).transferReceiverUsername, session.username])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    // 后端已从本地缓存找到文件（转发表情包无 CDN URL 的情况）
    if (isEmoji && message.emojiLocalPath && !emojiLocalPath) {
      setEmojiLocalPath(message.emojiLocalPath)
      return
    }
    if (isEmoji && message.emojiCdnUrl && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, message.emojiLocalPath, emojiLocalPath, emojiLoading, emojiError])

  const requestImageDecrypt = useCallback(async (forceUpdate = false, silent = false) => {
    if (!isImage) return
    if (imageLoading) return
    if (!silent) {
      setImageLoading(true)
      setImageError(false)
    }
    try {
      if (message.imageMd5 || message.imageDatName) {
        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageDatName: message.imageDatName,
          force: forceUpdate
        })
        if (result.success && result.localPath) {
          imageDataUrlCache.set(imageCacheKey, result.localPath)
          setImageLocalPath(result.localPath)
          setImageHasUpdate(false)
          if (result.liveVideoPath) setImageLiveVideoPath(result.liveVideoPath)
          return result
        }
      }

      const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId))
      if (fallback.success && fallback.data) {
        const mime = detectImageMimeFromBase64(fallback.data)
        const dataUrl = `data:${mime};base64,${fallback.data}`
        imageDataUrlCache.set(imageCacheKey, dataUrl)
        setImageLocalPath(dataUrl)
        setImageHasUpdate(false)
        return { success: true, localPath: dataUrl } as any
      }
      if (!silent) setImageError(true)
    } catch {
      if (!silent) setImageError(true)
    } finally {
      if (!silent) setImageLoading(false)
    }
    return { success: false } as any
  }, [isImage, imageLoading, message.imageMd5, message.imageDatName, message.localId, session.username, imageCacheKey, detectImageMimeFromBase64])

  const triggerForceHd = useCallback(() => {
    if (!message.imageMd5 && !message.imageDatName) return
    if (imageForceHdAttempted.current === imageCacheKey) return
    if (imageForceHdPending.current) return
    imageForceHdAttempted.current = imageCacheKey
    imageForceHdPending.current = true
    requestImageDecrypt(true, true).finally(() => {
      imageForceHdPending.current = false
    })
  }, [imageCacheKey, message.imageDatName, message.imageMd5, requestImageDecrypt])

  const handleImageClick = useCallback(() => {
    if (imageClickTimerRef.current) {
      window.clearTimeout(imageClickTimerRef.current)
    }
    setImageClicked(true)
    imageClickTimerRef.current = window.setTimeout(() => {
      setImageClicked(false)
    }, 800)
    console.info('[UI] image decrypt click', {
      sessionId: session.username,
      imageMd5: message.imageMd5,
      imageDatName: message.imageDatName,
      localId: message.localId
    })
    void requestImageDecrypt()
  }, [message.imageDatName, message.imageMd5, message.localId, requestImageDecrypt, session.username])

  const handleOpenImageViewer = useCallback(async () => {
    if (!imageLocalPath) return

    let finalImagePath = imageLocalPath
    let finalLiveVideoPath = imageLiveVideoPath || undefined

    // If current cache is a thumbnail, wait for a silent force-HD decrypt before opening viewer.
    if (imageHasUpdate) {
      try {
        const upgraded = await requestImageDecrypt(true, true)
        if (upgraded?.success && upgraded.localPath) {
          finalImagePath = upgraded.localPath
          finalLiveVideoPath = upgraded.liveVideoPath || finalLiveVideoPath
        }
      } catch { }
    }

    // One more resolve helps when background/batch decrypt has produced a clearer image or live video
    // but local component state hasn't caught up yet.
    if (message.imageMd5 || message.imageDatName) {
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageDatName: message.imageDatName
        })
        if (resolved?.success && resolved.localPath) {
          finalImagePath = resolved.localPath
          finalLiveVideoPath = resolved.liveVideoPath || finalLiveVideoPath
          imageDataUrlCache.set(imageCacheKey, resolved.localPath)
          setImageLocalPath(resolved.localPath)
          if (resolved.liveVideoPath) setImageLiveVideoPath(resolved.liveVideoPath)
          setImageHasUpdate(Boolean(resolved.hasUpdate))
        }
      } catch { }
    }

    void window.electronAPI.window.openImageViewerWindow(finalImagePath, finalLiveVideoPath)
  }, [
    imageHasUpdate,
    imageLiveVideoPath,
    imageLocalPath,
    imageCacheKey,
    message.imageDatName,
    message.imageMd5,
    requestImageDecrypt,
    session.username
  ])

  useEffect(() => {
    return () => {
      if (imageClickTimerRef.current) {
        window.clearTimeout(imageClickTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isImage || imageLoading) return
    if (!message.imageMd5 && !message.imageDatName) return
    if (imageUpdateCheckedRef.current === imageCacheKey) return
    imageUpdateCheckedRef.current = imageCacheKey
    let cancelled = false
    window.electronAPI.image.resolveCache({
      sessionId: session.username,
      imageMd5: message.imageMd5 || undefined,
      imageDatName: message.imageDatName
    }).then((result: { success: boolean; localPath?: string; hasUpdate?: boolean; liveVideoPath?: string; error?: string }) => {
      if (cancelled) return
      if (result.success && result.localPath) {
        imageDataUrlCache.set(imageCacheKey, result.localPath)
        if (!imageLocalPath || imageLocalPath !== result.localPath) {
          setImageLocalPath(result.localPath)
          setImageError(false)
        }
        if (result.liveVideoPath) setImageLiveVideoPath(result.liveVideoPath)
        setImageHasUpdate(Boolean(result.hasUpdate))
      }
    }).catch(() => { })
    return () => {
      cancelled = true
    }
  }, [isImage, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, imageCacheKey, session.username])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onUpdateAvailable((payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        setImageHasUpdate(true)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, message.imageDatName, message.imageMd5])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        imageDataUrlCache.set(imageCacheKey, payload.localPath)
        setImageLocalPath(payload.localPath)
        setImageError(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, imageCacheKey, message.imageDatName, message.imageMd5])

  // 图片进入视野前自动解密（懒加载）
  useEffect(() => {
    if (!isImage) return
    if (imageLocalPath) return // 已有图片，不需要解密
    if (!message.imageMd5 && !message.imageDatName) return

    const container = imageContainerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        // rootMargin 设置为 200px，提前触发解密
        if (entry.isIntersecting && !imageAutoDecryptTriggered.current) {
          imageAutoDecryptTriggered.current = true
          void requestImageDecrypt()
        }
      },
      { rootMargin: '200px', threshold: 0 }
    )

    observer.observe(container)
    return () => observer.disconnect()
  }, [isImage, imageLocalPath, message.imageMd5, message.imageDatName, requestImageDecrypt])

  // 进入视野时自动尝试切换高清图
  useEffect(() => {
    if (!isImage) return
    const container = imageContainerRef.current
    if (!container) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        setImageInView(entry.isIntersecting)
      },
      { rootMargin: '120px', threshold: 0 }
    )
    observer.observe(container)
    return () => observer.disconnect()
  }, [isImage])

  useEffect(() => {
    if (!isImage || !imageHasUpdate || !imageInView) return
    if (imageAutoHdTriggered.current === imageCacheKey) return
    imageAutoHdTriggered.current = imageCacheKey
    triggerForceHd()
  }, [isImage, imageHasUpdate, imageInView, imageCacheKey, triggerForceHd])

  useEffect(() => {
    if (!isImage || !imageHasUpdate) return
    if (imageAutoHdTriggered.current === imageCacheKey) return
    imageAutoHdTriggered.current = imageCacheKey
    triggerForceHd()
  }, [isImage, imageHasUpdate, imageCacheKey, triggerForceHd])

  // 更激进：进入视野/打开预览时，无论 hasUpdate 与否都尝试强制高清
  useEffect(() => {
    if (!isImage || !imageInView) return
    triggerForceHd()
  }, [isImage, imageInView, triggerForceHd])


  useEffect(() => {
    if (!isVoice) return
    if (!voiceAudioRef.current) {
      voiceAudioRef.current = new Audio()
    }
    const audio = voiceAudioRef.current
    if (!audio) return
    const handlePlay = () => setIsVoicePlaying(true)
    const handlePause = () => setIsVoicePlaying(false)
    const handleEnded = () => {
      setIsVoicePlaying(false)
      setVoiceCurrentTime(0)
      globalVoiceManager.stop(audio)
    }
    const handleTimeUpdate = () => {
      setVoiceCurrentTime(audio.currentTime)
    }
    const handleLoadedMetadata = () => {
      setVoiceDuration(audio.duration)
    }
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    return () => {
      audio.pause()
      globalVoiceManager.stop(audio)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
    }
  }, [isVoice])

  // 生成波形数据
  useEffect(() => {
    if (!voiceDataUrl) {
      setVoiceWaveform([])
      return
    }

    const generateWaveform = async () => {
      try {
        // 从 data:audio/wav;base64,... 提取 base64
        const base64 = voiceDataUrl.split(',')[1]
        const binaryString = window.atob(base64)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer)
        const rawData = audioBuffer.getChannelData(0) // 获取单声道数据
        const samples = 35 // 波形柱子数量
        const blockSize = Math.floor(rawData.length / samples)
        const filteredData: number[] = []

        for (let i = 0; i < samples; i++) {
          let blockStart = blockSize * i
          let sum = 0
          for (let j = 0; j < blockSize; j++) {
            sum = sum + Math.abs(rawData[blockStart + j])
          }
          filteredData.push(sum / blockSize)
        }

        // 归一化
        const multiplier = Math.pow(Math.max(...filteredData), -1)
        const normalizedData = filteredData.map(n => n * multiplier)
        setVoiceWaveform(normalizedData)
        void audioCtx.close()
      } catch (e) {
        console.error('Failed to generate waveform:', e)
        // 降级：生成随机但平滑的波形
        setVoiceWaveform(Array.from({ length: 35 }, () => 0.2 + Math.random() * 0.8))
      }
    }

    void generateWaveform()
  }, [voiceDataUrl])

  // 消息加载时自动检测语音缓存
  useEffect(() => {
    if (!isVoice || voiceDataUrl) return
    window.electronAPI.chat.resolveVoiceCache(session.username, String(message.localId))
      .then((result: { success: boolean; hasCache: boolean; data?: string; error?: string }) => {
        if (result.success && result.hasCache && result.data) {
          const url = `data:audio/wav;base64,${result.data}`
          voiceDataUrlCache.set(voiceCacheKey, url)
          setVoiceDataUrl(url)
        }
      })
  }, [isVoice, message.localId, session.username, voiceCacheKey, voiceDataUrl])

  // 监听流式转写结果
  useEffect(() => {
    if (!isVoice) return
    const removeListener = window.electronAPI.chat.onVoiceTranscriptPartial?.((payload: { msgId: string; text: string }) => {
      if (payload.msgId === String(message.localId)) {
        setVoiceTranscript(payload.text)
        voiceTranscriptCache.set(voiceTranscriptCacheKey, payload.text)
      }
    })
    return () => removeListener?.()
  }, [isVoice, message.localId, voiceTranscriptCacheKey])

  const requestVoiceTranscript = useCallback(async () => {
    if (voiceTranscriptLoading || voiceTranscriptRequestedRef.current) return

    // 检查 whisper API 是否可用
    if (!window.electronAPI?.whisper?.getModelStatus) {
      console.warn('[ChatPage] whisper API 不可用')
      setVoiceTranscriptError(true)
      return
    }

    voiceTranscriptRequestedRef.current = true
    setVoiceTranscriptLoading(true)
    setVoiceTranscriptError(false)
    try {
      // 检查模型状态
      const modelStatus = await window.electronAPI.whisper.getModelStatus()
      if (!modelStatus?.exists) {
        const error: any = new Error('MODEL_NOT_DOWNLOADED')
        error.requiresDownload = true
        error.sessionId = session.username
        error.messageId = String(message.localId)
        throw error
      }

      const result = await window.electronAPI.chat.getVoiceTranscript(
        session.username,
        String(message.localId),
        message.createTime
      )

      if (result.success) {
        const transcriptText = (result.transcript || '').trim()
        voiceTranscriptCache.set(voiceTranscriptCacheKey, transcriptText)
        setVoiceTranscript(transcriptText)
      } else {
        setVoiceTranscriptError(true)
        voiceTranscriptRequestedRef.current = false
      }
    } catch (error: any) {
      // 检查是否是模型未下载错误
      if (error?.requiresDownload) {
        // 模型未下载，触发下载弹窗
        onRequireModelDownload?.(error.sessionId, error.messageId)
        // 不要重置 voiceTranscriptRequestedRef，避免重复触发
        setVoiceTranscriptLoading(false)
        return
      }
      setVoiceTranscriptError(true)
      voiceTranscriptRequestedRef.current = false
    } finally {
      setVoiceTranscriptLoading(false)
    }
  }, [message.localId, session.username, voiceTranscriptCacheKey, voiceTranscriptLoading, onRequireModelDownload])

  // 监听模型下载完成事件
  useEffect(() => {
    if (!isVoice) return

    const handleModelDownloaded = (event: CustomEvent) => {
      if (event.detail?.messageId === String(message.localId)) {
        // 重置状态，允许重新尝试转写
        voiceTranscriptRequestedRef.current = false
        setVoiceTranscriptError(false)
        // 立即尝试转写
        void requestVoiceTranscript()
      }
    }

    window.addEventListener('model-downloaded', handleModelDownloaded as EventListener)
    return () => {
      window.removeEventListener('model-downloaded', handleModelDownloaded as EventListener)
    }
  }, [isVoice, message.localId, requestVoiceTranscript])

  // 视频懒加载
  const videoAutoLoadTriggered = useRef(false)
  const [videoClicked, setVideoClicked] = useState(false)

  useEffect(() => {
    if (!isVideo || !videoContainerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVideoVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '200px 0px',
        threshold: 0
      }
    )

    observer.observe(videoContainerRef.current)

    return () => observer.disconnect()
  }, [isVideo])

  // 视频加载中状态引用，避免依赖问题
  const videoLoadingRef = useRef(false)

  // 加载视频信息（添加重试机制）
  const requestVideoInfo = useCallback(async () => {
    if (!videoMd5 || videoLoadingRef.current) return

    videoLoadingRef.current = true
    setVideoLoading(true)
    try {
      const result = await window.electronAPI.video.getVideoInfo(videoMd5)
      if (result && result.success && result.exists) {
        setVideoInfo({
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl
        })
      } else {
        setVideoInfo({ exists: false })
      }
    } catch (err) {
      setVideoInfo({ exists: false })
    } finally {
      videoLoadingRef.current = false
      setVideoLoading(false)
    }
  }, [videoMd5])

  // 视频进入视野时自动加载
  useEffect(() => {
    if (!isVideo || !isVideoVisible) return
    if (videoInfo?.exists) return // 已成功加载，不需要重试
    if (videoAutoLoadTriggered.current) return

    videoAutoLoadTriggered.current = true
    void requestVideoInfo()
  }, [isVideo, isVideoVisible, videoInfo, requestVideoInfo])


  // 根据设置决定是否自动转写
  const [autoTranscribeEnabled, setAutoTranscribeEnabled] = useState(false)

  useEffect(() => {
    window.electronAPI.config.get('autoTranscribeVoice').then((value: unknown) => {
      setAutoTranscribeEnabled(value === true)
    })
  }, [])

  useEffect(() => {
    if (!autoTranscribeEnabled) return
    if (!isVoice) return
    if (!voiceDataUrl) return
    if (!autoTranscribeVoice) return // 如果自动转文字已关闭，不自动转文字
    if (voiceTranscriptError) return
    if (voiceTranscriptLoading || voiceTranscript !== undefined || voiceTranscriptRequestedRef.current) return
    void requestVoiceTranscript()
  }, [autoTranscribeEnabled, isVoice, voiceDataUrl, voiceTranscript, voiceTranscriptError, voiceTranscriptLoading, requestVoiceTranscript])

  // Selection mode handling removed from here to allow normal rendering
  // We will wrap the output instead

  // Regular rendering logic...
  if (isSystem) {
    return (
      <div
        className={`message-bubble system ${isSelectionMode ? 'selectable' : ''}`}
        onContextMenu={(e) => onContextMenu?.(e, message)}
        style={{ cursor: isSelectionMode ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        onClick={(e) => {
          if (isSelectionMode) {
            e.stopPropagation()
            onToggleSelection?.(message.localId, e.shiftKey)
          }
        }}
      >
        {isSelectionMode && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
        <div className="bubble-content">{message.parsedContent}</div>
      </div>
    )
  }

  // 检测是否为链接卡片消息
  const isLinkMessage = String(message.localType) === '21474836529' ||
    (message.rawContent && (message.rawContent.includes('<appmsg') || message.rawContent.includes('&lt;appmsg'))) ||
    (message.parsedContent && (message.parsedContent.includes('<appmsg') || message.parsedContent.includes('&lt;appmsg')))
  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：优先使用 myAvatarUrl，缺失则用 senderAvatarUrl (补救)
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const avatarUrl = isSent
    ? (myAvatarUrl || senderAvatarUrl)
    : (isGroupChat ? senderAvatarUrl : session.avatarUrl)
  const avatarLetter = isSent
    ? '我'
    : getAvatarLetter(isGroupChat ? (senderName || message.senderUsername || '?') : (session.displayName || session.username))


  // 是否有引用消息
  const hasQuote = message.quotedContent && message.quotedContent.length > 0

  // 去除企业微信 ID 前缀
  const cleanMessageContent = (content: string) => {
    if (!content) return ''
    return content.replace(/^[a-zA-Z0-9]+@openim:\n?/, '')
  }

  // 解析混合文本和表情
  const renderTextWithEmoji = (text: string) => {
    if (!text) return text
    const parts = text.split(/\[(.*?)\]/g)
    return parts.map((part, index) => {
      // 奇数索引是捕获组的内容（即括号内的文字）
      if (index % 2 === 1) {
        // @ts-ignore
        const path = getEmojiPath(part as any)
        if (path) {
          // path 例如 'assets/face/微笑.png'，需要添加 base 前缀
          return (
            <img
              key={index}
              src={`${import.meta.env.BASE_URL}${path}`}
              alt={`[${part}]`}
              className="inline-emoji"
              style={{ width: 22, height: 22, verticalAlign: 'bottom', margin: '0 1px' }}
            />
          )
        }
        return `[${part}]`
      }
      return part
    })
  }

  // 渲染消息内容
  const renderContent = () => {
    if (isImage) {
      return (
        <div ref={imageContainerRef}>
          {imageLoading ? (
            <div className="image-loading">
              <Loader2 size={20} className="spin" />
            </div>
          ) : imageError || !imageLocalPath ? (
            <button
              className={`image-unavailable ${imageClicked ? 'clicked' : ''}`}
              onClick={handleImageClick}
              disabled={imageLoading}
              type="button"
            >
              <ImageIcon size={24} />
              <span>图片未解密</span>
              <span className="image-action">{imageClicked ? '已点击…' : '点击解密'}</span>
            </button>
          ) : (
            <>
              <div className="image-message-wrapper">
                <img
                  src={imageLocalPath}
                  alt="图片"
                  className="image-message"
                  onClick={() => { void handleOpenImageViewer() }}
                  onLoad={() => setImageError(false)}
                  onError={() => setImageError(true)}
                />
                {imageLiveVideoPath && (
                  <div className="media-badge live">
                    <LivePhotoIcon size={14} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )
    }

    // 视频消息
    if (isVideo) {
      const handlePlayVideo = useCallback(async () => {
        if (!videoInfo?.videoUrl) return
        try {
          await window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl)
        } catch (e) {
          console.error('打开视频播放窗口失败:', e)
        }
      }, [videoInfo?.videoUrl])

      // 未进入可视区域时显示占位符
      if (!isVideoVisible) {
        return (
          <div className="video-placeholder" ref={videoContainerRef as React.RefObject<HTMLDivElement>}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
          </div>
        )
      }

      // 加载中
      if (videoLoading) {
        return (
          <div className="video-loading" ref={videoContainerRef as React.RefObject<HTMLDivElement>}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 视频不存在 - 添加点击重试功能
      if (!videoInfo?.exists || !videoInfo.videoUrl) {
        return (
          <button
            className={`video-unavailable ${videoClicked ? 'clicked' : ''}`}
            ref={videoContainerRef as React.RefObject<HTMLButtonElement>}
            onClick={() => {
              setVideoClicked(true)
              setTimeout(() => setVideoClicked(false), 800)
              videoAutoLoadTriggered.current = false
              void requestVideoInfo()
            }}
            type="button"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
            <span>视频未找到</span>
            <span className="video-action">{videoClicked ? '已点击…' : '点击重试'}</span>
          </button>
        )
      }

      // 默认显示缩略图，点击打开独立播放窗口
      const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
      return (
        <div className="video-thumb-wrapper" ref={videoContainerRef as React.RefObject<HTMLDivElement>} onClick={handlePlayVideo}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="视频缩略图" className="video-thumb" />
          ) : (
            <div className="video-thumb-placeholder">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
            </div>
          )}
          <div className="video-play-button">
            <Play size={32} fill="white" />
          </div>
        </div>
      )
    }

    if (isVoice) {
      const durationText = message.voiceDurationSeconds ? `${message.voiceDurationSeconds}"` : ''
      const handleToggle = async () => {
        if (voiceLoading) return
        const audio = voiceAudioRef.current || new Audio()
        if (!voiceAudioRef.current) {
          voiceAudioRef.current = audio
        }
        if (isVoicePlaying) {
          audio.pause()
          audio.currentTime = 0
          globalVoiceManager.stop(audio)
          return
        }
        if (!voiceDataUrl) {
          setVoiceLoading(true)
          setVoiceError(false)
          try {
            const result = await window.electronAPI.chat.getVoiceData(
              session.username,
              String(message.localId),
              message.createTime,
              message.serverId
            )
            if (result.success && result.data) {
              const url = `data:audio/wav;base64,${result.data}`
              voiceDataUrlCache.set(voiceCacheKey, url)
              setVoiceDataUrl(url)
            } else {
              setVoiceError(true)
              return
            }
          } catch {
            setVoiceError(true)
            return
          } finally {
            setVoiceLoading(false)
          }
        }
        const source = voiceDataUrlCache.get(voiceCacheKey) || voiceDataUrl
        if (!source) {
          setVoiceError(true)
          return
        }
        audio.src = source
        try {
          // 停止其他正在播放的语音，确保同一时间只播放一条
          globalVoiceManager.play(audio, () => {
            audio.pause()
            audio.currentTime = 0
          })
          await audio.play()
        } catch {
          setVoiceError(true)
        }
      }

      const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!voiceDataUrl || !voiceAudioRef.current) return
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const percentage = x / rect.width
        const newTime = percentage * voiceDuration
        voiceAudioRef.current.currentTime = newTime
        setVoiceCurrentTime(newTime)
      }

      const showDecryptHint = !voiceDataUrl && !voiceLoading && !isVoicePlaying
      const showTranscript = Boolean(voiceDataUrl) && (voiceTranscriptLoading || voiceTranscriptError || voiceTranscript !== undefined)
      const transcriptText = (voiceTranscript || '').trim()
      const transcriptDisplay = voiceTranscriptLoading
        ? '转写中...'
        : voiceTranscriptError
          ? '转写失败，点击重试'
          : (transcriptText || '未识别到文字')
      const handleTranscriptRetry = () => {
        if (!voiceTranscriptError) return
        voiceTranscriptRequestedRef.current = false
        void requestVoiceTranscript()
      }

      return (
        <div className="voice-stack">
          <div className={`voice-message ${isVoicePlaying ? 'playing' : ''}`} onClick={handleToggle}>
            <button
              className="voice-play-btn"
              onClick={(e) => {
                e.stopPropagation()
                handleToggle()
              }}
              aria-label="播放语音"
              type="button"
            >
              {isVoicePlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <div className="voice-wave" onClick={handleSeek}>
              {voiceDataUrl && voiceWaveform.length > 0 ? (
                <div className="voice-waveform">
                  {voiceWaveform.map((amplitude, i) => {
                    const progress = (voiceCurrentTime / (voiceDuration || 1))
                    const isPlayed = (i / voiceWaveform.length) < progress
                    return (
                      <div
                        key={i}
                        className={`waveform-bar ${isPlayed ? 'played' : ''}`}
                        style={{ height: `${Math.max(20, amplitude * 100)}%` }}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="voice-wave-placeholder">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            <div className="voice-info">
              <span className="voice-label">语音</span>
              {durationText && <span className="voice-duration">{durationText}</span>}
              {voiceLoading && <span className="voice-loading">解码中...</span>}
              {showDecryptHint && <span className="voice-hint">点击解密</span>}
              {voiceError && <span className="voice-error">播放失败</span>}
            </div>
            {/* 转文字按钮 */}
            {voiceDataUrl && !voiceTranscript && !voiceTranscriptLoading && (
              <button
                className="voice-transcribe-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  void requestVoiceTranscript()
                }}
                title="转文字"
                type="button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
          </div>
          {showTranscript && (
            <div
              className={`voice-transcript ${isSent ? 'sent' : 'received'}${voiceTranscriptError ? ' error' : ''}`}
              onClick={handleTranscriptRetry}
              title={voiceTranscriptError ? '点击重试语音转写' : undefined}
            >
              {voiceTranscriptError ? (
                '转写失败，点击重试'
              ) : !voiceTranscript ? (
                voiceTranscriptLoading ? '转写中...' : '未识别到文字'
              ) : (
                <AnimatedStreamingText
                  text={transcriptText}
                  loading={voiceTranscriptLoading}
                />
              )}
            </div>
          )}
        </div>
      )
    }

    // 名片消息
    if (isCard) {
      const cardName = message.cardNickname || message.cardUsername || '未知联系人'
      const cardAvatar = message.cardAvatarUrl
      return (
        <div className="card-message">
          <div className="card-icon">
            {cardAvatar ? (
              <img src={cardAvatar} alt="" style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '8px' }} referrerPolicy="no-referrer" />
            ) : (
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </div>
          <div className="card-info">
            <div className="card-name">{cardName}</div>
            {message.cardUsername && message.cardUsername !== message.cardNickname && (
              <div className="card-wxid">微信号: {message.cardUsername}</div>
            )}
            <div className="card-label">个人名片</div>
          </div>
        </div>
      )
    }

    // 通话消息
    if (isCall) {
      return (
        <div className="bubble-content">
          <div className="call-message">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            <span>{message.parsedContent || '[通话]'}</span>
          </div>
        </div>
      )
    }

    // 位置消息
    if (message.localType === 48) {
      const raw = message.rawContent || ''
      const poiname = raw.match(/poiname="([^"]*)"/)?.[1] || message.locationPoiname || '位置'
      const label = raw.match(/label="([^"]*)"/)?.[1] || message.locationLabel || ''
      const lat = parseFloat(raw.match(/x="([^"]*)"/)?.[1] || String(message.locationLat || 0))
      const lng = parseFloat(raw.match(/y="([^"]*)"/)?.[1] || String(message.locationLng || 0))
      const zoom = 15
      const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom))
      const latRad = lat * Math.PI / 180
      const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom))
      const mapTileUrl = (lat && lng)
        ? `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${zoom}`
        : ''
      return (
        <div className="location-message" onClick={() => window.electronAPI.shell.openExternal(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(poiname || label)}`)}>
          <div className="location-text">
            <div className="location-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
            <div className="location-info">
              {poiname && <div className="location-name">{poiname}</div>}
              {label && <div className="location-label">{label}</div>}
            </div>
          </div>
          {mapTileUrl && (
            <div className="location-map">
              <img src={mapTileUrl} alt="地图" referrerPolicy="no-referrer" />
            </div>
          )}
        </div>
      )
    }

    // 链接消息 (AppMessage)
    const appMsgRichPreview = (() => {
      const rawXml = message.rawContent || ''
      if (!rawXml || (!rawXml.includes('<appmsg') && !rawXml.includes('&lt;appmsg'))) return null

      let doc: Document | null = null
      const getDoc = () => {
        if (doc) return doc
        try {
          const start = rawXml.indexOf('<msg>')
          const xml = start >= 0 ? rawXml.slice(start) : rawXml
          doc = new DOMParser().parseFromString(xml, 'text/xml')
        } catch {
          doc = null
        }
        return doc
      }
      const q = (selector: string) => getDoc()?.querySelector(selector)?.textContent?.trim() || ''

      const xmlType = message.xmlType || q('appmsg > type') || q('type')

      // type 57: 引用回复消息，解析 refermsg 渲染为引用样式
      if (xmlType === '57') {
        const replyText = q('title') || cleanMessageContent(message.parsedContent) || ''
        const referContent = q('refermsg > content') || ''
        const referSender = q('refermsg > displayname') || ''
        const referType = q('refermsg > type') || ''

        // 根据被引用消息类型渲染对应内容
        const renderReferContent = () => {
          // 动画表情：解析嵌套 XML 提取 cdnurl 渲染
          if (referType === '47') {
            try {
              const innerDoc = new DOMParser().parseFromString(referContent, 'text/xml')
              const cdnUrl = innerDoc.querySelector('emoji')?.getAttribute('cdnurl') || ''
              const md5 = innerDoc.querySelector('emoji')?.getAttribute('md5') || ''
              if (cdnUrl) return <QuotedEmoji cdnUrl={cdnUrl} md5={md5} />
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[动画表情]</span>
          }

          // 各类型名称映射
          const typeLabels: Record<string, string> = {
            '3': '图片', '34': '语音', '43': '视频',
            '49': '链接', '50': '通话', '10000': '系统消息', '10002': '撤回消息',
          }
          if (referType && typeLabels[referType]) {
            return <span className="quoted-type-label">[{typeLabels[referType]}]</span>
          }

          // 普通文本或未知类型
          return <>{renderTextWithEmoji(cleanMessageContent(referContent))}</>
        }

        return (
          <div className="bubble-content">
            <div className="quoted-message">
              {referSender && <span className="quoted-sender">{referSender}</span>}
              <span className="quoted-text">{renderReferContent()}</span>
            </div>
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          </div>
        )
      }

      const title = message.linkTitle || q('title') || cleanMessageContent(message.parsedContent) || 'Card'
      const desc = message.appMsgDesc || q('des')
      const url = message.linkUrl || q('url')
      const thumbUrl = message.linkThumb || message.appMsgThumbUrl || q('thumburl') || q('cdnthumburl') || q('cover') || q('coverurl')
      const musicUrl = message.appMsgMusicUrl || message.appMsgDataUrl || q('musicurl') || q('playurl') || q('dataurl') || q('lowurl')
      const sourceName = message.appMsgSourceName || q('sourcename')
      const sourceDisplayName = q('sourcedisplayname') || ''
      const appName = message.appMsgAppName || q('appname')
      const sourceUsername = message.appMsgSourceUsername || q('sourceusername')
      const finderName =
        message.finderNickname ||
        message.finderUsername ||
        q('findernickname') ||
        q('finder_nickname') ||
        q('finderusername') ||
        q('finder_username')

      const lower = rawXml.toLowerCase()

      const kind = message.appMsgKind || (
        (xmlType === '2001' || lower.includes('hongbao')) ? 'red-packet'
          : (xmlType === '115' ? 'gift'
            : ((xmlType === '33' || xmlType === '36') ? 'miniapp'
              : (((xmlType === '5' || xmlType === '49') && (sourceUsername.startsWith('gh_') || !!sourceName || appName.includes('公众号'))) ? 'official-link'
                : (xmlType === '51' ? 'finder'
                  : (xmlType === '3' ? 'music'
                    : ((xmlType === '5' || xmlType === '49') ? 'link' // Fallback for standard links
                      : (!!musicUrl ? 'music' : '')))))))
      )

      if (!kind) return null

      // 对视频号提取真实标题，避免出现 "当前版本不支持该内容"
      let displayTitle = title
      if (kind === 'finder' && (!displayTitle || displayTitle.includes('不支持'))) {
        try {
          const d = new DOMParser().parseFromString(rawXml, 'text/xml')
          displayTitle = d.querySelector('finderFeed desc')?.textContent?.trim() || desc || ''
        } catch {
          displayTitle = desc || ''
        }
      }

      const openExternal = (e: React.MouseEvent, nextUrl?: string) => {
        if (!nextUrl) return
        e.stopPropagation()
        if (window.electronAPI?.shell?.openExternal) {
          window.electronAPI.shell.openExternal(nextUrl)
        } else {
          window.open(nextUrl, '_blank')
        }
      }

      const metaLabel =
        kind === 'red-packet' ? '红包'
          : kind === 'finder' ? (finderName || '视频号')
            : kind === 'location' ? '位置'
              : kind === 'music' ? (sourceName || appName || '音乐')
                : (sourceName || appName || (sourceUsername.startsWith('gh_') ? '公众号' : ''))

      const renderCard = (cardKind: string, clickableUrl?: string) => (
        <div
          className={`link-message appmsg-rich-card ${cardKind}`}
          onClick={clickableUrl ? (e) => openExternal(e, clickableUrl) : undefined}
          title={clickableUrl}
        >
          <div className="link-header">
            <div className="link-title" title={title}>{title}</div>
            {metaLabel ? <div className="appmsg-meta-badge">{metaLabel}</div> : null}
          </div>
          <div className="link-body">
            <div className="link-desc-block">
              {desc ? <div className="link-desc" title={desc}>{desc}</div> : null}
            </div>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                className={`link-thumb${((cardKind === 'miniapp') || /\.svg(?:$|\?)/i.test(thumbUrl)) ? ' theme-adaptive' : ''}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className={`link-thumb-placeholder ${cardKind}`}>{cardKind.slice(0, 2).toUpperCase()}</div>
            )}
          </div>
        </div>
      )

      if (kind === 'quote') {
        // 引用回复消息（appMsgKind='quote'，xmlType=57）
        const replyText = message.linkTitle || q('title') || cleanMessageContent(message.parsedContent) || ''
        const referContent = message.quotedContent || q('refermsg > content') || ''
        const referSender = message.quotedSender || q('refermsg > displayname') || ''
        return (
          <div className="bubble-content">
            <div className="quoted-message">
              {referSender && <span className="quoted-sender">{referSender}</span>}
              <span className="quoted-text">{renderTextWithEmoji(cleanMessageContent(referContent))}</span>
            </div>
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          </div>
        )
      }

      if (kind === 'red-packet') {
        // 专属红包卡片
        const greeting = (() => {
          try {
            const d = getDoc()
            if (!d) return ''
            return d.querySelector('receivertitle')?.textContent?.trim() ||
              d.querySelector('sendertitle')?.textContent?.trim() || ''
          } catch { return '' }
        })()
        return (
          <div className="hongbao-message">
            <div className="hongbao-icon">
              <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                <rect x="4" y="6" width="32" height="28" rx="4" fill="white" fillOpacity="0.3" />
                <rect x="4" y="6" width="32" height="14" rx="4" fill="white" fillOpacity="0.2" />
                <circle cx="20" cy="20" r="6" fill="white" fillOpacity="0.4" />
                <text x="20" y="24" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">¥</text>
              </svg>
            </div>
            <div className="hongbao-info">
              <div className="hongbao-greeting">{greeting || '恭喜发财，大吉大利'}</div>
              <div className="hongbao-label">微信红包</div>
            </div>
          </div>
        )
      }

      if (kind === 'gift') {
        // 礼物卡片
        const giftImg = message.giftImageUrl || thumbUrl
        const giftWish = message.giftWish || title || '送你一份心意'
        const giftPriceRaw = message.giftPrice
        const giftPriceYuan = giftPriceRaw ? (parseInt(giftPriceRaw) / 100).toFixed(2) : ''
        return (
          <div className="gift-message">
            {giftImg && <img className="gift-img" src={giftImg} alt="" referrerPolicy="no-referrer" />}
            <div className="gift-info">
              <div className="gift-wish">{giftWish}</div>
              {giftPriceYuan && <div className="gift-price">¥{giftPriceYuan}</div>}
              <div className="gift-label">微信礼物</div>
            </div>
          </div>
        )
      }

      if (kind === 'finder') {
        // 视频号专属卡片
        const coverUrl = message.finderCoverUrl || thumbUrl
        const duration = message.finderDuration
        const authorName = finderName || ''
        const authorAvatar = message.finderAvatar
        const fmtDuration = duration ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : ''
        return (
          <div className="channel-video-card" onClick={url ? (e) => openExternal(e, url) : undefined}>
            <div className="channel-video-cover">
              {coverUrl ? (
                <img src={coverUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="channel-video-cover-placeholder">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </div>
              )}
              {fmtDuration && <span className="channel-video-duration">{fmtDuration}</span>}
            </div>
            <div className="channel-video-info">
              <div className="channel-video-title">{displayTitle || '视频号视频'}</div>
              <div className="channel-video-author">
                {authorAvatar && <img className="channel-video-avatar" src={authorAvatar} alt="" referrerPolicy="no-referrer" />}
                <span>{authorName || '视频号'}</span>
              </div>
            </div>
          </div>
        )
      }



      if (kind === 'music') {
        // 音乐专属卡片
        const albumUrl = message.musicAlbumUrl || thumbUrl
        const playUrl = message.musicUrl || musicUrl || url
        const songTitle = title || '未知歌曲'
        const artist = desc || ''
        const appLabel = sourceName || appName || ''
        return (
          <div className="music-message" onClick={playUrl ? (e) => openExternal(e, playUrl) : undefined}>
            <div className="music-cover">
              {albumUrl ? (
                <img src={albumUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </div>
            <div className="music-info">
              <div className="music-title">{songTitle}</div>
              {artist && <div className="music-artist">{artist}</div>}
              {appLabel && <div className="music-source">{appLabel}</div>}
            </div>
          </div>
        )
      }

      if (kind === 'official-link') {
        const authorAvatar = q('publisher > headimg') || q('brand_info > headimgurl') || q('appmsg > avatar') || q('headimgurl') || message.cardAvatarUrl
        const authorName = sourceDisplayName || q('publisher > nickname') || sourceName || appName || '公众号'
        const coverPic = q('mmreader > category > item > cover') || thumbUrl
        const digest = q('mmreader > category > item > digest') || desc
        const articleTitle = q('mmreader > category > item > title') || title

        return (
          <div className="official-message" onClick={url ? (e) => openExternal(e, url) : undefined}>
            <div className="official-header">
              {authorAvatar ? (
                <img src={authorAvatar} alt="" className="official-avatar" referrerPolicy="no-referrer" />
              ) : (
                <div className="official-avatar-placeholder">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
              <span className="official-name">{authorName}</span>
            </div>
            <div className="official-body">
              {coverPic ? (
                <div className="official-cover-wrapper">
                  <img src={coverPic} alt="" className="official-cover" referrerPolicy="no-referrer" />
                  <div className="official-title-overlay">{articleTitle}</div>
                </div>
              ) : (
                <div className="official-title-text">{articleTitle}</div>
              )}
              {digest && <div className="official-digest">{digest}</div>}
            </div>
          </div>
        )
      }

      if (kind === 'link') return renderCard('link', url || undefined)
      if (kind === 'card') return renderCard('card', url || undefined)
      if (kind === 'miniapp') {
        return (
          <div className="miniapp-message miniapp-message-rich">
            <div className="miniapp-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="miniapp-info">
              <div className="miniapp-title">{title}</div>
              <div className="miniapp-label">{metaLabel || '小程序'}</div>
            </div>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                className={`miniapp-thumb${/\.svg(?:$|\?)/i.test(thumbUrl) ? ' theme-adaptive' : ''}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
        )
      }
      return null
    })()

    if (appMsgRichPreview) {
      return appMsgRichPreview
    }

    const isAppMsg = message.rawContent?.includes('<appmsg') || (message.parsedContent && message.parsedContent.includes('<appmsg'))

    if (isAppMsg) {
      let title = '链接'
      let desc = ''
      let url = ''
      let appMsgType = ''
      let textAnnouncement = ''
      let parsedDoc: Document | null = null

      try {
        const content = message.rawContent || message.parsedContent || ''
        // 简单清理 XML 前缀（如 wxid:）
        const xmlContent = content.substring(content.indexOf('<msg>'))

        const parser = new DOMParser()
        parsedDoc = parser.parseFromString(xmlContent, 'text/xml')

        title = parsedDoc.querySelector('title')?.textContent || '链接'
        desc = parsedDoc.querySelector('des')?.textContent || ''
        url = parsedDoc.querySelector('url')?.textContent || ''
        appMsgType = parsedDoc.querySelector('appmsg > type')?.textContent || parsedDoc.querySelector('type')?.textContent || ''
        textAnnouncement = parsedDoc.querySelector('textannouncement')?.textContent || ''
      } catch (e) {
        console.error('解析 AppMsg 失败:', e)
      }

      // 引用回复消息 (type=57)，防止被误判为链接
      if (appMsgType === '57') {
        const replyText = parsedDoc?.querySelector('title')?.textContent?.trim() || cleanMessageContent(message.parsedContent) || ''
        const referContent = parsedDoc?.querySelector('refermsg > content')?.textContent?.trim() || ''
        const referSender = parsedDoc?.querySelector('refermsg > displayname')?.textContent?.trim() || ''
        const referType = parsedDoc?.querySelector('refermsg > type')?.textContent?.trim() || ''

        const renderReferContent2 = () => {
          if (referType === '47') {
            try {
              const innerDoc = new DOMParser().parseFromString(referContent, 'text/xml')
              const cdnUrl = innerDoc.querySelector('emoji')?.getAttribute('cdnurl') || ''
              const md5 = innerDoc.querySelector('emoji')?.getAttribute('md5') || ''
              if (cdnUrl) return <QuotedEmoji cdnUrl={cdnUrl} md5={md5} />
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[动画表情]</span>
          }
          const typeLabels: Record<string, string> = {
            '3': '图片', '34': '语音', '43': '视频',
            '49': '链接', '50': '通话', '10000': '系统消息', '10002': '撤回消息',
          }
          if (referType && typeLabels[referType]) {
            return <span className="quoted-type-label">[{typeLabels[referType]}]</span>
          }
          return <>{renderTextWithEmoji(cleanMessageContent(referContent))}</>
        }

        return (
          <div className="bubble-content">
            <div className="quoted-message">
              {referSender && <span className="quoted-sender">{referSender}</span>}
              <span className="quoted-text">{renderReferContent2()}</span>
            </div>
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          </div>
        )
      }

      // 群公告消息 (type=87)
      if (appMsgType === '87') {
        const announcementText = textAnnouncement || desc || '群公告'
        return (
          <div className="announcement-message">
            <div className="announcement-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <div className="announcement-content">
              <div className="announcement-label">群公告</div>
              <div className="announcement-text">{announcementText}</div>
            </div>
          </div>
        )
      }

      // 聊天记录 (type=19)
      if (appMsgType === '19') {
        const recordList = message.chatRecordList || []
        const displayTitle = title || '群聊的聊天记录'
        const metaText =
          recordList.length > 0
            ? `共 ${recordList.length} 条聊天记录`
            : desc || '聊天记录'

        const previewItems = recordList.slice(0, 4)

        return (
          <div
            className="link-message chat-record-message"
            onClick={(e) => {
              e.stopPropagation()
              // 打开聊天记录窗口
              window.electronAPI.window.openChatHistoryWindow(session.username, message.localId)
            }}
            title="点击查看详细聊天记录"
          >
            <div className="link-header">
              <div className="link-title" title={displayTitle}>
                {displayTitle}
              </div>
            </div>
            <div className="link-body">
              <div className="chat-record-preview">
                {previewItems.length > 0 ? (
                  <>
                    <div className="chat-record-meta-line" title={metaText}>
                      {metaText}
                    </div>
                    <div className="chat-record-list">
                      {previewItems.map((item, i) => (
                        <div key={i} className="chat-record-item">
                          <span className="source-name">
                            {item.sourcename ? `${item.sourcename}: ` : ''}
                          </span>
                          {item.datadesc || item.datatitle || '[媒体消息]'}
                        </div>
                      ))}
                      {recordList.length > previewItems.length && (
                        <div className="chat-record-more">还有 {recordList.length - previewItems.length} 条…</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="chat-record-desc">
                    {desc || '点击打开查看完整聊天记录'}
                  </div>
                )}
              </div>
              <div className="chat-record-icon">
                <MessageSquare size={18} />
              </div>
            </div>
          </div>
        )
      }

      // 文件消息 (type=6)
      if (appMsgType === '6') {
        const fileName = message.fileName || title || '文件'
        const fileSize = message.fileSize
        const fileExt = message.fileExt || fileName.split('.').pop()?.toLowerCase() || ''

        // 根据扩展名选择图标
        const getFileIcon = () => {
          const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2']
          if (archiveExts.includes(fileExt)) {
            return (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )
          }
          return (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
          )
        }

        return (
          <div className="file-message">
            <div className="file-icon">
              {getFileIcon()}
            </div>
            <div className="file-info">
              <div className="file-name" title={fileName}>{fileName}</div>
              <div className="file-meta">
                {fileSize ? formatFileSize(fileSize) : ''}
              </div>
            </div>
          </div>
        )
      }

      // 转账消息 (type=2000)
      if (appMsgType === '2000') {
        try {
          // 使用外层已解析好的 parsedDoc（已去除 wxid 前缀）
          const feedesc = parsedDoc?.querySelector('feedesc')?.textContent || ''
          const payMemo = parsedDoc?.querySelector('pay_memo')?.textContent || ''
          const paysubtype = parsedDoc?.querySelector('paysubtype')?.textContent || '1'

          // paysubtype: 1=待收款, 3=已收款
          const isReceived = paysubtype === '3'

          // 如果 feedesc 为空，使用 title 作为降级
          const displayAmount = feedesc || title || '微信转账'

          // 构建转账描述：A 转账给 B
          const transferDesc = transferPayerName && transferReceiverName
            ? `${transferPayerName} 转账给 ${transferReceiverName}`
            : undefined

          return (
            <div className={`transfer-message ${isReceived ? 'received' : ''}`}>
              <div className="transfer-icon">
                {isReceived ? (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20l6 6 10-12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="transfer-info">
                <div className="transfer-amount">{displayAmount}</div>
                {transferDesc && <div className="transfer-desc">{transferDesc}</div>}
                {payMemo && <div className="transfer-memo">{payMemo}</div>}
                <div className="transfer-label">{isReceived ? '已收款' : '微信转账'}</div>
              </div>
            </div>
          )
        } catch (e) {
          console.error('[Transfer Debug] Parse error:', e)
          // 解析失败时的降级处理
          const feedesc = title || '微信转账'
          return (
            <div className="transfer-message">
              <div className="transfer-icon">
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                  <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="transfer-info">
                <div className="transfer-amount">{feedesc}</div>
                <div className="transfer-label">微信转账</div>
              </div>
            </div>
          )
        }
      }

      // 小程序 (type=33/36)
      if (appMsgType === '33' || appMsgType === '36') {
        return (
          <div className="miniapp-message">
            <div className="miniapp-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="miniapp-info">
              <div className="miniapp-title">{title}</div>
              <div className="miniapp-label">小程序</div>
            </div>
          </div>
        )
      }

      // 有 URL 的链接消息
      if (url) {
        return (
          <div
            className="link-message"
            onClick={(e) => {
              e.stopPropagation()
              if (window.electronAPI?.shell?.openExternal) {
                window.electronAPI.shell.openExternal(url)
              } else {
                window.open(url, '_blank')
              }
            }}
          >
            <div className="link-header">
              <div className="link-title" title={title}>{title}</div>
            </div>
            <div className="link-body">
              <div className="link-desc" title={desc}>{desc}</div>
              <div className="link-thumb-placeholder">
                <Link size={24} />
              </div>
            </div>
          </div>
        )
      }
    }

    // 表情包消息
    if (isEmoji) {
      // ... (keep existing emoji logic)
      // 没有 cdnUrl 或加载失败，显示占位符
      if ((!message.emojiCdnUrl && !message.emojiLocalPath) || emojiError) {
        return (
          <div className="emoji-unavailable">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 15s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
            <span>表情包未缓存</span>
          </div>
        )
      }

      // 显示加载中
      if (emojiLoading || !emojiLocalPath) {
        return (
          <div className="emoji-loading">
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 显示表情图片
      return (
        <img
          src={emojiLocalPath}
          alt="表情"
          className="emoji-image"
          onError={() => setEmojiError(true)}
        />
      )
    }

    // 解析引用消息（Links / App Messages）
    // localType: 21474836529 corresponds to AppMessage which often contains links

    // 带引用的消息
    if (hasQuote) {
      return (
        <div className="bubble-content">
          <div className="quoted-message">
            {message.quotedSender && <span className="quoted-sender">{message.quotedSender}</span>}
            <span className="quoted-text">{renderTextWithEmoji(cleanMessageContent(message.quotedContent || ''))}</span>
          </div>
          <div className="message-text">{renderTextWithEmoji(cleanMessageContent(message.parsedContent))}</div>
        </div>
      )
    }

    // 普通消息
    return <div className="bubble-content">{renderTextWithEmoji(cleanMessageContent(message.parsedContent))}</div>
  }

  return (
    <>
      {showTime && (
        <div className="time-divider">
          <span>{formatTime(message.createTime)}</span>
        </div>
      )}
      <div
        className={`message-wrapper-with-selection ${isSelectionMode ? 'selectable' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          width: '100%',
          justifyContent: isSent ? 'flex-end' : 'flex-start',
          cursor: isSelectionMode ? 'pointer' : 'default'
        }}
        onClick={(e) => {
          if (isSelectionMode) {
            e.stopPropagation()
            onToggleSelection?.(message.localId, e.shiftKey)
          }
        }}
      >
        {isSelectionMode && !isSent && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            marginRight: '12px',
            marginTop: '10px', // Align with avatar top
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}

        <div className={`message-bubble ${bubbleClass} ${isEmoji && message.emojiCdnUrl && !emojiError ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVoice ? 'voice' : ''}`}
          onContextMenu={(e) => onContextMenu?.(e, message)}
        >
          <div className="bubble-avatar">
            <Avatar
              src={avatarUrl}
              name={!isSent ? (isGroupChat ? (senderName || message.senderUsername || '?') : (session.displayName || session.username)) : '我'}
              size={36}
              className="bubble-avatar"
            />
          </div>
          <div className="bubble-body">
            {/* 群聊中显示发送者名称 */}
            {isGroupChat && !isSent && (
              <div className="sender-name">
                {senderName || message.senderUsername || '群成员'}
              </div>
            )}
            {renderContent()}
          </div>
        </div>

        {isSelectionMode && isSent && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            marginLeft: '12px',
            marginTop: '10px',
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
      </div>
    </>
  )
}

export default ChatPage
