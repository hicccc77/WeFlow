import { useEffect, useState } from 'react'
import { Clock, Zap, MessageCircle, MessageSquare, Type, Image as ImageIcon, Mic, Smile } from 'lucide-react'
import ReportHeatmap from '../components/ReportHeatmap'
import ReportWordCloud from '../components/ReportWordCloud'
import './AnnualReportWindow.scss'
import './DualReportWindow.scss'

interface DualReportMessage {
  content: string
  isSentByMe: boolean
  createTime: number
  createTimeStr: string
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
  } | null
  firstChatMessages?: DualReportMessage[]
  yearFirstChat?: {
    createTime: number
    createTimeStr: string
    content: string
    isSentByMe: boolean
    friendName: string
    firstThreeMessages: DualReportMessage[]
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
  heatmap?: number[][]
  initiative?: { initiated: number; received: number }
  response?: { avg: number; fastest: number; count: number }
  monthly?: Record<string, number>
  streak?: { days: number; startDate: string; endDate: string }
}

function DualReportWindow() {
  const [reportData, setReportData] = useState<DualReportData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingStage, setLoadingStage] = useState('准备中')
  const [loadingProgress, setLoadingProgress] = useState(0)
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
        setReportData(result.data)
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
    { label: '总消息数', value: stats.totalMessages, icon: MessageSquare, color: '#07C160' },
    { label: '总字数', value: stats.totalWords, icon: Type, color: '#10AEFF' },
    { label: '图片', value: stats.imageCount, icon: ImageIcon, color: '#FFC300' },
    { label: '语音', value: stats.voiceCount, icon: Mic, color: '#FA5151' },
    { label: '表情', value: stats.emojiCount, icon: Smile, color: '#FA9D3B' },
  ]

  const decodeEntities = (text: string) => (
    text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  )

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

  const formatMessageContent = (content?: string) => {
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

    return '（多媒体/卡片消息）'
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
          <img src={avatarUrl} alt={isSentByMe ? 'me-avatar' : 'friend-avatar'} />
        </div>
      )
    }
    return <div className="scene-avatar fallback">{getSceneAvatarFallback(isSentByMe)}</div>
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

      <div className="report-scroll-view">
        <div className="report-container">
          <section className="section">
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

          <section className="section">
            <div className="label-text">首次聊天</div>
            <h2 className="hero-title">故事的开始</h2>
            {firstChat ? (
              <div className="first-chat-scene">
                <div className="scene-title">第一次遇见</div>
                <div className="scene-subtitle">{formatFullDate(firstChat.createTime).split(' ')[0]}</div>
                {firstChatMessages.length > 0 ? (
                  <div className="scene-messages">
                    {firstChatMessages.map((msg, idx) => (
                      <div key={idx} className={`scene-message ${msg.isSentByMe ? 'sent' : 'received'}`}>
                        {renderSceneAvatar(msg.isSentByMe)}
                        <div className="scene-content-wrapper">
                          <div className="scene-meta">
                            {formatFullDate(msg.createTime).split(' ')[1]}
                          </div>
                          <div className="scene-bubble">
                            <div className="scene-content">{formatMessageContent(msg.content)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="hero-desc" style={{ textAlign: 'center' }}>暂无消息详情</div>
                )}
                <div className="scene-footer" style={{ marginTop: '20px', textAlign: 'center', fontSize: '12px', opacity: 0.6 }}>
                  距离今天已经 {daysSince} 天
                </div>
              </div>
            ) : (
              <p className="hero-desc">暂无首条消息</p>
            )}
          </section>

          {yearFirstChat ? (
            <section className="section">
              <div className="label-text">第一段对话</div>
              <h2 className="hero-title">
                {reportData.year === 0 ? '你们的第一段对话' : `${reportData.year}年的第一段对话`}
              </h2>
              <div className="first-chat-scene">
                <div className="scene-title">久别重逢</div>
                <div className="scene-subtitle">{formatFullDate(yearFirstChat.createTime).split(' ')[0]}</div>
                <div className="scene-messages">
                  {yearFirstChat.firstThreeMessages.map((msg, idx) => (
                    <div key={idx} className={`scene-message ${msg.isSentByMe ? 'sent' : 'received'}`}>
                      {renderSceneAvatar(msg.isSentByMe)}
                      <div className="scene-content-wrapper">
                        <div className="scene-meta">
                          {formatFullDate(msg.createTime).split(' ')[1]}
                        </div>
                        <div className="scene-bubble">
                          <div className="scene-content">{formatMessageContent(msg.content)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {reportData.heatmap && (
            <section className="section">
              <div className="label-text">聊天习惯</div>
              <h2 className="hero-title">作息规律</h2>
              {mostActive && (
                <p className="hero-desc active-time dual-active-time">
                  {'\u5728'} <span className="hl">{mostActive.weekday} {String(mostActive.hour).padStart(2, '0')}:00</span> {'\u6700\u6d3b\u8dc3\uff08'}{mostActive.value}{'\u6761\uff09'}
                </p>
              )}
              <ReportHeatmap data={reportData.heatmap} />
            </section>
          )}

          {reportData.initiative && (
            <section className="section">
              <div className="label-text">主动性</div>
              <h2 className="hero-title">情感的天平</h2>
              <div className="initiative-container">
                <div className="initiative-desc">
                  {reportData.initiative.initiated > reportData.initiative.received ? '每一个话题都是你对TA的在意' : 'TA总是那个率先打破沉默的人'}
                </div>
                <div className="initiative-bar-wrapper">
                  <div className="initiative-side">
                    <div className="avatar-placeholder">
                      {reportData.selfAvatarUrl ? <img src={reportData.selfAvatarUrl} alt="me-avatar" /> : '\u6211'}
                    </div>
                    <div className="count">{reportData.initiative.initiated}{'\u6b21'}</div>
                    <div className="percent">{initiatedPercent.toFixed(1)}%</div>
                  </div>
                  <div className="initiative-progress">
                    <div
                      className="bar-segment left"
                      style={{ width: `${initiatedPercent}%` }}
                    />
                    <div
                      className="bar-segment right"
                      style={{ width: `${receivedPercent}%` }}
                    />
                  </div>
                  <div className="initiative-side">
                    <div className="avatar-placeholder">
                      {reportData.friendAvatarUrl ? <img src={reportData.friendAvatarUrl} alt="friend-avatar" /> : reportData.friendName.substring(0, 1)}
                    </div>
                    <div className="count">{reportData.initiative.received}{'\u6b21'}</div>
                    <div className="percent">{receivedPercent.toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {reportData.response && (
            <section className="section">
              <div className="label-text">回复速度</div>
              <h2 className="hero-title">{'\u79d2\u56de\uff0c\u662f\u56e0\u4e3a\u5728\u4e4e'}</h2>
              <div className="response-grid">
                <div className="response-card">
                  <div className="icon-box">
                    <Clock size={24} />
                  </div>
                  <div className="label">{'\u5e73\u5747\u56de\u590d'}</div>
                  <div className="value">{Math.round(reportData.response.avg / 60)}<span>{'\u5206'}</span></div>
                </div>
                <div className="response-card fastest">
                  <div className="icon-box">
                    <Zap size={24} />
                  </div>
                  <div className="label">{'\u6700\u5feb\u56de\u590d'}</div>
                  <div className="value">{reportData.response.fastest}<span>{'\u79d2'}</span></div>
                </div>
                <div className="response-card sample">
                  <div className="icon-box">
                    <MessageCircle size={24} />
                  </div>
                  <div className="label">{'\u7edf\u8ba1\u6837\u672c'}</div>
                  <div className="value">{reportData.response.count}<span>{'\u6b21'}</span></div>
                </div>
              </div>
              <p className="hero-desc response-note">
                {`\u5171\u7edf\u8ba1 ${reportData.response.count} \u6b21\u6709\u6548\u56de\u590d\uff0c\u5e73\u5747\u7ea6 ${responseAvgMinutes} \u5206\u949f\uff0c\u6700\u5feb ${reportData.response.fastest} \u79d2\u3002`}
              </p>
            </section>
          )}

          {reportData.streak && (
            <section className="section">
              <div className="label-text">{'\u804a\u5929\u706b\u82b1'}</div>
              <h2 className="hero-title">{'\u6700\u957f\u8fde\u7eed\u804a\u5929'}</h2>
              <div className="streak-container">
                <div className="streak-flame">{'\uD83D\uDD25'}</div>
                <div className="streak-days">{reportData.streak.days}<span>{'\u5929'}</span></div>
                <div className="streak-range">
                  {reportData.streak.startDate} ~ {reportData.streak.endDate}
                </div>
              </div>
            </section>
          )}

          <section className="section">
            <div className="label-text">常用语</div>
            <h2 className="hero-title">{yearTitle}常用语</h2>
            <ReportWordCloud words={reportData.topPhrases} />
          </section>

          <section className="section">
            <div className="label-text">年度统计</div>
            <h2 className="hero-title">{yearTitle}数据概览</h2>
            <div className="dual-stat-grid">
              {statItems.map((item) => {
                const valueText = item.value.toLocaleString()
                const isLong = valueText.length > 7
                const Icon = item.icon
                return (
                  <div key={item.label} className={`dual-stat-card ${isLong ? 'long' : ''}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <div className="stat-icon" style={{
                      width: '40px',
                      height: '40px',
                      borderRadius: '12px',
                      background: `${item.color}15`,
                      color: item.color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: '4px'
                    }}>
                      <Icon size={20} />
                    </div>
                    <div className="stat-num">{valueText}</div>
                    <div className="stat-unit">{item.label}</div>
                  </div>
                )
              })}
            </div>

            <div className="emoji-row">
              <div className="emoji-card">
                <div className="emoji-title">我常用的表情</div>
                {myEmojiUrl ? (
                  <img src={myEmojiUrl} alt="my-emoji" />
                ) : (
                  <div className="emoji-placeholder">{stats.myTopEmojiMd5 || '暂无'}</div>
                )}
                <div className="emoji-count">{stats.myTopEmojiCount ? `${stats.myTopEmojiCount}\u6b21` : '\u6682\u65e0\u7edf\u8ba1'}</div>
              </div>
              <div className="emoji-card">
                <div className="emoji-title">{reportData.friendName}常用的表情</div>
                {friendEmojiUrl ? (
                  <img src={friendEmojiUrl} alt="friend-emoji" />
                ) : (
                  <div className="emoji-placeholder">{stats.friendTopEmojiMd5 || '暂无'}</div>
                )}
                <div className="emoji-count">{stats.friendTopEmojiCount ? `${stats.friendTopEmojiCount}\u6b21` : '\u6682\u65e0\u7edf\u8ba1'}</div>
              </div>
            </div>
          </section>

          <section className="section">
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
