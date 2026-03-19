import { useEffect, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { ChatRecordItem } from '../types/models'
import TitleBar from '../components/TitleBar'
import { ErrorBoundary } from '../components/ErrorBoundary'
import './ChatHistoryPage.scss'

export default function ChatHistoryPage() {
  const params = useParams<{ sessionId: string; messageId: string }>()
  const location = useLocation()
  const [recordList, setRecordList] = useState<ChatRecordItem[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('聊天记录')
  const [error, setError] = useState('')

  // 简单的 XML 标签内容提取
  const extractXmlValue = (xml: string, tag: string): string => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
    return match ? match[1] : ''
  }

  // 简单的 HTML 实体解码
  const decodeHtmlEntities = (text?: string): string | undefined => {
    if (!text) return text
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  }

  // 前端兜底解析合并转发聊天记录
  const parseChatHistory = (content: string): ChatRecordItem[] | undefined => {
    try {
      const type = extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      const parseRecordItemBody = (body: string, datatype = 0): ChatRecordItem => ({
        datatype,
        sourcename: extractXmlValue(body, 'sourcename'),
        sourcetime: extractXmlValue(body, 'sourcetime'),
        sourceheadurl: extractXmlValue(body, 'sourceheadurl'),
        datadesc: decodeHtmlEntities(extractXmlValue(body, 'datadesc')),
        datatitle: decodeHtmlEntities(extractXmlValue(body, 'datatitle')),
        fileext: extractXmlValue(body, 'fileext'),
        datasize: parseInt(extractXmlValue(body, 'datasize') || '0'),
        messageuuid: extractXmlValue(body, 'messageuuid'),
        dataurl: decodeHtmlEntities(extractXmlValue(body, 'dataurl')),
        datathumburl: decodeHtmlEntities(extractXmlValue(body, 'datathumburl') || extractXmlValue(body, 'thumburl')),
        datacdnurl: decodeHtmlEntities(extractXmlValue(body, 'datacdnurl') || extractXmlValue(body, 'cdnurl')),
        aeskey: decodeHtmlEntities(extractXmlValue(body, 'aeskey') || extractXmlValue(body, 'qaeskey')),
        md5: extractXmlValue(body, 'md5') || extractXmlValue(body, 'datamd5'),
        imgheight: parseInt(extractXmlValue(body, 'imgheight') || '0'),
        imgwidth: parseInt(extractXmlValue(body, 'imgwidth') || '0'),
        duration: parseInt(extractXmlValue(body, 'duration') || '0')
      })

      const cdataMatch = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
      if (cdataMatch) {
        const items: ChatRecordItem[] = []
        const itemRegex = /<dataitem\b([^>]*)>([\s\S]*?)<\/dataitem>/gi
        let itemMatch: RegExpExecArray | null

        while ((itemMatch = itemRegex.exec(cdataMatch[1])) !== null) {
          const datatypeMatch = /datatype="(\d+)"/i.exec(itemMatch[1])
          const datatype = datatypeMatch ? parseInt(datatypeMatch[1], 10) : 0
          items.push(parseRecordItemBody(itemMatch[2], datatype))
        }

        if (items.length > 0) {
          return items
        }
      }

      const legacyItems: ChatRecordItem[] = []
      const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
      let match: RegExpExecArray | null

      while ((match = recordItemRegex.exec(content)) !== null) {
        const datatype = parseInt(extractXmlValue(match[1], 'datatype') || '0')
        legacyItems.push(parseRecordItemBody(match[1], datatype))
      }

      return legacyItems.length > 0 ? legacyItems : undefined
    } catch (e) {
      console.error('前端解析聊天记录失败:', e)
      return undefined
    }
  }

  // 统一从路由参数或 pathname 中解析 sessionId / messageId
  const getIds = () => {
    const sessionId = params.sessionId || ''
    const messageId = params.messageId || ''
    
    if (sessionId && messageId) {
      return { sid: sessionId, mid: messageId }
    }
    
    // 独立窗口场景下没有 Route 包裹，用 pathname 手动解析
    const match = /^\/chat-history\/([^/]+)\/([^/]+)/.exec(location.pathname)
    if (match) {
      return { sid: match[1], mid: match[2] }
    }
    
    return { sid: '', mid: '' }
  }

  useEffect(() => {
    const loadData = async () => {
      const { sid, mid } = getIds()
      if (!sid || !mid) {
        setError('无效的聊天记录链接')
        setLoading(false)
        return
      }
      try {
        const result = await window.electronAPI.chat.getMessage(sid, parseInt(mid, 10))
        if (result.success && result.message) {
          const msg = result.message
          // 优先使用后端解析好的列表
          let records: ChatRecordItem[] | undefined = msg.chatRecordList

          // 如果后端没有解析到，则在前端兜底解析一次
          const fallbackRecords = msg.content ? (parseChatHistory(msg.content) || []) : []

          if ((!records || records.length === 0) && fallbackRecords.length > 0) {
            records = fallbackRecords
          }

          if (records && records.length > 0) {
            setRecordList(records)
            const match = /<title>(.*?)<\/title>/.exec(msg.content || '')
            if (match) setTitle(match[1])
          } else {
            setError('暂时无法解析这条聊天记录')
          }
        } else {
          setError(result.error || '获取消息失败')
        }
      } catch (e) {
        console.error(e)
        setError('加载详情失败')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [params.sessionId, params.messageId, location.pathname])

  return (
    <div className="chat-history-page">
      <TitleBar title={title} />
      <div className="history-list">
        {loading ? (
          <div className="status-msg">加载中...</div>
        ) : error ? (
          <div className="status-msg error">{error}</div>
        ) : recordList.length === 0 ? (
          <div className="status-msg empty">暂无可显示的聊天记录</div>
        ) : (
          recordList.map((item, i) => (
            <ErrorBoundary key={i} fallback={<div className="history-item error-item">消息解析失败</div>}>
              <HistoryItem item={item} />
            </ErrorBoundary>
          ))
        )}
      </div>
    </div>
  )
}

function HistoryItem({ item }: { item: ChatRecordItem }) {
  const [imageError, setImageError] = useState(false)
  
  // sourcetime 在合并转发里有两种格式：
  // 1) 时间戳（秒） 2) 已格式化的字符串 "2026-01-21 09:56:46"
  let time = ''
  if (item.sourcetime) {
    if (/^\d+$/.test(item.sourcetime)) {
      time = new Date(parseInt(item.sourcetime, 10) * 1000).toLocaleString()
    } else {
      time = item.sourcetime
    }
  }

  const renderContent = () => {
    if (item.datatype === 1) {
      // 文本消息
      return <div className="text-content">{item.datadesc || ''}</div>
    }
    if (item.datatype === 3) {
      // 图片
      const src = item.datathumburl || item.datacdnurl
      if (src) {
        return (
          <div className="media-content">
            {imageError ? (
              <div className="media-tip">图片无法加载</div>
            ) : (
              <img 
                src={src} 
                alt="图片" 
                referrerPolicy="no-referrer" 
                onError={() => setImageError(true)} 
              />
            )}
          </div>
        )
      }
      return <div className="media-placeholder">[图片]</div>
    }
    if (item.datatype === 43) {
      return <div className="media-placeholder">[视频] {item.datatitle}</div>
    }
    if (item.datatype === 34) {
      return <div className="media-placeholder">[语音] {item.duration ? (item.duration / 1000).toFixed(0) + '"' : ''}</div>
    }
    // Fallback
    return <div className="text-content">{item.datadesc || item.datatitle || '[不支持的消息类型]'}</div>
  }

  return (
    <div className="history-item">
      <div className="avatar">
        {item.sourceheadurl ? (
          <img src={item.sourceheadurl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="avatar-placeholder">
            {item.sourcename?.slice(0, 1)}
          </div>
        )}
      </div>
      <div className="content-wrapper">
        <div className="header">
          <span className="sender">{item.sourcename || '未知发送者'}</span>
          <span className="time">{time}</span>
        </div>
        <div className={`bubble ${item.datatype === 3 ? 'image-bubble' : ''}`}>
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
