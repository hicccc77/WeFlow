import { useEffect, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { ChatRecordItem } from '../types/models'
import TitleBar from '../components/TitleBar'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Avatar } from '../components/Avatar'
import './ChatHistoryPage.scss'

const forwardedImageCache = new Map<string, string>()

export default function ChatHistoryPage() {
  const params = useParams<{ sessionId: string; messageId: string; payloadId: string }>()
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

  const extractTopLevelXmlElements = (source: string, tagName: string): Array<{ attrs: string; inner: string }> => {
    const xml = source || ''
    if (!xml) return []

    const pattern = new RegExp(`<(/?)${tagName}\\b([^>]*)>`, 'gi')
    const result: Array<{ attrs: string; inner: string }> = []
    let match: RegExpExecArray | null
    let depth = 0
    let openEnd = -1
    let openStart = -1
    let openAttrs = ''

    while ((match = pattern.exec(xml)) !== null) {
      const isClosing = match[1] === '/'
      const attrs = match[2] || ''
      const rawTag = match[0] || ''
      const selfClosing = !isClosing && /\/\s*>$/.test(rawTag)

      if (!isClosing) {
        if (depth === 0) {
          openStart = match.index
          openEnd = pattern.lastIndex
          openAttrs = attrs
        }
        if (!selfClosing) {
          depth += 1
        } else if (depth === 0 && openEnd >= 0) {
          result.push({ attrs: openAttrs, inner: '' })
          openStart = -1
          openEnd = -1
          openAttrs = ''
        }
        continue
      }

      if (depth <= 0) continue
      depth -= 1
      if (depth === 0 && openEnd >= 0 && openStart >= 0) {
        result.push({
          attrs: openAttrs,
          inner: xml.slice(openEnd, match.index)
        })
        openStart = -1
        openEnd = -1
        openAttrs = ''
      }
    }

    return result
  }

  const parseChatRecordDataItem = (body: string, attrs = ''): ChatRecordItem | null => {
    const datatypeMatch = /datatype\s*=\s*["']?(\d+)["']?/i.exec(attrs || '')
    const datatype = datatypeMatch ? parseInt(datatypeMatch[1], 10) : parseInt(extractXmlValue(body, 'datatype') || '0', 10)

    const sourcename = decodeHtmlEntities(extractXmlValue(body, 'sourcename')) || ''
    const sourcetime = extractXmlValue(body, 'sourcetime') || ''
    const sourceheadurl = extractXmlValue(body, 'sourceheadurl') || undefined
    const datadesc = decodeHtmlEntities(extractXmlValue(body, 'datadesc') || extractXmlValue(body, 'content')) || undefined
    const datatitle = decodeHtmlEntities(extractXmlValue(body, 'datatitle')) || undefined
    const fileext = extractXmlValue(body, 'fileext') || undefined
    const datasize = parseInt(extractXmlValue(body, 'datasize') || '0', 10) || undefined
    const messageuuid = extractXmlValue(body, 'messageuuid') || undefined

    const dataurl = decodeHtmlEntities(extractXmlValue(body, 'dataurl')) || undefined
    const datathumburl = decodeHtmlEntities(
      extractXmlValue(body, 'datathumburl') ||
      extractXmlValue(body, 'thumburl') ||
      extractXmlValue(body, 'cdnthumburl')
    ) || undefined
    const datacdnurl = decodeHtmlEntities(
      extractXmlValue(body, 'datacdnurl') ||
      extractXmlValue(body, 'cdnurl') ||
      extractXmlValue(body, 'cdndataurl')
    ) || undefined
    const cdndatakey = decodeHtmlEntities(extractXmlValue(body, 'cdndatakey')) || undefined
    const cdnthumbkey = decodeHtmlEntities(extractXmlValue(body, 'cdnthumbkey')) || undefined
    const aeskey = decodeHtmlEntities(extractXmlValue(body, 'aeskey') || extractXmlValue(body, 'qaeskey')) || undefined
    const md5 = extractXmlValue(body, 'md5') || extractXmlValue(body, 'datamd5') || undefined
    const fullmd5 = extractXmlValue(body, 'fullmd5') || undefined
    const thumbfullmd5 = extractXmlValue(body, 'thumbfullmd5') || undefined
    const srcMsgLocalid = parseInt(extractXmlValue(body, 'srcMsgLocalid') || '0', 10) || undefined
    const imgheight = parseInt(extractXmlValue(body, 'imgheight') || '0', 10) || undefined
    const imgwidth = parseInt(extractXmlValue(body, 'imgwidth') || '0', 10) || undefined
    const duration = parseInt(extractXmlValue(body, 'duration') || '0', 10) || undefined
    const nestedRecordXml = extractXmlValue(body, 'recordxml') || undefined
    const chatRecordTitle = decodeHtmlEntities(
      (nestedRecordXml && extractXmlValue(nestedRecordXml, 'title')) ||
      datatitle ||
      ''
    ) || undefined
    const chatRecordDesc = decodeHtmlEntities(
      (nestedRecordXml && extractXmlValue(nestedRecordXml, 'desc')) ||
      datadesc ||
      ''
    ) || undefined
    const chatRecordList =
      datatype === 17 && nestedRecordXml
        ? parseChatRecordContainer(nestedRecordXml)
        : undefined

    if (!(datatype || sourcename || datadesc || datatitle || messageuuid || srcMsgLocalid)) return null

    return {
      datatype: Number.isFinite(datatype) ? datatype : 0,
      sourcename,
      sourcetime,
      sourceheadurl,
      datadesc,
      datatitle,
      fileext,
      datasize,
      messageuuid,
      dataurl,
      datathumburl,
      datacdnurl,
      cdndatakey,
      cdnthumbkey,
      aeskey,
      md5,
      fullmd5,
      thumbfullmd5,
      srcMsgLocalid,
      imgheight,
      imgwidth,
      duration,
      chatRecordTitle,
      chatRecordDesc,
      chatRecordList
    }
  }

  const parseChatRecordContainer = (containerXml: string): ChatRecordItem[] => {
    const source = containerXml || ''
    if (!source) return []

    const segments: string[] = [source]
    const decodedContainer = decodeHtmlEntities(source)
    if (decodedContainer && decodedContainer !== source) {
      segments.push(decodedContainer)
    }

    const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g
    let cdataMatch: RegExpExecArray | null
    while ((cdataMatch = cdataRegex.exec(source)) !== null) {
      const cdataInner = cdataMatch[1] || ''
      if (!cdataInner) continue
      segments.push(cdataInner)
      const decodedInner = decodeHtmlEntities(cdataInner)
      if (decodedInner && decodedInner !== cdataInner) {
        segments.push(decodedInner)
      }
    }

    const items: ChatRecordItem[] = []
    const dedupe = new Set<string>()
    for (const segment of segments) {
      if (!segment) continue
      const dataItems = extractTopLevelXmlElements(segment, 'dataitem')
      for (const dataItem of dataItems) {
        const item = parseChatRecordDataItem(dataItem.inner || '', dataItem.attrs || '')
        if (!item) continue
        const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
        if (!dedupe.has(key)) {
          dedupe.add(key)
          items.push(item)
        }
      }
    }

    if (items.length > 0) return items
    const fallback = parseChatRecordDataItem(source, '')
    return fallback ? [fallback] : []
  }

  // 前端兜底解析合并转发聊天记录
  const parseChatHistory = (content: string): ChatRecordItem[] | undefined => {
    try {
      const decodedContent = decodeHtmlEntities(content) || content
      const type = extractXmlValue(decodedContent, 'type')
      if (type !== '19' && !decodedContent.includes('<recorditem')) return undefined

      const items: ChatRecordItem[] = []
      const dedupe = new Set<string>()
      const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
      let recordItemMatch: RegExpExecArray | null
      while ((recordItemMatch = recordItemRegex.exec(decodedContent)) !== null) {
        const parsedItems = parseChatRecordContainer(recordItemMatch[1] || '')
        for (const item of parsedItems) {
          const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
          if (!dedupe.has(key)) {
            dedupe.add(key)
            items.push(item)
          }
        }
      }

      if (items.length === 0 && decodedContent.includes('<dataitem')) {
        const parsedItems = parseChatRecordContainer(decodedContent)
        for (const item of parsedItems) {
          const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
          if (!dedupe.has(key)) {
            dedupe.add(key)
            items.push(item)
          }
        }
      }

      return items.length > 0 ? items : undefined
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

  const ids = getIds()
  const payloadId = params.payloadId || (() => {
    const match = /^\/chat-history-inline\/([^/]+)/.exec(location.pathname)
    return match ? match[1] : ''
  })()

  useEffect(() => {
    const loadData = async () => {
      if (payloadId) {
        try {
          const result = await window.electronAPI.window.getChatHistoryPayload(payloadId)
          if (result.success && result.payload) {
            setRecordList(Array.isArray(result.payload.recordList) ? result.payload.recordList : [])
            setTitle(result.payload.title || '聊天记录')
            setError('')
          } else {
            setError(result.error || '聊天记录载荷不存在')
          }
        } catch (e) {
          console.error(e)
          setError('加载详情失败')
        } finally {
          setLoading(false)
        }
        return
      }

      const { sid, mid } = ids
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
          if ((!records || records.length === 0) && msg.content) {
            records = parseChatHistory(msg.content) || []
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
  }, [ids.mid, ids.sid, location.pathname, payloadId])

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
              <HistoryItem item={item} sessionId={ids.sid} />
            </ErrorBoundary>
          ))
        )}
      </div>
    </div>
  )
}

