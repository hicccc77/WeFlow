import { useNavigate } from 'react-router-dom'
import { ArrowLeft, History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getAiAnalysisSystemLogs, getAiAnalysisTasks } from '../features/ai-analysis/storage'
import { rerunFailedBatch, runAiAnalysisTask } from '../features/ai-analysis/scheduler'
import type { AiAnalysisLogEntry } from '../features/ai-analysis/types'
import type { AiAnalysisTaskRecord } from '../features/ai-analysis/types'
import './GroupAiPages.scss'

function GroupAiHistoryPage() {
  const PREF_KEY = 'aiAnalysisV1.historyPrefs'
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<AiAnalysisTaskRecord[]>([])
  const [systemLogs, setSystemLogs] = useState<AiAnalysisLogEntry[]>([])
  const [rerunTaskId, setRerunTaskId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('all')
  const [selectedLevel, setSelectedLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [keyword, setKeyword] = useState('')
  const [copyTip, setCopyTip] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(80)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshSeconds, setRefreshSeconds] = useState(5)
  const [replaySuggestion, setReplaySuggestion] = useState('')
  const [selectedTask, setSelectedTask] = useState<AiAnalysisTaskRecord | null>(null)
  const [batchRerunLoading, setBatchRerunLoading] = useState('')

  const loadAll = async () => {
    const [rows, logs] = await Promise.all([getAiAnalysisTasks(), getAiAnalysisSystemLogs()])
    setTasks(rows)
    setSystemLogs(logs)
  }

  useEffect(() => {
    void loadAll()
    try {
      const raw = window.localStorage.getItem(PREF_KEY)
      if (raw) {
        const pref = JSON.parse(raw) as { pageSize?: number; autoRefresh?: boolean; refreshSeconds?: number }
        if (pref.pageSize && [20, 50, 80, 120, 200].includes(pref.pageSize)) setPageSize(pref.pageSize)
        if (typeof pref.autoRefresh === 'boolean') setAutoRefresh(pref.autoRefresh)
        if (pref.refreshSeconds && pref.refreshSeconds >= 3 && pref.refreshSeconds <= 30) setRefreshSeconds(pref.refreshSeconds)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(PREF_KEY, JSON.stringify({ pageSize, autoRefresh, refreshSeconds }))
  }, [pageSize, autoRefresh, refreshSeconds])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      void loadAll()
    }, refreshSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, refreshSeconds])

  const rerun = async (task: AiAnalysisTaskRecord) => {
    if (rerunTaskId) return
    const groupId = task.groupId || ''
    if (!groupId) return
    setRerunTaskId(task.id)
    const nextTaskId = `ai-rerun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await runAiAnalysisTask({
      taskId: nextTaskId,
      groupId,
      groupName: task.groupName,
      rangeStart: task.rangeStart,
      rangeEnd: task.rangeEnd,
      mediaTypes: task.mediaTypes
    })
    await loadAll()
    setRerunTaskId('')
  }

  const filteredLogs = systemLogs.filter((log) => {
    if (selectedTaskId !== 'all' && log.taskId !== selectedTaskId) return false
    if (selectedLevel !== 'all' && log.level !== selectedLevel) return false
    const q = keyword.trim().toLowerCase()
    if (!q) return true
    const blob = [
      log.message,
      log.step,
      log.code,
      log.taskId,
      JSON.stringify(log.payload || {})
    ].join(' ').toLowerCase()
    return blob.includes(q)
  })

  const selectedTaskLogs = selectedTask
    ? systemLogs.filter((item) => item.taskId === selectedTask.id).sort((a, b) => a.createdAt - b.createdAt)
    : []

  const failedBatches = selectedTaskLogs
    .filter((log) => log.code === 'BATCH_SKIP' || log.step === 'batch.skip')
    .map((log) => {
      const payload = (log.payload || {}) as { range?: { start?: number; end?: number } }
      const start = Number(payload.range?.start || 0)
      const end = Number(payload.range?.end || 0)
      return {
        id: `${log.id}-${start}-${end}`,
        start,
        end,
        message: log.message
      }
    })
    .filter((item) => item.start > 0 && item.end > 0 && item.end >= item.start)

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pagedLogs = filteredLogs.slice((safePage - 1) * pageSize, safePage * pageSize)

  const errorChainLogs = filteredLogs.filter((log) => log.level === 'error' || String(log.code || '').includes('FAILED') || String(log.code || '').includes('INVALID'))

  useEffect(() => {
    const top = errorChainLogs.slice(0, 8)
    if (top.length === 0) {
      setReplaySuggestion('当前无错误链路。建议保持自动刷新开启，持续观察日志。')
      return
    }
    const reasonCount = top.reduce<Record<string, number>>((acc, item) => {
      const key = item.code || item.step || 'UNKNOWN'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    const sorted = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])
    const primary = sorted[0]?.[0] || 'UNKNOWN'
    const taskId = top[0]?.taskId || 'N/A'
    setReplaySuggestion([
      `建议重放任务: ${taskId}`,
      `主要失败点: ${primary}`,
      '建议参数：',
      '- 重试次数: 3',
      '- 批次间隔: 1秒',
      '- 时间范围: 使用原范围先复现，再缩小到失败批次',
      '- 重点检查: API Key、Base URL、模型名、提示词 JSON 输出约束'
    ].join('\n'))
  }, [errorChainLogs])

  const summary = {
    total: filteredLogs.length,
    info: filteredLogs.filter((x) => x.level === 'info').length,
    warn: filteredLogs.filter((x) => x.level === 'warn').length,
    error: filteredLogs.filter((x) => x.level === 'error').length,
    topSteps: Object.entries(filteredLogs.reduce<Record<string, number>>((acc, item) => {
      acc[item.step] = (acc[item.step] || 0) + 1
      return acc
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }

  const exportLogs = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      filters: {
        selectedTaskId,
        selectedLevel,
        keyword
      },
      total: filteredLogs.length,
      logs: filteredLogs
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-system-logs-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportErrorChain = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      filters: {
        selectedTaskId,
        selectedLevel,
        keyword
      },
      total: errorChainLogs.length,
      logs: errorChainLogs
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-error-chain-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const copyDiagnostics = async () => {
    const text = JSON.stringify({
      exportedAt: new Date().toISOString(),
      tasks,
      logs: filteredLogs
    }, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      setCopyTip('诊断包已复制')
      window.setTimeout(() => setCopyTip(''), 1500)
    } catch {
      setCopyTip('复制失败')
      window.setTimeout(() => setCopyTip(''), 1500)
    }
  }

  const copySummary = async () => {
    const lines = [
      `日志总数: ${summary.total}`,
      `INFO: ${summary.info}`,
      `WARN: ${summary.warn}`,
      `ERROR: ${summary.error}`,
      `高频步骤Top5:`,
      ...summary.topSteps.map(([step, count]) => `- ${step}: ${count}`)
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopyTip('问题摘要已复制')
      window.setTimeout(() => setCopyTip(''), 1500)
    } catch {
      setCopyTip('复制失败')
      window.setTimeout(() => setCopyTip(''), 1500)
    }
  }

  const rerunFailed = async (task: AiAnalysisTaskRecord, failed: { id: string; start: number; end: number }) => {
    if (batchRerunLoading) return
    const groupId = task.groupId || ''
    if (!groupId) return
    setBatchRerunLoading(failed.id)
    await rerunFailedBatch({
      sourceTaskId: task.id,
      failedRange: { start: failed.start, end: failed.end },
      groupId,
      groupName: task.groupName,
      mediaTypes: task.mediaTypes
    })
    await loadAll()
    setBatchRerunLoading('')
  }

  useEffect(() => {
    setPage(1)
  }, [selectedTaskId, selectedLevel, keyword])

  return (
    <div className="group-ai-page">
      <div className="group-ai-page__header">
        <button className="group-ai-page__back" onClick={() => navigate('/analytics/group')}>
          <ArrowLeft size={18} />
          <span>返回群聊分析</span>
        </button>
        <h2>分析历史</h2>
        <p>下一里程碑将接入按时间倒序的任务历史、复跑入口与状态展示。</p>
      </div>

      {tasks.length === 0 ? (
        <section className="group-ai-card group-ai-card--empty">
          <History size={20} />
          <span>暂无历史记录</span>
        </section>
      ) : (
        <section className="group-ai-card">
          <h3>历史任务（倒序）</h3>
          <div className="group-ai-history-list">
            {tasks.map((task) => (
              <div className={`group-ai-history-item ${selectedTask?.id === task.id ? 'active' : ''}`} key={task.id} onClick={() => setSelectedTask(task)}>
                <div>
                  <strong>{task.groupName || task.groupId || '未命名群聊'}</strong>
                  <p>{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>
                  <p>范围：{new Date(task.rangeStart).toLocaleString('zh-CN', { hour12: false })} - {new Date(task.rangeEnd).toLocaleString('zh-CN', { hour12: false })}</p>
                </div>
                <div className="group-ai-history-actions">
                  <span>{task.status}</span>
                  <button onClick={() => void rerun(task)} disabled={Boolean(rerunTaskId)}>
                    {rerunTaskId === task.id ? '重跑中...' : '重新分析'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {selectedTask ? (
        <section className="group-ai-card">
          <h3>任务详情与时序（{selectedTask.groupName || selectedTask.groupId || selectedTask.id}）</h3>
          <div className="group-ai-task-detail-meta">
            <span>任务ID: {selectedTask.id}</span>
            <span>状态: {selectedTask.status}</span>
            <span>范围: {new Date(selectedTask.rangeStart).toLocaleString('zh-CN', { hour12: false })} - {new Date(selectedTask.rangeEnd).toLocaleString('zh-CN', { hour12: false })}</span>
            {selectedTask.payloadStats ? <span>媒体选择: {selectedTask.payloadStats.selectedMediaTypes.join(', ')}</span> : null}
            {selectedTask.payloadStats ? <span>拉取/发送: {selectedTask.payloadStats.totalFetchedMessages}/{selectedTask.payloadStats.totalSentMessages}</span> : null}
            {selectedTask.payloadStats ? <span>类型分布: text {selectedTask.payloadStats.byType.text || 0}, image {selectedTask.payloadStats.byType.image || 0}, video {selectedTask.payloadStats.byType.video || 0}</span> : null}
          </div>
          <div className="group-ai-timeline">
            {selectedTaskLogs.length === 0 ? <p>暂无时序日志</p> : selectedTaskLogs.map((log) => (
              <div className="group-ai-timeline-item" key={`tl-${log.id}`}>
                <span>{new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <strong>{log.step}</strong>
                <em>{log.code || '-'}</em>
                <p>{log.message}</p>
              </div>
            ))}
          </div>
          <div className="group-ai-failed-batches">
            <h4>失败批次定位</h4>
            {failedBatches.length === 0 ? <p>当前任务没有失败批次。</p> : failedBatches.map((failed) => (
              <div key={failed.id} className="group-ai-failed-item">
                <div>
                  <strong>{new Date(failed.start).toLocaleString('zh-CN', { hour12: false })} - {new Date(failed.end).toLocaleString('zh-CN', { hour12: false })}</strong>
                  <p>{failed.message}</p>
                </div>
                <button onClick={() => void rerunFailed(selectedTask, failed)} disabled={Boolean(batchRerunLoading)}>
                  {batchRerunLoading === failed.id ? '复跑中...' : '复跑该失败批次'}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="group-ai-card">
        <h3>全系统日志（最近15天）</h3>
        <div className="group-ai-log-summary">
          <span>总计 {summary.total}</span>
          <span>INFO {summary.info}</span>
          <span>WARN {summary.warn}</span>
          <span>ERROR {summary.error}</span>
          <button onClick={() => void copySummary()}>复制问题摘要</button>
          <label className="group-ai-inline-toggle"><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />自动刷新</label>
          <select value={refreshSeconds} onChange={(e) => setRefreshSeconds(Number(e.target.value))}>
            <option value={3}>3s</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={15}>15s</option>
            <option value={30}>30s</option>
          </select>
        </div>
        <div className="group-ai-log-filters">
          <select value={selectedTaskId} onChange={(e) => setSelectedTaskId(e.target.value)}>
            <option value="all">全部任务</option>
            {tasks.map((task) => (
              <option value={task.id} key={task.id}>{task.groupName || task.groupId || task.id}</option>
            ))}
          </select>
          <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value as 'all' | 'info' | 'warn' | 'error')}>
            <option value="all">全部级别</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="关键词检索 message/step/code/payload" />
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            <option value={20}>20/页</option>
            <option value={50}>50/页</option>
            <option value={80}>80/页</option>
            <option value={120}>120/页</option>
            <option value={200}>200/页</option>
          </select>
          <button onClick={exportLogs}>导出日志</button>
          <button onClick={exportErrorChain}>仅导出错误链路</button>
          <button onClick={() => void copyDiagnostics()}>复制诊断包</button>
          {copyTip ? <span>{copyTip}</span> : null}
        </div>
        <div className="group-ai-replay-box">
          <h4>错误链路回放建议</h4>
          <pre>{replaySuggestion}</pre>
        </div>
        <div className="group-ai-log-list">
          {filteredLogs.length === 0 ? <p>暂无日志</p> : pagedLogs.map((log) => (
            <div key={log.id} className="group-ai-log-item">
              <strong>[{log.level.toUpperCase()}] {log.code || 'NO_CODE'}</strong>
              <span>{new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
              <em>{log.step}</em>
              {typeof log.durationMs === 'number' ? <span>耗时: {log.durationMs}ms</span> : null}
              <p>{log.message}</p>
              {log.payload ? <pre>{JSON.stringify(log.payload, null, 2)}</pre> : null}
            </div>
          ))}
        </div>
        <div className="group-ai-log-pagination">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>上一页</button>
          <span>第 {safePage}/{totalPages} 页</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>下一页</button>
        </div>
      </section>
    </div>
  )
}

export default GroupAiHistoryPage
