import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { Search, Download, FolderOpen, RefreshCw, Check, Calendar, FileJson, FileText, Table, Loader2, X, ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, Database, FileCode, CheckCircle, XCircle, ExternalLink } from 'lucide-react'
import * as configService from '../services/config'
import './ExportPage.scss'

interface ChatSession {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
}

interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'weclone' | 'sql'
  dateRange: { start: Date; end: Date } | null
  useAllTime: boolean
  exportAvatars: boolean
  exportMedia: boolean
  exportImages: boolean
  exportVoices: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoiceAsText: boolean
  excelCompactColumns: boolean
  txtColumns: string[]
  displayNamePreference: 'group-nickname' | 'remark' | 'nickname'
  exportConcurrency: number
}

interface ExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
}

type SessionLayout = 'shared' | 'per-session'

function ExportPage() {
  const location = useLocation()
  const defaultTxtColumns = ['index', 'time', 'senderRole', 'messageType', 'content']
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [filteredSessions, setFilteredSessions] = useState<ChatSession[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [exportFolder, setExportFolder] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, currentName: '', phaseLabel: '', phaseProgress: 0, phaseTotal: 0 })
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [calendarDate, setCalendarDate] = useState(new Date())
  const [selectingStart, setSelectingStart] = useState(true)
  const [showMediaLayoutPrompt, setShowMediaLayoutPrompt] = useState(false)
  const [showDisplayNameSelect, setShowDisplayNameSelect] = useState(false)
  const [showPreExportDialog, setShowPreExportDialog] = useState(false)
  const [preExportStats, setPreExportStats] = useState<{
    totalMessages: number; voiceMessages: number; cachedVoiceCount: number;
    needTranscribeCount: number; mediaMessages: number; estimatedSeconds: number
  } | null>(null)
  const [isLoadingStats, setIsLoadingStats] = useState(false)
  const [pendingLayout, setPendingLayout] = useState<SessionLayout>('shared')
  const exportStartTime = useRef<number>(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const displayNameDropdownRef = useRef<HTMLDivElement>(null)
  const preselectAppliedRef = useRef(false)

  const preselectSessionIds = useMemo(() => {
    const state = location.state as { preselectSessionIds?: unknown; preselectSessionId?: unknown } | null
    const rawList = Array.isArray(state?.preselectSessionIds)
      ? state?.preselectSessionIds
      : (typeof state?.preselectSessionId === 'string' ? [state.preselectSessionId] : [])

    return rawList
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  }, [location.state])

  const [options, setOptions] = useState<ExportOptions>({
    format: 'excel',
    dateRange: {
      start: new Date(new Date().setHours(0, 0, 0, 0)),
      end: new Date()
    },
    useAllTime: false,
    exportAvatars: true,
    exportMedia: false,
    exportImages: true,
    exportVoices: true,
    exportVideos: true,
    exportEmojis: true,
    exportVoiceAsText: false,
    excelCompactColumns: true,
    txtColumns: defaultTxtColumns,
    displayNamePreference: 'remark',
    exportConcurrency: 2
  })

  const buildDateRangeFromPreset = (preset: string) => {
    const now = new Date()
    if (preset === 'all') {
      return { useAllTime: true, dateRange: { start: now, end: now } }
    }
    let rangeMs = 0
    if (preset === '7d') rangeMs = 7 * 24 * 60 * 60 * 1000
    if (preset === '30d') rangeMs = 30 * 24 * 60 * 60 * 1000
    if (preset === '90d') rangeMs = 90 * 24 * 60 * 60 * 1000
    if (preset === 'today' || rangeMs === 0) {
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      return { useAllTime: false, dateRange: { start, end: now } }
    }
    const start = new Date(now.getTime() - rangeMs)
    start.setHours(0, 0, 0, 0)
    return { useAllTime: false, dateRange: { start, end: now } }
  }

  const loadSessions = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoading(false)
        return
      }
      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (sessionsResult.success && sessionsResult.sessions) {
        setSessions(sessionsResult.sessions)
        setFilteredSessions(sessionsResult.sessions)
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadExportPath = useCallback(async () => {
    try {
      const savedPath = await configService.getExportPath()
      if (savedPath) {
        setExportFolder(savedPath)
      } else {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        setExportFolder(downloadsPath)
      }
    } catch (e) {
      console.error('加载导出路径失败:', e)
    }
  }, [])

  const loadExportDefaults = useCallback(async () => {
    try {
      const [
        savedFormat,
        savedRange,
        savedMedia,
        savedVoiceAsText,
        savedExcelCompactColumns,
        savedTxtColumns,
        savedConcurrency
      ] = await Promise.all([
        configService.getExportDefaultFormat(),
        configService.getExportDefaultDateRange(),
        configService.getExportDefaultMedia(),
        configService.getExportDefaultVoiceAsText(),
        configService.getExportDefaultExcelCompactColumns(),
        configService.getExportDefaultTxtColumns(),
        configService.getExportDefaultConcurrency()
      ])

      const preset = savedRange || 'today'
      const rangeDefaults = buildDateRangeFromPreset(preset)
      const txtColumns = savedTxtColumns && savedTxtColumns.length > 0 ? savedTxtColumns : defaultTxtColumns

      setOptions((prev) => ({
        ...prev,
        format: (savedFormat as ExportOptions['format']) || 'excel',
        useAllTime: rangeDefaults.useAllTime,
        dateRange: rangeDefaults.dateRange,
        exportMedia: savedMedia ?? false,
        exportVoiceAsText: savedVoiceAsText ?? false,
        excelCompactColumns: savedExcelCompactColumns ?? true,
        txtColumns,
        exportConcurrency: savedConcurrency ?? 2
      }))
    } catch (e) {
      console.error('加载导出默认设置失败:', e)
    }
  }, [])

  useEffect(() => {
    loadSessions()
    loadExportPath()
    loadExportDefaults()
  }, [loadSessions, loadExportPath, loadExportDefaults])

  useEffect(() => {
    preselectAppliedRef.current = false
  }, [location.key, preselectSessionIds])

  useEffect(() => {
    if (preselectAppliedRef.current) return
    if (sessions.length === 0 || preselectSessionIds.length === 0) return

    const exists = new Set(sessions.map(session => session.username))
    const matched = preselectSessionIds.filter(id => exists.has(id))
    preselectAppliedRef.current = true

    if (matched.length > 0) {
      setSelectedSessions(new Set(matched))
      setSearchKeyword('')
    }
  }, [sessions, preselectSessionIds])

  useEffect(() => {
    const handleChange = () => {
      setSelectedSessions(new Set())
      setSearchKeyword('')
      setExportResult(null)
      setSessions([])
      setFilteredSessions([])
      loadSessions()
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [loadSessions])

  useEffect(() => {
    const removeListener = window.electronAPI.export.onProgress?.((payload: { current: number; total: number; currentSession: string; phase: string; phaseProgress?: number; phaseTotal?: number; phaseLabel?: string }) => {
      setExportProgress({
        current: payload.current,
        total: payload.total,
        currentName: payload.currentSession,
        phaseLabel: payload.phaseLabel || '',
        phaseProgress: payload.phaseProgress || 0,
        phaseTotal: payload.phaseTotal || 0
      })
    })
    return () => {
      removeListener?.()
    }
  }, [])

  // 导出计时器
  useEffect(() => {
    if (!isExporting) return
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - exportStartTime.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [isExporting])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (showDisplayNameSelect && displayNameDropdownRef.current && !displayNameDropdownRef.current.contains(target)) {
        setShowDisplayNameSelect(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDisplayNameSelect])

  useEffect(() => {
    if (!searchKeyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    const lower = searchKeyword.toLowerCase()
    setFilteredSessions(sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower)
    ))
  }, [searchKeyword, sessions])

  const toggleSession = (username: string) => {
    const newSet = new Set(selectedSessions)
    if (newSet.has(username)) {
      newSet.delete(username)
    } else {
      newSet.add(username)
    }
    setSelectedSessions(newSet)
  }

  const toggleSelectAll = () => {
    if (selectedSessions.size === filteredSessions.length) {
      setSelectedSessions(new Set())
    } else {
      setSelectedSessions(new Set(filteredSessions.map(s => s.username)))
    }
  }

  const getAvatarLetter = (name: string) => {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }

  const handleFormatChange = (format: ExportOptions['format']) => {
    setOptions((prev) => {
      const next = { ...prev, format }
      if (format === 'html') {
        return {
          ...next,
          exportMedia: true,
          exportImages: true,
          exportVoices: true,
          exportVideos: true,
          exportEmojis: true
        }
      }
      return next
    })
  }

  const openExportFolder = async () => {
    if (exportFolder) {
      await window.electronAPI.shell.openPath(exportFolder)
    }
  }

  const runExport = async (sessionLayout: SessionLayout) => {
    if (selectedSessions.size === 0 || !exportFolder) return

    setIsExporting(true)
    setExportProgress({ current: 0, total: selectedSessions.size, currentName: '', phaseLabel: '', phaseProgress: 0, phaseTotal: 0 })
    setExportResult(null)
    exportStartTime.current = Date.now()
    setElapsedSeconds(0)

    try {
      const sessionList = Array.from(selectedSessions)
      const exportOptions = {
        format: options.format,
        exportAvatars: options.exportAvatars,
        exportMedia: options.exportMedia,
        exportImages: options.exportMedia && options.exportImages,
        exportVoices: options.exportMedia && options.exportVoices,
        exportVideos: options.exportMedia && options.exportVideos,
        exportEmojis: options.exportMedia && options.exportEmojis,
        exportVoiceAsText: options.exportVoiceAsText,  // 即使不导出媒体，也可以导出语音转文字内容
        excelCompactColumns: options.excelCompactColumns,
        txtColumns: options.txtColumns,
        displayNamePreference: options.displayNamePreference,
        exportConcurrency: options.exportConcurrency,
        sessionLayout,
        dateRange: options.useAllTime ? null : options.dateRange ? {
          start: Math.floor(options.dateRange.start.getTime() / 1000),
          // 将结束日期设置为当天的 23:59:59，确保包含当天的所有记录
          end: Math.floor(new Date(options.dateRange.end.getFullYear(), options.dateRange.end.getMonth(), options.dateRange.end.getDate(), 23, 59, 59).getTime() / 1000)
        } : null
      }

      if (options.format === 'chatlab' || options.format === 'chatlab-jsonl' || options.format === 'json' || options.format === 'excel' || options.format === 'txt' || options.format === 'html' || options.format === 'weclone') {
        const result = await window.electronAPI.export.exportSessions(
          sessionList,
          exportFolder,
          exportOptions
        )
        setExportResult(result)
      } else {
        setExportResult({ success: false, error: `${options.format.toUpperCase()} 格式目前暂未实现，请选择其他格式。` })
      }
    } catch (e) {
      console.error('导出过程中发生异常:', e)
      setExportResult({ success: false, error: String(e) })
    } finally {
      setIsExporting(false)
    }
  }

  const startExport = async () => {
    if (selectedSessions.size === 0 || !exportFolder) return

    // 先获取预估统计
    setIsLoadingStats(true)
    setShowPreExportDialog(true)
    try {
      const sessionList = Array.from(selectedSessions)
      const exportOptions = {
        format: options.format,
        exportVoiceAsText: options.exportVoiceAsText,
        exportMedia: options.exportMedia,
        exportImages: options.exportMedia && options.exportImages,
        exportVoices: options.exportMedia && options.exportVoices,
        exportVideos: options.exportMedia && options.exportVideos,
        exportEmojis: options.exportMedia && options.exportEmojis,
        dateRange: options.useAllTime ? null : options.dateRange ? {
          start: Math.floor(options.dateRange.start.getTime() / 1000),
          end: Math.floor(new Date(options.dateRange.end.getFullYear(), options.dateRange.end.getMonth(), options.dateRange.end.getDate(), 23, 59, 59).getTime() / 1000)
        } : null
      }
      const stats = await window.electronAPI.export.getExportStats(sessionList, exportOptions)
      setPreExportStats(stats)
    } catch (e) {
      console.error('获取导出统计失败:', e)
      setPreExportStats(null)
    } finally {
      setIsLoadingStats(false)
    }
  }

  const confirmExport = () => {
    setShowPreExportDialog(false)
    setPreExportStats(null)

    if (options.exportMedia && selectedSessions.size > 1) {
      setShowMediaLayoutPrompt(true)
      return
    }

    const layout: SessionLayout = options.exportMedia ? 'per-session' : 'shared'
    runExport(layout)
  }

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date) => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month, 1).getDay()
  }

  const generateCalendar = () => {
    const daysInMonth = getDaysInMonth(calendarDate)
    const firstDay = getFirstDayOfMonth(calendarDate)
    const days: (number | null)[] = []

    for (let i = 0; i < firstDay; i++) {
      days.push(null)
    }

    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i)
    }

    return days
  }

  const handleDateSelect = (day: number) => {
    const year = calendarDate.getFullYear()
    const month = calendarDate.getMonth()
    const selectedDate = new Date(year, month, day)
    // 设置时间为当天的开始或结束
    selectedDate.setHours(selectingStart ? 0 : 23, selectingStart ? 0 : 59, selectingStart ? 0 : 59, selectingStart ? 0 : 999)

    const now = new Date()
    // 如果选择的日期晚于当前时间，限制为当前时间
    if (selectedDate > now) {
      selectedDate.setTime(now.getTime())
    }

    if (selectingStart) {
      // 选择开始日期
      const currentEnd = options.dateRange?.end || new Date()
      // 如果选择的开始日期晚于结束日期，则同时更新结束日期
      if (selectedDate > currentEnd) {
        const newEnd = new Date(selectedDate)
        newEnd.setHours(23, 59, 59, 999)
        // 确保结束日期也不晚于当前时间
        if (newEnd > now) {
          newEnd.setTime(now.getTime())
        }
        setOptions({
          ...options,
          dateRange: { start: selectedDate, end: newEnd }
        })
      } else {
        setOptions({
          ...options,
          dateRange: options.dateRange ? { ...options.dateRange, start: selectedDate } : { start: selectedDate, end: new Date() }
        })
      }
      setSelectingStart(false)
    } else {
      // 选择结束日期
      const currentStart = options.dateRange?.start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      // 如果选择的结束日期早于开始日期，则同时更新开始日期
      if (selectedDate < currentStart) {
        const newStart = new Date(selectedDate)
        newStart.setHours(0, 0, 0, 0)
        setOptions({
          ...options,
          dateRange: { start: newStart, end: selectedDate }
        })
      } else {
        setOptions({
          ...options,
          dateRange: options.dateRange ? { ...options.dateRange, end: selectedDate } : { start: new Date(), end: selectedDate }
        })
      }
      setSelectingStart(true)
    }
  }

  const formatOptions = [
    { value: 'chatlab', label: 'ChatLab', icon: FileCode, desc: '标准格式，支持其他软件导入' },
    { value: 'chatlab-jsonl', label: 'ChatLab JSONL', icon: FileCode, desc: '流式格式，适合大量消息' },
    { value: 'json', label: 'JSON', icon: FileJson, desc: '详细格式，包含完整消息信息' },
    { value: 'html', label: 'HTML', icon: FileText, desc: '网页格式，可直接浏览' },
    { value: 'txt', label: 'TXT', icon: Table, desc: '纯文本，通用格式' },
    { value: 'excel', label: 'Excel', icon: FileSpreadsheet, desc: '电子表格，适合统计分析' },
    { value: 'weclone', label: 'WeClone CSV', icon: Table, desc: 'WeClone 兼容字段格式（CSV）' },
    { value: 'sql', label: 'PostgreSQL', icon: Database, desc: '数据库脚本，便于导入到数据库' }
  ]
  const displayNameOptions = [
    {
      value: 'group-nickname',
      label: '群昵称优先',
      desc: '仅群聊有效，私聊显示备注/昵称'
    },
    {
      value: 'remark',
      label: '备注优先',
      desc: '有备注显示备注，否则显示昵称'
    },
    {
      value: 'nickname',
      label: '微信昵称',
      desc: '始终显示微信昵称'
    }
  ]
  const displayNameOption = displayNameOptions.find(option => option.value === options.displayNamePreference)
  const displayNameLabel = displayNameOption?.label || '备注优先'

  return (
    <div className="export-page">
      <div className="session-panel">
        <div className="panel-header">
          <h2>选择会话</h2>
          <button className="icon-btn" onClick={loadSessions} disabled={isLoading}>
            <RefreshCw size={18} className={isLoading ? 'spin' : ''} />
          </button>
        </div>

        <div className="search-bar">
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索联系人或群组..."
            value={searchKeyword}
            onChange={e => setSearchKeyword(e.target.value)}
          />
          {searchKeyword && (
            <button className="clear-btn" onClick={() => setSearchKeyword('')}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="select-actions">
          <button className="select-all-btn" onClick={toggleSelectAll}>
            {selectedSessions.size === filteredSessions.length && filteredSessions.length > 0 ? '取消全选' : '全选'}
          </button>
          <span className="selected-count">已选 {selectedSessions.size} 个</span>
        </div>

        {isLoading ? (
          <div className="loading-state">
            <Loader2 size={24} className="spin" />
            <span>加载中...</span>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="empty-state">
            <span>暂无会话</span>
          </div>
        ) : (
          <div className="export-session-list">
            {filteredSessions.map(session => (
              <div
                key={session.username}
                className={`export-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}
                onClick={() => toggleSession(session.username)}
              >
                <div className="check-box">
                  {selectedSessions.has(session.username) && <Check size={14} />}
                </div>
                <div className="export-avatar">
                  {session.avatarUrl ? (
                    <img src={session.avatarUrl} alt="" />
                  ) : (
                    <span>{getAvatarLetter(session.displayName || session.username)}</span>
                  )}
                </div>
                <div className="export-session-info">
                  <div className="export-session-name">{session.displayName || session.username}</div>
                  <div className="export-session-summary">{session.summary || '暂无消息'}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-panel">
        <div className="panel-header">
          <h2>导出设置</h2>
        </div>

        <div className="settings-content">
          <div className="setting-section">
            <h3>导出格式</h3>
            <div className="format-options">
              {formatOptions.map(fmt => (
                <div
                  key={fmt.value}
                  className={`format-card ${options.format === fmt.value ? 'active' : ''}`}
                  onClick={() => handleFormatChange(fmt.value as ExportOptions['format'])}
                >
                  <fmt.icon size={24} />
                  <span className="format-label">{fmt.label}</span>
                  <span className="format-desc">{fmt.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="setting-section">
            <h3>时间范围</h3>
            <p className="setting-subtitle">选择要导出的消息时间区间</p>
            <div className="media-options-card">
              <div className="media-switch-row">
                <div className="media-switch-info">
                  <span className="media-switch-title">导出全部时间</span>
                  <span className="media-switch-desc">关闭此项以选择特定的起止日期</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={options.useAllTime}
                    onChange={e => setOptions({ ...options, useAllTime: e.target.checked })}
                  />
                  <span className="switch-slider"></span>
                </label>
              </div>

              {!options.useAllTime && options.dateRange && (
                <>
                  <div className="media-option-divider"></div>
                  <div className="time-range-picker-item" onClick={() => setShowDatePicker(true)}>
                    <div className="time-picker-info">
                      <Calendar size={16} />
                      <span>{formatDate(options.dateRange.start)} - {formatDate(options.dateRange.end)}</span>
                    </div>
                    <ChevronDown size={14} />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 发送者名称显示偏好 */}
          {(options.format === 'html' || options.format === 'json' || options.format === 'txt') && (
            <div className="setting-section">
              <h3>发送者名称显示</h3>
              <p className="setting-subtitle">选择导出时优先显示的名称</p>
              <div className="select-field" ref={displayNameDropdownRef}>
                <button
                  type="button"
                  className={`select-trigger ${showDisplayNameSelect ? 'open' : ''}`}
                  onClick={() => setShowDisplayNameSelect(!showDisplayNameSelect)}
                >
                  <span className="select-value">{displayNameLabel}</span>
                  <ChevronDown size={16} />
                </button>
                {showDisplayNameSelect && (
                  <div className="select-dropdown">
                    {displayNameOptions.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        className={`select-option ${options.displayNamePreference === option.value ? 'active' : ''}`}
                        onClick={() => {
                          setOptions({
                            ...options,
                            displayNamePreference: option.value as ExportOptions['displayNamePreference']
                          })
                          setShowDisplayNameSelect(false)
                        }}
                      >
                        <span className="option-label">{option.label}</span>
                        <span className="option-desc">{option.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="setting-section">
            <h3>媒体文件</h3>
            <p className="setting-subtitle">导出图片/语音/视频/表情并在记录内写入相对路径</p>
            <div className="media-options-card">
              <div className="media-switch-row">
                <div className="media-switch-info">
                  <span className="media-switch-title">导出媒体文件</span>
                  <span className="media-switch-desc">会创建子文件夹并保存媒体资源</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={options.exportMedia}
                    onChange={e => setOptions({ ...options, exportMedia: e.target.checked })}
                  />
                  <span className="switch-slider"></span>
                </label>
              </div>

              <div className="media-option-divider"></div>

              <label className={`media-checkbox-row ${!options.exportMedia ? 'disabled' : ''}`}>
                <div className="media-checkbox-info">
                  <span className="media-checkbox-title">图片</span>
                  <span className="media-checkbox-desc">已有文件直接复制，缺失时尝试解密</span>
                </div>
                <input
                  type="checkbox"
                  checked={options.exportImages}
                  disabled={!options.exportMedia}
                  onChange={e => setOptions({ ...options, exportImages: e.target.checked })}
                />
              </label>

              <div className="media-option-divider"></div>

              <label className={`media-checkbox-row ${!options.exportMedia ? 'disabled' : ''}`}>
                <div className="media-checkbox-info">
                  <span className="media-checkbox-title">语音</span>
                  <span className="media-checkbox-desc">缺失时会解码生成 MP3</span>
                </div>
                <input
                  type="checkbox"
                  checked={options.exportVoices}
                  disabled={!options.exportMedia}
                  onChange={e => setOptions({ ...options, exportVoices: e.target.checked })}
                />
              </label>

              <div className="media-option-divider"></div>

              <label className="media-checkbox-row">
                <div className="media-checkbox-info">
                  <span className="media-checkbox-title">语音转文字</span>
                  <span className="media-checkbox-desc">将语音消息转换为文字导出</span>
                </div>
                <input
                  type="checkbox"
                  checked={options.exportVoiceAsText}
                  onChange={e => setOptions({ ...options, exportVoiceAsText: e.target.checked })}
                />
              </label>

              <div className="media-option-divider"></div>

              <label className={`media-checkbox-row ${!options.exportMedia ? 'disabled' : ''}`}>
                <div className="media-checkbox-info">
                  <span className="media-checkbox-title">视频</span>
                  <span className="media-checkbox-desc">直接复制视频文件到导出目录</span>
                </div>
                <input
                  type="checkbox"
                  checked={options.exportVideos}
                  disabled={!options.exportMedia}
                  onChange={e => setOptions({ ...options, exportVideos: e.target.checked })}
                />
              </label>

              <div className="media-option-divider"></div>

              <label className={`media-checkbox-row ${!options.exportMedia ? 'disabled' : ''}`}>
                <div className="media-checkbox-info">
                  <span className="media-checkbox-title">表情</span>
                  <span className="media-checkbox-desc">本地无缓存时尝试下载</span>
                </div>
                <input
                  type="checkbox"
                  checked={options.exportEmojis}
                  disabled={!options.exportMedia}
                  onChange={e => setOptions({ ...options, exportEmojis: e.target.checked })}
                />
              </label>
            </div>
          </div>

          <div className="setting-section">
            <h3>头像</h3>
            <p className="setting-subtitle">可选导出头像索引，关闭则不下载头像</p>
            <div className="media-options-card">
              <div className="media-switch-row">
                <div className="media-switch-info">
                  <span className="media-switch-title">导出头像</span>
                  <span className="media-switch-desc">用于展示发送者头像，可能会读取或下载头像文件</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={options.exportAvatars}
                    onChange={e => setOptions({ ...options, exportAvatars: e.target.checked })}
                  />
                  <span className="switch-slider"></span>
                </label>
              </div>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出位置</h3>
            <div className="export-path-display">
              <FolderOpen size={16} />
              <span>{exportFolder || '未设置'}</span>
            </div>
            <button
              className="select-folder-btn"
              onClick={async () => {
                try {
                  const result = await window.electronAPI.dialog.openFile({
                    title: '选择导出目录',
                    properties: ['openDirectory']
                  })
                  if (!result.canceled && result.filePaths.length > 0) {
                    setExportFolder(result.filePaths[0])
                    await configService.setExportPath(result.filePaths[0])
                  }
                } catch (e) {
                  console.error('选择目录失败:', e)
                }
              }}
            >
              <FolderOpen size={16} />
              <span>选择导出目录</span>
            </button>
          </div>
        </div>

        <div className="export-action">
          <button
            className="export-btn"
            onClick={startExport}
            disabled={selectedSessions.size === 0 || !exportFolder || isExporting}
          >
            {isExporting ? (
              <>
                <Loader2 size={18} className="spin" />
                <span>导出中 ({exportProgress.current}/{exportProgress.total})</span>
              </>
            ) : (
              <>
                <Download size={18} />
                <span>开始导出</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 媒体导出布局选择弹窗 */}
      {showMediaLayoutPrompt && (
        <div className="export-overlay" onClick={() => setShowMediaLayoutPrompt(false)}>
          <div className="export-layout-modal" onClick={e => e.stopPropagation()}>
            <h3>导出文件夹布局</h3>
            <p className="layout-subtitle">检测到同时导出多个会话并包含媒体文件，请选择存放方式：</p>
            <div className="layout-options">
              <button
                className="layout-option-btn primary"
                onClick={() => {
                  setShowMediaLayoutPrompt(false)
                  runExport('shared')
                }}
              >
                <span className="layout-title">所有会话在同一文件夹</span>
                <span className="layout-desc">媒体会按会话名归档到 media 子目录</span>
              </button>
              <button
                className="layout-option-btn"
                onClick={() => {
                  setShowMediaLayoutPrompt(false)
                  runExport('per-session')
                }}
              >
                <span className="layout-title">每个会话一个文件夹</span>
                <span className="layout-desc">每个会话单独包含导出文件和媒体</span>
              </button>
            </div>
            <div className="layout-actions">
              <button className="layout-cancel-btn" onClick={() => setShowMediaLayoutPrompt(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导出前预估弹窗 */}
      {showPreExportDialog && (
        <div className="export-overlay">
          <div className="export-layout-modal" onClick={e => e.stopPropagation()}>
            <h3>导出预估</h3>
            {isLoadingStats ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '24px 0', justifyContent: 'center' }}>
                <Loader2 size={20} className="spin" />
                <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>正在统计消息...</span>
              </div>
            ) : preExportStats ? (
              <div style={{ padding: '12px 0' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', fontSize: 14 }}>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>会话数</span>
                    <div style={{ fontWeight: 600, fontSize: 18, marginTop: 2 }}>{selectedSessions.size}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>总消息</span>
                    <div style={{ fontWeight: 600, fontSize: 18, marginTop: 2 }}>{preExportStats.totalMessages.toLocaleString()}</div>
                  </div>
                  {options.exportVoiceAsText && preExportStats.voiceMessages > 0 && (
                    <>
                      <div>
                        <span style={{ color: 'var(--text-secondary)' }}>语音消息</span>
                        <div style={{ fontWeight: 600, fontSize: 18, marginTop: 2 }}>{preExportStats.voiceMessages}</div>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-secondary)' }}>已有缓存</span>
                        <div style={{ fontWeight: 600, fontSize: 18, marginTop: 2, color: 'var(--primary)' }}>{preExportStats.cachedVoiceCount}</div>
                      </div>
                    </>
                  )}
                </div>
                {options.exportVoiceAsText && preExportStats.needTranscribeCount > 0 && (
                  <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 13 }}>
                    <span style={{ color: 'var(--text-warning, #e6a23c)' }}>⚠</span>
                    {' '}需要转写 <b>{preExportStats.needTranscribeCount}</b> 条语音，预计耗时约 <b>{preExportStats.estimatedSeconds > 60
                      ? `${Math.round(preExportStats.estimatedSeconds / 60)} 分钟`
                      : `${preExportStats.estimatedSeconds} 秒`
                    }</b>
                  </div>
                )}
                {options.exportVoiceAsText && preExportStats.voiceMessages > 0 && preExportStats.needTranscribeCount === 0 && (
                  <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 13 }}>
                    <span style={{ color: 'var(--text-success, #67c23a)' }}>✓</span>
                    {' '}所有 {preExportStats.voiceMessages} 条语音已有转写缓存，无需重新转写
                  </div>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 14, color: 'var(--text-secondary)', padding: '16px 0' }}>统计信息获取失败，仍可继续导出</p>
            )}
            <div className="layout-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="layout-cancel-btn" onClick={() => { setShowPreExportDialog(false); setPreExportStats(null) }}>
                取消
              </button>
              <button className="layout-option-btn primary" onClick={confirmExport} disabled={isLoadingStats}>
                <span className="layout-title">开始导出</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导出进度弹窗 */}
      {isExporting && (
        <div className="export-overlay">
          <div className="export-progress-modal">
            <div className="progress-spinner">
              <Loader2 size={32} className="spin" />
            </div>
            <h3>正在导出</h3>
            <p className="progress-text">{exportProgress.currentName}</p>
            {exportProgress.phaseLabel && (
              <p className="progress-phase-label" style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 8px' }}>
                {exportProgress.phaseLabel}
              </p>
            )}
            {exportProgress.phaseTotal > 0 && (
              <div className="progress-bar" style={{ marginBottom: 8 }}>
                <div
                  className="progress-fill"
                  style={{ width: `${(exportProgress.phaseProgress / exportProgress.phaseTotal) * 100}%`, background: 'var(--primary-light, #79bbff)' }}
                />
              </div>
            )}
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${exportProgress.total > 0 ? (exportProgress.current / exportProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="progress-count">
              {exportProgress.current} / {exportProgress.total} 个会话
              <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                {elapsedSeconds > 0 && `已用 ${elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒` : `${elapsedSeconds}秒`}`}
              </span>
            </p>
          </div>
        </div>
      )}

      {/* 导出结果弹窗 */}
      {exportResult && (
        <div className="export-overlay">
          <div className="export-result-modal">
            <div className={`result-icon ${exportResult.success ? 'success' : 'error'}`}>
              {exportResult.success ? <CheckCircle size={48} /> : <XCircle size={48} />}
            </div>
            <h3>{exportResult.success ? '导出完成' : '导出失败'}</h3>
            {exportResult.success ? (
              <p className="result-text">
                成功导出 {exportResult.successCount} 个会话
                {exportResult.failCount ? `，${exportResult.failCount} 个失败` : ''}
              </p>
            ) : (
              <p className="result-text error">{exportResult.error}</p>
            )}
            <div className="result-actions">
              {exportResult.success && (
                <button className="open-folder-btn" onClick={openExportFolder}>
                  <ExternalLink size={16} />
                  <span>打开文件夹</span>
                </button>
              )}
              <button className="close-btn" onClick={() => setExportResult(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 日期选择弹窗 */}
      {showDatePicker && (
        <div className="export-overlay" onClick={() => setShowDatePicker(false)}>
          <div className="date-picker-modal" onClick={e => e.stopPropagation()}>
            <h3>选择时间范围</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '8px 0 16px 0' }}>
              点击选择开始和结束日期，系统会自动调整确保时间顺序正确
            </p>
            <div className="quick-select">
              <button
                className="quick-btn"
                onClick={() => {
                  const end = new Date()
                  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)
                  setOptions({ ...options, dateRange: { start, end } })
                }}
              >
                最近7天
              </button>
              <button
                className="quick-btn"
                onClick={() => {
                  const end = new Date()
                  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000)
                  setOptions({ ...options, dateRange: { start, end } })
                }}
              >
                最近30天
              </button>
              <button
                className="quick-btn"
                onClick={() => {
                  const end = new Date()
                  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000)
                  setOptions({ ...options, dateRange: { start, end } })
                }}
              >
                最近90天
              </button>
            </div>
            <div className="date-display">
              <div
                className={`date-display-item ${selectingStart ? 'active' : ''}`}
                onClick={() => setSelectingStart(true)}
              >
                <span className="date-label">开始日期</span>
                <span className="date-value">
                  {options.dateRange?.start.toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                  })}
                </span>
              </div>
              <span className="date-separator">至</span>
              <div
                className={`date-display-item ${!selectingStart ? 'active' : ''}`}
                onClick={() => setSelectingStart(false)}
              >
                <span className="date-label">结束日期</span>
                <span className="date-value">
                  {options.dateRange?.end.toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                  })}
                </span>
              </div>
            </div>
            <div className="calendar-container">
              <div className="calendar-header">
                <button
                  className="calendar-nav-btn"
                  onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1))}
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="calendar-month">
                  {calendarDate.getFullYear()}年{calendarDate.getMonth() + 1}月
                </span>
                <button
                  className="calendar-nav-btn"
                  onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1))}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <div className="calendar-weekdays">
                {['日', '一', '二', '三', '四', '五', '六'].map(day => (
                  <div key={day} className="calendar-weekday">{day}</div>
                ))}
              </div>
              <div className="calendar-days">
                {generateCalendar().map((day, index) => {
                  if (day === null) {
                    return <div key={`empty-${index}`} className="calendar-day empty" />
                  }

                  const currentDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), day)
                  const isStart = options.dateRange?.start.toDateString() === currentDate.toDateString()
                  const isEnd = options.dateRange?.end.toDateString() === currentDate.toDateString()
                  const isInRange = options.dateRange && currentDate >= options.dateRange.start && currentDate <= options.dateRange.end
                  const today = new Date()
                  today.setHours(0, 0, 0, 0)
                  const isFuture = currentDate > today

                  return (
                    <div
                      key={day}
                      className={`calendar-day ${isStart ? 'start' : ''} ${isEnd ? 'end' : ''} ${isInRange ? 'in-range' : ''} ${isFuture ? 'disabled' : ''}`}
                      onClick={() => !isFuture && handleDateSelect(day)}
                      style={{ cursor: isFuture ? 'not-allowed' : 'pointer', opacity: isFuture ? 0.3 : 1 }}
                    >
                      {day}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="date-picker-actions">
              <button className="cancel-btn" onClick={() => setShowDatePicker(false)}>
                取消
              </button>
              <button className="confirm-btn" onClick={() => setShowDatePicker(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExportPage
