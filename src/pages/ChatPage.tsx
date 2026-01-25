import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, MessageSquare, AlertCircle, Loader2, RefreshCw, X, ChevronDown, Info, Calendar, Database, Hash, Play, Pause, Image as ImageIcon, Link } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../stores/chatStore'
import type { ChatSession, Message } from '../types/models'
import { getEmojiPath } from 'wechat-emojis'
import { ImagePreview } from '../components/ImagePreview'
import { VoiceTranscribeDialog } from '../components/VoiceTranscribeDialog'
import { AnimatedStreamingText } from '../components/AnimatedStreamingText'
import JumpToDateDialog from '../components/JumpToDateDialog'
import * as configService from '../services/config'
import './ChatPage.scss'

// 系统消息类型常量
const SYSTEM_MESSAGE_TYPES = [
  10000,        // 系统消息
  266287972401, // 拍一拍
]

// 判断是否为系统消息
function isSystemMessage(localType: number): boolean {
  return SYSTEM_MESSAGE_TYPES.includes(localType)
}

interface ChatPageProps {
  // 保留接口以备将来扩展
}


interface SessionDetail {
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
  // 缓存格式化的时间
  const timeText = useMemo(() =>
    formatTime(session.lastTimestamp || session.sortTimestamp),
    [formatTime, session.lastTimestamp, session.sortTimestamp]
  )

  return (
    <div
      className={`session-item ${isActive ? 'active' : ''}`}
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
          {session.unreadCount > 0 && (
            <span className="unread-badge">
              {session.unreadCount > 99 ? '99+' : session.unreadCount}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // 自定义比较：只在关键属性变化时重渲染
  return (
    prevProps.session.username === nextProps.session.username &&
    prevProps.session.displayName === nextProps.session.displayName &&
    prevProps.session.avatarUrl === nextProps.session.avatarUrl &&
    prevProps.session.summary === nextProps.session.summary &&
    prevProps.session.unreadCount === nextProps.session.unreadCount &&
    prevProps.session.lastTimestamp === nextProps.session.lastTimestamp &&
    prevProps.session.sortTimestamp === nextProps.session.sortTimestamp &&
    prevProps.isActive === nextProps.isActive
  )
})



function ChatPage(_props: ChatPageProps) {
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
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [myWxid, setMyWxid] = useState<string | undefined>(undefined)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [isResizing, setIsResizing] = useState(false)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [highlightedMessageKeys, setHighlightedMessageKeys] = useState<string[]>([])
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false)
  const [hasInitialMessages, setHasInitialMessages] = useState(false)
  const [showVoiceTranscribeDialog, setShowVoiceTranscribeDialog] = useState(false)
  const [pendingVoiceTranscriptRequest, setPendingVoiceTranscriptRequest] = useState<{ sessionId: string; messageId: string } | null>(null)

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
  const prevSessionRef = useRef<string | null>(null)
  const isLoadingMessagesRef = useRef(false)
  const isLoadingMoreRef = useRef(false)
  const isConnectedRef = useRef(false)
  const searchKeywordRef = useRef('')
  const preloadImageKeysRef = useRef<Set<string>>(new Set())
  const lastPreloadSessionRef = useRef<string | null>(null)

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

  // 加载会话详情
  const loadSessionDetail = useCallback(async (sessionId: string) => {
    setIsLoadingDetail(true)
    try {
      const result = await window.electronAPI.chat.getSessionDetail(sessionId)
      if (result.success && result.detail) {
        setSessionDetail(result.detail)
      }
    } catch (e) {
      console.error('加载会话详情失败:', e)
    } finally {
      setIsLoadingDetail(false)
    }
  }, [])

  // 切换详情面板
  const toggleDetailPanel = useCallback(() => {
    if (!showDetailPanel && currentSessionId) {
      loadSessionDetail(currentSessionId)
    }
    setShowDetailPanel(!showDetailPanel)
  }, [showDetailPanel, currentSessionId, loadSessionDetail])

  // 连接数据库
  const connect = useCallback(async () => {
    setConnecting(true)
    setConnectionError(null)
    try {
      const result = await window.electronAPI.chat.connect()
      if (result.success) {
        setConnected(true)
        await loadSessions()
        await loadMyAvatar()
        // 获取 myWxid 用于匹配个人头像
        const wxid = await window.electronAPI.config.get('myWxid')
        if (wxid) setMyWxid(wxid as string)
      } else {
        setConnectionError(result.error || '连接失败')
      }
    } catch (e) {
      setConnectionError(String(e))
    } finally {
      setConnecting(false)
    }
  }, [loadMyAvatar])

  const handleAccountChanged = useCallback(async () => {
    senderAvatarCache.clear()
    senderAvatarLoading.clear()
    preloadImageKeysRef.current.clear()
    lastPreloadSessionRef.current = null
    setSessionDetail(null)
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
    await connect()
  }, [
    connect,
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
    setSessions
  ])

  // 加载会话列表（优化：先返回基础数据，异步加载联系人信息）
  const loadSessions = async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      setIsRefreshingSessions(true)
    } else {
      setLoadingSessions(true)
    }
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        // 确保 sessions 是数组
        const sessionsArray = Array.isArray(result.sessions) ? result.sessions : []
        const nextSessions = options?.silent ? mergeSessions(sessionsArray) : sessionsArray
        // 确保 nextSessions 也是数组
        if (Array.isArray(nextSessions)) {
          setSessions(nextSessions)
          // 立即启动联系人信息加载，不再延迟 500ms
          void enrichSessionsContactInfo(nextSessions)
        } else {
          console.error('mergeSessions returned non-array:', nextSessions)
          setSessions(sessionsArray)
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
      console.log('[性能监控] 联系人信息正在加载中，跳过重复请求')
      return
    }

