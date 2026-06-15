import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar, Loader2, Sparkles, Users } from 'lucide-react'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import './AnnualReportPage.scss'

type YearOption = number | 'all'
type YearsLoadPayload = {
  years?: number[]
  done: boolean
  error?: string
  canceled?: boolean
  strategy?: 'cache' | 'native' | 'hybrid'
  phase?: 'cache' | 'native' | 'scan' | 'done'
  statusText?: string
  nativeElapsedMs?: number
  scanElapsedMs?: number
  totalElapsedMs?: number
  switched?: boolean
  nativeTimedOut?: boolean
}

const REPORT_LAUNCH_DELAY_MS = 420

const formatLoadElapsed = (ms: number) => {
  const totalSeconds = Math.max(0, ms) / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function AnnualReportPage() {
  const navigate = useNavigate()
  const [availableYears, setAvailableYears] = useState<number[]>([])
  const [selectedYear, setSelectedYear] = useState<YearOption | null>(null)
  const [selectedPairYear, setSelectedPairYear] = useState<YearOption | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMoreYears, setIsLoadingMoreYears] = useState(false)
  const [hasYearsLoadFinished, setHasYearsLoadFinished] = useState(false)
  const [loadStrategy, setLoadStrategy] = useState<'cache' | 'native' | 'hybrid'>('native')
  const [loadPhase, setLoadPhase] = useState<'cache' | 'native' | 'scan' | 'done'>('native')
  const [loadStatusText, setLoadStatusText] = useState('准备加载年份数据...')
  const [nativeElapsedMs, setNativeElapsedMs] = useState(0)
  const [scanElapsedMs, setScanElapsedMs] = useState(0)
  const [totalElapsedMs, setTotalElapsedMs] = useState(0)
  const [hasSwitchedStrategy, setHasSwitchedStrategy] = useState(false)
  const [nativeTimedOut, setNativeTimedOut] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isRouteTransitioning, setIsRouteTransitioning] = useState(false)
  const [launchingYearLabel, setLaunchingYearLabel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const launchTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let disposed = false
    let taskId = ''
    let uiTaskId = ''

    const applyLoadPayload = (payload: YearsLoadPayload) => {
      if (uiTaskId) {
        updateBackgroundTask(uiTaskId, {
          detail: payload.statusText || '正在加载可用年份',
          progressText: payload.done
            ? '已完成'
            : `${Array.isArray(payload.years) ? payload.years.length : 0} 个年份`
        })
      }
      if (payload.strategy) setLoadStrategy(payload.strategy)
      if (payload.phase) setLoadPhase(payload.phase)
      if (typeof payload.statusText === 'string' && payload.statusText) setLoadStatusText(payload.statusText)
      if (typeof payload.nativeElapsedMs === 'number' && Number.isFinite(payload.nativeElapsedMs)) {
        setNativeElapsedMs(Math.max(0, payload.nativeElapsedMs))
      }
      if (typeof payload.scanElapsedMs === 'number' && Number.isFinite(payload.scanElapsedMs)) {
        setScanElapsedMs(Math.max(0, payload.scanElapsedMs))
      }
      if (typeof payload.totalElapsedMs === 'number' && Number.isFinite(payload.totalElapsedMs)) {
        setTotalElapsedMs(Math.max(0, payload.totalElapsedMs))
      }
      if (typeof payload.switched === 'boolean') setHasSwitchedStrategy(payload.switched)
      if (typeof payload.nativeTimedOut === 'boolean') setNativeTimedOut(payload.nativeTimedOut)

      const years = Array.isArray(payload.years) ? payload.years : []
      if (years.length > 0) {
        setAvailableYears(years)
        setSelectedYear((prev) => {
          if (prev === 'all') return prev
          if (typeof prev === 'number' && years.includes(prev)) return prev
          return years[0]
        })
        setSelectedPairYear((prev) => {
          if (prev === 'all') return prev
          if (typeof prev === 'number' && years.includes(prev)) return prev
          return years[0]
        })
        setIsLoading(false)
      }

      if (payload.error && !payload.canceled) {
        setLoadError(payload.error || '加载年度数据失败')
      }

      if (payload.done) {
        setIsLoading(false)
        setIsLoadingMoreYears(false)
        setHasYearsLoadFinished(true)
        setLoadPhase('done')
        if (uiTaskId) {
          finishBackgroundTask(uiTaskId, payload.canceled ? 'canceled' : 'completed', {
            detail: payload.canceled
              ? '年度报告年份加载已停止'
              : `年度报告年份加载完成，共 ${years.length} 个年份`,
            progressText: payload.canceled ? '已停止' : `${years.length} 个年份`
          })
        }
      } else {
        setIsLoadingMoreYears(true)
        setHasYearsLoadFinished(false)
      }
    }

    const stopListen = window.electronAPI.annualReport.onAvailableYearsProgress((payload) => {
      if (disposed) return
      if (taskId && payload.taskId !== taskId) return
      if (!taskId) taskId = payload.taskId
      applyLoadPayload(payload)
    })

    const startLoad = async () => {
      uiTaskId = registerBackgroundTask({
        sourcePage: 'annualReport',
        title: '年度报告年份加载',
        detail: '准备使用原生快速模式加载年份',
        progressText: '初始化',
        cancelable: true,
        onCancel: async () => {
          if (taskId) {
            await window.electronAPI.annualReport.cancelAvailableYearsLoad(taskId)
          }
        }
      })
      setIsLoading(true)
      setIsLoadingMoreYears(true)
      setHasYearsLoadFinished(false)
      setLoadStrategy('native')
      setLoadPhase('native')
      setLoadStatusText('准备使用原生快速模式加载年份...')
      setNativeElapsedMs(0)
      setScanElapsedMs(0)
      setTotalElapsedMs(0)
      setHasSwitchedStrategy(false)
      setNativeTimedOut(false)
      setLoadError(null)
      try {
        const startResult = await window.electronAPI.annualReport.startAvailableYearsLoad()
        if (!startResult.success || !startResult.taskId) {
          finishBackgroundTask(uiTaskId, 'failed', {
            detail: startResult.error || '加载年度数据失败'
          })
          setLoadError(startResult.error || '加载年度数据失败')
          setIsLoading(false)
          setIsLoadingMoreYears(false)
          return
        }
        taskId = startResult.taskId
        if (startResult.snapshot) {
          applyLoadPayload(startResult.snapshot)
        }
      } catch (e) {
        console.error(e)
        finishBackgroundTask(uiTaskId, 'failed', {
          detail: String(e)
        })
        setLoadError(String(e))
        setIsLoading(false)
        setIsLoadingMoreYears(false)
      }
    }

    void startLoad()

    return () => {
      disposed = true
      stopListen()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current)
      }
    }
  }, [])

  const handleGenerateReport = () => {
    if (selectedYear === null || isRouteTransitioning) return
    const yearParam = selectedYear === 'all' ? 0 : selectedYear
    const yearLabel = selectedYear === 'all' ? '全部时间' : `${selectedYear}年`
    setIsGenerating(true)
    setIsRouteTransitioning(true)
    setLaunchingYearLabel(yearLabel)
    if (launchTimerRef.current !== null) {
      window.clearTimeout(launchTimerRef.current)
    }
    launchTimerRef.current = window.setTimeout(() => {
      try {
        navigate(`/annual-report/view?year=${yearParam}`)
      } catch (e) {
        console.error('生成报告失败:', e)
        setIsGenerating(false)
        setIsRouteTransitioning(false)
      }
    }, REPORT_LAUNCH_DELAY_MS)
  }

  const handleGenerateDualReport = () => {
    if (selectedPairYear === null || isRouteTransitioning) return
    const yearParam = selectedPairYear === 'all' ? 0 : selectedPairYear
    navigate(`/dual-report?year=${yearParam}`)
  }

  if (isLoading && availableYears.length === 0) {
    return (
      <div className="annual-report-page">
        <Loader2 size={32} className="spin" style={{ color: 'var(--text-tertiary)' }} />
        <p style={{ color: 'var(--text-tertiary)', marginTop: 16 }}>正在准备年度报告...</p>
      </div>
    )
  }

  if (availableYears.length === 0 && !isLoadingMoreYears) {
    return (
      <div className="annual-report-page">
        <Calendar size={64} style={{ color: 'var(--text-tertiary)', opacity: 0.5 }} />
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', margin: '16px 0 8px' }}>暂无聊天记录</h2>
        <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>
          {loadError || '请先解密数据库后再生成年度报告'}
        </p>
      </div>
    )
  }

  const yearOptions: YearOption[] = availableYears.length > 0
    ? ['all', ...availableYears]
    : []

  const getYearLabel = (value: YearOption | null) => {
    if (!value) return ''
    return value === 'all' ? '全部时间' : `${value} 年`
  }

  const loadedYearCount = availableYears.length
  const isYearStatusComplete = hasYearsLoadFinished
  const strategyLabel = getStrategyLabel({ loadStrategy, loadPhase, hasYearsLoadFinished, hasSwitchedStrategy, nativeTimedOut })
  const renderYearLoadStatus = () => (
    <div className={`year-load-status ${isYearStatusComplete ? 'complete' : 'loading'}`}>
      {isYearStatusComplete ? (
        <>全部年份已加载完毕</>
      ) : (
        <>
          更多年份加载中<span className="dot-ellipsis" aria-hidden="true">...</span>
        </>
      )}
    </div>
  )

  return (
    <div className={`annual-report-page ${isRouteTransitioning ? 'report-route-transitioning' : ''}`}>
      <Sparkles size={32} className="header-icon" />
      <h1 className="page-title">年度报告</h1>
      <p className="page-desc">选择年份，回顾你在微信里的点点滴滴</p>

      <div className="report-sections">
        <section className="report-section">
          <div className="section-header">
            <div>
              <h2 className="section-title">总年度报告</h2>
              <p className="section-desc">包含所有会话与消息</p>
            </div>
          </div>

          <div className="year-grid-with-status">
            <div className="year-grid">
              {yearOptions.map(option => (
                <div
                  key={option}
                  className={`year-card ${option === 'all' ? 'all-time' : ''} ${selectedYear === option ? 'selected' : ''} ${isRouteTransitioning ? 'disabled' : ''}`}
                  onClick={() => {
                    if (isRouteTransitioning) return
                    setSelectedYear(option)
                  }}
                >
                  <span className="year-number">{option === 'all' ? '全部' : option}</span>
                  <span className="year-label">{option === 'all' ? '时间' : '年'}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            className={`generate-btn ${isRouteTransitioning ? 'is-pending' : ''}`}
            onClick={handleGenerateReport}
            disabled={!selectedYear || isGenerating || isRouteTransitioning}
          >
            {isGenerating ? (
              <>
                <Loader2 size={20} className="spin" />
                <span>{isRouteTransitioning ? '正在进入报告...' : '正在生成...'}</span>
              </>
            ) : (
              <>
                <Sparkles size={20} />
                <span>生成 {getYearLabel(selectedYear)} 年度报告</span>
              </>
            )}
          </button>
        </section>

        <section className="report-section">
          <div className="section-header">
            <div>
              <h2 className="section-title">双人年度报告</h2>
              <p className="section-desc">选择一位好友，只看你们的私聊</p>
            </div>
            <div className="section-badge">
              <Users size={16} />
              <span>私聊</span>
            </div>
          </div>

          <div className="year-grid-with-status">
            <div className="year-grid">
              {yearOptions.map(option => (
                <div
                  key={`pair-${option}`}
                  className={`year-card ${option === 'all' ? 'all-time' : ''} ${selectedPairYear === option ? 'selected' : ''} ${isRouteTransitioning ? 'disabled' : ''}`}
                  onClick={() => {
                    if (isRouteTransitioning) return
                    setSelectedPairYear(option)
                  }}
                >
                  <span className="year-number">{option === 'all' ? '全部' : option}</span>
                  <span className="year-label">{option === 'all' ? '时间' : '年'}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            className={`generate-btn secondary ${isRouteTransitioning ? 'is-pending' : ''}`}
            onClick={handleGenerateDualReport}
            disabled={!selectedPairYear || isRouteTransitioning}
          >
            <Users size={20} />
            <span>选择好友并生成报告</span>
          </button>
          <p className="section-hint">从聊天排行中选择好友生成双人报告</p>
        </section>
      </div>

      {isRouteTransitioning && (
        <div className="report-launch-overlay" role="status" aria-live="polite">
          <div className="launch-core">
            <Loader2 size={30} className="spin" />
            <p className="launch-title">正在进入{launchingYearLabel}年度报告</p>
            <p className="launch-subtitle">正在整理你的聊天记忆...</p>
          </div>
        </div>
      )}
    </div>
  )
}

function getStrategyLabel(params: {
  loadStrategy: 'cache' | 'native' | 'hybrid'
  loadPhase: 'cache' | 'native' | 'scan' | 'done'
  hasYearsLoadFinished: boolean
  hasSwitchedStrategy: boolean
  nativeTimedOut: boolean
}): string {
  const { loadStrategy, loadPhase, hasYearsLoadFinished, hasSwitchedStrategy, nativeTimedOut } = params
  if (loadStrategy === 'cache') return '缓存模式（快速）'
  if (hasYearsLoadFinished) {
    if (loadStrategy === 'native') return '原生快速模式'
    if (hasSwitchedStrategy || nativeTimedOut) return '混合策略（原生→扫表）'
    return '扫表兼容模式'
  }
  if (loadPhase === 'native') return '原生快速模式（优先）'
  if (loadPhase === 'scan') return '扫表兼容模式（回退）'
  return '混合策略'
}

export default AnnualReportPage
