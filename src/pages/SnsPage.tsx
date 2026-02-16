import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { RefreshCw, Heart, Search, Calendar, User, X, Filter, Play, ImageIcon, Zap, Download, ChevronRight, AlertTriangle } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { ImagePreview } from '../components/ImagePreview'
import JumpToDateDialog from '../components/JumpToDateDialog'
import { LivePhotoIcon } from '../components/LivePhotoIcon'
import './SnsPage.scss'

interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: {
        url: string
        thumb: string
        md5?: string
        token?: string
        key?: string
        encIdx?: string
        livePhoto?: {
            url: string
            thumb: string
            token?: string
            key?: string
            encIdx?: string
        }
    }[]
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[]
    rawXml?: string  // 原始 XML 数据
}

const MediaItem = ({ media, onPreview }: { media: any; onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string) => void }) => {
    const [error, setError] = useState(false)
    const [thumbSrc, setThumbSrc] = useState<string>('') // 缩略图
    const [videoPath, setVideoPath] = useState<string>('') // 视频本地路径
    const [liveVideoPath, setLiveVideoPath] = useState<string>('') // Live Photo 视频路径
    const [isDecrypting, setIsDecrypting] = useState(false) // 解密状态
    const { url, thumb, livePhoto } = media
    const isLive = !!livePhoto
    const targetUrl = thumb || url // 默认显示缩略图

    // 判断是否为视频
    const isVideo = url && (url.includes('snsvideodownload') || url.includes('.mp4') || url.includes('video')) && !url.includes('vweixinthumb')

    useEffect(() => {
        let cancelled = false
        setError(false)
        setThumbSrc('')
        setVideoPath('')
        setLiveVideoPath('')
        setIsDecrypting(false)

        const extractFirstFrame = (videoUrl: string) => {
            const video = document.createElement('video')
            video.crossOrigin = 'anonymous'
            video.style.display = 'none'
            video.muted = true
            video.src = videoUrl
            video.currentTime = 0.1

            const onLoadedData = () => {
                if (cancelled) return cleanup()
                try {
                    const canvas = document.createElement('canvas')
                    canvas.width = video.videoWidth
                    canvas.height = video.videoHeight
                    const ctx = canvas.getContext('2d')
                    if (ctx) {
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
                        if (!cancelled) {
                            setThumbSrc(dataUrl)
                            setIsDecrypting(false)
                        }
                    } else {
                        if (!cancelled) setIsDecrypting(false)
                    }
                } catch (e) {
                    console.warn('Frame extraction error', e)
                    if (!cancelled) setIsDecrypting(false)
                } finally {
                    cleanup()
                }
            }

            const onError = () => {
                if (!cancelled) {
                    setIsDecrypting(false)
                    setThumbSrc(targetUrl) // Fallback
                }
                cleanup()
            }

            const cleanup = () => {
                video.removeEventListener('seeked', onLoadedData)
                video.removeEventListener('error', onError)
                video.remove()
            }

            video.addEventListener('seeked', onLoadedData)
            video.addEventListener('error', onError)
            video.load()
        }

        const run = async () => {
            try {
                if (isVideo) {
                    setIsDecrypting(true)

                    const videoResult = await window.electronAPI.sns.proxyImage({
                        url: url,
                        key: media.key
                    })

                    if (cancelled) return

                    if (videoResult.success && videoResult.videoPath) {
                        const localUrl = videoResult.videoPath.startsWith('file:')
                            ? videoResult.videoPath
                            : `file://${videoResult.videoPath.replace(/\\/g, '/')}`
                        setVideoPath(localUrl)
                        extractFirstFrame(localUrl)
                    } else {
                        console.warn('[MediaItem] Video decryption failed:', url, videoResult.error)
                        setIsDecrypting(false)
                        setError(true)
                    }
                } else {
                    const result = await window.electronAPI.sns.proxyImage({
                        url: targetUrl,
                        key: media.key
                    })

                    if (cancelled) return
                    if (result.success) {
                        if (result.dataUrl) {
                            setThumbSrc(result.dataUrl)
                        } else if (result.videoPath) {
                            const localUrl = result.videoPath.startsWith('file:')
                                ? result.videoPath
                                : `file://${result.videoPath.replace(/\\/g, '/')}`
                            setThumbSrc(localUrl)
                        }
                    } else {
                        console.warn('[MediaItem] Image proxy failed:', targetUrl, result.error)
                        setThumbSrc(targetUrl)
                    }

                    if (isLive && livePhoto && livePhoto.url) {
                        window.electronAPI.sns.proxyImage({
                            url: livePhoto.url,
                            key: livePhoto.key || media.key
                        }).then((res: any) => {
                            if (cancelled) return
                            if (res.success && res.videoPath) {
                                const localUrl = res.videoPath.startsWith('file:')
                                    ? res.videoPath
                                    : `file://${res.videoPath.replace(/\\/g, '/')}`
                                setLiveVideoPath(localUrl)
                                console.log('[MediaItem] Live video ready:', localUrl)
                            } else {
                                console.warn('[MediaItem] Live video failed:', res.error)
                            }
                        }).catch((e: any) => console.error('[MediaItem] Live video err:', e))
                    }
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('[MediaItem] run error:', err)
                    setError(true)
                    setIsDecrypting(false)
                }
            }
        }

        run()
        return () => { cancelled = true }
    }, [targetUrl, url, media.key, isVideo, isLive, livePhoto])

    const handleDownload = async (e: React.MouseEvent) => {
        e.stopPropagation()
        try {
            const result = await window.electronAPI.sns.downloadImage({
                url: url || targetUrl, // Use original url if available
                key: media.key
            })
            if (!result.success && result.error !== '用户已取消') {
                alert(`下载失败: ${result.error}`)
            }
        } catch (error) {
            console.error('Download failed:', error)
            alert('下载过程中发生错误')
        }
    }

    // 点击时：如果是视频，应该传视频地址给 Preview？
    // ImagePreview 目前可能只支持图片。需要检查 ImagePreview 是否支持视频。
    // 假设 ImagePreview 暂不支持视频播放，我们可以在这里直接点开播放？
    // 或者，传视频 URL 给 onPreview，让父组件决定/ImagePreview 决定。
    // 通常做法：传给 ImagePreview，ImagePreview 识别 mp4 后播放。

    // 显示用的图片：始终显示缩略图
    const displaySrc = thumbSrc || targetUrl

    // 预览用的地址：如果是视频，优先使用本地路径
    const previewSrc = isVideo ? (videoPath || url) : (thumbSrc || url || targetUrl)

    // 点击处理：解密中禁止点击
    const handleClick = () => {
        if (isVideo && isDecrypting) return
        onPreview(previewSrc, isVideo, liveVideoPath)
    }

    return (
        <div className={`media-item ${error ? 'error' : ''} ${isVideo && isDecrypting ? 'decrypting' : ''}`} onClick={handleClick}>
            {isVideo && isDecrypting ? (
                <div className="video-loading-overlay" style={{
                    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', color: '#fff',
                    zIndex: 2, backdropFilter: 'blur(4px)'
                }}>
                    <RefreshCw size={24} className="spin-icon" style={{ marginBottom: 8 }} />
                    <span style={{ fontSize: 12 }}>解密中...</span>
                </div>
            ) : (
                <img
                    src={displaySrc}
                    alt=""
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    onError={() => setError(true)}
                />
            )}

            {isVideo && !isDecrypting && (
                <div className="video-badge-container">
                    <div className="video-badge">
                        <Play size={16} className="play-icon" />
                    </div>
                </div>
            )}

            {isLive && !isVideo && (
                <div className="live-badge">
                    <LivePhotoIcon size={16} className="live-icon" />
                </div>
            )}
            <button className="download-btn-overlay" onClick={handleDownload} title="Download original">
                <Download size={14} />
            </button>
        </div>
    )
}

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
}

