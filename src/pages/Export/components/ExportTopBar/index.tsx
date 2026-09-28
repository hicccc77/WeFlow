import React, { memo } from 'react'
import { FolderOpen, Settings2, ExternalLink, Bot } from 'lucide-react'
import type { ExportWriteLayout } from '../../../../services/config'
import { writeLayoutOptions } from '../../constants'
import { formatPathBrief } from '../../utils/format'
import './ExportTopBar.scss'

interface ExportTopBarProps {
  exportPath: string
  writeLayout: ExportWriteLayout
  onSelectPath: () => void
  onWriteLayoutChange: (layout: ExportWriteLayout) => void
  onGlobalSettingsClick: () => void
}

const ExportTopBar: React.FC<ExportTopBarProps> = ({
  exportPath,
  writeLayout,
  onSelectPath,
  onWriteLayoutChange,
  onGlobalSettingsClick
}) => {
  return (
    <div className="export-top-bar">
      <div className="top-bar-left">
        <div className="path-selector">
          <span className="label">导出路径</span>
          <div className="path-display-group">
            <button className="path-btn" onClick={onSelectPath} title={exportPath || '请选择导出路径'}>
              <FolderOpen size={16} />
              <span className="path-text">
                {exportPath ? formatPathBrief(exportPath, 40) : '请选择...'}
              </span>
            </button>
            {exportPath && (
              <button 
                className="open-folder-btn" 
                title="在文件管理器中打开"
                onClick={() => window.electronAPI.shell.openPath(exportPath)}
              >
                <ExternalLink size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="layout-selector">
          <span className="label">目录结构</span>
          <div className="layout-pills">
            {writeLayoutOptions.map(option => (
              <button
                key={option.value}
                className={`pill-btn ${writeLayout === option.value ? 'active' : ''}`}
                onClick={() => onWriteLayoutChange(option.value)}
                title={option.desc}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="top-bar-right">
        <button className="global-settings-btn" onClick={onGlobalSettingsClick}>
          <Settings2 size={18} />
          <span>全局配置</span>
        </button>
      </div>
    </div>
  )
}

export default memo(ExportTopBar)
