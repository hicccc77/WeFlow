import React, { useState, useMemo } from 'react'
import { Heart, ChevronRight, ImageIcon, Download, Code, MoreHorizontal } from 'lucide-react'
import { SnsPost, SnsLinkCardData } from '../../types/sns'
import { Avatar } from '../Avatar'
import { SnsMediaGrid } from './SnsMediaGrid'

// Helper functions (extracted from SnsPage.tsx but simplified/reused)
const LINK_XML_URL_TAGS = ['url', 'shorturl', 'weburl', 'webpageurl', 'jumpurl']
const LINK_XML_TITLE_TAGS = ['title', 'linktitle', 'webtitle']
const MEDIA_HOST_HINTS = ['mmsns.qpic.cn', 'vweixinthumb', 'snstimeline', 'snsvideodownload']

const isSnsVideoUrl = (url?: string): boolean => {
    if (!url) return false
    const lower = url.toLowerCase()
    return (lower.includes('snsvideodownload') || lower.includes('.mp4') || lower.includes('video')) && !lower.includes('vweixinthumb')
}

const decodeHtmlEntities = (text: string): string => {
    if (!text) return ''
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .trim()
}

const normalizeUrlCandidate = (raw: string): string | null => {
    const value = decodeHtmlEntities(raw).replace(/[)\],.;]+$/, '').trim()
    if (!value) return null
    if (!/^https?:\/\//i.test(value)) return null
    return value
}

const simplifyUrlForCompare = (value: string): string => {
    const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, '')
    const [withoutQuery] = normalized.split('?')
    return withoutQuery.replace(/\/+$/, '')
}

const getXmlTagValues = (xml: string, tags: string[]): string[] => {
    if (!xml) return []
    const results: string[] = []
    for (const tag of tags) {
        const reg = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'ig')
        let match: RegExpExecArray | null
        while ((match = reg.exec(xml)) !== null) {
            if (match[1]) results.push(match[1])
        }
    }
    return results
}

