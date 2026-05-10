import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Avatar } from './Avatar'
import './NotificationToast.scss'

export interface NotificationData {
    id: string
    sessionId: string
    channel?: string
    insightRecordId?: string
    targetRoute?: string
    avatarUrl?: string
    title: string
    content: string
    timestamp: number
}

interface NotificationToastProps {
    data: NotificationData | null
    onClose: () => void
    onClick: (data: NotificationData) => void
    duration?: number
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'
    isStatic?: boolean
    initialVisible?: boolean
}

export function NotificationToast({
    data,
    onClose,
    onClick,
    duration = 5000,
    position = 'top-right',
    isStatic = false,
    initialVisible = false
}: NotificationToastProps) {
    const [isVisible, setIsVisible] = useState(initialVisible)
    const [currentData, setCurrentData] = useState<NotificationData | null>(null)

    useEffect(() => {
        if (data) {
            setCurrentData(data)
            setIsVisible(true)

            const timer = setTimeout(() => {
                setIsVisible(false)
                // clean up data after animation
                setTimeout(onClose, 300)
            }, duration)

            return () => clearTimeout(timer)
        } else {
            setIsVisible(false)
        }
    }, [data, duration, onClose])

    if (!currentData) return null

    const handleClose = (e: React.MouseEvent) => {
        e.stopPropagation()
        setIsVisible(false)
        setTimeout(onClose, 300)
    }

    const handleClick = () => {
        setIsVisible(false)
        setTimeout(() => {
            onClose()
            onClick(currentData)
        }, 300)
    }

    const content = (
        <div
            className={`notification-toast-container ${position} ${isVisible ? 'visible' : ''} ${isStatic ? 'static' : ''}`}
            onClick={handleClick}
        >
            <div className="notification-content">
                <div className="notification-avatar">
                    <Avatar
                        src={currentData.avatarUrl}
                        name={currentData.title}
                        size={40}
                    />
                </div>
                <div className="notification-text">
                    <div className="notification-header">
                        <span className="notification-title">{currentData.title}</span>
                        <span className="notification-time">
                            {new Date(currentData.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    </div>
                    <div className="notification-body">
                        {currentData.content}
                    </div>
                </div>
                <button className="notification-close" onClick={handleClose}>
                    <X size={14} />
                </button>
            </div>
        </div>
    )

    if (isStatic) {
        return content
    }

    // Portal to document.body to ensure it's on top
    return createPortal(content, document.body)
}
