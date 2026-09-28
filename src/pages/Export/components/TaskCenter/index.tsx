import React, { memo } from 'react'
import { CheckCircle2, XCircle, Loader2, PlayCircle, PauseCircle, Trash2, StopCircle } from 'lucide-react'
import type { ExportTask } from '../../types'
import type { BackgroundTaskRecord } from '../../../../types/backgroundTask'
import ErrorReferenceLink from '../../../../components/ErrorReferenceLink'
import {
  backgroundTaskSourceLabels,
  backgroundTaskStatusLabels
} from '../../constants'
import './TaskCenter.scss'

interface TaskCenterProps {
  exportTasks: ExportTask[]
  onCancelExportTask: (taskId: string) => void
  onClearCompletedExportTasks: () => void
  
  backgroundTasks: BackgroundTaskRecord[]
  onPauseBackgroundTask: (taskId: string) => void
  onResumeBackgroundTask: (taskId: string) => void
  onCancelBackgroundTask: (taskId: string) => void
  onClearCompletedBackgroundTasks: () => void
}

const isBackgroundTaskSettled = (task: BackgroundTaskRecord): boolean => (
  task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'
)

const parseBackgroundTaskProgress = (progressText?: string): { current: number; total: number; percent: number } | null => {
  const match = String(progressText || '').match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/)
  if (!match) return null
  const current = Number(match[1].replace(/,/g, ''))
  const total = Number(match[2].replace(/,/g, ''))
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null
  const safeCurrent = Math.max(0, Math.min(current, total))
  return {
    current: safeCurrent,
    total,
    percent: Math.max(0, Math.min(100, Math.round((safeCurrent / total) * 100)))
  }
}

