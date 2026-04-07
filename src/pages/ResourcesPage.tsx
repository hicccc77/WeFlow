import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { Calendar, Image as ImageIcon, Loader2, PlayCircle, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { VirtuosoGrid } from 'react-virtuoso'
import { finishBackgroundTask, registerBackgroundTask, updateBackgroundTask } from '../services/backgroundTaskMonitor'
import './ResourcesPage.scss'

type MediaTab = 'image' | 'video'

interface MediaStreamItem {
  sessionId: string
  sessionDisplayName?: string
  mediaType: 'image' | 'video'
  localId: number
  serverId?: string
  createTime: number
  localType: number
  senderUsername?: string
  isSend?: number | null
  imageMd5?: string
  imageDatName?: string
  videoMd5?: string
  content?: string
}

interface ContactOption {
  id: string
  name: string
}

type DialogState = {
  mode: 'alert' | 'confirm'
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm?: (() => void) | null
}

const PAGE_SIZE = 96
const MAX_IMAGE_CACHE_RESOLVE_PER_TICK = 12
const MAX_IMAGE_CACHE_PRELOAD_PER_TICK = 24
const MAX_VIDEO_POSTER_RESOLVE_PER_TICK = 3
const INITIAL_IMAGE_PRELOAD_END = 48
const INITIAL_IMAGE_RESOLVE_END = 12
const TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS = 250
const TASK_PROGRESS_UPDATE_MAX_STEPS = 100

const GridList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function GridList(props, ref) {
  const { className = '', ...rest } = props
  const mergedClassName = ['stream-grid-list', className].filter(Boolean).join(' ')
  return <div ref={ref} className={mergedClassName} {...rest} />
})

function GridItem(props: HTMLAttributes<HTMLDivElement>) {
  const { className = '', ...rest } = props
  const mergedClassName = ['stream-grid-item', className].filter(Boolean).join(' ')
  return <div className={mergedClassName} {...rest} />
}

function getRangeTimestampStart(date: string): number | undefined {
  if (!date) return undefined
  const parsed = new Date(`${date}T00:00:00`)
  const n = Math.floor(parsed.getTime() / 1000)
  return Number.isFinite(n) ? n : undefined
}

function getRangeTimestampEnd(date: string): number | undefined {
  if (!date) return undefined
  const parsed = new Date(`${date}T23:59:59`)
  const n = Math.floor(parsed.getTime() / 1000)
  return Number.isFinite(n) ? n : undefined
}

function getItemKey(item: MediaStreamItem): string {
  const sessionId = String(item.sessionId || '').trim().toLowerCase()
  const localId = Number(item.localId || 0)
  if (sessionId && Number.isFinite(localId) && localId > 0) {
    return `${sessionId}|${localId}`
  }

  const serverId = String(item.serverId || '').trim().toLowerCase()
  const createTime = Number(item.createTime || 0)
  const localType = Number(item.localType || 0)
  const mediaId = String(
    item.mediaType === 'video'
      ? (item.videoMd5 || '')
      : (item.imageMd5 || item.imageDatName || '')
  ).trim().toLowerCase()
  return `${sessionId}|${createTime}|${localType}|${serverId}|${mediaId}`
}