export default function SnsPage() {
    const [posts, setPosts] = useState<SnsPost[]>([])
    const [loading, setLoading] = useState(false)
    const [offset, setOffset] = useState(0)
    const [hasMore, setHasMore] = useState(true)
    const loadingRef = useRef(false)

    // 筛选与搜索状态
    const [searchKeyword, setSearchKeyword] = useState('')
    const [selectedUsernames, setSelectedUsernames] = useState<string[]>([])
    const [isSidebarOpen, setIsSidebarOpen] = useState(true)

    // 联系人列表状态
    const [contacts, setContacts] = useState<Contact[]>([])
    const [contactSearch, setContactSearch] = useState('')
    const [contactsLoading, setContactsLoading] = useState(false)
    const [showJumpDialog, setShowJumpDialog] = useState(false)
    const [jumpTargetDate, setJumpTargetDate] = useState<Date | undefined>(undefined)
    const [previewImage, setPreviewImage] = useState<{ src: string, isVideo?: boolean, liveVideoPath?: string } | null>(null)
    const [debugPost, setDebugPost] = useState<SnsPost | null>(null)

    const postsContainerRef = useRef<HTMLDivElement>(null)

    const [hasNewer, setHasNewer] = useState(false)
    const [loadingNewer, setLoadingNewer] = useState(false)
    const postsRef = useRef<SnsPost[]>([])
    const scrollAdjustmentRef = useRef<number>(0)

    // 同步 posts 到 ref 供 loadPosts 使用
    useEffect(() => {
        postsRef.current = posts
    }, [posts])

    // 处理向上加载动态时的滚动位置保持
    useEffect(() => {
        if (scrollAdjustmentRef.current !== 0 && postsContainerRef.current) {
            const container = postsContainerRef.current;
            const newHeight = container.scrollHeight;
            const diff = newHeight - scrollAdjustmentRef.current;
            if (diff > 0) {
                container.scrollTop += diff;
            }
            scrollAdjustmentRef.current = 0;
        }
    }, [posts])

    const loadPosts = useCallback(async (options: { reset?: boolean, direction?: 'older' | 'newer' } = {}) => {
        const { reset = false, direction = 'older' } = options
        if (loadingRef.current) return

        loadingRef.current = true
        if (direction === 'newer') setLoadingNewer(true)
        else setLoading(true)

        try {
            const limit = 20
            let startTs: number | undefined = undefined
            let endTs: number | undefined = undefined

            if (reset) {
                if (jumpTargetDate) {
                    endTs = Math.floor(jumpTargetDate.getTime() / 1000) + 86399
                }
            } else if (direction === 'newer') {
                const currentPosts = postsRef.current
                if (currentPosts.length > 0) {
                    const topTs = currentPosts[0].createTime


                    const result = await window.electronAPI.sns.getTimeline(
                        limit,
                        0,
                        selectedUsernames,
                        searchKeyword,
                        topTs + 1,
                        undefined
                    );

                    if (result.success && result.timeline && result.timeline.length > 0) {
                        if (postsContainerRef.current) {
                            scrollAdjustmentRef.current = postsContainerRef.current.scrollHeight;
                        }

                        const existingIds = new Set(currentPosts.map((p: SnsPost) => p.id));
                        const uniqueNewer = result.timeline.filter((p: SnsPost) => !existingIds.has(p.id));

                        if (uniqueNewer.length > 0) {
                            setPosts(prev => [...uniqueNewer, ...prev]);
                        }
                        setHasNewer(result.timeline.length >= limit);
                    } else {
                        setHasNewer(false);
                    }
                }
                setLoadingNewer(false);
                loadingRef.current = false;
                return;
            } else {
                const currentPosts = postsRef.current
                if (currentPosts.length > 0) {
                    endTs = currentPosts[currentPosts.length - 1].createTime - 1
                }
            }

            const result = await window.electronAPI.sns.getTimeline(
                limit,
                0,
                selectedUsernames,
                searchKeyword,
                startTs,
                endTs
            )

            if (result.success && result.timeline) {
                if (reset) {
                    setPosts(result.timeline)
                    setHasMore(result.timeline.length >= limit)

                    // 探测上方是否还有新动态（利用 DLL 过滤，而非底层 SQL）
                    const topTs = result.timeline[0]?.createTime || 0;
                    if (topTs > 0) {
                        const checkResult = await window.electronAPI.sns.getTimeline(1, 0, selectedUsernames, searchKeyword, topTs + 1, undefined);
                        setHasNewer(!!(checkResult.success && checkResult.timeline && checkResult.timeline.length > 0));
                    } else {
                        setHasNewer(false);
                    }

                    if (postsContainerRef.current) {
                        postsContainerRef.current.scrollTop = 0
                    }
                } else {
                    if (result.timeline.length > 0) {
                        setPosts(prev => [...prev, ...result.timeline!])
                    }
                    if (result.timeline.length < limit) {
                        setHasMore(false)
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load SNS timeline:', error)
        } finally {
            setLoading(false)
            setLoadingNewer(false)
            loadingRef.current = false
        }
    }, [selectedUsernames, searchKeyword, jumpTargetDate])

    // 获取联系人列表
    const loadContacts = useCallback(async () => {
        setContactsLoading(true)
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions) {
                const systemAccounts = ['filehelper', 'fmessage', 'newsapp', 'weixin', 'qqmail', 'tmessage', 'floatbottle', 'medianote', 'brandsessionholder'];
                const initialContacts = result.sessions
                    .filter((s: any) => {
                        if (!s.username) return false;
                        const u = s.username.toLowerCase();
                        if (u.includes('@chatroom') || u.endsWith('@chatroom') || u.endsWith('@openim')) return false;
                        if (u.startsWith('gh_')) return false;
                        if (systemAccounts.includes(u) || u.includes('helper') || u.includes('sessionholder')) return false;
                        return true;
                    })
                    .map((s: any) => ({
                        username: s.username,
                        displayName: s.displayName || s.username,
                        avatarUrl: s.avatarUrl
                    }))
                setContacts(initialContacts)

                const usernames = initialContacts.map((c: { username: string }) => c.username)
                const enriched = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
                if (enriched.success && enriched.contacts) {
                    setContacts(prev => prev.map(c => {
                        const extra = enriched.contacts![c.username]
                        if (extra) {
                            return {
                                ...c,
                                displayName: extra.displayName || c.displayName,
                                avatarUrl: extra.avatarUrl || c.avatarUrl
                            }
                        }
                        return c
                    }))
                }
            }
        } catch (error) {
            console.error('Failed to load contacts:', error)
        } finally {
            setContactsLoading(false)
        }
    }, [])

    // 初始加载
    useEffect(() => {
        const checkSchema = async () => {
            try {
                const schema = await window.electronAPI.chat.execQuery('sns', null, "PRAGMA table_info(SnsTimeLine)");

                if (schema.success && schema.rows) {
                    const columns = schema.rows.map((r: any) => r.name);

                }
            } catch (e) {
                console.error('[SnsPage] Failed to check schema:', e);
            }
        };
        checkSchema();
        loadContacts()
    }, [loadContacts])

    useEffect(() => {
        const handleChange = () => {
            setPosts([])
            setHasMore(true)
            setHasNewer(false)
            setSelectedUsernames([])
            setSearchKeyword('')
            setJumpTargetDate(undefined)
            loadContacts()
            loadPosts({ reset: true })
        }
        window.addEventListener('wxid-changed', handleChange as EventListener)
        return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
    }, [loadContacts, loadPosts])

    useEffect(() => {
        loadPosts({ reset: true })
    }, [selectedUsernames, searchKeyword, jumpTargetDate])

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const { scrollTop, clientHeight, scrollHeight } = e.currentTarget

        // 加载更旧的动态（触底）
        if (scrollHeight - scrollTop - clientHeight < 400 && hasMore && !loading && !loadingNewer) {
            loadPosts({ direction: 'older' })
        }

        // 加载更新的动态（触顶触发）
        // 这里的阈值可以保留，但主要依赖下面的 handleWheel 捕获到顶后的上划
        if (scrollTop < 10 && hasNewer && !loading && !loadingNewer) {
            loadPosts({ direction: 'newer' })
        }
    }

    // 处理到顶后的手动上滚意图
    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const container = postsContainerRef.current
        if (!container) return

        // deltaY < 0 表示向上滚，scrollTop === 0 表示已经在最顶端
        if (e.deltaY < -20 && container.scrollTop <= 0 && hasNewer && !loading && !loadingNewer) {

            loadPosts({ direction: 'newer' })
        }
    }

    const formatTime = (ts: number) => {
        const date = new Date(ts * 1000)
        const isCurrentYear = date.getFullYear() === new Date().getFullYear()

        return date.toLocaleString('zh-CN', {
            year: isCurrentYear ? undefined : 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    }

    const toggleUserSelection = (username: string) => {
        // 选择联系人时，如果当前有时间跳转，建议清除时间跳转以避免“跳到旧动态”的困惑
        // 或者保持原样。根据用户反馈“乱跳”，我们在这里选择：
        // 如果用户选择了新的一个人，而之前有时间跳转，我们重置时间跳转到最新。
        setJumpTargetDate(undefined);

        setSelectedUsernames(prev => {
            if (prev.includes(username)) {
                return prev.filter(u => u !== username)
            } else {
                return [...prev, username]
            }
        })
    }

    const clearFilters = () => {
        setSearchKeyword('')
        setSelectedUsernames([])
        setJumpTargetDate(undefined)
    }

    const filteredContacts = contacts.filter(c =>
        c.displayName.toLowerCase().includes(contactSearch.toLowerCase()) ||
        c.username.toLowerCase().includes(contactSearch.toLowerCase())
    )



    return (
        <div className="sns-page">
            <div className="sns-container">
                <main className="sns-main">
                    <div className="sns-header">
                        <div className="header-left">
                            <h2>社交动态</h2>
                        </div>
                        <div className="header-right">
                            <button
                                className={`icon-btn sidebar-trigger ${isSidebarOpen ? 'active' : ''}`}
                                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                                title={isSidebarOpen ? "收起筛选" : "打开筛选"}
                            >
                                <Filter size={18} />
                            </button>
                            <button
                                onClick={() => {
                                    if (jumpTargetDate) setJumpTargetDate(undefined);
                                    loadPosts({ reset: true });
                                }}
                                disabled={loading || loadingNewer}
                                className="icon-btn refresh-btn"
                                title="刷新"
                            >
                                <RefreshCw size={18} className={(loading || loadingNewer) ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    <div className="sns-content-wrapper">
                        <div className="sns-content custom-scrollbar" onScroll={handleScroll} onWheel={handleWheel} ref={postsContainerRef}>
                            <div className="posts-list">
                                {loadingNewer && (
                                    <div className="status-indicator loading-newer">
                                        <RefreshCw size={16} className="spinning" />
                                        <span>正在检查更新的动态...</span>
                                    </div>
                                )}
                                {!loadingNewer && hasNewer && (
                                    <div className="status-indicator newer-hint" onClick={() => loadPosts({ direction: 'newer' })}>
                                        查看更新的动态
                                    </div>
                                )}
                                {posts.map((post, index) => {
                                    return (
                                        <div key={post.id} className="sns-post-row">
                                            <div className="sns-post-wrapper">
                                                <div className="sns-post">
                                                    <div className="post-header">
                                                        <Avatar
                                                            src={post.avatarUrl}
                                                            name={post.nickname}
                                                            size={44}
                                                            shape="rounded"
                                                        />
                                                        <div className="post-info">
                                                            <div className="nickname">{post.nickname}</div>
                                                            <div className="time">{formatTime(post.createTime)}</div>
                                                        </div>
                                                        <button
                                                            className="debug-btn"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setDebugPost(post);
                                                            }}
                                                            title="查看原始数据"
                                                        >
                                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <polyline points="16 18 22 12 16 6"></polyline>
                                                                <polyline points="8 6 2 12 8 18"></polyline>
                                                            </svg>
                                                        </button>
                                                    </div>

                                                    <div className="post-body">
                                                        {post.contentDesc && <div className="post-text">{post.contentDesc}</div>}

                                                        {post.media.length > 0 && (
                                                            <div className={`post-media-grid media-count-${Math.min(post.media.length, 9)}`}>
                                                                {post.media.map((m, idx) => (
                                                                    <MediaItem key={idx} media={m} onPreview={(src, isVideo, liveVideoPath) => setPreviewImage({ src, isVideo, liveVideoPath })} />
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>

                                                    {(post.likes.length > 0 || post.comments.length > 0) && (
                                                        <div className="post-footer">
                                                            {post.likes.length > 0 && (
                                                                <div className="likes-section">
                                                                    <Heart size={14} className="icon" />
                                                                    <span className="likes-list">
                                                                        {post.likes.join('、')}
                                                                    </span>
                                                                </div>
                                                            )}

                                                            {post.comments.length > 0 && (
                                                                <div className="comments-section">
                                                                    {post.comments.map((c, idx) => (
                                                                        <div key={idx} className="comment-item">
                                                                            <span className="comment-user">{c.nickname}</span>
                                                                            {c.refNickname && (
                                                                                <>
                                                                                    <span className="reply-text">回复</span>
                                                                                    <span className="comment-user">{c.refNickname}</span>
                                                                                </>
                                                                            )}
                                                                            <span className="comment-separator">: </span>
                                                                            <span className="comment-content">{c.content}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>

                            {loading && <div className="status-indicator loading-more">
                                <RefreshCw size={16} className="spinning" />
                                <span>正在加载更多...</span>
                            </div>}
                            {!hasMore && posts.length > 0 && <div className="status-indicator no-more">已经到底啦</div>}
                            {!loading && posts.length === 0 && (
                                <div className="no-results">
                                    <div className="no-results-icon"><Search size={48} /></div>
                                    <p>未找到相关动态</p>
                                    {(selectedUsernames.length > 0 || searchKeyword) && (
                                        <button onClick={clearFilters} className="reset-inline">
                                            重置搜索条件
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </main>

                {/* 侧边栏：过滤与搜索 (moved to right) */}
                <aside className={`sns-sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
                    <div className="sidebar-header">
                        <h3>筛选条件</h3>

                    </div>

                    <div className="filter-content custom-scrollbar">
                        {/* 1. 搜索分组 (放到最顶上) */}
                        <div className="filter-card">
                            <div className="filter-section">
                                <label><Search size={14} /> 关键词搜索</label>
                                <div className="search-input-wrapper">
                                    <Search size={14} className="input-icon" />
                                    <input
                                        type="text"
                                        placeholder="搜索动态内容..."
                                        value={searchKeyword}
                                        onChange={e => setSearchKeyword(e.target.value)}
                                    />
                                    {searchKeyword && (
                                        <button className="clear-input" onClick={() => setSearchKeyword('')}>
                                            <X size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* 2. 日期跳转 (放搜索下面) */}
                        <div className="filter-card jump-date-card">
                            <div className="filter-section">
                                <label><Calendar size={14} /> 时间跳转</label>
                                <button className={`jump-date-btn ${jumpTargetDate ? 'active' : ''}`} onClick={() => setShowJumpDialog(true)}>
                                    <span className="text">
                                        {jumpTargetDate ? jumpTargetDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '选择跳转日期...'}
                                    </span>
                                    <Calendar size={14} className="icon" />
                                </button>
                                {jumpTargetDate && (
                                    <button className="clear-jump-date-inline" onClick={() => setJumpTargetDate(undefined)}>
                                        返回最新动态
                                    </button>
                                )}
                            </div>
                        </div>


                        {/* 3. 联系人筛选 (放最下面，高度自适应) */}
                        <div className="filter-card contact-card">
                            <div className="contact-filter-section">
                                <div className="section-header">
                                    <label><User size={14} /> 联系人</label>
                                    <div className="header-actions">
                                        {selectedUsernames.length > 0 && (
                                            <button className="clear-selection-btn" onClick={() => setSelectedUsernames([])}>清除</button>
                                        )}
                                        {selectedUsernames.length > 0 && (
                                            <span className="selected-count">{selectedUsernames.length}</span>
                                        )}
                                    </div>
                                </div>
                                <div className="contact-search">
                                    <Search size={12} className="search-icon" />
                                    <input
                                        type="text"
                                        placeholder="搜索好友..."
                                        value={contactSearch}
                                        onChange={e => setContactSearch(e.target.value)}
                                    />
                                    {contactSearch && (
                                        <X size={12} className="clear-search-icon" onClick={() => setContactSearch('')} />
                                    )}
                                </div>
                                <div className="contact-list custom-scrollbar">
                                    {filteredContacts.map(contact => (
                                        <div
                                            key={contact.username}
                                            className={`contact-item ${selectedUsernames.includes(contact.username) ? 'active' : ''}`}
                                            onClick={() => toggleUserSelection(contact.username)}
                                        >
                                            <div className="avatar-wrapper">
                                                <Avatar src={contact.avatarUrl} name={contact.displayName} size={32} shape="rounded" />
                                                {selectedUsernames.includes(contact.username) && (
                                                    <div className="active-badge"></div>
                                                )}
                                            </div>
                                            <span className="contact-name">{contact.displayName}</span>
                                            <div className="check-box">
                                                {selectedUsernames.includes(contact.username) && <div className="inner-check"></div>}
                                            </div>
                                        </div>
                                    ))}
                                    {filteredContacts.length === 0 && (
                                        <div className="empty-contacts">无可显示联系人</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="sidebar-footer">
                        <button className="clear-btn" onClick={clearFilters}>
                            <RefreshCw size={14} />
                            重置所有筛选
                        </button>
                    </div>
                </aside>
            </div>
            {previewImage && (
                <ImagePreview
                    src={previewImage.src}
                    isVideo={previewImage.isVideo}
                    liveVideoPath={previewImage.liveVideoPath}
                    onClose={() => setPreviewImage(null)}
                />
            )}
            <JumpToDateDialog
                isOpen={showJumpDialog}
                onClose={() => {
                    setShowJumpDialog(false)
                }}
                onSelect={(date) => {
                    setJumpTargetDate(date)
                    setShowJumpDialog(false)
                }}
                currentDate={jumpTargetDate || new Date()}
            />

            {/* Debug Info Dialog */}
            {debugPost && (
                <div className="modal-overlay" onClick={() => setDebugPost(null)}>
                    <div className="debug-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="debug-dialog-header">
                            <h3>原始数据 - {debugPost.nickname}</h3>
                            <button className="close-btn" onClick={() => setDebugPost(null)}>
                                <X size={20} />
                            </button>
                        </div>
                        <div className="debug-dialog-body">

                            <div className="debug-section">
                                <h4>ℹ 基本信息</h4>
                                <div className="debug-item">
                                    <span className="debug-key">ID:</span>
                                    <span className="debug-value">{debugPost.id}</span>
                                </div>
                                <div className="debug-item">
                                    <span className="debug-key">用户名:</span>
                                    <span className="debug-value">{debugPost.username}</span>
                                </div>
                                <div className="debug-item">
                                    <span className="debug-key">昵称:</span>
                                    <span className="debug-value">{debugPost.nickname}</span>
                                </div>
                                <div className="debug-item">
                                    <span className="debug-key">时间:</span>
                                    <span className="debug-value">{new Date(debugPost.createTime * 1000).toLocaleString()}</span>
                                </div>
                                <div className="debug-item">
                                    <span className="debug-key">类型:</span>
                                    <span className="debug-value">{debugPost.type}</span>
                                </div>
                            </div>

                            <div className="debug-section">
                                <h4> 媒体信息 ({debugPost.media.length} 项)</h4>
                                {debugPost.media.map((media, idx) => (
                                    <div key={idx} className="media-debug-item">
                                        <div className="media-debug-header">媒体 {idx + 1}</div>
                                        <div className="debug-item">
                                            <span className="debug-key">URL:</span>
                                            <span className="debug-value">{media.url}</span>
                                        </div>
                                        <div className="debug-item">
                                            <span className="debug-key">缩略图:</span>
                                            <span className="debug-value">{media.thumb}</span>
                                        </div>
                                        {media.md5 && (
                                            <div className="debug-item">
                                                <span className="debug-key">MD5:</span>
                                                <span className="debug-value">{media.md5}</span>
                                            </div>
                                        )}
                                        {media.token && (
                                            <div className="debug-item">
                                                <span className="debug-key">Token:</span>
                                                <span className="debug-value">{media.token}</span>
                                            </div>
                                        )}
                                        {media.key && (
                                            <div className="debug-item">
                                                <span className="debug-key">Key (解密密钥):</span>
                                                <span className="debug-value">{media.key}</span>
                                            </div>
                                        )}
                                        {media.encIdx && (
                                            <div className="debug-item">
                                                <span className="debug-key">Enc Index:</span>
                                                <span className="debug-value">{media.encIdx}</span>
                                            </div>
                                        )}
                                        {media.livePhoto && (
                                            <div className="live-photo-debug">
                                                <div className="live-photo-label"> Live Photo 视频部分:</div>
                                                <div className="debug-item">
                                                    <span className="debug-key">视频 URL:</span>
                                                    <span className="debug-value">{media.livePhoto.url}</span>
                                                </div>
                                                <div className="debug-item">
                                                    <span className="debug-key">视频缩略图:</span>
                                                    <span className="debug-value">{media.livePhoto.thumb}</span>
                                                </div>
                                                {media.livePhoto.token && (
                                                    <div className="debug-item">
                                                        <span className="debug-key">视频 Token:</span>
                                                        <span className="debug-value">{media.livePhoto.token}</span>
                                                    </div>
                                                )}
                                                {media.livePhoto.key && (
                                                    <div className="debug-item">
                                                        <span className="debug-key">视频 Key:</span>
                                                        <span className="debug-value">{media.livePhoto.key}</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {/* 原始 XML */}
                            {debugPost.rawXml && (
                                <div className="debug-section">
                                    <h4> 原始 XML 数据</h4>
                                    <pre className="json-code">{(() => {
                                        // XML 缩进格式化
                                        let formatted = '';
                                        let indent = 0;
                                        const tab = '  ';
                                        const parts = debugPost.rawXml.split(/(<[^>]+>)/g).filter(p => p.trim());

                                        for (const part of parts) {
                                            if (!part.startsWith('<')) {
                                                if (part.trim()) formatted += part;
                                                continue;
                                            }

                                            if (part.startsWith('</')) {
                                                indent = Math.max(0, indent - 1);
                                                formatted += '\n' + tab.repeat(indent) + part;
                                            } else if (part.endsWith('/>')) {
                                                formatted += '\n' + tab.repeat(indent) + part;
                                            } else {
                                                formatted += '\n' + tab.repeat(indent) + part;
                                                indent++;
                                            }
                                        }

                                        return formatted.trim();
                                    })()}</pre>
                                    <button
                                        className="copy-json-btn"
                                        onClick={() => {
                                            navigator.clipboard.writeText(debugPost.rawXml || '');
                                            alert('已复制 XML 到剪贴板');
                                        }}
                                    >
                                        复制 XML
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