const getUrlLikeStrings = (text: string): string[] => {
    if (!text) return []
    return text.match(/https?:\/\/[^\s<>"']+/gi) || []
}

const isLikelyMediaAssetUrl = (url: string): boolean => {
    const lower = url.toLowerCase()
    return MEDIA_HOST_HINTS.some((hint) => lower.includes(hint))
}

const buildLinkCardData = (post: SnsPost): SnsLinkCardData | null => {
    const hasVideoMedia = post.type === 15 || post.media.some((item) => isSnsVideoUrl(item.url))
    if (hasVideoMedia) return null

    const mediaValues = post.media
        .flatMap((item) => [item.url, item.thumb])
        .filter((value): value is string => Boolean(value))
    const mediaSet = new Set(mediaValues.map((value) => simplifyUrlForCompare(value)))

    const urlCandidates: string[] = [
        post.linkUrl || '',
        ...getXmlTagValues(post.rawXml || '', LINK_XML_URL_TAGS),
        ...getUrlLikeStrings(post.rawXml || ''),
        ...getUrlLikeStrings(post.contentDesc || '')
    ]

    const normalizedCandidates = urlCandidates
        .map(normalizeUrlCandidate)
        .filter((value): value is string => Boolean(value))

    const dedupedCandidates: string[] = []
    const seen = new Set<string>()
    for (const candidate of normalizedCandidates) {
        if (seen.has(candidate)) continue
        seen.add(candidate)
        dedupedCandidates.push(candidate)
    }

    const linkUrl = dedupedCandidates.find((candidate) => {
        const simplified = simplifyUrlForCompare(candidate)
        if (mediaSet.has(simplified)) return false
        if (isLikelyMediaAssetUrl(candidate)) return false
        return true
    })

    if (!linkUrl) return null

    const titleCandidates = [
        post.linkTitle || '',
        ...getXmlTagValues(post.rawXml || '', LINK_XML_TITLE_TAGS),
        post.contentDesc || ''
    ]

    const title = titleCandidates
        .map((value) => decodeHtmlEntities(value))
        .find((value) => Boolean(value) && !/^https?:\/\//i.test(value))

    return {
        url: linkUrl,
        title: title || '网页链接',
        thumb: post.media[0]?.thumb || post.media[0]?.url
    }
}

const SnsLinkCard = ({ card }: { card: SnsLinkCardData }) => {
    const [thumbFailed, setThumbFailed] = useState(false)
    const hostname = useMemo(() => {
        try {
            return new URL(card.url).hostname.replace(/^www\./i, '')
        } catch {
            return card.url
        }
    }, [card.url])

    const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        try {
            await window.electronAPI.shell.openExternal(card.url)
        } catch (error) {
            console.error('[SnsLinkCard] openExternal failed:', error)
        }
    }

    return (
        <button type="button" className="post-link-card" onClick={handleClick}>
            <div className="link-thumb">
                {card.thumb && !thumbFailed ? (
                    <img
                        src={card.thumb}
                        alt=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        onError={() => setThumbFailed(true)}
                    />
                ) : (
                    <div className="link-thumb-fallback">
                        <ImageIcon size={18} />
                    </div>
                )}
            </div>
            <div className="link-meta">
                <div className="link-title">{card.title}</div>
                <div className="link-url">{hostname}</div>
            </div>
            <ChevronRight size={16} className="link-arrow" />
        </button>
    )
}

interface SnsPostItemProps {
    post: SnsPost
    onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string) => void
    onDebug: (post: SnsPost) => void
}

export const SnsPostItem: React.FC<SnsPostItemProps> = ({ post, onPreview, onDebug }) => {
    const linkCard = buildLinkCardData(post)
    const hasVideoMedia = post.type === 15 || post.media.some((item) => isSnsVideoUrl(item.url))
    const showLinkCard = Boolean(linkCard) && post.media.length <= 1 && !hasVideoMedia
    const showMediaGrid = post.media.length > 0 && !showLinkCard

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

    // Add extra class for media-only posts (no text) to adjust spacing?
    // Not strictly needed but good to know

    return (
        <div className="sns-post-item">
            <div className="post-avatar-col">
                <Avatar
                    src={post.avatarUrl}
                    name={post.nickname}
                    size={48}
                    shape="rounded"
                />
            </div>

            <div className="post-content-col">
                <div className="post-header-row">
                    <div className="post-author-info">
                        <span className="author-name">{decodeHtmlEntities(post.nickname)}</span>
                        <span className="post-time">{formatTime(post.createTime)}</span>
                    </div>
                    <button className="icon-btn-ghost debug-btn" onClick={(e) => {
                        e.stopPropagation();
                        onDebug(post);
                    }} title="查看原始数据">
                        <Code size={14} />
                    </button>
                </div>

                {post.contentDesc && (
                    <div className="post-text">{decodeHtmlEntities(post.contentDesc)}</div>
                )}

                {showLinkCard && linkCard && (
                    <SnsLinkCard card={linkCard} />
                )}

                {showMediaGrid && (
                    <div className="post-media-container">
                        <SnsMediaGrid mediaList={post.media} onPreview={onPreview} />
                    </div>
                )}

                {(post.likes.length > 0 || post.comments.length > 0) && (
                    <div className="post-interactions">
                        {post.likes.length > 0 && (
                            <div className="likes-block">
                                <Heart size={14} className="like-icon" />
                                <span className="likes-text">{post.likes.join('、')}</span>
                            </div>
                        )}

                        {post.comments.length > 0 && (
                            <div className="comments-block">
                                {post.comments.map((c, idx) => (
                                    <div key={idx} className="comment-row">
                                        <span className="comment-user">{c.nickname}</span>
                                        {c.refNickname && (
                                            <>
                                                <span className="reply-text">回复</span>
                                                <span className="comment-user">{c.refNickname}</span>
                                            </>
                                        )}
                                        <span className="comment-colon">：</span>
                                        <span className="comment-content">{c.content}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
