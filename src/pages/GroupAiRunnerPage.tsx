import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Brain, CalendarDays, Image, Video } from 'lucide-react'
import { buildDefaultTimeRange, runAiAnalysisTask } from '../features/ai-analysis/scheduler'
import { getAiAnalysisColumnWidths, getAiAnalysisLogs, getAiAnalysisSettings, getAiAnalysisTasks, setAiAnalysisColumnWidths } from '../features/ai-analysis/storage'
import type { AiAnalysisLogEntry, AiAnalysisMediaType, AiAnalysisTaskRecord } from '../features/ai-analysis/types'
import './GroupAiPages.scss'

interface RunnerState {
  groupId?: string
  groupName?: string
}

function GroupAiRunnerPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = (location.state || {}) as RunnerState

  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [running, setRunning] = useState(false)
  const [task, setTask] = useState<AiAnalysisTaskRecord | null>(null)
  const [logs, setLogs] = useState<AiAnalysisLogEntry[]>([])
  const [startTs, setStartTs] = useState<number>(0)
  const [endTs, setEndTs] = useState<number>(0)
  const [mediaText, setMediaText] = useState(true)
  const [mediaImage, setMediaImage] = useState(false)
  const [mediaVideo, setMediaVideo] = useState(false)
  const [startedAt, setStartedAt] = useState<number>(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [copyTip, setCopyTip] = useState('')

  useEffect(() => {
    const init = async () => {
      const settings = await getAiAnalysisSettings()
      const range = buildDefaultTimeRange(settings.defaultDays)
      setStartTs(range.start)
      setEndTs(range.end)
      setMediaText(settings.defaultMediaTypes.includes('text'))
      setMediaImage(settings.defaultMediaTypes.includes('image'))
      setMediaVideo(settings.defaultMediaTypes.includes('video'))
      const widths = await getAiAnalysisColumnWidths()
      setColumnWidths(widths)
      setSettingsLoaded(true)
    }
    void init()
  }, [])

  useEffect(() => {
    if (!task?.id) return
    const timer = window.setInterval(async () => {
      const [rows, taskRows] = await Promise.all([
        getAiAnalysisLogs(task.id),
        getAiAnalysisTasks()
      ])
      setLogs(rows)
      const latest = taskRows.find(item => item.id === task.id)
      if (latest) {
        setTask(latest)
        if (latest.status === 'succeeded' || latest.status === 'failed') {
          setRunning(false)
        }
      }
    }, 1200)

    return () => window.clearInterval(timer)
  }, [task?.id])

  useEffect(() => {
    if (!running || !startedAt) return
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])

  const startTask = async () => {
    if (running || !state.groupId) return
    setRunning(true)
    setLogs([])
    const mediaTypes: AiAnalysisMediaType[] = []
    if (mediaText) mediaTypes.push('text')
    if (mediaImage) mediaTypes.push('image')
    if (mediaVideo) mediaTypes.push('video')
    const taskId = `ai-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setStartedAt(Date.now())
    setElapsedSeconds(0)

    const startedTask: AiAnalysisTaskRecord = {
      id: taskId,
      groupId: state.groupId,
      groupName: state.groupName,
      rangeStart: startTs,
      rangeEnd: endTs,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : ['text'],
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setTask(startedTask)

    const result = await runAiAnalysisTask({
      taskId,
      groupId: state.groupId,
      groupName: state.groupName,
      rangeStart: startTs,
      rangeEnd: endTs,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : ['text']
    })
    setTask(result)
    setRunning(false)
    if (result.status === 'succeeded') {
      void window.electronAPI.notification?.show({
        title: 'AI识别任务完成',
        content: `${result.groupName || result.groupId || '群聊'} 已完成分析`,
        sessionId: 'weflow-ai-analysis'
      })
    }
    const latestLogs = await getAiAnalysisLogs(taskId)
    setLogs(latestLogs)
  }

  const targetGroupText = useMemo(() => {
    if (state.groupName) return `${state.groupName}${state.groupId ? ` (${state.groupId})` : ''}`
    if (state.groupId) return state.groupId
    return '未指定群聊'
  }, [state.groupId, state.groupName])

  const formatDateInput = (ts: number) => {
    if (!ts) return ''
    const d = new Date(ts)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }

  const parseDateInput = (value: string, end = false) => {
    const date = new Date(`${value}T00:00:00`)
    if (Number.isNaN(date.getTime())) return 0
    if (end) {
      date.setHours(23, 59, 59, 999)
    }
    return date.getTime()
  }

  const parseResultTable = (text?: string): { columns: string[]; rows: Array<Record<string, string>> } => {
    if (!text) return { columns: [], rows: [] }
    const normalized = text.trim()
    if (!(normalized.startsWith('{') || normalized.startsWith('['))) {
      throw new Error('AI输出格式异常：返回内容不是 JSON 结构')
    }
    try {
      const payload = JSON.parse(normalized)
      if (Array.isArray(payload)) {
        const rows = payload
          .filter((item) => item && typeof item === 'object')
          .map((item) => Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])))
        const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
        return { columns, rows }
      }
      if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>
        const rows = Object.entries(obj).map(([key, value]) => ({ 字段: key, 内容: typeof value === 'string' ? value : JSON.stringify(value) }))
        return { columns: ['字段', '内容'], rows }
      }
    } catch {
      throw new Error('AI输出格式异常：JSON 解析失败')
    }

    throw new Error('AI输出格式异常：无法解析为表格数据')
  }
  const [resultParseError, setResultParseError] = useState('')
  const resultTable = useMemo(() => {
    try {
      return parseResultTable(task?.finalResultText)
    } catch {
      return { columns: [], rows: [] }
    }
  }, [task?.finalResultText])

  useEffect(() => {
    try {
      void parseResultTable(task?.finalResultText)
      setResultParseError('')
    } catch (error) {
      setResultParseError(error instanceof Error ? error.message : String(error))
    }
  }, [task?.finalResultText])

  const updateColumnWidth = async (column: string, nextWidth: number) => {
    const merged = {
      ...columnWidths,
      [column]: Math.max(120, Math.min(800, Math.round(nextWidth)))
    }
    setColumnWidths(merged)
    await setAiAnalysisColumnWidths(merged)
  }

  const startResize = (column: string, startX: number) => {
    const baseWidth = columnWidths[column] || 180
    const onMove = (event: MouseEvent) => {
      const delta = event.clientX - startX
      void updateColumnWidth(column, baseWidth + delta)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const copyCell = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyTip('已复制')
      window.setTimeout(() => setCopyTip(''), 1200)
    } catch {
      setCopyTip('复制失败')
      window.setTimeout(() => setCopyTip(''), 1200)
    }
  }

  return (
    <div className="group-ai-page">
      <div className="group-ai-page__header">
        <button className="group-ai-page__back" onClick={() => navigate('/analytics/group')}>
          <ArrowLeft size={18} />
          <span>返回群聊分析</span>
        </button>
        <h2>AI识别</h2>
        <p>功能骨架已接入，下一里程碑将补齐循环切片、重试与合并分析。</p>
      </div>

      <div className="group-ai-card-grid">
        <section className="group-ai-card">
          <h3>当前目标</h3>
          <p>{targetGroupText}</p>
        </section>

        <section className="group-ai-card">
          <h3>默认参数</h3>
          <ul>
            <li><CalendarDays size={14} /> 默认时间范围：近30天（可调整）</li>
            <li><Brain size={14} /> 处理模式：分批串行 + 最终合并</li>
            <li><Image size={14} /> 图片提取：默认关闭</li>
            <li><Video size={14} /> 视频提取：默认关闭</li>
          </ul>
        </section>
      </div>

      {settingsLoaded ? (
        <section className="group-ai-card">
          <h3>任务参数</h3>
          <div className="group-ai-runner-controls">
            <label>开始日期</label>
            <input
              type="date"
              value={formatDateInput(startTs)}
              onChange={(e) => setStartTs(parseDateInput(e.target.value, false))}
            />
            <label>结束日期</label>
            <input
              type="date"
              value={formatDateInput(endTs)}
              onChange={(e) => setEndTs(parseDateInput(e.target.value, true))}
            />
            <label><input type="checkbox" checked={mediaText} onChange={(e) => setMediaText(e.target.checked)} /> 文本</label>
            <label><input type="checkbox" checked={mediaImage} onChange={(e) => setMediaImage(e.target.checked)} /> 图片</label>
            <label><input type="checkbox" checked={mediaVideo} onChange={(e) => setMediaVideo(e.target.checked)} /> 视频</label>
            <button onClick={() => void startTask()} disabled={running || !state.groupId || !startTs || !endTs}>
              {running ? '分析执行中...' : '开始 AI识别'}
            </button>
          </div>
        </section>
      ) : null}

      {task ? (
        <section className="group-ai-card">
          <h3>执行进度</h3>
          <p>状态：{task.status}</p>
          <p>批次进度：{task.progress?.completedBatches || 0}/{task.progress?.totalBatches || 0}</p>
          {task.payloadStats ? (
            <div className="group-ai-task-detail-meta">
              <span>媒体选择: {task.payloadStats.selectedMediaTypes.join(', ') || 'text'}</span>
              <span>拉取总数: {task.payloadStats.totalFetchedMessages}</span>
              <span>发送总数: {task.payloadStats.totalSentMessages}</span>
              <span>发送字符数: {task.payloadStats.totalSentTextChars}</span>
              <span>
                类型分布: text {task.payloadStats.byType.text || 0}, image {task.payloadStats.byType.image || 0}, video {task.payloadStats.byType.video || 0}
              </span>
            </div>
          ) : null}
          {running ? <p>运行时长：{elapsedSeconds}s</p> : null}
          {task.errorMessage ? <p>错误：{task.errorMessage}</p> : null}
          {task.finalResultText ? (
            <div className="group-ai-result-table-wrap">
              {resultParseError ? (
                <div className="group-ai-result-error">{resultParseError}</div>
              ) : null}
              {!resultParseError ? (
                <table className="group-ai-result-table">
                <colgroup>
                  {resultTable.columns.map((column) => (
                    <col key={column} style={{ width: `${columnWidths[column] || 180}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {resultTable.columns.map((column) => (
                      <th key={column}>
                        <span>{column}</span>
                        <button
                          className="group-ai-col-resize"
                          onMouseDown={(e) => startResize(column, e.clientX)}
                          aria-label={`resize-${column}`}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resultTable.rows.map((row, idx) => (
                    <tr key={`row-${idx}`}>
                      {resultTable.columns.map((column) => {
                        const val = row[column] || ''
                        return (
                          <td key={`${idx}-${column}`} onClick={() => void copyCell(val)} title="点击复制">
                            {val}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              ) : null}
              {copyTip ? <div className="group-ai-copy-tip">{copyTip}</div> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="group-ai-card">
        <h3>运行日志</h3>
        <div className="group-ai-log-list">
          {logs.length === 0 ? <p>暂无日志</p> : logs.map((log) => (
            <div key={log.id} className="group-ai-log-item">
              <strong>[{log.level.toUpperCase()}]</strong>
              <span>{new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <em>{log.step}</em>
              <p>{log.message}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export default GroupAiRunnerPage
