import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import LiquidGlass from './LiquidGlass'
import './ConfirmDialog.scss'

interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: string
  onConfirm: () => void
  onCancel: () => void
  confirmText?: string
  cancelText?: string
  tone?: 'default' | 'danger'
  showCancel?: boolean
}

export default function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = '确认',
  cancelText = '取消',
  tone = 'default',
  showCancel = true
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancelRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    const frame = window.requestAnimationFrame(() => confirmButtonRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) return null

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <LiquidGlass
        className="confirm-dialog-glass"
        cornerRadius={20}
        displacementScale={36}
        aberrationIntensity={1.5}
      >
        <div className="confirm-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title || '确认操作'}>
          <button className="close-btn" onClick={onCancel} aria-label="关闭">
            <X size={20} />
          </button>
          {title && <div className="dialog-title">{title}</div>}
          <div className="dialog-content">
            <p style={{ whiteSpace: 'pre-line' }}>{message}</p>
          </div>
          <div className="dialog-actions">
            {showCancel && <button className="btn-cancel" onClick={onCancel}>{cancelText}</button>}
            <button ref={confirmButtonRef} className={`btn-confirm ${tone === 'danger' ? 'danger' : ''}`} onClick={onConfirm}>{confirmText}</button>
          </div>
        </div>
      </LiquidGlass>
    </div>
  )
}