    isEnrichingRef.current = true
    enrichCancelledRef.current = false

    console.log(`[性能监控] 开始加载联系人信息，会话数: ${sessions.length}`)
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
        console.log('[性能监控] 所有联系人信息已缓存，跳过加载')
        isEnrichingRef.current = false
        return
      }

      console.log(`[性能监控] 需要加载的联系人信息: ${needEnrich.length} 个`)

      // 进一步减少批次大小，每批3个，避免DLL调用阻塞
      const batchSize = 3
      let loadedCount = 0

      for (let i = 0; i < needEnrich.length; i += batchSize) {
        // 如果正在滚动，暂停加载
        if (isScrollingRef.current) {
          console.log('[性能监控] 检测到滚动，暂停加载联系人信息')
          // 等待滚动结束
          while (isScrollingRef.current && !enrichCancelledRef.current) {
            await new Promise(resolve => setTimeout(resolve, 200))
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
            }, { timeout: 2000 })
          } else {
            setTimeout(() => {
              void loadContactInfoBatch(usernames).then(() => resolve())
            }, 300)
          }
        })

        loadedCount += batch.length
        const batchTime = performance.now() - batchStart
        if (batchTime > 200) {
          console.warn(`[性能监控] 批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(needEnrich.length / batchSize)} 耗时: ${batchTime.toFixed(2)}ms (已加载: ${loadedCount}/${needEnrich.length})`)
        }

        // 批次间延迟，给UI更多时间（DLL调用可能阻塞，需要更长的延迟）
        if (i + batchSize < needEnrich.length && !enrichCancelledRef.current) {
          // 如果不在滚动，可以延迟短一点
          const delay = isScrollingRef.current ? 1000 : 800
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }

      const totalTime = performance.now() - totalStart
      if (!enrichCancelledRef.current) {
        console.log(`[性能监控] 联系人信息加载完成，总耗时: ${totalTime.toFixed(2)}ms, 已加载: ${loadedCount}/${needEnrich.length}`)
      } else {
        console.log(`[性能监控] 联系人信息加载被取消，已加载: ${loadedCount}/${needEnrich.length}`)
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

    // 增加防抖延迟到500ms，避免在滚动时频繁更新
    contactUpdateTimerRef.current = window.setTimeout(() => {
      const updates = contactUpdateQueueRef.current
      if (updates.size === 0) return

      const now = Date.now()
      // 如果距离上次更新太近（小于1秒），继续延迟
      if (now - lastUpdateTimeRef.current < 1000) {
        contactUpdateTimerRef.current = window.setTimeout(() => {
          flushContactUpdates()
        }, 1000 - (now - lastUpdateTimeRef.current))
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
    }, 500) // 500ms 防抖，减少更新频率
  }, [setSessions])

  // 加载一批联系人信息并更新会话列表（优化：使用队列批量更新）
  const loadContactInfoBatch = async (usernames: string[]) => {
    const startTime = performance.now()
    try {
      // 在 DLL 调用前让出控制权（使用 setTimeout 0 代替 setImmediate）
      await new Promise(resolve => setTimeout(resolve, 0))

      const dllStart = performance.now()
      const result = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
      const dllTime = performance.now() - dllStart

      // DLL 调用后再次让出控制权
      await new Promise(resolve => setTimeout(resolve, 0))

      const totalTime = performance.now() - startTime
      if (dllTime > 50 || totalTime > 100) {
        console.warn(`[性能监控] DLL调用耗时: ${dllTime.toFixed(2)}ms, 总耗时: ${totalTime.toFixed(2)}ms, usernames: ${usernames.length}`)
      }

      if (result.success && result.contacts) {
        // 将更新加入队列，用于侧边栏更新
        for (const [username, contact] of Object.entries(result.contacts)) {
          contactUpdateQueueRef.current.set(username, contact)

          // 如果是自己的信息且当前个人头像为空，同步更新
          if (myWxid && username === myWxid && contact.avatarUrl && !myAvatarUrl) {
            console.log('[ChatPage] 从联系人同步获取到个人头像')
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
  const handleRefreshMessages = async () => {
    if (!currentSessionId || isRefreshingMessages) return
    setJumpStartTime(0)
    setJumpEndTime(0)
    setHasMoreLater(false)
    setIsRefreshingMessages(true)
    try {
      // 获取最新消息并增量添加
      const result = await window.electronAPI.chat.getLatestMessages(currentSessionId, 50)
      if (!result.success || !result.messages) {
        return
      }
      const existing = new Set(messages.map(getMessageKey))
      const lastMsg = messages[messages.length - 1]
      const lastTime = lastMsg?.createTime ?? 0
      const newMessages = result.messages.filter((msg) => {
        const key = getMessageKey(msg)
        if (existing.has(key)) return false
        if (lastTime > 0 && msg.createTime < lastTime) return false
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
      setIsRefreshingMessages(false)
    }
  }

  // 加载消息
  const loadMessages = async (sessionId: string, offset = 0, startTime = 0, endTime = 0) => {
    const listEl = messageListRef.current
    const session = sessionMapRef.current.get(sessionId)
    const unreadCount = session?.unreadCount ?? 0
    const messageLimit = offset === 0 && unreadCount > 99 ? 30 : 50

    if (offset === 0) {
      setLoadingMessages(true)
      setMessages([])
    } else {
      setLoadingMore(true)
    }

    // 记录加载前的第一条消息元素
    const firstMsgEl = listEl?.querySelector('.message-wrapper') as HTMLElement | null

    try {
      const result = await window.electronAPI.chat.getMessages(sessionId, offset, messageLimit, startTime, endTime)
      if (result.success && result.messages) {
        if (offset === 0) {
          setMessages(result.messages)

          // 预取发送者信息：在关闭加载遮罩前处理
          const unreadCount = session?.unreadCount ?? 0
          const isGroup = sessionId.includes('@chatroom')
          if (isGroup && result.messages.length > 0) {
            const unknownSenders = [...new Set(result.messages
              .filter(m => m.isSend !== 1 && m.senderUsername && !senderAvatarCache.has(m.senderUsername))
              .map(m => m.senderUsername as string)
            )]
            if (unknownSenders.length > 0) {
              console.log(`[性能监控] 预取消息发送者信息: ${unknownSenders.length} 个`)
              // 在批量请求前，先将这些发送者标记为加载中，防止 MessageBubble 触发重复请求
              const batchPromise = loadContactInfoBatch(unknownSenders)
              unknownSenders.forEach(username => {
                if (!senderAvatarLoading.has(username)) {
                  senderAvatarLoading.set(username, batchPromise.then(() => senderAvatarCache.get(username) || null))
                }
              })
              // 确保在请求完成后清理 loading 状态
              batchPromise.finally(() => {
                unknownSenders.forEach(username => senderAvatarLoading.delete(username))
              })
            }
          }

          // 首次加载滚动到底部
          requestAnimationFrame(() => {
            if (messageListRef.current) {
              messageListRef.current.scrollTop = messageListRef.current.scrollHeight
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
              const batchPromise = loadContactInfoBatch(unknownSenders)
              unknownSenders.forEach(username => {
                if (!senderAvatarLoading.has(username)) {
                  senderAvatarLoading.set(username, batchPromise.then(() => senderAvatarCache.get(username) || null))
                }
              })
              batchPromise.finally(() => {
                unknownSenders.forEach(username => senderAvatarLoading.delete(username))
              })
            }
          }

          // 加载更多后保持位置：让之前的第一条消息保持在原来的视觉位置
          if (firstMsgEl && listEl) {
            requestAnimationFrame(() => {
              listEl.scrollTop = firstMsgEl.offsetTop - 80
            })
          }
        }
        setHasMoreMessages(result.hasMore ?? false)
        // 如果是按 endTime 跳转加载，且结果刚好满批，可能后面（更晚）还有消息
        if (offset === 0) {
          if (endTime > 0) {
            setHasMoreLater(true)
          } else {
            setHasMoreLater(false)
          }
        }
        setCurrentOffset(offset + result.messages.length)
      } else if (!result.success) {
        setConnectionError(result.error || '加载消息失败')
        setHasMoreMessages(false)
      }
    } catch (e) {
      console.error('加载消息失败:', e)
      setConnectionError('加载消息失败')
      setHasMoreMessages(false)
    } finally {
      setLoadingMessages(false)
      setLoadingMore(false)
    }
  }

  // 加载更晚的消息
  const loadLaterMessages = useCallback(async () => {
    if (!currentSessionId || isLoadingMore || isLoadingMessages || messages.length === 0) return

    setLoadingMore(true)
    try {
      const lastMsg = messages[messages.length - 1]
      // 从最后一条消息的时间开始往后找
      const result = await window.electronAPI.chat.getMessages(currentSessionId, 0, 50, lastMsg.createTime, 0, true)

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

  // 选择会话
  const handleSelectSession = (session: ChatSession) => {
    if (session.username === currentSessionId) return
    setCurrentSession(session.username)
    setCurrentOffset(0)
    setJumpStartTime(0)
    setJumpEndTime(0)
    loadMessages(session.username, 0, 0, 0)
    // 重置详情面板
    setSessionDetail(null)
    if (showDetailPanel) {
      loadSessionDetail(session.username)
    }
  }

  // 搜索过滤
  const handleSearch = (keyword: string) => {
    setSearchKeyword(keyword)
    if (!Array.isArray(sessions)) {
      setFilteredSessions([])
      return
    }
    if (!keyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    const lower = keyword.toLowerCase()
    const filtered = sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    )
    setFilteredSessions(filtered)
  }

  // 关闭搜索框
  const handleCloseSearch = () => {
    setSearchKeyword('')
    setFilteredSessions(Array.isArray(sessions) ? sessions : [])
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
    if (currentSessionId && messages.length === 0 && !isLoadingMessages && !isLoadingMore) {
      loadMessages(currentSessionId, 0)
    }
  }, [currentSessionId, messages.length, isLoadingMessages, isLoadingMore])

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
    if (!Array.isArray(sessions)) {
      setFilteredSessions([])
      return
    }
    if (!searchKeyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    const lower = searchKeyword.toLowerCase()
    const filtered = sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    )
    setFilteredSessions(filtered)
  }, [sessions, searchKeyword, setFilteredSessions])


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

  // 获取当前会话信息
  const currentSession = Array.isArray(sessions) ? sessions.find(s => s.username === currentSessionId) : undefined

  // 判断是否为群聊
  const isGroupChat = (username: string) => username.includes('@chatroom')

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

  return (
    <div className={`chat-page ${isResizing ? 'resizing' : ''}`}>
      {/* 左侧会话列表 */}
      <div
        className="session-sidebar"
        ref={sidebarRef}
        style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
      >
        <div className="session-header">
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
        {isLoadingSessions ? (
          <div className="loading-sessions">
            {/* ... (skeleton items) ... */}
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
        ) : Array.isArray(filteredSessions) && filteredSessions.length > 0 ? (
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
            <p className="hint">请先在数据管理页面解密数据库</p>
          </div>
        )}


      </div>

      {/* 拖动调节条 */}
      <div className="resize-handle" onMouseDown={handleResizeStart} />

      {/* 右侧消息区域 */}
      <div className="message-area">
        {currentSession ? (
          <>
            <div className="message-header">
              <Avatar
                src={currentSession.avatarUrl}
                name={currentSession.displayName || currentSession.username}
                size={40}
                className={isGroupChat(currentSession.username) ? 'group session-avatar' : 'session-avatar'}
              />
              <div className="header-info">
                <h3>{currentSession.displayName || currentSession.username}</h3>
                {isGroupChat(currentSession.username) && (
                  <div className="header-subtitle">群聊</div>
                )}
              </div>
              <div className="header-actions">
                <button
                  className="icon-btn jump-to-time-btn"
                  onClick={() => setShowJumpDialog(true)}
                  title="跳转到指定时间"
                >
                  <Calendar size={18} />
                </button>
                <JumpToDateDialog
                  isOpen={showJumpDialog}
                  onClose={() => setShowJumpDialog(false)}
                  onSelect={(date) => {
                    if (!currentSessionId) return
                    const end = Math.floor(date.setHours(23, 59, 59, 999) / 1000)
                    setCurrentOffset(0)
                    setJumpStartTime(0)
                    setJumpEndTime(end)
                    loadMessages(currentSessionId, 0, 0, end)
                  }}
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

            <div className={`message-content-wrapper ${hasInitialMessages ? 'loaded' : 'loading'}`}>
              {isLoadingMessages && !hasInitialMessages && (
                <div className="loading-messages loading-overlay">
                  <Loader2 size={24} />
                  <span>加载消息中...</span>
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

                {messages.map((msg, index) => {
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
                        isGroupChat={isGroupChat(currentSession.username)}
                        onRequireModelDownload={handleRequireModelDownload}
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

              {/* 会话详情面板 */}
              {showDetailPanel && (
                <div className="detail-panel">
                  <div className="detail-header">
                    <h4>会话详情</h4>
                    <button className="close-btn" onClick={() => setShowDetailPanel(false)}>
                      <X size={16} />
                    </button>
                  </div>
                  {isLoadingDetail ? (
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
                        </div>
                        {sessionDetail.remark && (
                          <div className="detail-item">
                            <span className="label">备注</span>
                            <span className="value">{sessionDetail.remark}</span>
                          </div>
                        )}
                        {sessionDetail.nickName && (
                          <div className="detail-item">
                            <span className="label">昵称</span>
                            <span className="value">{sessionDetail.nickName}</span>
                          </div>
                        )}
                        {sessionDetail.alias && (
                          <div className="detail-item">
                            <span className="label">微信号</span>
                            <span className="value">{sessionDetail.alias}</span>
                          </div>
                        )}
                      </div>

                      <div className="detail-section">
                        <div className="section-title">
                          <MessageSquare size={14} />
                          <span>消息统计</span>
                        </div>
                        <div className="detail-item">
                          <span className="label">消息总数</span>
                          <span className="value highlight">
                            {Number.isFinite(sessionDetail.messageCount)
                              ? sessionDetail.messageCount.toLocaleString()
                              : '—'}
                          </span>
                        </div>
                        {sessionDetail.firstMessageTime && (
                          <div className="detail-item">
                            <Calendar size={14} />
                            <span className="label">首条消息</span>
                            <span className="value">
                              {Number.isFinite(sessionDetail.firstMessageTime)
                                ? new Date(sessionDetail.firstMessageTime * 1000).toLocaleDateString('zh-CN')
                                : '—'}
                            </span>
                          </div>
                        )}
                        {sessionDetail.latestMessageTime && (
                          <div className="detail-item">
                            <Calendar size={14} />
                            <span className="label">最新消息</span>
                            <span className="value">
                              {Number.isFinite(sessionDetail.latestMessageTime)
                                ? new Date(sessionDetail.latestMessageTime * 1000).toLocaleDateString('zh-CN')
                                : '—'}
                            </span>
                          </div>
                        )}
                      </div>

                      {Array.isArray(sessionDetail.messageTables) && sessionDetail.messageTables.length > 0 && (
                        <div className="detail-section">
                          <div className="section-title">
                            <Database size={14} />
                            <span>数据库分布</span>
                          </div>
                          <div className="table-list">
                            {sessionDetail.messageTables.map((t, i) => (
                              <div key={i} className="table-item">
                                <span className="db-name">{t.dbName}</span>
                                <span className="table-count">{t.count.toLocaleString()} 条</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
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
            <p>选择一个会话开始查看聊天记录</p>
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
    </div>
  )
}

// 前端表情包缓存
const emojiDataUrlCache = new Map<string, string>()
const imageDataUrlCache = new Map<string, string>()
const voiceDataUrlCache = new Map<string, string>()
const voiceTranscriptCache = new Map<string, string>()
const senderAvatarCache = new Map<string, { avatarUrl?: string; displayName?: string }>()
const senderAvatarLoading = new Map<string, Promise<{ avatarUrl?: string; displayName?: string } | null>>()

// 消息气泡组件
function MessageBubble({ message, session, showTime, myAvatarUrl, isGroupChat, onRequireModelDownload }: {
  message: Message;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  isGroupChat?: boolean;
  onRequireModelDownload?: (sessionId: string, messageId: string) => void;
}) {
  const isSystem = isSystemMessage(message.localType)
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const imageAutoDecryptTriggered = useRef(false)
  const [voiceError, setVoiceError] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [isVoicePlaying, setIsVoicePlaying] = useState(false)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const [voiceTranscriptLoading, setVoiceTranscriptLoading] = useState(false)
  const [voiceTranscriptError, setVoiceTranscriptError] = useState(false)
  const voiceTranscriptRequestedRef = useRef(false)
  const [showImagePreview, setShowImagePreview] = useState(false)
  const [autoTranscribeVoice, setAutoTranscribeVoice] = useState(true)
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0)
  const [voiceDuration, setVoiceDuration] = useState(0)
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>([])
  const voiceAutoDecryptTriggered = useRef(false)

  // 视频相关状态
  const [videoLoading, setVideoLoading] = useState(false)
  const [videoInfo, setVideoInfo] = useState<{ videoUrl?: string; coverUrl?: string; thumbUrl?: string; exists: boolean } | null>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const [isVideoVisible, setIsVideoVisible] = useState(false)
  const [videoMd5, setVideoMd5] = useState<string | null>(null)

  // 解析视频 MD5
  useEffect(() => {
    if (!isVideo) return

    console.log('[Video Debug] Full message object:', JSON.stringify(message, null, 2))
    console.log('[Video Debug] Message keys:', Object.keys(message))
    console.log('[Video Debug] Message:', {
      localId: message.localId,
      localType: message.localType,
      hasVideoMd5: !!message.videoMd5,
      hasContent: !!message.content,
      hasParsedContent: !!message.parsedContent,
      hasRawContent: !!(message as any).rawContent,
      contentPreview: message.content?.substring(0, 200),
      parsedContentPreview: message.parsedContent?.substring(0, 200),
      rawContentPreview: (message as any).rawContent?.substring(0, 200)
    })

    // 优先使用数据库中的 videoMd5
    if (message.videoMd5) {
      console.log('[Video Debug] Using videoMd5 from message:', message.videoMd5)
      setVideoMd5(message.videoMd5)
      return
    }

    // 尝试从多个可能的字段获取原始内容
    const contentToUse = message.content || (message as any).rawContent || message.parsedContent
    if (contentToUse) {
      console.log('[Video Debug] Parsing MD5 from content, length:', contentToUse.length)
      window.electronAPI.video.parseVideoMd5(contentToUse).then((result) => {
        console.log('[Video Debug] Parse result:', result)
        if (result && result.success && result.md5) {
          console.log('[Video Debug] Parsed MD5:', result.md5)
          setVideoMd5(result.md5)
        } else {
          console.error('[Video Debug] Failed to parse MD5:', result)
        }
      }).catch((err) => {
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
    () => emojiDataUrlCache.get(cacheKey)
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
        pending.then((result) => {
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

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    if (isEmoji && message.emojiCdnUrl && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, emojiLocalPath, emojiLoading, emojiError])

  const requestImageDecrypt = useCallback(async (forceUpdate = false) => {
    if (!isImage || imageLoading) return
    setImageLoading(true)
    setImageError(false)
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
          return
        }
      }

      const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId))
      if (fallback.success && fallback.data) {
        const mime = detectImageMimeFromBase64(fallback.data)
        const dataUrl = `data:${mime};base64,${fallback.data}`
        imageDataUrlCache.set(imageCacheKey, dataUrl)
        setImageLocalPath(dataUrl)
        setImageHasUpdate(false)
        return
      }
      setImageError(true)
    } catch {
      setImageError(true)
    } finally {
      setImageLoading(false)
    }
  }, [isImage, imageLoading, message.imageMd5, message.imageDatName, message.localId, session.username, imageCacheKey, detectImageMimeFromBase64])

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
    }).then((result) => {
      if (cancelled) return
      if (result.success && result.localPath) {
        imageDataUrlCache.set(imageCacheKey, result.localPath)
        if (!imageLocalPath || imageLocalPath !== result.localPath) {
          setImageLocalPath(result.localPath)
          setImageError(false)
        }
        setImageHasUpdate(Boolean(result.hasUpdate))
      }
    }).catch(() => { })
    return () => {
      cancelled = true
    }
  }, [isImage, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, imageCacheKey, session.username])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onUpdateAvailable((payload) => {
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
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload) => {
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
      .then(result => {
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
      console.log('[ChatPage] 调用转写:', {
        sessionId: session.username,
        msgId: message.localId,
        createTime: message.createTime
      })
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

  // 加载视频信息
  useEffect(() => {
    if (!isVideo || !isVideoVisible || videoInfo || videoLoading) return
    if (!videoMd5) {
      console.log('[Video Debug] No videoMd5 available yet')
      return
    }

    console.log('[Video Debug] Loading video info for MD5:', videoMd5)
    setVideoLoading(true)
    window.electronAPI.video.getVideoInfo(videoMd5).then((result) => {
      console.log('[Video Debug] getVideoInfo result:', result)
      if (result && result.success) {
        setVideoInfo({
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl
        })
      } else {
        console.error('[Video Debug] Video info failed:', result)
        setVideoInfo({ exists: false })
      }
    }).catch((err) => {
      console.error('[Video Debug] getVideoInfo error:', err)
      setVideoInfo({ exists: false })
    }).finally(() => {
      setVideoLoading(false)
    })
  }, [isVideo, isVideoVisible, videoInfo, videoLoading, videoMd5])


  // 根据设置决定是否自动转写
  const [autoTranscribeEnabled, setAutoTranscribeEnabled] = useState(false)

  useEffect(() => {
    window.electronAPI.config.get('autoTranscribeVoice').then((value) => {
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

  if (isSystem) {
    return (
      <div className="message-bubble system">
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
                  onClick={() => setShowImagePreview(true)}
                  onLoad={() => setImageError(false)}
                  onError={() => setImageError(true)}
                />
                {imageHasUpdate && (
                  <button
                    className="image-update-button"
                    type="button"
                    title="发现更高清图片，点击更新"
                    onClick={(event) => {
                      event.stopPropagation()
                      void requestImageDecrypt(true)
                    }}
                  >
                    <RefreshCw size={14} />
                  </button>
                )}
              </div>
              {showImagePreview && (
                <ImagePreview src={imageLocalPath} onClose={() => setShowImagePreview(false)} />
              )}
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
          <div className="video-placeholder" ref={videoContainerRef}>
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
          <div className="video-loading" ref={videoContainerRef}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 视频不存在
      if (!videoInfo?.exists || !videoInfo.videoUrl) {
        return (
          <div className="video-unavailable" ref={videoContainerRef}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
            <span>视频不可用</span>
          </div>
        )
      }

      // 默认显示缩略图，点击打开独立播放窗口
      const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
      return (
        <div className="video-thumb-wrapper" ref={videoContainerRef} onClick={handlePlayVideo}>
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

    // 表情包消息
    if (isEmoji) {
      // ... (keep existing emoji logic)
      // 没有 cdnUrl 或加载失败，显示占位符
      if (!message.emojiCdnUrl || emojiError) {
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

    // 解析引用消息（Links / App Messages）
    // localType: 21474836529 corresponds to AppMessage which often contains links
    if (isLinkMessage) {
      try {
        // 清理内容：移除可能的 wxid 前缀，找到 XML 起始位置
        let contentToParse = message.rawContent || message.parsedContent || '';
        const xmlStartIndex = contentToParse.indexOf('<');
        if (xmlStartIndex >= 0) {
          contentToParse = contentToParse.substring(xmlStartIndex);
        }

        // 处理 HTML 转义字符
        if (contentToParse.includes('&lt;')) {
          contentToParse = contentToParse
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'");
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(contentToParse, "text/xml");
        const appMsg = doc.querySelector('appmsg');

        if (appMsg) {
          const title = doc.querySelector('title')?.textContent || '未命名链接';
          const des = doc.querySelector('des')?.textContent || '无描述';
          const url = doc.querySelector('url')?.textContent || '';

          return (
            <div
              className="link-message"
              onClick={(e) => {
                e.stopPropagation();
                if (url) {
                  // 优先使用 electron 接口打开外部浏览器
                  if (window.electronAPI?.shell?.openExternal) {
                    window.electronAPI.shell.openExternal(url);
                  } else {
                    window.open(url, '_blank');
                  }
                }
              }}
            >
              <div className="link-header">
                <div className="link-content">
                  <div className="link-title" title={title}>{title}</div>
                  <div className="link-desc" title={des}>{des}</div>
                </div>
                <div className="link-icon">
                  <Link size={24} />
                </div>
              </div>
            </div>
          );
        }
      } catch (e) {
        console.error('Failed to parse app message', e);
      }
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
      <div className={`message-bubble ${bubbleClass} ${isEmoji && message.emojiCdnUrl && !emojiError ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVoice ? 'voice' : ''}`}>
        <div className="bubble-avatar">
          <Avatar
            src={avatarUrl}
            name={!isSent ? (isGroupChat ? (senderName || message.senderUsername || '?') : (session.displayName || session.username)) : '我'}
            size={36}
            className="bubble-avatar"
          // If it's sent by me (isSent), we might not want 'group' class even if it's a group chat. 
          // But 'group' class mainly handles default avatar icon.
          // Let's rely on standard Avatar behavior.
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
    </>
  )
}

export default ChatPage
