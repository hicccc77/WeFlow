import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, MessageSquare, AlertCircle, Loader2, RefreshCw, X, ChevronDown, Info, Calendar, Database, Hash } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
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


  const highlightedMessageSet = useMemo(() => new Set(highlightedMessageKeys), [highlightedMessageKeys])
  const messagesRef = useRef<Message[]>([])
  const currentSessionRef = useRef<string | null>(null)
  const isLoadingMessagesRef = useRef(false)
  const isLoadingMoreRef = useRef(false)
  const isConnectedRef = useRef(false)
  const searchKeywordRef = useRef('')

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
  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        setSessions(result.sessions)
      } else if (!result.success) {
        setConnectionError(result.error || '获取会话失败')
      }
    } catch (e) {
      console.error('加载会话失败:', e)
      setConnectionError('加载会话失败')
    } finally {
      setLoadingSessions(false)
    }
  }

  // 刷新会话列表
  const handleRefresh = async () => {
    await loadSessions()
  }

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

  // 加载消息
  const loadMessages = async (sessionId: string, offset = 0) => {
    const listEl = messageListRef.current

    if (offset === 0) {
      setLoadingMessages(true)
      setMessages([])
    } else {
      setLoadingMore(true)
    }

    // 记录加载前的第一条消息元素
    const firstMsgEl = listEl?.querySelector('.message-wrapper') as HTMLElement | null

    try {
      const result = await window.electronAPI.chat.getMessages(sessionId, offset, 50)
      if (result.success && result.messages) {
        if (offset === 0) {
          setMessages(result.messages)
          // 首次加载滚动到底部
          requestAnimationFrame(() => {
            if (messageListRef.current) {
              messageListRef.current.scrollTop = messageListRef.current.scrollHeight
            }
          })
        } else {
          appendMessages(result.messages, true)
          // 加载更多后保持位置：让之前的第一条消息保持在原来的视觉位置
          if (firstMsgEl && listEl) {
            requestAnimationFrame(() => {
              listEl.scrollTop = firstMsgEl.offsetTop - 80
            })
          }
        }
        setHasMoreMessages(result.hasMore ?? false)
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
  }, [])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    currentSessionRef.current = currentSessionId
  }, [currentSessionId])

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
    if (!searchKeyword.trim()) return
    const lower = searchKeyword.toLowerCase()
    const filtered = sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    )
    setFilteredSessions(filtered)
  }, [sessions, searchKeyword, setFilteredSessions])



  // 格式化会话时间（相对时间）- 与原项目一致
  const formatSessionTime = (timestamp: number): string => {
    if (!timestamp) return ''

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
            <button className="icon-btn refresh-btn" onClick={handleRefresh} disabled={isLoadingSessions}>
              <RefreshCw size={16} className={isLoadingSessions ? 'spin' : ''} />
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
              <div
                key={session.username}
                className={`session-item ${currentSessionId === session.username ? 'active' : ''}`}
                onClick={() => handleSelectSession(session)}
              >
                <SessionAvatar session={session} size={48} />
                <div className="session-info">
                  <div className="session-top">
                    <span className="session-name">{session.displayName || session.username}</span>
                    <span className="session-time">{formatSessionTime(session.lastTimestamp || session.sortTimestamp)}</span>
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
                          <span className="value highlight">{sessionDetail.messageCount.toLocaleString()}</span>
                        </div>
                        {sessionDetail.firstMessageTime && (
                          <div className="detail-item">
                            <Calendar size={14} />
                            <span className="label">首条消息</span>
                            <span className="value">{new Date(sessionDetail.firstMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
                          </div>
                        )}
                        {sessionDetail.latestMessageTime && (
                          <div className="detail-item">
                            <Calendar size={14} />
                            <span className="label">最新消息</span>
                            <span className="value">{new Date(sessionDetail.latestMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
                          </div>
                        )}
                      </div>

                      {sessionDetail.messageTables.length > 0 && (
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

// 前端表情包缓存
const emojiDataUrlCache = new Map<string, string>()
const senderAvatarCache = new Map<string, { avatarUrl?: string; displayName?: string }>()

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
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)

  // 从缓存获取表情包 data URL
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => emojiDataUrlCache.get(cacheKey)
  )

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

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
      const cached = senderAvatarCache.get(message.senderUsername)
      if (cached) {
        setSenderAvatarUrl(cached.avatarUrl)
        setSenderName(cached.displayName)
        return
      }
      window.electronAPI.chat.getContactAvatar(message.senderUsername).then((result: { avatarUrl?: string; displayName?: string } | null) => {
        if (result) {
          senderAvatarCache.set(message.senderUsername!, result)
          setSenderAvatarUrl(result.avatarUrl)
          setSenderName(result.displayName)
        }
      }).catch(() => { })
    }
  }, [isGroupChat, isSent, message.senderUsername])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    if (isEmoji && message.emojiCdnUrl && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, emojiLocalPath, emojiLoading, emojiError])

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
          // path 例如 'assets/face/微笑.png'，需要添加 / 前缀
          return (
            <img
              key={index}
              src={`/${path}`}
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
      <div className={`message-bubble ${bubbleClass} ${isEmoji && message.emojiCdnUrl && !emojiError ? 'emoji' : ''}`}>
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
