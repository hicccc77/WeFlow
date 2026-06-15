import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, AtSign, CheckCircle2, Download, Loader2, MessageCircle, RefreshCw, Search, Sparkles, Users } from 'lucide-react'
import DateRangePicker from '../components/DateRangePicker'
import './MyFootprintPage.scss'

type RangePreset = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'custom'
type TimelineMode = 'all' | 'mention' | 'private'
type TimelineTimeMode = 'clock' | 'month_day_clock' | 'full_date_clock'
type PrivateDotVariant = 'both' | 'inbound_only' | 'outbound_only'
type ExportModalStatus = 'idle' | 'progress' | 'success' | 'error'
type FootprintAiStatus = 'idle' | 'loading' | 'success' | 'error'

interface MyFootprintSummary {
  private_inbound_people: number
  private_replied_people: number
  private_outbound_people: number
  private_reply_rate: number
  mention_count: number
  mention_group_count: number
}

interface MyFootprintPrivateSession {
  session_id: string
  incoming_count: number
  outgoing_count: number
  replied: boolean
  first_incoming_ts: number
  first_reply_ts: number
  latest_ts: number
  anchor_local_id: number
  anchor_create_time: number
  displayName?: string
  avatarUrl?: string
}

interface MyFootprintPrivateSegment {
  session_id: string
  segment_index: number
  start_ts: number
  end_ts: number
  duration_sec: number
  incoming_count: number
  outgoing_count: number
  message_count: number
  replied: boolean
  first_incoming_ts: number
  first_reply_ts: number
  latest_ts: number
  anchor_local_id: number
  anchor_create_time: number
  displayName?: string
  avatarUrl?: string
}

interface MyFootprintMention {
  session_id: string
  local_id: number
  create_time: number
  sender_username: string
  message_content: string
  source: string
  sessionDisplayName?: string
  senderDisplayName?: string
  senderAvatarUrl?: string
}

interface MyFootprintMentionGroup {
  session_id: string
  count: number
  latest_ts: number
  displayName?: string
  avatarUrl?: string
}

interface MyFootprintDiagnostics {
  truncated: boolean
  scanned_dbs: number
  elapsed_ms: number
  mention_truncated?: boolean
  private_truncated?: boolean
}

interface MyFootprintData {
  summary: MyFootprintSummary
  private_sessions: MyFootprintPrivateSession[]
  private_segments: MyFootprintPrivateSegment[]
  mentions: MyFootprintMention[]
  mention_groups: MyFootprintMentionGroup[]
  diagnostics: MyFootprintDiagnostics
}

interface TimelineBoundaryItem {
  kind: 'boundary'
  edge: 'start' | 'end'
  key: string
  time: number
  label: string
}

interface TimelineMentionItem {
  kind: 'mention'
  key: string
  time: number
  sessionId: string
  localId: number
  createTime: number
  groupName: string
  groupAvatarUrl?: string
  senderName: string
  messageContent: string
}

interface TimelinePrivateItem {
  kind: 'private'
  key: string
  time: number
  endTime: number
  sessionId: string
  anchorLocalId: number
  anchorCreateTime: number
  displayName: string
  avatarUrl?: string
  subtitle: string
  totalInteractions: number
  summaryText: string
  dotVariant: PrivateDotVariant
  isRange: boolean
}

type TimelineItem = TimelineBoundaryItem | TimelineMentionItem | TimelinePrivateItem

const EMPTY_DATA: MyFootprintData = {
  summary: {
    private_inbound_people: 0,
    private_replied_people: 0,
    private_outbound_people: 0,
    private_reply_rate: 0,
    mention_count: 0,
    mention_group_count: 0
  },
  private_sessions: [],
  private_segments: [],
  mentions: [],
  mention_groups: [],
  diagnostics: {
    truncated: false,
    scanned_dbs: 0,
    elapsed_ms: 0,
    mention_truncated: false,
    private_truncated: false
  }
}

