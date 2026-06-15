import React, { useState, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Heart, ChevronRight, ImageIcon, Code, Trash2, MapPin } from 'lucide-react'
import { SnsPost, SnsLinkCardData, SnsLocation } from '../../types/sns'
import { Avatar } from '../Avatar'
import { SnsMediaGrid } from './SnsMediaGrid'
import { getEmojiPath } from 'wechat-emojis'

// Helper functions (extracted from SnsPage.tsx but simplified/reused)
const LINK_XML_URL_TAGS = ['url', 'shorturl', 'weburl', 'webpageurl', 'jumpurl']
const LINK_XML_DIRECT_URL_TAGS = ['contentUrl', ...LINK_XML_URL_TAGS]
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

const normalizeRawXmlForParsing = (xml: string): string => {
    if (!xml) return ''
    return decodeHtmlEntities(xml)
        .replace(/\\+"/g, '"')
        .replace(/\\+'/g, "'")
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
    const normalizedXml = normalizeRawXmlForParsing(xml)
    if (!normalizedXml) return []
    const results: string[] = []
    for (const tag of tags) {
        const reg = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'ig')
        let match: RegExpExecArray | null
        while ((match = reg.exec(normalizedXml)) !== null) {
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

const normalizeSnsAssetUrl = (url: string, token?: string, encIdx?: string): string => {
    const base = decodeHtmlEntities(url).trim()
    if (!base) return ''

    let fixed = base.replace(/^http:\/\//i, 'https://')

    const normalizedToken = decodeHtmlEntities(String(token || '')).trim()
    const normalizedEncIdx = decodeHtmlEntities(String(encIdx || '')).trim()
    const effectiveIdx = normalizedEncIdx || (normalizedToken ? '1' : '')
    const appendParams: string[] = []
    if (normalizedToken && !/[?&]token=/i.test(fixed)) {
        appendParams.push(`token=${normalizedToken}`)
    }
    if (effectiveIdx && !/[?&]idx=/i.test(fixed)) {
        appendParams.push(`idx=${effectiveIdx}`)
    }
    if (appendParams.length > 0) {
        const connector = fixed.includes('?') ? '&' : '?'
        fixed = `${fixed}${connector}${appendParams.join('&')}`
    }
    return fixed
}

const extractCardThumbMetaFromXml = (xml: string): { thumb?: string; thumbKey?: string } => {
    const normalizedXml = normalizeRawXmlForParsing(xml)
    if (!normalizedXml) return {}
    const mediaMatch = normalizedXml.match(/<media>([\s\S]*?)<\/media>/i)
    if (!mediaMatch?.[1]) return {}

    const mediaXml = mediaMatch[1]
    const thumbMatch = mediaXml.match(/<thumb([^>]*)>([^<]+)<\/thumb>/i)
    if (!thumbMatch) return {}

    const attrs = thumbMatch[1] || ''
    const getAttr = (name: string): string | undefined => {
        const reg = new RegExp(`${name}\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s>]+))`, 'i')
        const m = attrs.match(reg)
        return decodeHtmlEntities((m?.[1] || m?.[2] || m?.[3] || '').trim()) || undefined
    }
    const thumbRawUrl = thumbMatch[2] || ''
    const thumbToken = getAttr('token')
    const thumbKey = getAttr('key')
    const thumbEncIdx = getAttr('enc_idx')
    const thumb = normalizeSnsAssetUrl(thumbRawUrl, thumbToken, thumbEncIdx)

    return {
        thumb: thumb || undefined,
        thumbKey: thumbKey ? decodeHtmlEntities(thumbKey).trim() : undefined
    }
}

const pickCardTitle = (post: SnsPost): string => {
    const titleCandidates = [
        post.linkTitle || '',
        ...getXmlTagValues(post.rawXml || '', LINK_XML_TITLE_TAGS),
        post.contentDesc || ''
    ]
    return titleCandidates
        .map((value) => decodeHtmlEntities(value))
        .find((value) => Boolean(value) && !/^https?:\/\//i.test(value)) || '网页链接'
}

const buildLinkCardData = (post: SnsPost): SnsLinkCardData | null => {
    // type 3 / 5 是链接卡片类型，优先按卡片链接解析
    if (post.type === 3 || post.type === 5) {
        const thumbMeta = extractCardThumbMetaFromXml(post.rawXml || '')
        const directUrlCandidates = [
            post.linkUrl || '',
            ...getXmlTagValues(post.rawXml || '', LINK_XML_DIRECT_URL_TAGS),
            ...post.media.map((item) => item.url || '')
        ]
        const url = directUrlCandidates
            .map(normalizeUrlCandidate)
            .find((value): value is string => Boolean(value))
        if (!url) return null
        return {
            url,
            title: pickCardTitle(post),
            thumb: thumbMeta.thumb || post.media[0]?.thumb || post.media[0]?.url,
            thumbKey: thumbMeta.thumbKey || post.media[0]?.key
        }
    }

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

    return {
        url: linkUrl,
        title: pickCardTitle(post),
        thumb: post.media[0]?.thumb || post.media[0]?.url
    }
}

const buildLocationText = (location?: SnsLocation): string => {
    if (!location) return ''

    const normalize = (value?: string): string => (
        decodeHtmlEntities(String(value || '')).replace(/\s+/g, ' ').trim()
    )

    const primary = [
        normalize(location.poiName),
        normalize(location.poiAddressName),
        normalize(location.label),
        normalize(location.poiAddress)
    ].find(Boolean) || ''

    const region = [normalize(location.country), normalize(location.city)]
        .filter(Boolean)
        .join(' ')

    if (primary && region && !primary.includes(region)) {
        return `${primary} · ${region}`
    }
    return primary || region
}

const SnsLinkCard = ({ card, thumbKey }: { card: SnsLinkCardData; thumbKey?: string }) => {
    const [thumbFailed, setThumbFailed] = useState(false)
    const [thumbSrc, setThumbSrc] = useState(card.thumb || '')
    const [reloadNonce, setReloadNonce] = useState(0)
    const retryCountRef = useRef(0)
    const hostname = useMemo(() => {
        try {
            return new URL(card.url).hostname.replace(/^www\./i, '')
        } catch {
            return card.url
        }
    }, [card.url])

    useEffect(() => {
        retryCountRef.current = 0
    }, [card.thumb, thumbKey])

    const scheduleRetry = () => {
        if (retryCountRef.current >= 2) return
        retryCountRef.current += 1
        window.setTimeout(() => {
            setReloadNonce((v) => v + 1)
        }, 900)
    }

    useEffect(() => {
        const rawThumb = card.thumb || ''
        setThumbFailed(false)
        setThumbSrc(rawThumb)
        if (!rawThumb) return

        let cancelled = false
        const loadThumb = async () => {
            try {
                const result = await window.electronAPI.sns.proxyImage({
                    url: rawThumb,
                    key: thumbKey
                })
                if (cancelled) return
                if (!result.success) {
                    console.warn('[SnsLinkCard] thumb decrypt failed', {
                        url: rawThumb,
                        key: thumbKey,
                        error: result.error
                    })
                    scheduleRetry()
                    return
                }
                if (result.dataUrl) {
                    setThumbSrc(result.dataUrl)
                    return
                }
                if (result.videoPath) {
                    setThumbSrc(`file://${result.videoPath.replace(/\\/g, '/')}`)
                }
            } catch {
                // noop: keep raw thumb fallback
                scheduleRetry()
            }
        }

        loadThumb()
        return () => { cancelled = true }
    }, [card.thumb, thumbKey, reloadNonce])

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
                {thumbSrc && !thumbFailed ? (
                    <img
                        src={thumbSrc}
                        alt=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        onError={() => {
                            const rawThumb = card.thumb || ''
                            if (thumbSrc !== rawThumb && rawThumb) {
                                console.warn('[SnsLinkCard] thumb render failed, fallback raw thumb', {
                                    failedSrc: thumbSrc,
                                    rawThumb,
                                    key: thumbKey
                                })
                                setThumbSrc(rawThumb)
                                return
                            }
                            console.warn('[SnsLinkCard] thumb render failed, fallback exhausted', {
                                failedSrc: thumbSrc,
                                rawThumb,
                                key: thumbKey
                            })
                            setThumbFailed(true)
                            scheduleRetry()
                        }}
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

// 表情包内存缓存
const emojiLocalCache = new Map<string, string>()

// 评论表情包组件
const CommentEmoji: React.FC<{
    emoji: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }
    onPreview?: (src: string) => void
}> = ({ emoji, onPreview }) => {
    const cacheKey = emoji.encryptUrl || emoji.url
    const [localSrc, setLocalSrc] = useState<string>(() => emojiLocalCache.get(cacheKey) || '')

    useEffect(() => {
        if (!cacheKey) return
        if (emojiLocalCache.has(cacheKey)) {
            setLocalSrc(emojiLocalCache.get(cacheKey)!)
            return
        }
        let cancelled = false
        const load = async () => {
            try {
                const res = await window.electronAPI.sns.downloadEmoji({
                    url: emoji.url,
                    encryptUrl: emoji.encryptUrl,
                    aesKey: emoji.aesKey
                })
                if (cancelled) return
                if (res.success && res.localPath) {
                    const fileUrl = res.localPath.startsWith('file:')
                        ? res.localPath
                        : `file://${res.localPath.replace(/\\/g, '/')}`
                    emojiLocalCache.set(cacheKey, fileUrl)
                    setLocalSrc(fileUrl)
                }
            } catch { /* 静默失败 */ }
        }
        load()
        return () => { cancelled = true }
    }, [cacheKey])

    if (!localSrc) return null

    return (
        <img
            src={localSrc}
            alt="emoji"
            className="comment-custom-emoji"
            draggable={false}
            onClick={(e) => { e.stopPropagation(); onPreview?.(localSrc) }}
            style={{
                width: Math.min(emoji.width || 24, 30),
                height: Math.min(emoji.height || 24, 30),
                verticalAlign: 'middle',
                marginLeft: 2,
                borderRadius: 4,
                cursor: onPreview ? 'pointer' : 'default'
            }}
        />
    )
}

interface SnsPostItemProps {
    post: SnsPost
    onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string) => void
    onDebug: (post: SnsPost) => void
    onDelete?: (postId: string, username: string) => void
    onOpenAuthorPosts?: (post: SnsPost) => void
    hideAuthorMeta?: boolean
}

export const SnsPostItem: React.FC<SnsPostItemProps> = ({ post, onPreview, onDebug, onDelete, onOpenAuthorPosts, hideAuthorMeta = false }) => {
    const [mediaDeleted, setMediaDeleted] = useState(false)
    const [dbDeleted, setDbDeleted] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
    const linkCard = buildLinkCardData(post)
    const linkCardThumbKey = linkCard?.thumbKey || post.media[0]?.key
    const locationText = useMemo(() => buildLocationText(post.location), [post.location])
    const hasVideoMedia = post.type === 15 || post.media.some((item) => isSnsVideoUrl(item.url))
    const isLinkCardType = post.type === 3 || post.type === 5
    const showLinkCard = Boolean(linkCard) && !hasVideoMedia && (isLinkCardType || post.media.length <= 1)
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

    // 解析微信表情
    const renderTextWithEmoji = (text: string) => {
        if (!text) return text
        const parts = text.split(/\[(.*?)\]/g)
        return parts.map((part, index) => {
            if (index % 2 === 1) {
                // @ts-ignore
                const path = getEmojiPath(part as any)
                if (path) {
                    return <img key={index} src={`${import.meta.env.BASE_URL}${path}`} alt={`[${part}]`} className="inline-emoji" style={{ width: 22, height: 22, verticalAlign: 'bottom', margin: '0 1px' }} />
                }
                return `[${part}]`
            }
            return part
        })
    }

    const handleDeleteClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (deleting || dbDeleted) return
        setShowDeleteConfirm(true)
    }

    const handleDeleteConfirm = async () => {
        setShowDeleteConfirm(false)
        setDeleting(true)
        try {
            const r = await window.electronAPI.sns.deleteSnsPost(post.tid ?? post.id)
            if (r.success) {
                setDbDeleted(true)
                onDelete?.(post.id, post.username)
            }
        } finally {
            setDeleting(false)
        }
    }

    const handleOpenAuthorPosts = (e: React.MouseEvent) => {
        e.stopPropagation()
        onOpenAuthorPosts?.(post)
    }

    return (
        <>
        <div className={`sns-post-item ${(mediaDeleted || dbDeleted) ? 'post-deleted' : ''}`}>
            {!hideAuthorMeta && (
                <div className="post-avatar-col">
                    <button
                        type="button"
                        className="author-trigger-btn avatar-trigger"
                        onClick={handleOpenAuthorPosts}
                        title="查看该发布者的全部朋友圈"
                    >
                        <Avatar
                            src={post.avatarUrl}
                            name={post.nickname}
                            size={36}
                            shape="rounded"
                        />
                    </button>
                </div>
            )}

            <div className="post-content-col">
                <div className="post-header-row">
                    {hideAuthorMeta ? (
                        <span className="post-time post-time-standalone">{formatTime(post.createTime)}</span>
                    ) : (
                        <div className="post-author-info">
                            <button
                                type="button"
                                className="author-trigger-btn author-name-trigger"
                                onClick={handleOpenAuthorPosts}
                                title="查看该发布者的全部朋友圈"
                            >
                                <span className="author-name">{decodeHtmlEntities(post.nickname)}</span>
                            </button>
                            <span className="post-time">{formatTime(post.createTime)}</span>
                        </div>
                    )}
                    <div className="post-header-actions">
                        {(mediaDeleted || dbDeleted) && (
                            <span className="post-deleted-badge">
                                <Trash2 size={12} />
                                <span>已删除</span>
                            </span>
                        )}
                        <button
                            className="icon-btn-ghost debug-btn delete-btn"
                            onClick={handleDeleteClick}
                            disabled={deleting || dbDeleted}
                            title="从数据库删除此条记录"
                        >
                            <Trash2 size={14} />
                        </button>
                        <button className="icon-btn-ghost debug-btn" onClick={(e) => {
                            e.stopPropagation();
                            onDebug(post);
                        }} title="查看原始数据">
                            <Code size={14} />
                        </button>
                    </div>
                </div>

                {post.contentDesc && (
                    <div className="post-text">{renderTextWithEmoji(decodeHtmlEntities(post.contentDesc))}</div>
                )}

                {locationText && (
                    <div className="post-location" title={locationText}>
                        <MapPin size={14} />
                        <span className="post-location-text">{locationText}</span>
                    </div>
                )}

                {showLinkCard && linkCard && (
                    <SnsLinkCard card={linkCard} thumbKey={linkCardThumbKey} />
                )}

                {showMediaGrid && (
                    <div className="post-media-container">
                        <SnsMediaGrid mediaList={post.media} postType={post.type} onPreview={onPreview} onMediaDeleted={[1, 54].includes(post.type ?? 0) ? () => setMediaDeleted(true) : undefined} />
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
                                        {c.content && (
                                            <span className="comment-content">{renderTextWithEmoji(c.content)}</span>
                                        )}
                                        {c.emojis && c.emojis.map((emoji, ei) => (
                                            <CommentEmoji
                                                key={ei}
                                                emoji={emoji}
                                                onPreview={(src) => onPreview(src)}
                                            />
                                        ))}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>

        {/* 删除确认弹窗 - 用 Portal 挂到 body，避免父级 transform 影响 fixed 定位 */}
        {showDeleteConfirm && createPortal(
            <div className="sns-confirm-overlay" onClick={() => setShowDeleteConfirm(false)}>
                <div className="sns-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                    <div className="sns-confirm-icon">
                        <Trash2 size={22} />
                    </div>
                    <div className="sns-confirm-title">删除这条记录？</div>
                    <div className="sns-confirm-desc">将从本地数据库中永久删除，无法恢复。</div>
                    <div className="sns-confirm-actions">
                        <button className="sns-confirm-cancel" onClick={() => setShowDeleteConfirm(false)}>取消</button>
                        <button className="sns-confirm-ok" onClick={handleDeleteConfirm}>删除</button>
                    </div>
                </div>
            </div>,
            document.body
        )}
        </>
    )
}
