import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { ExportAutomationTask } from '../../../../types/exportAutomation'
import { useAutomationStore } from '../../hooks/useAutomation'
import { AutomationTaskList } from './AutomationTaskList'
import { AutomationTaskForm } from './AutomationTaskForm'
import './Automation.scss'

interface AutomationModalProps {
  onClose: () => void
  onRunNow: (task: ExportAutomationTask) => Promise<{ queued: boolean; reason?: string }>
}

export const AutomationModal: React.FC<AutomationModalProps> = ({ onClose, onRunNow }) => {
  const { tasks, updateTask, deleteTask } = useAutomationStore()
  const [editingTask, setEditingTask] = useState<ExportAutomationTask | null>(null)
  const [triggeringTaskIds, setTriggeringTaskIds] = useState<Set<string>>(new Set())

  const handleToggleEnable = (task: ExportAutomationTask, enabled: boolean) => {
    void updateTask(task.id, prev => ({ ...prev, enabled, updatedAt: Date.now() }))
  }

  const handleRunNow = async (task: ExportAutomationTask) => {
    if (triggeringTaskIds.has(task.id)) return
    setTriggeringTaskIds(prev => new Set(prev).add(task.id))

    try {
      const result = await onRunNow(task)
      if (result.queued) {
        alert('已手动触发自动化导出，任务已加入导出队列。')
      } else {
        alert(result.reason || '手动触发失败')
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '手动触发失败')
    } finally {
      setTriggeringTaskIds(prev => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }

  const handleDelete = (task: ExportAutomationTask) => {
    void deleteTask(task.id)
  }

  const handleEditSave = (task: ExportAutomationTask) => {
    void updateTask(task.id, () => task)
    setEditingTask(null)
  }

  return createPortal(
    <>
      <div className="automation-modal-overlay" onClick={onClose}>
        <div className="automation-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div className="header-title">
              <h3>自动化导出</h3>
              <p>管理定时增量备份任务，仅在应用运行期间生效</p>
            </div>
            <div className="header-actions">
              <button className="close-icon-btn" onClick={onClose}>
                <X size={18} />
              </button>
            </div>
          </div>
          
          <div className="modal-content">
            <AutomationTaskList 
              tasks={tasks}
              onEdit={setEditingTask}
              onDelete={handleDelete}
              onToggleEnable={handleToggleEnable}
              onRunNow={handleRunNow}
            />
          </div>
        </div>
      </div>

      {editingTask && (
        <AutomationTaskForm
          initialTask={editingTask}
          onSave={handleEditSave}
          onCancel={() => setEditingTask(null)}
        />
      )}
    </>,
    document.body
  )
}