function formatTimeLabel(timestampSec: number): string {
  if (!timestampSec) return '--:--'
  return new Date(timestampSec * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function extractVideoTitle(content?: string): string {
  const xml = String(content || '')
  if (!xml) return '视频'
  const match = /<title>([\s\S]*?)<\/title>/i.exec(xml)
  const text = String(match?.[1] || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  return text || '视频'
}

function toRenderableMediaSrc(rawPath?: string): string {
  const src = String(rawPath || '').trim()
  if (!src) return ''
  if (/^(data:image\/|blob:|https?:\/\/)/i.test(src)) {
    return src
  }
  if (/^file:\/\//i.test(src)) {
    return src.replace(/#/g, '%23')
  }
  if (src.startsWith('/')) {
    return encodeURI(`file://${src}`).replace(/#/g, '%23')
  }
  if (/^[a-zA-Z]:[\\/]/.test(src)) {
    return encodeURI(`file:///${src.replace(/\\/g, '/')}`).replace(/#/g, '%23')
  }
  return encodeURI(`file://${src.startsWith('/') ? '' : '/'}${src.replace(/\\/g, '/')}`).replace(/#/g, '%23')
}

const MediaCard = memo(function MediaCard({
  item,
  sessionName,
  previewPath,
  videoPosterPath,
  imageIsLong,
  hasPreviewUpdate,
  selected,
  decrypting,
  onToggleSelect,
  onDelete,
  onImagePreviewAction,
  onUpdateImageQuality,
  onOpenVideo,
  onImageLoaded
}: {
  item: MediaStreamItem
  sessionName: string
  previewPath: string
  videoPosterPath: string
  imageIsLong: boolean
  hasPreviewUpdate: boolean
  selected: boolean
  decrypting: boolean
  onToggleSelect: (item: MediaStreamItem) => void
  onDelete: (item: MediaStreamItem) => void
  onImagePreviewAction: (item: MediaStreamItem) => void
  onUpdateImageQuality: (item: MediaStreamItem) => void
  onOpenVideo: (item: MediaStreamItem) => void
  onImageLoaded: (item: MediaStreamItem, width: number, height: number) => void
}) {
  const isImage = item.mediaType === 'image'
  const isDecryptingVisual = decrypting
  const showDecryptOverlay = isImage && isDecryptingVisual

  return (
    <article className={`media-card ${selected ? 'selected' : ''} ${isDecryptingVisual ? 'decrypting' : ''}`}>
      <button type="button" className="floating-delete" onClick={() => onDelete(item)} aria-label="删除资源">
        <Trash2 size={14} />
      </button>

      {isImage && hasPreviewUpdate && (
        <button
          type="button"
          className="floating-update"
          disabled={decrypting}
          onClick={() => onUpdateImageQuality(item)}
          title="已扫描到高清图，点击更新画质"
          aria-label="更新画质"
        >
          <RefreshCw size={13} />
          更新
        </button>
      )}

      <button
        type="button"
        className={`card-visual ${isImage ? 'image' : 'video'}`}
        disabled={isImage && isDecryptingVisual}
        onClick={() => {
          if (isImage) {
            onImagePreviewAction(item)
            return
          }
          onOpenVideo(item)
        }}
      >
        {isImage ? (
          previewPath
            ? <img
              src={toRenderableMediaSrc(previewPath)}
              alt="图片资源"
              className={imageIsLong ? 'long-image' : ''}
              loading="lazy"
              decoding="async"
              onLoad={(event) => {
                const width = event.currentTarget.naturalWidth || 0
                const height = event.currentTarget.naturalHeight || 0
                onImageLoaded(item, width, height)
              }}
            />
            : <div className="placeholder"><ImageIcon size={30} /></div>
        ) : (
          videoPosterPath
            ? <img src={toRenderableMediaSrc(videoPosterPath)} alt="视频封面" loading="lazy" decoding="async" />
            : <div className="placeholder">
              <PlayCircle size={34} />
              <span>{extractVideoTitle(item.content)}</span>
            </div>
        )}
        {showDecryptOverlay && (
          <div className="decrypting-overlay" aria-hidden="true">
            <div className="decrypting-spinner" />
          </div>
        )}
      </button>

      <div className="card-meta" onClick={() => onToggleSelect(item)}>
        <div className="title-row">
          <span className="session" title={sessionName}>{sessionName}</span>
          <span className="time">{formatTimeLabel(item.createTime)}</span>
        </div>
        <div className="sub-row">
          <span>{item.mediaType === 'image' ? '图片' : '视频'}</span>
          {item.senderUsername && <span>{item.senderUsername}</span>}
        </div>
      </div>
    </article>
  )
})

function ResourcesPage() {
  const [tab, setTab] = useState<MediaTab>('image')
  const [contacts, setContacts] = useState<ContactOption[]>([{ id: 'all', name: '全部联系人' }])
  const [selectedContact, setSelectedContact] = useState('all')
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')

  const [items, setItems] = useState<MediaStreamItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [decryptingKeys, setDecryptingKeys] = useState<Set<string>>(new Set())
  const [actionMessage, setActionMessage] = useState('')
  const [sessionNameMap, setSessionNameMap] = useState<Record<string, string>>({})
  const [previewPathMap, setPreviewPathMap] = useState<Record<string, string>>({})
  const [previewUpdateMap, setPreviewUpdateMap] = useState<Record<string, boolean>>({})
  const [videoPosterMap, setVideoPosterMap] = useState<Record<string, string>>({})
  const [imageAspectMap, setImageAspectMap] = useState<Record<string, number>>({})
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const previewPathMapRef = useRef<Record<string, string>>({})
  const previewUpdateMapRef = useRef<Record<string, boolean>>({})
  const videoPosterMapRef = useRef<Record<string, string>>({})
  const imageAspectMapRef = useRef<Record<string, number>>({})
  const resolvingImageCacheBatchRef = useRef(false)
  const pendingImageResolveRangeRef = useRef<{ start: number; end: number } | null>(null)
  const imagePreloadUntilRef = useRef<Record<string, number>>({})
  const imageCacheMissUntilRef = useRef<Record<string, number>>({})
  const resolvingVideoPosterKeysRef = useRef<Set<string>>(new Set())
  const attemptedVideoPosterKeysRef = useRef<Set<string>>(new Set())
  const resolvedVideoMd5Ref = useRef<Record<string, string>>({})
  const previewPatchRef = useRef<Record<string, string>>({})
  const updatePatchRef = useRef<Record<string, boolean>>({})
  const previewPatchTimerRef = useRef<number | null>(null)
  const posterPatchRef = useRef<Record<string, string>>({})
  const posterPatchTimerRef = useRef<number | null>(null)
  const aspectPatchRef = useRef<Record<string, number>>({})
  const aspectPatchTimerRef = useRef<number | null>(null)
  const pendingRangeRef = useRef<{ start: number; end: number } | null>(null)
  const rangeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    previewPathMapRef.current = previewPathMap
  }, [previewPathMap])

  useEffect(() => {
    previewUpdateMapRef.current = previewUpdateMap
  }, [previewUpdateMap])

  useEffect(() => {
    videoPosterMapRef.current = videoPosterMap
  }, [videoPosterMap])

  useEffect(() => {
    imageAspectMapRef.current = imageAspectMap
  }, [imageAspectMap])

  useEffect(() => () => {
    if (previewPatchTimerRef.current !== null) {
      window.clearTimeout(previewPatchTimerRef.current)
      previewPatchTimerRef.current = null
    }
    if (posterPatchTimerRef.current !== null) {
      window.clearTimeout(posterPatchTimerRef.current)
      posterPatchTimerRef.current = null
    }
    if (aspectPatchTimerRef.current !== null) {
      window.clearTimeout(aspectPatchTimerRef.current)
      aspectPatchTimerRef.current = null
    }
    if (rangeTimerRef.current !== null) {
      window.clearTimeout(rangeTimerRef.current)
      rangeTimerRef.current = null
    }
  }, [])

  const showAlert = useCallback((message: string, title: string = '提示') => {
    setDialog({
      mode: 'alert',
      title,
      message,
      confirmText: '确定',
      onConfirm: null
    })
  }, [])

  const showConfirm = useCallback((message: string, onConfirm: () => void, title: string = '确认操作') => {
    setDialog({
      mode: 'confirm',
      title,
      message,
      confirmText: '确定',
      cancelText: '取消',
      onConfirm
    })
  }, [])

  const closeDialog = useCallback(() => {
    setDialog(null)
  }, [])

  const isLikelyThumbnailPreview = useCallback((path: string): boolean => {
    const lower = String(path || '').toLowerCase()
    if (!lower) return false
    return lower.includes('_thumb') || lower.includes('_t.') || lower.includes('.t.')
  }, [])

  const flushPreviewPatch = useCallback(() => {
    const pathPatch = previewPatchRef.current
    const updatePatch = updatePatchRef.current
    previewPatchRef.current = {}
    updatePatchRef.current = {}
    previewPatchTimerRef.current = null
    const hasPathPatch = Object.keys(pathPatch).length > 0
    const hasUpdatePatch = Object.keys(updatePatch).length > 0
    if (hasPathPatch) {
      setPreviewPathMap((prev) => ({ ...prev, ...pathPatch }))
    }
    if (hasUpdatePatch) {
      setPreviewUpdateMap((prev) => ({ ...prev, ...updatePatch }))
    }
  }, [])

  const queuePreviewPatch = useCallback((itemKey: string, localPath: string, hasUpdate: boolean) => {
    if (!itemKey || !localPath) return
    if (previewPathMapRef.current[itemKey] === localPath && previewUpdateMapRef.current[itemKey] === hasUpdate) return
    previewPatchRef.current[itemKey] = localPath
    updatePatchRef.current[itemKey] = hasUpdate
    if (previewPatchTimerRef.current !== null) return
    previewPatchTimerRef.current = window.setTimeout(flushPreviewPatch, 16)
  }, [flushPreviewPatch])

  const flushPosterPatch = useCallback(() => {
    const patch = posterPatchRef.current
    posterPatchRef.current = {}
    posterPatchTimerRef.current = null
    if (Object.keys(patch).length === 0) return
    setVideoPosterMap((prev) => ({ ...prev, ...patch }))
  }, [])

  const queuePosterPatch = useCallback((itemKey: string, posterPath: string) => {
    if (!itemKey || !posterPath) return
    if (videoPosterMapRef.current[itemKey] === posterPath) return
    posterPatchRef.current[itemKey] = posterPath
    if (posterPatchTimerRef.current !== null) return
    posterPatchTimerRef.current = window.setTimeout(flushPosterPatch, 16)
  }, [flushPosterPatch])

  const flushAspectPatch = useCallback(() => {
    const patch = aspectPatchRef.current
    aspectPatchRef.current = {}
    aspectPatchTimerRef.current = null
    if (Object.keys(patch).length === 0) return
    setImageAspectMap((prev) => ({ ...prev, ...patch }))
  }, [])

  const queueAspectPatch = useCallback((itemKey: string, ratio: number) => {
    const old = imageAspectMapRef.current[itemKey]
    if (typeof old === 'number' && Math.abs(old - ratio) < 0.01) return
    aspectPatchRef.current[itemKey] = ratio
    if (aspectPatchTimerRef.current !== null) return
    aspectPatchTimerRef.current = window.setTimeout(flushAspectPatch, 24)
  }, [flushAspectPatch])

  const loadStream = useCallback(async (reset: boolean) => {
    if (reset) setLoading(true)
    else setLoadingMore(true)
    if (reset) {
      setError('')
      setActionMessage('')
    }

    try {
      if (reset) {
        const connectResult = await window.electronAPI.chat.connect()
        if (!connectResult.success) {
          setError(connectResult.error || '连接数据库失败')
          return
        }
      }
      const requestOffset = reset ? 0 : nextOffset
      const streamResult = await window.electronAPI.chat.getMediaStream({
        sessionId: selectedContact === 'all' ? undefined : selectedContact,
        mediaType: tab,
        beginTimestamp: getRangeTimestampStart(dateStart),
        endTimestamp: getRangeTimestampEnd(dateEnd),
        offset: requestOffset,
        limit: PAGE_SIZE
      })

      if (!streamResult.success) {
        setError(streamResult.error || '加载失败')
        if (reset) {
          previewPatchRef.current = {}
          updatePatchRef.current = {}
          posterPatchRef.current = {}
          aspectPatchRef.current = {}
          if (previewPatchTimerRef.current !== null) {
            window.clearTimeout(previewPatchTimerRef.current)
            previewPatchTimerRef.current = null
          }
          if (posterPatchTimerRef.current !== null) {
            window.clearTimeout(posterPatchTimerRef.current)
            posterPatchTimerRef.current = null
          }
          if (aspectPatchTimerRef.current !== null) {
            window.clearTimeout(aspectPatchTimerRef.current)
            aspectPatchTimerRef.current = null
          }
          if (rangeTimerRef.current !== null) {
            window.clearTimeout(rangeTimerRef.current)
            rangeTimerRef.current = null
          }
          pendingRangeRef.current = null
          resolvingImageCacheBatchRef.current = false
          pendingImageResolveRangeRef.current = null
          imagePreloadUntilRef.current = {}
          imageCacheMissUntilRef.current = {}
          resolvingVideoPosterKeysRef.current.clear()
          attemptedVideoPosterKeysRef.current.clear()
          resolvedVideoMd5Ref.current = {}
          setItems([])
          setNextOffset(0)
          setHasMore(false)
          setSelectedKeys(new Set())
          setPreviewPathMap({})
          setPreviewUpdateMap({})
          setVideoPosterMap({})
          setImageAspectMap({})
        }
        return
      }

      const incoming = (streamResult.items || []) as MediaStreamItem[]
      if (reset) {
        previewPatchRef.current = {}
        updatePatchRef.current = {}
        posterPatchRef.current = {}
        aspectPatchRef.current = {}
        if (previewPatchTimerRef.current !== null) {
          window.clearTimeout(previewPatchTimerRef.current)
          previewPatchTimerRef.current = null
        }
        if (posterPatchTimerRef.current !== null) {
          window.clearTimeout(posterPatchTimerRef.current)
          posterPatchTimerRef.current = null
        }
        if (aspectPatchTimerRef.current !== null) {
          window.clearTimeout(aspectPatchTimerRef.current)
          aspectPatchTimerRef.current = null
        }
        if (rangeTimerRef.current !== null) {
          window.clearTimeout(rangeTimerRef.current)
          rangeTimerRef.current = null
        }
        pendingRangeRef.current = null
        resolvingImageCacheBatchRef.current = false
        pendingImageResolveRangeRef.current = null
        imagePreloadUntilRef.current = {}
        imageCacheMissUntilRef.current = {}
        resolvingVideoPosterKeysRef.current.clear()
        attemptedVideoPosterKeysRef.current.clear()
        resolvedVideoMd5Ref.current = {}
        setItems(incoming)
        setSelectedKeys(new Set())
        setPreviewPathMap({})
        setPreviewUpdateMap({})
        setVideoPosterMap({})
        setImageAspectMap({})
      } else {
        setItems((prev) => {
          const map = new Map(prev.map((row) => [getItemKey(row), row]))
          incoming.forEach((row) => map.set(getItemKey(row), row))
          return Array.from(map.values())
        })
      }
      setNextOffset(Number(streamResult.nextOffset || requestOffset + incoming.length))
      setHasMore(Boolean(streamResult.hasMore))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [dateEnd, dateStart, nextOffset, selectedContact, tab])

  useEffect(() => {
    void loadStream(true)
  }, [tab, selectedContact, dateStart, dateEnd])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const sessionResult = await window.electronAPI.chat.getSessions()
        if (!cancelled && sessionResult.success && Array.isArray(sessionResult.sessions)) {
          const initialNameMap: Record<string, string> = {}
          sessionResult.sessions.forEach((session) => {
            initialNameMap[session.username] = session.displayName || session.username
          })
          setSessionNameMap(initialNameMap)
          setContacts([
            { id: 'all', name: '全部联系人' },
            ...sessionResult.sessions.map((session) => ({
              id: session.username,
              name: session.displayName || session.username
            }))
          ])
        }
      } catch {
        // ignore
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const displayItems = useMemo(() => (
    items.map((item) => ({
      ...item,
      sessionDisplayName: item.sessionDisplayName || sessionNameMap[item.sessionId] || item.sessionId
    }))
  ), [items, sessionNameMap])

  useEffect(() => {
    const imageKeySet = new Set(
      displayItems
        .filter((item) => item.mediaType === 'image')
        .map((item) => getItemKey(item))
    )
    const videoKeySet = new Set(
      displayItems
        .filter((item) => item.mediaType === 'video')
        .map((item) => getItemKey(item))
    )

    setPreviewPathMap((prev) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(prev)) {
        if (!imageKeySet.has(key)) continue
        next[key] = value
      }
      if (Object.keys(next).length !== Object.keys(prev).length) changed = true
      return changed ? next : prev
    })

    setPreviewUpdateMap((prev) => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(prev)) {
        if (!imageKeySet.has(key)) continue
        next[key] = value
      }
      if (Object.keys(next).length !== Object.keys(prev).length) changed = true
      return changed ? next : prev
    })

    setImageAspectMap((prev) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [key, value] of Object.entries(prev)) {
        if (!imageKeySet.has(key)) continue
        next[key] = value
      }
      if (Object.keys(next).length !== Object.keys(prev).length) changed = true
      return changed ? next : prev
    })

    setVideoPosterMap((prev) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(prev)) {
        if (!videoKeySet.has(key)) continue
        next[key] = value
      }
      if (Object.keys(next).length !== Object.keys(prev).length) changed = true
      return changed ? next : prev
    })

    const validKeys = new Set<string>(displayItems.map((item) => getItemKey(item)))
    const nextResolvedVideoMd5: Record<string, string> = {}
    for (const [key, value] of Object.entries(resolvedVideoMd5Ref.current)) {
      if (!validKeys.has(key)) continue
      nextResolvedVideoMd5[key] = value
    }
    resolvedVideoMd5Ref.current = nextResolvedVideoMd5

    const nextAttempted = new Set<string>()
    attemptedVideoPosterKeysRef.current.forEach((key) => {
      if (validKeys.has(key)) nextAttempted.add(key)
    })
    attemptedVideoPosterKeysRef.current = nextAttempted

    const nextImageMissUntil: Record<string, number> = {}
    for (const [key, value] of Object.entries(imageCacheMissUntilRef.current)) {
      if (!validKeys.has(key)) continue
      nextImageMissUntil[key] = value
    }
    imageCacheMissUntilRef.current = nextImageMissUntil

    const nextImagePreloadUntil: Record<string, number> = {}
    for (const [key, value] of Object.entries(imagePreloadUntilRef.current)) {
      if (!validKeys.has(key)) continue
      nextImagePreloadUntil[key] = value
    }
    imagePreloadUntilRef.current = nextImagePreloadUntil

  }, [displayItems])

  const resolveImageCacheRange = useCallback((start: number, end: number) => {
    const from = Math.max(0, start)
    const to = Math.min(displayItems.length - 1, end)
    if (to < from) return
    const now = Date.now()
    const payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }> = []
    const itemKeys: string[] = []
    for (let i = from; i <= to; i += 1) {
      const item = displayItems[i]
      if (!item || item.mediaType !== 'image') continue
      const itemKey = getItemKey(item)
      if (previewPathMapRef.current[itemKey] || previewPatchRef.current[itemKey]) continue
      if (!item.imageMd5 && !item.imageDatName) continue
      if ((imageCacheMissUntilRef.current[itemKey] || 0) > now) continue
      payloads.push({
        sessionId: item.sessionId,
        imageMd5: item.imageMd5 || undefined,
        imageDatName: item.imageDatName || undefined
      })
      itemKeys.push(itemKey)
      if (payloads.length >= MAX_IMAGE_CACHE_RESOLVE_PER_TICK) break
    }
    if (payloads.length === 0) return
    if (resolvingImageCacheBatchRef.current) {
      pendingImageResolveRangeRef.current = { start: from, end: to }
      return
    }

    resolvingImageCacheBatchRef.current = true
    void (async () => {
      try {
        const result = await window.electronAPI.image.resolveCacheBatch(payloads, {
          disableUpdateCheck: true,
          allowCacheIndex: false
        })
        const rows = Array.isArray(result?.rows) ? result.rows : []
        const pathPatch: Record<string, string> = {}
        const updatePatch: Record<string, boolean> = {}
        const missUntil = Date.now() + 4500

        for (let i = 0; i < itemKeys.length; i += 1) {
          const itemKey = itemKeys[i]
          const row = rows[i]
          if (row?.success && row.localPath) {
            delete imageCacheMissUntilRef.current[itemKey]
            pathPatch[itemKey] = row.localPath
            updatePatch[itemKey] = Boolean(row.hasUpdate)
          } else {
            imageCacheMissUntilRef.current[itemKey] = missUntil
          }
        }

        if (Object.keys(pathPatch).length > 0) {
          setPreviewPathMap((prev) => ({ ...prev, ...pathPatch }))
        }
        if (Object.keys(updatePatch).length > 0) {
          setPreviewUpdateMap((prev) => ({ ...prev, ...updatePatch }))
        }
      } catch {
        const missUntil = Date.now() + 4500
        itemKeys.forEach((itemKey) => {
          imageCacheMissUntilRef.current[itemKey] = missUntil
        })
      } finally {
        resolvingImageCacheBatchRef.current = false
        const pending = pendingImageResolveRangeRef.current
        pendingImageResolveRangeRef.current = null
        if (pending) {
          resolveImageCacheRange(pending.start, pending.end)
        }
      }
    })()
  }, [displayItems])

  const preloadImageCacheRange = useCallback((start: number, end: number) => {
    const from = Math.max(0, start)
    const to = Math.min(displayItems.length - 1, end)
    if (to < from) return

    const now = Date.now()
    const payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string }> = []
    const dedup = new Set<string>()
    for (let i = from; i <= to; i += 1) {
      const item = displayItems[i]
      if (!item || item.mediaType !== 'image') continue
      const itemKey = getItemKey(item)
      if (previewPathMapRef.current[itemKey] || previewPatchRef.current[itemKey]) continue
      if (!item.imageMd5 && !item.imageDatName) continue
      if ((imagePreloadUntilRef.current[itemKey] || 0) > now) continue
      const dedupKey = `${item.sessionId || ''}|${item.imageMd5 || ''}|${item.imageDatName || ''}`
      if (dedup.has(dedupKey)) continue
      dedup.add(dedupKey)
      imagePreloadUntilRef.current[itemKey] = now + 12000
      payloads.push({
        sessionId: item.sessionId,
        imageMd5: item.imageMd5 || undefined,
        imageDatName: item.imageDatName || undefined
      })
      if (payloads.length >= MAX_IMAGE_CACHE_PRELOAD_PER_TICK) break
    }
    if (payloads.length === 0) return
    void window.electronAPI.image.preload(payloads, {
      allowDecrypt: false,
      allowCacheIndex: false
    })
  }, [displayItems])

  const resolveItemVideoMd5 = useCallback(async (item: MediaStreamItem): Promise<string> => {
    const itemKey = getItemKey(item)
    const cached = resolvedVideoMd5Ref.current[itemKey]
    if (cached) return cached

    let md5 = String(item.videoMd5 || '').trim().toLowerCase()
    if (md5) {
      resolvedVideoMd5Ref.current[itemKey] = md5
      return md5
    }
    const parsed = await window.electronAPI.video.parseVideoMd5(String(item.content || ''))
    if (parsed.success && parsed.md5) md5 = String(parsed.md5).trim().toLowerCase()
    if (md5) resolvedVideoMd5Ref.current[itemKey] = md5
    return md5
  }, [])

  const resolveVideoPoster = useCallback(async (item: MediaStreamItem) => {
    if (item.mediaType !== 'video') return
    const itemKey = getItemKey(item)
    if (videoPosterMapRef.current[itemKey]) return
    if (attemptedVideoPosterKeysRef.current.has(itemKey)) return
    if (resolvingVideoPosterKeysRef.current.has(itemKey)) return

    resolvingVideoPosterKeysRef.current.add(itemKey)
    try {
      const md5 = await resolveItemVideoMd5(item)
      if (!md5) {
        attemptedVideoPosterKeysRef.current.add(itemKey)
        return
      }
      const info = await window.electronAPI.video.getVideoInfo(md5, { includePoster: true, posterFormat: 'fileUrl' })
      if (!info.success || !info.exists) {
        attemptedVideoPosterKeysRef.current.add(itemKey)
        return
      }
      const poster = String(info.coverUrl || info.thumbUrl || '')
      if (!poster) {
        attemptedVideoPosterKeysRef.current.add(itemKey)
        return
      }
      queuePosterPatch(itemKey, poster)
      attemptedVideoPosterKeysRef.current.add(itemKey)
    } catch {
      attemptedVideoPosterKeysRef.current.add(itemKey)
    } finally {
      resolvingVideoPosterKeysRef.current.delete(itemKey)
    }
  }, [queuePosterPatch, resolveItemVideoMd5])

  const resolvePosterRange = useCallback((start: number, end: number) => {
    const from = Math.max(0, start)
    const to = Math.min(displayItems.length - 1, end)
    if (to < from) return
    let resolvedCount = 0
    for (let i = from; i <= to; i += 1) {
      const item = displayItems[i]
      if (!item || item.mediaType !== 'video') continue
      void resolveVideoPoster(item)
      resolvedCount += 1
      if (resolvedCount >= MAX_VIDEO_POSTER_RESOLVE_PER_TICK) break
    }
  }, [displayItems, resolveVideoPoster])

  const flushRangeResolve = useCallback(() => {
    rangeTimerRef.current = null
    const pending = pendingRangeRef.current
    if (!pending) return
    pendingRangeRef.current = null
    if (tab === 'image') {
      preloadImageCacheRange(pending.start - 4, pending.end + 20)
      resolveImageCacheRange(pending.start - 1, pending.end + 6)
      return
    }
    resolvePosterRange(pending.start, pending.end)
  }, [preloadImageCacheRange, resolveImageCacheRange, resolvePosterRange, tab])

  const scheduleRangeResolve = useCallback((start: number, end: number) => {
    const previous = pendingRangeRef.current
    if (previous && start >= previous.start && end <= previous.end) {
      return
    }
    pendingRangeRef.current = { start, end }
    if (rangeTimerRef.current !== null) {
      window.clearTimeout(rangeTimerRef.current)
      rangeTimerRef.current = null
    }
    rangeTimerRef.current = window.setTimeout(flushRangeResolve, 120)
  }, [flushRangeResolve])

  useEffect(() => {
    if (displayItems.length === 0) return
    if (tab === 'image') {
      preloadImageCacheRange(0, Math.min(displayItems.length - 1, INITIAL_IMAGE_PRELOAD_END))
      resolveImageCacheRange(0, Math.min(displayItems.length - 1, INITIAL_IMAGE_RESOLVE_END))
      return
    }
    resolvePosterRange(0, Math.min(displayItems.length - 1, 12))
  }, [displayItems, preloadImageCacheRange, resolveImageCacheRange, resolvePosterRange, tab])

  const selectedItems = useMemo(() => {
    if (selectedKeys.size === 0) return []
    return displayItems.filter((item) => selectedKeys.has(getItemKey(item)))
  }, [displayItems, selectedKeys])

  const toggleSelect = useCallback((item: MediaStreamItem) => {
    const key = getItemKey(item)
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const onImageLoaded = useCallback((item: MediaStreamItem, width: number, height: number) => {
    if (item.mediaType !== 'image') return
    if (!width || !height) return
    const ratio = height / width
    if (!Number.isFinite(ratio) || ratio <= 0) return
    const itemKey = getItemKey(item)
    queueAspectPatch(itemKey, ratio)
  }, [queueAspectPatch])

  const deleteOne = useCallback((item: MediaStreamItem) => {
    showConfirm('确认删除该原始记录？此操作不可恢复。', () => {
      void (async () => {
        const result = await window.electronAPI.chat.deleteMessage(item.sessionId, item.localId, item.createTime)
        if (!result.success) {
          showAlert(`删除失败：${result.error || '未知错误'}`, '删除失败')
          return
        }

        const key = getItemKey(item)
        setItems((prev) => prev.filter((row) => getItemKey(row) !== key))
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        setPreviewPathMap((prev) => {
          if (!prev[key]) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
        setPreviewUpdateMap((prev) => {
          if (prev[key] === undefined) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
        setActionMessage('删除成功')
      })()
    }, '删除确认')
  }, [showAlert, showConfirm])

  const batchDelete = useCallback(() => {
    if (selectedItems.length === 0 || batchBusy) return

    showConfirm(`确认删除选中 ${selectedItems.length} 条记录？此操作不可恢复。`, () => {
      void (async () => {
        setBatchBusy(true)
        let success = 0
        const deletedKeys = new Set<string>()
        try {
          for (const item of selectedItems) {
            const result = await window.electronAPI.chat.deleteMessage(item.sessionId, item.localId, item.createTime)
            if (result.success) {
              success += 1
              deletedKeys.add(getItemKey(item))
            }
          }

          setItems((prev) => prev.filter((item) => !deletedKeys.has(getItemKey(item))))
          setSelectedKeys(new Set())
          setPreviewPathMap((prev) => {
            const next = { ...prev }
            deletedKeys.forEach((key) => { delete next[key] })
            return next
          })
          setPreviewUpdateMap((prev) => {
            const next = { ...prev }
            deletedKeys.forEach((key) => { delete next[key] })
            return next
          })
          setActionMessage(`批量删除完成：成功 ${success}，失败 ${selectedItems.length - success}`)
          showAlert(`批量删除完成：成功 ${success}，失败 ${selectedItems.length - success}`, '批量删除完成')
        } finally {
          setBatchBusy(false)
        }
      })()
    }, '批量删除确认')
  }, [batchBusy, selectedItems, showAlert, showConfirm])

  const decryptImage = useCallback(async (item: MediaStreamItem): Promise<string | undefined> => {
    if (item.mediaType !== 'image') return

    const key = getItemKey(item)
    if (!item.imageMd5 && !item.imageDatName) {
      showAlert('当前图片缺少解密所需字段（imageMd5/imageDatName）', '无法解密')
      return
    }

    setDecryptingKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })

    try {
      const result = await window.electronAPI.image.decrypt({
        sessionId: item.sessionId,
        imageMd5: item.imageMd5 || undefined,
        imageDatName: item.imageDatName || undefined,
        force: true
      })
      if (!result?.success) {
        showAlert(`解密失败：${result?.error || '未知错误'}`, '解密失败')
        return undefined
      }

      if (result.localPath) {
        const localPath = result.localPath as string
        setPreviewPathMap((prev) => ({ ...prev, [key]: localPath }))
        setPreviewUpdateMap((prev) => ({ ...prev, [key]: isLikelyThumbnailPreview(localPath) }))
        setActionMessage('图片解密完成')
        return localPath
      }
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: item.sessionId,
          imageMd5: item.imageMd5 || undefined,
          imageDatName: item.imageDatName || undefined
        })
        if (resolved?.success && resolved.localPath) {
          const localPath = resolved.localPath
          setPreviewPathMap((prev) => ({ ...prev, [key]: localPath }))
          setPreviewUpdateMap((prev) => ({ ...prev, [key]: Boolean(resolved.hasUpdate) }))
          setActionMessage('图片解密完成')
          return localPath
        }
      } catch {
        // ignore
      }
      setActionMessage('图片解密完成')
      return undefined
    } catch (e) {
      showAlert(`解密失败：${String(e)}`, '解密失败')
      return undefined
    } finally {
      setDecryptingKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [isLikelyThumbnailPreview, showAlert])

  const onImagePreviewAction = useCallback(async (item: MediaStreamItem) => {
    if (item.mediaType !== 'image') return
    const key = getItemKey(item)
    let localPath = previewPathMapRef.current[key] || previewPatchRef.current[key] || ''

    if (localPath) {
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: item.sessionId,
          imageMd5: item.imageMd5 || undefined,
          imageDatName: item.imageDatName || undefined
        })
        if (resolved?.success && resolved.localPath) {
          localPath = resolved.localPath
          queuePreviewPatch(key, localPath, Boolean(resolved.hasUpdate))
        }
      } catch {
        // ignore
      }
      if (localPath) {
        await window.electronAPI.window.openImageViewerWindow(localPath)
        return
      }
    }

    try {
      const resolved = await window.electronAPI.image.resolveCache({
        sessionId: item.sessionId,
        imageMd5: item.imageMd5 || undefined,
        imageDatName: item.imageDatName || undefined
      })
      if (resolved?.success && resolved.localPath) {
        localPath = resolved.localPath
        queuePreviewPatch(key, localPath, Boolean(resolved.hasUpdate))
        await window.electronAPI.window.openImageViewerWindow(localPath)
        return
      }
    } catch {
      // ignore
    }

    await decryptImage(item)
  }, [decryptImage, queuePreviewPatch])

  const updateImageQuality = useCallback(async (item: MediaStreamItem) => {
    await decryptImage(item)
  }, [decryptImage])

  const batchDecryptImage = useCallback(async () => {
    if (batchBusy) return

    const imageItems = selectedItems.filter((item) => item.mediaType === 'image')
    if (imageItems.length === 0) {
      showAlert('当前选中中没有图片资源', '无法批量解密')
      return
    }

    setBatchBusy(true)
    let success = 0
    let failed = 0
    const previewPatch: Record<string, string> = {}
    const updatePatch: Record<string, boolean> = {}
    const taskId = registerBackgroundTask({
      sourcePage: 'other',
      title: '资源页图片批量解密',
      detail: `正在解密图片（0/${imageItems.length}）`,
      progressText: `0 / ${imageItems.length}`,
      cancelable: false
    })
    try {
      let completed = 0
      const progressStep = Math.max(1, Math.floor(imageItems.length / TASK_PROGRESS_UPDATE_MAX_STEPS))
      let lastProgressBucket = 0
      let lastProgressUpdateAt = Date.now()
      const updateTaskProgress = (force: boolean = false) => {
        const now = Date.now()
        const bucket = Math.floor(completed / progressStep)
        const crossedBucket = bucket !== lastProgressBucket
        const intervalReached = now - lastProgressUpdateAt >= TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS
        if (!force && !crossedBucket && !intervalReached) return
        updateBackgroundTask(taskId, {
          detail: `正在解密图片（${completed}/${imageItems.length}）`,
          progressText: `${completed} / ${imageItems.length}`
        })
        lastProgressBucket = bucket
        lastProgressUpdateAt = now
      }
      for (const item of imageItems) {
        if (!item.imageMd5 && !item.imageDatName) {
          failed += 1
          completed += 1
          updateTaskProgress()
          continue
        }
        const result = await window.electronAPI.image.decrypt({
          sessionId: item.sessionId,
          imageMd5: item.imageMd5 || undefined,
          imageDatName: item.imageDatName || undefined,
          force: true
        })
        if (!result?.success) {
          failed += 1
        } else {
          success += 1
          if (result.localPath) {
            const key = getItemKey(item)
            previewPatch[key] = result.localPath
            updatePatch[key] = isLikelyThumbnailPreview(result.localPath)
          }
        }
        completed += 1
        updateTaskProgress()
      }
      updateTaskProgress(true)

      if (Object.keys(previewPatch).length > 0) {
        setPreviewPathMap((prev) => ({ ...prev, ...previewPatch }))
      }
      if (Object.keys(updatePatch).length > 0) {
        setPreviewUpdateMap((prev) => ({ ...prev, ...updatePatch }))
      }
      setActionMessage(`批量解密完成：成功 ${success}，失败 ${failed}`)
      showAlert(`批量解密完成：成功 ${success}，失败 ${failed}`, '批量解密完成')
      finishBackgroundTask(taskId, success > 0 || failed === 0 ? 'completed' : 'failed', {
        detail: `资源页图片批量解密完成：成功 ${success}，失败 ${failed}`,
        progressText: `成功 ${success} / 失败 ${failed}`
      })
    } catch (e) {
      finishBackgroundTask(taskId, 'failed', {
        detail: `资源页图片批量解密失败：${String(e)}`
      })
      showAlert(`批量解密失败：${String(e)}`, '批量解密失败')
    } finally {
      setBatchBusy(false)
    }
  }, [batchBusy, isLikelyThumbnailPreview, selectedItems, showAlert])

  const openVideo = useCallback(async (item: MediaStreamItem) => {
    if (item.mediaType !== 'video') return

    const md5 = await resolveItemVideoMd5(item)
    if (!md5) {
      showAlert('未解析到视频资源标识', '无法播放')
      return
    }

    const info = await window.electronAPI.video.getVideoInfo(md5, { includePoster: false })
    if (!info.success || !info.exists || !info.videoUrl) {
      showAlert(info.error || '未找到视频文件', '无法播放')
      return
    }

    await window.electronAPI.window.openVideoPlayerWindow(info.videoUrl)
  }, [resolveItemVideoMd5, showAlert])

  return (
    <div className="resources-page stream-rebuild">
      <header className="stream-toolbar">
        <div className="toolbar-left">
          <div className="media-tabs">
            <button type="button" className={tab === 'image' ? 'active' : ''} onClick={() => setTab('image')}>图片</button>
            <button type="button" className={tab === 'video' ? 'active' : ''} onClick={() => setTab('video')}>视频</button>
          </div>
          <div className="filters">
            <label className="filter-field filter-select">
              <UserRound size={14} />
              <select
                className="contact-select"
                value={selectedContact}
                onChange={(event) => setSelectedContact(event.target.value)}
              >
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>{contact.name}</option>
                ))}
              </select>
            </label>
            <label className="filter-field filter-date">
              <Calendar size={14} />
              <input
                className="date-input"
                type="date"
                value={dateStart}
                onChange={(event) => setDateStart(event.target.value)}
              />
            </label>
            <span className="sep">至</span>
            <label className="filter-field filter-date">
              <Calendar size={14} />
              <input
                className="date-input"
                type="date"
                value={dateEnd}
                onChange={(event) => setDateEnd(event.target.value)}
              />
            </label>
            <button type="button" className="ghost reset-btn" onClick={() => { setDateStart(''); setDateEnd('') }}>重置时间</button>
          </div>
        </div>
        <div className="toolbar-right">
          <button type="button" onClick={() => void loadStream(true)} disabled={loading || loadingMore}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            刷新
          </button>
          {tab === 'image' && (
            <button type="button" onClick={() => void batchDecryptImage()} disabled={selectedKeys.size === 0 || batchBusy}>
              批量解密
            </button>
          )}
          <button type="button" className="danger" onClick={() => void batchDelete()} disabled={selectedKeys.size === 0 || batchBusy}>
            批量删除
          </button>
        </div>
      </header>

      <div className="stream-summary">
        <span>已加载 {items.length} 条</span>
        <span>已选 {selectedKeys.size} 条</span>
        <span>{tab === 'image' ? '图片按时间倒序流式展示' : '视频按时间倒序流式展示'}</span>
        {actionMessage && <span className="action-message">{actionMessage}</span>}
      </div>

      {error && (
        <div className="stream-state error">{error}</div>
      )}

      {!error && items.length === 0 && (loading || loadingMore) && (
        <div className="stream-state"><Loader2 size={18} className="spin" /> 正在加载...</div>
      )}

      {!error && items.length === 0 && !loading && !loadingMore && (
        <div className="stream-state">当前筛选条件下没有内容</div>
      )}

      {!error && items.length > 0 && (
        <div className="stream-grid-wrap">
          <VirtuosoGrid
            className="stream-grid"
            overscan={48}
            components={{
              List: GridList,
              Item: GridItem
            }}
            data={displayItems}
            computeItemKey={(_, item) => getItemKey(item)}
            rangeChanged={(range) => {
              scheduleRangeResolve(range.startIndex - 3, range.endIndex + 6)
            }}
            endReached={() => {
              if (!hasMore || loading || loadingMore) return
              void loadStream(false)
            }}
            itemContent={(_, item) => {
              const itemKey = getItemKey(item)
              const aspect = imageAspectMap[itemKey] || 0
              return (
                <MediaCard
                  item={item}
                  sessionName={item.sessionDisplayName || item.sessionId}
                  previewPath={previewPathMap[itemKey] || ''}
                  videoPosterPath={videoPosterMap[itemKey] || ''}
                  imageIsLong={aspect >= 2.8}
                  hasPreviewUpdate={Boolean(previewUpdateMap[itemKey])}
                  selected={selectedKeys.has(itemKey)}
                  decrypting={decryptingKeys.has(itemKey)}
                  onToggleSelect={toggleSelect}
                  onDelete={deleteOne}
                  onImagePreviewAction={onImagePreviewAction}
                  onUpdateImageQuality={updateImageQuality}
                  onOpenVideo={openVideo}
                  onImageLoaded={onImageLoaded}
                />
              )
            }}
          />
          {loadingMore && <div className="grid-loading-more"><Loader2 size={16} className="spin" /> 加载更多中...</div>}
          {!hasMore && <div className="grid-end">已加载到底</div>}
        </div>
      )}

      {dialog && (
        <div className="resource-dialog-mask">
          <div className="resource-dialog" role="dialog" aria-modal="true" aria-label={dialog.title}>
            <header className="dialog-header">{dialog.title}</header>
            <div className="dialog-body">{dialog.message}</div>
            <footer className="dialog-actions">
              {dialog.mode === 'confirm' && (
                <button type="button" className="dialog-btn ghost" onClick={closeDialog}>
                  {dialog.cancelText || '取消'}
                </button>
              )}
              <button
                type="button"
                className="dialog-btn solid"
                onClick={() => {
                  const callback = dialog.onConfirm
                  closeDialog()
                  callback?.()
                }}
              >
                {dialog.confirmText || '确定'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

export default ResourcesPage