const TaskCenter: React.FC<TaskCenterProps> = ({
  exportTasks,
  onCancelExportTask,
  onClearCompletedExportTasks,
  backgroundTasks,
  onPauseBackgroundTask,
  onResumeBackgroundTask,
  onCancelBackgroundTask,
  onClearCompletedBackgroundTasks
}) => {
  const hasTasks = exportTasks.length > 0 || backgroundTasks.length > 0
  
  if (!hasTasks) return null

  const completedExportTasks = exportTasks.filter(t => t.status === 'success' || t.status === 'error')
  const completedBackgroundTasks = backgroundTasks.filter(isBackgroundTaskSettled)
  const hasCompletedTasks = completedExportTasks.length > 0 || completedBackgroundTasks.length > 0

  const handleClearCompletedTasks = () => {
    onClearCompletedExportTasks()
    onClearCompletedBackgroundTasks()
  }

  return (
    <div className="task-center">
      <div className="task-center-header">
        <h2 className="title">任务中心</h2>
        {hasCompletedTasks && (
          <button className="clear-btn" onClick={handleClearCompletedTasks}>
            <Trash2 size={14} /> 清理已完成
          </button>
        )}
      </div>

      <div className="task-list">
        {/* Export Tasks */}
        {exportTasks.map(task => {
          const hasMessageProgress = Number(task.progress.phaseTotal) > 0
          const phaseLabel = task.progress.phaseLabel || task.progress.phase
          const labelAlreadyHasCount = hasMessageProgress && /\d[\d,]*\s*\/\s*\d[\d,]*\s*条/.test(phaseLabel)
          const countText = hasMessageProgress
            ? `${Math.max(0, Math.floor(Number(task.progress.phaseProgress) || 0)).toLocaleString()} / ${Math.max(0, Math.floor(Number(task.progress.phaseTotal) || 0)).toLocaleString()} 条`
            : `${Math.max(0, Math.floor(Number(task.progress.current) || 0))} / ${Math.max(0, Math.floor(Number(task.progress.total) || 0))}`
          return (
          <div key={task.id} className={`task-card export-task status-${task.status}`}>
            <div className="task-card-header">
              <div className="task-info">
                <span className="task-title">{task.title}</span>
                <span className="task-status-badge">
                  {task.status === 'running' && <Loader2 className="spin" size={12} />}
                  {task.status === 'success' && <CheckCircle2 size={12} />}
                  {task.status === 'error' && <XCircle size={12} />}
                  {task.status === 'canceled' && <StopCircle size={12} />}
                  {task.status === 'cancel_requested' && <Loader2 className="spin" size={12} />}
                  {task.status === 'running' ? '导出中' : task.status === 'success' ? '已完成' : task.status === 'cancel_requested' ? '取消中' : task.status === 'canceled' ? '已取消' : '失败'}
                </span>
              </div>
              <div className="task-actions">
                {task.status === 'running' && (
                  <button className="action-btn cancel" onClick={() => onCancelExportTask(task.id)} title="取消任务">
                    <StopCircle size={16} />
                  </button>
                )}
              </div>
            </div>

            <div className="task-progress-area">
              <div className="progress-bar-bg">
                <div 
                  className="progress-bar-fill" 
                  style={{ width: `${Math.max(0, Math.min(100, (task.progress.current / Math.max(1, task.progress.total)) * 100))}%` }}
                />
              </div>
              <div className="progress-stats">
                <span className="phase">{phaseLabel}</span>
                {!labelAlreadyHasCount && <span className="count">{countText}</span>}
              </div>
              
              {task.error && (
                <div className="task-error-msg">
                  <span>{task.error}</span>
                  <ErrorReferenceLink error={task.error} label="核对" compact />
                </div>
              )}
            </div>
          </div>
          )
        })}

        {/* Global Background Tasks */}
        {backgroundTasks.length > 0 && (
          <div className="bg-tasks-section">
            <h3 className="section-title">全局后台任务</h3>
            {backgroundTasks.map(bgTask => {
              const isPausable = bgTask.status === 'running'
              const isResumable = bgTask.status === 'paused'
              const isCancelable = !isBackgroundTaskSettled(bgTask)
              const progress = parseBackgroundTaskProgress(bgTask.progressText)
              const sourceLabel = backgroundTaskSourceLabels[bgTask.sourcePage] || '后台任务'

              return (
                <div key={bgTask.id} className={`task-card bg-task status-${bgTask.status}`}>
                  <div className="task-card-header">
                    <div className="task-info">
                      <span className="task-title">{bgTask.title || sourceLabel}</span>
                      <span className="task-source-badge">{sourceLabel}</span>
                      <span className="task-status-badge">
                        {bgTask.status === 'running' && <Loader2 className="spin" size={12} />}
                        {(bgTask.status === 'completed') && <CheckCircle2 size={12} />}
                        {(bgTask.status === 'failed' || bgTask.status === 'canceled') && <XCircle size={12} />}
                        {(bgTask.status === 'pause_requested' || bgTask.status === 'cancel_requested') && <Loader2 className="spin" size={12} />}
                        {backgroundTaskStatusLabels[bgTask.status]}
                      </span>
                    </div>
                    <div className="task-actions">
                      {isPausable && (
                        <button className="action-btn" onClick={() => onPauseBackgroundTask(bgTask.id)} title="暂停">
                          <PauseCircle size={16} />
                        </button>
                      )}
                      {isResumable && (
                        <button className="action-btn" onClick={() => onResumeBackgroundTask(bgTask.id)} title="恢复">
                          <PlayCircle size={16} />
                        </button>
                      )}
                      {isCancelable && (
                        <button className="action-btn cancel" onClick={() => onCancelBackgroundTask(bgTask.id)} title="取消">
                          <StopCircle size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  {(bgTask.detail || bgTask.progressText) && (
                    <div className="task-progress-area bg-progress-area">
                      {progress && (
                        <div className="progress-bar-bg">
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                      )}
                      <div className="progress-stats">
                        {bgTask.detail && <span className="phase">{bgTask.detail}</span>}
                        {bgTask.progressText && <span className="count">{bgTask.progressText}</span>}
                      </div>
                    </div>
                  )}
                  {bgTask.status === 'failed' && (
                    <div className="task-error-msg">
                      <span>{bgTask.detail || bgTask.progressText || '后台任务执行失败'}</span>
                      <ErrorReferenceLink error={bgTask.detail || bgTask.progressText} label="核对" compact />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(TaskCenter)
