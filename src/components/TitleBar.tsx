import { useEffect, useState } from 'react'
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react'
import './TitleBar.scss'

interface TitleBarProps {
  title?: string
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  showWindowControls?: boolean
  customControls?: React.ReactNode
  showLogo?: boolean
}

function TitleBar({
  title,
  sidebarCollapsed = false,
  onToggleSidebar,
  showWindowControls = true,
  customControls,
  showLogo = true
}: TitleBarProps = {}) {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!showWindowControls) return

    void window.electronAPI.window.isMaximized().then(setIsMaximized).catch(() => {
      setIsMaximized(false)
    })

    return window.electronAPI.window.onMaximizeStateChanged((maximized) => {
      setIsMaximized(maximized)
    })
  }, [showWindowControls])

  return (
    <div className="title-bar">
      <div className="title-brand">
        {showLogo && <img src="./logo.png" alt="WeFlow" className="title-logo" />}
        <span className="titles">{title || 'WeFlow'}</span>
        {onToggleSidebar ? (
          <button
            type="button"
            className="title-sidebar-toggle"
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
      </div>
      {customControls}
      {showWindowControls ? (
        <div className="title-window-controls">
          <button
            type="button"
            className="title-window-control-btn"
            aria-label="最小化"
            title="最小化"
            onClick={() => window.electronAPI.window.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="title-window-control-btn"
            aria-label={isMaximized ? '还原' : '最大化'}
            title={isMaximized ? '还原' : '最大化'}
            onClick={() => window.electronAPI.window.maximize()}
          >
            {isMaximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="title-window-control-btn is-close"
            aria-label="关闭"
            title="关闭"
            onClick={() => window.electronAPI.window.close()}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default TitleBar
