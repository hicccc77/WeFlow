import React, { useState } from 'react'
import { Play, Lock, Download } from 'lucide-react'
import { LivePhotoIcon } from '../../components/LivePhotoIcon'
import { RefreshCw } from 'lucide-react'

interface SnsMedia {
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
}

interface SnsMediaGridProps {
    mediaList: SnsMedia[]
    onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string) => void
}

const isSnsVideoUrl = (url?: string): boolean => {
    if (!url) return false
    const lower = url.toLowerCase()
    return (lower.includes('snsvideodownload') || lower.includes('.mp4') || lower.includes('video')) && !lower.includes('vweixinthumb')
}

const extractVideoFrame = async (videoPath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video')
        video.preload = 'auto'
        video.src = videoPath
        video.muted = true
        video.currentTime = 0 // Initial reset
        // video.crossOrigin = 'anonymous' // Not needed for file:// usually

        const onSeeked = () => {
            try {
                const canvas = document.createElement('canvas')
                canvas.width = video.videoWidth
                canvas.height = video.videoHeight
                const ctx = canvas.getContext('2d')
                if (ctx) {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
                    resolve(dataUrl)
                } else {
                    reject(new Error('Canvas context failed'))
                }
            } catch (e) {
                reject(e)
            } finally {
                // Cleanup
                video.removeEventListener('seeked', onSeeked)
                video.src = ''
                video.load()
            }
        }

        video.onloadedmetadata = () => {
            if (video.duration === Infinity || isNaN(video.duration)) {
                // Determine duration failed, try a fixed small offset
                video.currentTime = 1
            } else {
                video.currentTime = Math.max(0.1, video.duration / 2)
            }
        }

        video.onseeked = onSeeked

        video.onerror = (e) => {
            reject(new Error('Video load failed'))
        }
    })
}

