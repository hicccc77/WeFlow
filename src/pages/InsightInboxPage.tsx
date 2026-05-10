import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CalendarDays, Code, Copy, MessageSquare, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import type {
  InsightRecord,
  InsightRecordContactFacet,
  InsightRecordFilters,
  InsightRecordListResult,
  InsightRecordSummary,
  InsightRecordTriggerReason
} from '../types/electron'
import './InsightInboxPage.scss'

const INSIGHT_AVATAR_URL = './assets/insight/AI_Insight.png'

type DateFilterMode = 'all' | 'today' | 'week' | 'custom'

function getStartOfDay(date: Date): number {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next.getTime()
}

function getEndOfDay(date: Date): number {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next.getTime()
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateInput(value: string, endOfDay = false): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return undefined
  return endOfDay ? getEndOfDay(date) : getStartOfDay(date)
}

function formatRecordTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatGroupDate(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (getStartOfDay(date) === getStartOfDay(today)) return '今天'
  if (getStartOfDay(date) === getStartOfDay(yesterday)) return '昨天'
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function getTriggerLabel(reason: InsightRecordTriggerReason): string {
  if (reason === 'silence') return '沉默提醒'
  if (reason === 'test') return '测试见解'
  return '活跃分析'
}

function buildLogText(record: InsightRecord): string {
  const log = record.log
  return [
    `时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`,
    `联系人：${record.displayName} (${record.sessionId})`,
    `触发类型：${getTriggerLabel(record.triggerReason)}`,
    `接口地址：${log.endpoint}`,
    `模型：${log.model}`,
    `Max Tokens：${log.maxTokens}`,
    `Temperature：${log.temperature}`,
    `耗时：${log.durationMs}ms`,
    '',
    '系统提示词：',
    log.systemPrompt,
    '',
    '用户提示词：',
    log.userPrompt,
    '',
    '模型输出原文：',
    log.rawOutput,
    '',
    '最终见解：',
    log.finalInsight
  ].join('\n')
}

export default function InsightInboxPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [records, setRecords] = useState<InsightRecordSummary[]>([])
  const [contacts, setContacts] = useState<InsightRecordContactFacet[]>([])
  const [keyword, setKeyword] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [dateMode, setDateMode] = useState<DateFilterMode>('all')
  const [customStart, setCustomStart] = useState(formatDateInput(new Date()))
  const [customEnd, setCustomEnd] = useState(formatDateInput(new Date()))
  const [stats, setStats] = useState({ total: 0, todayCount: 0, unreadCount: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [focusedRecordId, setFocusedRecordId] = useState(searchParams.get('recordId') || '')
  const [logRecord, setLogRecord] = useState<InsightRecord | null>(null)
  const [message, setMessage] = useState('')

  const dateRange = useMemo(() => {
    const now = new Date()
    if (dateMode === 'today') {
      return { startTime: getStartOfDay(now), endTime: getEndOfDay(now) }
    }
    if (dateMode === 'week') {
      const start = new Date(now)
      start.setDate(now.getDate() - 6)
      return { startTime: getStartOfDay(start), endTime: getEndOfDay(now) }
    }
    if (dateMode === 'custom') {
      return {
        startTime: parseDateInput(customStart),
        endTime: parseDateInput(customEnd, true)
      }
    }
    return {}
  }, [customEnd, customStart, dateMode])

  const filters = useMemo<InsightRecordFilters>(() => ({
    keyword: keyword.trim() || undefined,
    sessionId: selectedSessionId || undefined,
    startTime: dateRange.startTime,
    endTime: dateRange.endTime,
    limit: 200,
    offset: 0
  }), [dateRange.endTime, dateRange.startTime, keyword, selectedSessionId])

  const loadRecords = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result: InsightRecordListResult = await window.electronAPI.insight.listRecords(filters)
      if (!result.success) {
        setError(result.error || '加载灵感信箱失败')
        return
      }
      setRecords(result.records)
      setContacts(result.contacts)
      setStats({
        total: result.total,
        todayCount: result.todayCount,
        unreadCount: result.unreadCount
      })
    } catch (err) {
      setError((err as Error).message || '加载灵感信箱失败')
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  useEffect(() => {
    const recordId = searchParams.get('recordId') || ''
    if (!recordId) return
    setFocusedRecordId(recordId)
    window.setTimeout(() => {
      document.getElementById(`insight-record-${recordId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
    void window.electronAPI.insight.markRecordRead(recordId)
  }, [searchParams])

  const groupedRecords = useMemo(() => {
    const groups: Array<{ label: string; records: InsightRecordSummary[] }> = []
    for (const record of records) {
      const label = formatGroupDate(record.createdAt)
      const last = groups[groups.length - 1]
      if (last?.label === label) {
        last.records.push(record)
      } else {
        groups.push({ label, records: [record] })
      }
    }
    return groups
  }, [records])

  const filteredContacts = useMemo(() => {
    const normalized = contactSearch.trim().toLowerCase()
    if (!normalized) return contacts
    return contacts.filter((contact) => {
      const text = `${contact.displayName}\n${contact.sessionId}`.toLowerCase()
      return text.includes(normalized)
    })
  }, [contactSearch, contacts])

  const openChat = (record: InsightRecordSummary) => {
    navigate(`/chat?sessionId=${encodeURIComponent(record.sessionId)}`)
  }

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setMessage(successText)
      window.setTimeout(() => setMessage(''), 1800)
    } catch {
      setMessage('复制失败')
      window.setTimeout(() => setMessage(''), 1800)
    }
  }

  const openLog = async (recordId: string) => {
    const result = await window.electronAPI.insight.getRecord(recordId)
    if (!result.success || !result.record) {
      setMessage(result.error || '读取请求日志失败')
      window.setTimeout(() => setMessage(''), 1800)
      return
    }
    setLogRecord(result.record)
    void window.electronAPI.insight.markRecordRead(recordId)
    setRecords((prev) => prev.map((record) => record.id === recordId ? { ...record, read: true } : record))
  }

  const clearFocusedRecord = () => {
    setFocusedRecordId('')
    searchParams.delete('recordId')
    setSearchParams(searchParams, { replace: true })
  }

  return (
    <div className="insight-inbox-page">
      <section className="insight-inbox-main">
        <header className="insight-inbox-header">
          <div className="insight-inbox-title-block">
            <div className="insight-inbox-title-line">
              <img src={INSIGHT_AVATAR_URL} alt="" className="insight-inbox-logo" />
              <h2>灵感信箱</h2>
            </div>
            <div className="insight-inbox-stats">
              <span>共 {stats.total} 条</span>
              <span>今天 {stats.todayCount} 条</span>
              <span>未读 {stats.unreadCount} 条</span>
            </div>
          </div>
          <button className="insight-icon-btn" onClick={() => { void loadRecords() }} title="刷新">
            <RefreshCw size={18} className={loading ? 'spinning' : ''} />
          </button>
        </header>

        {focusedRecordId && (
          <div className="insight-focus-bar">
            <Sparkles size={15} />
            <span>已定位通知中的见解</span>
            <button type="button" onClick={clearFocusedRecord}>取消定位</button>
          </div>
        )}

        <div className="insight-record-scroll">
          {error && (
            <div className="insight-empty-state">
              <span>{error}</span>
              <button onClick={() => { void loadRecords() }}>重试</button>
            </div>
          )}

          {!error && loading && records.length === 0 && (
            <div className="insight-empty-state">
              <RefreshCw size={18} className="spinning" />
              <span>正在加载灵感信箱...</span>
            </div>
          )}

          {!error && !loading && records.length === 0 && (
            <div className="insight-empty-state">
              <Sparkles size={36} />
              <strong>暂无见解</strong>
              <span>AI 见解生成后会自动保存在这里。</span>
            </div>
          )}

          {groupedRecords.map((group) => (
            <div className="insight-date-group" key={group.label}>
              <div className="insight-date-label">{group.label}</div>
              {group.records.map((record) => (
                <article
                  id={`insight-record-${record.id}`}
                  key={record.id}
                  className={`insight-card ${record.read ? '' : 'unread'} ${focusedRecordId === record.id ? 'focused' : ''}`}
                >
                  <div className="insight-card-avatar">
                    <Avatar src={INSIGHT_AVATAR_URL} name="见解" size={44} shape="rounded" lazy={false} />
                  </div>
                  <div className="insight-card-content">
                    <div className="insight-card-header">
                      <div className="insight-recipient">
                        <Avatar src={record.avatarUrl} name={record.displayName} size={28} shape="rounded" />
                        <div className="insight-recipient-text">
                          <span className="insight-recipient-name">发给 {record.displayName}</span>
                          <span className="insight-session-id">{record.sessionId}</span>
                        </div>
                      </div>
                      <div className="insight-card-actions">
                        <span className={`insight-trigger-pill ${record.triggerReason}`}>{getTriggerLabel(record.triggerReason)}</span>
                        <span className="insight-time">{formatRecordTime(record.createdAt)}</span>
                        <button className="insight-action-btn" onClick={() => openChat(record)} title="打开聊天">
                          <MessageSquare size={14} />
                        </button>
                        <button className="insight-action-btn" onClick={() => { void copyText(record.insight, '见解已复制') }} title="复制见解">
                          <Copy size={14} />
                        </button>
                        <button className="insight-action-btn code" onClick={() => { void openLog(record.id) }} title="查看请求日志">
                          <Code size={14} />
                        </button>
                      </div>
                    </div>
                    <p className="insight-body">{record.insight}</p>
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      </section>

      <aside className="insight-filter-panel">
        <div className="insight-filter-header">
          <h3>筛选条件</h3>
        </div>

        <div className="insight-filter-widget">
          <div className="insight-widget-title">
            <Search size={14} />
            <span>关键词搜索</span>
          </div>
          <div className="insight-input-wrap">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索见解或联系人..."
            />
            {keyword && <button onClick={() => setKeyword('')}><X size={14} /></button>}
          </div>
        </div>

        <div className="insight-filter-widget">
          <div className="insight-widget-title">
            <CalendarDays size={14} />
            <span>日期范围</span>
          </div>
          <div className="insight-date-tabs">
            {[
              { value: 'all', label: '全部' },
              { value: 'today', label: '今天' },
              { value: 'week', label: '近 7 天' },
              { value: 'custom', label: '自定义' }
            ].map((option) => (
              <button
                key={option.value}
                className={dateMode === option.value ? 'active' : ''}
                onClick={() => setDateMode(option.value as DateFilterMode)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {dateMode === 'custom' && (
            <div className="insight-custom-dates">
              <input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
              <input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
            </div>
          )}
        </div>

        <div className="insight-filter-widget contact-filter">
          <div className="insight-widget-title">
            <MessageSquare size={14} />
            <span>聊天对象</span>
            <span className="insight-widget-count">{contacts.length}</span>
          </div>
          <div className="insight-input-wrap">
            <input
              value={contactSearch}
              onChange={(event) => setContactSearch(event.target.value)}
              placeholder="查找联系人..."
            />
            {contactSearch && <button onClick={() => setContactSearch('')}><X size={14} /></button>}
          </div>
          <button
            className={`insight-contact-row all ${selectedSessionId ? '' : 'active'}`}
            onClick={() => setSelectedSessionId('')}
          >
            <span>全部联系人</span>
            <strong>{contacts.reduce((sum, contact) => sum + contact.count, 0)}</strong>
          </button>
          <div className="insight-contact-list">
            {filteredContacts.map((contact) => (
              <button
                key={contact.sessionId}
                className={`insight-contact-row ${selectedSessionId === contact.sessionId ? 'active' : ''}`}
                onClick={() => setSelectedSessionId(contact.sessionId)}
              >
                <Avatar src={contact.avatarUrl} name={contact.displayName} size={32} shape="rounded" />
                <span>{contact.displayName}</span>
                <strong>{contact.count}</strong>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {logRecord && (
        <div className="insight-modal-overlay" onClick={() => setLogRecord(null)}>
          <div className="insight-log-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="insight-log-header">
              <div>
                <h3>请求日志</h3>
                <span>{logRecord.displayName} · {formatRecordTime(logRecord.createdAt)}</span>
              </div>
              <div className="insight-log-actions">
                <button onClick={() => { void copyText(buildLogText(logRecord), '请求日志已复制') }}>
                  <Copy size={15} />
                  复制
                </button>
                <button className="close" onClick={() => setLogRecord(null)}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="insight-log-body">
              <section>
                <h4>请求参数</h4>
                <pre>{[
                  `Endpoint: ${logRecord.log.endpoint}`,
                  `Model: ${logRecord.log.model}`,
                  `Max Tokens: ${logRecord.log.maxTokens}`,
                  `Temperature: ${logRecord.log.temperature}`,
                  `Duration: ${logRecord.log.durationMs}ms`,
                  `Trigger: ${getTriggerLabel(logRecord.triggerReason)}`
                ].join('\n')}</pre>
              </section>
              <section>
                <h4>System Prompt</h4>
                <pre>{logRecord.log.systemPrompt}</pre>
              </section>
              <section>
                <h4>User Prompt</h4>
                <pre>{logRecord.log.userPrompt}</pre>
              </section>
              <section>
                <h4>模型输出</h4>
                <pre>{logRecord.log.rawOutput}</pre>
              </section>
              <section>
                <h4>最终见解</h4>
                <pre>{logRecord.log.finalInsight}</pre>
              </section>
            </div>
          </div>
        </div>
      )}

      {message && <div className="insight-copy-toast">{message}</div>}
    </div>
  )
}
