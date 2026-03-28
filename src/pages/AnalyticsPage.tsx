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

  const themeMode = useThemeStore((state) => state.themeMode)
  const { statistics, rankings, timeDistribution, isLoaded, setStatistics, setRankings, setTimeDistribution, markLoaded, clearCache } = useAnalyticsStore()

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
    if (isLoaded && !forceRefresh) return
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
      const rankingsResult = await window.electronAPI.analytics.getContactRankings(200)
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
  }, [isLoaded, markLoaded, setRankings, setStatistics, setTimeDistribution])

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

  const getChartLabelColors = () => {
    if (typeof window === 'undefined') {
      return { text: '#333333', line: '#999999' }
    }
    const styles = getComputedStyle(document.documentElement)
    const text = styles.getPropertyValue('--text-primary').trim() || '#333333'
    const line = styles.getPropertyValue('--text-tertiary').trim() || '#999999'
    return { text, line }
  }

  const chartLabelColors = getChartLabelColors()

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
            color: chartLabelColors.text,
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
            color: chartLabelColors.line,
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
            color: chartLabelColors.text,
            textShadowBlur: 0,
            textShadowColor: 'transparent',
            textBorderWidth: 0,
            textBorderColor: 'transparent',
          },
          labelLine: {
            lineStyle: {
              color: chartLabelColors.line,
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
            color: chartLabelColors.text,
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
            color: chartLabelColors.line,
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
            color: chartLabelColors.text,
            textShadowBlur: 0,
            textShadowColor: 'transparent',
            textBorderWidth: 0,
            textBorderColor: 'transparent',
          },
          labelLine: {
            lineStyle: {
              color: chartLabelColors.line,
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
