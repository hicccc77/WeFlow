import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, MessageSquare, AlertCircle, Loader2, RefreshCw, X, ChevronDown, Info, Calendar, Database, Hash, Play, Pause, Image as ImageIcon } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'
import type { ChatSession, Message } from '../types/models'
import { getEmojiPath } from 'wechat-emojis'
import './ChatPage.scss'

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

// 头像组件 - 支持骨架屏加载
function SessionAvatar({ session, size = 48 }: { session: ChatSession; size?: number }) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const isGroup = session.username.includes('@chatroom')

  const getAvatarLetter = (): string => {
    const name = session.displayName || session.username
    if (!name) return '?'
    const chars = [...name]
    return chars[0] || '?'
  }

  // 当 avatarUrl 变化时重置状态
  useEffect(() => {
    setImageLoaded(false)
    setImageError(false)
  }, [session.avatarUrl])

  // 检查图片是否已经从缓存加载完成
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current?.naturalWidth > 0) {
      setImageLoaded(true)
    }
  }, [session.avatarUrl])

  const hasValidUrl = session.avatarUrl && !imageError

  return (
    <div
      className={`session-avatar ${isGroup ? 'group' : ''} ${hasValidUrl && !imageLoaded ? 'loading' : ''}`}
      style={{ width: size, height: size }}
    >
      {hasValidUrl ? (
        <>
          {!imageLoaded && <div className="avatar-skeleton" />}
          <img
            ref={imgRef}
            src={session.avatarUrl}
            alt=""
            className={imageLoaded ? 'loaded' : ''}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageError(true)}
          />
        </>
      ) : (
        <span className="avatar-letter">{getAvatarLetter()}</span>
      )}
    </div>
  )
}

// 会话列表项组件 - 支持懒加载联系人信息
const loadingUsernames = new Set<string>()
const loadedUsernames = new Set<string>()