function detectImageMimeFromBase64(base64: string): string {
  try {
    const head = window.atob(base64.slice(0, 48))
    const bytes = new Uint8Array(head.length)
    for (let i = 0; i < head.length; i++) {
      bytes[i] = head.charCodeAt(i)
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
  } catch { }
  return 'image/jpeg'
}

function normalizeChatRecordText(value?: string): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getChatRecordPreviewText(item: ChatRecordItem): string {
  const text = normalizeChatRecordText(item.datadesc) || normalizeChatRecordText(item.datatitle)
  if (item.datatype === 17) {
    return normalizeChatRecordText(item.chatRecordTitle) || normalizeChatRecordText(item.datatitle) || '聊天记录'
  }
  if (item.datatype === 2 || item.datatype === 3) return '[图片]'
  if (item.datatype === 43) return '[视频]'
  if (item.datatype === 34) return '[语音]'
  if (item.datatype === 47) return '[表情]'
  return text || '[媒体消息]'
}

function ForwardedImage({ item, sessionId }: { item: ChatRecordItem; sessionId: string }) {
  const cacheKey =
    item.thumbfullmd5 ||
    item.fullmd5 ||
    item.md5 ||
    item.messageuuid ||
    item.datathumburl ||
    item.datacdnurl ||
    item.dataurl ||
    `local:${item.srcMsgLocalid || 0}`
  const [localPath, setLocalPath] = useState<string | undefined>(() => forwardedImageCache.get(cacheKey))
  const [loading, setLoading] = useState(!forwardedImageCache.has(cacheKey))
  const [error, setError] = useState(false)

  useEffect(() => {
    if (localPath || error) return

    let cancelled = false
    const candidateMd5s = Array.from(new Set([
      item.thumbfullmd5,
      item.fullmd5,
      item.md5
    ].filter(Boolean) as string[]))

    const load = async () => {
      setLoading(true)

      for (const imageMd5 of candidateMd5s) {
        const cached = await window.electronAPI.image.resolveCache({ imageMd5 })
        if (cached.success && cached.localPath) {
          if (!cancelled) {
            forwardedImageCache.set(cacheKey, cached.localPath)
            setLocalPath(cached.localPath)
            setLoading(false)
          }
          return
        }
      }

      for (const imageMd5 of candidateMd5s) {
        const decrypted = await window.electronAPI.image.decrypt({ imageMd5 })
        if (decrypted.success && decrypted.localPath) {
          if (!cancelled) {
            forwardedImageCache.set(cacheKey, decrypted.localPath)
            setLocalPath(decrypted.localPath)
            setLoading(false)
          }
          return
        }
      }

      if (sessionId && item.srcMsgLocalid) {
        const fallback = await window.electronAPI.chat.getImageData(sessionId, String(item.srcMsgLocalid))
        if (fallback.success && fallback.data) {
          const dataUrl = `data:${detectImageMimeFromBase64(fallback.data)};base64,${fallback.data}`
          if (!cancelled) {
            forwardedImageCache.set(cacheKey, dataUrl)
            setLocalPath(dataUrl)
            setLoading(false)
          }
          return
        }
      }

      const remoteSrc = item.dataurl || item.datathumburl || item.datacdnurl
      if (remoteSrc && /^https?:\/\//i.test(remoteSrc)) {
        if (!cancelled) {
          setLocalPath(remoteSrc)
          setLoading(false)
        }
        return
      }

      if (!cancelled) {
        setError(true)
        setLoading(false)
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setError(true)
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [cacheKey, error, item.dataurl, item.datacdnurl, item.datathumburl, item.fullmd5, item.md5, item.messageuuid, item.srcMsgLocalid, item.thumbfullmd5, localPath, sessionId])

  if (localPath) {
    return (
      <div className="media-content">
        <img src={localPath} alt="图片" referrerPolicy="no-referrer" />
      </div>
    )
  }

  if (loading) {
    return <div className="media-tip">图片加载中...</div>
  }

  if (error) {
    return <div className="media-tip">图片未索引到本地缓存</div>
  }

  return <div className="media-placeholder">[图片]</div>
}

function NestedChatRecordCard({ item, sessionId }: { item: ChatRecordItem; sessionId: string }) {
  const previewItems = (item.chatRecordList || []).slice(0, 3)
  const title = normalizeChatRecordText(item.chatRecordTitle) || normalizeChatRecordText(item.datatitle) || '聊天记录'
  const description = normalizeChatRecordText(item.chatRecordDesc) || normalizeChatRecordText(item.datadesc)
  const canOpen = Boolean(sessionId && item.chatRecordList && item.chatRecordList.length > 0)

  const handleOpen = () => {
    if (!canOpen) return
    window.electronAPI.window.openChatHistoryPayloadWindow({
      sessionId,
      title,
      recordList: item.chatRecordList || []
    }).catch(() => { })
  }

  return (
    <button
      type="button"
      className={`nested-chat-record-card${canOpen ? ' clickable' : ''}`}
      onClick={handleOpen}
      disabled={!canOpen}
      title={canOpen ? '点击打开聊天记录' : undefined}
    >
      <div className="nested-chat-record-title">{title}</div>
      {previewItems.length > 0 ? (
        <div className="nested-chat-record-list">
          {previewItems.map((previewItem, index) => (
            <div key={`${previewItem.messageuuid || previewItem.srcMsgLocalid || index}`} className="nested-chat-record-line">
              {getChatRecordPreviewText(previewItem)}
            </div>
          ))}
        </div>
      ) : description ? (
        <div className="nested-chat-record-list">
          <div className="nested-chat-record-line">{description}</div>
        </div>
      ) : null}
      <div className="nested-chat-record-footer">聊天记录</div>
    </button>
  )
}

function HistoryItem({ item, sessionId }: { item: ChatRecordItem; sessionId: string }) {
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

  const senderDisplayName = item.sourcename ?? '未知发送者'

  const renderContent = () => {
    if (item.datatype === 1) {
      // 文本消息
      return <div className="text-content">{item.datadesc || ''}</div>
    }
    if (item.datatype === 2 || item.datatype === 3) {
      return <ForwardedImage item={item} sessionId={sessionId} />
    }
    if (item.datatype === 17) {
      return <NestedChatRecordCard item={item} sessionId={sessionId} />
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
      <div className="history-avatar">
        <Avatar
          src={item.sourceheadurl}
          name={senderDisplayName}
          size={36}
          className="avatar-inner"
        />
      </div>
      <div className="content-wrapper">
        <div className="header">
          <span className="sender">{senderDisplayName}</span>
          <span className="time">{time}</span>
        </div>
        <div className={`bubble ${(item.datatype === 2 || item.datatype === 3) ? 'image-bubble' : ''}`}>
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
