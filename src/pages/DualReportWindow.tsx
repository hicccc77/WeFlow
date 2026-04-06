import { useEffect, useRef, useState } from 'react'
import { Check, Download, Image, SlidersHorizontal, X } from 'lucide-react'
import html2canvas from 'html2canvas'
import ReportHeatmap from '../components/ReportHeatmap'
import ReportWordCloud from '../components/ReportWordCloud'
import { useThemeStore } from '../stores/themeStore'
import { drawPatternBackground } from '../utils/reportExport'
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
  response?: { avg: number; fastest: number; slowest: number; count: number }
  monthly?: Record<string, number>
  streak?: { days: number; startDate: string; endDate: string }
}

interface SectionInfo {
  id: string
  name: string
  ref: React.RefObject<HTMLElement | null>
}

function DualReportWindow() {
  const [reportData, setReportData] = useState<DualReportData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingStage, setLoadingStage] = useState('准备中')
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [myEmojiUrl, setMyEmojiUrl] = useState<string | null>(null)
  const [friendEmojiUrl, setFriendEmojiUrl] = useState<string | null>(null)
  const [activeWordCloudTab, setActiveWordCloudTab] = useState<'shared' | 'my' | 'friend'>('shared')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [showExportModal, setShowExportModal] = useState(false)
  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set())
  const [fabOpen, setFabOpen] = useState(false)
  const [exportMode, setExportMode] = useState<'separate' | 'long'>('separate')

  const { themeMode } = useThemeStore()

  const sectionRefs = {
    cover: useRef<HTMLElement>(null),
    firstChat: useRef<HTMLElement>(null),
    yearFirstChat: useRef<HTMLElement>(null),
    heatmap: useRef<HTMLElement>(null),
    initiative: useRef<HTMLElement>(null),
    response: useRef<HTMLElement>(null),
    streak: useRef<HTMLElement>(null),
    wordCloud: useRef<HTMLElement>(null),
    stats: useRef<HTMLElement>(null),
    ending: useRef<HTMLElement>(null)
  }

  const containerRef = useRef<HTMLDivElement>(null)

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
    setIsLoading(true)
    setError(null)
    setLoadingProgress(0)

    const removeProgressListener = window.electronAPI.dualReport.onProgress?.((payload: { status: string; progress: number }) => {
      setLoadingProgress(payload.progress)
      setLoadingStage(payload.status)
    })

    try {
      const result = await window.electronAPI.dualReport.generateReport({ friendUsername, year })
      removeProgressListener?.()
      setLoadingProgress(100)
      setLoadingStage('完成')

      if (result.success && result.data) {
        const normalizedResponse = result.data.response
          ? {
            ...result.data.response,
            slowest: result.data.response.slowest ?? result.data.response.avg
          }
          : undefined
        setReportData({
          ...result.data,
          response: normalizedResponse
        })
        setIsLoading(false)
      } else {
        setError(result.error || '生成报告失败')
        setIsLoading(false)
      }
    } catch (e) {
      removeProgressListener?.()
      setError(String(e))
      setIsLoading(false)
    }
  }

  useEffect(() => {
    const loadEmojis = async () => {
      if (!reportData) return
      setMyEmojiUrl(null)
      setFriendEmojiUrl(null)
      const stats = reportData.stats
      if (stats.myTopEmojiUrl) {
        const res = await window.electronAPI.chat.downloadEmoji(stats.myTopEmojiUrl, stats.myTopEmojiMd5)
        if (res.success && res.localPath) {
          setMyEmojiUrl(res.localPath)
        }
      }
      if (stats.friendTopEmojiUrl) {
        const res = await window.electronAPI.chat.downloadEmoji(stats.friendTopEmojiUrl, stats.friendTopEmojiMd5)
        if (res.success && res.localPath) {
          setFriendEmojiUrl(res.localPath)
        }
      }
    }
    void loadEmojis()
  }, [reportData])

  const formatFileYearLabel = (year: number) => (year === 0 ? '历史以来' : String(year))

  const sanitizeFileNameSegment = (value: string) => {
    const sanitized = value.replace(/[\\/:*?"<>|]/g, '_').trim()
    return sanitized || '好友'
  }

  const getAvailableSections = (): SectionInfo[] => {
    if (!reportData) return []

    const sections: SectionInfo[] = [
      { id: 'cover', name: '封面', ref: sectionRefs.cover },
      { id: 'firstChat', name: '首次聊天', ref: sectionRefs.firstChat }
    ]

    if (reportData.yearFirstChat && (!reportData.firstChat || reportData.yearFirstChat.createTime !== reportData.firstChat.createTime)) {
      sections.push({ id: 'yearFirstChat', name: '第一段对话', ref: sectionRefs.yearFirstChat })
    }
    if (reportData.heatmap) {
      sections.push({ id: 'heatmap', name: '作息规律', ref: sectionRefs.heatmap })
    }
    if (reportData.initiative) {
      sections.push({ id: 'initiative', name: '主动性', ref: sectionRefs.initiative })
    }
    if (reportData.response) {
      sections.push({ id: 'response', name: '回应速度', ref: sectionRefs.response })
    }
    if (reportData.streak) {
      sections.push({ id: 'streak', name: '最长连续聊天', ref: sectionRefs.streak })
    }

    sections.push({ id: 'wordCloud', name: '常用语', ref: sectionRefs.wordCloud })
    sections.push({ id: 'stats', name: '年度统计', ref: sectionRefs.stats })
    sections.push({ id: 'ending', name: '尾声', ref: sectionRefs.ending })

    return sections
  }

  const exportSection = async (section: SectionInfo): Promise<{ name: string; data: string } | null> => {
    const element = section.ref.current
    if (!element) {
      return null
    }

    const OUTPUT_WIDTH = 1920
    const OUTPUT_HEIGHT = 1080
    let wordCloudInner: HTMLElement | null = null
    let wordTags: NodeListOf<HTMLElement> | null = null
    let wordCloudOriginalStyle = ''
    const wordTagOriginalStyles: string[] = []
    const originalStyle = element.style.cssText

    try {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) selection.removeAllRanges()
      const activeEl = document.activeElement as HTMLElement | null
      activeEl?.blur?.()
      document.body.classList.add('exporting-snapshot')
      document.documentElement.classList.add('exporting-snapshot')

      element.style.minHeight = 'auto'
      element.style.padding = '40px 20px'
      element.style.background = 'transparent'
      element.style.backgroundColor = 'transparent'
      element.style.boxShadow = 'none'

      wordCloudInner = element.querySelector('.word-cloud-inner') as HTMLElement | null
      wordTags = element.querySelectorAll('.word-tag') as NodeListOf<HTMLElement>

      if (wordCloudInner) {
        wordCloudOriginalStyle = wordCloudInner.style.cssText
        wordCloudInner.style.transform = 'none'
      }

      wordTags.forEach((tag, index) => {
        wordTagOriginalStyles[index] = tag.style.cssText
        tag.style.opacity = String(tag.style.getPropertyValue('--final-opacity') || '1')
        tag.style.animation = 'none'
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      const computedStyle = getComputedStyle(document.documentElement)
      const bgColor = computedStyle.getPropertyValue('--bg-primary').trim() || '#F9F8F6'

      const canvas = await html2canvas(element, {
        backgroundColor: 'transparent',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        onclone: (clonedDoc) => {
          clonedDoc.body.classList.add('exporting-snapshot')
          clonedDoc.documentElement.classList.add('exporting-snapshot')
          clonedDoc.getSelection?.()?.removeAllRanges()
        }
      })

      const outputCanvas = document.createElement('canvas')
      outputCanvas.width = OUTPUT_WIDTH
      outputCanvas.height = OUTPUT_HEIGHT
      const ctx = outputCanvas.getContext('2d')
      if (!ctx) {
        return null
      }

      const isDark = themeMode === 'dark'
      await drawPatternBackground(ctx, OUTPUT_WIDTH, OUTPUT_HEIGHT, bgColor, isDark)

      const PADDING = 80
      const contentWidth = OUTPUT_WIDTH - PADDING * 2
      const contentHeight = OUTPUT_HEIGHT - PADDING * 2
      const srcRatio = canvas.width / canvas.height
      const dstRatio = contentWidth / contentHeight

      let drawWidth: number
      let drawHeight: number
      let drawX: number
      let drawY: number

      if (srcRatio > dstRatio) {
        drawWidth = contentWidth
        drawHeight = contentWidth / srcRatio
        drawX = PADDING
        drawY = PADDING + (contentHeight - drawHeight) / 2
      } else {
        drawHeight = contentHeight
        drawWidth = contentHeight * srcRatio
        drawX = PADDING + (contentWidth - drawWidth) / 2
        drawY = PADDING
      }

      ctx.drawImage(canvas, drawX, drawY, drawWidth, drawHeight)
      return { name: section.name, data: outputCanvas.toDataURL('image/png') }
    } catch {
      return null
    } finally {
      element.style.cssText = originalStyle
      if (wordCloudInner) {
        wordCloudInner.style.cssText = wordCloudOriginalStyle
      }
      wordTags?.forEach((tag, index) => {
        tag.style.cssText = wordTagOriginalStyles[index]
      })
      document.body.classList.remove('exporting-snapshot')
      document.documentElement.classList.remove('exporting-snapshot')
    }
  }

  const exportFullReport = async (filterIds?: Set<string>) => {
    if (!containerRef.current || !reportData) {
      return
    }

    setIsExporting(true)
    setExportProgress('正在生成长图...')

    let wordCloudInner: HTMLElement | null = null
    let wordTags: NodeListOf<HTMLElement> | null = null
    let wordCloudOriginalStyle = ''
    const wordTagOriginalStyles: string[] = []
    const container = containerRef.current
    const sections = Array.from(container.querySelectorAll('.section')) as HTMLElement[]
    const originalStyles = sections.map((section) => section.style.cssText)

    try {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) selection.removeAllRanges()
      const activeEl = document.activeElement as HTMLElement | null
      activeEl?.blur?.()
      document.body.classList.add('exporting-snapshot')
      document.documentElement.classList.add('exporting-snapshot')

      sections.forEach((section) => {
        section.style.minHeight = 'auto'
        section.style.padding = '40px 0'
      })

      if (filterIds) {
        getAvailableSections().forEach((section) => {
          if (!filterIds.has(section.id) && section.ref.current) {
            section.ref.current.style.display = 'none'
          }
        })
      }

      wordCloudInner = container.querySelector('.word-cloud-inner') as HTMLElement | null
      wordTags = container.querySelectorAll('.word-tag') as NodeListOf<HTMLElement>

      if (wordCloudInner) {
        wordCloudOriginalStyle = wordCloudInner.style.cssText
        wordCloudInner.style.transform = 'none'
      }

      wordTags.forEach((tag, index) => {
        wordTagOriginalStyles[index] = tag.style.cssText
        tag.style.opacity = String(tag.style.getPropertyValue('--final-opacity') || '1')
        tag.style.animation = 'none'
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      const computedStyle = getComputedStyle(document.documentElement)
      const bgColor = computedStyle.getPropertyValue('--bg-primary').trim() || '#F9F8F6'

      const canvas = await html2canvas(container, {
        backgroundColor: 'transparent',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        onclone: (clonedDoc) => {
          clonedDoc.body.classList.add('exporting-snapshot')
          clonedDoc.documentElement.classList.add('exporting-snapshot')
          clonedDoc.getSelection?.()?.removeAllRanges()
        }
      })

      const outputCanvas = document.createElement('canvas')
      outputCanvas.width = canvas.width
      outputCanvas.height = canvas.height
      const ctx = outputCanvas.getContext('2d')
      if (!ctx) {
        throw new Error('无法创建导出画布')
      }

      const isDark = themeMode === 'dark'
      await drawPatternBackground(ctx, canvas.width, canvas.height, bgColor, isDark)
      ctx.drawImage(canvas, 0, 0)

      const yearFilePrefix = formatFileYearLabel(reportData.year)
      const friendFileSegment = sanitizeFileNameSegment(reportData.friendName || reportData.friendUsername)
      const link = document.createElement('a')
      link.download = `${yearFilePrefix}双人年度报告_${friendFileSegment}${filterIds ? '_自定义' : ''}.png`
      link.href = outputCanvas.toDataURL('image/png')
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (e) {
      alert('导出失败: ' + String(e))
    } finally {
      sections.forEach((section, index) => {
        section.style.cssText = originalStyles[index]
      })
      if (wordCloudInner) {
        wordCloudInner.style.cssText = wordCloudOriginalStyle
      }
      wordTags?.forEach((tag, index) => {
        tag.style.cssText = wordTagOriginalStyles[index]
      })
      document.body.classList.remove('exporting-snapshot')
      document.documentElement.classList.remove('exporting-snapshot')
      setIsExporting(false)
      setExportProgress('')
    }
  }

  const exportSelectedSections = async () => {
    if (!reportData) return

    const sections = getAvailableSections().filter((section) => selectedSections.has(section.id))
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

    const exportedImages: Array<{ name: string; data: string }> = []

    for (let index = 0; index < sections.length; index++) {
      const section = sections[index]
      setExportProgress(`正在导出: ${section.name} (${index + 1}/${sections.length})`)

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
    const yearFilePrefix = formatFileYearLabel(reportData.year)
    const friendFileSegment = sanitizeFileNameSegment(reportData.friendName || reportData.friendUsername)
    const exportResult = await window.electronAPI.annualReport.exportImages({
      baseDir: dirResult.filePaths[0],
      folderName: `${yearFilePrefix}双人年度报告_${friendFileSegment}_分模块`,
      images: exportedImages.map((image) => ({
        name: `${yearFilePrefix}双人年度报告_${friendFileSegment}_${image.name}.png`,
        dataUrl: image.data
      }))
    })

    if (!exportResult.success) {
      alert('导出失败: ' + (exportResult.error || '未知错误'))
    }

    setIsExporting(false)
    setExportProgress('')
    setSelectedSections(new Set())
  }

  const toggleSection = (id: string) => {
    const next = new Set(selectedSections)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedSections(next)
  }

  const toggleAll = () => {
    const sections = getAvailableSections()
    if (selectedSections.size === sections.length) {
      setSelectedSections(new Set())
      return
    }
    setSelectedSections(new Set(sections.map((section) => section.id)))
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

  const yearTitle = reportData.year === 0 ? '全部时间' : `${reportData.year}年`
  const firstChat = reportData.firstChat
  const firstChatMessages = (reportData.firstChatMessages && reportData.firstChatMessages.length > 0)
    ? reportData.firstChatMessages.slice(0, 3)
    : firstChat
      ? [{
        content: firstChat.content,
        isSentByMe: firstChat.isSentByMe,
        createTime: firstChat.createTime,
        createTimeStr: firstChat.createTimeStr
      }]
      : []
  const daysSince = firstChat
    ? Math.max(0, Math.floor((Date.now() - firstChat.createTime) / 86400000))
    : null
  const yearFirstChat = reportData.yearFirstChat
  const stats = reportData.stats
  const initiativeTotal = (reportData.initiative?.initiated || 0) + (reportData.initiative?.received || 0)
  const initiatedPercent = initiativeTotal > 0 ? (reportData.initiative!.initiated / initiativeTotal) * 100 : 0
  const receivedPercent = initiativeTotal > 0 ? (reportData.initiative!.received / initiativeTotal) * 100 : 0
  const statItems = [
    { label: '总消息数', value: stats.totalMessages, color: '#07C160' },
    { label: '总字数', value: stats.totalWords, color: '#10AEFF' },
    { label: '图片', value: stats.imageCount, color: '#FFC300' },
    { label: '语音', value: stats.voiceCount, color: '#FA5151' },
    { label: '表情', value: stats.emojiCount, color: '#FA9D3B' },
  ]

  const decodeEntities = (text: string) => (
    text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  )

  const filterDisplayMessages = (messages: DualReportMessage[], maxActual: number = 3) => {
    let actualCount = 0
    const result: DualReportMessage[] = []
    for (const msg of messages) {
      const isSystem = msg.localType === 10000 || msg.localType === 10002
      if (!isSystem) {
        if (actualCount >= maxActual) break
        actualCount++
      }
      result.push(msg)
    }
    return result
  }

  const stripCdata = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const compactMessageText = (text: string) => (
    text
      .replace(/\r\n/g, '\n')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )

  const extractXmlText = (content: string) => {
    const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/i)
    if (titleMatch?.[1]) return titleMatch[1]
    const descMatch = content.match(/<des>([\s\S]*?)<\/des>/i)
    if (descMatch?.[1]) return descMatch[1]
    const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/i)
    if (summaryMatch?.[1]) return summaryMatch[1]
    const contentMatch = content.match(/<content>([\s\S]*?)<\/content>/i)
    if (contentMatch?.[1]) return contentMatch[1]
    return ''
  }

  const formatMessageContent = (content?: string, localType?: number) => {
    const isSystemMsg = localType === 10000 || localType === 10002
    if (!isSystemMsg) {
      if (localType === 3) return '[图片]'
      if (localType === 34) return '[语音]'
      if (localType === 43) return '[视频]'
      if (localType === 47) return '[表情]'
      if (localType === 42) return '[名片]'
      if (localType === 48) return '[位置]'
      if (localType === 49) return '[链接/文件]'
    }

    const raw = compactMessageText(String(content || '').trim())
    if (!raw) return '（空）'

    // 1. 尝试提取 XML 关键字段
    const titleMatch = raw.match(/<title>([\s\S]*?)<\/title>/i)
    if (titleMatch?.[1]) return compactMessageText(decodeEntities(stripCdata(titleMatch[1]).trim()))

    const descMatch = raw.match(/<des>([\s\S]*?)<\/des>/i)
    if (descMatch?.[1]) return compactMessageText(decodeEntities(stripCdata(descMatch[1]).trim()))

    const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/i)
    if (summaryMatch?.[1]) return compactMessageText(decodeEntities(stripCdata(summaryMatch[1]).trim()))

    // 2. 检查是否是 XML 结构
    const hasXmlTag = /<\s*[a-zA-Z]+[^>]*>/.test(raw)
    const looksLikeXml = /<\?xml|<msg\b|<appmsg\b|<sysmsg\b|<appattach\b|<emoji\b|<img\b|<voip\b/i.test(raw) || hasXmlTag

    if (!looksLikeXml) return raw

    // 3. 最后的尝试：移除所有 XML 标签，看是否还有有意义的文本
    const stripped = raw.replace(/<[^>]+>/g, '').trim()
    if (stripped && stripped.length > 0 && stripped.length < 50) {
      return compactMessageText(decodeEntities(stripped))
    }

    return '[多媒体消息]'
  }

  const ReportMessageItem = ({ msg }: { msg: DualReportMessage }) => {
    if (msg.localType === 47 && (msg.emojiMd5 || msg.emojiCdnUrl)) {
      const emojiUrl = msg.emojiCdnUrl || (msg.emojiMd5 ? `https://emoji.qpic.cn/wx_emoji/${msg.emojiMd5}/0` : '')
      if (emojiUrl) {
        return (
          <div className="report-emoji-container">
            <img src={emojiUrl} alt="表情" className="report-emoji-img" crossOrigin="anonymous" onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style');
            }} />
            <span style={{ display: 'none' }}>[表情]</span>
          </div>
        )
      }
    }
    return <span>{formatMessageContent(msg.content, msg.localType)}</span>
  }
  const formatFullDate = (timestamp: number) => {
    const d = new Date(timestamp)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${year}/${month}/${day} ${hour}:${minute}`
  }

  const getMostActiveTime = (data: number[][]) => {
    let maxHour = 0
    let maxWeekday = 0
    let maxVal = -1
    data.forEach((row, weekday) => {
      row.forEach((value, hour) => {
        if (value > maxVal) {
          maxVal = value
          maxHour = hour
          maxWeekday = weekday
        }
      })
    })
    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    return {
      weekday: weekdayNames[maxWeekday] || '周一',
      hour: maxHour,
      value: Math.max(0, maxVal)
    }
  }

  const mostActive = reportData.heatmap ? getMostActiveTime(reportData.heatmap) : null
  const responseAvgMinutes = reportData.response ? Math.max(0, Math.round(reportData.response.avg / 60)) : 0
  const getSceneAvatarUrl = (isSentByMe: boolean) => (isSentByMe ? reportData.selfAvatarUrl : reportData.friendAvatarUrl)
  const getSceneAvatarFallback = (isSentByMe: boolean) => (isSentByMe ? '我' : reportData.friendName.substring(0, 1))
  const renderSceneAvatar = (isSentByMe: boolean) => {
    const avatarUrl = getSceneAvatarUrl(isSentByMe)
    if (avatarUrl) {
      return (
        <div className="scene-avatar with-image">
          <img src={avatarUrl} alt={isSentByMe ? 'me-avatar' : 'friend-avatar'} crossOrigin="anonymous" />
        </div>
      )
    }
    return <div className="scene-avatar fallback">{getSceneAvatarFallback(isSentByMe)}</div>
  }

  const renderMessageList = (messages: DualReportMessage[]) => {
    const displayMsgs = filterDisplayMessages(messages)
    let lastTime = 0
    const TIME_THRESHOLD = 5 * 60 * 1000 // 5 分钟

    return displayMsgs.map((msg, idx) => {
      const isSystem = msg.localType === 10000 || msg.localType === 10002
      const showTime = idx === 0 || (msg.createTime - lastTime > TIME_THRESHOLD)
      lastTime = msg.createTime

      if (isSystem) {
        return (
          <div key={idx} className="scene-message system">
            {showTime && (
              <div className="scene-meta">
                {formatFullDate(msg.createTime).split(' ')[1]}
              </div>
            )}
            <div className="system-msg-content">
              <ReportMessageItem msg={msg} />
            </div>
          </div>
        )
      }
      return (
        <div key={idx} className={`scene-message ${msg.isSentByMe ? 'sent' : 'received'}`}>
          {showTime && (
            <div className="scene-meta">
              {formatFullDate(msg.createTime).split(' ')[1]}
            </div>
          )}
          <div className="scene-body">
            {renderSceneAvatar(msg.isSentByMe)}
            <div className="scene-content-wrapper">
              <div className={`scene-bubble ${msg.localType === 47 ? 'no-bubble' : ''}`}>
                <div className="scene-content"><ReportMessageItem msg={msg} /></div>
              </div>
            </div>
          </div>
        </div>
      )
    })
  }

  return (
    <div className="annual-report-window dual-report-window">
      <div className="drag-region" />

      <div className="bg-decoration">
        <div className="deco-circle c1" />
        <div className="deco-circle c2" />
        <div className="deco-circle c3" />
        <div className="deco-circle c4" />
        <div className="deco-circle c5" />
      </div>

      <div className={`fab-container ${fabOpen ? 'open' : ''}`}>
        <button
          className="fab-item"
          onClick={() => {
            setFabOpen(false)
            setExportMode('separate')
            setShowExportModal(true)
          }}
          title="分模块导出"
        >
          <Image size={18} />
        </button>
        <button
          className="fab-item"
          onClick={() => {
            setFabOpen(false)
            setExportMode('long')
            setShowExportModal(true)
          }}
          title="自定义导出长图"
        >
          <SlidersHorizontal size={18} />
        </button>
        <button
          className="fab-item"
          onClick={() => {
            setFabOpen(false)
            void exportFullReport()
          }}
          title="导出长图"
        >
          <Download size={18} />
        </button>
        <button className="fab-main" onClick={() => setFabOpen(!fabOpen)}>
          {fabOpen ? <X size={22} /> : <Download size={22} />}
        </button>
      </div>

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

      {showExportModal && (
        <div className="export-overlay" onClick={() => setShowExportModal(false)}>
          <div className="export-modal section-selector" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{exportMode === 'long' ? '自定义导出长图' : '选择要导出的板块'}</h3>
              <button className="close-btn" onClick={() => setShowExportModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="section-grid">
              {getAvailableSections().map((section) => (
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
                onClick={() => void exportSelectedSections()}
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
          <section className="section" ref={sectionRefs.cover}>
            <div className="label-text">WEFLOW · DUAL REPORT</div>
            <h1 className="hero-title dual-cover-title">{yearTitle}<br />双人聊天报告</h1>
            <hr className="divider" />
            <div className="dual-names">
              <span>我</span>
              <span className="amp">&amp;</span>
              <span>{reportData.friendName}</span>
            </div>
            <p className="hero-desc">每一次对话都值得被珍藏</p>
          </section>

          <section className="section" ref={sectionRefs.firstChat}>
            <div className="label-text">首次聊天</div>
            <h2 className="hero-title">故事的开始</h2>
            {firstChat ? (
              <div className="first-chat-scene">
                <div className="scene-title">第一次遇见</div>
                <div className="scene-subtitle">{formatFullDate(firstChat.createTime).split(' ')[0]}</div>
                {firstChatMessages.length > 0 ? (
                  <div className="scene-messages">
                    {renderMessageList(firstChatMessages)}
                  </div>
                ) : (
                  <div className="hero-desc" style={{ textAlign: 'center' }}>暂无消息详情</div>
                )}
                <div className="scene-footer" style={{ marginTop: '20px', textAlign: 'center', fontSize: '14px', opacity: 0.6 }}>
                  距离今天已经 {daysSince} 天
                </div>
              </div>
            ) : (
              <p className="hero-desc">暂无首条消息</p>
            )}
          </section>

          {yearFirstChat && (!firstChat || yearFirstChat.createTime !== firstChat.createTime) ? (
            <section className="section" ref={sectionRefs.yearFirstChat}>
              <div className="label-text">第一段对话</div>
              <h2 className="hero-title">
                {reportData.year === 0 ? '你们的第一段对话' : `${reportData.year}年的第一段对话`}
              </h2>
              <div className="first-chat-scene">
                <div className="scene-title">久别重逢</div>
                <div className="scene-subtitle">{formatFullDate(yearFirstChat.createTime).split(' ')[0]}</div>
                <div className="scene-messages">
                  {renderMessageList(yearFirstChat.firstThreeMessages)}
                </div>
              </div>
            </section>
          ) : null}

          {reportData.heatmap && (
            <section className="section" ref={sectionRefs.heatmap}>
              <div className="label-text">聊天习惯</div>
              <h2 className="hero-title">作息规律</h2>
              {mostActive && (
                <p className="hero-desc active-time dual-active-time">
                  在 <span className="hl">{mostActive.weekday} {String(mostActive.hour).padStart(2, '0')}:00</span> 最活跃（{mostActive.value}条）
                </p>
              )}
              <ReportHeatmap data={reportData.heatmap} />
            </section>
          )}

          {reportData.initiative && (
            <section className="section" ref={sectionRefs.initiative}>
              <div className="label-text">主动性</div>
              <h2 className="hero-title">情感的天平</h2>
              <div className="initiative-container">
                <div className="initiative-bar-wrapper">
                  <div className="initiative-side">
                    <div className="avatar-placeholder">
                      {reportData.selfAvatarUrl ? <img src={reportData.selfAvatarUrl} alt="me-avatar" crossOrigin="anonymous" /> : '我'}
                    </div>
                    <div className="count">{reportData.initiative.initiated}次</div>
                    <div className="percent">{initiatedPercent.toFixed(1)}%</div>
                  </div>
                  <div className="initiative-progress">
                    <div className="line-bg" />
                    <div
                      className="initiative-indicator"
                      style={{ left: `${initiatedPercent}%` }}
                    />
                  </div>
                  <div className="initiative-side">
                    <div className="avatar-placeholder">
                      {reportData.friendAvatarUrl ? <img src={reportData.friendAvatarUrl} alt="friend-avatar" crossOrigin="anonymous" /> : reportData.friendName.substring(0, 1)}
                    </div>
                    <div className="count">{reportData.initiative.received}次</div>
                    <div className="percent">{receivedPercent.toFixed(1)}%</div>
                  </div>
                </div>
                <div className="initiative-desc">
                  {reportData.initiative.initiated > reportData.initiative.received ? '每一个话题都是你对TA的在意' : 'TA总是那个率先打破沉默的人'}
                </div>
              </div>
            </section>
          )}

          {reportData.response && (
            <section className="section" ref={sectionRefs.response}>
              <div className="label-text">回应速度</div>
              <h2 className="hero-title">你说，我在</h2>
              <div className="response-pulse-container">
                <div className="pulse-visual">
                  <div className="pulse-ripple one" />
                  <div className="pulse-ripple two" />
                  <div className="pulse-ripple three" />

                  <div className="pulse-node left">
                    <div className="label">最快回复</div>
                    <div className="value">{reportData.response.fastest}<span>秒</span></div>
                  </div>

                  <div className="pulse-hub">
                    <div className="label">平均回复</div>
                    <div className="value">{Math.round(reportData.response.avg / 60)}<span>分</span></div>
                  </div>

                  <div className="pulse-node right">
                    <div className="label">最慢回复</div>
                    <div className="value">
                      {reportData.response.slowest > 3600
                        ? (reportData.response.slowest / 3600).toFixed(1)
                        : Math.round(reportData.response.slowest / 60)}
                      <span>{reportData.response.slowest > 3600 ? '时' : '分'}</span>
                    </div>
                  </div>
                </div>
              </div>
              <p className="hero-desc response-note">
                {`在 ${reportData.response.count} 次互动中，平均约 ${responseAvgMinutes} 分钟，最快 ${reportData.response.fastest} 秒。`}
              </p>
            </section>
          )}

          {reportData.streak && (
            <section className="section" ref={sectionRefs.streak}>
              <div className="label-text">聊天火花</div>
              <h2 className="hero-title">最长连续聊天</h2>
              <div className="streak-spark-visual premium">
                <div className="spark-ambient-glow" />

                <div className="spark-ember one" />
                <div className="spark-ember two" />
                <div className="spark-ember three" />
                <div className="spark-ember four" />

                <div className="spark-core-wrapper">
                  <div className="spark-flame-outer" />
                  <div className="spark-flame-inner" />
                  <div className="spark-core">
                    <div className="spark-days">{reportData.streak.days}</div>
                    <div className="spark-label">DAYS</div>
                  </div>
                </div>

                <div className="streak-bridge premium">
                  <div className="bridge-date start">
                    <div className="date-orb" />
                    <span>{reportData.streak.startDate}</span>
                  </div>
                  <div className="bridge-line">
                    <div className="line-glow" />
                    <div className="line-string" />
                  </div>
                  <div className="bridge-date end">
                    <span>{reportData.streak.endDate}</span>
                    <div className="date-orb" />
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="section word-cloud-section" ref={sectionRefs.wordCloud}>
            <div className="label-text">常用语</div>
            <h2 className="hero-title">{yearTitle}常用语</h2>

            <div className="word-cloud-tabs">
              <button
                className={`tab-item ${activeWordCloudTab === 'shared' ? 'active' : ''}`}
                onClick={() => setActiveWordCloudTab('shared')}
              >
                共用词汇
              </button>
              <button
                className={`tab-item ${activeWordCloudTab === 'my' ? 'active' : ''}`}
                onClick={() => setActiveWordCloudTab('my')}
              >
                我的专属
              </button>
              <button
                className={`tab-item ${activeWordCloudTab === 'friend' ? 'active' : ''}`}
                onClick={() => setActiveWordCloudTab('friend')}
              >
                TA的专属
              </button>
            </div>

            <div className={`word-cloud-container fade-in ${activeWordCloudTab}`}>
              {activeWordCloudTab === 'shared' && <ReportWordCloud words={reportData.topPhrases} />}
              {activeWordCloudTab === 'my' && (
                reportData.myExclusivePhrases && reportData.myExclusivePhrases.length > 0 ? (
                  <ReportWordCloud words={reportData.myExclusivePhrases} />
                ) : (
                  <div className="empty-state">暂无专属词汇</div>
                )
              )}
              {activeWordCloudTab === 'friend' && (
                reportData.friendExclusivePhrases && reportData.friendExclusivePhrases.length > 0 ? (
                  <ReportWordCloud words={reportData.friendExclusivePhrases} />
                ) : (
                  <div className="empty-state">暂无专属词汇</div>
                )
              )}
            </div>
          </section>

          <section className="section" ref={sectionRefs.stats}>
            <div className="label-text">年度统计</div>
            <h2 className="hero-title">{yearTitle}数据概览</h2>
            <div className="dual-stat-grid">
              {statItems.slice(0, 2).map((item) => (
                <div key={item.label} className="dual-stat-card">
                  <div className="stat-num">{item.value.toLocaleString()}</div>
                  <div className="stat-unit">{item.label}</div>
                </div>
              ))}
            </div>
            <div className="dual-stat-grid bottom">
              {statItems.slice(2).map((item) => (
                <div key={item.label} className="dual-stat-card">
                  <div className="stat-num small">{item.value.toLocaleString()}</div>
                  <div className="stat-unit">{item.label}</div>
                </div>
              ))}
            </div>

            <div className="emoji-row">
              <div className="emoji-card">
                <div className="emoji-title">我常用的表情</div>
                {myEmojiUrl ? (
                  <img src={myEmojiUrl} alt="my-emoji" crossOrigin="anonymous" onError={(e) => {
                    (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style');
                    (e.target as HTMLImageElement).style.display = 'none';
                  }} />
                ) : null}
                <div className="emoji-placeholder" style={myEmojiUrl ? { display: 'none' } : undefined}>
                  {stats.myTopEmojiMd5 || '暂无'}
                </div>
                <div className="emoji-count">{stats.myTopEmojiCount ? `${stats.myTopEmojiCount}次` : '暂无统计'}</div>
              </div>
              <div className="emoji-card">
                <div className="emoji-title">{reportData.friendName}常用的表情</div>
                {friendEmojiUrl ? (
                  <img src={friendEmojiUrl} alt="friend-emoji" crossOrigin="anonymous" onError={(e) => {
                    (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style');
                    (e.target as HTMLImageElement).style.display = 'none';
                  }} />
                ) : null}
                <div className="emoji-placeholder" style={friendEmojiUrl ? { display: 'none' } : undefined}>
                  {stats.friendTopEmojiMd5 || '暂无'}
                </div>
                <div className="emoji-count">{stats.friendTopEmojiCount ? `${stats.friendTopEmojiCount}次` : '暂无统计'}</div>
              </div>
            </div>
          </section>

          <section className="section" ref={sectionRefs.ending}>
            <div className="label-text">尾声</div>
            <h2 className="hero-title">谢谢你一直在</h2>
            <p className="hero-desc">愿我们继续把故事写下去</p>
          </section>
        </div>
      </div>
    </div>
  )
}

export default DualReportWindow
