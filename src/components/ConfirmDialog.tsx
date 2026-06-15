import { X } from 'lucide-react'
import './ConfirmDialog.scss'

interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <button className="close-btn" onClick={onCancel}>
          <X size={20} />
        </button>
        {title && <div className="dialog-title">{title}</div>}
        <div className="dialog-content">
          <p style={{ whiteSpace: 'pre-line' }}>{message}</p>
        </div>
        <div className="dialog-actions">
          <button className="btn-cancel" onClick={onCancel}>取消</button>
          <button className="btn-confirm" onClick={onConfirm}>开始获取</button>
        </div>
      </div>
    </div>
  )
}
