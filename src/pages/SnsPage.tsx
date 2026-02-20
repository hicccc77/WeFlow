import { useEffect, useState, useRef, useCallback } from 'react'
import { RefreshCw, Search, X, Download, FolderOpen } from 'lucide-react'
import { ImagePreview } from '../components/ImagePreview'
import JumpToDateDialog from '../components/JumpToDateDialog'
import './SnsPage.scss'
import { SnsPost } from '../types/sns'
import { SnsPostItem } from '../components/Sns/SnsPostItem'
import { SnsFilterPanel } from '../components/Sns/SnsFilterPanel'

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
}

export default function SnsPage() {
    const [posts, setPosts] = useState<SnsPost[]>([])
    const [loading, setLoading] = useState(false)
    const [hasMore, setHasMore] = useState(true)
    const loadingRef = useRef(false)

    // Filter states
    const [searchKeyword, setSearchKeyword] = useState('')
    const [selectedUsernames, setSelectedUsernames] = useState<string[]>([])
    const [jumpTargetDate, setJumpTargetDate] = useState<Date | undefined>(undefined)

    // Contacts state
    const [contacts, setContacts] = useState<Contact[]>([])
    const [contactSearch, setContactSearch] = useState('')
    const [contactsLoading, setContactsLoading] = useState(false)

    // UI states
    const [showJumpDialog, setShowJumpDialog] = useState(false)
    const [previewImage, setPreviewImage] = useState<{ src: string, isVideo?: boolean, liveVideoPath?: string } | null>(null)
    const [debugPost, setDebugPost] = useState<SnsPost | null>(null)

    const postsContainerRef = useRef<HTMLDivElement>(null)
    const [hasNewer, setHasNewer] = useState(false)
    const [loadingNewer, setLoadingNewer] = useState(false)
    const postsRef = useRef<SnsPost[]>([])
    const scrollAdjustmentRef = useRef<number>(0)

    // Sync posts ref
    useEffect(() => {
        postsRef.current = posts
    }, [posts])

    // Maintain scroll position when loading newer posts
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
                // If jumping to date, set endTs to end of that day
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
                // Loading older
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
                startTs, // default undefined
                endTs
            )

            if (result.success && result.timeline) {
                if (reset) {
                    setPosts(result.timeline)
                    setHasMore(result.timeline.length >= limit)

                    // Check for newer items above topTs
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

    // Load Contacts
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

    // Initial Load & Listeners
    useEffect(() => {
        loadContacts()
    }, [loadContacts])

    useEffect(() => {
        const handleChange = () => {
            // wxid changed, reset everything
            setPosts([]); setHasMore(true); setHasNewer(false);
            setSelectedUsernames([]); setSearchKeyword(''); setJumpTargetDate(undefined);
            loadContacts();
            loadPosts({ reset: true });
        }
        window.addEventListener('wxid-changed', handleChange as EventListener)
        return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
    }, [loadContacts, loadPosts])

    useEffect(() => {
        const timer = setTimeout(() => {
            loadPosts({ reset: true })
        }, 500)
        return () => clearTimeout(timer)
    }, [selectedUsernames, searchKeyword, jumpTargetDate, loadPosts])

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const { scrollTop, clientHeight, scrollHeight } = e.currentTarget
        if (scrollHeight - scrollTop - clientHeight < 400 && hasMore && !loading && !loadingNewer) {
            loadPosts({ direction: 'older' })
        }
        if (scrollTop < 10 && hasNewer && !loading && !loadingNewer) {
            loadPosts({ direction: 'newer' })
        }
    }

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const container = postsContainerRef.current
        if (!container) return
        if (e.deltaY < -20 && container.scrollTop <= 0 && hasNewer && !loading && !loadingNewer) {
            loadPosts({ direction: 'newer' })
        }
    }

    return (
        <div className="sns-page-layout">
            <div className="sns-main-viewport" onScroll={handleScroll} onWheel={handleWheel} ref={postsContainerRef}>
                <div className="sns-feed-container">
                    <div className="feed-header">
                        <h2>朋友圈</h2>
                        <div className="header-actions">
                            <button
                                onClick={() => loadPosts({ reset: true })}
                                disabled={loading || loadingNewer}
                                className="icon-btn refresh-btn"
                                title="从头刷新"
                            >
                                <RefreshCw size={20} className={(loading || loadingNewer) ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    {loadingNewer && (
                        <div className="status-indicator loading-newer">
                            <RefreshCw size={16} className="spinning" />
                            <span>正在检查更新的动态...</span>
                        </div>
                    )}

                    {!loadingNewer && hasNewer && (
                        <div className="status-indicator newer-hint" onClick={() => loadPosts({ direction: 'newer' })}>
                            有新动态，点击查看
                        </div>
                    )}

                    <div className="posts-list">
                        {posts.map(post => (
                            <SnsPostItem
                                key={post.id}
                                post={post}
                                onPreview={(src, isVideo, liveVideoPath) => setPreviewImage({ src, isVideo, liveVideoPath })}
                                onDebug={(p) => setDebugPost(p)}
                            />
                        ))}
                    </div>

                    {loading && <div className="status-indicator loading-more">
                        <RefreshCw size={16} className="spinning" />
                        <span>正在加载更多...</span>
                    </div>}

                    {!hasMore && posts.length > 0 && (
                        <div className="status-indicator no-more">已经到底啦</div>
                    )}

                    {!loading && posts.length === 0 && (
                        <div className="no-results">
                            <div className="no-results-icon"><Search size={48} /></div>
                            <p>未找到相关动态</p>
                            {(selectedUsernames.length > 0 || searchKeyword || jumpTargetDate) && (
                                <button onClick={() => {
                                    setSearchKeyword(''); setSelectedUsernames([]); setJumpTargetDate(undefined);
                                }} className="reset-inline">
                                    重置筛选条件
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <SnsFilterPanel
                searchKeyword={searchKeyword}
                setSearchKeyword={setSearchKeyword}
                jumpTargetDate={jumpTargetDate}
                setJumpTargetDate={setJumpTargetDate}
                onOpenJumpDialog={() => setShowJumpDialog(true)}
                selectedUsernames={selectedUsernames}
                setSelectedUsernames={setSelectedUsernames}
                contacts={contacts}
                contactSearch={contactSearch}
                setContactSearch={setContactSearch}
                loading={contactsLoading}
            />

            {/* Dialogs and Overlays */}
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
                onClose={() => setShowJumpDialog(false)}
                onSelect={(date) => {
                    setJumpTargetDate(date)
                    setShowJumpDialog(false)
                }}
                currentDate={jumpTargetDate || new Date()}
            />

            {debugPost && (
                <div className="modal-overlay" onClick={() => setDebugPost(null)}>
                    <div className="debug-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="debug-dialog-header">
                            <h3>原始数据</h3>
                            <button className="close-btn" onClick={() => setDebugPost(null)}>
                                <X size={20} />
                            </button>
                        </div>
                        <div className="debug-dialog-body">
                            <pre className="json-code">
                                {JSON.stringify(debugPost, null, 2)}
                            </pre>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
