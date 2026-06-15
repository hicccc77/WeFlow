import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Users, Clock, MessageSquare, Send, Inbox, Calendar, Loader2, RefreshCw, Medal, UserMinus, Search, X } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { useAnalyticsStore } from '../stores/analyticsStore'
import { useThemeStore } from '../stores/themeStore'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import './AnalyticsPage.scss'
import { Avatar } from '../components/Avatar'
import ChatAnalysisHeader from '../components/ChatAnalysisHeader'

interface ExcludeCandidate {
  username: string
  displayName: string
  avatarUrl?: string
  wechatId?: string
}

const normalizeUsername = (value: string) => value.trim().toLowerCase()

function AnalyticsPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [isExcludeDialogOpen, setIsExcludeDialogOpen] = useState(false)
  const [excludeCandidates, setExcludeCandidates] = useState<ExcludeCandidate[]>([])
  const [excludeQuery, setExcludeQuery] = useState('')
  const [excludeLoading, setExcludeLoading] = useState(false)
  const [excludeError, setExcludeError] = useState<string | null>(null)
  const [excludedUsernames, setExcludedUsernames] = useState<Set<string>>(new Set())
  const [draftExcluded, setDraftExcluded] = useState<Set<string>>(new Set())

  const chartThemeSignature = useThemeStore((state) => `${state.currentTheme}-${state.themeMode}`)
  const {
    statistics,
    rankings,
    timeDistribution,
    selfSentDailyDistribution,
    isLoaded,
    setStatistics,
    setRankings,
    setTimeDistribution,
    setSelfSentDailyDistribution,
    markLoaded,
    clearCache
  } = useAnalyticsStore()

  const loadExcludedUsernames = useCallback(async () => {
    try {
      const result = await window.electronAPI.analytics.getExcludedUsernames()
      if (result.success && result.data) {
        setExcludedUsernames(new Set(result.data.map(normalizeUsername)))
      } else {
        setExcludedUsernames(new Set())
      }
    } catch (e) {
      console.warn('加载排除名单失败', e)
      setExcludedUsernames(new Set())
    }
  }, [])

  const loadData = useCallback(async (forceRefresh = false) => {
    const currentAnalyticsState = useAnalyticsStore.getState()
    if (
      currentAnalyticsState.isLoaded &&
      !forceRefresh &&
      currentAnalyticsState.statistics &&
      currentAnalyticsState.timeDistribution &&
      currentAnalyticsState.selfSentDailyDistribution
    ) return
    const taskId = registerBackgroundTask({
      sourcePage: 'analytics',
      title: forceRefresh ? '刷新分析看板' : '加载分析看板',
      detail: '准备读取整体统计数据',
      progressText: '整体统计',
      cancelable: true
    })
    setIsLoading(true)
    setError(null)
    setProgress(0)

    // 监听后台推送的进度
    const removeListener = window.electronAPI.analytics.onProgress?.((payload: { status: string; progress: number }) => {
      setLoadingStatus(payload.status)
      setProgress(payload.progress)
    })

    try {
      setLoadingStatus('正在统计消息数据...')
      updateBackgroundTask(taskId, {
        detail: '正在统计消息数据',
        progressText: '整体统计'
      })
      const statsResult = await window.electronAPI.analytics.getOverallStatistics(forceRefresh)
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，当前页面分析流程已结束'
        })
        setIsLoading(false)
        return
      }
      if (statsResult.success && statsResult.data) {
        setStatistics(statsResult.data)
      } else {
        setError(statsResult.error || '加载统计数据失败')
        finishBackgroundTask(taskId, 'failed', {
          detail: statsResult.error || '加载统计数据失败'
        })
        setIsLoading(false)
        return
      }
      setLoadingStatus('正在分析联系人排名...')
      updateBackgroundTask(taskId, {
        detail: '正在分析联系人排名',
        progressText: '联系人排名'
      })
      const rankingsResult = await window.electronAPI.analytics.getContactRankings(20)
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，联系人排名后续步骤未继续'
        })
        setIsLoading(false)
        return
      }
      if (rankingsResult.success && rankingsResult.data) {
        setRankings(rankingsResult.data)
      }
      setLoadingStatus('正在计算时间分布...')
      updateBackgroundTask(taskId, {
        detail: '正在计算时间分布',
        progressText: '时间分布'
      })
      const timeResult = await window.electronAPI.analytics.getTimeDistribution()
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，时间分布结果未继续写入'
        })
        setIsLoading(false)
        return
      }
      if (timeResult.success && timeResult.data) {
        setTimeDistribution(timeResult.data)
      }
      setLoadingStatus('正在统计每日发送分布...')
      updateBackgroundTask(taskId, {
        detail: '正在统计每日发送分布',
        progressText: '每日发送'
      })
      const selfSentDailyResult = await window.electronAPI.analytics.getSelfSentDailyDistribution(0, 0, forceRefresh)
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，每日发送分布结果未继续写入'
        })
        setIsLoading(false)
        return
      }
      if (selfSentDailyResult.success && selfSentDailyResult.data) {
        setSelfSentDailyDistribution(selfSentDailyResult.data)
      }
      markLoaded()
      finishBackgroundTask(taskId, 'completed', {
        detail: '分析看板数据加载完成',
        progressText: '已完成'
      })
    } catch (e) {
      setError(String(e))
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
    } finally {
      setIsLoading(false)
      if (removeListener) removeListener()
    }
  }, [markLoaded, setRankings, setSelfSentDailyDistribution, setStatistics, setTimeDistribution])

  const location = useLocation()

  useEffect(() => {
    const force = location.state?.forceRefresh === true
    loadData(force)
  }, [location.state, loadData])

  useEffect(() => {
    const handleChange = () => {
      loadExcludedUsernames()
      loadData(true)
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [loadData, loadExcludedUsernames])

  useEffect(() => {
    loadExcludedUsernames()
  }, [loadExcludedUsernames])

  const handleRefresh = () => loadData(true)
  const isNoSessionError = error?.includes('未找到消息会话') ?? false

  const loadExcludeCandidates = useCallback(async () => {
    setExcludeLoading(true)
    setExcludeError(null)
    try {
      const result = await window.electronAPI.analytics.getExcludeCandidates()
      if (result.success && result.data) {
        setExcludeCandidates(result.data)
      } else {
        setExcludeError(result.error || '加载好友列表失败')
      }
    } catch (e) {
      setExcludeError(String(e))
    } finally {
      setExcludeLoading(false)
    }
  }, [])

  const openExcludeDialog = async () => {
    setExcludeQuery('')
    setDraftExcluded(new Set(excludedUsernames))
    setIsExcludeDialogOpen(true)
    await loadExcludeCandidates()
  }

  const toggleExcluded = (username: string) => {
    const key = normalizeUsername(username)
    setDraftExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const toggleInvertSelection = () => {
    setDraftExcluded((prev) => {
      const allUsernames = new Set(excludeCandidates.map(c => normalizeUsername(c.username)))
      const inverted = new Set<string>()
      for (const u of allUsernames) {
        if (!prev.has(u)) inverted.add(u)
      }
      return inverted
    })
  }

  const handleApplyExcluded = async () => {
    const payload = Array.from(draftExcluded)
    setIsExcludeDialogOpen(false)
    try {
      const result = await window.electronAPI.analytics.setExcludedUsernames(payload)
      if (!result.success) {
        alert(result.error || '更新排除名单失败')
        return
      }
      setExcludedUsernames(new Set((result.data || payload).map(normalizeUsername)))
      clearCache()
      await window.electronAPI.cache.clearAnalytics()
      await loadData(true)
    } catch (e) {
      alert(`更新排除名单失败：${String(e)}`)
    }
  }

  const handleResetExcluded = async () => {
    try {
      const result = await window.electronAPI.analytics.setExcludedUsernames([])
      if (!result.success) {
        setError(result.error || '重置排除好友失败')
        return
      }
      setExcludedUsernames(new Set())
      setDraftExcluded(new Set())
      clearCache()
      await window.electronAPI.cache.clearAnalytics()
      await loadData(true)
    } catch (e) {
      setError(`重置排除好友失败: ${String(e)}`)
    }
  }

  const visibleExcludeCandidates = excludeCandidates
    .filter((candidate) => {
      const query = excludeQuery.trim().toLowerCase()
      if (!query) return true
      const wechatId = candidate.wechatId || ''
      const haystack = `${candidate.displayName} ${candidate.username} ${wechatId}`.toLowerCase()
      return haystack.includes(query)
    })
    .sort((a, b) => {
      const aSelected = draftExcluded.has(normalizeUsername(a.username))
      const bSelected = draftExcluded.has(normalizeUsername(b.username))
      if (aSelected !== bSelected) return aSelected ? -1 : 1
      return a.displayName.localeCompare(b.displayName, 'zh')
    })

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '-'
    const date = new Date(timestamp * 1000)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  const formatNumber = (num: number) => {
    if (num >= 10000) return (num / 10000).toFixed(1) + '万'
    return num.toLocaleString()
  }

  const getChartTheme = () => {
    if (typeof window === 'undefined') {
      return {
        text: '#333333',
        secondaryText: '#666666',
        mutedText: '#999999',
        line: '#e5e5e5',
        surface: '#ffffff',
        border: '#e5e5e5',
        primary: '#10a37f',
        primaryLight: 'rgba(16, 163, 127, 0.1)',
        danger: '#ef4444',
        warning: '#f59e0b',
        success: '#10a37f',
        info: '#3b82f6'
      }
    }
    const styles = getComputedStyle(document.documentElement)
    const cssVar = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
    return {
      text: cssVar('--text-primary', '#333333'),
      secondaryText: cssVar('--text-secondary', '#666666'),
      mutedText: cssVar('--text-tertiary', '#999999'),
      line: cssVar('--border-color', '#e5e5e5'),
      surface: cssVar('--card-inner-bg', '#ffffff'),
      border: cssVar('--border-color', '#e5e5e5'),
      primary: cssVar('--primary', '#10a37f'),
      primaryLight: cssVar('--primary-light', 'rgba(16, 163, 127, 0.1)'),
      danger: cssVar('--danger', '#ef4444'),
      warning: cssVar('--warning', '#f59e0b'),
      success: cssVar('--primary', '#10a37f'),
      info: '#3b82f6'
    }
  }

  const chartTheme = getChartTheme()

  const getTypeChartOption = () => {
    if (!statistics) return {}
    const data = [
      { name: '文本', value: statistics.textMessages },
      { name: '图片', value: statistics.imageMessages },
      { name: '语音', value: statistics.voiceMessages },
      { name: '视频', value: statistics.videoMessages },
      { name: '表情', value: statistics.emojiMessages },
      { name: '其他', value: statistics.otherMessages },
    ].filter(d => d.value > 0)
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        avoidLabelOverlap: false,
        itemStyle: { borderRadius: 8, borderColor: 'transparent', borderWidth: 0 },
        label: {
          show: true,
          formatter: '{b}\n{d}%',
          textStyle: {
            color: chartTheme.text,
            textShadowBlur: 0,
            textShadowColor: 'transparent',
            textShadowOffsetX: 0,
            textShadowOffsetY: 0,
            textBorderWidth: 0,
            textBorderColor: 'transparent',
          },
        },
        labelLine: {
          lineStyle: {
            color: chartTheme.mutedText,
            shadowBlur: 0,
            shadowColor: 'transparent',
          },
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 0,
            shadowOffsetX: 0,
            shadowOffsetY: 0,
          },
          label: {
            color: chartTheme.text,
            textShadowBlur: 0,
            textShadowColor: 'transparent',
            textBorderWidth: 0,
            textBorderColor: 'transparent',
          },
          labelLine: {
            lineStyle: {
              color: chartTheme.mutedText,
              shadowBlur: 0,
              shadowColor: 'transparent',
            },
          },
        },
        data,
      }]
    }
  }

  const getSendReceiveOption = () => {
    if (!statistics) return {}
    return {
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie', radius: ['50%', '70%'], data: [
          { name: '发送', value: statistics.sentMessages, itemStyle: { color: '#07c160' } },
          { name: '接收', value: statistics.receivedMessages, itemStyle: { color: '#1989fa' } }
        ],
        label: {
          show: true,
          formatter: '{b}: {c}',
          textStyle: {
            color: chartTheme.text,
            textShadowBlur: 0,
            textShadowColor: 'transparent',
            textShadowOffsetX: 0,
            textShadowOffsetY: 0,
            textBorderWidth: 0,
            textBorderColor: 'transparent',
          },
        },
        labelLine: {
          lineStyle: {
            color: chartTheme.mutedText,
            shadowBlur: 0,
            shadowColor: 'transparent',
          },
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 0,
            shadowOffsetX: 0,
            shadowOffsetY: 0,
          },
          label: {
            color: chartTheme.text,
            textShadowBlur: 0,
            textShadowColor: 'transparent',
            textBorderWidth: 0,
            textBorderColor: 'transparent',
          },
          labelLine: {
            lineStyle: {
              color: chartTheme.mutedText,
              shadowBlur: 0,
              shadowColor: 'transparent',
            },
          },
        },
      }]
    }
  }

  const getHourlyOption = () => {
    if (!timeDistribution) return {}
    const hours = Array.from({ length: 24 }, (_, i) => i)
    const data = hours.map(h => timeDistribution.hourlyDistribution[h] || 0)
    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: hours.map(h => `${h}时`) },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data, itemStyle: { color: '#07c160', borderRadius: [4, 4, 0, 0] } }]
    }
  }

  const getSelfSentDailyRatioData = () => {
    const entries = Object.entries(selfSentDailyDistribution?.dailyDistribution || {})
      .sort(([a], [b]) => a.localeCompare(b))
    const days = entries.map(([day]) => day)
    const counts = entries.map(([, count]) => count)
    const totalDays = Math.max(days.length, 1)
    const total = counts.reduce((sum, count) => sum + count, 0)
    const baseline = total > 0 ? total / totalDays : 0
    const ratios = counts.map((count) => baseline > 0 ? Number((count / baseline * 100).toFixed(1)) : 0)
    const movingAverage = ratios.map((_, index) => {
      const start = Math.max(0, index - 6)
      const windowValues = ratios.slice(start, index + 1)
      const sum = windowValues.reduce((total, value) => total + value, 0)
      return Number((sum / windowValues.length).toFixed(1))
    })
    return { days, counts, ratios, movingAverage, baseline, total }
  }

  const getSelfSentDailyRatioOption = () => {
    if (!selfSentDailyDistribution) return {}
    const { days, counts, ratios, movingAverage, baseline } = getSelfSentDailyRatioData()
    const showZoom = days.length > 31

    const zoomStart = showZoom ? Math.max(0, 100 - Math.min(100, 31 / days.length * 100)) : 0
    const ratioBarColors = {
      normal: chartTheme.primary,
      high: chartTheme.warning,
      spike: chartTheme.danger,
      trend: chartTheme.secondaryText,
      baseline: chartTheme.mutedText
    }

    return {
      tooltip: {
        trigger: 'axis',
        backgroundColor: chartTheme.surface,
        borderColor: chartTheme.border,
        textStyle: { color: chartTheme.text },
        extraCssText: 'box-shadow: var(--shadow-md); border-radius: 8px;',
        axisPointer: {
          type: 'shadow',
          shadowStyle: { color: chartTheme.primaryLight }
        },
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params]
          const first = items[0]
          const index = Number(first?.dataIndex || 0)
          const lines = [
            `${first?.axisValue || ''}`,
            `当日发送：${formatNumber(counts[index] || 0)} 条`,
            `相对日均：${formatNumber(ratios[index] || 0)}%`,
            `7日均线：${formatNumber(movingAverage[index] || 0)}%`,
            `全期日均：${baseline.toFixed(1)} 条/天`
          ]
          return lines.join('<br/>')
        }
      },
      legend: {
        data: ['单日比例', '7日均线'],
        top: 0,
        textStyle: { color: chartTheme.secondaryText }
      },
      grid: { left: 56, right: 40, top: 42, bottom: showZoom ? 58 : 32 },
      xAxis: {
        type: 'category',
        data: days,
        axisLine: { lineStyle: { color: chartTheme.line } },
        axisTick: { lineStyle: { color: chartTheme.line } },
        axisLabel: {
          color: chartTheme.mutedText,
          hideOverlap: true,
          formatter: (value: string) => value.slice(5)
        }
      },
      yAxis: {
        type: 'value',
        name: '相对日均',
        nameTextStyle: { color: chartTheme.mutedText },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: chartTheme.mutedText,
          formatter: '{value}%'
        },
        splitLine: { lineStyle: { color: chartTheme.line, type: 'dashed' } }
      },
      dataZoom: showZoom ? [
        { type: 'inside', start: zoomStart, end: 100 },
        {
          type: 'slider',
          height: 18,
          bottom: 16,
          start: zoomStart,
          end: 100,
          borderColor: chartTheme.border,
          fillerColor: chartTheme.primaryLight,
          handleStyle: { color: chartTheme.primary, borderColor: chartTheme.primary },
          moveHandleStyle: { color: chartTheme.primaryLight },
          dataBackground: {
            lineStyle: { color: chartTheme.mutedText },
            areaStyle: { color: chartTheme.primaryLight }
          },
          selectedDataBackground: {
            lineStyle: { color: chartTheme.primary },
            areaStyle: { color: chartTheme.primaryLight }
          },
          textStyle: { color: chartTheme.mutedText }
        }
      ] : undefined,
      series: [
        {
          name: '单日比例',
          type: 'bar',
          data: ratios,
          itemStyle: {
            color: (params: any) => {
              const value = Number(params?.value || 0)
              if (value >= 200) return ratioBarColors.spike
              if (value >= 150) return ratioBarColors.high
              return ratioBarColors.normal
            },
            borderRadius: [4, 4, 0, 0]
          },
          markLine: {
            symbol: 'none',
            data: [{ yAxis: 100, name: '日均基线' }],
            label: {
              position: 'middle',
              formatter: '日均基线',
              color: chartTheme.secondaryText,
              backgroundColor: chartTheme.surface,
              borderColor: chartTheme.border,
              borderWidth: 1,
              borderRadius: 4,
              padding: [2, 6]
            },
            lineStyle: { type: 'dashed', color: ratioBarColors.baseline }
          }
        },
        {
          name: '7日均线',
          type: 'line',
          data: movingAverage,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: ratioBarColors.trend },
          itemStyle: { color: ratioBarColors.trend }
        }
      ]
    }
  }

  const selfSentDailyRatioData = getSelfSentDailyRatioData()

  const renderPageShell = (content: ReactNode) => (
    <div className="analytics-page-shell">
      <ChatAnalysisHeader currentMode="private" />
      {content}
    </div>
  )

  const analyticsHeaderActions = (
    <>
      <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
        <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
        {isLoading ? '刷新中...' : '刷新'}
      </button>
      <button className="btn btn-secondary" onClick={openExcludeDialog}>
        <UserMinus size={16} />
        排除好友{excludedUsernames.size > 0 ? ` (${excludedUsernames.size})` : ''}
      </button>
    </>
  )

  if (isLoading && !isLoaded) {
    return renderPageShell(
      <div className="loading-container">
        <Loader2 size={48} className="spin" />
        <p className="loading-status">{loadingStatus}</p>
        <div className="progress-bar-wrapper">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
        </div>
        <span className="progress-percent">{progress}%</span>
      </div>
    )
  }

  if (error && !isLoaded && isNoSessionError && excludedUsernames.size > 0) {
    return renderPageShell(
      <div className="error-container">
        <p>{error}</p>
        <div className="error-actions">
          <button className="btn btn-secondary" onClick={handleResetExcluded}>
            重置排除好友
          </button>
          <button className="btn btn-primary" onClick={() => loadData(true)}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (error && !isLoaded) {
    return renderPageShell(
      <div className="error-container">
        <p>{error}</p>
        <button className="btn btn-primary" onClick={() => loadData(true)}>重试</button>
      </div>
    )
  }


  return (
    <div className="analytics-page-shell">
      <ChatAnalysisHeader currentMode="private" actions={analyticsHeaderActions} />
      <div className="page-scroll">
        <section className="page-section">
          <div className="stats-overview">
            <div className="stat-card">
              <div className="stat-icon"><MessageSquare size={24} /></div>
              <div className="stat-info">
                <span className="stat-value">{formatNumber(statistics?.totalMessages || 0)}</span>
                <span className="stat-label">总消息数</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon"><Send size={24} /></div>
              <div className="stat-info">
                <span className="stat-value">{formatNumber(statistics?.sentMessages || 0)}</span>
                <span className="stat-label">发送消息</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon"><Inbox size={24} /></div>
              <div className="stat-info">
                <span className="stat-value">{formatNumber(statistics?.receivedMessages || 0)}</span>
                <span className="stat-label">接收消息</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon"><Calendar size={24} /></div>
              <div className="stat-info">
                <span className="stat-value">{statistics?.activeDays || 0}</span>
                <span className="stat-label">活跃天数</span>
              </div>
            </div>
          </div>
          {statistics && (
            <div className="time-range">
              <Clock size={16} />
              <span>数据范围: {formatDate(statistics.firstMessageTime)} - {formatDate(statistics.lastMessageTime)}</span>
            </div>
          )}
          <div className="charts-grid">
            <div className="chart-card"><h3>消息类型分布</h3><ReactECharts option={getTypeChartOption()} style={{ height: 300 }} /></div>
            <div className="chart-card"><h3>发送/接收比例</h3><ReactECharts option={getSendReceiveOption()} style={{ height: 300 }} /></div>
            <div className="chart-card wide"><h3>每小时消息分布</h3><ReactECharts option={getHourlyOption()} style={{ height: 250 }} /></div>
            <div className="chart-card wide self-sent-ratio-card">
              <div className="chart-title-row">
                <h3>每日自身发送强度比例</h3>
                <span>范围：全部 · 基线：{selfSentDailyRatioData.baseline.toFixed(1)} 条/天 · 共 {formatNumber(selfSentDailyDistribution?.totalMessages || 0)} 条</span>
              </div>
              <div className="chart-note">
                比例 = 当日自身发送量 ÷ 全期每日平均自身发送量。超过 100% 表示高于本人基线
              </div>
              <ReactECharts key={chartThemeSignature} option={getSelfSentDailyRatioOption()} style={{ height: 320 }} />
            </div>
          </div>
        </section>
        <section className="page-section">
          <div className="section-header"><div><h2><Users size={20} /> 聊天排名 Top 20</h2></div></div>
          <div className="rankings-list">
            {rankings.map((contact, index) => (
              <div key={contact.username} className="ranking-item">
                <span className={`rank ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
                <div className="contact-avatar">
                  <Avatar src={contact.avatarUrl} name={contact.displayName} size={36} />
                  {index < 3 && <div className={`medal medal-${index + 1}`}><Medal size={10} /></div>}
                </div>
                <div className="contact-info">
                  <span className="contact-name">{contact.displayName}</span>
                  <span className="contact-stats">发送 {contact.sentCount} / 接收 {contact.receivedCount}</span>
                </div>
                <span className="message-count">{formatNumber(contact.messageCount)} 条</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      {isExcludeDialogOpen && (
        <div className="exclude-modal-overlay" onClick={() => setIsExcludeDialogOpen(false)}>
          <div className="exclude-modal" onClick={e => e.stopPropagation()}>
            <div className="exclude-modal-header">
              <h3>选择不统计的好友</h3>
              <button className="modal-close" onClick={() => setIsExcludeDialogOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="exclude-modal-search">
              <Search size={16} />
              <input
                type="text"
                placeholder="搜索好友"
                value={excludeQuery}
                onChange={e => setExcludeQuery(e.target.value)}
                disabled={excludeLoading}
              />
              {excludeQuery && (
                <button className="clear-search" onClick={() => setExcludeQuery('')}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="exclude-modal-body">
              {excludeLoading && (
                <div className="exclude-loading">
                  <Loader2 size={20} className="spin" />
                  <span>正在加载好友列表...</span>
                </div>
              )}
              {!excludeLoading && excludeError && (
                <div className="exclude-error">{excludeError}</div>
              )}
              {!excludeLoading && !excludeError && (
                <div className="exclude-list">
                  {visibleExcludeCandidates.map((candidate) => {
                    const isChecked = draftExcluded.has(normalizeUsername(candidate.username))
                    const wechatId = candidate.wechatId?.trim() || candidate.username
                    return (
                      <label key={candidate.username} className={`exclude-item ${isChecked ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleExcluded(candidate.username)}
                        />
                        <div className="exclude-avatar">
                          <Avatar src={candidate.avatarUrl} name={candidate.displayName} size={32} />
                        </div>
                        <div className="exclude-info">
                          <span className="exclude-name">{candidate.displayName}</span>
                          <span className="exclude-username">{wechatId}</span>
                        </div>
                      </label>
                    )
                  })}
                  {visibleExcludeCandidates.length === 0 && (
                    <div className="exclude-empty">
                      {excludeQuery.trim() ? '未找到匹配好友' : '暂无可选好友'}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="exclude-modal-footer">
              <div className="exclude-footer-left">
                <span className="exclude-count">已排除 {draftExcluded.size} 人</span>
                <button className="btn btn-text" onClick={toggleInvertSelection} disabled={excludeLoading}>
                  反选
                </button>
              </div>
              <div className="exclude-actions">
                <button className="btn btn-secondary" onClick={() => setIsExcludeDialogOpen(false)}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleApplyExcluded} disabled={excludeLoading}>
                  应用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AnalyticsPage
