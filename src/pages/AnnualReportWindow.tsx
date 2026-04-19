import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import html2canvas from 'html2canvas'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import './AnnualReportWindow.scss'

interface TopContact {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
}

interface MonthlyTopFriend {
  month: number
  displayName: string
  avatarUrl?: string
  messageCount: number
}

interface AnnualReportData {
  year: number
  totalMessages: number
  totalFriends: number
  coreFriends: TopContact[]
  monthlyTopFriends: MonthlyTopFriend[]
  peakDay: { date: string; messageCount: number; topFriend?: string; topFriendCount?: number } | null
  longestStreak: { friendName: string; days: number; startDate: string; endDate: string } | null
  activityHeatmap: { data: number[][] }
  midnightKing: { displayName: string; count: number; percentage: number } | null
  selfAvatarUrl?: string
  mutualFriend?: { displayName: string; avatarUrl?: string; sentCount: number; receivedCount: number; ratio: number } | null
  socialInitiative?: {
    initiatedChats: number
    receivedChats: number
    initiativeRate: number
    topInitiatedFriend?: string
    topInitiatedCount?: number
  } | null
  responseSpeed?: { avgResponseTime: number; fastestFriend: string; fastestTime: number } | null
  topPhrases?: { phrase: string; count: number }[]
  snsStats?: {
    totalPosts: number
    typeCounts?: Record<string, number>
    topLikers: { username: string; displayName: string; avatarUrl?: string; count: number }[]
    topLiked: { username: string; displayName: string; avatarUrl?: string; count: number }[]
  }
  lostFriend: {
    username: string
    displayName: string
    avatarUrl?: string
    earlyCount: number
    lateCount: number
    periodDesc: string
  } | null
}

