import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Check } from 'lucide-react'
import ReportHeatmap from '../components/ReportHeatmap'
import ReportWordCloud from '../components/ReportWordCloud'
import { useThemeStore } from '../stores/themeStore'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import './AnnualReportWindow.scss'
import './DualReportWindow.scss'

interface DualReportMessage {
  content: string
  isSentByMe: boolean
  createTime: number
  createTimeStr: string
  localType?: number
  emojiMd5?: string
  emojiCdnUrl?: string
}

interface DualReportData {
  year: number
  selfName: string
  selfAvatarUrl?: string
  friendUsername: string
  friendName: string
  friendAvatarUrl?: string
  firstChat: {
    createTime: number
    createTimeStr: string
    content: string
    isSentByMe: boolean
    senderUsername?: string
    localType?: number
    emojiMd5?: string
    emojiCdnUrl?: string
  } | null
  firstChatMessages?: DualReportMessage[]
  yearFirstChat?: {
    createTime: number
    createTimeStr: string
    content: string
    isSentByMe: boolean
    friendName: string
    firstThreeMessages: DualReportMessage[]
    localType?: number
    emojiMd5?: string
    emojiCdnUrl?: string
  } | null
  stats: {
    totalMessages: number
    totalWords: number
    imageCount: number
    voiceCount: number
    emojiCount: number
    myTopEmojiMd5?: string
    friendTopEmojiMd5?: string
    myTopEmojiUrl?: string
    friendTopEmojiUrl?: string
    myTopEmojiCount?: number
    friendTopEmojiCount?: number
  }
  topPhrases: Array<{ phrase: string; count: number }>
  myExclusivePhrases: Array<{ phrase: string; count: number }>
  friendExclusivePhrases: Array<{ phrase: string; count: number }>
  heatmap?: number[][]
  initiative?: { initiated: number; received: number }
  response?: { avg: number; fastest: number; slowest?: number; count: number }
  monthly?: Record<string, number>
  streak?: { days: number; startDate: string; endDate: string }
}

const DecodeText = ({ value, active }: { value: string | number; active: boolean }) => {
  const strVal = String(value)
  const [display, setDisplay] = useState(strVal)
  const decodedRef = useRef(false)

  useEffect(() => { setDisplay(strVal) }, [strVal])

  useEffect(() => {
    if (!active) {
      decodedRef.current = false
      return
    }
    if (decodedRef.current) return
    decodedRef.current = true

    const chars = '018X-/#*'
    let iter = 0
    const inv = setInterval(() => {
      setDisplay(strVal.split('').map((c, i) => {
        if (c === ',' || c === ' ' || c === ':') return c
        if (i < iter) return strVal[i]
        return chars[Math.floor(Math.random() * chars.length)]
      }).join(''))
      
      if (iter >= strVal.length) {
        clearInterval(inv)
        setDisplay(strVal)
      }
      iter += 1 / 3
    }, 35)
    return () => clearInterval(inv)
  }, [active, strVal])

  return <>{display.length > 0 ? display : value}</>
}

