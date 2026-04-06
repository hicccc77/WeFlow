import { useState, useEffect, useRef } from 'react'
import { Loader2, Download, Image, Check, X, SlidersHorizontal } from 'lucide-react'
import html2canvas from 'html2canvas'
import { useThemeStore } from '../stores/themeStore'
import {
  finishBackgroundTask,
  isBackgroundTaskCancelRequested,
  registerBackgroundTask,
  updateBackgroundTask
} from '../services/backgroundTaskMonitor'
import { drawPatternBackground } from '../utils/reportExport'
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
  socialInitiative?: { initiatedChats: number; receivedChats: number; initiativeRate: number } | null
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

interface SectionInfo {
  id: string
  name: string
  ref: React.RefObject<HTMLElement | null>
}

// 头像组件
const Avatar = ({ url, name, size = 'md' }: { url?: string; name: string; size?: 'sm' | 'md' | 'lg' }) => {
  const [imgError, setImgError] = useState(false)
  const initial = name?.[0] || '友'

  return (
    <div className={`avatar ${size}`}>
      {url && !imgError ? (
        <img src={url} alt="" onError={() => setImgError(true)} crossOrigin="anonymous" />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  )
}

import Heatmap from '../components/ReportHeatmap'
import WordCloud from '../components/ReportWordCloud'

function AnnualReportWindow() {
  const [reportData, setReportData] = useState<AnnualReportData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [showExportModal, setShowExportModal] = useState(false)
  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set())
  const [fabOpen, setFabOpen] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState('正在初始化...')
  const [exportMode, setExportMode] = useState<'separate' | 'long'>('separate')

  const { currentTheme, themeMode } = useThemeStore()

  // Section refs
  const sectionRefs = {
    cover: useRef<HTMLElement>(null),
    overview: useRef<HTMLElement>(null),
    bestFriend: useRef<HTMLElement>(null),
    monthlyFriends: useRef<HTMLElement>(null),
    mutualFriend: useRef<HTMLElement>(null),
    socialInitiative: useRef<HTMLElement>(null),
    peakDay: useRef<HTMLElement>(null),
    streak: useRef<HTMLElement>(null),
    heatmap: useRef<HTMLElement>(null),
    midnightKing: useRef<HTMLElement>(null),
    responseSpeed: useRef<HTMLElement>(null),
    topPhrases: useRef<HTMLElement>(null),
    ranking: useRef<HTMLElement>(null),
    sns: useRef<HTMLElement>(null),
    lostFriend: useRef<HTMLElement>(null),
    ending: useRef<HTMLElement>(null),
  }

  const containerRef = useRef<HTMLDivElement>(null)

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
      detail: `正在生成 ${formatYearLabel(year)} 年度报告`,
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

  const formatNumber = (num: number) => num.toLocaleString()

  const getMostActiveTime = (data: number[][]) => {
    let maxHour = 0, maxWeekday = 0, maxVal = 0
    data.forEach((row, w) => {
      row.forEach((val, h) => {
        if (val > maxVal) { maxVal = val; maxHour = h; maxWeekday = w }
      })
    })
    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    return { weekday: weekdayNames[maxWeekday], hour: maxHour }
  }

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}秒`
    if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`
    return `${Math.round(seconds / 3600)}小时`
  }

  const formatYearLabel = (value: number, withSuffix: boolean = true) => {
    if (value === 0) return '历史以来'
    return withSuffix ? `${value}年` : `${value}`
  }

  // 获取可用的板块列表
  const getAvailableSections = (): SectionInfo[] => {
    if (!reportData) return []
    const sections: SectionInfo[] = [
      { id: 'cover', name: '封面', ref: sectionRefs.cover },
      { id: 'overview', name: '年度概览', ref: sectionRefs.overview },
    ]
    if (reportData.coreFriends[0]) {
      sections.push({ id: 'bestFriend', name: '年度挚友', ref: sectionRefs.bestFriend })
    }
    sections.push({ id: 'monthlyFriends', name: '月度好友', ref: sectionRefs.monthlyFriends })
    if (reportData.mutualFriend) {
      sections.push({ id: 'mutualFriend', name: '双向奔赴', ref: sectionRefs.mutualFriend })
    }
    if (reportData.socialInitiative) {
      sections.push({ id: 'socialInitiative', name: '社交主动性', ref: sectionRefs.socialInitiative })
    }
    if (reportData.peakDay) {
      sections.push({ id: 'peakDay', name: '巅峰时刻', ref: sectionRefs.peakDay })
    }
    if (reportData.longestStreak) {
      sections.push({ id: 'streak', name: '聊天火花', ref: sectionRefs.streak })
    }
    sections.push({ id: 'heatmap', name: '作息规律', ref: sectionRefs.heatmap })
    if (reportData.midnightKing) {
      sections.push({ id: 'midnightKing', name: '深夜好友', ref: sectionRefs.midnightKing })
    }
    if (reportData.responseSpeed) {
      sections.push({ id: 'responseSpeed', name: '回应速度', ref: sectionRefs.responseSpeed })
    }
    if (reportData.lostFriend) {
      sections.push({ id: 'lostFriend', name: '曾经的好朋友', ref: sectionRefs.lostFriend })
    }
    if (reportData.topPhrases && reportData.topPhrases.length > 0) {
      sections.push({ id: 'topPhrases', name: '年度常用语', ref: sectionRefs.topPhrases })
    }
    sections.push({ id: 'ranking', name: '好友排行', ref: sectionRefs.ranking })
    if (reportData.snsStats && reportData.snsStats.totalPosts > 0) {
      sections.push({ id: 'sns', name: '朋友圈', ref: sectionRefs.sns })
    }
    sections.push({ id: 'ending', name: '尾声', ref: sectionRefs.ending })
    return sections
  }

  // 导出单个板块 - 统一 16:9 尺寸
  const exportSection = async (section: SectionInfo): Promise<{ name: string; data: string } | null> => {
    const element = section.ref.current
    if (!element) {
      return null
    }

    // 固定输出尺寸 1920x1080 (16:9)
    const OUTPUT_WIDTH = 1920
    const OUTPUT_HEIGHT = 1080

    try {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) selection.removeAllRanges()
      const activeEl = document.activeElement as HTMLElement | null
      activeEl?.blur?.()
      document.body.classList.add('exporting-snapshot')
      document.documentElement.classList.add('exporting-snapshot')

      const originalStyle = element.style.cssText
      element.style.minHeight = 'auto'
      element.style.padding = '40px 20px'
      element.style.background = 'transparent'
      element.style.backgroundColor = 'transparent'
      element.style.boxShadow = 'none'

      // 修复词云
      const wordCloudInner = element.querySelector('.word-cloud-inner') as HTMLElement
      const wordTags = element.querySelectorAll('.word-tag') as NodeListOf<HTMLElement>
      let wordCloudOriginalStyle = ''
      const wordTagOriginalStyles: string[] = []

      if (wordCloudInner) {
        wordCloudOriginalStyle = wordCloudInner.style.cssText
        wordCloudInner.style.transform = 'none'
      }

      wordTags.forEach((tag, i) => {
        wordTagOriginalStyles[i] = tag.style.cssText
        tag.style.opacity = String(tag.style.getPropertyValue('--final-opacity') || '1')
        tag.style.animation = 'none'
      })

      await new Promise(r => setTimeout(r, 50))

      const computedStyle = getComputedStyle(document.documentElement)
      const bgColor = computedStyle.getPropertyValue('--bg-primary').trim() || '#F9F8F6'

      const canvas = await html2canvas(element, {
        backgroundColor: 'transparent', // 透明背景，让 SVG 图案显示
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        onclone: (clonedDoc) => {
          clonedDoc.body.classList.add('exporting-snapshot')
          clonedDoc.documentElement.classList.add('exporting-snapshot')
          clonedDoc.getSelection?.()?.removeAllRanges()
        },
      })

      // 恢复样式
      element.style.cssText = originalStyle
      if (wordCloudInner) {
        wordCloudInner.style.cssText = wordCloudOriginalStyle
      }
      wordTags.forEach((tag, i) => {
        tag.style.cssText = wordTagOriginalStyles[i]
      })
      document.body.classList.remove('exporting-snapshot')
      document.documentElement.classList.remove('exporting-snapshot')

      // 创建固定 16:9 尺寸的画布
      const outputCanvas = document.createElement('canvas')
      outputCanvas.width = OUTPUT_WIDTH
      outputCanvas.height = OUTPUT_HEIGHT
      const ctx = outputCanvas.getContext('2d')!

      // 绘制带 SVG 图案的背景
      const isDark = themeMode === 'dark'
      await drawPatternBackground(ctx, OUTPUT_WIDTH, OUTPUT_HEIGHT, bgColor, isDark)

      // 边距 (留出更多空白)
      const PADDING = 80
      const contentWidth = OUTPUT_WIDTH - PADDING * 2
      const contentHeight = OUTPUT_HEIGHT - PADDING * 2

      // 计算缩放和居中位置
      const srcRatio = canvas.width / canvas.height
      const dstRatio = contentWidth / contentHeight
      let drawWidth: number, drawHeight: number, drawX: number, drawY: number

      if (srcRatio > dstRatio) {
        // 源图更宽，以宽度为准
        drawWidth = contentWidth
        drawHeight = contentWidth / srcRatio
        drawX = PADDING
        drawY = PADDING + (contentHeight - drawHeight) / 2
      } else {
        // 源图更高，以高度为准
        drawHeight = contentHeight
        drawWidth = contentHeight * srcRatio
        drawX = PADDING + (contentWidth - drawWidth) / 2
        drawY = PADDING
      }

      ctx.drawImage(canvas, drawX, drawY, drawWidth, drawHeight)

      return { name: section.name, data: outputCanvas.toDataURL('image/png') }
    } catch (e) {
      document.body.classList.remove('exporting-snapshot')
      return null
    }
  }

  // 导出整个报告为长图
  const exportFullReport = async (filterIds?: Set<string>) => {
    if (!containerRef.current) {
      return
    }
    setIsExporting(true)
    setExportProgress('正在生成长图...')

    try {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) selection.removeAllRanges()
      const activeEl = document.activeElement as HTMLElement | null
      activeEl?.blur?.()
      document.body.classList.add('exporting-snapshot')
      document.documentElement.classList.add('exporting-snapshot')

      const container = containerRef.current
      const sections = container.querySelectorAll('.section')
      const originalStyles: string[] = []

      sections.forEach((section, i) => {
        const el = section as HTMLElement
        originalStyles[i] = el.style.cssText
        el.style.minHeight = 'auto'
        el.style.padding = '40px 0'
      })

      // 如果有筛选，隐藏未选中的板块
      if (filterIds) {
        const available = getAvailableSections()
        available.forEach(s => {
          if (!filterIds.has(s.id) && s.ref.current) {
            s.ref.current.style.display = 'none'
          }
        })
      }

      // 修复词云导出问题
      const wordCloudInner = container.querySelector('.word-cloud-inner') as HTMLElement
      const wordTags = container.querySelectorAll('.word-tag') as NodeListOf<HTMLElement>
      let wordCloudOriginalStyle = ''
      const wordTagOriginalStyles: string[] = []

      if (wordCloudInner) {
        wordCloudOriginalStyle = wordCloudInner.style.cssText
        wordCloudInner.style.transform = 'none'
      }

      wordTags.forEach((tag, i) => {
        wordTagOriginalStyles[i] = tag.style.cssText
        tag.style.opacity = String(tag.style.getPropertyValue('--final-opacity') || '1')
        tag.style.animation = 'none'
      })

      // 等待样式生效
      await new Promise(r => setTimeout(r, 100))

      // 获取计算后的背景色
      const computedStyle = getComputedStyle(document.documentElement)
      const bgColor = computedStyle.getPropertyValue('--bg-primary').trim() || '#F9F8F6'

      const canvas = await html2canvas(container, {
        backgroundColor: 'transparent', // 透明背景
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        onclone: (clonedDoc) => {
          clonedDoc.body.classList.add('exporting-snapshot')
          clonedDoc.documentElement.classList.add('exporting-snapshot')
          clonedDoc.getSelection?.()?.removeAllRanges()
        },
      })

      // 恢复原始样式
      sections.forEach((section, i) => {
        const el = section as HTMLElement
        el.style.cssText = originalStyles[i]
      })

      if (wordCloudInner) {
        wordCloudInner.style.cssText = wordCloudOriginalStyle
      }

      wordTags.forEach((tag, i) => {
        tag.style.cssText = wordTagOriginalStyles[i]
      })
      document.body.classList.remove('exporting-snapshot')
      document.documentElement.classList.remove('exporting-snapshot')

      // 创建带 SVG 图案背景的输出画布
      const outputCanvas = document.createElement('canvas')
      outputCanvas.width = canvas.width
      outputCanvas.height = canvas.height
      const ctx = outputCanvas.getContext('2d')!

      // 绘制 SVG 图案背景
      const isDark = themeMode === 'dark'
      await drawPatternBackground(ctx, canvas.width, canvas.height, bgColor, isDark)

      // 绘制内容
      ctx.drawImage(canvas, 0, 0)

      const dataUrl = outputCanvas.toDataURL('image/png')
      const link = document.createElement('a')
      const yearFilePrefix = reportData ? formatYearLabel(reportData.year, false) : ''
      link.download = `${yearFilePrefix}年度报告${filterIds ? '_自定义' : ''}.png`
      link.href = dataUrl
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (e) {
      alert('导出失败: ' + String(e))
    } finally {
      document.body.classList.remove('exporting-snapshot')
      document.documentElement.classList.remove('exporting-snapshot')
      setIsExporting(false)
      setExportProgress('')
    }
  }

  // 导出选中的板块
  const exportSelectedSections = async () => {
    const sections = getAvailableSections().filter(s => selectedSections.has(s.id))
    if (sections.length === 0) {
      alert('请至少选择一个板块')
      return
    }

    if (exportMode === 'long') {
      setShowExportModal(false)
      await exportFullReport(selectedSections)
      setSelectedSections(new Set())
      return
    }

    setIsExporting(true)
    setShowExportModal(false)

    const exportedImages: { name: string; data: string }[] = []

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      setExportProgress(`正在导出: ${section.name} (${i + 1}/${sections.length})`)

      const result = await exportSection(section)
      if (result) {
        exportedImages.push(result)
      }
    }

    if (exportedImages.length === 0) {
      alert('导出失败')
      setIsExporting(false)
      setExportProgress('')
      return
    }

    const dirResult = await window.electronAPI.dialog.openDirectory({
      title: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (dirResult.canceled || !dirResult.filePaths?.[0]) {
      setIsExporting(false)
      setExportProgress('')
      return
    }

    setExportProgress('正在写入文件...')
    const yearFilePrefix = reportData ? formatYearLabel(reportData.year, false) : ''
    const exportResult = await window.electronAPI.annualReport.exportImages({
      baseDir: dirResult.filePaths[0],
      folderName: `${yearFilePrefix}年度报告_分模块`,
      images: exportedImages.map((img) => ({
        name: `${yearFilePrefix}年度报告_${img.name}.png`,
        dataUrl: img.data
      }))
    })

    if (!exportResult.success) {
      alert('导出失败: ' + (exportResult.error || '未知错误'))
    }

    setIsExporting(false)
    setExportProgress('')
    setSelectedSections(new Set())
  }

  // 切换板块选择
  const toggleSection = (id: string) => {
    const newSet = new Set(selectedSections)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedSections(newSet)
  }

  // 全选/取消全选
  const toggleAll = () => {
    const sections = getAvailableSections()
    if (selectedSections.size === sections.length) {
      setSelectedSections(new Set())
    } else {
      setSelectedSections(new Set(sections.map(s => s.id)))
    }
  }

  if (isLoading) {
    return (
      <div className="annual-report-window loading">
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

  if (error) {
    return (
      <div className="annual-report-window error">
        <p>生成报告失败: {error}</p>
      </div>
    )
  }

  if (!reportData) {
    return (
      <div className="annual-report-window error">
        <p>暂无数据</p>
      </div>
    )
  }

  const { year, totalMessages, totalFriends, coreFriends, monthlyTopFriends, peakDay, longestStreak, activityHeatmap, midnightKing, selfAvatarUrl, mutualFriend, socialInitiative, responseSpeed, topPhrases, lostFriend } = reportData
  const topFriend = coreFriends[0]
  const mostActive = getMostActiveTime(activityHeatmap.data)
  const socialStoryName = topFriend?.displayName || '好友'
  const yearTitle = formatYearLabel(year, true)
  const yearTitleShort = formatYearLabel(year, false)
  const monthlyTitle = year === 0 ? '历史以来月度好友' : `${year}年月度好友`
  const phrasesTitle = year === 0 ? '你在历史以来的常用语' : `你在${year}年的年度常用语`

  return (
    <div className="annual-report-window">
      <div className="drag-region" />

      {/* 背景装饰 */}
      <div className="bg-decoration">
        <div className="deco-circle c1" />
        <div className="deco-circle c2" />
        <div className="deco-circle c3" />
        <div className="deco-circle c4" />
        <div className="deco-circle c5" />
      </div>

      {/* 浮动操作按钮 */}
      <div className={`fab-container ${fabOpen ? 'open' : ''}`}>
        <button className="fab-item" onClick={() => { setFabOpen(false); setExportMode('separate'); setShowExportModal(true) }} title="分模块导出">
          <Image size={18} />
        </button>
        <button className="fab-item" onClick={() => { setFabOpen(false); setExportMode('long'); setShowExportModal(true) }} title="自定义导出长图">
          <SlidersHorizontal size={18} />
        </button>
        <button className="fab-item" onClick={() => { setFabOpen(false); exportFullReport() }} title="导出长图">
          <Download size={18} />
        </button>
        <button className="fab-main" onClick={() => setFabOpen(!fabOpen)}>
          {fabOpen ? <X size={22} /> : <Download size={22} />}
        </button>
      </div>

      {/* 导出进度 */}
      {isExporting && (
        <div className="export-overlay">
          <div className="export-progress-modal">
            <div className="export-spinner">
              <div className="spinner-ring"></div>
              <Download size={24} className="spinner-icon" />
            </div>
            <p className="export-title">正在导出</p>
            <p className="export-status">{exportProgress}</p>
          </div>
        </div>
      )}

      {/* 模块选择弹窗 */}
      {showExportModal && (
        <div className="export-overlay" onClick={() => setShowExportModal(false)}>
          <div className="export-modal section-selector" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{exportMode === 'long' ? '自定义导出长图' : '选择要导出的板块'}</h3>
              <button className="close-btn" onClick={() => setShowExportModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="section-grid">
              {getAvailableSections().map(section => (
                <div
                  key={section.id}
                  className={`section-card ${selectedSections.has(section.id) ? 'selected' : ''}`}
                  onClick={() => toggleSection(section.id)}
                >
                  <div className="card-check">
                    {selectedSections.has(section.id) && <Check size={14} />}
                  </div>
                  <span>{section.name}</span>
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button className="select-all-btn" onClick={toggleAll}>
                {selectedSections.size === getAvailableSections().length ? '取消全选' : '全选'}
              </button>
              <button
                className="confirm-btn"
                onClick={exportSelectedSections}
                disabled={selectedSections.size === 0}
              >
                {exportMode === 'long' ? '生成长图' : '导出'} {selectedSections.size > 0 ? `(${selectedSections.size})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="report-scroll-view">
        <div className="report-container" ref={containerRef}>

          {/* 封面 */}
          <section className="section" ref={sectionRefs.cover}>
            <div className="label-text">WEFLOW · ANNUAL REPORT</div>
            <h1 className="hero-title">{yearTitle}<br />微信聊天报告</h1>
            <hr className="divider" />
            <p className="hero-desc">每一条消息背后<br />都藏着一段独特的故事</p>
          </section>

          {/* 年度概览 */}
          <section className="section" ref={sectionRefs.overview}>
            <div className="label-text">年度概览</div>
            <h2 className="hero-title">你和你的朋友们<br />互相发过</h2>
            <div className="big-stat">
              <span className="stat-num">{formatNumber(totalMessages)}</span>
              <span className="stat-unit">条消息</span>
            </div>
            <p className="hero-desc">
              在这段时光里，你与 <span className="hl">{formatNumber(totalFriends)}</span> 位好友交换过喜怒哀乐。
              <br />每一个对话，都是一段故事的开始。
            </p>
          </section>

          {/* 年度挚友 */}
          {topFriend && (
            <section className="section" ref={sectionRefs.bestFriend}>
              <div className="label-text">年度挚友</div>
              <h2 className="hero-title">{topFriend.displayName}</h2>
              <div className="big-stat">
                <span className="stat-num">{formatNumber(topFriend.messageCount)}</span>
                <span className="stat-unit">条消息</span>
              </div>
              <p className="hero-desc">
                你发出 <span className="hl">{formatNumber(topFriend.sentCount)}</span> 条 ·
                TA发来 <span className="hl">{formatNumber(topFriend.receivedCount)}</span> 条
              </p>
              <br />
              <p className="hero-desc">
                在一起，就可以
              </p>
            </section>
          )}

          {/* 月度好友 */}
          <section className="section" ref={sectionRefs.monthlyFriends}>
            <div className="label-text">月度好友</div>
            <h2 className="hero-title">{monthlyTitle}</h2>
            <p className="hero-desc">根据12个月的聊天习惯</p>
            <div className="monthly-orbit">
              {monthlyTopFriends.map((m, i) => (
                <div key={m.month} className="monthly-item" style={{ '--i': i } as React.CSSProperties}>
                  <div className="month-label">{m.month}月</div>
                  <Avatar url={m.avatarUrl} name={m.displayName} size="sm" />
                  <div className="month-name">{m.displayName}</div>
                </div>
              ))}
              <div className="monthly-center">
                <Avatar url={selfAvatarUrl} name="我" size="lg" />
              </div>
            </div>
            <p className="hero-desc">你只管说<br />我一直在</p>
          </section>

          {/* 双向奔赴 */}
          {mutualFriend && (
            <section className="section" ref={sectionRefs.mutualFriend}>
              <div className="label-text">双向奔赴</div>
              <h2 className="hero-title">默契与平衡</h2>
              <div className="mutual-visual">
                <div className="mutual-side you">
                  <Avatar url={selfAvatarUrl} name="我" size="lg" />
                  <div className="mutual-arrow">
                    <span className="arrow-count">{formatNumber(mutualFriend.sentCount)}</span>
                    <div className="arrow-line">→</div>
                  </div>
                </div>
                <div className="mutual-center">
                  <div className="mutual-icon">🤝</div>
                  <div className="mutual-ratio">{mutualFriend.ratio}</div>
                </div>
                <div className="mutual-side friend">
                  <div className="mutual-arrow reverse">
                    <span className="arrow-count">{formatNumber(mutualFriend.receivedCount)}</span>
                    <div className="arrow-line">←</div>
                  </div>
                  <Avatar url={mutualFriend.avatarUrl} name={mutualFriend.displayName} size="lg" />
                </div>
              </div>
              <div className="mutual-name-tag">{mutualFriend.displayName}</div>
              <p className="hero-desc">
                你们的互动比例接近 <span className="hl">{mutualFriend.ratio}</span>。
                <br />你来我往，势均力敌。
              </p>
            </section>
          )}

          {/* 社交主动性 */}
          {socialInitiative && (
            <section className="section" ref={sectionRefs.socialInitiative}>
              <div className="label-text">社交主动性</div>
              <h2 className="hero-title">主动才有故事</h2>
              <div className="big-stat">
                <span className="stat-num">{socialInitiative.initiativeRate}%</span>
                <span className="stat-unit">的对话由你发起</span>
              </div>
              <p className="hero-desc">
                面对 <span className="hl">{socialStoryName}</span> 的时候，你总是那个先开口的人。
              </p>
            </section>
          )}

          {/* 巅峰时刻 */}
          {peakDay && (
            <section className="section" ref={sectionRefs.peakDay}>
              <div className="label-text">巅峰时刻</div>
              <h2 className="hero-title">{peakDay.date}</h2>
              <p className="hero-desc">一天里你一共发了</p>
              <div className="big-stat">
                <span className="stat-num">{formatNumber(peakDay.messageCount)}</span>
                <span className="stat-unit">条消息</span>
              </div>
              <p className="hero-desc">
                在这个快节奏的世界，有人正陪在你身边听你慢慢地讲
                <br />那天，你和 <span className="hl">{peakDay.topFriend || '好友'}</span> 的 {formatNumber(peakDay.topFriendCount || 0)} 条消息见证着这一切
                <br />有些话，只想对你说
              </p>
            </section>
          )}

          {/* 聊天火花 */}
          {longestStreak && (
            <section className="section" ref={sectionRefs.streak}>
              <div className="label-text">持之以恒</div>
              <h2 className="hero-title">聊天火花</h2>
              <p className="hero-desc">与 <span className="hl">{longestStreak.friendName}</span> 持续了</p>
              <div className="big-stat">
                <span className="stat-num">{longestStreak.days}</span>
                <span className="stat-unit">天</span>
              </div>
              <p className="hero-desc">
                从 {longestStreak.startDate} 到 {longestStreak.endDate}
              </p>
              <p className="hero-desc">陪伴，是最长情的告白</p>
            </section>
          )}

          {/* 作息规律 */}
          <section className="section" ref={sectionRefs.heatmap}>
            <div className="label-text">作息规律</div>
            <h2 className="hero-title">时间的痕迹</h2>
            <p className="hero-desc active-time">
              在 <span className="hl">{mostActive.weekday} {String(mostActive.hour).padStart(2, '0')}:00</span> 最活跃
            </p>
            <Heatmap data={activityHeatmap.data} />
          </section>

          {/* 深夜好友 */}
          {midnightKing && (
            <section className="section" ref={sectionRefs.midnightKing}>
              <div className="label-text">深夜好友</div>
              <h2 className="hero-title">月光下的你</h2>
              <p className="hero-desc">在这一年你留下了</p>
              <div className="big-stat">
                <span className="stat-num">{midnightKing.count}</span>
                <span className="stat-unit">条深夜的消息</span>
              </div>
              <p className="hero-desc">
                其中 <span className="hl">{midnightKing.displayName}</span> 常常在深夜中陪着你胡思乱想。
                <br />你和Ta的对话占你深夜期间聊天的 <span className="gold">{midnightKing.percentage}%</span>。
              </p>
            </section>
          )}

          {/* 回应速度 */}
          {responseSpeed && (
            <section className="section" ref={sectionRefs.responseSpeed}>
              <div className="label-text">回应速度</div>
              <h2 className="hero-title">念念不忘，必有回响</h2>
              <div className="big-stat">
                <span className="stat-num">{formatTime(responseSpeed.avgResponseTime)}</span>
                <span className="stat-unit">是你的平均回复时间</span>
              </div>
              <p className="hero-desc">
                你回复 <span className="hl">{responseSpeed.fastestFriend}</span> 最快
                <br />平均只需 <span className="gold">{formatTime(responseSpeed.fastestTime)}</span>
              </p>
            </section>
          )}

          {/* 曾经的好朋友 */}
          {lostFriend && (
            <section className="section" ref={sectionRefs.lostFriend}>
              <div className="label-text">曾经的好朋友</div>
              <h2 className="hero-title">{lostFriend.displayName}</h2>
              <div className="big-stat">
                <span className="stat-num">{formatNumber(lostFriend.earlyCount)}</span>
                <span className="stat-unit">条消息</span>
              </div>
              <p className="hero-desc">
                在 <span className="hl">{lostFriend.periodDesc}</span>
                <br />你们曾有聊不完的话题
              </p>
              <div className="lost-friend-visual">
                <div className="avatar-group sender">
                  <Avatar url={lostFriend.avatarUrl} name={lostFriend.displayName} size="lg" />
                  <span className="avatar-label">TA</span>
                </div>
                <div className="fading-line">
                  <div className="line-path" />
                  <div className="line-glow" />
                  <div className="flow-particle" />
                </div>
                <div className="avatar-group receiver">
                  <Avatar url={selfAvatarUrl} name="我" size="lg" />
                  <span className="avatar-label">我</span>
                </div>
              </div>
              <p className="hero-desc fading">
                人类发明后悔
                <br />来证明拥有的珍贵
              </p>
            </section>
          )}

          {/* 年度常用语 - 词云 */}
          {topPhrases && topPhrases.length > 0 && (
            <section className="section" ref={sectionRefs.topPhrases}>
              <div className="label-text">年度常用语</div>
              <h2 className="hero-title">{phrasesTitle}</h2>
              <p className="hero-desc">
                这一年，你说得最多的是：
                <br />
                <span className="hl" style={{ fontSize: '20px' }}>
                  {topPhrases.slice(0, 3).map(p => p.phrase).join('、')}
                </span>
              </p>
              <WordCloud words={topPhrases} />
              <p className="hero-desc word-cloud-note">颜色越深代表出现频率越高</p>
            </section>
          )}

          {/* 朋友圈 */}
          {reportData.snsStats && reportData.snsStats.totalPosts > 0 && (
            <section className="section" ref={sectionRefs.sns}>
              <div className="label-text">朋友圈</div>
              <h2 className="hero-title">记录生活时刻</h2>
              <p className="hero-desc">
                这一年，你发布了
              </p>
              <div className="big-stat">
                <span className="stat-num">{reportData.snsStats.totalPosts}</span>
                <span className="stat-unit">条朋友圈</span>
              </div>

              <div className="sns-stats-container" style={{ display: 'flex', gap: '60px', marginTop: '40px', justifyContent: 'center' }}>
                {reportData.snsStats.topLikers.length > 0 && (
                  <div className="sns-sub-stat" style={{ textAlign: 'left' }}>
                    <h3 className="sub-title" style={{ fontSize: '18px', marginBottom: '16px', opacity: 0.8, borderBottom: '1px solid currentColor', paddingBottom: '8px' }}>更关心你的Ta</h3>
                    <div className="mini-ranking">
                      {reportData.snsStats.topLikers.slice(0, 3).map((u, i) => (
                        <div key={i} className="mini-rank-item" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                          <Avatar url={u.avatarUrl} name={u.displayName} size="sm" />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="name" style={{ fontSize: '15px', fontWeight: 500, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.displayName}</span>
                          </div>
                          <span className="count hl" style={{ fontSize: '14px', marginLeft: 'auto' }}>{u.count}赞</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {reportData.snsStats.topLiked.length > 0 && (
                  <div className="sns-sub-stat" style={{ textAlign: 'left' }}>
                    <h3 className="sub-title" style={{ fontSize: '18px', marginBottom: '16px', opacity: 0.8, borderBottom: '1px solid currentColor', paddingBottom: '8px' }}>你最关心的Ta</h3>
                    <div className="mini-ranking">
                      {reportData.snsStats.topLiked.slice(0, 3).map((u, i) => (
                        <div key={i} className="mini-rank-item" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                          <Avatar url={u.avatarUrl} name={u.displayName} size="sm" />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="name" style={{ fontSize: '15px', fontWeight: 500, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.displayName}</span>
                          </div>
                          <span className="count hl" style={{ fontSize: '14px', marginLeft: 'auto' }}>{u.count}赞</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* 好友排行 */}
          <section className="section" ref={sectionRefs.ranking}>
            <div className="label-text">好友排行</div>
            <h2 className="hero-title">聊得最多的人</h2>

            {/* 领奖台 - 前三名 */}
            <div className="podium">
              {/* 第二名 - 左边 */}
              {coreFriends[1] && (
                <div className="podium-item second">
                  <Avatar url={coreFriends[1].avatarUrl} name={coreFriends[1].displayName} size="lg" />
                  <div className="podium-name">{coreFriends[1].displayName}</div>
                  <div className="podium-count">{formatNumber(coreFriends[1].messageCount)} 条</div>
                  <div className="podium-stand">
                    <span className="podium-rank">2</span>
                  </div>
                </div>
              )}

              {/* 第一名 - 中间最高 */}
              {coreFriends[0] && (
                <div className="podium-item first">
                  <div className="crown">👑</div>
                  <Avatar url={coreFriends[0].avatarUrl} name={coreFriends[0].displayName} size="lg" />
                  <div className="podium-name">{coreFriends[0].displayName}</div>
                  <div className="podium-count">{formatNumber(coreFriends[0].messageCount)} 条</div>
                  <div className="podium-stand">
                    <span className="podium-rank">1</span>
                  </div>
                </div>
              )}

              {/* 第三名 - 右边 */}
              {coreFriends[2] && (
                <div className="podium-item third">
                  <Avatar url={coreFriends[2].avatarUrl} name={coreFriends[2].displayName} size="lg" />
                  <div className="podium-name">{coreFriends[2].displayName}</div>
                  <div className="podium-count">{formatNumber(coreFriends[2].messageCount)} 条</div>
                  <div className="podium-stand">
                    <span className="podium-rank">3</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 结尾 */}
          <section className="section ending" ref={sectionRefs.ending}>
            <h2 className="hero-title">尾声</h2>
            <p className="hero-desc">
              我们总是在向前走
              <br />却很少有机会回头看看
              <br />如果这份报告让你有所触动，不妨把它分享给你在意的人
              <br />愿新的一年，
              <br />所有期待，皆有回声。
            </p>
            <div className="ending-year">{yearTitleShort}</div>
            <div className="ending-brand">WEFLOW</div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default AnnualReportWindow
