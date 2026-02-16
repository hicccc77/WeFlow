import React, { useState, useRef, useCallback, useEffect } from 'react'
import { X } from 'lucide-react'
import { LivePhotoIcon } from './LivePhotoIcon'
import { createPortal } from 'react-dom'
import './ImagePreview.scss'

interface ImagePreviewProps {
  src: string
  isVideo?: boolean
  liveVideoPath?: string
  onClose: () => void
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({ src, isVideo, liveVideoPath, onClose }) => {
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [showLive, setShowLive] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const positionStart = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (showLive) return // 播放实况时禁止缩放? 或者支持缩放? 暂定禁止以简化
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setScale(prev => Math.min(Math.max(prev * delta, 0.5), 5))
  }, [showLive])

  // 开始拖动
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (showLive || scale <= 1) return
    e.preventDefault()
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    positionStart.current = { ...position }
  }, [scale, position, showLive])

  // 拖动中
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPosition({
      x: positionStart.current.x + dx,
      y: positionStart.current.y + dy
    })
  }, [isDragging])

  // 结束拖动
  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // 双击重置
  const handleDoubleClick = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  // 点击背景关闭
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      onClose()
    }
  }, [onClose])

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      ref={containerRef}
      className="image-preview-overlay"
      onClick={handleOverlayClick}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div
        className="preview-content"
        style={{
          position: 'relative',
          transform: `translate(${position.x}px, ${position.y}px)`,
          width: 'fit-content',
          height: 'fit-content'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {(isVideo || showLive) ? (
          <video
            src={showLive ? liveVideoPath : src}
            controls={!showLive}
            autoPlay
            loop={showLive}
            className="preview-image"
            style={{
              transform: `scale(${scale})`,
              maxHeight: '90vh',
              maxWidth: '90vw'
            }}
          />
        ) : (
          <img
            src={src}
            alt="图片预览"
            className={`preview-image ${isDragging ? 'dragging' : ''}`}
            style={{
              transform: `scale(${scale})`,
              maxHeight: '90vh',
              maxWidth: '90vw',
              cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
            }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            draggable={false}
          />
        )}

        {liveVideoPath && !isVideo && (
          <button
            className={`live-photo-btn ${showLive ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              setShowLive(!showLive)
            }}
            title={showLive ? "显示照片" : "播放实况"}
          >
            <LivePhotoIcon size={20} />
            <span>实况</span>
          </button>
        )}
      </div>

      <button className="image-preview-close" onClick={onClose}>
        <X size={20} />
      </button>
    </div>,
    document.body
  )
}