function SessionItem({ 
  session, 
  isActive, 
  onClick,
  onNeedLoadContact,
  formatTime
}: { 
  session: ChatSession
  isActive: boolean
  onClick: () => void
  onNeedLoadContact: (username: string) => void
  formatTime: (timestamp: number) => string
}) {
  const itemRef = useRef<HTMLDivElement>(null)
  const hasContactInfo = session.avatarUrl || (session.displayName && session.displayName !== session.username)
  
  useEffect(() => {
    // 如果已经有联系人信息，或者已经在加载/已加载，跳过
    if (hasContactInfo || loadingUsernames.has(session.username) || loadedUsernames.has(session.username)) {
      return
    }
    
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          // 进入视口，请求加载联系人信息
          if (!loadingUsernames.has(session.username) && !loadedUsernames.has(session.username)) {
            loadingUsernames.add(session.username)
            onNeedLoadContact(session.username)
          }
          observer.disconnect()
        }
      },
      { rootMargin: '100px' }
    )
    
    if (itemRef.current) {
      observer.observe(itemRef.current)
    }
    
    return () => observer.disconnect()
  }, [session.username, hasContactInfo, onNeedLoadContact])
  
  return (
    <div
      ref={itemRef}
      className={`session-item ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <SessionAvatar session={session} size={48} />
      <div className="session-info">
        <div className="session-top">
          <span className="session-name">{session.displayName || session.username}</span>
          <span className="session-time">{formatTime(session.lastTimestamp || session.sortTimestamp)}</span>
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
}

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
    setSearchKeyword
  } = useChatStore()

  // 从 appStore 获取全局连接状态
  const isDbConnected = useAppStore(state => state.isDbConnected)

  const messageListRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [currentOffset, setCurrentOffset] = useState(0)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [isResizing, setIsResizing] = useState(false)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [highlightedMessageKeys, setHighlightedMessageKeys] = useState<string[]>([])
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false)


  const highlightedMessageSet = useMemo(() => new Set(highlightedMessageKeys), [highlightedMessageKeys])
  const messageKeySetRef = useRef<Set<string>>(new Set())
  const lastMessageTimeRef = useRef(0)
  const sessionMapRef = useRef<Map<string, ChatSession>>(new Map())
  const sessionsRef = useRef<ChatSession[]>([])
  const currentSessionRef = useRef<string | null>(null)
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
      } else {
        setConnectionError(result.error || '连接失败')
      }
    } catch (e) {
      setConnectionError(String(e))
    } finally {
      setConnecting(false)
    }
  }, [loadMyAvatar])

  // 加载会话列表
  const loadSessions = async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      setIsRefreshingSessions(true)
    } else {
      setLoadingSessions(true)
    }
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        const nextSessions = options?.silent ? mergeSessions(result.sessions) : result.sessions
        setSessions(nextSessions)
        
        // 预热前5个会话的游标（后台异步执行）
        if (!options?.silent && nextSessions.length > 0) {
          const topSessionIds = nextSessions.slice(0, 5).map(s => s.username)
          window.electronAPI.chat.prewarmCursors(topSessionIds)
          
          // 预加载前30个会话的联系人信息（减少滚动时的请求）
          const sessionsNeedContact = nextSessions
            .slice(0, 30)
            .filter(s => !s.avatarUrl && !s.displayName)
            .map(s => s.username)
          if (sessionsNeedContact.length > 0) {
            window.electronAPI.chat.enrichSessionContacts(sessionsNeedContact).then(res => {
              if (res.success && res.sessions) {
                const updated = [...nextSessions]
                let hasChanges = false
                for (const info of res.sessions) {
                  const idx = updated.findIndex(s => s.username === info.username)
                  if (idx >= 0 && (info.displayName || info.avatarUrl)) {
                    updated[idx] = { ...updated[idx], displayName: info.displayName, avatarUrl: info.avatarUrl }
                    loadedUsernames.add(info.username)
                    hasChanges = true
                  }
                }
                if (hasChanges) setSessions(updated)
              }
            })
          }
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

  // 刷新会话列表
  const handleRefresh = async () => {
    await loadSessions({ silent: true })
  }

  // 批量加载联系人信息的队列
  const pendingContactsRef = useRef<Set<string>>(new Set())
  const loadContactsTimerRef = useRef<number | null>(null)
  
  // 批量加载联系人信息
  const loadContactsBatch = useCallback(async () => {
    const usernames = Array.from(pendingContactsRef.current)
    if (usernames.length === 0) return
    
    pendingContactsRef.current.clear()
    
    try {
      const result = await (window.electronAPI.chat as any).enrichSessionContacts(usernames)
      if (result.success && result.sessions) {
        // 更新会话列表中的联系人信息
        const currentSessions = sessionsRef.current
        const updated = [...currentSessions]
        let hasChanges = false
        
        for (const info of result.sessions as Array<{ username: string; displayName?: string; avatarUrl?: string }>) {
          const idx = updated.findIndex(s => s.username === info.username)
          if (idx >= 0) {
            updated[idx] = {
              ...updated[idx],
              displayName: info.displayName || updated[idx].displayName,
              avatarUrl: info.avatarUrl || updated[idx].avatarUrl
            }
            loadedUsernames.add(info.username)
            hasChanges = true
          }
        }
        
        if (hasChanges) {
          setSessions(updated)
        }
      }
    } catch (e) {
      console.error('批量加载联系人信息失败:', e)
    } finally {
      // 清除加载中状态
      for (const username of usernames) {
        loadingUsernames.delete(username)
      }
    }
  }, [setSessions])
  
  // 请求加载联系人信息（防抖批量处理）
  const isLoadingContactsRef = useRef(false)
  const handleNeedLoadContact = useCallback((username: string) => {
    pendingContactsRef.current.add(username)
    
    // 防抖：300ms 内的请求合并为一批，避免滚动时频繁请求
    if (loadContactsTimerRef.current) {
      clearTimeout(loadContactsTimerRef.current)
    }
    loadContactsTimerRef.current = window.setTimeout(async () => {
      // 如果正在加载，延迟执行
      if (isLoadingContactsRef.current) {
        loadContactsTimerRef.current = window.setTimeout(() => {
          loadContactsBatch()
        }, 200)
        return
      }
      isLoadingContactsRef.current = true
      await loadContactsBatch()
      isLoadingContactsRef.current = false
      loadContactsTimerRef.current = null
    }, 300)
  }, [loadContactsBatch])

  // 刷新当前会话消息（增量更新新消息）
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false)
  const handleRefreshMessages = async () => {
    if (!currentSessionId || isRefreshingMessages) return
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

  // 加载消息 - 先快速加载少量，然后无感刷新
  const loadMessages = async (sessionId: string, offset = 0, isBackgroundLoad = false) => {
    const listEl = messageListRef.current
    const session = sessionMapRef.current.get(sessionId)
    
    // 首次加载时先加载20条，后台再加载更多
    const initialLimit = 20
    const fullLimit = 50
    
    if (offset === 0 && !isBackgroundLoad) {
      setLoadingMessages(true)
      setMessages([])
    } else if (!isBackgroundLoad) {
      setLoadingMore(true)
    }

    // 记录加载前的第一条消息元素
    const firstMsgEl = listEl?.querySelector('.message-wrapper') as HTMLElement | null

    try {
      let result: { success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }
      
      if (offset === 0 && !isBackgroundLoad) {
        // 首次加载：检查游标是否已预热
        const isCursorReady = await window.electronAPI.chat.isCursorReady(sessionId)
        
        if (isCursorReady) {
          // 游标已预热，直接使用游标获取（极快）
          result = await window.electronAPI.chat.getMessages(sessionId, 0, initialLimit)
        } else {
          // 游标未预热，使用快速方法
          result = await window.electronAPI.chat.getMessagesFast(sessionId, initialLimit)
        }
      } else {
        // 后续加载使用游标方法
        const limit = isBackgroundLoad ? fullLimit : fullLimit
        result = await window.electronAPI.chat.getMessages(sessionId, offset, limit)
      }
      
      if (result.success && result.messages) {
        // 群聊：批量预加载发送者头像
        if (session?.username?.includes('@chatroom') && result.messages.length > 0) {
          const senderUsernames = [...new Set(
            result.messages
              .filter(m => m.senderUsername && !senderAvatarCache.has(m.senderUsername))
              .map(m => m.senderUsername!)
          )]
          if (senderUsernames.length > 0) {
            // 异步预加载，不阻塞消息显示
            window.electronAPI.chat.getContactAvatarsBatch(senderUsernames).then(res => {
              if (res.success && res.map) {
                for (const [username, info] of Object.entries(res.map)) {
                  senderAvatarCache.set(username, info)
                }
              }
            })
          }
        }
        
        if (offset === 0 && !isBackgroundLoad) {
          setMessages(result.messages)
          setLoadingMessages(false)
          // 首次加载滚动到底部
          requestAnimationFrame(() => {
            if (messageListRef.current) {
              messageListRef.current.scrollTop = messageListRef.current.scrollHeight
            }
          })
          setHasMoreMessages(result.hasMore ?? false)
          setCurrentOffset(result.messages.length)
          
          // 后台无感加载更多消息
          const loadedCount = result.messages.length
          if (result.hasMore && currentSessionRef.current === sessionId) {
            setTimeout(() => {
              if (currentSessionRef.current === sessionId) {
                loadMessages(sessionId, loadedCount, true)
              }
            }, 100)
          }
          return
        } else if (isBackgroundLoad) {
          // 后台加载：追加到前面，不影响滚动位置
          const currentScrollHeight = listEl?.scrollHeight || 0
          const currentScrollTop = listEl?.scrollTop || 0
          
          appendMessages(result.messages, true)
          
          // 保持滚动位置
          requestAnimationFrame(() => {
            if (listEl) {
              const newScrollHeight = listEl.scrollHeight
              listEl.scrollTop = currentScrollTop + (newScrollHeight - currentScrollHeight)
            }
          })
          setHasMoreMessages(result.hasMore ?? false)
          setCurrentOffset(offset + result.messages.length)
        } else {
          // 用户主动加载更多
          appendMessages(result.messages, true)
          if (firstMsgEl && listEl) {
            requestAnimationFrame(() => {
              listEl.scrollTop = firstMsgEl.offsetTop - 80
            })
          }
          setHasMoreMessages(result.hasMore ?? false)
          setCurrentOffset(offset + result.messages.length)
        }
      } else if (!result.success) {
        setConnectionError(result.error || '加载消息失败')
        setHasMoreMessages(false)
      }
    } catch (e) {
      console.error('加载消息失败:', e)
      if (!isBackgroundLoad) {
        setConnectionError('加载消息失败')
      }
      setHasMoreMessages(false)
    } finally {
      if (!isBackgroundLoad) {
        setLoadingMessages(false)
        setLoadingMore(false)
      }
    }
  }

  // 选择会话
  const handleSelectSession = (session: ChatSession) => {
    if (session.username === currentSessionId) return
    setCurrentSession(session.username)
    setCurrentOffset(0)
    loadMessages(session.username, 0)
    // 重置详情面板
    setSessionDetail(null)
    if (showDetailPanel) {
      loadSessionDetail(session.username)
    }
  }

  // 搜索过滤
  const handleSearch = (keyword: string) => {
    setSearchKeyword(keyword)
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
    setFilteredSessions(sessions)
  }

  // 滚动加载更多 + 显示/隐藏回到底部按钮
  const handleScroll = useCallback(() => {
    if (!messageListRef.current) return

    const { scrollTop, clientHeight, scrollHeight } = messageListRef.current

    // 显示回到底部按钮：距离底部超过 300px
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    setShowScrollToBottom(distanceFromBottom > 300)

    // 预加载：当滚动到顶部 30% 区域时开始加载
    if (!isLoadingMore && !isLoadingMessages && hasMoreMessages && currentSessionId) {
      const threshold = clientHeight * 0.3
      if (scrollTop < threshold) {
        loadMessages(currentSessionId, currentOffset)
      }
    }
  }, [isLoadingMore, isLoadingMessages, hasMoreMessages, currentSessionId, currentOffset])

  const getMessageKey = useCallback((msg: Message): string => {
    if (msg.localId && msg.localId > 0) return `l:${msg.localId}`
    return `t:${msg.createTime}:${msg.sortSeq || 0}:${msg.serverId || 0}`
  }, [])

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
    if (sessionsRef.current.length === 0) return nextSessions
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
    // 如果 App 已经连接了数据库，直接标记为已连接并加载会话
    if (isDbConnected && !isConnected && !isConnecting) {
      setConnected(true)
      loadSessions()
      loadMyAvatar()
      return
    }
    // 如果未连接且未在连接中，则连接
    if (!isDbConnected && !isConnected && !isConnecting) {
      connect()
    }
  }, [isDbConnected, isConnected, isConnecting])

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

  // 暂时完全禁用图片预加载，改为懒加载
  // useEffect(() => {
  //   if (!currentSessionId || messages.length === 0) return
  //   const preloadEdgeCount = 40
  //   const maxPreload = 5  // 减少并发数从30到5
  //   const head = messages.slice(0, preloadEdgeCount)
  //   const tail = messages.slice(-preloadEdgeCount)
  //   const candidates = [...head, ...tail]
  //   const queued = preloadImageKeysRef.current
  //   const seen = new Set<string>()
  //   const payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }> = []
  //   for (const msg of candidates) {
  //     if (payloads.length >= maxPreload) break
  //     if (msg.localType !== 3) continue
  //     const cacheKey = msg.imageMd5 || msg.imageDatName || `local:${msg.localId}`
  //     if (!msg.imageMd5 && !msg.imageDatName) continue
  //     if (imageDataUrlCache.has(cacheKey)) continue
  //     const taskKey = `${currentSessionId}|${cacheKey}`
  //     if (queued.has(taskKey) || seen.has(taskKey)) continue
  //     queued.add(taskKey)
  //     seen.add(taskKey)
  //     payloads.push({
  //       sessionId: currentSessionId,
  //       imageMd5: msg.imageMd5 || undefined,
  //       imageDatName: msg.imageDatName
  //     })
  //   }
  //   if (payloads.length > 0) {
  //     // 分批处理，避免过度并发
  //     const batchSize = 3
  //     for (let i = 0; i < payloads.length; i += batchSize) {
  //       const batch = payloads.slice(i, i + batchSize)
  //       setTimeout(() => {
  //         window.electronAPI.image.preload(batch).catch(() => {})
  //       }, i * 100) // 每批间隔100ms
  //     }
  //   }
  // }, [currentSessionId, messages])

  useEffect(() => {
    const nextMap = new Map<string, ChatSession>()
    for (const session of sessions) {
      nextMap.set(session.username, session)
    }
    sessionMapRef.current = nextMap
  }, [sessions])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // 监听会话列表更新事件（联系人信息异步加载完成后）
  useEffect(() => {
    const unsubscribe = window.electronAPI?.chat?.onSessionsUpdated?.((updatedSessions: ChatSession[]) => {
      setSessions(updatedSessions)
    })
    
    return () => {
      unsubscribe?.()
    }
  }, [setSessions])

  useEffect(() => {
    isLoadingMessagesRef.current = isLoadingMessages
    isLoadingMoreRef.current = isLoadingMore
  }, [isLoadingMessages, isLoadingMore])

  useEffect(() => {
    isConnectedRef.current = isConnected
  }, [isConnected])

  useEffect(() => {
    searchKeywordRef.current = searchKeyword
  }, [searchKeyword])

  useEffect(() => {
    if (!searchKeyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    
    // 添加防抖，避免频繁搜索
    const timeoutId = setTimeout(() => {
      const lower = searchKeyword.toLowerCase()
      const filtered = sessions.filter(s =>
        s.displayName?.toLowerCase().includes(lower) ||
        s.username.toLowerCase().includes(lower) ||
        s.summary.toLowerCase().includes(lower)
      )
      setFilteredSessions(filtered)
    }, 300) // 300ms防抖

    return () => clearTimeout(timeoutId)
  }, [sessions, searchKeyword, setFilteredSessions])


  // 格式化会话时间（相对时间）- 与原项目一致
  const formatSessionTime = (timestamp: number): string => {
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
  }

  // 获取当前会话信息
  const currentSession = sessions.find(s => s.username === currentSessionId)

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

        {isLoadingSessions ? (
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
        ) : filteredSessions.length > 0 ? (
          <div className="session-list">
            {filteredSessions.map(session => (
              <SessionItem
                key={session.username}
                session={session}
                isActive={currentSessionId === session.username}
                onClick={() => handleSelectSession(session)}
                onNeedLoadContact={handleNeedLoadContact}
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
              <SessionAvatar session={currentSession} size={40} />
              <div className="header-info">
                <h3>{currentSession.displayName || currentSession.username}</h3>
                {isGroupChat(currentSession.username) && (
                  <div className="header-subtitle">群聊</div>
                )}
              </div>
              <div className="header-actions">
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

            <div className="message-content-wrapper">
              {isLoadingMessages ? (
                <div className="loading-messages">
                  <Loader2 size={24} />
                  <span>加载消息中...</span>
                </div>
              ) : (
                <div
                  className="message-list"
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

                    // 显示时间：第一条消息，或者与上一条消息间隔超过5分钟
                    const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
                    const isSent = msg.isSend === 1
                    const isSystem = msg.localType === 10000

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
                        />
                      </div>
                    )
                  })}

                  {/* 回到底部按钮 */}
                  <div className={`scroll-to-bottom ${showScrollToBottom ? 'show' : ''}`} onClick={scrollToBottom}>
                    <ChevronDown size={16} />
                    <span>回到底部</span>
                  </div>
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
    </div>
  )
}

// 前端表情包缓存 - 带LRU限制
class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // 移到最后（最近使用）
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // 删除最久未使用的项
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }
}

const emojiDataUrlCache = new LRUCache<string, string>(100)
const imageDataUrlCache = new LRUCache<string, string>(200)
const voiceDataUrlCache = new LRUCache<string, string>(50)
const senderAvatarCache = new Map<string, { avatarUrl?: string; displayName?: string }>()
const senderAvatarLoading = new Map<string, Promise<{ avatarUrl?: string; displayName?: string } | null>>()

// 消息气泡组件
function MessageBubble({ message, session, showTime, myAvatarUrl, isGroupChat }: {
  message: Message;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  isGroupChat?: boolean;
}) {
  const isSystem = message.localType === 10000
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
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
  const [voiceError, setVoiceError] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [isVoicePlaying, setIsVoicePlaying] = useState(false)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const [showImagePreview, setShowImagePreview] = useState(false)

  // 懒加载状态
  const imageRef = useRef<HTMLDivElement>(null)
  const emojiRef = useRef<HTMLDivElement>(null)
  const [isInView, setIsInView] = useState(false)
  const [isEmojiInView, setIsEmojiInView] = useState(false)

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
    } catch {}
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

  // 群聊中获取发送者信息
  useEffect(() => {
    if (isGroupChat && !isSent && message.senderUsername) {
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
      }).catch(() => {}).finally(() => {
        senderAvatarLoading.delete(sender)
      })
    }
  }, [isGroupChat, isSent, message.senderUsername])

  // 自动下载表情包 - 改为懒加载
  useEffect(() => {
    if (emojiLocalPath) return
    if (isEmoji && isEmojiInView && message.emojiCdnUrl && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, isEmojiInView, message.emojiCdnUrl, emojiLocalPath, emojiLoading, emojiError])

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
    if (!isImage || !imageRef.current) return
    
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true)
            observer.disconnect() // 一旦进入视口就停止观察
          }
        })
      },
      { 
        rootMargin: '100px', // 提前100px开始加载
        threshold: 0.1 
      }
    )
    
    observer.observe(imageRef.current)
    
    return () => observer.disconnect()
  }, [isImage])

  useEffect(() => {
    if (!isEmoji || !emojiRef.current) return
    
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsEmojiInView(true)
            observer.disconnect()
          }
        })
      },
      { 
        rootMargin: '50px',
        threshold: 0.1 
      }
    )
    
    observer.observe(emojiRef.current)
    
    return () => observer.disconnect()
  }, [isEmoji])

  useEffect(() => {
    if (!isImage || !isInView || imageLoading) return
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
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isImage, isInView, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, imageCacheKey, session.username])

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


  useEffect(() => {
    if (!isVoice) return
    if (!voiceAudioRef.current) {
      voiceAudioRef.current = new Audio()
    }
    const audio = voiceAudioRef.current
    if (!audio) return
    const handlePlay = () => setIsVoicePlaying(true)
    const handlePause = () => setIsVoicePlaying(false)
    const handleEnded = () => setIsVoicePlaying(false)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)
    return () => {
      audio.pause()
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [isVoice])

  if (isSystem) {
    return (
      <div className="message-bubble system">
        <div className="bubble-content">{message.parsedContent}</div>
      </div>
    )
  }

  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：使用 myAvatarUrl
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const avatarUrl = isSent
    ? myAvatarUrl
    : (isGroupChat ? senderAvatarUrl : session.avatarUrl)
  const avatarLetter = isSent
    ? '我'
    : getAvatarLetter(isGroupChat ? (senderName || message.senderUsername || '?') : (session.displayName || session.username))

  // 是否有引用消息
  const hasQuote = message.quotedContent && message.quotedContent.length > 0

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
        <div ref={imageRef} className="image-container">
          {!isInView ? (
            <div className="image-placeholder">
              <ImageIcon size={24} />
              <span>图片</span>
            </div>
          ) : imageLoading ? (
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
                <div className="image-preview-overlay" onClick={() => setShowImagePreview(false)}>
                  <img src={imageLocalPath} alt="图片预览" onClick={(e) => e.stopPropagation()} />
                  <button className="image-preview-close" onClick={() => setShowImagePreview(false)}>
                    <X size={16} />
                  </button>
                </div>
              )}
            </>
          )}
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
            const result = await window.electronAPI.chat.getVoiceData(session.username, String(message.localId))
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

      const showDecryptHint = !voiceDataUrl && !voiceLoading && !isVoicePlaying

      return (
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
          <div className="voice-wave">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="voice-info">
            <span className="voice-label">语音</span>
            {durationText && <span className="voice-duration">{durationText}</span>}
            {voiceLoading && <span className="voice-loading">解码中...</span>}
            {showDecryptHint && <span className="voice-hint">点击解密</span>}
            {voiceError && <span className="voice-error">播放失败</span>}
          </div>
        </div>
      )
    }

    // 表情包消息
    if (isEmoji) {
      return (
        <div ref={emojiRef} className="emoji-container">
          {!isEmojiInView ? (
            <div className="emoji-placeholder">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 15s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
              <span>表情</span>
            </div>
          ) : !message.emojiCdnUrl || emojiError ? (
            <div className="emoji-unavailable">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 15s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
              <span>表情包未缓存</span>
            </div>
          ) : emojiLoading || !emojiLocalPath ? (
            <div className="emoji-loading">
              <Loader2 size={20} className="spin" />
            </div>
          ) : (
            <img
              src={emojiLocalPath}
              alt="表情"
              className="emoji-image"
              onError={() => setEmojiError(true)}
            />
          )}
        </div>
      )
    }
    // 带引用的消息
    if (hasQuote) {
      return (
        <div className="bubble-content">
          <div className="quoted-message">
            {message.quotedSender && <span className="quoted-sender">{message.quotedSender}</span>}
            <span className="quoted-text">{renderTextWithEmoji(message.quotedContent || '')}</span>
          </div>
          <div className="message-text">{renderTextWithEmoji(message.parsedContent)}</div>
        </div>
      )
    }
    // 普通消息
    return <div className="bubble-content">{renderTextWithEmoji(message.parsedContent)}</div>
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
          {avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="avatar-letter">{avatarLetter}</span>
          )}
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
