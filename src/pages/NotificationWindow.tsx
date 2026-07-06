import { useEffect, useState, useRef } from 'react'
import { NotificationToast, type NotificationData } from '../components/NotificationToast'
import type { LiquidGlassBackdropImage } from '../components/LiquidGlass'
import {
    useNotificationAdaptiveTheme,
    useNotificationNativeAdaptiveTheme,
    getLayoutRect,
    NATIVE_BAND_IDS
} from './useNotificationAdaptiveTheme'
import '../components/NotificationToast.scss'
import './NotificationWindow.scss'

/** 与 NotificationToast 传给 LiquidGlass 的参数保持一致（原生面板需要同一套值） */
const GLASS_PARAMS = { cornerRadius: 16, blurSigma: 2, displacementScale: 70, aberrationIntensity: 1, saturation: 140 }

export default function NotificationWindow() {
    const [notification, setNotification] = useState<NotificationData | null>(null)
    const [prevNotification, setPrevNotification] = useState<NotificationData | null>(null)
    const [position, setPosition] = useState<string>('top-right')
    // 主进程随通知下发的屏幕几何信息（尺寸 + 窗口坐标）。
    // 回退管线（原生玻璃不可用时）用它把桌面视频流与屏幕逐像素对齐——
    // Electron 透明窗口内 backdrop-filter 采不到桌面，渲染层自采视频流是回退路径下唯一的折射来源
    const [backdrop, setBackdrop] = useState<LiquidGlassBackdropImage | undefined>(undefined)
    // 原生玻璃模式（Windows）：折射由主进程的原生面板在窗口下方提供，
    // 渲染层不开视频流、不渲染折射画布，只负责上报卡片几何与内容层
    const [nativeBackdrop, setNativeBackdrop] = useState(false)
    // 屏幕实时视频流（仅回退管线使用）：通知展示期间开启，玻璃折射随桌面实时更新；
    // 隐藏后释放采集。原生模式下始终为 null
    const [stream, setStream] = useState<MediaStream | null>(null)
    const streamRef = useRef<MediaStream | null>(null)
    const sourceIdRef = useRef<string | null>(null)

    // 事件回调里需要读取"当前展示中"的通知作为过渡的旧通知，用 ref 避免重建监听
    const notificationRef = useRef<NotificationData | null>(null)
    // 上次上报的窗口尺寸：重复上报会触发主进程 setSize，
    // 可见状态下反复设置尺寸会让 DWM 短暂拉伸旧帧缓冲，闪出一圈幽灵轮廓
    const lastSizeRef = useRef<{ width: number; height: number } | null>(null)

    useEffect(() => {
        notificationRef.current = notification
    }, [notification])

    useEffect(() => {
        const handleShow = (_event: any, data: any) => {
            const timestamp = Math.floor(Date.now() / 1000)
            const newNoti: NotificationData = {
                id: `noti_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
                sessionId: data.sessionId,
                channel: data.channel,
                insightRecordId: data.insightRecordId,
                targetRoute: data.targetRoute,
                title: data.title,
                content: data.content,
                timestamp: timestamp,
                avatarUrl: data.avatarUrl
            }

            if (data.position) {
                setPosition(data.position)
            }
            if (data.backdrop) {
                setBackdrop({
                    width: data.backdrop.width,
                    height: data.backdrop.height,
                    screenX: data.backdrop.winX,
                    screenY: data.backdrop.winY
                })
                setNativeBackdrop(Boolean(data.backdrop.native))
                sourceIdRef.current = data.backdrop.sourceId ?? null
            }

            if (notificationRef.current) {
                setPrevNotification(notificationRef.current)
            }
            setNotification(newNoti)
        }

        if (window.electronAPI) {
            const remove = window.electronAPI.notification?.onShow?.(handleShow)
            window.electronAPI.notification?.ready?.()
            return () => remove?.()
        }
    }, [])

    // Clean up prevNotification after transition
    useEffect(() => {
        if (prevNotification) {
            const timer = setTimeout(() => {
                setPrevNotification(null)
            }, 400)
            return () => clearTimeout(timer)
        }
    }, [prevNotification])

    // 分区无级自适应：整卡驱动玻璃纱层方向与浓度，标题行/正文按各自背后区域
    // 的实际对比度连续取色（算法详见 useNotificationAdaptiveTheme）。
    // 流模式从视频帧采样；原生模式吃原生面板回读的亮度带事件
    useNotificationAdaptiveTheme(stream, backdrop)
    useNotificationNativeAdaptiveTheme(nativeBackdrop)

    const stopStream = () => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop())
            streamRef.current = null
            setStream(null)
        }
    }

    // 回退管线（原生玻璃不可用时）：通知展示期间开启屏幕采集流
    // （通知窗口已被 content protection 排除，不会拍到自己）；
    // 全部隐藏后立即停止采集释放资源。原生模式下 sourceId 为空，永不触发
    useEffect(() => {
        const active = Boolean(notification || prevNotification)

        if (active && !streamRef.current && sourceIdRef.current && !nativeBackdrop) {
            let cancelled = false
            const dpr = window.devicePixelRatio || 1
            const captureW = Math.round(window.screen.width * dpr)
            const captureH = Math.round(window.screen.height * dpr)
            navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    // Electron 专有约束：按 sourceId 采集屏幕，无需用户手势
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sourceIdRef.current,
                        minWidth: captureW,
                        maxWidth: captureW,
                        minHeight: captureH,
                        maxHeight: captureH,
                        maxFrameRate: 60
                    }
                }
            } as unknown as MediaStreamConstraints).then(mediaStream => {
                if (cancelled) {
                    mediaStream.getTracks().forEach(track => track.stop())
                    return
                }
                // 提示采集调度器优先保帧率而非画质（本地渲染无编码环节，无画质代价）
                mediaStream.getVideoTracks().forEach(track => { track.contentHint = 'motion' })
                streamRef.current = mediaStream
                setStream(mediaStream)
            }).catch(error => {
                console.warn('[NotificationWindow] 屏幕流获取失败，折射退化为兜底材质:', error)
            })
            return () => {
                cancelled = true
            }
        }

        if (!active) stopStream()
    }, [notification, prevNotification, nativeBackdrop])

    // 原生玻璃模式：卡片挂载后上报实测几何（窗口本地 CSS 像素 + 卡片本地亮度带），
    // 主进程据此创建/复用窗口下方的原生面板；参数与 LiquidGlass 的视觉参数一致
    useEffect(() => {
        if (!nativeBackdrop || !notification) return
        // 同一条通知内的重复上报去重（双 rAF 首测 + 120ms 复测几何通常一致）：
        // 跳过后主进程不会白做 setBounds/setLumaBands/anchor 原生调用，
        // 也避免 setLumaBands 触发的一次带 GPU 同步等待的亮度补采。
        // 局部变量随 effect 重建，新通知（即使几何相同）必然重新上报以驱动面板 show
        let lastSent = ''
        const report = () => {
            const host = document.getElementById('notification-current')
            const glassEl = host?.querySelector<HTMLElement>('.liquid-glass')
            if (!glassEl) return
            const card = getLayoutRect(glassEl)
            if (card.width < 1 || card.height < 1) return
            const bands: Array<{ id: number; x: number; y: number; width: number; height: number }> = [
                { id: NATIVE_BAND_IDS.card, x: 0, y: 0, width: card.width, height: card.height }
            ]
            const bandEls: Array<[number, HTMLElement | null]> = [
                [NATIVE_BAND_IDS.title, host?.querySelector<HTMLElement>('.notification-header') ?? null],
                [NATIVE_BAND_IDS.body, host?.querySelector<HTMLElement>('.notification-body') ?? null]
            ]
            for (const [id, el] of bandEls) {
                if (!el) continue
                const rect = getLayoutRect(el)
                bands.push({ id, x: rect.left - card.left, y: rect.top - card.top, width: rect.width, height: rect.height })
            }
            const payload = {
                card: { x: card.left, y: card.top, width: card.width, height: card.height },
                bands,
                // CSS px → 物理 px 的换算系数（devicePixelRatio 已含页面缩放，
                // 主进程不能只用显示器 scaleFactor：缩放会随 file:// 域持久化）
                dpr: window.devicePixelRatio || 1,
                ...GLASS_PARAMS
            }
            const key = JSON.stringify(payload)
            if (key === lastSent) return
            lastSent = key
            window.electronAPI?.notification?.glassRect?.(payload)
        }
        // 双 rAF 等首次布局落定后测量；120ms 复测一次，覆盖表情图/字体就绪导致的高度变化
        let raf2 = 0
        const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(report) })
        const timer = setTimeout(report, 120)
        return () => {
            cancelAnimationFrame(raf1)
            cancelAnimationFrame(raf2)
            clearTimeout(timer)
        }
    }, [nativeBackdrop, notification, position])

    // 兜底释放：窗口被主进程隐藏或组件卸载时，无论上层状态如何都立即停止采集，
    // 确保任何路径下都不会在后台持续占用采集管线
    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') stopStream()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange)
            stopStream()
        }
    }, [])

    const handleClose = () => {
        setNotification(null)
        setPrevNotification(null)
        window.electronAPI.notification?.close()
    }

    const handleClick = (data: NotificationData) => {
        if (data.channel === 'ai-insight') {
            window.electronAPI.notification?.click({
                sessionId: data.sessionId,
                channel: data.channel,
                insightRecordId: data.insightRecordId,
                targetRoute: data.targetRoute
            })
        } else {
            window.electronAPI.notification?.click(data.sessionId)
        }
        setNotification(null)
        setPrevNotification(null)
        // Main process handles window hide/close
    }

    useEffect(() => {
        if (!notification && !prevNotification) return

        const timer = setTimeout(() => {
            // 窗口必须精确贴合内容高度，多余区域会拦截桌面点击
            const root = document.getElementById('notification-root')
            if (root && window.electronAPI?.notification?.resize) {
                const width = position === 'top-center' ? 280 : 344
                const height = Math.min(Math.ceil(root.getBoundingClientRect().height), 300)
                const last = lastSizeRef.current
                if (last && last.width === width && last.height === height) return
                lastSizeRef.current = { width, height }
                window.electronAPI.notification.resize(width, height)
            }
        }, 50)

        return () => clearTimeout(timer)
    }, [notification, prevNotification, position])

    if (!notification && !prevNotification) return null

    return (
        <>
            <div
                id="notification-root"
                style={{
                    width: '100vw',
                    height: 'auto',
                    background: 'transparent',
                    position: 'relative', // Context for absolute children
                    overflow: 'hidden' // Prevent scrollbars during transition
                }}>

                {/* Previous Notification (Background / Fading Out) */}
                {prevNotification && (
                    <div
                        id="notification-prev"
                        key={prevNotification.id}
                        className={position === 'top-center' ? 'anim-center' : ''}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            zIndex: 1,
                            pointerEvents: 'none' // Disable interaction on old one
                        }}
                    >
                        <NotificationToast
                            key={prevNotification.id}
                            data={prevNotification}
                            onClose={() => { }} // No-op for background item
                            onClick={() => { }}
                            initialVisible={true}
                            backdropImage={backdrop}
                            backdropStream={stream}
                            nativeBackdrop={nativeBackdrop}
                        />
                    </div>
                )}

                {/* Current Notification (Foreground / Fading In) */}
                {notification && (
                    <div
                        id="notification-current"
                        key={notification.id}
                        className={position === 'top-center' ? 'anim-center' : ''}
                        style={{
                            position: 'relative', // Takes up space
                            zIndex: 2,
                            width: '100%'
                        }}
                    >
                        <NotificationToast
                            key={notification.id} // Ensure remount for animation
                            data={notification}
                            onClose={handleClose}
                            onClick={handleClick}
                            initialVisible={true}
                            backdropImage={backdrop}
                            backdropStream={stream}
                            nativeBackdrop={nativeBackdrop}
                            // 退场动画开始的一刻同步淡出原生面板（与卡片 0.3s 渐隐节奏匹配）
                            onHideStart={nativeBackdrop ? () => window.electronAPI?.notification?.glassHide?.() : undefined}
                        />
                    </div>
                )}
            </div>
        </>
    )
}
