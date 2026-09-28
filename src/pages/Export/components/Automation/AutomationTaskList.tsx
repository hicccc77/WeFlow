import React from 'react'
import { Play, Pause, Edit, Trash2, Clock, CheckCircle2, AlertCircle } from 'lucide-react'
import type { ExportAutomationTask } from '../../../../types/exportAutomation'
import {
  formatAutomationScheduleLabel,
  formatAutomationCurrentState,
  formatAutomationStopCondition,
  formatAutomationLastRunSummary
} from '../../utils/automation'

interface AutomationTaskListProps {
  tasks: ExportAutomationTask[]
  onEdit: (task: ExportAutomationTask) => void
  onDelete: (task: ExportAutomationTask) => void
  onToggleEnable: (task: ExportAutomationTask, enabled: boolean) => void
  onRunNow: (task: ExportAutomationTask) => void
}

export const AutomationTaskList: React.FC<AutomationTaskListProps> = ({
  tasks,
  onEdit,
  onDelete,
  onToggleEnable,
  onRunNow
}) => {
  if (tasks.length === 0) {
    return (
      <div className="automation-task-list">
        <div className="empty-state">
          <Clock size={48} className="empty-icon" />
          <p>暂无自动化任务</p>
          <span style={{ fontSize: '12px', opacity: 0.6 }}>在导出配置时，选择“保存为自动化任务”即可创建</span>
        </div>
      </div>
    )
  }

  const nowMs = Date.now()

  return (
    <div className="automation-task-list">
      {tasks.map(task => {
        const isEnabled = task.enabled
        // For queueState, we can determine from lastRunStatus if it's currently running/queued
        const queueState = task.runState?.lastRunStatus === 'running' 
          ? 'running' 
          : task.runState?.lastRunStatus === 'queued' ? 'queued' : null

        return (
          <div key={task.id} className="task-item">
            <div className="task-info">
              <div className="task-header">
                <span className={`status-badge ${isEnabled ? 'enabled' : ''}`}>
                  {isEnabled ? '运行中' : '已停用'}
                </span>
                <h4 title={task.name}>{task.name}</h4>
              </div>
              <div className="task-details">
                <div className="detail-row">
                  <Clock size={14} />
                  <span>调度规则：{formatAutomationScheduleLabel(task.schedule)}</span>
                </div>
                <div className="detail-row">
                  <AlertCircle size={14} />
                  <span>停止条件：{formatAutomationStopCondition(task)}</span>
                </div>
                <div className="detail-row">
                  <CheckCircle2 size={14} />
                  <span>最近执行：{formatAutomationLastRunSummary(task)}</span>
                </div>
                <div className="detail-row" style={{ color: isEnabled ? 'var(--primary)' : 'inherit', marginTop: '4px' }}>
                  <span>状态：{formatAutomationCurrentState(task, queueState, nowMs)}</span>
                </div>
              </div>
            </div>
            
            <div className="task-actions">
              <div className="action-row">
                {isEnabled ? (
                  <button 
                    className="secondary-btn" 
                    title="停用任务"
                    onClick={() => onToggleEnable(task, false)}
                  >
                    <Pause size={14} style={{ marginRight: '4px' }} /> 停用
                  </button>
                ) : (
                  <button 
                    className="primary-btn" 
                    title="启用任务"
                    onClick={() => onToggleEnable(task, true)}
                  >
                    <Play size={14} style={{ marginRight: '4px' }} /> 启用
                  </button>
                )}
                <button 
                  className="secondary-btn"
                  title="立即手动触发一次"
                  onClick={() => onRunNow(task)}
                >
                  <Play size={14} />
                </button>
              </div>
              <div className="action-row">
                <button 
                  className="icon-btn" 
                  title="编辑"
                  onClick={() => onEdit(task)}
                >
                  <Edit size={16} />
                </button>
                <button 
                  className="icon-btn danger" 
                  title="删除"
                  onClick={() => {
                    if (window.confirm(`确认删除自动化任务「${task.name}」吗？`)) {
                      onDelete(task)
                    }
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
