import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SnsPostItem } from './SnsPostItem'
import type { SnsPost } from '../../types/sns'
import {
  type ContactSnsRankItem,
  type ContactSnsRankMode,
  type ContactSnsTimelineTarget,
  getAvatarLetter
} from './contactSnsTimeline'
import './ContactSnsTimelineDialog.scss'

const TIMELINE_PAGE_SIZE = 20
const SNS_RANK_PAGE_SIZE = 50
const SNS_RANK_DISPLAY_LIMIT = 15

interface ContactSnsRankCacheEntry {
  likes: ContactSnsRankItem[]
  comments: ContactSnsRankItem[]
  totalPosts: number
}

interface ContactSnsTimelineDialogProps {
  target: ContactSnsTimelineTarget | null
  onClose: () => void
  initialTotalPosts?: number | null
  initialTotalPostsLoading?: boolean
  isProtected?: boolean
  onDeletePost?: (postId: string, username: string) => void
}

const normalizeTotalPosts = (value?: number | null): number | null => {
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.floor(Number(value)))
}

const formatYmdDateFromSeconds = (timestamp?: number): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp * 1000)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const buildContactSnsRankings = (posts: SnsPost[]): { likes: ContactSnsRankItem[]; comments: ContactSnsRankItem[] } => {
  const likeMap = new Map<string, ContactSnsRankItem>()
  const commentMap = new Map<string, ContactSnsRankItem>()

  for (const post of posts) {
    const createTime = Number(post?.createTime) || 0
    const likes = Array.isArray(post?.likes) ? post.likes : []
    const comments = Array.isArray(post?.comments) ? post.comments : []

    for (const likeNameRaw of likes) {
      const name = String(likeNameRaw || '').trim() || '未知用户'
      const current = likeMap.get(name)
      if (current) {
        current.count += 1
        if (createTime > current.latestTime) current.latestTime = createTime
        continue
      }
      likeMap.set(name, { name, count: 1, latestTime: createTime })
    }

    for (const comment of comments) {
      const name = String(comment?.nickname || '').trim() || '未知用户'
      const current = commentMap.get(name)
      if (current) {
        current.count += 1
        if (createTime > current.latestTime) current.latestTime = createTime
        continue
      }
      commentMap.set(name, { name, count: 1, latestTime: createTime })
    }
  }

  const sorter = (left: ContactSnsRankItem, right: ContactSnsRankItem): number => {
    if (right.count !== left.count) return right.count - left.count
    if (right.latestTime !== left.latestTime) return right.latestTime - left.latestTime
    return left.name.localeCompare(right.name, 'zh-CN')
  }

  return {
    likes: [...likeMap.values()].sort(sorter),
    comments: [...commentMap.values()].sort(sorter)
  }
}