function DualReportWindow() {
  const navigate = useNavigate()
  const [reportData, setReportData] = useState<DualReportData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState('正在初始化...')

  const TOTAL_SCENES = 9
  const [currentScene, setCurrentScene] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const p0CanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [activeWordCloudTab, setActiveWordCloudTab] = useState<'shared' | 'my' | 'friend'>('shared')

  const containerRef = useRef<HTMLDivElement | null>(null)

  const [buttonText, setButtonText] = useState('EXTRACT RECORD')
  const [isExtracting, setIsExtracting] = useState(false)

  const [myEmojiUrl, setMyEmojiUrl] = useState<string | null>(null)
  const [friendEmojiUrl, setFriendEmojiUrl] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const username = params.get('username')
    const yearParam = params.get('year')
    const parsedYear = yearParam ? parseInt(yearParam, 10) : 0
    const year = Number.isNaN(parsedYear) ? 0 : parsedYear
    if (!username) {
      setError('缺少好友信息')
      setIsLoading(false)
      return
    }
    generateReport(username, year)
  }, [])

  const generateReport = async (friendUsername: string, year: number) => {
    const taskId = registerBackgroundTask({
      sourcePage: 'annualReport',
      title: '双人报告生成',
      detail: `正在生成 ${year === 0 ? '历史以来' : year + '年'} 双人年度报告`,
      progressText: '初始化',
      cancelable: true
    })
    setIsLoading(true)
    setError(null)
    setLoadingProgress(0)

    const removeProgressListener = window.electronAPI.dualReport.onProgress?.((payload: { status: string; progress: number }) => {
      setLoadingProgress(payload.progress)
      setLoadingStage(payload.status)
      updateBackgroundTask(taskId, {
        detail: payload.status || '正在生成年度报告',
        progressText: `${Math.max(0, Math.round(payload.progress || 0))}%`
      })
    })

    try {
      const result = await window.electronAPI.dualReport.generateReport({ friendUsername, year })
      removeProgressListener?.()
      
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', { detail: '已停止后续加载' })
        setIsLoading(false)
        return
      }
      setLoadingProgress(100)
      setLoadingStage('完成')

      if (result.success && result.data) {
        finishBackgroundTask(taskId, 'completed', { detail: '双人报告生成完成' })
        setTimeout(() => {
          setReportData(result.data!)
          setIsLoading(false)
        }, 500)
        
        if (result.data.stats?.myTopEmojiUrl) {
          setMyEmojiUrl(result.data.stats.myTopEmojiUrl)
        }
        if (result.data.stats?.friendTopEmojiUrl) {
          setFriendEmojiUrl(result.data.stats.friendTopEmojiUrl)
        }
      } else {
        finishBackgroundTask(taskId, 'failed', { detail: result.error || '生成失败' })
        setError(result.error || '生成报告失败')
        setIsLoading(false)
      }
    } catch (e) {
      removeProgressListener?.()
      finishBackgroundTask(taskId, 'failed', { detail: String(e) })
      setError(String(e))
      setIsLoading(false)
    }
  }

  const goToScene = useCallback((index: number) => {
    if (isAnimating || index === currentScene || index < 0 || index >= TOTAL_SCENES) return
    setIsAnimating(true)
    setCurrentScene(index)
    setTimeout(() => { setIsAnimating(false) }, 1500)
  }, [currentScene, isAnimating, TOTAL_SCENES])

  useEffect(() => {
    if (isLoading || error || !reportData) return

    let touchStartY = 0
    let lastWheelTime = 0

    const handleWheel = (e: WheelEvent) => {
      const now = Date.now()
      if (now - lastWheelTime < 1000) return
      if (Math.abs(e.deltaY) > 30) {
        lastWheelTime = now
        goToScene(e.deltaY > 0 ? currentScene + 1 : currentScene - 1)
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY
    }
    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault()
    }
    const handleTouchEnd = (e: TouchEvent) => {
      const deltaY = touchStartY - e.changedTouches[0].clientY
      if (deltaY > 40) goToScene(currentScene + 1)
      else if (deltaY < -40) goToScene(currentScene - 1)
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)

    return () => {
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [currentScene, isLoading, error, reportData, goToScene])

  useEffect(() => {
    if (isLoading || error || !reportData || currentScene !== 0) return

    const canvas = p0CanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    canvas.width = canvas.offsetWidth * window.devicePixelRatio
    canvas.height = canvas.offsetHeight * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    let particles = Array.from({ length: 60 }).map(() => ({
      x: Math.random() * canvas.offsetWidth,
      y: Math.random() * canvas.offsetHeight,
      r: Math.random() * 1.5 + 0.5,
      dx: (Math.random() - 0.5) * 0.2,
      dy: (Math.random() - 0.5) * 0.2,
      alpha: Math.random() * 0.5 + 0.1
    }))

    let rafId: number
    const animate = () => {
      ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight)
      particles.forEach(p => {
        p.x += p.dx
        p.y += p.dy
        if (p.x < 0 || p.x > canvas.offsetWidth) p.dx *= -1
        if (p.y < 0 || p.y > canvas.offsetHeight) p.dy *= -1
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(242, 170, 0, ${p.alpha})`
        ctx.fill()
      })
      rafId = requestAnimationFrame(animate)
    }
    animate()

    return () => cancelAnimationFrame(rafId)
  }, [isLoading, error, reportData, currentScene])

  const getSceneClass = (index: number) => {
    if (index === currentScene) return 'scene active'
    if (index < currentScene) return 'scene prev'
    return 'scene next'
  }

  const handleClose = () => { navigate('/home') }

  const formatFileYearLabel = (year: number) => (year === 0 ? '历史以来' : String(year))
  const formatMonthDayTime = (timestamp?: number) => {
    if (!timestamp || Number.isNaN(timestamp)) return ''
    const msTimestamp = timestamp > 1e12 ? timestamp : timestamp * 1000
    const date = new Date(msTimestamp)
    if (Number.isNaN(date.getTime())) return ''
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hour}:${minute}`
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForNextPaint = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => resolve()) })
  })
  
  const captureSceneDataUrl = async (): Promise<string> => {
    const captureFn = window.electronAPI.annualReport.captureCurrentWindow
    if (typeof captureFn !== 'function') throw new Error('当前版本未启用原生截图接口')
    const captureResult = await captureFn()
    if (!captureResult.success || !captureResult.dataUrl) throw new Error(captureResult.error || '原生截图失败')
    return captureResult.dataUrl
  }

  const handleExtract = async () => {
    if (isExtracting || !reportData || !containerRef.current) return

    const dirResult = await window.electronAPI.dialog.openDirectory({
      title: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (dirResult.canceled || !dirResult.filePaths?.[0]) return

    const root = containerRef.current
    const sceneNames = [
      'THE_BINDING',
      'FIRST_ENCOUNTER',
      'SYNCHRONIZATION',
      'MUTUAL_INITIATIVE',
      'ECHOES',
      'THE_SPARK',
      'LEXICON',
      'VOLUME',
      'EXTRACTION'
    ]

    setIsExtracting(true)
    setButtonText('EXTRACTING...')

    try {
      const images: Array<{ name: string; dataUrl: string }> = []
      root.classList.add('exporting-scenes')
      await waitForNextPaint()
      await wait(120)
      await captureSceneDataUrl()

      for (let i = 0; i < TOTAL_SCENES; i++) {
        setCurrentScene(i)
        setButtonText(`EXTRACTING ${i + 1}/${TOTAL_SCENES}`)
        await waitForNextPaint()
        await wait(1700)

        images.push({
          name: `P${String(i).padStart(2, '0')}_${sceneNames[i] || 'SCENE'}.png`,
          dataUrl: await captureSceneDataUrl()
        })
      }

      const yearFilePrefix = formatFileYearLabel(reportData.year)
      const exportResult = await window.electronAPI.annualReport.exportImages({
        baseDir: dirResult.filePaths[0],
        folderName: `${yearFilePrefix}双人报告_分页面`,
        images
      })

      if (!exportResult.success) throw new Error(exportResult.error || '导出失败')

      setButtonText('ARCHIVED')
      setTimeout(() => setButtonText('EXTRACT RECORD'), 2000)
    } catch (err: any) {
      alert(err.message || '导出过程中出现错误')
      setButtonText('EXTRACT FAILED')
      setTimeout(() => setButtonText('EXTRACT RECORD'), 2000)
    } finally {
      setIsExtracting(false)
      root.classList.remove('exporting-scenes')
      setCurrentScene(8)
    }
  }

  if (isLoading) {
    return (
      <div className="annual-report-window dual-report-window loading dark-theme">
        <div className="top-controls">
          <button className="window-close-btn close-btn" onClick={handleClose}><X size={16} /></button>
        </div>
        <div className="loading-ring">
          <svg viewBox="0 0 100 100">
            <circle className="ring-bg" cx="50" cy="50" r="42" />
            <circle
              className="ring-progress"
              cx="50" cy="50" r="42"
              style={{ strokeDashoffset: 264 - (264 * loadingProgress / 100) }}
            />
          </svg>
          <span className="ring-text">{Math.round(loadingProgress)}%</span>
        </div>
        <p className="loading-stage">{loadingStage}</p>
        <p className="loading-hint">DUAL RECORD INIT</p>
      </div>
    )
  }

  if (error || !reportData) {
    return (
      <div className="annual-report-window dual-report-window error dark-theme">
        <div className="top-controls">
          <button className="window-close-btn close-btn" onClick={handleClose}><X size={16} /></button>
        </div>
        <h2>Report Initialization Failed</h2>
        <p>{error}</p>
      </div>
    )
  }

  const formatFirstChat = (content: string) => {
    if (!content) return ''
    if (content.includes('<?xml') || content.includes('<msg>')) {
      const match = content.match(/<title>([^<]+)<\/title>/)
      return match && match[1] ? `[${match[1]}]` : '[富文本消息]'
    }
    return content.trim()
  }

  // 计算第一句话数据
  const displayFirstChat = reportData.yearFirstChat || reportData.firstChat
  const firstChatArray = (
    reportData.yearFirstChat?.firstThreeMessages ||
    reportData.firstChatMessages ||
    (displayFirstChat ? [displayFirstChat] : [])
  ).slice(0, 3)
  
  // 聊天火花
  const showSpark = reportData.streak && reportData.streak.days > 0
  // 回复速度
  const avgResponseMins = reportData.response ? reportData.response.avg / 60 : 0
  const fastestResponseSecs = reportData.response ? reportData.response.fastest : 0
  // 主动性
  const initRate = reportData.initiative ? (reportData.initiative.initiated / (reportData.initiative.initiated + reportData.initiative.received) * 100).toFixed(1) : 50
  
  // 当前词云数据
  const currentWordList = activeWordCloudTab === 'shared' ? reportData.topPhrases 
      : activeWordCloudTab === 'my' ? reportData.myExclusivePhrases 
      : reportData.friendExclusivePhrases

  return (
    <div className={`annual-report-window dual-report-window dark-theme`} ref={containerRef}>
      <div className="top-controls">
        <button className="close-btn" onClick={handleClose} title="关闭 (Esc)"><X size={16} /></button>
      </div>

      {/* ============== 背景系统 ============== */}
      <div className="cinematic-bg-system">
        <div className="film-grain" />
        <div className="p0-bg-layer" style={{ opacity: currentScene === 0 ? 1 : 0.4 }}>
          <canvas ref={p0CanvasRef} className="p0-canvas" />
          <div className="p0-overlay-grad" />
        </div>
      </div>

      <div className="scene-container">
        
        {/* S0: THE BINDING */}
        <div className={getSceneClass(0)} id="scene-0">
          <div className="center-layout s0-layout">
            <div className="reveal-wrap">
              <div className="reveal-inner en-tag delay-1">WEFLOW · DUAL RECORD</div>
            </div>
            <div className="reveal-wrap">
              <h1 className="reveal-inner hero-title delay-2">
                <DecodeText value={reportData.year === 0 ? '所有时间' : `${reportData.year}年`} active={currentScene === 0} />
              </h1>
            </div>
            <div className="reveal-wrap">
              <div className="reveal-inner hero-desc dual-names delay-3" style={{ fontSize: '1.2rem', marginTop: '20px' }}>
                <DecodeText value={reportData.selfName || '你'} active={currentScene === 0} /> 
                <span className="amp">&</span> 
                <DecodeText value={reportData.friendName || reportData.friendUsername} active={currentScene === 0} />
              </div>
            </div>
          </div>
        </div>

        {/* S1: FIRST ENCOUNTER */}
        <div className={getSceneClass(1)} id="scene-1">
          <div className="s1-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">FIRST ENCOUNTER</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">故事的开始</h2></div>
            <div className="s1-messages reveal-inner delay-3">
              {firstChatArray.map((chat: any, idx: number) => (
                <div key={idx} className={`s1-message-item ${chat.isSentByMe ? 'sent' : ''}`}>
                  <span className="s1-meta">{chat.createTimeStr || formatMonthDayTime(chat.createTime)}</span>
                  <div className="scene-bubble s1-bubble">{formatFirstChat(chat.content)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* S2: SYNCHRONIZATION */}
        <div className={getSceneClass(2)} id="scene-2">
          <div className="center-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">SYNCHRONIZATION</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">作息波纹</h2></div>
            <div className="reveal-wrap">
              <div className="reveal-inner desc delay-3 s2-active-text">
                {reportData.heatmap ? (() => {
                  let maxVal = 0, maxDay = 0, maxHour = 0;
                  reportData.heatmap.forEach((dayRow: number[], dayIdx: number) => {
                     dayRow.forEach((val: number, hourIdx: number) => {
                       if (val > maxVal) { maxVal = val; maxDay = dayIdx; maxHour = hourIdx; }
                     });
                  });
                  const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
                  return <>在<span className="hl">{dayNames[maxDay]}</span>的<span className="hl">{String(maxHour).padStart(2, '0')}:00</span>，我们最为活跃</>
                })() : '我们的时空，在这里高频交叠'}
              </div>
            </div>
            {reportData.heatmap && (
              <div className="reveal-wrap">
              <div className="heatmap-wrapper reveal-inner delay-3">
                <ReportHeatmap data={reportData.heatmap} />
              </div>
            </div>
            )}
          </div>
        </div>

        {/* S3: MUTUAL INITIATIVE */}
        <div className={getSceneClass(3)} id="scene-3">
          <div className="center-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">MUTUAL INITIATIVE</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">情感的天平</h2></div>
            
            {reportData.initiative && (
            <div className="reveal-wrap">
              <div className="reveal-inner initiative-container delay-3">
                <div className="initiative-bar-wrapper">
                  <div className="initiative-side">
                    <div className="avatar-placeholder">
                       {reportData.selfAvatarUrl ? <img src={reportData.selfAvatarUrl} /> : reportData.selfName.substring(0, 1) || 'Me'}
                    </div>
                    <div className="count">{reportData.initiative.initiated}</div>
                    <div className="percent">{initRate}%</div>
                  </div>
                  
                  <div className="initiative-progress">
                    <div className="line-bg" />
                    <div className="initiative-indicator" style={{ left: `${initRate}%` }} />
                  </div>
                  
                  <div className="initiative-side right">
                    <div className="avatar-placeholder">
                      {reportData.friendAvatarUrl ? <img src={reportData.friendAvatarUrl} /> : reportData.friendName.substring(0, 1)}
                    </div>
                    <div className="count">{reportData.initiative.received}</div>
                    <div className="percent">{(100 - parseFloat(initRate as any)).toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            </div>
            )}
          </div>
        </div>

        {/* S4: ECHOES */}
        <div className={getSceneClass(4)} id="scene-4">
          <div className="center-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">ECHOES</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">回应的速度</h2></div>
            
            <div className="reveal-wrap">
              <div className="reveal-inner response-wrapper delay-3">
                <div className="response-circle">
                  <span className="label">AVG RESPONSE</span>
                  <span className="value"><DecodeText value={avgResponseMins.toFixed(1)} active={currentScene === 4}/><span>m</span></span>
                </div>
                
                <div className="response-stats">
                  <div className="stat-item">
                    <div className="label">FASTEST</div>
                    <div className="value"><DecodeText value={fastestResponseSecs} active={currentScene === 4}/>s</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* S5: THE SPARK */}
        <div className={getSceneClass(5)} id="scene-5">
          <div className="center-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">THE SPARK</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">连绵不绝的火花</h2></div>
            
            {showSpark && reportData.streak ? (
              <div className="reveal-wrap">
                <div className="reveal-inner streak-wrapper delay-3">
                  <span className="streak-days"><DecodeText value={reportData.streak.days} active={currentScene === 5}/></span>
                  <span className="streak-label">DAYS STREAK</span>
                  <div className="streak-dates">
                     {reportData.streak.startDate}
                     <div className="line" />
                     {reportData.streak.endDate}
                  </div>
                </div>
              </div>
            ) : (
               <div className="reveal-wrap"><p className="reveal-inner desc delay-3" style={{marginTop:"3vh"}}>火种尚未点亮...</p></div>
            )}
          </div>
        </div>

        {/* S6: LEXICON */}
        <div className={getSceneClass(6)} id="scene-6">
          <div className="center-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">LEXICON</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">专属词典</h2></div>
            
            <div className="reveal-wrap">
              <div className="reveal-inner word-cloud-wrapper-outer delay-3">
                <div className="word-cloud-tabs">
                  <button className={`tab-item ${activeWordCloudTab === 'shared' ? 'active' : ''}`} onClick={() => setActiveWordCloudTab('shared')}>共同</button>
                  <button className={`tab-item ${activeWordCloudTab === 'my' ? 'active' : ''}`} onClick={() => setActiveWordCloudTab('my')}>我方</button>
                  <button className={`tab-item ${activeWordCloudTab === 'friend' ? 'active' : ''}`} onClick={() => setActiveWordCloudTab('friend')}>对方</button>
                </div>
                {currentWordList && currentWordList.length > 0 ? (
                  <ReportWordCloud words={currentWordList} />
                ) : (
                  <div style={{textAlign: 'center', marginTop: '10vh', color: 'var(--c-text-muted)'}}>没有足够的词汇数据</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* S7: VOLUME */}
        <div className={getSceneClass(7)} id="scene-7">
          <div className="center-layout">
            <div className="reveal-wrap"><div className="reveal-inner en-tag delay-1">VOLUME</div></div>
            <div className="reveal-wrap"><h2 className="reveal-inner title delay-2">数据归档</h2></div>
            
            <div className="reveal-wrap">
              <div className="reveal-inner stats-grid delay-3" style={{ background: 'transparent' }}>
                <div className="stat-card">
                  <div className="val"><DecodeText value={reportData.stats.totalMessages} active={currentScene === 7}/></div>
                  <div className="lbl">MESSAGES</div>
                </div>
                <div className="stat-card">
                  <div className="val"><DecodeText value={reportData.stats.totalWords} active={currentScene === 7}/></div>
                  <div className="lbl">WORDS</div>
                </div>
                <div className="stat-card">
                  <div className="val"><DecodeText value={reportData.stats.imageCount} active={currentScene === 7}/></div>
                  <div className="lbl">IMAGES</div>
                </div>
                <div className="stat-card">
                  <div className="val"><DecodeText value={reportData.stats.emojiCount} active={currentScene === 7}/></div>
                  <div className="lbl">EMOJIS</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* S8: EXTRACTION */}
        <div className={getSceneClass(8)} id="scene-8">
          <div className="center-layout">
            <div className="reveal-wrap">
              <h1 className="reveal-inner extract-title delay-1">ARCHIVED</h1>
            </div>
            <div className="reveal-wrap">
              <p className="reveal-inner desc delay-2">WeFlow</p>
            </div>
            <div className="reveal-wrap">
              <button 
                className={`reveal-inner extract-btn delay-3 ${isExtracting ? 'processing' : ''}`}
                onClick={handleExtract}
                disabled={isExtracting}
              >
                {buttonText}
              </button>
            </div>
          </div>
        </div>

      </div>
      
      {/* 底部导航点 */}
      <div className="scene-nav">
        {Array.from({ length: TOTAL_SCENES }).map((_, i) => (
          <div 
            key={i} 
            className={`nav-dot ${i === currentScene ? 'active' : ''}`} 
            onClick={() => goToScene(i)}
          />
        ))}
      </div>
    </div>
  )
}

export default DualReportWindow