const MediaItem = ({ media, onPreview }: { media: SnsMedia; onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string) => void }) => {
    const [error, setError] = useState(false)
    const [loading, setLoading] = useState(true)
    const [thumbSrc, setThumbSrc] = useState<string>('')
    const [videoPath, setVideoPath] = useState<string>('')
    const [liveVideoPath, setLiveVideoPath] = useState<string>('')
    const [isDecrypting, setIsDecrypting] = useState(false)
    const [isGeneratingCover, setIsGeneratingCover] = useState(false)

    const isVideo = isSnsVideoUrl(media.url)
    const isLive = !!media.livePhoto
    const targetUrl = media.thumb || media.url

    // Simple effect to load image/decrypt
    // Simple effect to load image/decrypt
    React.useEffect(() => {
        let cancelled = false
        setLoading(true)

        const load = async () => {
            try {
                if (!isVideo) {
                    // For images, we proxy to get the local path/base64
                    const result = await window.electronAPI.sns.proxyImage({
                        url: targetUrl,
                        key: media.key
                    })
                    if (cancelled) return

                    if (result.success) {
                        if (result.dataUrl) setThumbSrc(result.dataUrl)
                        else if (result.videoPath) setThumbSrc(`file://${result.videoPath.replace(/\\/g, '/')}`)
                    } else {
                        setThumbSrc(targetUrl)
                    }

                    // Pre-load live photo video if needed
                    if (isLive && media.livePhoto?.url) {
                        window.electronAPI.sns.proxyImage({
                            url: media.livePhoto.url,
                            key: media.livePhoto.key || media.key
                        }).then((res: any) => {
                            if (!cancelled && res.success && res.videoPath) {
                                setLiveVideoPath(`file://${res.videoPath.replace(/\\/g, '/')}`)
                            }
                        }).catch(() => { })
                    }
                    setLoading(false)
                } else {
                    // Video logic: Decrypt -> Extract Frame
                    setIsGeneratingCover(true)

                    // First check if we already have it decryptable? 
                    // Usually we need to call proxyImage with the video URL to decrypt it to cache
                    const result = await window.electronAPI.sns.proxyImage({
                        url: media.url,
                        key: media.key
                    })

                    if (cancelled) return

                    if (result.success && result.videoPath) {
                        const localPath = `file://${result.videoPath.replace(/\\/g, '/')}`
                        setVideoPath(localPath)

                        try {
                            const coverDataUrl = await extractVideoFrame(localPath)
                            if (!cancelled) setThumbSrc(coverDataUrl)
                        } catch (err) {
                            console.error('Frame extraction failed', err)
                            // Fallback to video path if extraction fails, though it might be black
                            // Only set thumbSrc if extraction fails, so we don't override the generated one
                        }
                    } else {
                        console.error('Video decryption for cover failed')
                    }

                    setIsGeneratingCover(false)
                    setLoading(false)
                }
            } catch (e) {
                console.error(e)
                if (!cancelled) {
                    setThumbSrc(targetUrl)
                    setLoading(false)
                    setIsGeneratingCover(false)
                }
            }
        }

        load()
        return () => { cancelled = true }
    }, [media, isVideo, isLive, targetUrl])

    const handlePreview = async (e: React.MouseEvent) => {
        e.stopPropagation()
        if (isVideo) {
            // Decrypt video on demand if not already
            if (!videoPath) {
                setIsDecrypting(true)
                try {
                    const res = await window.electronAPI.sns.proxyImage({
                        url: media.url,
                        key: media.key
                    })
                    if (res.success && res.videoPath) {
                        const local = `file://${res.videoPath.replace(/\\/g, '/')}`
                        setVideoPath(local)
                        onPreview(local, true, undefined)
                    } else {
                        alert('视频解密失败')
                    }
                } catch (e) {
                    console.error(e)
                } finally {
                    setIsDecrypting(false)
                }
            } else {
                onPreview(videoPath, true, undefined)
            }
        } else {
            onPreview(thumbSrc || targetUrl, false, liveVideoPath)
        }
    }

    const handleDownload = async (e: React.MouseEvent) => {
        e.stopPropagation()
        setLoading(true)
        try {
            const result = await window.electronAPI.sns.proxyImage({
                url: media.url,
                key: media.key
            })

            if (result.success) {
                const link = document.createElement('a')
                link.download = `sns_media_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`

                if (result.dataUrl) {
                    link.href = result.dataUrl
                } else if (result.videoPath) {
                    // For local video files, we need to fetch as blob to force download behavior
                    // or just use the file protocol url if the browser supports it
                    try {
                        const response = await fetch(`file://${result.videoPath}`)
                        const blob = await response.blob()
                        const url = URL.createObjectURL(blob)
                        link.href = url
                        setTimeout(() => URL.revokeObjectURL(url), 60000)
                    } catch (err) {
                        console.error('Video fetch failed, falling back to direct link', err)
                        link.href = `file://${result.videoPath}`
                    }
                }

                document.body.appendChild(link)
                link.click()
                document.body.removeChild(link)
            } else {
                alert('下载失败: 无法获取资源')
            }
        } catch (e) {
            console.error('Download error:', e)
            alert('下载出错')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div
            className={`sns-media-item ${isDecrypting ? 'decrypting' : ''}`}
            onClick={handlePreview}
        >
            {(thumbSrc && !thumbSrc.startsWith('data:') && (thumbSrc.toLowerCase().endsWith('.mp4') || thumbSrc.includes('video'))) ? (
                <video
                    key={thumbSrc}
                    src={`${thumbSrc}#t=0.1`}
                    className="media-image"
                    preload="auto"
                    muted
                    playsInline
                    disablePictureInPicture
                    disableRemotePlayback
                    onLoadedMetadata={(e) => {
                        e.currentTarget.currentTime = 0.1
                    }}
                />
            ) : (
                <img
                    src={thumbSrc || targetUrl}
                    className="media-image"
                    loading="lazy"
                    onError={() => setError(true)}
                    alt=""
                />
            )}

            {isGeneratingCover && (
                <div className="media-decrypting-mask">
                    <RefreshCw className="spin" size={24} />
                    <span>解密中...</span>
                </div>
            )}

            {isVideo && (
                <div className="media-badge video">
                    {/* If we have a cover, show Play. If decrypting for preview, show spin. Generating cover has its own mask. */}
                    {isDecrypting ? <RefreshCw className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
                </div>
            )}

            {isLive && !isVideo && (
                <div className="media-badge live">
                    <LivePhotoIcon size={16} />
                </div>
            )}

            <div className="media-download-btn" onClick={handleDownload} title="下载">
                <Download size={16} />
            </div>
        </div>
    )
}

export const SnsMediaGrid: React.FC<SnsMediaGridProps> = ({ mediaList, onPreview }) => {
    if (!mediaList || mediaList.length === 0) return null

    const count = mediaList.length
    let gridClass = ''

    if (count === 1) gridClass = 'grid-1'
    else if (count === 2) gridClass = 'grid-2'
    else if (count === 3) gridClass = 'grid-3'
    else if (count === 4) gridClass = 'grid-4' // 2x2
    else if (count <= 6) gridClass = 'grid-6' // 3 cols
    else gridClass = 'grid-9' // 3x3

    return (
        <div className={`sns-media-grid ${gridClass}`}>
            {mediaList.map((media, idx) => (
                <MediaItem key={idx} media={media} onPreview={onPreview} />
            ))}
        </div>
    )
}
