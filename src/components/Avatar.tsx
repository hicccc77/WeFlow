import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Loader2, User } from 'lucide-react'
import { avatarLoadQueue } from '../utils/AvatarLoadQueue'
import './Avatar.scss'

// 全局缓存已成功加载过的头像 URL，用于控制后续是否显示动画
const loadedAvatarCache = new Set<string>()
const MAX_LOADED_AVATAR_CACHE_SIZE = 3000

const rememberLoadedAvatar = (src: string): void => {
    if (!src) return
    if (loadedAvatarCache.has(src)) {
        loadedAvatarCache.delete(src)
    }
    loadedAvatarCache.add(src)

    while (loadedAvatarCache.size > MAX_LOADED_AVATAR_CACHE_SIZE) {
        const oldest = loadedAvatarCache.values().next().value as string | undefined
        if (!oldest) break
        loadedAvatarCache.delete(oldest)
    }
}

interface AvatarProps {
    src?: string
    name?: string
    size?: number | string
    shape?: 'circle' | 'square' | 'rounded'
    className?: string
    lazy?: boolean
    loading?: boolean
    onClick?: () => void
}

export const Avatar = React.memo(function Avatar({
    src,
    name,
    size = 48,
    shape = 'rounded',
    className = '',
    lazy = true,
    loading = false,
    onClick
}: AvatarProps) {
    // 如果 URL 已在缓存中，则直接标记为已加载，不显示骨架屏和淡入动画
    const isCached = useMemo(() => src ? loadedAvatarCache.has(src) : false, [src])
    const isFailed = useMemo(() => src ? avatarLoadQueue.hasFailed(src) : false, [src])
    const [imageLoaded, setImageLoaded] = useState(isCached)
    const [imageError, setImageError] = useState(isFailed)
    const [shouldLoad, setShouldLoad] = useState(!lazy || isCached)
    const [isInQueue, setIsInQueue] = useState(false)
    const imgRef = useRef<HTMLImageElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const getAvatarLetter = (): string => {
        if (!name) return '?'
        const chars = [...name]
        return chars[0] || '?'
    }

    // Intersection Observer for lazy loading
    useEffect(() => {
        if (!lazy || shouldLoad || isInQueue || !src || !containerRef.current || isCached || imageError || isFailed) return

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !isInQueue) {
                        setIsInQueue(true)
                        avatarLoadQueue.enqueue(src).then(() => {
                            setImageError(false)
                            setShouldLoad(true)
                        }).catch(() => {
                            setImageError(true)
                            setShouldLoad(false)
                        }).finally(() => {
                            setIsInQueue(false)
                        })
                        observer.disconnect()
                    }
                })
            },
            { rootMargin: '100px' }
        )

        observer.observe(containerRef.current)

        return () => observer.disconnect()
    }, [src, lazy, shouldLoad, isInQueue, isCached, imageError, isFailed])

    // Reset state when src changes
    useEffect(() => {
        const cached = src ? loadedAvatarCache.has(src) : false
        const failed = src ? avatarLoadQueue.hasFailed(src) : false
        setImageLoaded(cached)
        setImageError(failed)
        if (failed) {
            setShouldLoad(false)
            setIsInQueue(false)
        } else if (lazy && !cached) {
            setShouldLoad(false)
            setIsInQueue(false)
        } else {
            setShouldLoad(true)
        }
    }, [src, lazy])

    // Check if image is already cached/loaded
    useEffect(() => {
        if (shouldLoad && imgRef.current?.complete && imgRef.current?.naturalWidth > 0) {
            setImageLoaded(true)
        }
    }, [src, shouldLoad])

    const style = {
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
    }

    const hasValidUrl = !!src && !imageError && shouldLoad
    const shouldShowLoadingPlaceholder = loading && !hasValidUrl && !imageError

    return (
        <div
            ref={containerRef}
            className={`avatar-component ${shape} ${className}`}
            style={style}
            onClick={onClick}
        >
            {hasValidUrl ? (
                <>
                    {!imageLoaded && <div className="avatar-skeleton" />}
                    <img
                        ref={imgRef}
                        src={src}
                        alt={name || 'avatar'}
                        className={`avatar-image ${imageLoaded ? 'loaded' : ''} ${isCached ? 'instant' : ''}`}
                        onLoad={() => {
                            if (src) {
                                avatarLoadQueue.clearFailed(src)
                                rememberLoadedAvatar(src)
                            }
                            setImageLoaded(true)
                            setImageError(false)
                        }}
                        onError={() => {
                            if (src) {
                                avatarLoadQueue.markFailed(src)
                                loadedAvatarCache.delete(src)
                            }
                            setImageLoaded(false)
                            setImageError(true)
                            setShouldLoad(false)
                        }}
                        loading={lazy ? "lazy" : "eager"}
                        referrerPolicy="no-referrer"
                    />
                </>
            ) : shouldShowLoadingPlaceholder ? (
                <div className="avatar-loading">
                    <Loader2 size="50%" className="avatar-loading-icon" />
                </div>
            ) : (
                <div className="avatar-placeholder">
                    {name ? <span className="avatar-letter">{getAvatarLetter()}</span> : <User size="50%" />}
                </div>
            )}
        </div>
    )
})
