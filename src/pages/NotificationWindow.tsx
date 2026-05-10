import { useEffect, useState, useRef } from 'react'
import { NotificationToast, type NotificationData } from '../components/NotificationToast'
import '../components/NotificationToast.scss'
import './NotificationWindow.scss'

export default function NotificationWindow() {
    const [notification, setNotification] = useState<NotificationData | null>(null)
    const [prevNotification, setPrevNotification] = useState<NotificationData | null>(null)
    const [position, setPosition] = useState<string>('top-right')

    // We need a ref to access the current notification inside the callback
    // without satisfying the dependency array which would recreate the listener
    // Actually, setNotification(prev => ...) pattern is better, but we need the VALUE of current to set as prev.
    // So we use setNotification callback: setNotification(current => { ... return newNode })
    // But we need to update TWO states.
    // So we use a ref to track "current displayed" for the event handler.
    // Or just use functional updates, but we need to setPrev(current).

    const notificationRef = useRef<NotificationData | null>(null)

    useEffect(() => {
        notificationRef.current = notification
    }, [notification])

    useEffect(() => {
        const handleShow = (_event: any, data: any) => {
            // data: { title, content, avatarUrl, sessionId }
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

            // 获取位置配置
            if (data.position) {
                setPosition(data.position)
            }

            // Set previous to current (ref)
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
        // Measure only if we have a notification (current or prev)
        if (!notification && !prevNotification) return

        // Prefer measuring the NEW one
        const targetId = notification ? 'notification-current' : 'notification-prev'

        const timer = setTimeout(() => {
            // Find the wrapper of the content
            // Since we wrap them, we should measure the content inside
            // But getting root is easier if size is set by relative child
            const root = document.getElementById('notification-root')
            if (root) {
                const height = root.offsetHeight
                const width = 344
                if (window.electronAPI?.notification?.resize) {
                    const finalHeight = Math.min(height + 4, 300)
                    window.electronAPI.notification.resize(width, finalHeight)
                }
            }
        }, 50)

        return () => clearTimeout(timer)
    }, [notification, prevNotification])

    if (!notification && !prevNotification) return null

    return (
        <div
            id="notification-root"
            style={{
                width: '100vw',
                height: 'auto',
                minHeight: '10px',
                background: 'transparent',
                position: 'relative', // Context for absolute children
                overflow: 'hidden', // Prevent scrollbars during transition
                padding: '2px', // Margin safe
                boxSizing: 'border-box'
            }}>

            {/* Previous Notification (Background / Fading Out) */}
            {prevNotification && (
                <div
                    id="notification-prev"
                    key={prevNotification.id}
                    className={position === 'top-center' ? 'anim-center' : ''}
                    style={{
                        position: 'absolute',
                        top: 2, // Match padding
                        left: 2,
                        width: 'calc(100% - 4px)', // Match width logic
                        zIndex: 1,
                        pointerEvents: 'none' // Disable interaction on old one
                    }}
                >
                    <NotificationToast
                        key={prevNotification.id}
                        data={prevNotification}
                        onClose={() => { }} // No-op for background item
                        onClick={() => { }}
                        position={position as any}
                        isStatic={true}
                        initialVisible={true}
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
                        position={position as any}
                        isStatic={true}
                        initialVisible={true}
                    />
                </div>
            )}
        </div>
    )
}
