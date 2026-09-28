import React, { useState } from 'react'
import { X } from 'lucide-react'
import type { ExportAutomationTask } from '../../../../types/exportAutomation'
import type { ExportTaskPayload } from '../../types'
import {
  buildAutomationSchedule,
  createAutomationTaskId,
  normalizeAutomationIntervalDays,
  normalizeAutomationIntervalHours,
  AUTOMATION_RANGE_OPTIONS,
  type AutomationRangeMode,
  normalizeAutomationLastNDays,
  AUTOMATION_LAST_N_DAYS_DEFAULT,
  buildAutomationLastNDaysConfig,
  resolveAutomationRangeMode,
  resolveAutomationDateRangeSelection
} from '../../utils/automation'
import type { ExportAutomationDateRangeConfig } from '../../../../types/exportAutomation'
import './Automation.scss'

interface AutomationTaskFormProps {
  initialTask?: ExportAutomationTask
  basePayload?: Omit<ExportTaskPayload, 'source' | 'automationTaskId'>
  onSave: (task: ExportAutomationTask) => void
  onCancel: () => void
}

export const AutomationTaskForm: React.FC<AutomationTaskFormProps> = ({
  initialTask,
  basePayload,
  onSave,
  onCancel
}) => {
  // ─── Derive a sensible default task name ───────────────────
  const defaultName = (() => {
    const names = initialTask?.sessionNames || basePayload?.sessionNames || []
    if (names.length === 0) return '每日增量备份'
    if (names.length === 1) return `${names[0]} 自动化导出`
    return `${names[0]} 等 ${names.length} 个会话 自动化导出`
  })()

  const [name, setName] = useState(initialTask?.name || defaultName)
  const [enabled, setEnabled] = useState(initialTask?.enabled ?? true)
  const [useGlobalOutputDir, setUseGlobalOutputDir] = useState(!initialTask?.outputDir)
  const [outputDir, setOutputDir] = useState(initialTask?.outputDir || '')
  
  const schedule = initialTask?.schedule
  const [intervalDays, setIntervalDays] = useState(schedule?.intervalDays ?? 1)
  const [intervalHours, setIntervalHours] = useState(schedule?.intervalHours ?? 0)
  
  const firstTriggerAt = schedule?.firstTriggerAt
  const [firstTriggerEnabled, setFirstTriggerEnabled] = useState(!!firstTriggerAt)
  const [firstTriggerValue, setFirstTriggerValue] = useState(() => {
    if (firstTriggerAt) {
      const d = new Date(firstTriggerAt)
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
      return d.toISOString().slice(0, 16)
    }
    return ''
  })

  // ─── Date Range Mode ───────────────────────────────────────
  const initDateRangeConfig = initialTask?.template?.dateRangeConfig
  const initSelection = initDateRangeConfig
    ? resolveAutomationDateRangeSelection(initDateRangeConfig)
    : undefined
  const initMode = initDateRangeConfig && initSelection
    ? resolveAutomationRangeMode(initDateRangeConfig, initSelection)
    : 'all'

  const [rangeMode, setRangeMode] = useState<AutomationRangeMode>(initMode)
  const [lastNDays, setLastNDays] = useState(() => {
    if (initDateRangeConfig && typeof initDateRangeConfig === 'object' && (initDateRangeConfig as any).relativeDays) {
      return (initDateRangeConfig as any).relativeDays
    }
    return AUTOMATION_LAST_N_DAYS_DEFAULT
  })

  // ─── Stop Conditions ──────────────────────────────────────
  const stopCondition = initialTask?.stopCondition
  const [stopAtEnabled, setStopAtEnabled] = useState(!!stopCondition?.endAt)
  const [stopAtValue, setStopAtValue] = useState(() => {
    if (stopCondition?.endAt) {
      const d = new Date(stopCondition.endAt)
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
      return d.toISOString().slice(0, 16)
    }
    return ''
  })

  const [maxRunsEnabled, setMaxRunsEnabled] = useState(!!stopCondition?.maxRuns)
  const [maxRuns, setMaxRuns] = useState(stopCondition?.maxRuns || 0)

  const handleChooseDir = async () => {
    const result = await window.electronAPI.dialog.openFile({
      properties: ['openDirectory', 'createDirectory'] as any
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setOutputDir(result.filePaths[0])
      setUseGlobalOutputDir(false)
    }
  }

  const buildDateRangeConfig = (): ExportAutomationDateRangeConfig | null => {
    if (rangeMode === 'all') {
      return { version: 1, preset: 'all', useAllTime: true } as any
    }
    if (rangeMode === 'lastNDays') {
      return buildAutomationLastNDaysConfig(normalizeAutomationLastNDays(lastNDays)) as any
    }
    if (['yesterday', 'last7days', 'last30days', 'last1year', 'today'].includes(rangeMode)) {
      return { version: 1, preset: rangeMode, useAllTime: false } as any
    }
    return null
  }

  const handleSave = () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      alert('请输入任务名称')
      return
    }

    const days = normalizeAutomationIntervalDays(intervalDays)
    const hours = normalizeAutomationIntervalHours(intervalHours)
    if (days <= 0 && hours <= 0) {
      alert('执行间隔不能为0，请至少设置天数或小时')
      return
    }

    let firstTriggerTimestamp: number | undefined
    if (firstTriggerEnabled) {
      if (!firstTriggerValue) {
        alert('请填写有效的首次触发时间')
        return
      }
      firstTriggerTimestamp = new Date(firstTriggerValue).getTime()
    }

    let endAtTimestamp: number | undefined
    if (stopAtEnabled) {
      if (!stopAtValue) {
        alert('请填写有效的终止时间')
        return
      }
      endAtTimestamp = new Date(stopAtValue).getTime()
    }

    const maxRunsValue = maxRunsEnabled ? Math.max(0, Math.floor(maxRuns)) : undefined

    const sessionIds = initialTask?.sessionIds || basePayload?.sessionIds || []
    const sessionNames = initialTask?.sessionNames || basePayload?.sessionNames || []
    const templateOptions = initialTask?.template.optionTemplate || basePayload?.options || {}
    const scope = initialTask?.template.scope || basePayload?.scope || 'multi'
    const contentType = initialTask?.template.contentType || basePayload?.contentType

    const task: ExportAutomationTask = {
      id: initialTask?.id || createAutomationTaskId(),
      name: trimmedName,
      enabled,
      sessionIds,
      sessionNames,
      outputDir: useGlobalOutputDir ? undefined : outputDir,
      schedule: buildAutomationSchedule(days, hours, firstTriggerTimestamp || 0),
      condition: {
        type: 'new-message-since-last-success'
      },
      stopCondition: {
        endAt: endAtTimestamp,
        maxRuns: maxRunsValue
      },
      template: {
        scope: scope as any,
        contentType,
        optionTemplate: templateOptions as any,
        dateRangeConfig: buildDateRangeConfig() as any
      },
      runState: initialTask?.runState,
      createdAt: initialTask?.createdAt || Date.now(),
      updatedAt: Date.now()
    }

    onSave(task)
  }

  // ─── Summary ───────────────────────────────────────────────
  const sessionIds = initialTask?.sessionIds || basePayload?.sessionIds || []
  const sessionNamesForSummary = initialTask?.sessionNames || basePayload?.sessionNames || []
  const rangeLabelMap: Record<AutomationRangeMode, string> = {
    all: '每次触发导出全部历史消息',
    today: '每次触发导出当天',
    yesterday: '每次触发导出前1天',
    last7days: '每次触发导出前7天',
    last30days: '每次触发导出前30天',
    last1year: '每次触发导出前1年',
    lastNDays: `每次触发导出前 ${normalizeAutomationLastNDays(lastNDays)} 天`,
    custom: '完整时间'
  }

  return (
    <div className="automation-form-overlay" onClick={onCancel}>
      <div className="automation-form-modal" onClick={e => e.stopPropagation()}>
        <div className="form-header">
          <h3>{initialTask ? '编辑自动化任务' : '创建自动化任务'}</h3>
          <button className="close-icon-btn" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div className="form-body">
          {/* 基本信息 */}
          <div className="form-section">
            <h4>任务名称</h4>
            <div className="form-row">
              <input 
                type="text" 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="例如：每天凌晨备份" 
              />
            </div>
          </div>

          {/* 执行频率 */}
          <div className="form-section">
            <h4>执行频率</h4>
            <div className="form-row">
              <label>间隔天数</label>
              <div className="number-input-group">
                <input 
                  type="number" 
                  min="0" 
                  value={intervalDays} 
                  onChange={e => setIntervalDays(Number(e.target.value))} 
                />
              </div>
              <label>间隔小时</label>
              <div className="number-input-group">
                <input 
                  type="number" 
                  min="0" 
                  max="23" 
                  value={intervalHours} 
                  onChange={e => setIntervalHours(Number(e.target.value))} 
                />
              </div>
            </div>
          </div>

          {/* 首次触发 */}
          <div className="form-section">
            <h4>首次触发时间（可选）</h4>
            <div className="form-row">
              <label className="checkbox-label">
                <input 
                  type="checkbox" 
                  checked={firstTriggerEnabled} 
                  onChange={e => setFirstTriggerEnabled(e.target.checked)} 
                />
                指定第一次触发时间
              </label>
            </div>
            {firstTriggerEnabled && (
              <div className="form-row">
                <input 
                  type="datetime-local" 
                  value={firstTriggerValue} 
                  onChange={e => setFirstTriggerValue(e.target.value)} 
                />
              </div>
            )}
          </div>

          {/* 导出时间范围 */}
          <div className="form-section">
            <h4>导出时间范围（按触发时间动态计算）</h4>
            <div className="form-row" style={{ flexWrap: 'wrap', gap: '8px' }}>
              {AUTOMATION_RANGE_OPTIONS.map(opt => (
                <button
                  key={opt.mode}
                  type="button"
                  style={{
                    padding: '6px 14px',
                    borderRadius: '16px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    border: rangeMode === opt.mode ? '1px solid var(--primary)' : '1px solid color-mix(in srgb, var(--border-color) 60%, transparent)',
                    background: rangeMode === opt.mode ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'var(--bg-surface, #fff)',
                    color: rangeMode === opt.mode ? 'var(--primary)' : 'var(--text-primary)',
                    fontWeight: rangeMode === opt.mode ? 500 : 400
                  }}
                  onClick={() => setRangeMode(opt.mode)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {rangeMode === 'lastNDays' && (
              <div className="form-row">
                <label>天数</label>
                <div className="number-input-group">
                  <input
                    type="number"
                    min="1"
                    max="3650"
                    value={lastNDays}
                    onChange={e => setLastNDays(Number(e.target.value))}
                  />
                </div>
              </div>
            )}
            <div style={{ fontSize: '12px', color: 'var(--text-secondary, #888)', marginTop: '4px' }}>
              {rangeLabelMap[rangeMode]}
            </div>
          </div>

          {/* 终止条件 */}
          <div className="form-section">
            <h4>终止条件（可选）</h4>
            <div className="form-row">
              <label className="checkbox-label">
                <input 
                  type="checkbox" 
                  checked={stopAtEnabled} 
                  onChange={e => setStopAtEnabled(e.target.checked)} 
                />
                到指定时间后自动停止
              </label>
            </div>
            {stopAtEnabled && (
              <div className="form-row">
                <input 
                  type="datetime-local" 
                  value={stopAtValue} 
                  onChange={e => setStopAtValue(e.target.value)} 
                />
              </div>
            )}
            <div className="form-row">
              <label className="checkbox-label">
                <input 
                  type="checkbox" 
                  checked={maxRunsEnabled} 
                  onChange={e => setMaxRunsEnabled(e.target.checked)} 
                />
                成功执行指定次数后自动停止
              </label>
            </div>
            {maxRunsEnabled && (
              <div className="form-row">
                <div className="number-input-group">
                  <input 
                    type="number" 
                    min="1" 
                    value={maxRuns} 
                    onChange={e => setMaxRuns(Number(e.target.value))} 
                  /> 次
                </div>
              </div>
            )}
          </div>

          {/* 导出目录 */}
          <div className="form-section">
            <h4>导出目录</h4>
            <div className="form-row">
              <label className="checkbox-label">
                <input 
                  type="checkbox" 
                  checked={useGlobalOutputDir} 
                  onChange={e => setUseGlobalOutputDir(e.target.checked)} 
                />
                使用全局导出目录
              </label>
            </div>
            {!useGlobalOutputDir && (
              <div className="form-row">
                <button type="button" className="secondary-btn" onClick={handleChooseDir}>选择目录</button>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {outputDir || '未选择'}
                </span>
              </div>
            )}
          </div>

          {/* 启用 */}
          <div className="form-section">
            <div className="form-row">
              <label className="checkbox-label">
                <input 
                  type="checkbox" 
                  checked={enabled} 
                  onChange={e => setEnabled(e.target.checked)} 
                />
                创建后立即启用
              </label>
            </div>
          </div>

          {/* Summary */}
          <div className="form-summary">
            会话：{sessionIds.length} 个 · 
            间隔：{normalizeAutomationIntervalDays(intervalDays)} 天 {normalizeAutomationIntervalHours(intervalHours)} 小时 · 
            首次：{firstTriggerEnabled && firstTriggerValue ? new Date(firstTriggerValue).toLocaleString('zh-CN') : '默认按创建时间+间隔'} · 
            时间：{rangeLabelMap[rangeMode]} · 
            条件：有新消息才导出
          </div>

        </div>
        <div className="form-footer">
          <button type="button" className="secondary-btn" onClick={onCancel}>取消</button>
          <button type="button" className="primary-btn" onClick={handleSave}>保存任务</button>
        </div>
      </div>
    </div>
  )
}
