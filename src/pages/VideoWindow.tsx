import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Play, Pause, Volume2, VolumeX, RotateCcw } from 'lucide-react'
import './VideoWindow.scss'

export default function VideoWindow() {
    const [searchParams] = useSearchParams()
    const videoPath = searchParams.get('videoPath')
    const [isPlaying, setIsPlaying] = useState(false)
    const [isMuted, setIsMuted] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [volume, setVolume] = useState(1)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const videoRef = useRef<HTMLVideoElement>(null)
    const progressRef = useRef<HTMLDivElement>(null)

    // 格式化时间
    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60)
        const secs = Math.floor(seconds % 60)
        return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    //播放/暂停
    const togglePlay = useCallback(() => {
        if (!videoRef.current) return
        if (isPlaying) {
            videoRef.current.pause()
        } else {
            videoRef.current.play()
        }
    }, [isPlaying])

    // 静音切换
    const toggleMute = useCallback(() => {
        if (!videoRef.current) return
        videoRef.current.muted = !isMuted
        setIsMuted(!isMuted)
    }, [isMuted])

    // 进度条点击
    const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!videoRef.current || !progressRef.current) return
        e.stopPropagation()
        const rect = progressRef.current.getBoundingClientRect()
        const percent = (e.clientX - rect.left) / rect.width
        videoRef.current.currentTime = percent * duration
    }, [duration])

    // 音量调节
    const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseFloat(e.target.value)
        setVolume(newVolume)
        if (videoRef.current) {
            videoRef.current.volume = newVolume
            setIsMuted(newVolume === 0)
        }
    }, [])

    // 重新播放
    const handleReplay = useCallback(() => {
        if (!videoRef.current) return
        videoRef.current.currentTime = 0
        videoRef.current.play()
    }, [])

    // 快捷键
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') window.electronAPI.window.close()
            if (e.key === ' ') {
                e.preventDefault()
                togglePlay()
            }
            if (e.key === 'm' || e.key === 'M') toggleMute()
            if (e.key === 'ArrowLeft' && videoRef.current) {
                videoRef.current.currentTime -= 5
            }
            if (e.key === 'ArrowRight' && videoRef.current) {
                videoRef.current.currentTime += 5
            }
            if (e.key === 'ArrowUp' && videoRef.current) {
                videoRef.current.volume = Math.min(1, videoRef.current.volume + 0.1)
                setVolume(videoRef.current.volume)
            }
            if (e.key === 'ArrowDown' && videoRef.current) {
                videoRef.current.volume = Math.max(0, videoRef.current.volume - 0.1)
                setVolume(videoRef.current.volume)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [togglePlay, toggleMute])

    if (!videoPath) {
        return (
            <div className="video-window-empty">
                <span>无效的视频路径</span>
            </div>
        )
    }

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0

    return (
        <div className="video-window-container">
            <div className="title-bar">
                <div className="window-drag-area"></div>
            </div>

            <div className="video-viewport" onClick={togglePlay}>
                {isLoading && (
                    <div className="video-loading-overlay">
                        <div className="spinner"></div>
                    </div>
                )}
                {error && (
                    <div className="video-error-overlay">
                        <span>{error}</span>
                    </div>
                )}
                <video
                    ref={videoRef}
                    src={videoPath}
                    onLoadedMetadata={(e) => {
                        const video = e.currentTarget
                        setDuration(video.duration)
                        setIsLoading(false)
                        // 根据视频尺寸调整窗口大小
                        if (video.videoWidth && video.videoHeight) {
                            window.electronAPI.window.resizeToFitVideo(video.videoWidth, video.videoHeight)
                        }
                    }}
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    onError={() => {
                        setError('视频加载失败')
                        setIsLoading(false)
                    }}
                    onWaiting={() => setIsLoading(true)}
                    onCanPlay={() => setIsLoading(false)}
                    autoPlay
                />
                {!isPlaying && !isLoading && !error && (
                    <div className="play-overlay">
                        <Play size={64} fill="white" />
                    </div>
                )}

                <div className="video-controls" onClick={(e) => e.stopPropagation()}>
                    <div
                        className="progress-bar"
                        ref={progressRef}
                        onClick={handleProgressClick}
                    >
                        <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
                        </div>
                    </div>

                    <div className="controls-row">
                        <div className="controls-left">
                            <button onClick={togglePlay} title={isPlaying ? '暂停 (空格)' : '播放 (空格)'}>
                                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                            </button>
                            <button onClick={handleReplay} title="重新播放">
                                <RotateCcw size={16} />
                            </button>
                            <span className="time-display">
                                {formatTime(currentTime)} / {formatTime(duration)}
                            </span>
                        </div>

                        <div className="controls-right">
                            <div className="volume-control">
                                <button onClick={toggleMute} title={isMuted ? '取消静音 (M)' : '静音 (M)'}>
                                    {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                                </button>
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.1"
                                    value={isMuted ? 0 : volume}
                                    onChange={handleVolumeChange}
                                    className="volume-slider"
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