const DecodeText = ({
  value,
  active
}: {
  value: string | number
  active: boolean
}) => {
  const strVal = String(value)
  const [display, setDisplay] = useState(strVal)
  const decodedRef = useRef(false)

  useEffect(() => {
    setDisplay(strVal)
  }, [strVal])

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

function AnnualReportWindow() {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [reportData, setReportData] = useState<AnnualReportData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState('正在初始化...')

  const TOTAL_SCENES = 11
  const [currentScene, setCurrentScene] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const p0CanvasRef = useRef<HTMLCanvasElement | null>(null)
  const s3LayoutRef = useRef<HTMLDivElement | null>(null)
  const s3ListRef = useRef<HTMLDivElement | null>(null)
  const [s3LineVars, setS3LineVars] = useState<React.CSSProperties>({})
  
  // 提取长图逻辑变量
  const [buttonText, setButtonText] = useState('EXTRACT RECORD')
  const [isExtracting, setIsExtracting] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const yearParam = params.get('year')
    const parsedYear = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear()
    const year = Number.isNaN(parsedYear) ? new Date().getFullYear() : parsedYear
    generateReport(year)
  }, [])

  const generateReport = async (year: number) => {
    const taskId = registerBackgroundTask({
      sourcePage: 'annualReport',
      title: '年度报告生成',
      detail: `正在生成 ${year === 0 ? '历史以来' : year + '年'} 年度报告`,
      progressText: '初始化',
      cancelable: true
    })
    setIsLoading(true)
    setError(null)
    setLoadingProgress(0)

    const removeProgressListener = window.electronAPI.annualReport.onProgress?.((payload: { status: string; progress: number }) => {
      setLoadingProgress(payload.progress)
      setLoadingStage(payload.status)
      updateBackgroundTask(taskId, {
        detail: payload.status || '正在生成年度报告',
        progressText: `${Math.max(0, Math.round(payload.progress || 0))}%`
      })
    })

    try {
      const result = await window.electronAPI.annualReport.generateReport(year)
      removeProgressListener?.()
      if (isBackgroundTaskCancelRequested(taskId)) {
        finishBackgroundTask(taskId, 'canceled', {
          detail: '已停止后续加载，当前报告结果未继续写入页面'
        })
        setIsLoading(false)
        return
      }
      setLoadingProgress(100)
      setLoadingStage('完成')

      if (result.success && result.data) {
        finishBackgroundTask(taskId, 'completed', {
          detail: '年度报告生成完成',
          progressText: '100%'
        })
        setTimeout(() => {
          setReportData(result.data!)
          setIsLoading(false)
        }, 300)
      } else {
        finishBackgroundTask(taskId, 'failed', {
          detail: result.error || '生成年度报告失败'
        })
        setError(result.error || '生成报告失败')
        setIsLoading(false)
      }
    } catch (e) {
      removeProgressListener?.()
      finishBackgroundTask(taskId, 'failed', {
        detail: String(e)
      })
      setError(String(e))
      setIsLoading(false)
    }
  }

  // Handle Scroll and touch events
  const goToScene = useCallback((index: number) => {
    if (isAnimating || index === currentScene || index < 0 || index >= TOTAL_SCENES) return

    setIsAnimating(true)
    setCurrentScene(index)
    
    setTimeout(() => {
      setIsAnimating(false)
    }, 1500)
  }, [currentScene, isAnimating, TOTAL_SCENES])

  useEffect(() => {
    if (isLoading || error || !reportData) return

    let touchStartY = 0
    let lastWheelTime = 0

    const handleWheel = (e: WheelEvent) => {
      const now = Date.now()
      if (now - lastWheelTime < 1000) return // Throttle wheel events
      
      if (Math.abs(e.deltaY) > 30) {
        lastWheelTime = now
        goToScene(e.deltaY > 0 ? currentScene + 1 : currentScene - 1)
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY
    }

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault() // prevent native scroll
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

    let rafId = 0
    let particles: Array<{
      x: number
      y: number
      vx: number
      vy: number
      size: number
      alpha: number
    }> = []

    const buildParticle = () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      size: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.5 + 0.1
    })

    const initParticles = () => {
      const count = Math.max(36, Math.floor((canvas.width * canvas.height) / 15000))
      particles = Array.from({ length: count }, () => buildParticle())
    }

    const resizeCanvas = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      initParticles()
    }

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        p.x += p.vx
        p.y += p.vy

        if (p.x < 0 || p.x > canvas.width) p.vx *= -1
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`
        ctx.fill()

        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j]
          const dx = p.x - q.x
          const dy = p.y - q.y
          const distance = Math.sqrt(dx * dx + dy * dy)

          if (distance < 150) {
            const lineAlpha = (1 - distance / 150) * 0.15
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(q.x, q.y)
            ctx.strokeStyle = `rgba(255, 255, 255, ${lineAlpha})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }

      rafId = requestAnimationFrame(animate)
    }

    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)
    animate()

    return () => {
      window.removeEventListener('resize', resizeCanvas)
      cancelAnimationFrame(rafId)
    }
  }, [isLoading, error, reportData, currentScene])

  useEffect(() => {
    if (isLoading || error || !reportData) return

    let rafId = 0

    const updateS3Line = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const root = document.querySelector('.annual-report-window') as HTMLElement | null
        const layout = s3LayoutRef.current
        const list = s3ListRef.current
        if (!root || !layout || !list) return

        const rootRect = root.getBoundingClientRect()
        const layoutRect = layout.getBoundingClientRect()
        const listRect = list.getBoundingClientRect()
        if (listRect.height <= 0 || layoutRect.width <= 0) return

        const leftOffset = Math.max(8, Math.min(16, layoutRect.width * 0.018))
        const lineLeft = layoutRect.left - rootRect.left + leftOffset
        const lineCenterTop = listRect.top - rootRect.top + listRect.height / 2

        setS3LineVars({
          ['--s3-line-left' as '--s3-line-left']: `${lineLeft}px`,
          ['--s3-line-top' as '--s3-line-top']: `${lineCenterTop}px`,
          ['--s3-line-height' as '--s3-line-height']: `${listRect.height}px`
        } as React.CSSProperties)
      })
    }

    updateS3Line()
    window.addEventListener('resize', updateS3Line)

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateS3Line())
      : null

    if (resizeObserver) {
      if (s3LayoutRef.current) resizeObserver.observe(s3LayoutRef.current)
      if (s3ListRef.current) resizeObserver.observe(s3ListRef.current)
    }

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updateS3Line)
      resizeObserver?.disconnect()
    }
  }, [isLoading, error, reportData, currentScene])

  const getSceneClass = (index: number) => {
    if (index === currentScene) return 'scene active'
    if (index < currentScene) return 'scene prev'
    return 'scene next'
  }

  const handleClose = () => {
    navigate('/home')
  }

  const formatFileYearLabel = (year: number) => (year === 0 ? '历史以来' : String(year))

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const handleExtract = async () => {
    if (isExtracting || !reportData || !containerRef.current) return

    const dirResult = await window.electronAPI.dialog.openDirectory({
      title: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (dirResult.canceled || !dirResult.filePaths?.[0]) return

    const root = containerRef.current
    const previousScene = currentScene
    const sceneNames = [
      'THE_ARCHIVE',
      'VOLUME',
      'NOCTURNE',
      'GRAVITY_CENTERS',
      'TIME_WAVEFORM',
      'MUTUAL_RESONANCE',
      'SOCIAL_KINETICS',
      'THE_SPARK',
      'FADING_SIGNALS',
      'LEXICON',
      'EXTRACTION'
    ]

    setIsExtracting(true)
    setButtonText('EXTRACTING...')

    try {
      const images: Array<{ name: string; dataUrl: string }> = []
      root.classList.add('exporting-scenes')

      for (let i = 0; i < TOTAL_SCENES; i++) {
        setCurrentScene(i)
        setButtonText(`EXTRACTING ${i + 1}/${TOTAL_SCENES}`)
        await wait(2000)

        const canvas = await html2canvas(root, {
          backgroundColor: '#050505',
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
          onclone: (clonedDoc) => {
            clonedDoc.querySelector('.annual-report-window')?.classList.add('exporting-scenes')
          }
        })

        images.push({
          name: `P${String(i).padStart(2, '0')}_${sceneNames[i] || `SCENE_${i}`}.png`,
          dataUrl: canvas.toDataURL('image/png')
        })
      }

      const yearFilePrefix = formatFileYearLabel(reportData.year)
      const exportResult = await window.electronAPI.annualReport.exportImages({
        baseDir: dirResult.filePaths[0],
        folderName: `${yearFilePrefix}年度报告_分页面`,
        images
      })

      if (!exportResult.success) {
        throw new Error(exportResult.error || '导出失败')
      }

      setButtonText('SAVED TO DEVICE')
    } catch (e) {
      alert(`导出失败: ${String(e)}`)
      setButtonText('EXTRACT RECORD')
    } finally {
      root.classList.remove('exporting-scenes')
      setCurrentScene(previousScene)
      await wait(80)

      setTimeout(() => {
        setButtonText('EXTRACT RECORD')
        setIsExtracting(false)
      }, 2200)
    }
  }

  if (isLoading) {
    return (
      <div className="annual-report-window loading">
        <div className="top-controls">
          <button className="close-btn" onClick={handleClose}><X size={16} /></button>
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
          <span className="ring-text">{loadingProgress}%</span>
        </div>
        <p className="loading-stage">{loadingStage}</p>
        <p className="loading-hint">进行中</p>
      </div>
    )
  }

  if (error || !reportData) {
    return (
      <div className="annual-report-window error">
        <div className="top-controls">
          <button className="close-btn" onClick={handleClose}><X size={16} /></button>
        </div>
        <p>{error ? `生成报告失败: ${error}` : '暂无数据'}</p>
      </div>
    )
  }

  const yearTitle = reportData.year === 0 ? '历史以来' : String(reportData.year)
  const finalYearLabel = reportData.year === 0 ? 'ALL YEARS' : String(reportData.year)
  const topFriends = reportData.coreFriends.slice(0, 3)
  const endingPostCount = reportData.snsStats?.totalPosts ?? 0
  const endingReceivedChats = reportData.socialInitiative?.receivedChats ?? 0
  const endingTopPhrase = reportData.topPhrases?.[0]?.phrase || ''
  const endingTopPhraseCount = reportData.topPhrases?.[0]?.count ?? 0

  return (
    <div className="annual-report-window" data-scene={currentScene} style={s3LineVars} ref={containerRef}>
      <div className="top-controls">
        <button className="close-btn" title="关闭页面" onClick={handleClose}><X size={16} /></button>
      </div>

      <div className="p0-bg-layer">
        <canvas ref={p0CanvasRef} className="p0-particle-canvas" />
        <div className="p0-center-glow" />
      </div>
      
      <div className="film-grain"></div>
      
      <div id="memory-core"></div>

      <div className="pagination">
        {Array.from({ length: TOTAL_SCENES }).map((_, i) => (
          <div 
            key={i} 
            className={`dot-nav ${currentScene === i ? 'active' : ''}`}
            onClick={() => goToScene(i)}
          />
        ))}
      </div>
      
      <div className="swipe-hint">向下滑动以继续</div>

      {/* S0: THE ARCHIVE */}
      <div className={getSceneClass(0)} id="scene-0">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">一切的起点</div>
        </div>
        <div className="reveal-wrap title-year-wrap">
          <div className="reveal-inner serif title-year delay-1">{yearTitle}</div>
        </div>
        <div className="reveal-wrap desc-text p0-desc">
          <div className="reveal-inner serif delay-2 p0-desc-inner">那些被岁月悄悄掩埋的对话<br/>原来都在这里，等待一个春天。</div>
        </div>
      </div>

      {/* S1: VOLUME */}
      <div className={getSceneClass(1)} id="scene-1">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">消息报告</div>
        </div>
        <div className="reveal-wrap">
          <div className="reveal-inner title-data delay-1 num-display">
            <DecodeText value={reportData.totalMessages.toLocaleString()} active={currentScene === 1} />
          </div>
        </div>
        <div className="reveal-wrap desc-text">
          <div className="reveal-inner serif delay-2">
            这一年，你说出了 <strong className="num-display" style={{color: '#fff'}}>{reportData.totalMessages.toLocaleString()}</strong> 句话。<br/>无数个日夜的碎碎念，都是为了在茫茫人海中，刻下彼此来过的痕迹。
          </div>
        </div>
      </div>

      {/* S2: NOCTURNE */}
      <div className={getSceneClass(2)} id="scene-2">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">深夜</div>
        </div>
        <div className="reveal-wrap">
          <div className="reveal-inner serif title-time delay-1">
             {reportData.midnightKing ? reportData.midnightKing.displayName : '00:00'}
          </div>
        </div>
        <div className="reveal-wrap">
          <br/>
          <div className="reveal-inner serif scene0-cn-tag delay-1" style={{ fontSize: '1rem', color: 'var(--c-text-muted)', margin: '1vh 0' }}>
            在深夜陪你聊天最多的人
          </div>
        </div>
        <div className="reveal-wrap desc-text">
          <div className="reveal-inner serif delay-2">
            梦境之外，你与{reportData.midnightKing ? reportData.midnightKing.displayName : '00:00'}共同醒着度过了许多个夜晚<br/>
            “曾有<strong className="num-display" style={{color: '#fff', margin: '0 10px', fontSize: '1.5rem'}}>
               <DecodeText value={(reportData.midnightKing?.count || 0).toLocaleString()} active={currentScene === 2} />
            </strong>条消息在那些无人知晓的夜里，代替星光照亮了彼此”
          </div>
        </div>
      </div>

      {/* S3: GRAVITY CENTERS */}
      <div className={getSceneClass(3)} id="scene-3">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">聊天排行</div>
        </div>

        <div className="s3-layout" ref={s3LayoutRef}>
          <div className="reveal-wrap s3-subtitle-wrap">
            <div className="reveal-inner serif delay-1 s3-subtitle">漫长的岁月里，是他们，让你的时间有了实实在在的重量。</div>
          </div>

          <div className="contact-list" ref={s3ListRef}>
            {topFriends.map((f, i) => (
              <div className="reveal-wrap s3-row-wrap" key={f.username}>
                <div className={`reveal-inner c-item delay-${i + 1}`}>
                  <div className="c-info">
                    <div className="serif c-name" style={{ color: i === 0 ? '#fff' : i === 1 ? '#bbb' : '#666' }}>
                      {f.displayName}
                    </div>
                    <div className="mono c-sub num-display">TOP {i + 1}</div>
                  </div>
                  <div className="c-count num-display" style={{ color: i === 0 ? '#fff' : '#888' }}>
                    {f.messageCount.toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
            {topFriends.length === 0 && (
              <div className="reveal-wrap s3-row-wrap">
                <div className="reveal-inner c-item delay-1">
                  <div className="c-info">
                    <div className="serif c-name" style={{ color: '#bbb' }}>暂无记录</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* S4: TIME WAVEFORM (Audio/Heartbeat timeline visual) */}
      <div className={getSceneClass(4)} id="scene-4">
        <div className="reveal-wrap en-tag" style={{ zIndex: 10 }}>
          <div className="reveal-inner serif scene0-cn-tag">TIME WAVEFORM</div>
        </div>
        <div className="reveal-wrap desc-text" style={{ position: 'absolute', top: '15vh', left: '50vw', transform: 'translateX(-50%)', textAlign: 'center', zIndex: 10, marginTop: 0, width: '100%' }}>
          <div className="reveal-inner serif delay-1" style={{color: 'rgba(255,255,255,0.6)', fontSize: '1.2rem', letterSpacing: '0.1em'}}>十二个月的更迭，就像走过了一万个冬天<br />时间在变，但好在总有人陪在身边。</div>
        </div>

        {reportData.monthlyTopFriends.length > 0 ? (
          <div style={{ position: 'absolute', top: '55vh', left: '10vw', width: '80vw', height: '1px', background: 'transparent' }}>
            {reportData.monthlyTopFriends.map((m, i) => {
               const leftPos = (i / 11) * 100; // 0% to 100%
               const isTop = i % 2 === 0; // Alternate up and down to prevent crowding
               const isRightSide = i >= 6; // Center-focus alignment logic
               
               // Pseudo-random organic height variation for audio-wave feel (from 8vh to 18vh)
               const heightVariation = 12 + (Math.sin(i * 1.5) * 6); 
               
               const alignStyle = isRightSide ? { right: '10px', alignItems: 'flex-end', textAlign: 'right' as const } : { left: '10px', alignItems: 'flex-start', textAlign: 'left' as const };

               return (
                 <div key={m.month} className="reveal-wrap float-el" style={{ position: 'absolute', left: `${leftPos}%`, top: 0, width: '1px', height: '1px', overflow: 'visible', animationDelay: `${-(i%4)*0.5}s` }}>
                    
                    {/* The connecting thread (gradient fades away from center line) */}
                    <div className={`reveal-inner delay-${(i % 5) + 1}`} style={{
                        position: 'absolute', 
                        left: '-0px', 
                        top: isTop ? `-${heightVariation}vh` : '0px',
                        width: '1px', 
                        height: `${heightVariation}vh`, 
                        background: isTop ? 'linear-gradient(to top, rgba(255,255,255,0.3), transparent)' : 'linear-gradient(to bottom, rgba(255,255,255,0.3), transparent)' 
                    }} />

                    {/* Center Glowing Dot */}
                    <div className={`reveal-inner delay-${(i % 5) + 1}`} style={{ position: 'absolute', left: '-2.5px', top: '-2.5px', width: '6px', height: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.8)', boxShadow: '0 0 10px rgba(255,255,255,0.5)' }} />

                    {/* Text Payload */}
                    <div className={`reveal-inner delay-${(i % 5) + 1}`} style={{
                        position: 'absolute',
                        ...alignStyle,
                        top: isTop ? `-${heightVariation + 2}vh` : `${heightVariation}vh`,
                        transform: 'translateY(-50%)',
                        display: 'flex',
                        flexDirection: 'column',
                        width: '20vw' // ample space to avoid wrapping
                    }}>
                        <div className="mono num-display" style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px', letterSpacing: '0.1em' }}>
                            {m.month.toString().padStart(2, '0')}
                        </div>
                        <div className="serif" style={{ fontSize: 'clamp(1rem, 2vw, 1.4rem)', color: '#fff', letterSpacing: '0.05em' }}>
                            {m.displayName}
                        </div>
                        <div className="mono num-display" style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.5)', marginTop: '4px', letterSpacing: '0.1em' }}>
                            {m.messageCount.toLocaleString()} M
                        </div>
                    </div>

                 </div>
               );
            })}
          </div>
        ) : (
          <div className="reveal-wrap desc-text" style={{ position: 'absolute', top: '50vh', left: '50vw', transform: 'translate(-50%, -50%)' }}>
            <div className="reveal-inner serif delay-1" style={{color: '#bbb'}}>暂无记忆声纹</div>
          </div>
        )}
      </div>

      {/* S5: MUTUAL RESONANCE (Mutual friend) */}
      <div className={getSceneClass(5)} id="scene-5">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">回应的艺术</div>
        </div>
        {reportData.mutualFriend ? (
          <>
            <div className="reveal-wrap desc-text" style={{ position: 'absolute', top: '20vh' }}>
              <div className="reveal-inner serif delay-1" style={{ fontSize: 'clamp(3rem, 7vw, 4rem)', color: '#fff', letterSpacing: '0.05em' }}>
                 {reportData.mutualFriend.displayName}
              </div>
            </div>
            
            <div className="reveal-wrap" style={{ position: 'absolute', top: '42vh', left: '15vw' }}>
               <div className="reveal-inner serif scene0-cn-tag delay-2" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.2em' }}>发出</div>
               <div className="reveal-inner num-display delay-2" style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', color: '#fff', marginTop: '10px' }}><DecodeText value={reportData.mutualFriend.sentCount.toLocaleString()} active={currentScene === 5} /></div>
            </div>
            <div className="reveal-wrap" style={{ position: 'absolute', top: '42vh', right: '15vw', textAlign: 'right' }}>
               <div className="reveal-inner serif scene0-cn-tag delay-2" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.2em' }}>收到</div>
               <div className="reveal-inner num-display delay-2" style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', color: '#fff', marginTop: '10px' }}><DecodeText value={reportData.mutualFriend.receivedCount.toLocaleString()} active={currentScene === 5} /></div>
            </div>

            <div className="reveal-wrap desc-text" style={{ position: 'absolute', bottom: '20vh' }}>
              <div className="reveal-inner serif delay-3">
                你们之间收发的消息高达 <strong className="num-display" style={{color: '#fff', fontSize: '1.5rem'}}>{reportData.mutualFriend.ratio}</strong> 的平衡率
                <br/>
                <span style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.5)', marginTop: '15px', display: 'block' }}>“你抛出的每一句话，都落在了对方的心里。<br/>所谓重逢，就是我走向你的时候，你也在走向我。”</span>
              </div>
            </div>
          </>
        ) : (
          <div className="reveal-wrap desc-text" style={{ marginTop: '25vh' }}><div className="reveal-inner serif delay-1">今年似乎独自咽下了很多话。<br/>请相信，分别和孤独总会迎来终结，你终会遇到那个懂你的TA。</div></div>
        )}
      </div>

      {/* S6: SOCIAL KINETICS */}
      <div className={getSceneClass(6)} id="scene-6">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">我的风格</div>
        </div>
        {reportData.socialInitiative || reportData.responseSpeed ? (
          <div style={{ position: 'absolute', top: '0', left: '0', width: '100%', height: '100%' }}>
              {reportData.socialInitiative && (
                <div className="reveal-wrap" style={{ position: 'absolute', top: '28vh', left: '15vw', width: '38vw', textAlign: 'left' }}>
                  <div className="reveal-inner serif scene0-cn-tag delay-1" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.2em' }}>我的主动性</div>
                  <div className="reveal-inner num-display delay-2" style={{ fontSize: 'clamp(4.5rem, 8vw, 7rem)', color: '#fff', lineHeight: '1', margin: '2vh 0' }}>
                    {reportData.socialInitiative.initiativeRate}%
                  </div>
                  <div className="reveal-inner serif delay-3" style={{ fontSize: '1.2rem', color: 'rgba(255,255,255,0.8)', lineHeight: '1.8' }}>
                    <div style={{ fontSize: '1.3rem', color: 'rgba(255,255,255,0.92)', marginBottom: '0.6vh' }}>
                      你的聊天开场大多由你发起。
                    </div>
                    {reportData.socialInitiative.topInitiatedFriend && (reportData.socialInitiative.topInitiatedCount || 0) > 0 ? (
                      <div style={{ marginBottom: '0.6vh' }}>
                        其中<strong style={{color: '#fff'}}>{reportData.socialInitiative.topInitiatedFriend}</strong>是你最常联系的人，
                        有<strong className="num-display" style={{color: '#fff', fontSize: '1.2rem', margin: '0 4px'}}>{(reportData.socialInitiative.topInitiatedCount || 0).toLocaleString()}</strong>次，是你先忍不住敲响了对方的门
                      </div>
                    ) : (
                      <div style={{ marginBottom: '0.6vh' }}>
                        你主动发起了<strong className="num-display" style={{color: '#fff', fontSize: '1.2rem', margin: '0 4px'}}>{reportData.socialInitiative.initiatedChats.toLocaleString()}</strong>次联络。
                      </div>
                    )}
                    <span style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.5)' }}>想见一个人的心，总是走在时间的前面。</span>
                  </div>
                </div>
              )}
              {reportData.responseSpeed && (
                <div className="reveal-wrap" style={{ position: 'absolute', bottom: '22vh', right: '15vw', width: '38vw', textAlign: 'right' }}>
                  <div className="reveal-inner serif scene0-cn-tag delay-4" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.3em' }}>回应速度</div>
                  <div className="reveal-inner num-display delay-5" style={{ fontSize: 'clamp(3.5rem, 6vw, 5rem)', color: '#ccc', lineHeight: '1', margin: '2vh 0' }}>
                    <DecodeText value={reportData.responseSpeed.fastestTime} active={currentScene === 6} />S
                  </div>
                  <div className="reveal-inner serif delay-6" style={{ fontSize: '1.2rem', color: 'rgba(255,255,255,0.8)', lineHeight: '1.8' }}>
                    <strong style={{color: '#fff'}}>{reportData.responseSpeed.fastestFriend}</strong> 回你的消息总是很快。<br/>
                    <span style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.5)' }}>这世上最让人安心的默契，莫过于一句 "我在"。</span>
                  </div>
                </div>
              )}
          </div>
        ) : (
           <div className="reveal-wrap desc-text" style={{ marginTop: '25vh' }}><div className="reveal-inner serif delay-1">暂无数据。</div></div>
        )}
      </div>

      {/* S7: THE SPARK */}
      <div className={getSceneClass(7)} id="scene-7">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">聊天火花</div>
        </div>
        
        {reportData.longestStreak ? (
           <div className="reveal-wrap" style={{ position: 'absolute', top: '35vh', left: '15vw', textAlign: 'left' }}>
             <div className="reveal-inner serif scene0-cn-tag delay-1" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.3em', marginBottom: '2vh' }}>最长连续聊天</div>
             <div className="reveal-inner serif delay-2" style={{ fontSize: 'clamp(3rem, 6vw, 5rem)', color: '#fff', letterSpacing: '0.02em' }}>
                {reportData.longestStreak.friendName}
             </div>
             <div className="reveal-inner serif delay-3" style={{ fontSize: '1.2rem', color: 'rgba(255,255,255,0.8)', marginTop: '2vh' }}>
                你们曾连续 <strong className="num-display" style={{color: '#fff', fontSize: '1.8rem'}}><DecodeText value={reportData.longestStreak.days} active={currentScene === 7} /></strong> 天，聊到忘记了时间,<br/>那些舍不得说再见的日夜，连成了最漫长的春天。
             </div>
           </div>
        ) : null}

        {reportData.peakDay ? (
           <div className="reveal-wrap" style={{ position: 'absolute', bottom: '30vh', right: '15vw', textAlign: 'right' }}>
             <div className="reveal-inner serif scene0-cn-tag delay-4" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.3em', marginBottom: '2vh' }}>最热烈的一天</div>
             <div className="reveal-inner num-display delay-5" style={{ fontSize: 'clamp(2.5rem, 5vw, 4rem)', color: '#fff', letterSpacing: '0.02em' }}>
                {reportData.peakDay.date}
             </div>
             <div className="reveal-inner serif delay-6" style={{ fontSize: '1.2rem', color: 'rgba(255,255,255,0.8)', marginTop: '2vh' }}>
                “这一天，你们留下了 <strong className="num-display" style={{color: '#fff', fontSize: '1.8rem'}}>{reportData.peakDay.messageCount}</strong> 句话。<br/>好像要把积攒了很久的想念，一天全都说完。”
             </div>
           </div>
        ) : null}
        
        {!reportData.longestStreak && !reportData.peakDay && (
           <div className="reveal-wrap desc-text" style={{ marginTop: '25vh' }}><div className="reveal-inner serif delay-1">没有激起过火花。</div></div>
        )}
      </div>

      {/* S8: FADING SIGNALS */}
      <div className={getSceneClass(8)} id="scene-8">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">曾经的好友</div>
        </div>
        {reportData.lostFriend ? (
          <div className="s8-layout">
            <div className="s8-left">
              <div className="reveal-wrap s8-name-wrap">
                <div className="reveal-inner serif delay-1 s8-name">
                  {reportData.lostFriend.displayName}
                </div>
              </div>
              <div className="reveal-wrap s8-summary-wrap">
                <div className="reveal-inner serif delay-2 s8-summary">
                  后来，你们的交集停留在{reportData.lostFriend.periodDesc}这短短的
                  <span className="num-display s8-summary-count">
                    <DecodeText value={reportData.lostFriend.lateCount.toLocaleString()} active={currentScene === 8} />
                  </span>
                  句话里。
                </div>
              </div>
              <div className="reveal-wrap s8-quote-wrap">
                <div className="reveal-inner serif delay-3 s8-quote">
                  “我一直相信我们能够再次相见，相信分别的日子总会迎来终结。”
                </div>
              </div>
            </div>
            <div className="reveal-wrap s8-letter-wrap">
              <div className="reveal-inner serif delay-4 s8-letter">
                所有的离散，或许都只是一场漫长的越冬。飞鸟要越过一万座雪山，才能带来春天的第一行回信；树木要褪去一万次枯叶，才能记住风的形状。如果时间注定要把我们推向不同的象限，那就在记忆的最深处建一座灯塔。哪怕要熬过几千个无法见面的黄昏，也要相信，总有一次日出的晨光，是为了照亮我们重逢的归途。
              </div>
            </div>
          </div>
        ) : (
          <div className="reveal-wrap desc-text s8-empty-wrap">
            <div className="reveal-inner serif delay-1 s8-empty-text">
              缘分温柔地眷顾着你。<br/>
              这一年，所有重要的人都在，没有一次无疾而终的告别。<br/>
            </div>
          </div>
        )}
      </div>

      {/* S9: LEXICON & ARCHIVE */}
      <div className={getSceneClass(9)} id="scene-9">
        <div className="reveal-wrap en-tag">
          <div className="reveal-inner serif scene0-cn-tag">我的词云</div>
        </div>

        {reportData.topPhrases && reportData.topPhrases.slice(0, 12).map((phrase, i) => {
          // 12 precisely tuned absolute coordinates for the ultimate organic scatter without overlapping
          const demoStyles = [
            { left: '25vw', top: '25vh', fontSize: 'clamp(3rem, 7vw, 5rem)', color: 'rgba(255,255,255,1)', delay: '0.1s', floatDelay: '0s', targetOp: 1 },
            { left: '72vw', top: '30vh', fontSize: 'clamp(2rem, 5vw, 4rem)', color: 'rgba(255,255,255,0.8)', delay: '0.2s', floatDelay: '-1s', targetOp: 0.8 },
            { left: '15vw', top: '55vh', fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', color: 'rgba(255,255,255,0.9)', delay: '0.3s', floatDelay: '-2.5s', targetOp: 0.9 },
            { left: '78vw', top: '60vh', fontSize: 'clamp(1.5rem, 3.5vw, 3rem)', color: 'rgba(255,255,255,0.6)', delay: '0.4s', floatDelay: '-1.5s', targetOp: 0.6 },
            { left: '45vw', top: '75vh', fontSize: 'clamp(1.2rem, 3vw, 2.5rem)', color: 'rgba(255,255,255,0.7)', delay: '0.5s', floatDelay: '-3s', targetOp: 0.7 },
            { left: '55vw', top: '15vh', fontSize: 'clamp(1.5rem, 3vw, 2.5rem)', color: 'rgba(255,255,255,0.5)', delay: '0.6s', floatDelay: '-0.5s', targetOp: 0.5 },
            { left: '12vw', top: '80vh', fontSize: 'clamp(1rem, 2vw, 1.8rem)', color: 'rgba(255,255,255,0.4)', delay: '0.7s', floatDelay: '-1.2s', targetOp: 0.4 },
            { left: '35vw', top: '45vh', fontSize: 'clamp(2.2rem, 5vw, 4rem)', color: 'rgba(255,255,255,0.85)', delay: '0.8s', floatDelay: '-0.8s', targetOp: 0.85 },
            { left: '85vw', top: '82vh', fontSize: 'clamp(0.9rem, 1.5vw, 1.5rem)', color: 'rgba(255,255,255,0.3)', delay: '0.9s', floatDelay: '-2.1s', targetOp: 0.3 },
            { left: '60vw', top: '50vh', fontSize: 'clamp(1.8rem, 4vw, 3.5rem)', color: 'rgba(255,255,255,0.65)', delay: '1s', floatDelay: '-0.3s', targetOp: 0.65 },
            { left: '45vw', top: '35vh', fontSize: 'clamp(1rem, 2vw, 1.8rem)', color: 'rgba(255,255,255,0.35)', delay: '1.1s', floatDelay: '-1.8s', targetOp: 0.35 },
            { left: '30vw', top: '65vh', fontSize: 'clamp(1.4rem, 2.5vw, 2.2rem)', color: 'rgba(255,255,255,0.55)', delay: '1.2s', floatDelay: '-2.7s', targetOp: 0.55 },
          ];
          const st = demoStyles[i];

          return (
            <div 
              key={phrase.phrase + i} 
              className="word-burst"
              style={{ 
                left: st.left, 
                top: st.top, 
                fontSize: st.fontSize, 
                color: st.color, 
                transitionDelay: st.delay, 
                '--target-op': st.targetOp 
              } as React.CSSProperties}
            >
              <span className="float-el" style={{ animationDelay: st.floatDelay }}>{phrase.phrase}</span>
            </div>
          )
        })}
        {(!reportData.topPhrases || reportData.topPhrases.length === 0) && (
           <div className="reveal-wrap desc-text" style={{ marginTop: '25vh' }}><div className="reveal-inner serif delay-1">词汇量太少，无法形成星云。</div></div>
        )}
      </div>

      {/* S10: EXTRACTION (白色反色结束页 / Data Receipt) */}
      <div className={getSceneClass(10)} id="scene-10" style={{ color: '#000' }}>
        <div className="reveal-wrap en-tag" style={{ zIndex: 20 }}>
          <div className="reveal-inner serif scene0-cn-tag" style={{color: '#999'}}>旅程的终点</div>
        </div>
        
        {/* The Final Summary Receipt / Dashboard */}
        <div className="reveal-wrap" style={{ position: 'absolute', top: '45vh', left: '50vw', transform: 'translate(-50%, -50%)', width: '60vw', textAlign: 'center', zIndex: 20 }}>
          <div className="reveal-inner delay-1" style={{ display: 'flex', flexDirection: 'column', gap: '3vh' }}>
            <div className="mono num-display" style={{ fontSize: 'clamp(3rem, 6vw, 5rem)', color: '#000', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
              {finalYearLabel}
            </div>
            <div className="mono" style={{ fontSize: '0.8rem', color: '#666', letterSpacing: '0.4em' }}>
              TRANSMISSION COMPLETE
            </div>
            
            {/* Core Stats Row */}
            <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '6vh', borderTop: '1px solid #ccc', borderBottom: '1px solid #ccc', padding: '4vh 0' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div className="serif scene0-cn-tag" style={{ fontSize: '0.75rem', color: '#888', letterSpacing: '0.1em', marginBottom: '1vh' }}>朋友圈发帖</div>
                <div className="num-display" style={{ fontSize: '2.5rem', color: '#111', fontWeight: 600 }}>{endingPostCount.toLocaleString()}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div className="serif scene0-cn-tag" style={{ fontSize: '0.75rem', color: '#888', letterSpacing: '0.1em', marginBottom: '1vh' }}>被动开场</div>
                <div className="num-display" style={{ fontSize: '2.5rem', color: '#111', fontWeight: 600 }}>{endingReceivedChats.toLocaleString()}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div className="serif scene0-cn-tag" style={{ fontSize: '0.75rem', color: '#888', letterSpacing: '0.1em', marginBottom: '1vh' }}>你最爱说</div>
                <div className="num-display" style={{ fontSize: '2.5rem', color: '#111', fontWeight: 600 }}>“{endingTopPhrase}”</div>
              </div>
            </div>
            
            <div className="serif" style={{ fontSize: '1.2rem', color: '#444', marginTop: '4vh', letterSpacing: '0.05em' }}>
              “故事的最后，我们把这一切悄悄还给岁月<br/>只要这些文字还在，所有的离别，就都只是一场短暂的缺席。”
            </div>
          </div>
        </div>

        <div className="btn-wrap" style={{ zIndex: 20, bottom: '8vh' }}>
          <div className="serif reveal-wrap" style={{ marginBottom: '20px' }}>
            <div
              className="reveal-inner delay-2"
              style={{
                fontSize: 'clamp(0.9rem, 1.15vw, 1.02rem)',
                color: '#5F5F5F',
                lineHeight: 1.95,
                letterSpacing: '0.03em',
                maxWidth: 'min(980px, 78vw)',
                textAlign: 'center',
                fontWeight: 500
              }}
            >
              数据数得清一万句落笔的寒暄，却度量不出一个默契的眼神。<br/>在这片由数字构建的大海里，热烈的回应未必是感情的全部轮廓。<br/>真正的爱与羁绊，从来都不在跳动的屏幕里，而在无法被量化的现实。
            </div>
          </div>
          <div className="reveal-wrap">
            <button 
              className="btn num-display reveal-inner delay-3" 
              onClick={handleExtract}
              disabled={isExtracting}
              style={{ 
                background: isExtracting ? '#ddd' : (buttonText === 'SAVED TO DEVICE' ? '#000' : '#000'), 
                color: '#fff',
                fontSize: '0.85rem',
                border: 'none',
                minWidth: '200px'
              }}
            >
              {buttonText}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AnnualReportWindow