export function ContactSnsTimelineDialog({
  target,
  onClose,
  initialTotalPosts = null,
  initialTotalPostsLoading = false,
  isProtected = false,
  onDeletePost
}: ContactSnsTimelineDialogProps) {
  const [timelinePosts, setTimelinePosts] = useState<SnsPost[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false)
  const [timelineHasMore, setTimelineHasMore] = useState(false)
  const [timelineTotalPosts, setTimelineTotalPosts] = useState<number | null>(null)
  const [timelineStatsLoading, setTimelineStatsLoading] = useState(false)
  const [rankMode, setRankMode] = useState<ContactSnsRankMode | null>(null)
  const [likeRankings, setLikeRankings] = useState<ContactSnsRankItem[]>([])
  const [commentRankings, setCommentRankings] = useState<ContactSnsRankItem[]>([])
  const [rankLoading, setRankLoading] = useState(false)
  const [rankError, setRankError] = useState<string | null>(null)
  const [rankLoadedPosts, setRankLoadedPosts] = useState(0)
  const [rankTotalPosts, setRankTotalPosts] = useState<number | null>(null)

  const timelinePostsRef = useRef<SnsPost[]>([])
  const timelineLoadingRef = useRef(false)
  const timelineRequestTokenRef = useRef(0)
  const totalPostsRequestTokenRef = useRef(0)
  const rankRequestTokenRef = useRef(0)
  const rankLoadingRef = useRef(false)
  const rankCacheRef = useRef<Record<string, ContactSnsRankCacheEntry>>({})

  const targetUsername = String(target?.username || '').trim()
  const targetDisplayName = target?.displayName || targetUsername
  const targetAvatarUrl = target?.avatarUrl

  useEffect(() => {
    timelinePostsRef.current = timelinePosts
  }, [timelinePosts])

  const loadTimelinePosts = useCallback(async (nextTarget: ContactSnsTimelineTarget, options?: { reset?: boolean }) => {
    const reset = Boolean(options?.reset)
    if (timelineLoadingRef.current) return

    timelineLoadingRef.current = true
    if (reset) {
      setTimelineLoading(true)
      setTimelineLoadingMore(false)
      setTimelineHasMore(false)
    } else {
      setTimelineLoadingMore(true)
    }

    const requestToken = ++timelineRequestTokenRef.current

    try {
      let endTime: number | undefined
      if (!reset && timelinePostsRef.current.length > 0) {
        endTime = timelinePostsRef.current[timelinePostsRef.current.length - 1].createTime - 1
      }

      const result = await window.electronAPI.sns.getTimeline(
        TIMELINE_PAGE_SIZE,
        0,
        [nextTarget.username],
        '',
        undefined,
        endTime
      )
      if (requestToken !== timelineRequestTokenRef.current) return

      if (!result.success || !Array.isArray(result.timeline)) {
        if (reset) {
          setTimelinePosts([])
          setTimelineHasMore(false)
        }
        return
      }

      const timeline = [...(result.timeline as SnsPost[])].sort((left, right) => right.createTime - left.createTime)
      if (reset) {
        setTimelinePosts(timeline)
        setTimelineHasMore(timeline.length >= TIMELINE_PAGE_SIZE)
        return
      }

      const existingIds = new Set(timelinePostsRef.current.map((post) => post.id))
      const uniqueOlder = timeline.filter((post) => !existingIds.has(post.id))
      if (uniqueOlder.length > 0) {
        const merged = [...timelinePostsRef.current, ...uniqueOlder].sort((left, right) => right.createTime - left.createTime)
        setTimelinePosts(merged)
      }
      if (timeline.length < TIMELINE_PAGE_SIZE) {
        setTimelineHasMore(false)
      }
    } catch (error) {
      console.error('加载联系人朋友圈失败:', error)
      if (requestToken === timelineRequestTokenRef.current && reset) {
        setTimelinePosts([])
        setTimelineHasMore(false)
      }
    } finally {
      if (requestToken === timelineRequestTokenRef.current) {
        timelineLoadingRef.current = false
        setTimelineLoading(false)
        setTimelineLoadingMore(false)
      }
    }
  }, [])

  const loadTimelineTotalPosts = useCallback(async (nextTarget: ContactSnsTimelineTarget) => {
    const requestToken = ++totalPostsRequestTokenRef.current
    setTimelineStatsLoading(true)

    try {
      const result = await window.electronAPI.sns.getUserPostCounts()
      if (requestToken !== totalPostsRequestTokenRef.current) return

      if (!result.success || !result.counts) {
        setTimelineTotalPosts(null)
        setRankTotalPosts(null)
        return
      }

      const rawCount = Number(result.counts[nextTarget.username] || 0)
      const normalized = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0
      setTimelineTotalPosts(normalized)
      setRankTotalPosts(normalized)
    } catch (error) {
      console.error('加载联系人朋友圈条数失败:', error)
      if (requestToken !== totalPostsRequestTokenRef.current) return
      setTimelineTotalPosts(null)
      setRankTotalPosts(null)
    } finally {
      if (requestToken === totalPostsRequestTokenRef.current) {
        setTimelineStatsLoading(false)
      }
    }
  }, [])

  const loadRankings = useCallback(async (nextTarget: ContactSnsTimelineTarget) => {
    const normalizedUsername = String(nextTarget?.username || '').trim()
    if (!normalizedUsername || rankLoadingRef.current) return

    const normalizedKnownTotal = normalizeTotalPosts(timelineTotalPosts)
    const cached = rankCacheRef.current[normalizedUsername]

    if (cached && (normalizedKnownTotal === null || cached.totalPosts === normalizedKnownTotal)) {
      setLikeRankings(cached.likes)
      setCommentRankings(cached.comments)
      setRankLoadedPosts(cached.totalPosts)
      setRankTotalPosts(cached.totalPosts)
      setRankError(null)
      setRankLoading(false)
      return
    }

    rankLoadingRef.current = true
    const requestToken = ++rankRequestTokenRef.current
    setRankLoading(true)
    setRankError(null)
    setRankLoadedPosts(0)
    setRankTotalPosts(normalizedKnownTotal)

    try {
      const allPosts: SnsPost[] = []
      let endTime: number | undefined
      let hasMore = true

      while (hasMore) {
        const result = await window.electronAPI.sns.getTimeline(
          SNS_RANK_PAGE_SIZE,
          0,
          [normalizedUsername],
          '',
          undefined,
          endTime
        )
        if (requestToken !== rankRequestTokenRef.current) return

        if (!result.success) {
          throw new Error(result.error || '加载朋友圈排行失败')
        }

        const pagePosts = Array.isArray(result.timeline)
          ? [...(result.timeline as SnsPost[])].sort((left, right) => right.createTime - left.createTime)
          : []
        if (pagePosts.length === 0) {
          hasMore = false
          break
        }

        allPosts.push(...pagePosts)
        setRankLoadedPosts(allPosts.length)
        if (normalizedKnownTotal === null) {
          setRankTotalPosts(allPosts.length)
        }

        endTime = pagePosts[pagePosts.length - 1].createTime - 1
        hasMore = pagePosts.length >= SNS_RANK_PAGE_SIZE
      }

      if (requestToken !== rankRequestTokenRef.current) return

      const rankings = buildContactSnsRankings(allPosts)
      const totalPosts = allPosts.length
      rankCacheRef.current[normalizedUsername] = {
        likes: rankings.likes,
        comments: rankings.comments,
        totalPosts
      }
      setLikeRankings(rankings.likes)
      setCommentRankings(rankings.comments)
      setRankLoadedPosts(totalPosts)
      setRankTotalPosts(totalPosts)
      setRankError(null)
    } catch (error) {
      if (requestToken !== rankRequestTokenRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setLikeRankings([])
      setCommentRankings([])
      setRankError(message || '加载朋友圈排行失败')
    } finally {
      if (requestToken === rankRequestTokenRef.current) {
        rankLoadingRef.current = false
        setRankLoading(false)
      }
    }
  }, [timelineTotalPosts])

  useEffect(() => {
    if (!targetUsername) return

    totalPostsRequestTokenRef.current += 1
    rankRequestTokenRef.current += 1
    rankLoadingRef.current = false
    setRankMode(null)
    setLikeRankings([])
    setCommentRankings([])
    setRankLoading(false)
    setRankError(null)
    setRankLoadedPosts(0)
    setRankTotalPosts(null)
    setTimelinePosts([])
    setTimelineTotalPosts(null)
    setTimelineStatsLoading(false)
    setTimelineHasMore(false)
    setTimelineLoadingMore(false)
    setTimelineLoading(false)

    void loadTimelinePosts({
      username: targetUsername,
      displayName: targetDisplayName,
      avatarUrl: targetAvatarUrl
    }, { reset: true })
  }, [loadTimelinePosts, targetAvatarUrl, targetDisplayName, targetUsername])

  useEffect(() => {
    if (!targetUsername) return

    const normalizedTotal = normalizeTotalPosts(initialTotalPosts)
    if (normalizedTotal !== null) {
      setTimelineTotalPosts(normalizedTotal)
      setRankTotalPosts(normalizedTotal)
      setTimelineStatsLoading(false)
      return
    }

    if (initialTotalPostsLoading) {
      setTimelineTotalPosts(null)
      setRankTotalPosts(null)
      setTimelineStatsLoading(true)
      return
    }

    void loadTimelineTotalPosts({
      username: targetUsername,
      displayName: targetDisplayName,
      avatarUrl: targetAvatarUrl
    })
  }, [
    initialTotalPosts,
    initialTotalPostsLoading,
    loadTimelineTotalPosts,
    targetAvatarUrl,
    targetDisplayName,
    targetUsername
  ])

  useEffect(() => {
    if (timelineTotalPosts === null) return
    if (timelinePosts.length >= timelineTotalPosts) {
      setTimelineHasMore(false)
    }
  }, [timelinePosts.length, timelineTotalPosts])

  useEffect(() => {
    if (!rankMode || !targetUsername) return
    void loadRankings({
      username: targetUsername,
      displayName: targetDisplayName,
      avatarUrl: targetAvatarUrl
    })
  }, [loadRankings, rankMode, targetAvatarUrl, targetDisplayName, targetUsername])

  useEffect(() => {
    if (!targetUsername) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, targetUsername])

  const timelineStatsText = useMemo(() => {
    const loadedCount = timelinePosts.length
    const loadPart = timelineStatsLoading
      ? `已加载 ${loadedCount} / 总数统计中...`
      : timelineTotalPosts === null
        ? `已加载 ${loadedCount} 条`
        : `已加载 ${loadedCount} / 共 ${timelineTotalPosts} 条`

    if (timelineLoading && loadedCount === 0) return `${loadPart} ｜ 加载中...`
    if (loadedCount === 0) return loadPart

    const latest = timelinePosts[0]?.createTime
    const earliest = timelinePosts[timelinePosts.length - 1]?.createTime
    return `${loadPart} ｜ ${formatYmdDateFromSeconds(earliest)} ~ ${formatYmdDateFromSeconds(latest)}`
  }, [timelineLoading, timelinePosts, timelineStatsLoading, timelineTotalPosts])

  const activeRankings = useMemo(() => {
    if (rankMode === 'likes') return likeRankings
    if (rankMode === 'comments') return commentRankings
    return []
  }, [commentRankings, likeRankings, rankMode])

  const loadMore = useCallback(() => {
    if (!targetUsername || timelineLoading || timelineLoadingMore || !timelineHasMore) return
    void loadTimelinePosts({
      username: targetUsername,
      displayName: targetDisplayName,
      avatarUrl: targetAvatarUrl
    }, { reset: false })
  }, [
    loadTimelinePosts,
    targetAvatarUrl,
    targetDisplayName,
    targetUsername,
    timelineHasMore,
    timelineLoading,
    timelineLoadingMore
  ])

  const handleBodyScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    if (remaining <= 160) {
      loadMore()
    }
  }, [loadMore])

  const toggleRankMode = useCallback((mode: ContactSnsRankMode) => {
    setRankMode((previous) => (previous === mode ? null : mode))
  }, [])

  if (!target) return null

  return createPortal(
    <div className="contact-sns-dialog-overlay" onClick={onClose}>
      <div
        className="contact-sns-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="联系人朋友圈"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="contact-sns-dialog-header">
          <div className="contact-sns-dialog-header-main">
            <div className="contact-sns-dialog-avatar">
              {targetAvatarUrl ? (
                <img src={targetAvatarUrl} alt="" />
              ) : (
                <span>{getAvatarLetter(targetDisplayName)}</span>
              )}
            </div>
            <div className="contact-sns-dialog-meta">
              <h4>{targetDisplayName}</h4>
              <div className="contact-sns-dialog-username">@{targetUsername}</div>
              <div className="contact-sns-dialog-stats">{timelineStatsText}</div>
            </div>
          </div>
          <div className="contact-sns-dialog-header-actions">
            <div className="contact-sns-dialog-rank-switch">
              <button
                type="button"
                className={`contact-sns-dialog-rank-btn ${rankMode === 'likes' ? 'active' : ''}`}
                onClick={() => toggleRankMode('likes')}
              >
                点赞排行
              </button>
              <button
                type="button"
                className={`contact-sns-dialog-rank-btn ${rankMode === 'comments' ? 'active' : ''}`}
                onClick={() => toggleRankMode('comments')}
              >
                评论排行
              </button>
              {rankMode && (
                <div
                  className="contact-sns-dialog-rank-panel"
                  role="region"
                  aria-label={rankMode === 'likes' ? '点赞排行' : '评论排行'}
                >
                  {rankLoading && (
                    <div className="contact-sns-dialog-rank-loading">
                      <Loader2 size={12} className="spin" />
                      <span>
                        {rankTotalPosts !== null && rankTotalPosts > 0
                          ? `统计中，已加载 ${rankLoadedPosts} / ${rankTotalPosts} 条`
                          : `统计中，已加载 ${rankLoadedPosts} 条`}
                      </span>
                    </div>
                  )}
                  {!rankLoading && rankError ? (
                    <div className="contact-sns-dialog-rank-empty">{rankError}</div>
                  ) : !rankLoading && activeRankings.length === 0 ? (
                    <div className="contact-sns-dialog-rank-empty">
                      {rankMode === 'likes' ? '暂无点赞数据' : '暂无评论数据'}
                    </div>
                  ) : (
                    activeRankings.slice(0, SNS_RANK_DISPLAY_LIMIT).map((item, index) => (
                      <div className="contact-sns-dialog-rank-row" key={`${rankMode}-${item.name}`}>
                        <span className="contact-sns-dialog-rank-index">{index + 1}</span>
                        <span className="contact-sns-dialog-rank-name" title={item.name}>{item.name}</span>
                        <span className="contact-sns-dialog-rank-count">
                          {item.count.toLocaleString('zh-CN')}
                          {rankMode === 'likes' ? '次' : '条'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <button className="contact-sns-dialog-close-btn" type="button" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div
          className="contact-sns-dialog-body"
          onScroll={handleBodyScroll}
        >
          {timelinePosts.length > 0 && (
            <div className="contact-sns-dialog-posts-list">
              {timelinePosts.map((post) => (
                <SnsPostItem
                  key={post.id}
                  post={{ ...post, isProtected }}
                  onPreview={(src, isVideo, liveVideoPath) => {
                    if (isVideo) {
                      void window.electronAPI.window.openVideoPlayerWindow(src)
                    } else {
                      void window.electronAPI.window.openImageViewerWindow(src, liveVideoPath || undefined)
                    }
                  }}
                  onDebug={() => {}}
                  onDelete={onDeletePost}
                  hideAuthorMeta
                />
              ))}
            </div>
          )}

          {timelineLoading && (
            <div className="contact-sns-dialog-status">正在加载该联系人的朋友圈...</div>
          )}

          {!timelineLoading && timelinePosts.length === 0 && (
            <div className="contact-sns-dialog-status empty">该联系人暂无朋友圈</div>
          )}

          {!timelineLoading && timelineHasMore && (
            <button
              className="contact-sns-dialog-load-more"
              type="button"
              onClick={loadMore}
              disabled={timelineLoadingMore}
            >
              {timelineLoadingMore ? '正在加载...' : '加载更多'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
