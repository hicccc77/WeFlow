import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronDown, ChevronUp, Download, Clock, User, MessageSquare, Cpu, CheckCircle, AlertCircle, Edit2, Save, Globe, X, Loader2 } from 'lucide-react'
import './CoachLogPage.scss'

interface CoachLogEntry {
  id: string
  timestamp: string
  contact: string
  messageSummary: string
  model: string
  duration: number
  status: 'success' | 'error' | 'pending'
}

interface CoachLogDetail {
  id: string
  relationContext: string
  historyContext: string
  personalityContext: string
  systemPrompt: string
  userPrompt: string
}

function CoachLogPage() {
  const navigate = useNavigate()
  const [entries, setEntries] = useState<CoachLogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedLog, setSelectedLog] = useState<string | null>(null)
  const [detail, setDetail] = useState<CoachLogDetail | null>(null)
  const [detailEntry, setDetailEntry] = useState<CoachLogEntry | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['systemPrompt', 'userPrompt']))
  const [editingSection, setEditingSection] = useState<string | null>(null)
  const [editedContent, setEditedContent] = useState('')
  const [applyScope, setApplyScope] = useState<'global' | 'session' | null>(null)

  useEffect(() => {
    async function loadLogs() {
      setIsLoading(true)
      try {
        const result = await window.electronAPI.coachLog.list()
        if (result && Array.isArray(result)) {
          setEntries(result.map((entry: any) => ({
            id: String(entry.id),
            timestamp: entry.timestamp || entry.created_at || '',
            contact: entry.contact || '',
            messageSummary: (entry.incoming_message || entry.incomingMessage || '').slice(0, 50),
            model: entry.model_used || entry.modelUsed || 'unknown',
            duration: ((entry.duration_ms || entry.durationMs || 0) / 1000),
            status: entry.duration_ms ? 'success' : 'error',
          })))
        }
      } catch (e) {
        console.error('Failed to load coach logs:', e)
      } finally {
        setIsLoading(false)
      }
    }
    loadLogs()
  }, [])

  const loadDetail = async (logId: string) => {
    setSelectedLog(logId)
    try {
      const result = await window.electronAPI.coachLog.getDetail(Number(logId))
      if (result) {
        setDetail({
          id: logId,
          relationContext: result.context_bundle?.rel_context || result.relationContext || '无数据',
          historyContext: result.context_bundle?.history_context || result.historyContext || '无数据',
          personalityContext: result.context_bundle?.personality_context || result.personalityContext || '无数据',
          systemPrompt: result.system_prompt || result.systemPrompt || '无数据',
          userPrompt: result.user_prompt || result.userPrompt || '无数据',
        })
        setDetailEntry(entries.find(e => e.id === logId) || null)
      }
    } catch (e) {
      console.error('Failed to load log detail:', e)
    }
  }

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const startEditing = (section: string, content: string) => {
    setEditingSection(section)
    setEditedContent(content)
  }

  const saveEdit = async () => {
    if (editingSection && applyScope === 'global') {
      try {
        await window.electronAPI.coachLog.updateConfig(editingSection, editedContent)
      } catch (e) {
        console.error('Failed to save config:', e)
      }
    }
    setEditingSection(null)
    setApplyScope(null)
  }

  const downloadJson = () => {
    if (!detail) return
    const data = JSON.stringify(detail, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `coach-log-${selectedLog}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const getStatusIcon = (status: string) => {
    if (status === 'success') return <CheckCircle size={14} className="status-success" />
    if (status === 'error') return <AlertCircle size={14} className="status-error" />
    return <Clock size={14} className="status-pending" />
  }

  // Detail view
  if (selectedLog && detail) {
    const sections = [
      { key: 'relationContext', label: '关系上下文', content: detail.relationContext },
      { key: 'historyContext', label: '历史上下文', content: detail.historyContext },
      { key: 'personalityContext', label: '性格上下文', content: detail.personalityContext },
      { key: 'systemPrompt', label: '系统提示词', content: detail.systemPrompt },
      { key: 'userPrompt', label: '用户提示词', content: detail.userPrompt },
    ]

    return (
      <div className="coach-log-page">
        <div className="coach-log-detail">
          <div className="detail-top-bar">
            <button className="back-btn" onClick={() => { setSelectedLog(null); setDetail(null) }}>
              <ArrowLeft size={16} /> 返回列表
            </button>
            <div className="detail-top-meta">
              <span>{detailEntry?.contact}</span>
              <span className="dot">·</span>
              <span>{detailEntry?.timestamp}</span>
            </div>
            <button className="download-btn" onClick={downloadJson}>
              <Download size={14} /> 下载 JSON
            </button>
          </div>

          <div className="detail-sections">
            {sections.map(section => (
              <div key={section.key} className="detail-collapse-section">
                <button
                  className="collapse-header"
                  onClick={() => toggleSection(section.key)}
                >
                  {expandedSections.has(section.key)
                    ? <ChevronUp size={16} />
                    : <ChevronDown size={16} />
                  }
                  <span>{section.label}</span>
                  <button
                    className="edit-btn"
                    onClick={e => {
                      e.stopPropagation()
                      startEditing(section.key, section.content)
                    }}
                  >
                    <Edit2 size={12} />
                  </button>
                </button>

                {expandedSections.has(section.key) && (
                  <div className="collapse-body">
                    {editingSection === section.key ? (
                      <div className="section-editor">
                        <textarea
                          value={editedContent}
                          onChange={e => setEditedContent(e.target.value)}
                          rows={10}
                        />
                        <div className="editor-actions">
                          <div className="apply-scope-options">
                            <label>
                              <input
                                type="radio"
                                name="scope"
                                checked={applyScope === 'global'}
                                onChange={() => setApplyScope('global')}
                              />
                              <Globe size={12} /> 全局应用
                            </label>
                            <label>
                              <input
                                type="radio"
                                name="scope"
                                checked={applyScope === 'session'}
                                onChange={() => setApplyScope('session')}
                              />
                              <MessageSquare size={12} /> 仅当前会话
                            </label>
                          </div>
                          <div className="editor-btns">
                            <button className="cancel-btn" onClick={() => setEditingSection(null)}>
                              <X size={12} /> 取消
                            </button>
                            <button className="save-btn" onClick={saveEdit}>
                              <Save size={12} /> 保存
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <pre className="section-content">{section.content}</pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="coach-log-page">
      <div className="coach-log-list">
        <div className="list-header">
          <button className="back-btn" onClick={() => navigate('/assistant')}>
            <ArrowLeft size={16} /> 返回沟通助手
          </button>
          <h2>调试日志</h2>
        </div>

        {isLoading ? (
          <div className="log-loading">
            <Loader2 size={20} className="spinning" />
            <span>加载日志...</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="log-empty">
            <MessageSquare size={32} />
            <p>暂无调试日志，使用沟通助手分析消息后会自动记录</p>
          </div>
        ) : (
          <div className="log-table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th><Clock size={12} /> 时间</th>
                  <th><User size={12} /> 联系人</th>
                  <th><MessageSquare size={12} /> 消息摘要</th>
                  <th><Cpu size={12} /> 模型</th>
                  <th>耗时</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} onClick={() => loadDetail(entry.id)}>
                    <td className="cell-time">{entry.timestamp}</td>
                    <td className="cell-contact">{entry.contact}</td>
                    <td className="cell-summary">{entry.messageSummary}</td>
                    <td className="cell-model">{entry.model}</td>
                    <td className="cell-duration">{entry.duration.toFixed(1)}s</td>
                    <td className="cell-status">{getStatusIcon(entry.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default CoachLogPage
