import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { Users, Clock, MessageSquare, Send, Inbox, Calendar, Loader2, RefreshCw, User, Medal } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { useAnalyticsStore } from '../stores/analyticsStore'
import { useThemeStore } from '../stores/themeStore'
import './AnalyticsPage.scss'
import './DataManagementPage.scss'
import { Avatar } from '../components/Avatar'

function AnalyticsPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const themeMode = useThemeStore((state) => state.themeMode)
  const { statistics, rankings, timeDistribution, isLoaded, setStatistics, setRankings, setTimeDistribution, markLoaded } = useAnalyticsStore()
  const loadData = useCallback(async (forceRefresh = false) => {
    if (isLoaded && !forceRefresh) return
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
      const statsResult = await window.electronAPI.analytics.getOverallStatistics(forceRefresh)
      if (statsResult.success && statsResult.data) {
        setStatistics(statsResult.data)
      } else {
        setError(statsResult.error || '加载统计数据失败')
        setIsLoading(false)
        return
      }
      setLoadingStatus('正在分析联系人排名...')
      const rankingsResult = await window.electronAPI.analytics.getContactRankings(20)
      if (rankingsResult.success && rankingsResult.data) {
        setRankings(rankingsResult.data)
      }
      setLoadingStatus('正在计算时间分布...')
      const timeResult = await window.electronAPI.analytics.getTimeDistribution()
      if (timeResult.success && timeResult.data) {
        setTimeDistribution(timeResult.data)
      }
      markLoaded()
    } catch (e) {
      setError(String(e))
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
      loadData(true)
    }
    window.addEventListener('wxid-changed', handleChange as EventListener)
    return () => window.removeEventListener('wxid-changed', handleChange as EventListener)
  }, [loadData])

  const handleRefresh = () => loadData(true)

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

  if (isLoading && !isLoaded) {
    return (
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

  if (error && !isLoaded) {
    return (<div className="error-container"><p>{error}</p><button className="btn btn-primary" onClick={() => loadData(true)}>重试</button></div>)
  }


  return (
    <>
      <div className="page-header">
        <h1>私聊分析</h1>
        <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
          <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
          {isLoading ? '刷新中...' : '刷新'}
        </button>
      </div>
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
    </>
  )
}

export default AnalyticsPage
