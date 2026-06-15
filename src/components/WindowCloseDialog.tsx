import { Minimize2, Power, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import './WindowCloseDialog.scss'

interface WindowCloseDialogProps {
  open: boolean
  canMinimizeToTray: boolean
  restoreMethod?: 'tray' | 'dock'
  onSelect: (action: 'tray' | 'quit', rememberChoice: boolean) => void
  onCancel: () => void
}

export default function WindowCloseDialog({
  open,
  canMinimizeToTray,
  restoreMethod = 'tray',
  onSelect,
  onCancel
}: WindowCloseDialogProps) {
  const [rememberChoice, setRememberChoice] = useState(false)
  const isDockRestore = restoreMethod === 'dock'

  useEffect(() => {
    if (!open) return
    setRememberChoice(false)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="window-close-dialog-overlay" onClick={onCancel}>
      <div
        className="window-close-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="window-close-dialog-title"
      >
        <button
          type="button"
          className="window-close-dialog-close"
          onClick={onCancel}
          aria-label="关闭提示"
        >
          <X size={18} />
        </button>

        <div className="window-close-dialog-header">
          <span className="window-close-dialog-kicker">退出行为</span>
          <h2 id="window-close-dialog-title">关闭 WeFlow</h2>
          <p>
            {canMinimizeToTray
              ? isDockRestore
                ? '你可以隐藏主窗口并保留后台进程与本地 API，稍后可从 Dock 或重新打开应用恢复。'
                : '你可以保留后台进程与本地 API，或者直接完全退出应用。'
              : '当前系统托盘不可用，本次只能完全退出应用。'}
          </p>
        </div>

        <div className="window-close-dialog-body">
          {canMinimizeToTray && (
            <button
              type="button"
              className="window-close-dialog-option"
              onClick={() => onSelect('tray', rememberChoice)}
            >
              <span className="window-close-dialog-option-icon">
                <Minimize2 size={18} />
              </span>
              <span className="window-close-dialog-option-text">
                <strong>{isDockRestore ? '隐藏主窗口' : '最小化到系统托盘'}</strong>
                <span>
                  {isDockRestore
                    ? '继续保留后台进程和本地 API，稍后可从 Dock 或重新打开应用恢复。'
                    : '继续保留后台进程和本地 API，稍后可从托盘恢复。'}
                </span>
              </span>
            </button>
          )}

          <button
            type="button"
            className="window-close-dialog-option is-danger"
            onClick={() => onSelect('quit', rememberChoice)}
          >
            <span className="window-close-dialog-option-icon">
              <Power size={18} />
            </span>
            <span className="window-close-dialog-option-text">
              <strong>完全关闭</strong>
              <span>结束 WeFlow 进程，并停止当前保留的本地 API。</span>
            </span>
          </button>
        </div>

        <label className="window-close-dialog-remember">
          <input
            type="checkbox"
            checked={rememberChoice}
            onChange={(event) => setRememberChoice(event.target.checked)}
          />
          <span className="window-close-dialog-checkbox" aria-hidden="true" />
          <span className="window-close-dialog-remember-text">下次不再提示，直接按本次选择处理</span>
        </label>

        <div className="window-close-dialog-actions">
          <button type="button" className="window-close-dialog-cancel" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