function toDayStart(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function toDayEnd(date: Date): Date {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

function toSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

function toDateInputValue(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getWeekStart(date: Date): Date {
  const base = toDayStart(date)
  const day = base.getDay()
  const diff = day === 0 ? -6 : 1 - day
  base.setDate(base.getDate() + diff)
  return base
}

function formatTimelineMoment(seconds: number, mode: TimelineTimeMode): string {
  if (!seconds || !Number.isFinite(seconds)) return '--'
  const date = new Date(seconds * 1000)
  const yyyy = `${date.getFullYear()}`
  const mm = `${date.getMonth() + 1}`.padStart(2, '0')
  const dd = `${date.getDate()}`.padStart(2, '0')
  const hh = `${date.getHours()}`.padStart(2, '0')
  const min = `${date.getMinutes()}`.padStart(2, '0')
  if (mode === 'full_date_clock') {
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`
  }
  if (mode === 'month_day_clock') {
    return `${mm}-${dd} ${hh}:${min}`
  }
  return `${hh}:${min}`
}

function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0
  return `${(safe * 100).toFixed(1)}%`
}

function decodeHtmlEntities(content: string): string {
  return String(content || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function stripGroupSenderPrefix(content: string): string {
  return String(content || '')
    .replace(/^[\s]*([a-zA-Z0-9_@-]+):(?!\/\/)(?:\s*(?:\r?\n|<br\s*\/?>)\s*|\s*)/i, '')
    .replace(/^[a-zA-Z0-9]+@openim:\n?/i, '')
}

function normalizeFootprintMessageContent(content: string): string {
  const decoded = decodeHtmlEntities(content || '')
  const stripped = stripGroupSenderPrefix(decoded)
  return stripped.trim()
}

function renderMentionContent(content: string): ReactNode {
  const normalized = String(content || '').trim() || '[空消息]'
  const parts = normalized.split(/(@我|＠我)/g)
  if (parts.length <= 1) return normalized
  return parts.map((part, index) => {
    if (part === '@我' || part === '＠我') {
      return (
        <span key={index} className="mention-token">
          {part}
        </span>
      )
    }
    return <span key={index}>{part}</span>
  })
}

function formatDurationLabel(beginTimestamp: number, endTimestamp: number): string {
  if (!beginTimestamp || !endTimestamp || endTimestamp <= beginTimestamp) {
    return '持续不足 1 分钟'
  }
  const minutes = Math.max(1, Math.round((endTimestamp - beginTimestamp) / 60))
  return `持续 ${minutes} 分钟`
}

function resolveRangePresetLabel(preset: RangePreset): string {
  switch (preset) {
    case 'today':
      return '今天'
    case 'yesterday':
      return '昨天'
    case 'this_week':
      return '本周'
    case 'last_week':
      return '上周'
    default:
      return '自定义'
  }
}

function buildRange(preset: RangePreset, customStart: string, customEnd: string): { begin: number; end: number; label: string } {
  const now = new Date()

  if (preset === 'today') {
    return {
      begin: toSeconds(toDayStart(now)),
      end: toSeconds(now),
      label: '今天'
    }
  }

  if (preset === 'yesterday') {
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    return {
      begin: toSeconds(toDayStart(yesterday)),
      end: toSeconds(toDayEnd(yesterday)),
      label: '昨天'
    }
  }

  if (preset === 'this_week') {
    const weekStart = getWeekStart(now)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    return {
      begin: toSeconds(toDayStart(weekStart)),
      end: toSeconds(toDayEnd(weekEnd)),
      label: '本周'
    }
  }

  if (preset === 'last_week') {
    const thisWeekStart = getWeekStart(now)
    const lastWeekStart = new Date(thisWeekStart)
    lastWeekStart.setDate(lastWeekStart.getDate() - 7)
    const lastWeekEnd = new Date(thisWeekStart)
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 1)
    return {
      begin: toSeconds(toDayStart(lastWeekStart)),
      end: toSeconds(toDayEnd(lastWeekEnd)),
      label: '上周'
    }
  }

  const customStartDate = customStart ? new Date(`${customStart}T00:00:00`) : toDayStart(now)
  const customEndDate = customEnd ? new Date(`${customEnd}T23:59:59`) : toDayEnd(now)
  const begin = toSeconds(customStartDate)
  const end = Math.max(begin, toSeconds(customEndDate))

  return {
    begin,
    end,
    label: `${toDateInputValue(customStartDate)} 至 ${toDateInputValue(customEndDate)}`
  }
}

function MyFootprintPage() {
  const navigate = useNavigate()
  const [preset, setPreset] = useState<RangePreset>('today')
  const [customStartDate, setCustomStartDate] = useState(() => toDateInputValue(toDayStart(new Date())))
  const [customEndDate, setCustomEndDate] = useState(() => toDateInputValue(toDayStart(new Date())))
  const [searchKeyword, setSearchKeyword] = useState('')
  const [timelineMode, setTimelineMode] = useState<TimelineMode>('all')
  const [data, setData] = useState<MyFootprintData>(EMPTY_DATA)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportModalStatus, setExportModalStatus] = useState<ExportModalStatus>('idle')
  const [exportModalTitle, setExportModalTitle] = useState('')
  const [exportModalDescription, setExportModalDescription] = useState('')
  const [exportModalPath, setExportModalPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [footprintAiStatus, setFootprintAiStatus] = useState<FootprintAiStatus>('idle')
  const [footprintAiText, setFootprintAiText] = useState('')
  const inflightRangeKeyRef = useRef<string | null>(null)

  const currentRange = useMemo(() => buildRange(preset, customStartDate, customEndDate), [preset, customStartDate, customEndDate])
  const timelineTimeMode = useMemo<TimelineTimeMode>(() => {
    const span = Math.max(0, currentRange.end - currentRange.begin)
    if (span > 365 * 24 * 60 * 60) return 'full_date_clock'
    if (span > 24 * 60 * 60) return 'month_day_clock'
    return 'clock'
  }, [currentRange.begin, currentRange.end])

  const handleJump = useCallback((sessionId: string, localId: number, createTime: number) => {
    if (!sessionId || !localId || !createTime) return
    const query = new URLSearchParams({
      sessionId,
      jumpLocalId: String(localId),
      jumpCreateTime: String(createTime),
      jumpSource: 'footprint'
    })
    navigate(`/chat?${query.toString()}`)
  }, [navigate])

  const loadData = useCallback(async () => {
    const rangeKey = `${currentRange.begin}-${currentRange.end}`
    if (inflightRangeKeyRef.current === rangeKey) {
      return
    }
    inflightRangeKeyRef.current = rangeKey
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.chat.getMyFootprintStats(currentRange.begin, currentRange.end)
      if (!result.success || !result.data) {
        setError(result.error || '读取统计失败')
        setData(EMPTY_DATA)
        return
      }
      setData({
        ...result.data,
        private_segments: Array.isArray(result.data.private_segments) ? result.data.private_segments : []
      })
    } catch (loadError) {
      setError(String(loadError))
      setData(EMPTY_DATA)
    } finally {
      setLoading(false)
      if (inflightRangeKeyRef.current === rangeKey) {
        inflightRangeKeyRef.current = null
      }
    }
  }, [currentRange.begin, currentRange.end])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const keyword = searchKeyword.trim().toLowerCase()

  const privateSessionMetaMap = useMemo(() => {
    const map = new Map<string, { displayName?: string; avatarUrl?: string }>()
    for (const item of data.private_sessions) {
      map.set(item.session_id, {
        displayName: item.displayName,
        avatarUrl: item.avatarUrl
      })
    }
    for (const item of data.private_segments) {
      if (!map.has(item.session_id)) {
        map.set(item.session_id, {
          displayName: item.displayName,
          avatarUrl: item.avatarUrl
        })
      }
    }
    return map
  }, [data.private_sessions, data.private_segments])

  const filteredMentions = useMemo(() => {
    if (!keyword) return data.mentions
    return data.mentions.filter((item) => {
      const sessionName = (item.sessionDisplayName || '').toLowerCase()
      const senderName = (item.senderDisplayName || '').toLowerCase()
      const sender = item.sender_username.toLowerCase()
      const content = normalizeFootprintMessageContent(item.message_content).toLowerCase()
      return sessionName.includes(keyword) || senderName.includes(keyword) || sender.includes(keyword) || content.includes(keyword)
    })
  }, [data.mentions, keyword])

  const filteredPrivateSegments = useMemo(() => {
    const rawSegments = data.private_segments.length > 0
      ? data.private_segments
      : data.private_sessions.map((item, index) => ({
          session_id: item.session_id,
          segment_index: index + 1,
          start_ts: item.first_incoming_ts > 0
            ? item.first_incoming_ts
            : item.first_reply_ts > 0
              ? item.first_reply_ts
              : item.latest_ts,
          end_ts: item.latest_ts,
          duration_sec: Math.max(0, item.latest_ts - (item.first_incoming_ts || item.first_reply_ts || item.latest_ts)),
          incoming_count: item.incoming_count,
          outgoing_count: item.outgoing_count,
          message_count: Math.max(0, item.incoming_count + item.outgoing_count),
          replied: item.replied,
          first_incoming_ts: item.first_incoming_ts,
          first_reply_ts: item.first_reply_ts,
          latest_ts: item.latest_ts,
          anchor_local_id: item.anchor_local_id,
          anchor_create_time: item.anchor_create_time,
          displayName: item.displayName,
          avatarUrl: item.avatarUrl
        }))

    if (!keyword) return rawSegments
    return rawSegments.filter((item) => {
      const meta = privateSessionMetaMap.get(item.session_id)
      const name = String(item.displayName || meta?.displayName || '').toLowerCase()
      const id = item.session_id.toLowerCase()
      return name.includes(keyword) || id.includes(keyword)
    })
  }, [data.private_segments, data.private_sessions, keyword, privateSessionMetaMap])

  const mentionGroupMetaMap = useMemo(() => {
    const map = new Map<string, { displayName?: string; avatarUrl?: string }>()
    for (const item of data.mention_groups) {
      map.set(item.session_id, { displayName: item.displayName, avatarUrl: item.avatarUrl })
    }
    for (const item of data.private_sessions) {
      if (!map.has(item.session_id)) {
        map.set(item.session_id, { displayName: item.displayName, avatarUrl: item.avatarUrl })
      }
    }
    return map
  }, [data.mention_groups, data.private_sessions])

  const mentionTimelineItems = useMemo<TimelineMentionItem[]>(() => {
    return filteredMentions
      .filter((item) => item.create_time > 0)
      .map((item) => {
        const groupMeta = mentionGroupMetaMap.get(item.session_id)
        return {
          kind: 'mention' as const,
          key: `mention:${item.session_id}:${item.local_id}`,
          time: item.create_time,
          sessionId: item.session_id,
          localId: item.local_id,
          createTime: item.create_time,
          groupName: item.sessionDisplayName || groupMeta?.displayName || item.session_id,
          groupAvatarUrl: groupMeta?.avatarUrl,
          senderName: item.senderDisplayName || item.sender_username || '未知',
          messageContent: normalizeFootprintMessageContent(item.message_content)
        }
      })
  }, [filteredMentions, mentionGroupMetaMap])

  const privateTimelineItems = useMemo<TimelinePrivateItem[]>(() => {
    return filteredPrivateSegments
      .map((item) => {
        const startTime = item.start_ts > 0
          ? item.start_ts
          : item.first_incoming_ts > 0
            ? item.first_incoming_ts
            : item.first_reply_ts > 0
              ? item.first_reply_ts
              : item.latest_ts

        const endTime = item.end_ts > 0 ? item.end_ts : item.latest_ts
        const isRange = endTime > startTime + 60
        const totalInteractions = Math.max(0, item.message_count || (item.incoming_count + item.outgoing_count))
        const durationLabel = item.duration_sec > 0
          ? `持续 ${Math.max(1, Math.round(item.duration_sec / 60))} 分钟`
          : formatDurationLabel(startTime, endTime)
        const subtitle = isRange
          ? `${formatTimelineMoment(startTime, timelineTimeMode)} 至 ${formatTimelineMoment(endTime || startTime, timelineTimeMode)} · ${durationLabel}`
          : ''
        const summaryText = `收到 ${item.incoming_count} 条 / 发送 ${item.outgoing_count} 条${item.replied ? ' · 已回复' : ''}`
        const sessionMeta = privateSessionMetaMap.get(item.session_id)
        let dotVariant: PrivateDotVariant = 'both'
        if (item.incoming_count > 0 && item.outgoing_count === 0) {
          dotVariant = 'inbound_only'
        } else if (item.incoming_count === 0 && item.outgoing_count > 0) {
          dotVariant = 'outbound_only'
        }

        return {
          kind: 'private' as const,
          key: `private:${item.session_id}:${item.segment_index}:${item.start_ts}`,
          time: startTime,
          endTime,
          sessionId: item.session_id,
          anchorLocalId: item.anchor_local_id,
          anchorCreateTime: item.anchor_create_time,
          displayName: item.displayName || sessionMeta?.displayName || item.session_id,
          avatarUrl: item.avatarUrl || sessionMeta?.avatarUrl,
          subtitle,
          totalInteractions,
          summaryText,
          dotVariant,
          isRange
        }
      })
      .filter((item) => item.time > 0)
  }, [filteredPrivateSegments, privateSessionMetaMap, timelineTimeMode])

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const events: TimelineItem[] = []
    if (timelineMode !== 'private') {
      events.push(...mentionTimelineItems)
    }
    if (timelineMode !== 'mention') {
      events.push(...privateTimelineItems)
    }

    events.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time
      const rankA = a.kind === 'mention' ? 0 : a.kind === 'private' ? 1 : 2
      const rankB = b.kind === 'mention' ? 0 : b.kind === 'private' ? 1 : 2
      return rankA - rankB
    })

    const presetLabel = resolveRangePresetLabel(preset)
    const startNode: TimelineBoundaryItem = {
      kind: 'boundary',
      edge: 'start',
      key: 'boundary:start',
      time: currentRange.begin,
      label: `区域时间开始（${presetLabel}）`
    }

    const endNode: TimelineBoundaryItem = {
      kind: 'boundary',
      edge: 'end',
      key: 'boundary:end',
      time: currentRange.end,
      label: `区域时间结束（${preset === 'today' ? '现在' : presetLabel}）`
    }

    return [startNode, ...events, endNode]
  }, [timelineMode, mentionTimelineItems, privateTimelineItems, currentRange.begin, currentRange.end, preset])

  const timelineEventCount = useMemo(
    () => timelineItems.filter((item) => item.kind !== 'boundary').length,
    [timelineItems]
  )

  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    try {
      setExporting(true)
      setExportModalStatus('progress')
      setExportModalTitle(`正在准备导出 ${format.toUpperCase()}`)
      setExportModalDescription('正在准备文件保存信息...')
      setExportModalPath('')
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      const separator = downloadsPath && downloadsPath.includes('\\') ? '\\' : '/'
      const rangeName = currentRange.label.replace(/[\\/:*?"<>|\s]+/g, '_')
      const suggestedName = `my_footprint_${rangeName}_${Date.now()}.${format}`
      const defaultPath = downloadsPath ? `${downloadsPath}${separator}${suggestedName}` : suggestedName

      setExportModalDescription('请在弹窗中选择导出路径...')
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: format === 'csv' ? '导出我的足迹 CSV' : '导出我的足迹 JSON',
        defaultPath,
        filters: format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }]
      })
      if (saveResult.canceled || !saveResult.filePath) {
        setExportModalStatus('idle')
        setExportModalTitle('')
        setExportModalDescription('')
        setExportModalPath('')
        return
      }

      setExportModalDescription('正在导出数据，请稍候...')
      setExportModalPath(saveResult.filePath)
      const exportResult = await window.electronAPI.chat.exportMyFootprint(
        currentRange.begin,
        currentRange.end,
        format,
        saveResult.filePath
      )
      if (!exportResult.success) {
        setExportModalStatus('error')
        setExportModalTitle('导出失败')
        setExportModalDescription(exportResult.error || '未知错误')
        setExportModalPath(saveResult.filePath)
        return
      }
      setExportModalStatus('success')
      setExportModalTitle('导出完成')
      setExportModalDescription(`文件已成功导出为 ${format.toUpperCase()}。`)
      setExportModalPath(exportResult.filePath || saveResult.filePath)
    } catch (exportError) {
      setExportModalStatus('error')
      setExportModalTitle('导出失败')
      setExportModalDescription(String(exportError))
    } finally {
      setExporting(false)
    }
  }, [currentRange.begin, currentRange.end, currentRange.label])

  const handleGenerateAiSummary = useCallback(async () => {
    setFootprintAiStatus('loading')
    setFootprintAiText('')
    try {
      const privateSegments = (data.private_segments.length > 0 ? data.private_segments : data.private_sessions).slice(0, 12)
      const result = await window.electronAPI.insight.generateFootprintInsight({
        rangeLabel: currentRange.label,
        summary: data.summary,
        privateSegments: privateSegments.map((item: MyFootprintPrivateSegment | MyFootprintPrivateSession) => ({
          session_id: item.session_id,
          displayName: item.displayName,
          incoming_count: item.incoming_count,
          outgoing_count: item.outgoing_count,
          message_count: 'message_count' in item ? item.message_count : item.incoming_count + item.outgoing_count,
          replied: item.replied
        })),
        mentionGroups: data.mention_groups.slice(0, 12).map((item) => ({
          session_id: item.session_id,
          displayName: item.displayName,
          count: item.count
        }))
      })
      if (!result.success || !result.insight) {
        setFootprintAiStatus('error')
        setFootprintAiText(result.message || '生成失败')
        return
      }
      setFootprintAiStatus('success')
      setFootprintAiText(result.insight)
    } catch (generateError) {
      setFootprintAiStatus('error')
      setFootprintAiText(String(generateError))
    }
  }, [currentRange.label, data])

  return (
    <div className="my-footprint-page">
      <section className="footprint-header">
        <div className="footprint-title-wrap">
          <h1>我的微信足迹</h1>
          <p>范围：{currentRange.label}</p>
        </div>

        <div className="footprint-toolbar">
          <div className="range-preset-group">
            {[
              { value: 'today', label: '今天' },
              { value: 'yesterday', label: '昨天' },
              { value: 'this_week', label: '本周' },
              { value: 'last_week', label: '上周' },
              { value: 'custom', label: '自定义' }
            ].map((item) => (
              <button
                key={item.value}
                type="button"
                className={`preset-chip ${preset === item.value ? 'active' : ''}`}
                onClick={() => setPreset(item.value as RangePreset)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="custom-range-row">
              <DateRangePicker
                startDate={customStartDate}
                endDate={customEndDate}
                onStartDateChange={setCustomStartDate}
                onEndDateChange={setCustomEndDate}
              />
            </div>
          )}

          <div className="toolbar-actions">
            <div className="search-input">
              <Search size={15} />
              <input
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder="搜索联系人/群聊/内容"
              />
            </div>
            <button type="button" className="action-btn" onClick={() => void loadData()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
              <span>刷新</span>
            </button>
            <button type="button" className="action-btn" onClick={() => void handleGenerateAiSummary()} disabled={loading || footprintAiStatus === 'loading'}>
              {footprintAiStatus === 'loading' ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
              <span>{footprintAiStatus === 'loading' ? '生成中...' : 'AI 总结'}</span>
            </button>
            <button type="button" className="action-btn" onClick={() => void handleExport('csv')} disabled={exporting || loading}>
              <Download size={15} />
              <span>导出 CSV</span>
            </button>
            <button type="button" className="action-btn" onClick={() => void handleExport('json')} disabled={exporting || loading}>
              <Download size={15} />
              <span>导出 JSON</span>
            </button>
          </div>
        </div>
      </section>

      {loading ? (
        <section className="footprint-loading" aria-live="polite">
          <div className="kpi-skeleton-grid">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="kpi-skeleton-card skeleton-shimmer" />
            ))}
          </div>
          <div className="timeline-skeleton-list">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="timeline-skeleton-item skeleton-shimmer" />
            ))}
          </div>
        </section>
      ) : error ? (
        <section className="footprint-error" role="alert">
          <h3>读取我的足迹失败</h3>
          <p>{error}</p>
          <button type="button" className="action-btn" onClick={() => void loadData()}>
            <RefreshCw size={15} />
            <span>重试</span>
          </button>
        </section>
      ) : (
        <>
          <section className="kpi-grid">
            <button type="button" className="kpi-card" onClick={() => setTimelineMode('private')}>
              <span className="kpi-label">收到消息的人数</span>
              <strong>{data.summary.private_inbound_people}</strong>
              <small>回复了其中 {data.summary.private_replied_people} 人</small>
            </button>
            <button type="button" className="kpi-card" onClick={() => setTimelineMode('private')}>
              <span className="kpi-label">发送消息的人数</span>
              <strong>{data.summary.private_outbound_people}</strong>
              <small>回复率 {formatPercent(data.summary.private_reply_rate)}</small>
            </button>
            <button type="button" className="kpi-card" onClick={() => setTimelineMode('mention')}>
              <span className="kpi-label">@我次数</span>
              <strong>{data.summary.mention_count}</strong>
              <small>可点击查看原消息</small>
            </button>
            <button type="button" className="kpi-card" onClick={() => setTimelineMode('mention')}>
              <span className="kpi-label">涉及群聊</span>
              <strong>{data.summary.mention_group_count}</strong>
              <small>按群聚合 @我消息</small>
            </button>
          </section>

          {footprintAiStatus !== 'idle' && (
            <section className={`footprint-ai-result footprint-ai-result-${footprintAiStatus}`}>
              <div className="footprint-ai-head">
                <strong>AI 足迹总结</strong>
                <span>{currentRange.label}</span>
              </div>
              <p>{footprintAiText}</p>
            </section>
          )}

          <section
            className={`footprint-timeline timeline-time-${timelineTimeMode}`}
            key={`${timelineMode}:${currentRange.begin}:${currentRange.end}`}
          >
            <div className="timeline-head">
              <div className="timeline-head-left">
                <h2>联络时间线</h2>
                <p>最上方是时间区间开始，最下方是时间区间终点，中间按时间展示群聊 @我 与私聊分段会话节点。</p>
              </div>
              <div className="timeline-mode-row">
                <button
                  type="button"
                  className={`timeline-mode-chip ${timelineMode === 'all' ? 'active' : ''}`}
                  onClick={() => setTimelineMode('all')}
                >
                  全部 {timelineEventCount}
                </button>
                <button
                  type="button"
                  className={`timeline-mode-chip ${timelineMode === 'mention' ? 'active' : ''}`}
                  onClick={() => setTimelineMode('mention')}
                >
                  @我群聊 {mentionTimelineItems.length}
                </button>
                <button
                  type="button"
                  className={`timeline-mode-chip ${timelineMode === 'private' ? 'active' : ''}`}
                  onClick={() => setTimelineMode('private')}
                >
                  私聊 {privateTimelineItems.length}
                </button>
              </div>
            </div>

            {timelineEventCount === 0 ? (
              <div className="panel-empty-state">当前区间暂无联络事件，试试切换日期范围或清空关键词筛选。</div>
            ) : (
              <div className="timeline-stream">
                {timelineItems.map((item, index) => (
                  <div
                    key={item.key}
                    className={`timeline-item timeline-item-${item.kind}`}
                    style={{ animationDelay: `${Math.min(index, 12) * 0.04}s` }}
                  >
                    <div className={`timeline-time timeline-time-${item.kind}`}>
                      {item.kind === 'private' ? (
                        <div className="timeline-time-range">
                          <span className="timeline-time-main">{formatTimelineMoment(item.time, timelineTimeMode)}</span>
                          {item.isRange && (
                            <span className="timeline-time-end-wrap">
                              <span className="timeline-time-end">{formatTimelineMoment(item.endTime, timelineTimeMode)}</span>
                            </span>
                          )}
                        </div>
                      ) : (
                        formatTimelineMoment(item.time, timelineTimeMode)
                      )}
                    </div>
                    <div className={`timeline-dot-col timeline-dot-col-${item.kind}`}>
                      {item.kind === 'private' ? (
                        <div className="timeline-dot-range">
                          <div className={`timeline-dot timeline-dot-private timeline-dot-private-start timeline-dot-private-${item.dotVariant}`} />
                          {item.isRange && (
                            <>
                              <div className={`timeline-dot-range-line timeline-dot-range-line-${item.dotVariant}`} />
                              <div className={`timeline-dot timeline-dot-private timeline-dot-private-end timeline-dot-private-${item.dotVariant}`} />
                            </>
                          )}
                        </div>
                      ) : (
                        <div className={`timeline-dot timeline-dot-${item.kind}${item.kind === 'boundary' ? ` timeline-dot-${item.edge}` : ''}`} />
                      )}
                    </div>
                    <div className="timeline-content-wrap">
                      {item.kind === 'boundary' && (
                        <div className={`timeline-boundary timeline-boundary-${item.edge}`}>{item.label}</div>
                      )}

                      {item.kind === 'mention' && (
                        <div className="timeline-card timeline-card-mention">
                          <div className="timeline-card-head">
                            <div className="timeline-identity">
                              <div className="timeline-avatar">
                                {item.groupAvatarUrl ? (
                                  <img src={item.groupAvatarUrl} alt={item.groupName} />
                                ) : (
                                  <Users size={16} />
                                )}
                              </div>
                              <div className="timeline-title-group">
                                <div className="timeline-title">{item.groupName}</div>
                                <div className="timeline-subtitle">发送人：{item.senderName}</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="jump-btn timeline-jump-btn"
                              onClick={() => handleJump(item.sessionId, item.localId, item.createTime)}
                            >
                              跳转
                            </button>
                          </div>
                          <div className="timeline-message mention-message">{renderMentionContent(item.messageContent)}</div>
                        </div>
                      )}

                      {item.kind === 'private' && (
                        <div className="timeline-card timeline-card-private">
                          <div className="timeline-card-head">
                            <div className="timeline-identity">
                              <div className="timeline-avatar timeline-avatar-private">
                                {item.avatarUrl ? (
                                  <img src={item.avatarUrl} alt={item.displayName} />
                                ) : (
                                  <MessageCircle size={16} />
                                )}
                              </div>
                              <div className="timeline-title-group">
                                <div className="timeline-title">{item.displayName}</div>
                                <div className="timeline-subtitle">{item.subtitle}</div>
                              </div>
                            </div>
                            <div className="timeline-right-tools">
                              <span className="timeline-count-badge">共 {item.totalInteractions} 条</span>
                              <button
                                type="button"
                                className="jump-btn timeline-jump-btn"
                                disabled={!item.anchorLocalId || !item.anchorCreateTime}
                                onClick={() => handleJump(item.sessionId, item.anchorLocalId, item.anchorCreateTime)}
                              >
                                跳转
                              </button>
                            </div>
                          </div>
                          <div className="timeline-message private-message">{item.summaryText}</div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {exportModalStatus !== 'idle' && (
        <div className="footprint-export-modal-mask" role="presentation">
          <div className="footprint-export-modal" role="dialog" aria-modal="true" aria-live="polite">
            <div className={`export-modal-icon export-modal-icon-${exportModalStatus}`}>
              {exportModalStatus === 'progress' && <RefreshCw size={20} className="spin" />}
              {exportModalStatus === 'success' && <CheckCircle2 size={20} />}
              {exportModalStatus === 'error' && <AlertCircle size={20} />}
            </div>
            <h3>{exportModalTitle}</h3>
            <p>{exportModalDescription}</p>
            {exportModalPath && <code className="export-modal-path">{exportModalPath}</code>}
            {exportModalStatus !== 'progress' && (
              <div className="export-modal-actions">
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => {
                    setExportModalStatus('idle')
                    setExportModalTitle('')
                    setExportModalDescription('')
                    setExportModalPath('')
                  }}
                >
                  知道了
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default MyFootprintPage
