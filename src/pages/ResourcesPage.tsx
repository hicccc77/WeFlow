import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type MutableRefObject } from 'react'
import { Calendar, Image as ImageIcon, Info, Loader2, PlayCircle, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { VirtuosoGrid } from 'react-virtuoso'
import { finishBackgroundTask, registerBackgroundTask, updateBackgroundTask } from '../services/backgroundTaskMonitor'
import {
  BATCH_IMAGE_DECRYPT_CONCURRENCY,
  BATCH_IMAGE_DECRYPT_YIELD_MS,
  BATCH_IMAGE_HARDLINK_PRELOAD_CHUNK_SIZE,
  BATCH_IMAGE_HARDLINK_PRELOAD_YIELD_MS,
  IMAGE_PREDECRYPT_LOOKAHEAD,
  IMAGE_PREDECRYPT_IDLE_DELAY_MS,
  IMAGE_PREDECRYPT_TIMER_MS,
  INITIAL_IMAGE_PREDECRYPT_END,
  INITIAL_IMAGE_PRELOAD_END,
  INITIAL_IMAGE_RESOLVE_END,
  MAX_IMAGE_CACHE_PRELOAD_PER_TICK,
  MAX_IMAGE_CACHE_RESOLVE_PER_TICK,
  MAX_IMAGE_PREDECRYPT_PER_TICK,
  MAX_MEDIA_PATCHES_PER_FLUSH,
  MAX_VIDEO_POSTER_RESOLVE_PER_TICK,
  PAGE_SIZE,
  TASK_PROGRESS_UPDATE_MAX_STEPS,
  TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS,
  extractVideoMd5,
  extractVideoTitle,
  formatInfoValue,
  formatTimeLabel,
  getItemKey,
  getRangeTimestampEnd,
  getRangeTimestampStart,
  getSafeImageDatName,
  hasImageLocator,
  normalizeMediaToken,
  toRenderableMediaSrc,
  type ContactOption,
  type DialogState,
  type ImagePreloadPayload,
  type MediaStreamItem,
  type MediaTab
} from './ResourcesPage.utils'
import './ResourcesPage.scss'

const waitForBatchDecryptYield = () => new Promise<void>((resolve) => window.setTimeout(resolve, BATCH_IMAGE_DECRYPT_YIELD_MS))

const GridList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function GridList(props, ref) {
  const { className = '', ...rest } = props
  const mergedClassName = ['stream-grid-list', className].filter(Boolean).join(' ')
  return <div ref={ref} className={mergedClassName} {...rest} />
})

const GridItem = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function GridItem(props, ref) {
  const { className = '', ...rest } = props
  const mergedClassName = ['stream-grid-item', className].filter(Boolean).join(' ')
  return <div ref={ref} className={mergedClassName} {...rest} />
})

const GRID_COMPONENTS = {
  List: GridList,
  Item: GridItem
}

type MediaItemMeta = {
  itemKey: string
  imageMd5: string
  imageDatName: string
  imageIdentity: string
  videoMd5: string
  videoTitle: string
  hasImageLocator: boolean
}

type ResourceRuntimeCounters = {
  cacheResolvedEvents: number
  cacheResolvedPatchedItems: number
  cacheResolvedUnmatchedEvents: number
  imageResolveStarted: number
  imageResolveCompleted: number
  imageResolveSuperseded: number
  imageResolveIdentityMissSkipped: number
  imageResolveMisses: number
  imageResolveContainedSkips: number
  imageResolvePendingMerges: number
  imageResolvePendingReplacements: number
  imagePreloadRequests: number
  imagePreloadRejectedCapacity: number
  imagePreloadSubmittingSkips: number
  imagePredecryptRequests: number
  imagePredecryptBackpressureSkips: number
  imagePredecryptRejectedCapacity: number
  imagePredecryptDeferred: number
  imagePredecryptSubmittingSkips: number
  imagePredecryptPreviewUpgrades: number
  loadMoreRequests: number
  loadMoreSkipped: number
  loadResets: number
  mediaStreamLoadSamples: number
  mediaStreamLoadMsTotal: number
  mediaStreamMaxLoadMs: number
  mediaStreamPageCacheHits: number
  mediaStreamInflightMerges: number
  mediaStreamNativeLoads: number
  mediaStreamRowsLoaded: number
  mediaStreamDuplicateRows: number
  mediaStreamNoProgressStops: number
  previewPatchesQueued: number
  rangeFlushes: number
  rangeSchedules: number
  rangeDuplicateSkips: number
  rangeHiddenSkips: number
  rangeVisibilityReschedules: number
  rangeContainedSkips: number
  rangePendingMerges: number
  rangePendingReplacements: number
  predecryptFlushes: number
  predecryptContainedSkips: number
  predecryptHiddenSkips: number
  predecryptPendingUpdates: number
  predecryptPendingReplacements: number
  predecryptSchedules: number
  transientStatePruneRuns: number
  videoPosterBatches: number
  videoPosterMd5CacheHits: number
  videoPosterMd5MissSkips: number
  videoPosterContainedSkips: number
  videoPosterPendingMerges: number
  videoPosterPendingReplacements: number
}

type ResourceFrameMetrics = {
  samples: number
  longFrames: number
  maxFrameMs: number
  lastFrameMs: number
}

const createResourceRuntimeCounters = (): ResourceRuntimeCounters => ({
  cacheResolvedEvents: 0,
  cacheResolvedPatchedItems: 0,
  cacheResolvedUnmatchedEvents: 0,
  imageResolveStarted: 0,
  imageResolveCompleted: 0,
  imageResolveSuperseded: 0,
  imageResolveIdentityMissSkipped: 0,
  imageResolveMisses: 0,
  imageResolveContainedSkips: 0,
  imageResolvePendingMerges: 0,
  imageResolvePendingReplacements: 0,
  imagePreloadRequests: 0,
  imagePreloadRejectedCapacity: 0,
  imagePreloadSubmittingSkips: 0,
  imagePredecryptRequests: 0,
  imagePredecryptBackpressureSkips: 0,
  imagePredecryptRejectedCapacity: 0,
  imagePredecryptDeferred: 0,
  imagePredecryptSubmittingSkips: 0,
  imagePredecryptPreviewUpgrades: 0,
  loadMoreRequests: 0,
  loadMoreSkipped: 0,
  loadResets: 0,
  mediaStreamLoadSamples: 0,
  mediaStreamLoadMsTotal: 0,
  mediaStreamMaxLoadMs: 0,
  mediaStreamPageCacheHits: 0,
  mediaStreamInflightMerges: 0,
  mediaStreamNativeLoads: 0,
  mediaStreamRowsLoaded: 0,
  mediaStreamDuplicateRows: 0,
  mediaStreamNoProgressStops: 0,
  previewPatchesQueued: 0,
  rangeFlushes: 0,
  rangeSchedules: 0,
  rangeDuplicateSkips: 0,
  rangeHiddenSkips: 0,
  rangeVisibilityReschedules: 0,
  rangeContainedSkips: 0,
  rangePendingMerges: 0,
  rangePendingReplacements: 0,
  predecryptFlushes: 0,
  predecryptContainedSkips: 0,
  predecryptHiddenSkips: 0,
  predecryptPendingUpdates: 0,
  predecryptPendingReplacements: 0,
  predecryptSchedules: 0,
  transientStatePruneRuns: 0,
  videoPosterBatches: 0,
  videoPosterMd5CacheHits: 0,
  videoPosterMd5MissSkips: 0,
  videoPosterContainedSkips: 0,
  videoPosterPendingMerges: 0,
  videoPosterPendingReplacements: 0
})

const createResourceFrameMetrics = (): ResourceFrameMetrics => ({
  samples: 0,
  longFrames: 0,
  maxFrameMs: 0,
  lastFrameMs: 0
})

type ResourcePreloadStatsSnapshot = {
  queuedDecrypt?: number
  queuedLow?: number
  activeDecrypt?: number
  highWater?: {
    queuedDecrypt?: number
    queuedLow?: number
    activeDecrypt?: number
  }
}

type ImagePreloadCandidate = {
  payload: ImagePreloadPayload
  itemKey: string
  imageIdentity: string
  previewUpgrade: boolean
}

type MediaCardProps = {
  item: MediaStreamItem
  itemKey: string
  sessionName: string
  videoTitle: string
  previewPath: string
  videoPosterPath: string
  imageIsLong: boolean
  hasPreviewUpdate: boolean
  selected: boolean
  decrypting: boolean
  onToggleSelect: (item: MediaStreamItem) => void
  onDelete: (item: MediaStreamItem) => void
  onShowInfo: (item: MediaStreamItem) => void
  onImagePreviewAction: (item: MediaStreamItem) => void
  onUpdateImageQuality: (item: MediaStreamItem) => void
  onOpenVideo: (item: MediaStreamItem) => void
  onImageLoaded: (item: MediaStreamItem, width: number, height: number) => void
}

type MediaCardDynamicState = Pick<
  MediaCardProps,
  'previewPath' | 'videoPosterPath' | 'imageIsLong' | 'hasPreviewUpdate' | 'selected' | 'decrypting'
>

type MediaCardStore = {
  getSnapshot: (itemKey: string) => MediaCardDynamicState
  subscribe: (itemKey: string, listener: () => void) => () => void
  update: (itemKey: string, patch: Partial<MediaCardDynamicState>) => void
  remove: (itemKey: string) => void
  pruneTransient: (keepKeys: Set<string>) => void
  clear: () => void
}

type MediaCardContainerProps = Omit<MediaCardProps, keyof MediaCardDynamicState> & {
  stateStore: MediaCardStore
}

const EMPTY_MEDIA_CARD_STATE: MediaCardDynamicState = {
  previewPath: '',
  videoPosterPath: '',
  imageIsLong: false,
  hasPreviewUpdate: false,
  selected: false,
  decrypting: false
}

function areMediaCardStatesEqual(prev: MediaCardDynamicState, next: MediaCardDynamicState): boolean {
  return (
    prev.previewPath === next.previewPath &&
    prev.videoPosterPath === next.videoPosterPath &&
    prev.imageIsLong === next.imageIsLong &&
    prev.hasPreviewUpdate === next.hasPreviewUpdate &&
    prev.selected === next.selected &&
    prev.decrypting === next.decrypting
  )
}

function createMediaCardStore(): MediaCardStore {
  const snapshots = new Map<string, MediaCardDynamicState>()
  const listeners = new Map<string, Set<() => void>>()
  const notify = (itemKey: string) => {
    const itemListeners = listeners.get(itemKey)
    if (!itemListeners || itemListeners.size === 0) return
    for (const listener of Array.from(itemListeners)) listener()
  }

  return {
    getSnapshot: (itemKey: string) => snapshots.get(itemKey) || EMPTY_MEDIA_CARD_STATE,
    subscribe: (itemKey: string, listener: () => void) => {
      const itemListeners = listeners.get(itemKey) || new Set<() => void>()
      itemListeners.add(listener)
      listeners.set(itemKey, itemListeners)
      return () => {
        itemListeners.delete(listener)
        if (itemListeners.size === 0) listeners.delete(itemKey)
      }
    },
    update: (itemKey: string, patch: Partial<MediaCardDynamicState>) => {
      if (!itemKey) return
      const previous = snapshots.get(itemKey) || EMPTY_MEDIA_CARD_STATE
      const next = { ...previous, ...patch }
      if (areMediaCardStatesEqual(previous, next)) return
      snapshots.set(itemKey, next)
      notify(itemKey)
    },
    remove: (itemKey: string) => {
      if (!snapshots.delete(itemKey)) return
      notify(itemKey)
    },
    pruneTransient: (keepKeys: Set<string>) => {
      for (const [itemKey, previous] of snapshots.entries()) {
        if (keepKeys.has(itemKey)) continue
        const next: MediaCardDynamicState = {
          ...EMPTY_MEDIA_CARD_STATE,
          selected: previous.selected,
          decrypting: previous.decrypting
        }
        if (areMediaCardStatesEqual(previous, next)) continue
        if (next.selected || next.decrypting) {
          snapshots.set(itemKey, next)
        } else {
          snapshots.delete(itemKey)
        }
        notify(itemKey)
      }
    },
    clear: () => {
      if (snapshots.size === 0) return
      const keys = Array.from(snapshots.keys())
      snapshots.clear()
      keys.forEach(notify)
    }
  }
}

function buildMediaItemMeta(item: MediaStreamItem): MediaItemMeta {
  const imageMd5 = item.mediaType === 'image' ? normalizeMediaToken(item.imageMd5) : ''
  const imageDatName = item.mediaType === 'image' ? getSafeImageDatName(item) : ''
  const videoMd5 = item.mediaType === 'video'
    ? (normalizeMediaToken(item.videoMd5) || extractVideoMd5(item.content))
    : ''
  const videoTitle = item.mediaType === 'video' ? extractVideoTitle(item.content) : ''
  const sessionId = String(item.sessionId || '').trim().toLowerCase()
  const createTime = Number(item.createTime || 0) || 0
  return {
    itemKey: getItemKey(item),
    imageMd5,
    imageDatName,
    imageIdentity: imageMd5 ? `md5:${imageMd5}` : (imageDatName ? `dat:${sessionId}|${createTime}|${imageDatName}` : ''),
    videoMd5,
    videoTitle,
    hasImageLocator: Boolean(imageMd5 || imageDatName)
  }
}

function mergeRecordPatch<T extends string | number | boolean>(prev: Record<string, T>, patch: Record<string, T>): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const key in patch) {
    const value = patch[key]
    if (prev[key] === value) continue
    if (!next) next = { ...prev }
    next[key] = value
  }
  return next || prev
}

function removeRecordKeys<T extends string | number | boolean>(prev: Record<string, T>, keys: Set<string>): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(prev, key)) continue
    if (!next) next = { ...prev }
    delete next[key]
  }
  return next || prev
}

function pruneRecordToKeys<T extends string | number | boolean>(prev: Record<string, T>, keepKeys: Set<string>): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const key in prev) {
    if (keepKeys.has(key)) continue
    if (!next) next = { ...prev }
    delete next[key]
  }
  return next || prev
}

function removeItemsByKeys(
  prev: MediaStreamItem[],
  keys: Set<string>,
  getMeta: (item: MediaStreamItem) => MediaItemMeta
): MediaStreamItem[] {
  if (keys.size === 0 || prev.length === 0) return prev
  let removed = false
  const next = prev.filter((item) => {
    const keep = !keys.has(getMeta(item).itemKey)
    if (!keep) removed = true
    return keep
  })
  return removed ? next : prev
}

function clearArray<T>(prev: T[]): T[] {
  return prev.length === 0 ? prev : []
}

function clearSet<T>(prev: Set<T>): Set<T> {
  return prev.size === 0 ? prev : new Set()
}

function clearRecord<T extends string | number | boolean>(prev: Record<string, T>): Record<string, T> {
  return hasRecordEntries(prev) ? {} : prev
}

function addSetValue<T>(prev: Set<T>, value: T): Set<T> {
  if (prev.has(value)) return prev
  const next = new Set(prev)
  next.add(value)
  return next
}

function removeSetValue<T>(prev: Set<T>, value: T): Set<T> {
  if (!prev.has(value)) return prev
  const next = new Set(prev)
  next.delete(value)
  return next
}

function hasRecordEntries<T>(record: Record<string, T>): boolean {
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return true
  }
  return false
}

function mergeRange(
  current: { start: number; end: number } | null,
  next: { start: number; end: number }
): { start: number; end: number } {
  if (!current) return next
  return {
    start: Math.min(current.start, next.start),
    end: Math.max(current.end, next.end)
  }
}

function mergeNearbyRange(
  current: { start: number; end: number } | null,
  next: { start: number; end: number },
  maxGap: number
): { range: { start: number; end: number }; merged: boolean } {
  if (!current) return { range: next, merged: false }
  if (next.start > current.end + maxGap || current.start > next.end + maxGap) {
    return { range: next, merged: false }
  }
  return { range: mergeRange(current, next), merged: true }
}

function areMediaItemsEquivalent(prev: MediaStreamItem, next: MediaStreamItem): boolean {
  if (prev === next) return true
  return (
    prev.mediaType === next.mediaType &&
    prev.createTime === next.createTime &&
    prev.senderUsername === next.senderUsername &&
    prev.sessionId === next.sessionId &&
    prev.sessionDisplayName === next.sessionDisplayName &&
    prev.localId === next.localId &&
    prev.serverId === next.serverId &&
    prev.localType === next.localType &&
    prev.isSend === next.isSend &&
    prev.imageMd5 === next.imageMd5 &&
    prev.imageDatName === next.imageDatName &&
    prev.videoMd5 === next.videoMd5 &&
    prev.content === next.content
  )
}

function areMediaCardPropsEqual(prev: MediaCardProps, next: MediaCardProps): boolean {
  return (
    prev.itemKey === next.itemKey &&
    areMediaItemsEquivalent(prev.item, next.item) &&
    prev.sessionName === next.sessionName &&
    prev.videoTitle === next.videoTitle &&
    prev.previewPath === next.previewPath &&
    prev.videoPosterPath === next.videoPosterPath &&
    prev.imageIsLong === next.imageIsLong &&
    prev.hasPreviewUpdate === next.hasPreviewUpdate &&
    prev.selected === next.selected &&
    prev.decrypting === next.decrypting &&
    prev.onToggleSelect === next.onToggleSelect &&
    prev.onDelete === next.onDelete &&
    prev.onShowInfo === next.onShowInfo &&
    prev.onImagePreviewAction === next.onImagePreviewAction &&
    prev.onUpdateImageQuality === next.onUpdateImageQuality &&
    prev.onOpenVideo === next.onOpenVideo &&
    prev.onImageLoaded === next.onImageLoaded
  )
}

const MediaCard = memo(function MediaCard({
  item,
  sessionName,
  videoTitle,
  previewPath,
  videoPosterPath,
  imageIsLong,
  hasPreviewUpdate,
  selected,
  decrypting,
  onToggleSelect,
  onDelete,
  onShowInfo,
  onImagePreviewAction,
  onUpdateImageQuality,
  onOpenVideo,
  onImageLoaded
}: MediaCardProps) {
  const isImage = item.mediaType === 'image'
  const isDecryptingVisual = decrypting
  const showDecryptOverlay = isImage && isDecryptingVisual
  const previewSrc = useMemo(() => previewPath ? toRenderableMediaSrc(previewPath) : '', [previewPath])
  const videoPosterSrc = useMemo(() => videoPosterPath ? toRenderableMediaSrc(videoPosterPath) : '', [videoPosterPath])
  const timeLabel = useMemo(() => formatTimeLabel(item.createTime), [item.createTime])

  return (
    <article className={`media-card ${selected ? 'selected' : ''} ${isDecryptingVisual ? 'decrypting' : ''}`}>
      <button type="button" className="floating-info" onClick={() => onShowInfo(item)} aria-label="查看资源信息">
        <Info size={14} />
      </button>
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
              src={previewSrc}
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
            ? <img src={videoPosterSrc} alt="视频封面" loading="lazy" decoding="async" />
            : <div className="placeholder">
              <PlayCircle size={34} />
              <span>{videoTitle}</span>
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
          <span className="time">{timeLabel}</span>
        </div>
        <div className="sub-row">
          <span>{item.mediaType === 'image' ? '图片' : '视频'}</span>
          {item.senderUsername && <span>{item.senderUsername}</span>}
        </div>
      </div>
    </article>
  )
}, areMediaCardPropsEqual)

const MediaCardContainer = memo(function MediaCardContainer({
  stateStore,
  itemKey,
  ...props
}: MediaCardContainerProps) {
  const state = useSyncExternalStore(
    useCallback((listener) => stateStore.subscribe(itemKey, listener), [itemKey, stateStore]),
    useCallback(() => stateStore.getSnapshot(itemKey), [itemKey, stateStore]),
    () => EMPTY_MEDIA_CARD_STATE
  )
  return (
    <MediaCard
      {...props}
      itemKey={itemKey}
      previewPath={state.previewPath}
      videoPosterPath={state.videoPosterPath}
      imageIsLong={state.imageIsLong}
      hasPreviewUpdate={state.hasPreviewUpdate}
      selected={state.selected}
      decrypting={state.decrypting}
    />
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
  const [actionMessage, setActionMessage] = useState('')
  const [sessionNameMap, setSessionNameMap] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const previewPathMapRef = useRef<Record<string, string>>({})
  const previewUpdateMapRef = useRef<Record<string, boolean>>({})
  const videoPosterMapRef = useRef<Record<string, string>>({})
  const imageAspectMapRef = useRef<Record<string, number>>({})
  const selectedKeysRef = useRef<Set<string>>(new Set())
  const decryptingKeysRef = useRef<Set<string>>(new Set())
  const mediaCardStateStoreRef = useRef<MediaCardStore>(createMediaCardStore())
  const imageResolveBatchIdRef = useRef(0)
  const resolvingImageCacheBatchRef = useRef(false)
  const pendingImageResolveRangeRef = useRef<{ start: number; end: number } | null>(null)
  const imagePreloadUntilRef = useRef<Record<string, number>>({})
  const imagePredecryptUntilRef = useRef<Record<string, number>>({})
  const imagePreloadIdentityUntilRef = useRef<Record<string, number>>({})
  const imagePredecryptIdentityUntilRef = useRef<Record<string, number>>({})
  const imagePreloadSubmittingIdentityRef = useRef<Set<string>>(new Set())
  const imagePredecryptSubmittingIdentityRef = useRef<Set<string>>(new Set())
  const preloadSubmissionEpochRef = useRef(0)
  const imageCacheMissUntilRef = useRef<Record<string, number>>({})
  const imageCacheIdentityMissUntilRef = useRef<Record<string, number>>({})
  const videoPosterBatchIdRef = useRef(0)
  const resolvingVideoPosterBatchRef = useRef(false)
  const pendingVideoPosterRangeRef = useRef<{ start: number; end: number } | null>(null)
  const resolvingVideoPosterKeysRef = useRef<Set<string>>(new Set())
  const attemptedVideoPosterKeysRef = useRef<Set<string>>(new Set())
  const resolvingVideoPosterMd5Ref = useRef<Set<string>>(new Set())
  const attemptedVideoPosterMd5Ref = useRef<Set<string>>(new Set())
  const videoPosterByMd5Ref = useRef<Record<string, string>>({})
  const previewPatchRef = useRef<Record<string, string>>({})
  const updatePatchRef = useRef<Record<string, boolean>>({})
  const previewPatchTimerRef = useRef<number | null>(null)
  const posterPatchRef = useRef<Record<string, string>>({})
  const posterPatchTimerRef = useRef<number | null>(null)
  const aspectPatchRef = useRef<Record<string, number>>({})
  const aspectPatchTimerRef = useRef<number | null>(null)
  const pendingRangeRef = useRef<{ start: number; end: number } | null>(null)
  const lastVisibleRangeRef = useRef<{ start: number; end: number } | null>(null)
  const lastRangeActivityAtRef = useRef(0)
  const rangeTimerRef = useRef<number | null>(null)
  const transientStatePruneTimerRef = useRef<number | null>(null)
  const pendingTransientPruneRangeRef = useRef<{ start: number; end: number } | null>(null)
  const pendingPredecryptRangeRef = useRef<{ start: number; end: number } | null>(null)
  const predecryptTimerRef = useRef<number | null>(null)
  const streamRequestIdRef = useRef(0)
  const loadingRef = useRef(false)
  const loadingMoreRef = useRef(false)
  const nextOffsetRef = useRef(0)
  const hasMoreRef = useRef(false)
  const preloadScopeRef = useRef('resources-initial')
  const initialRangeScheduleKeyRef = useRef('')
  const itemMetaMapRef = useRef<WeakMap<MediaStreamItem, MediaItemMeta>>(new WeakMap())
  const itemByKeyRef = useRef<Record<string, MediaStreamItem>>({})
  const itemMetaByKeyRef = useRef<Record<string, MediaItemMeta>>({})
  const loadedItemKeysRef = useRef<Set<string>>(new Set())
  const validItemKeysRef = useRef<Set<string>>(new Set())
  const imageItemKeysRef = useRef<Set<string>>(new Set())
  const videoItemKeysRef = useRef<Set<string>>(new Set())
  const imageIdentityKeysRef = useRef<Set<string>>(new Set())
  const imageIdentityItemKeyMapRef = useRef<Map<string, Set<string>>>(new Map())
  const runtimeCountersRef = useRef<ResourceRuntimeCounters>(createResourceRuntimeCounters())
  const lastDiagnosticsSampleRef = useRef<ResourceRuntimeCounters>(createResourceRuntimeCounters())
  const frameMetricsRef = useRef<ResourceFrameMetrics>(createResourceFrameMetrics())
  const lastDiagnosticsFrameMetricsRef = useRef<ResourceFrameMetrics>(createResourceFrameMetrics())
  const recentMaxFrameMsRef = useRef(0)
  const diagnosticsSamplingRef = useRef(false)
  const diagnosticsEpochRef = useRef(0)
  const lastPreloadStatsRef = useRef<ResourcePreloadStatsSnapshot | null>(null)
  const tabRef = useRef<MediaTab>(tab)
  const itemsRef = useRef<MediaStreamItem[]>([])
  const itemsLengthRef = useRef(0)
  const selectedContactRef = useRef(selectedContact)

  const bumpRuntimeCounter = useCallback((key: keyof ResourceRuntimeCounters, amount = 1) => {
    runtimeCountersRef.current[key] += amount
  }, [])

  const resetResourceDiagnosticsWindow = useCallback(() => {
    diagnosticsEpochRef.current += 1
    lastDiagnosticsSampleRef.current = { ...runtimeCountersRef.current }
    lastDiagnosticsFrameMetricsRef.current = { ...frameMetricsRef.current }
    recentMaxFrameMsRef.current = 0
    void window.electronAPI.diagnostics.clearResourceStats().catch(() => {})
  }, [])

  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  useLayoutEffect(() => {
    itemsRef.current = items
    itemsLengthRef.current = items.length
  }, [items])

  useEffect(() => {
    selectedContactRef.current = selectedContact
  }, [selectedContact])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  useEffect(() => {
    loadingMoreRef.current = loadingMore
  }, [loadingMore])

  useEffect(() => {
    nextOffsetRef.current = nextOffset
  }, [nextOffset])

  useEffect(() => {
    hasMoreRef.current = hasMore
  }, [hasMore])

  useEffect(() => {
    selectedKeysRef.current = selectedKeys
  }, [selectedKeys])

  useEffect(() => {
    let animationFrameId = 0
    let lastFrameAt = performance.now()
    const scheduleNextFrame = () => {
      if (document.visibilityState === 'hidden') return
      animationFrameId = window.requestAnimationFrame(tick)
    }
    const tick = (now: number) => {
      const deltaMs = Math.max(0, now - lastFrameAt)
      lastFrameAt = now
      const roundedDelta = Math.round(deltaMs * 10) / 10
      const metrics = frameMetricsRef.current
      metrics.samples += 1
      metrics.lastFrameMs = roundedDelta
      if (roundedDelta > metrics.maxFrameMs) metrics.maxFrameMs = roundedDelta
      if (roundedDelta > recentMaxFrameMsRef.current) recentMaxFrameMsRef.current = roundedDelta
      if (roundedDelta >= 50) metrics.longFrames += 1
      scheduleNextFrame()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        window.cancelAnimationFrame(animationFrameId)
        animationFrameId = 0
        return
      }
      lastFrameAt = performance.now()
      if (!animationFrameId) scheduleNextFrame()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    scheduleNextFrame()
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [])

  useEffect(() => {
    const sample = async () => {
      if (document.visibilityState === 'hidden') return
      if (diagnosticsSamplingRef.current) return
      diagnosticsSamplingRef.current = true
      const sampleEpoch = diagnosticsEpochRef.current
      try {
        const counters = { ...runtimeCountersRef.current }
        const previous = lastDiagnosticsSampleRef.current
        const delta = Object.fromEntries(
          (Object.keys(counters) as Array<keyof ResourceRuntimeCounters>).map((key) => [
            key,
            counters[key] - previous[key]
          ])
        )
        const frameMetrics = { ...frameMetricsRef.current }
        const previousFrameMetrics = lastDiagnosticsFrameMetricsRef.current
        const frameDelta = {
          samples: frameMetrics.samples - previousFrameMetrics.samples,
          longFrames: frameMetrics.longFrames - previousFrameMetrics.longFrames,
          recentMaxFrameMs: recentMaxFrameMsRef.current,
          lastFrameMs: frameMetrics.lastFrameMs
        }
        const preloadStats = await window.electronAPI.image.getPreloadStats()
        if (sampleEpoch !== diagnosticsEpochRef.current) return
        lastDiagnosticsSampleRef.current = counters
        lastDiagnosticsFrameMetricsRef.current = frameMetrics
        recentMaxFrameMsRef.current = 0
        lastPreloadStatsRef.current = preloadStats
        await window.electronAPI.diagnostics.recordResourceStats({
          page: 'resources',
          tab: tabRef.current,
          selectedContact: selectedContactRef.current,
          scope: preloadScopeRef.current,
          items: itemsLengthRef.current,
          nextOffset: nextOffsetRef.current,
          hasMore: hasMoreRef.current,
          loading: loadingRef.current,
          loadingMore: loadingMoreRef.current,
          counters,
          delta,
          frameMetrics,
          frameDelta,
          preloadStats
        })
      } catch {
        // diagnostics must never affect browsing
      } finally {
        diagnosticsSamplingRef.current = false
      }
    }
    const timer = window.setInterval(() => {
      void sample()
    }, 3000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void sample()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    void sample()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const getMeta = useCallback((item: MediaStreamItem): MediaItemMeta => {
    const cached = itemMetaMapRef.current.get(item)
    if (cached) return cached
    const meta = buildMediaItemMeta(item)
    itemMetaMapRef.current.set(item, meta)
    return meta
  }, [])

  const getScopedDatIdentity = useCallback((sessionId: unknown, createTime: unknown, imageDatName: unknown): string => {
    const datName = normalizeMediaToken(String(imageDatName || ''))
    if (!datName) return ''
    const safeSessionId = String(sessionId || '').trim().toLowerCase()
    const safeCreateTime = Number(createTime || 0) || 0
    return `dat:${safeSessionId}|${safeCreateTime}|${datName}`
  }, [])

  const removeImageIdentityMapping = useCallback((identity: string, itemKey: string) => {
    if (!identity || !itemKey) return
    const current = imageIdentityItemKeyMapRef.current.get(identity)
    if (!current) return
    current.delete(itemKey)
    if (current.size === 0) {
      imageIdentityItemKeyMapRef.current.delete(identity)
      imageIdentityKeysRef.current.delete(identity)
    }
  }, [])

  const addResourceIndexItem = useCallback((item: MediaStreamItem, meta: MediaItemMeta = getMeta(item)) => {
    const { itemKey, imageIdentity } = meta
    if (!itemKey) return
    itemByKeyRef.current[itemKey] = item
    itemMetaByKeyRef.current[itemKey] = meta
    validItemKeysRef.current.add(itemKey)
    if (item.mediaType === 'video') {
      videoItemKeysRef.current.add(itemKey)
      return
    }
    imageItemKeysRef.current.add(itemKey)
    if (imageIdentity) {
      imageIdentityKeysRef.current.add(imageIdentity)
      const identitySet = imageIdentityItemKeyMapRef.current.get(imageIdentity) || new Set<string>()
      identitySet.add(itemKey)
      imageIdentityItemKeyMapRef.current.set(imageIdentity, identitySet)
    }
  }, [getMeta])

  const pruneImageIdentityCooldowns = useCallback(() => {
    const validIdentities = imageIdentityKeysRef.current
    const nextImagePreloadIdentityUntil: Record<string, number> = {}
    for (const [key, value] of Object.entries(imagePreloadIdentityUntilRef.current)) {
      if (!validIdentities.has(key)) continue
      nextImagePreloadIdentityUntil[key] = value
    }
    imagePreloadIdentityUntilRef.current = nextImagePreloadIdentityUntil

    const nextImagePredecryptIdentityUntil: Record<string, number> = {}
    for (const [key, value] of Object.entries(imagePredecryptIdentityUntilRef.current)) {
      if (!validIdentities.has(key)) continue
      nextImagePredecryptIdentityUntil[key] = value
    }
    imagePredecryptIdentityUntilRef.current = nextImagePredecryptIdentityUntil

    const nextImageCacheIdentityMissUntil: Record<string, number> = {}
    for (const [key, value] of Object.entries(imageCacheIdentityMissUntilRef.current)) {
      if (!validIdentities.has(key)) continue
      nextImageCacheIdentityMissUntil[key] = value
    }
    imageCacheIdentityMissUntilRef.current = nextImageCacheIdentityMissUntil
  }, [])

  const removeResourceIndexItem = useCallback((itemKey: string, meta?: MediaItemMeta) => {
    if (!itemKey) return
    loadedItemKeysRef.current.delete(itemKey)
    validItemKeysRef.current.delete(itemKey)
    videoItemKeysRef.current.delete(itemKey)
    imageItemKeysRef.current.delete(itemKey)
    delete itemByKeyRef.current[itemKey]
    delete itemMetaByKeyRef.current[itemKey]
    if (meta) {
      removeImageIdentityMapping(meta.imageIdentity, itemKey)
    } else {
      for (const identity of Array.from(imageIdentityItemKeyMapRef.current.keys())) {
        removeImageIdentityMapping(identity, itemKey)
      }
    }
    delete imageCacheMissUntilRef.current[itemKey]
    if (meta?.imageIdentity && !imageIdentityKeysRef.current.has(meta.imageIdentity)) {
      delete imageCacheIdentityMissUntilRef.current[meta.imageIdentity]
    }
    delete imagePreloadUntilRef.current[itemKey]
    delete imagePredecryptUntilRef.current[itemKey]
    attemptedVideoPosterKeysRef.current.delete(itemKey)
    resolvingVideoPosterKeysRef.current.delete(itemKey)
    pruneImageIdentityCooldowns()
  }, [pruneImageIdentityCooldowns, removeImageIdentityMapping])

  const resetResourceIndexes = useCallback((nextItems: MediaStreamItem[]) => {
    imageIdentityItemKeyMapRef.current = new Map()
    itemByKeyRef.current = {}
    itemMetaByKeyRef.current = {}
    loadedItemKeysRef.current = new Set()
    validItemKeysRef.current = new Set()
    imageItemKeysRef.current = new Set()
    videoItemKeysRef.current = new Set()
    imageIdentityKeysRef.current = new Set()
    for (const item of nextItems) {
      const meta = getMeta(item)
      loadedItemKeysRef.current.add(meta.itemKey)
      addResourceIndexItem(item, meta)
    }
  }, [addResourceIndexItem, getMeta])

  const updateMediaCardState = useCallback((itemKey: string, patch: Partial<MediaCardDynamicState>) => {
    mediaCardStateStoreRef.current.update(itemKey, patch)
  }, [])

  const removeMediaCardState = useCallback((itemKey: string) => {
    mediaCardStateStoreRef.current.remove(itemKey)
  }, [])

  const clearMediaCardStates = useCallback(() => {
    mediaCardStateStoreRef.current.clear()
  }, [])

  const cancelPendingResourceTimers = useCallback(() => {
    previewPatchRef.current = {}
    updatePatchRef.current = {}
    posterPatchRef.current = {}
    aspectPatchRef.current = {}
    previewPathMapRef.current = {}
    previewUpdateMapRef.current = {}
    videoPosterMapRef.current = {}
    imageAspectMapRef.current = {}
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
    if (transientStatePruneTimerRef.current !== null) {
      window.clearTimeout(transientStatePruneTimerRef.current)
      transientStatePruneTimerRef.current = null
    }
    if (predecryptTimerRef.current !== null) {
      window.clearTimeout(predecryptTimerRef.current)
      predecryptTimerRef.current = null
    }
    pendingRangeRef.current = null
    pendingTransientPruneRangeRef.current = null
    pendingPredecryptRangeRef.current = null
  }, [])

  const resetAsyncResourceWork = useCallback((options?: { clearIndexes?: boolean; cancelScope?: boolean }) => {
    cancelPendingResourceTimers()
    initialRangeScheduleKeyRef.current = ''
    imageResolveBatchIdRef.current += 1
    resolvingImageCacheBatchRef.current = false
    pendingImageResolveRangeRef.current = null
    preloadSubmissionEpochRef.current += 1
    imagePreloadUntilRef.current = {}
    imagePredecryptUntilRef.current = {}
    imagePreloadIdentityUntilRef.current = {}
    imagePredecryptIdentityUntilRef.current = {}
    imagePreloadSubmittingIdentityRef.current.clear()
    imagePredecryptSubmittingIdentityRef.current.clear()
    selectedKeysRef.current = new Set()
    decryptingKeysRef.current = new Set()
    lastPreloadStatsRef.current = null
    imageCacheMissUntilRef.current = {}
    imageCacheIdentityMissUntilRef.current = {}
    videoPosterBatchIdRef.current += 1
    resolvingVideoPosterBatchRef.current = false
    pendingVideoPosterRangeRef.current = null
    resolvingVideoPosterKeysRef.current.clear()
    attemptedVideoPosterKeysRef.current.clear()
    resolvingVideoPosterMd5Ref.current.clear()
    attemptedVideoPosterMd5Ref.current.clear()
    videoPosterByMd5Ref.current = {}
    if (options?.clearIndexes) {
      itemsRef.current = []
      itemsLengthRef.current = 0
      lastVisibleRangeRef.current = null
      resetResourceIndexes([])
      clearMediaCardStates()
    }
    if (options?.cancelScope) void window.electronAPI.image.cancelPreloadScope(preloadScopeRef.current)
  }, [cancelPendingResourceTimers, clearMediaCardStates, resetResourceIndexes])

  useEffect(() => () => {
    resetAsyncResourceWork({ cancelScope: true })
  }, [resetAsyncResourceWork])

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

  const isCurrentItemKey = useCallback((itemKey: string): boolean => {
    return Boolean(itemKey && validItemKeysRef.current.has(itemKey))
  }, [])

  const flushPreviewPatch = useCallback(() => {
    const pathPatch: Record<string, string> = {}
    const updatePatch: Record<string, boolean> = {}
    let drained = 0
    let hasRemaining = false
    let hasPathPatch = false
    let hasUpdatePatch = false
    for (const key in previewPatchRef.current) {
      if (drained >= MAX_MEDIA_PATCHES_PER_FLUSH) {
        hasRemaining = true
        break
      }
      const value = previewPatchRef.current[key]
      const hasUpdate = updatePatchRef.current[key]
      delete previewPatchRef.current[key]
      delete updatePatchRef.current[key]
      drained += 1
      if (!isCurrentItemKey(key)) continue
      pathPatch[key] = value
      updatePatch[key] = hasUpdate
      updateMediaCardState(key, {
        previewPath: value,
        hasPreviewUpdate: Boolean(hasUpdate)
      })
      hasPathPatch = true
      hasUpdatePatch = true
    }
    previewPatchTimerRef.current = null
    if (hasPathPatch) {
      previewPathMapRef.current = mergeRecordPatch(previewPathMapRef.current, pathPatch)
    }
    if (hasUpdatePatch) {
      previewUpdateMapRef.current = mergeRecordPatch(previewUpdateMapRef.current, updatePatch)
    }
    if (hasRemaining) {
      previewPatchTimerRef.current = window.setTimeout(flushPreviewPatch, 16)
    }
  }, [isCurrentItemKey, updateMediaCardState])

  const queuePreviewPatch = useCallback((itemKey: string, localPath: string, hasUpdate: boolean) => {
    if (!itemKey || !localPath) return
    if (!isCurrentItemKey(itemKey)) return
    if (previewPatchRef.current[itemKey] === localPath && updatePatchRef.current[itemKey] === hasUpdate) return
    if (previewPathMapRef.current[itemKey] === localPath && previewUpdateMapRef.current[itemKey] === hasUpdate) return
    const meta = itemMetaByKeyRef.current[itemKey]
    delete imageCacheMissUntilRef.current[itemKey]
    if (meta?.imageIdentity) delete imageCacheIdentityMissUntilRef.current[meta.imageIdentity]
    bumpRuntimeCounter('previewPatchesQueued')
    previewPatchRef.current[itemKey] = localPath
    updatePatchRef.current[itemKey] = hasUpdate
    if (previewPatchTimerRef.current !== null) return
    previewPatchTimerRef.current = window.setTimeout(flushPreviewPatch, 16)
  }, [bumpRuntimeCounter, flushPreviewPatch, isCurrentItemKey])

  const flushPosterPatch = useCallback(() => {
    const patch: Record<string, string> = {}
    let drained = 0
    let hasRemaining = false
    let hasPatch = false
    for (const key in posterPatchRef.current) {
      if (drained >= MAX_MEDIA_PATCHES_PER_FLUSH) {
        hasRemaining = true
        break
      }
      const value = posterPatchRef.current[key]
      delete posterPatchRef.current[key]
      drained += 1
      if (!isCurrentItemKey(key)) continue
      patch[key] = value
      updateMediaCardState(key, { videoPosterPath: value })
      hasPatch = true
    }
    posterPatchTimerRef.current = null
    if (hasPatch) {
      videoPosterMapRef.current = mergeRecordPatch(videoPosterMapRef.current, patch)
    }
    if (hasRemaining) {
      posterPatchTimerRef.current = window.setTimeout(flushPosterPatch, 16)
    }
  }, [isCurrentItemKey, updateMediaCardState])

  const queuePosterPatch = useCallback((itemKey: string, posterPath: string) => {
    if (!itemKey || !posterPath) return
    if (!isCurrentItemKey(itemKey)) return
    if (posterPatchRef.current[itemKey] === posterPath) return
    if (videoPosterMapRef.current[itemKey] === posterPath) return
    posterPatchRef.current[itemKey] = posterPath
    if (posterPatchTimerRef.current !== null) return
    posterPatchTimerRef.current = window.setTimeout(flushPosterPatch, 16)
  }, [flushPosterPatch, isCurrentItemKey])

  const flushAspectPatch = useCallback(() => {
    const patch: Record<string, number> = {}
    let drained = 0
    let hasRemaining = false
    let hasPatch = false
    for (const key in aspectPatchRef.current) {
      if (drained >= MAX_MEDIA_PATCHES_PER_FLUSH) {
        hasRemaining = true
        break
      }
      const value = aspectPatchRef.current[key]
      delete aspectPatchRef.current[key]
      drained += 1
      if (!isCurrentItemKey(key)) continue
      patch[key] = value
      updateMediaCardState(key, { imageIsLong: value >= 2.8 })
      hasPatch = true
    }
    aspectPatchTimerRef.current = null
    if (hasPatch) {
      imageAspectMapRef.current = mergeRecordPatch(imageAspectMapRef.current, patch)
    }
    if (hasRemaining) {
      aspectPatchTimerRef.current = window.setTimeout(flushAspectPatch, 24)
    }
  }, [isCurrentItemKey, updateMediaCardState])

  const queueAspectPatch = useCallback((itemKey: string, ratio: number) => {
    if (!isCurrentItemKey(itemKey)) return
    const old = imageAspectMapRef.current[itemKey]
    if (typeof old === 'number' && Math.abs(old - ratio) < 0.01) return
    const pending = aspectPatchRef.current[itemKey]
    if (typeof pending === 'number' && Math.abs(pending - ratio) < 0.01) return
    aspectPatchRef.current[itemKey] = ratio
    if (aspectPatchTimerRef.current !== null) return
    aspectPatchTimerRef.current = window.setTimeout(flushAspectPatch, 24)
  }, [flushAspectPatch, isCurrentItemKey])

  const pruneTransientMediaState = useCallback((range: { start: number; end: number }) => {
    const currentItems = itemsRef.current
    if (currentItems.length === 0) return
    const retainStart = Math.max(0, range.start - 160)
    const retainEnd = Math.min(currentItems.length - 1, range.end + 320)
    if (retainEnd < retainStart) return
    const keepKeys = new Set<string>()
    for (let i = retainStart; i <= retainEnd; i += 1) {
      const item = currentItems[i]
      if (!item) continue
      keepKeys.add(getMeta(item).itemKey)
    }
    bumpRuntimeCounter('transientStatePruneRuns')
    previewPathMapRef.current = pruneRecordToKeys(previewPathMapRef.current, keepKeys)
    previewUpdateMapRef.current = pruneRecordToKeys(previewUpdateMapRef.current, keepKeys)
    videoPosterMapRef.current = pruneRecordToKeys(videoPosterMapRef.current, keepKeys)
    imageAspectMapRef.current = pruneRecordToKeys(imageAspectMapRef.current, keepKeys)
    previewPatchRef.current = pruneRecordToKeys(previewPatchRef.current, keepKeys)
    updatePatchRef.current = pruneRecordToKeys(updatePatchRef.current, keepKeys)
    posterPatchRef.current = pruneRecordToKeys(posterPatchRef.current, keepKeys)
    aspectPatchRef.current = pruneRecordToKeys(aspectPatchRef.current, keepKeys)
    mediaCardStateStoreRef.current.pruneTransient(keepKeys)
  }, [bumpRuntimeCounter, getMeta])

  const flushTransientStatePrune = useCallback(() => {
    transientStatePruneTimerRef.current = null
    const pending = pendingTransientPruneRangeRef.current
    pendingTransientPruneRangeRef.current = null
    if (!pending) return
    pruneTransientMediaState(pending)
  }, [pruneTransientMediaState])

  const scheduleTransientStatePrune = useCallback((range: { start: number; end: number }) => {
    pendingTransientPruneRangeRef.current = range
    if (transientStatePruneTimerRef.current !== null) return
    transientStatePruneTimerRef.current = window.setTimeout(flushTransientStatePrune, 650)
  }, [flushTransientStatePrune])

  useEffect(() => {
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload) => {
      bumpRuntimeCounter('cacheResolvedEvents')
      const localPath = String(payload.localPath || '').trim()
      if (!localPath) return
      const cacheKey = normalizeMediaToken(payload.cacheKey)
      let patchedCount = 0
      const md5Candidates = [
        normalizeMediaToken(payload.imageMd5),
        !payload.imageDatName && /^[a-f0-9]{32}$/i.test(cacheKey) ? cacheKey : ''
      ].filter(Boolean)
      for (const token of md5Candidates) {
        const itemKeys = imageIdentityItemKeyMapRef.current.get(`md5:${token}`)
        if (!itemKeys || itemKeys.size === 0) continue
        for (const itemKey of itemKeys) {
          queuePreviewPatch(itemKey, localPath, isLikelyThumbnailPreview(localPath))
          patchedCount += 1
        }
        bumpRuntimeCounter('cacheResolvedPatchedItems', patchedCount)
        return
      }
      const datCandidates = [
        normalizeMediaToken(payload.imageDatName),
        cacheKey && !/^[a-f0-9]{32}$/i.test(cacheKey) ? cacheKey : ''
      ].filter(Boolean)
      for (const token of datCandidates) {
        const eventIdentity = getScopedDatIdentity(payload.sessionId, payload.createTime, token)
        if (!eventIdentity) continue
        const itemKeys = imageIdentityItemKeyMapRef.current.get(eventIdentity)
        if (!itemKeys || itemKeys.size === 0) continue
        for (const itemKey of itemKeys) {
          queuePreviewPatch(itemKey, localPath, isLikelyThumbnailPreview(localPath))
          patchedCount += 1
        }
        bumpRuntimeCounter('cacheResolvedPatchedItems', patchedCount)
        return
      }
      bumpRuntimeCounter('cacheResolvedUnmatchedEvents')
    })
    return unsubscribe
  }, [bumpRuntimeCounter, getScopedDatIdentity, isLikelyThumbnailPreview, queuePreviewPatch])

  const loadStream = useCallback(async (reset: boolean) => {
    if (!reset) {
      if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) {
        bumpRuntimeCounter('loadMoreSkipped')
        return
      }
      bumpRuntimeCounter('loadMoreRequests')
      loadingMoreRef.current = true
    } else {
      bumpRuntimeCounter('loadResets')
      loadingRef.current = true
      loadingMoreRef.current = false
    }
    const requestId = streamRequestIdRef.current + 1
    streamRequestIdRef.current = requestId
    if (reset) {
      const previousScope = preloadScopeRef.current
      preloadScopeRef.current = `resources-${requestId}-${Date.now()}`
      resetAsyncResourceWork({ clearIndexes: true })
      resetResourceDiagnosticsWindow()
      void window.electronAPI.image.cancelPreloadScope(previousScope)
    }
    if (reset) {
      setLoading(true)
      setLoadingMore(false)
      setItems(clearArray)
      setSelectedKeys(clearSet)
      nextOffsetRef.current = 0
      hasMoreRef.current = false
      setNextOffset(0)
      setHasMore(false)
    } else {
      setLoadingMore(true)
    }
    if (reset) {
      setError('')
      setActionMessage('')
    }

    try {
      if (reset) {
        const connectResult = await window.electronAPI.chat.connect()
        if (requestId !== streamRequestIdRef.current) return
        if (!connectResult.success) {
          setError(connectResult.error || '连接数据库失败')
          return
        }
      }
      const requestOffset = reset ? 0 : nextOffsetRef.current
      const streamLoadStartedAt = performance.now()
      const streamResult = await window.electronAPI.chat.getMediaStream({
        sessionId: selectedContact === 'all' ? undefined : selectedContact,
        mediaType: tab,
        beginTimestamp: getRangeTimestampStart(dateStart),
        endTimestamp: getRangeTimestampEnd(dateEnd),
        offset: requestOffset,
        limit: PAGE_SIZE
      })
      if (requestId !== streamRequestIdRef.current) return
      const streamLoadMs = Math.max(0, Math.round((performance.now() - streamLoadStartedAt) * 10) / 10)
      bumpRuntimeCounter('mediaStreamLoadSamples')
      bumpRuntimeCounter('mediaStreamLoadMsTotal', streamLoadMs)
      if (streamLoadMs > runtimeCountersRef.current.mediaStreamMaxLoadMs) {
        runtimeCountersRef.current.mediaStreamMaxLoadMs = streamLoadMs
      }
      if (streamResult.pageCacheHit || streamResult.streamSource === 'pageCache') {
        bumpRuntimeCounter('mediaStreamPageCacheHits')
      } else if (streamResult.inflightMerged || streamResult.streamSource === 'inflight') {
        bumpRuntimeCounter('mediaStreamInflightMerges')
      } else if (streamResult.success) {
        bumpRuntimeCounter('mediaStreamNativeLoads')
      }

      if (!streamResult.success) {
        setError(streamResult.error || '加载失败')
        return
      }

      const incoming = (streamResult.items || []) as MediaStreamItem[]
      bumpRuntimeCounter('mediaStreamRowsLoaded', incoming.length)
      if (reset) {
        const nextLoadedKeys = new Set<string>()
        const uniqueIncoming: MediaStreamItem[] = []
        for (const item of incoming) {
          const meta = getMeta(item)
          if (nextLoadedKeys.has(meta.itemKey)) continue
          nextLoadedKeys.add(meta.itemKey)
          uniqueIncoming.push(item)
        }
        bumpRuntimeCounter('mediaStreamDuplicateRows', incoming.length - uniqueIncoming.length)
        resetResourceIndexes(uniqueIncoming)
        setItems(uniqueIncoming)
        setSelectedKeys(clearSet)
      } else {
        const uniqueIncoming: MediaStreamItem[] = []
        const loadedKeys = loadedItemKeysRef.current
        for (const item of incoming) {
          const meta = getMeta(item)
          if (loadedKeys.has(meta.itemKey)) continue
          loadedKeys.add(meta.itemKey)
          addResourceIndexItem(item, meta)
          uniqueIncoming.push(item)
        }
        bumpRuntimeCounter('mediaStreamDuplicateRows', incoming.length - uniqueIncoming.length)
        if (uniqueIncoming.length > 0) {
          setItems((prev) => prev.concat(uniqueIncoming))
        }
      }
      const reportedNextOffset = Number(streamResult.nextOffset)
      const nextOffsetValue = Number.isFinite(reportedNextOffset)
        ? Math.max(requestOffset, reportedNextOffset)
        : requestOffset + incoming.length
      let hasMoreValue = Boolean(streamResult.hasMore)
      if (hasMoreValue && nextOffsetValue <= requestOffset) {
        bumpRuntimeCounter('mediaStreamNoProgressStops')
        hasMoreValue = false
      }
      nextOffsetRef.current = nextOffsetValue
      hasMoreRef.current = hasMoreValue
      setNextOffset(nextOffsetValue)
      setHasMore(hasMoreValue)
    } catch (e) {
      if (requestId !== streamRequestIdRef.current) return
      setError(String(e))
    } finally {
      if (requestId === streamRequestIdRef.current) {
        if (reset) loadingRef.current = false
        else loadingMoreRef.current = false
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [addResourceIndexItem, bumpRuntimeCounter, dateEnd, dateStart, getMeta, resetAsyncResourceWork, resetResourceDiagnosticsWindow, resetResourceIndexes, selectedContact, tab])

  useEffect(() => {
    void loadStream(true)
  }, [loadStream])

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

  const resolveImageCacheRange = useCallback((start: number, end: number) => {
    const currentItems = itemsRef.current
    const from = Math.max(0, start)
    const to = Math.min(currentItems.length - 1, end)
    if (to < from) return
    if (resolvingImageCacheBatchRef.current) {
      const previous = pendingImageResolveRangeRef.current
      if (previous && from >= previous.start && to <= previous.end) {
        bumpRuntimeCounter('imageResolveContainedSkips')
        return
      }
      const merged = mergeNearbyRange(pendingImageResolveRangeRef.current, { start: from, end: to }, 24)
      pendingImageResolveRangeRef.current = merged.range
      bumpRuntimeCounter(merged.merged ? 'imageResolvePendingMerges' : 'imageResolvePendingReplacements')
      return
    }
    const now = Date.now()
    const payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }> = []
    const payloadItemKeys: string[][] = []
    const payloadIdentities: string[] = []
    const dedup = new Map<string, number>()
    for (let i = from; i <= to; i += 1) {
      const item = currentItems[i]
      if (!item || item.mediaType !== 'image') continue
      const meta = getMeta(item)
      const { itemKey, imageMd5, imageDatName, imageIdentity } = meta
      if (previewPathMapRef.current[itemKey] || previewPatchRef.current[itemKey]) continue
      if (!meta.hasImageLocator) continue
      if ((imageCacheMissUntilRef.current[itemKey] || 0) > now) continue
      if ((imageCacheIdentityMissUntilRef.current[imageIdentity] || 0) > now) {
        imageCacheMissUntilRef.current[itemKey] = imageCacheIdentityMissUntilRef.current[imageIdentity]
        bumpRuntimeCounter('imageResolveIdentityMissSkipped')
        continue
      }
      const dedupKey = imageIdentity
      const existingIndex = dedup.get(dedupKey)
      if (existingIndex !== undefined) {
        payloadItemKeys[existingIndex].push(itemKey)
        continue
      }
      payloads.push({
        sessionId: item.sessionId,
        imageMd5: imageMd5 || undefined,
        imageDatName: imageDatName || undefined,
        createTime: Number(item.createTime || 0) || undefined
      })
      dedup.set(dedupKey, payloads.length - 1)
      payloadItemKeys.push([itemKey])
      payloadIdentities.push(imageIdentity)
      if (payloads.length >= MAX_IMAGE_CACHE_RESOLVE_PER_TICK) break
    }
    if (payloads.length === 0) return

    resolvingImageCacheBatchRef.current = true
    bumpRuntimeCounter('imageResolveStarted')
    const batchId = imageResolveBatchIdRef.current + 1
    imageResolveBatchIdRef.current = batchId
    void (async () => {
      try {
        const result = await window.electronAPI.image.resolveCacheBatch(payloads, {
          disableUpdateCheck: true,
          allowCacheIndex: true,
          allowCachePromotion: false,
          allowFilesystemScan: false,
          preferFilePath: true,
          hardlinkOnly: true,
          suppressEvents: true
        })
        if (batchId !== imageResolveBatchIdRef.current) {
          bumpRuntimeCounter('imageResolveSuperseded')
          return
        }
        const rows = Array.isArray(result?.rows) ? result.rows : []
        const pathPatch: Record<string, string> = {}
        const updatePatch: Record<string, boolean> = {}
        const missUntil = Date.now() + 4500
        let hasPathPatch = false
        let hasUpdatePatch = false

        for (let i = 0; i < payloadItemKeys.length; i += 1) {
          const row = rows[i]
          const imageIdentity = payloadIdentities[i] || ''
          for (const itemKey of payloadItemKeys[i] || []) {
            if (!isCurrentItemKey(itemKey)) continue
            if (row?.success && row.localPath) {
              delete imageCacheMissUntilRef.current[itemKey]
              if (imageIdentity) delete imageCacheIdentityMissUntilRef.current[imageIdentity]
              pathPatch[itemKey] = row.localPath
              updatePatch[itemKey] = Boolean(row.hasUpdate)
              updateMediaCardState(itemKey, {
                previewPath: row.localPath,
                hasPreviewUpdate: Boolean(row.hasUpdate)
              })
              hasPathPatch = true
              hasUpdatePatch = true
            } else {
              imageCacheMissUntilRef.current[itemKey] = missUntil
              if (imageIdentity) imageCacheIdentityMissUntilRef.current[imageIdentity] = missUntil
              bumpRuntimeCounter('imageResolveMisses')
            }
          }
        }

        if (hasPathPatch) {
          previewPathMapRef.current = mergeRecordPatch(previewPathMapRef.current, pathPatch)
        }
        if (hasUpdatePatch) {
          previewUpdateMapRef.current = mergeRecordPatch(previewUpdateMapRef.current, updatePatch)
        }
      } catch {
        if (batchId !== imageResolveBatchIdRef.current) {
          bumpRuntimeCounter('imageResolveSuperseded')
          return
        }
        const missUntil = Date.now() + 4500
        payloadItemKeys.forEach((itemKeys, index) => {
          const imageIdentity = payloadIdentities[index] || ''
          if (imageIdentity) imageCacheIdentityMissUntilRef.current[imageIdentity] = missUntil
          itemKeys.forEach((itemKey) => {
            if (!isCurrentItemKey(itemKey)) return
            imageCacheMissUntilRef.current[itemKey] = missUntil
            bumpRuntimeCounter('imageResolveMisses')
          })
        })
      } finally {
        if (batchId !== imageResolveBatchIdRef.current) return
        bumpRuntimeCounter('imageResolveCompleted')
        resolvingImageCacheBatchRef.current = false
        const pending = pendingImageResolveRangeRef.current
        pendingImageResolveRangeRef.current = null
        if (pending) {
          resolveImageCacheRange(pending.start, pending.end)
        }
      }
    })()
  }, [bumpRuntimeCounter, getMeta, isCurrentItemKey, updateMediaCardState])

  const collectImagePreloadPayloads = useCallback((
    start: number,
    end: number,
    options: {
      cooldownRef: MutableRefObject<Record<string, number>>
      identityCooldownRef: MutableRefObject<Record<string, number>>
      submittingIdentityRef: MutableRefObject<Set<string>>
      submittingSkipCounter: keyof ResourceRuntimeCounters
      cooldownMs: number
      limit: number
      includeExistingPreview?: boolean
    }
  ): ImagePreloadCandidate[] => {
    const currentItems = itemsRef.current
    const from = Math.max(0, start)
    const to = Math.min(currentItems.length - 1, end)
    if (to < from) return []

    const now = Date.now()
    const candidates: ImagePreloadCandidate[] = []
    const dedup = new Set<string>()
    for (let i = from; i <= to; i += 1) {
      const item = currentItems[i]
      if (!item || item.mediaType !== 'image') continue
      const meta = getMeta(item)
      const { itemKey, imageMd5, imageDatName, imageIdentity } = meta
      const previewPath = previewPatchRef.current[itemKey] || previewPathMapRef.current[itemKey] || ''
      const isExistingPreviewCandidate = Boolean(previewPath && options.includeExistingPreview === true)
      if (previewPath) {
        const previewMayNeedUpgrade =
          options.includeExistingPreview === true &&
          (
            previewUpdateMapRef.current[itemKey] === true ||
            updatePatchRef.current[itemKey] === true ||
            isLikelyThumbnailPreview(previewPath)
          )
        if (!previewMayNeedUpgrade) continue
      }
      if (!meta.hasImageLocator) continue
      if ((options.cooldownRef.current[itemKey] || 0) > now) continue
      const dedupKey = imageIdentity
      if ((options.identityCooldownRef.current[dedupKey] || 0) > now) {
        options.cooldownRef.current[itemKey] = options.identityCooldownRef.current[dedupKey]
        continue
      }
      if (options.submittingIdentityRef.current.has(dedupKey)) {
        bumpRuntimeCounter(options.submittingSkipCounter)
        continue
      }
      if (dedup.has(dedupKey)) continue
      dedup.add(dedupKey)
      candidates.push({
        itemKey,
        imageIdentity,
        previewUpgrade: isExistingPreviewCandidate,
        payload: {
          sessionId: item.sessionId,
          imageMd5: imageMd5 || undefined,
          imageDatName: imageDatName || undefined,
          createTime: Number(item.createTime || 0) || undefined
        }
      })
      if (candidates.length >= options.limit) break
    }
    return candidates
  }, [bumpRuntimeCounter, getMeta, isLikelyThumbnailPreview])

  const commitImagePreloadCooldowns = useCallback((
    candidates: ImagePreloadCandidate[],
    handledIdentities: string[],
    cooldownRef: MutableRefObject<Record<string, number>>,
    identityCooldownRef: MutableRefObject<Record<string, number>>,
    cooldownMs: number
  ) => {
    if (candidates.length === 0 || handledIdentities.length === 0) return
    const handled = new Set(handledIdentities)
    const until = Date.now() + cooldownMs
    for (const candidate of candidates) {
      if (!handled.has(candidate.imageIdentity)) continue
      cooldownRef.current[candidate.itemKey] = until
      identityCooldownRef.current[candidate.imageIdentity] = until
      if (candidate.previewUpgrade) {
        bumpRuntimeCounter('imagePredecryptPreviewUpgrades')
      }
    }
  }, [bumpRuntimeCounter])

  const commitImagePreloadRetryCooldowns = useCallback((
    candidates: ImagePreloadCandidate[],
    rejectedIdentities: string[],
    cooldownRef: MutableRefObject<Record<string, number>>,
    identityCooldownRef: MutableRefObject<Record<string, number>>,
    cooldownMs: number
  ) => {
    if (candidates.length === 0 || rejectedIdentities.length === 0) return
    const rejected = new Set(rejectedIdentities)
    const until = Date.now() + cooldownMs
    for (const candidate of candidates) {
      if (!rejected.has(candidate.imageIdentity)) continue
      cooldownRef.current[candidate.itemKey] = until
      identityCooldownRef.current[candidate.imageIdentity] = until
    }
  }, [])

  const markImagePreloadSubmitting = useCallback((
    candidates: ImagePreloadCandidate[],
    submittingIdentityRef: MutableRefObject<Set<string>>
  ) => {
    candidates.forEach((candidate) => {
      submittingIdentityRef.current.add(candidate.imageIdentity)
    })
  }, [])

  const clearImagePreloadSubmitting = useCallback((
    candidates: ImagePreloadCandidate[],
    submittingIdentityRef: MutableRefObject<Set<string>>
  ) => {
    candidates.forEach((candidate) => {
      submittingIdentityRef.current.delete(candidate.imageIdentity)
    })
  }, [])

  const preloadImageCacheRange = useCallback((start: number, end: number) => {
    const candidates = collectImagePreloadPayloads(start, end, {
      cooldownRef: imagePreloadUntilRef,
      identityCooldownRef: imagePreloadIdentityUntilRef,
      submittingIdentityRef: imagePreloadSubmittingIdentityRef,
      submittingSkipCounter: 'imagePreloadSubmittingSkips',
      cooldownMs: 12000,
      limit: MAX_IMAGE_CACHE_PRELOAD_PER_TICK
    })
    const payloads = candidates.map((candidate) => candidate.payload)
    if (payloads.length === 0) return
    markImagePreloadSubmitting(candidates, imagePreloadSubmittingIdentityRef)
    const submissionEpoch = preloadSubmissionEpochRef.current
    bumpRuntimeCounter('imagePreloadRequests', payloads.length)
    void window.electronAPI.image.preload(payloads, {
      allowDecrypt: false,
      allowCacheIndex: true,
      allowFilesystemScan: false,
      emitResolved: true,
      scope: preloadScopeRef.current,
      priority: 'high'
    }).then((result) => {
      if (submissionEpoch !== preloadSubmissionEpochRef.current) return
      const rejectedIdentities = Array.isArray(result?.rejectedIdentities) ? result.rejectedIdentities : []
      if (rejectedIdentities.length > 0) {
        bumpRuntimeCounter('imagePreloadRejectedCapacity', rejectedIdentities.length)
        commitImagePreloadRetryCooldowns(
          candidates,
          rejectedIdentities,
          imagePreloadUntilRef,
          imagePreloadIdentityUntilRef,
          1600
        )
      }
      commitImagePreloadCooldowns(
        candidates,
        Array.isArray(result?.handledIdentities) ? result.handledIdentities : [],
        imagePreloadUntilRef,
        imagePreloadIdentityUntilRef,
        12000
      )
    }).catch(() => { }).finally(() => {
      if (submissionEpoch !== preloadSubmissionEpochRef.current) return
      clearImagePreloadSubmitting(candidates, imagePreloadSubmittingIdentityRef)
    })
  }, [bumpRuntimeCounter, clearImagePreloadSubmitting, collectImagePreloadPayloads, commitImagePreloadCooldowns, commitImagePreloadRetryCooldowns, markImagePreloadSubmitting])

  const shouldSkipPredecryptForBackpressure = useCallback((): boolean => {
    const stats = lastPreloadStatsRef.current
    if (!stats) return false
    const queuedDecrypt = Number(stats.queuedDecrypt || 0)
    const queuedLow = Number(stats.queuedLow || 0)
    const activeDecrypt = Number(stats.activeDecrypt || 0)
    const highWaterQueuedDecrypt = Number(stats.highWater?.queuedDecrypt || 0)
    const highWaterQueuedLow = Number(stats.highWater?.queuedLow || 0)
    return (
      queuedDecrypt >= 48 ||
      queuedLow >= 96 ||
      highWaterQueuedDecrypt >= 96 ||
      highWaterQueuedLow >= 160 ||
      (activeDecrypt >= 2 && queuedDecrypt >= 24)
    )
  }, [])

  const predecryptImageRange = useCallback((start: number, end: number) => {
    if (document.visibilityState === 'hidden') {
      bumpRuntimeCounter('predecryptHiddenSkips')
      return
    }
    if (shouldSkipPredecryptForBackpressure()) {
      bumpRuntimeCounter('imagePredecryptBackpressureSkips')
      return
    }
    const candidates = collectImagePreloadPayloads(start, end, {
      cooldownRef: imagePredecryptUntilRef,
      identityCooldownRef: imagePredecryptIdentityUntilRef,
      submittingIdentityRef: imagePredecryptSubmittingIdentityRef,
      submittingSkipCounter: 'imagePredecryptSubmittingSkips',
      cooldownMs: 30000,
      limit: MAX_IMAGE_PREDECRYPT_PER_TICK,
      includeExistingPreview: true
    })
    const payloads = candidates.map((candidate) => candidate.payload)
    if (payloads.length === 0) return
    markImagePreloadSubmitting(candidates, imagePredecryptSubmittingIdentityRef)
    const submissionEpoch = preloadSubmissionEpochRef.current
    bumpRuntimeCounter('imagePredecryptRequests', payloads.length)
    void window.electronAPI.image.preload(payloads, {
      allowDecrypt: true,
      allowCacheIndex: true,
      allowFilesystemScan: true,
      emitResolved: true,
      scope: preloadScopeRef.current,
      priority: 'low'
    }).then((result) => {
      if (submissionEpoch !== preloadSubmissionEpochRef.current) return
      const rejectedIdentities = Array.isArray(result?.rejectedIdentities) ? result.rejectedIdentities : []
      const deferredIdentities = Array.isArray(result?.deferredIdentities) ? result.deferredIdentities : []
      if (rejectedIdentities.length > 0) {
        bumpRuntimeCounter('imagePredecryptRejectedCapacity', rejectedIdentities.length)
        commitImagePreloadRetryCooldowns(
          candidates,
          rejectedIdentities,
          imagePredecryptUntilRef,
          imagePredecryptIdentityUntilRef,
          3000
        )
      }
      if (deferredIdentities.length > 0) {
        bumpRuntimeCounter('imagePredecryptDeferred', deferredIdentities.length)
        commitImagePreloadRetryCooldowns(
          candidates,
          deferredIdentities,
          imagePredecryptUntilRef,
          imagePredecryptIdentityUntilRef,
          3600
        )
      }
      commitImagePreloadCooldowns(
        candidates,
        Array.isArray(result?.acceptedIdentities) ? result.acceptedIdentities : [],
        imagePredecryptUntilRef,
        imagePredecryptIdentityUntilRef,
        12000
      )
      commitImagePreloadCooldowns(
        candidates,
        [
          ...(Array.isArray(result?.mergedQueuedIdentities) ? result.mergedQueuedIdentities : []),
          ...(Array.isArray(result?.skippedActiveIdentities) ? result.skippedActiveIdentities : []),
          ...(Array.isArray(result?.skippedPendingIdentities) ? result.skippedPendingIdentities : [])
        ],
        imagePredecryptUntilRef,
        imagePredecryptIdentityUntilRef,
        30000
      )
    }).catch(() => { }).finally(() => {
      if (submissionEpoch !== preloadSubmissionEpochRef.current) return
      clearImagePreloadSubmitting(candidates, imagePredecryptSubmittingIdentityRef)
    })
  }, [bumpRuntimeCounter, clearImagePreloadSubmitting, collectImagePreloadPayloads, commitImagePreloadCooldowns, commitImagePreloadRetryCooldowns, markImagePreloadSubmitting, shouldSkipPredecryptForBackpressure])

  const flushPredecryptRange = useCallback(() => {
    predecryptTimerRef.current = null
    const pending = pendingPredecryptRangeRef.current
    pendingPredecryptRangeRef.current = null
    if (!pending) return
    if (document.visibilityState === 'hidden') {
      bumpRuntimeCounter('predecryptHiddenSkips')
      return
    }
    const idleForMs = Date.now() - lastRangeActivityAtRef.current
    if (lastRangeActivityAtRef.current > 0 && idleForMs < IMAGE_PREDECRYPT_IDLE_DELAY_MS) {
      pendingPredecryptRangeRef.current = pending
      predecryptTimerRef.current = window.setTimeout(
        flushPredecryptRange,
        Math.max(80, IMAGE_PREDECRYPT_IDLE_DELAY_MS - idleForMs)
      )
      return
    }
    bumpRuntimeCounter('predecryptFlushes')
    predecryptImageRange(pending.start, pending.end)
  }, [bumpRuntimeCounter, predecryptImageRange])

  const schedulePredecryptRange = useCallback((start: number, end: number) => {
    bumpRuntimeCounter('predecryptSchedules')
    if (document.visibilityState === 'hidden') {
      bumpRuntimeCounter('predecryptHiddenSkips')
      return
    }
    const nextRange = {
      start: Math.max(0, start),
      end: Math.max(Math.max(0, start), end)
    }
    const previous = pendingPredecryptRangeRef.current
    if (previous && nextRange.start >= previous.start && nextRange.end <= previous.end) {
      bumpRuntimeCounter('predecryptContainedSkips')
      if (predecryptTimerRef.current !== null) {
        window.clearTimeout(predecryptTimerRef.current)
        predecryptTimerRef.current = window.setTimeout(flushPredecryptRange, IMAGE_PREDECRYPT_TIMER_MS)
      }
      return
    }
    if (previous) {
      bumpRuntimeCounter('predecryptPendingUpdates')
      bumpRuntimeCounter('predecryptPendingReplacements')
    }
    pendingPredecryptRangeRef.current = nextRange
    if (predecryptTimerRef.current !== null) {
      window.clearTimeout(predecryptTimerRef.current)
    }
    predecryptTimerRef.current = window.setTimeout(flushPredecryptRange, IMAGE_PREDECRYPT_TIMER_MS)
  }, [bumpRuntimeCounter, flushPredecryptRange])

  const resolveItemVideoMd5 = useCallback((item: MediaStreamItem): string => {
    return getMeta(item).videoMd5
  }, [getMeta])

  const showMediaInfo = useCallback(async (item: MediaStreamItem) => {
    const meta = getMeta(item)
    const itemKey = meta.itemKey
    const mediaLabel = item.mediaType === 'image' ? '图片' : '视频'
    const baseRows: Array<{ label: string; value: string }> = [
      { label: '资源类型', value: mediaLabel },
      { label: '会话 ID', value: formatInfoValue(item.sessionId) },
      { label: '消息 LocalId', value: formatInfoValue(item.localId) },
      { label: '消息时间', value: formatTimeLabel(item.createTime) },
      { label: '发送方', value: formatInfoValue(item.senderUsername) },
      { label: '是否我发送', value: item.isSend === 1 ? '是' : (item.isSend === 0 ? '否' : '-') }
    ]

    setDialog({
      mode: 'info',
      title: `${mediaLabel}信息`,
      infoRows: [...baseRows, { label: '状态', value: '正在读取缓存信息...' }],
      confirmText: '关闭',
      onConfirm: null
    })

    try {
      if (item.mediaType === 'image') {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: item.sessionId,
          imageMd5: normalizeMediaToken(item.imageMd5) || undefined,
          imageDatName: getSafeImageDatName(item) || undefined,
          createTime: Number(item.createTime || 0) || undefined,
          preferFilePath: true,
          hardlinkOnly: true,
          allowCacheIndex: true,
          suppressEvents: true
        })
        const previewPath = previewPathMapRef.current[itemKey] || previewPatchRef.current[itemKey] || ''
        const cachePath = String(resolved?.localPath || previewPath || '').trim()
        const rows: Array<{ label: string; value: string }> = [
          ...baseRows,
          { label: 'imageMd5', value: formatInfoValue(normalizeMediaToken(item.imageMd5)) },
          { label: 'imageDatName', value: formatInfoValue(getSafeImageDatName(item)) },
          { label: '列表预览路径', value: formatInfoValue(previewPath) },
          { label: '缓存命中', value: resolved?.success && cachePath ? '是' : '否' },
          { label: '缓存路径', value: formatInfoValue(cachePath) },
          { label: '缓存可更新', value: resolved?.hasUpdate ? '是' : '否' },
          { label: '缓存状态', value: resolved?.success ? '可用' : formatInfoValue(resolved?.error || resolved?.failureKind || '未命中') }
        ]
        setDialog({
          mode: 'info',
          title: '图片信息',
          infoRows: rows,
          confirmText: '关闭',
          onConfirm: null
        })
        return
      }

      const resolvedMd5 = await resolveItemVideoMd5(item)
      const videoInfo = resolvedMd5
        ? await window.electronAPI.video.getVideoInfo(resolvedMd5, { includePoster: true, posterFormat: 'fileUrl' })
        : null
      const posterPath = videoPosterMapRef.current[itemKey] || posterPatchRef.current[itemKey] || ''
      const rows: Array<{ label: string; value: string }> = [
        ...baseRows,
        { label: 'videoMd5(消息)', value: formatInfoValue(normalizeMediaToken(item.videoMd5)) },
        { label: 'videoMd5(解析)', value: formatInfoValue(resolvedMd5) },
        { label: '视频文件存在', value: videoInfo?.success && videoInfo.exists ? '是' : '否' },
        { label: '视频路径', value: formatInfoValue(videoInfo?.videoUrl) },
        { label: '同名封面路径', value: formatInfoValue(videoInfo?.coverUrl) },
        { label: '列表封面路径', value: formatInfoValue(posterPath) },
        { label: '视频状态', value: videoInfo?.success ? '可用' : formatInfoValue(videoInfo?.error || '未找到') }
      ]
      setDialog({
        mode: 'info',
        title: '视频信息',
        infoRows: rows,
        confirmText: '关闭',
        onConfirm: null
      })
    } catch (e) {
      setDialog({
        mode: 'info',
        title: `${mediaLabel}信息`,
        infoRows: [...baseRows, { label: '读取失败', value: formatInfoValue(String(e)) }],
        confirmText: '关闭',
        onConfirm: null
      })
    }
  }, [getMeta, resolveItemVideoMd5])

  const resolvePosterRange = useCallback((start: number, end: number) => {
    const currentItems = itemsRef.current
    const from = Math.max(0, start)
    const to = Math.min(currentItems.length - 1, end)
    if (to < from) return
    if (resolvingVideoPosterBatchRef.current) {
      const previous = pendingVideoPosterRangeRef.current
      if (previous && from >= previous.start && to <= previous.end) {
        bumpRuntimeCounter('videoPosterContainedSkips')
        return
      }
      const merged = mergeNearbyRange(pendingVideoPosterRangeRef.current, { start: from, end: to }, 18)
      pendingVideoPosterRangeRef.current = merged.range
      bumpRuntimeCounter(merged.merged ? 'videoPosterPendingMerges' : 'videoPosterPendingReplacements')
      return
    }

    const md5List: string[] = []
    const md5ItemKeys: string[][] = []
    const md5IndexMap = new Map<string, number>()
    for (let i = from; i <= to; i += 1) {
      const item = currentItems[i]
      if (!item || item.mediaType !== 'video') continue
      const itemKey = getMeta(item).itemKey
      if (videoPosterMapRef.current[itemKey] || posterPatchRef.current[itemKey]) continue
      if (attemptedVideoPosterKeysRef.current.has(itemKey)) continue
      if (resolvingVideoPosterKeysRef.current.has(itemKey)) continue
      const md5 = resolveItemVideoMd5(item)
      if (!md5) {
        attemptedVideoPosterKeysRef.current.add(itemKey)
        continue
      }
      const cachedPoster = videoPosterByMd5Ref.current[md5]
      if (cachedPoster) {
        bumpRuntimeCounter('videoPosterMd5CacheHits')
        queuePosterPatch(itemKey, cachedPoster)
        attemptedVideoPosterKeysRef.current.add(itemKey)
        continue
      }
      if (attemptedVideoPosterMd5Ref.current.has(md5)) {
        bumpRuntimeCounter('videoPosterMd5MissSkips')
        attemptedVideoPosterKeysRef.current.add(itemKey)
        continue
      }
      const existingIndex = md5IndexMap.get(md5)
      if (existingIndex !== undefined) {
        resolvingVideoPosterKeysRef.current.add(itemKey)
        md5ItemKeys[existingIndex].push(itemKey)
        continue
      }
      if (resolvingVideoPosterMd5Ref.current.has(md5)) continue
      resolvingVideoPosterKeysRef.current.add(itemKey)
      md5IndexMap.set(md5, md5List.length)
      resolvingVideoPosterMd5Ref.current.add(md5)
      md5ItemKeys.push([itemKey])
      md5List.push(md5)
      if (md5List.length >= MAX_VIDEO_POSTER_RESOLVE_PER_TICK) break
    }
    if (md5List.length === 0) return

    resolvingVideoPosterBatchRef.current = true
    bumpRuntimeCounter('videoPosterBatches')
    const batchId = videoPosterBatchIdRef.current + 1
    videoPosterBatchIdRef.current = batchId
    void (async () => {
      try {
        const result = await window.electronAPI.video.getVideoInfoBatch(md5List, {
          includePoster: true,
          posterFormat: 'fileUrl'
        })
        if (batchId !== videoPosterBatchIdRef.current) return
        const rows = Array.isArray(result?.rows) ? result.rows : []
        const rowsByIndex = new Map(rows.map((row) => [Number(row.index), row]))
        for (let i = 0; i < md5ItemKeys.length; i += 1) {
          const row = rowsByIndex.get(i)
          const md5 = md5List[i] || ''
          for (const itemKey of md5ItemKeys[i] || []) {
            if (row?.success && row.exists && row.coverUrl) {
              const coverUrl = String(row.coverUrl)
              if (md5) videoPosterByMd5Ref.current[md5] = coverUrl
              queuePosterPatch(itemKey, coverUrl)
            }
            attemptedVideoPosterKeysRef.current.add(itemKey)
          }
          if (md5) attemptedVideoPosterMd5Ref.current.add(md5)
        }
      } catch {
        if (batchId !== videoPosterBatchIdRef.current) return
        md5ItemKeys.forEach((itemKeys, index) => {
          const md5 = md5List[index] || ''
          if (md5) attemptedVideoPosterMd5Ref.current.add(md5)
          itemKeys.forEach((itemKey) => {
            attemptedVideoPosterKeysRef.current.add(itemKey)
          })
        })
      } finally {
        if (batchId !== videoPosterBatchIdRef.current) return
        md5ItemKeys.forEach((itemKeys, index) => {
          const md5 = md5List[index] || ''
          if (md5) resolvingVideoPosterMd5Ref.current.delete(md5)
          itemKeys.forEach((itemKey) => {
            resolvingVideoPosterKeysRef.current.delete(itemKey)
          })
        })
        resolvingVideoPosterBatchRef.current = false
        const pending = pendingVideoPosterRangeRef.current
        pendingVideoPosterRangeRef.current = null
        if (pending) resolvePosterRange(pending.start, pending.end)
      }
    })()
  }, [bumpRuntimeCounter, getMeta, queuePosterPatch, resolveItemVideoMd5])

  const flushRangeResolve = useCallback(() => {
    rangeTimerRef.current = null
    const pending = pendingRangeRef.current
    if (!pending) return
    if (document.visibilityState === 'hidden') {
      bumpRuntimeCounter('rangeHiddenSkips')
      return
    }
    pendingRangeRef.current = null
    bumpRuntimeCounter('rangeFlushes')
    if (tab === 'image') {
      preloadImageCacheRange(pending.start - 4, pending.end + 20)
      resolveImageCacheRange(pending.start - 1, pending.end + 6)
      schedulePredecryptRange(pending.start - 1, pending.end + IMAGE_PREDECRYPT_LOOKAHEAD)
      return
    }
    resolvePosterRange(pending.start, pending.end)
  }, [bumpRuntimeCounter, preloadImageCacheRange, resolveImageCacheRange, resolvePosterRange, schedulePredecryptRange, tab])

  const scheduleRangeResolve = useCallback((start: number, end: number) => {
    bumpRuntimeCounter('rangeSchedules')
    const armRangeTimer = () => {
      if (rangeTimerRef.current !== null) return
      if (document.visibilityState === 'hidden') return
      rangeTimerRef.current = window.setTimeout(flushRangeResolve, 120)
    }
    const previous = pendingRangeRef.current
    if (previous && start >= previous.start && end <= previous.end) {
      bumpRuntimeCounter('rangeContainedSkips')
      armRangeTimer()
      return
    }
    if (previous) {
      const merged = mergeNearbyRange(previous, { start, end }, 18)
      pendingRangeRef.current = merged.range
      bumpRuntimeCounter(merged.merged ? 'rangePendingMerges' : 'rangePendingReplacements')
    } else {
      pendingRangeRef.current = { start, end }
    }
    armRangeTimer()
  }, [bumpRuntimeCounter, flushRangeResolve])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (itemsLengthRef.current <= 0) return
      const range = lastVisibleRangeRef.current || {
        start: 0,
        end: Math.min(itemsLengthRef.current - 1, INITIAL_IMAGE_RESOLVE_END)
      }
      bumpRuntimeCounter('rangeVisibilityReschedules')
      scheduleRangeResolve(range.start, range.end)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [bumpRuntimeCounter, scheduleRangeResolve])

  useEffect(() => {
    if (items.length === 0) return
    if (document.visibilityState === 'hidden') {
      bumpRuntimeCounter('rangeHiddenSkips')
      return
    }
    const scheduleKey = `${preloadScopeRef.current}|${tab}`
    if (initialRangeScheduleKeyRef.current === scheduleKey) return
    initialRangeScheduleKeyRef.current = scheduleKey
    if (tab === 'image') {
      preloadImageCacheRange(0, Math.min(items.length - 1, INITIAL_IMAGE_PRELOAD_END))
      resolveImageCacheRange(0, Math.min(items.length - 1, INITIAL_IMAGE_RESOLVE_END))
      schedulePredecryptRange(0, Math.min(items.length - 1, INITIAL_IMAGE_PREDECRYPT_END))
      return
    }
    resolvePosterRange(0, Math.min(items.length - 1, 12))
  }, [bumpRuntimeCounter, items, preloadImageCacheRange, resolveImageCacheRange, resolvePosterRange, schedulePredecryptRange, tab])

  const selectedItems = useMemo(() => {
    if (selectedKeys.size === 0) return []
    const selected: MediaStreamItem[] = []
    for (const key of selectedKeys) {
      const item = itemByKeyRef.current[key]
      if (item) selected.push(item)
    }
    return selected
  }, [selectedKeys])

  const toggleSelect = useCallback((item: MediaStreamItem) => {
    const key = getMeta(item).itemKey
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      selectedKeysRef.current = next
      updateMediaCardState(key, { selected: next.has(key) })
      return next
    })
  }, [getMeta, updateMediaCardState])

  const onImageLoaded = useCallback((item: MediaStreamItem, width: number, height: number) => {
    if (item.mediaType !== 'image') return
    if (!width || !height) return
    const ratio = height / width
    if (!Number.isFinite(ratio) || ratio <= 0) return
    const itemKey = getMeta(item).itemKey
    queueAspectPatch(itemKey, ratio)
  }, [getMeta, queueAspectPatch])

  const deleteOne = useCallback((item: MediaStreamItem) => {
    showConfirm('确认删除该原始记录？此操作不可恢复。', () => {
      void (async () => {
        const result = await window.electronAPI.chat.deleteMessage(item.sessionId, item.localId, item.createTime)
        if (!result.success) {
          showAlert(`删除失败：${result.error || '未知错误'}`, '删除失败')
          return
        }

        const key = getMeta(item).itemKey
        removeResourceIndexItem(key, getMeta(item))
        removeMediaCardState(key)
        const deletedKeys = new Set([key])
        setItems((prev) => removeItemsByKeys(prev, deletedKeys, getMeta))
        setSelectedKeys((prev) => {
          const next = removeSetValue(prev, key)
          if (next !== prev) selectedKeysRef.current = next
          return next
        })
        previewPathMapRef.current = removeRecordKeys(previewPathMapRef.current, deletedKeys)
        previewUpdateMapRef.current = removeRecordKeys(previewUpdateMapRef.current, deletedKeys)
        videoPosterMapRef.current = removeRecordKeys(videoPosterMapRef.current, deletedKeys)
        imageAspectMapRef.current = removeRecordKeys(imageAspectMapRef.current, deletedKeys)
        setActionMessage('删除成功')
      })()
    }, '删除确认')
  }, [getMeta, removeMediaCardState, removeResourceIndexItem, showAlert, showConfirm])

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
              deletedKeys.add(getMeta(item).itemKey)
            }
          }

          if (deletedKeys.size > 0) {
            setItems((prev) => removeItemsByKeys(prev, deletedKeys, getMeta))
            selectedItems.forEach((item) => {
              const meta = getMeta(item)
              if (deletedKeys.has(meta.itemKey)) {
                removeResourceIndexItem(meta.itemKey, meta)
                removeMediaCardState(meta.itemKey)
              }
            })
          }
          setSelectedKeys(clearSet)
          selectedKeysRef.current = new Set()
          selectedItems.forEach((item) => {
            updateMediaCardState(getMeta(item).itemKey, { selected: false })
          })
          previewPathMapRef.current = removeRecordKeys(previewPathMapRef.current, deletedKeys)
          previewUpdateMapRef.current = removeRecordKeys(previewUpdateMapRef.current, deletedKeys)
          videoPosterMapRef.current = removeRecordKeys(videoPosterMapRef.current, deletedKeys)
          imageAspectMapRef.current = removeRecordKeys(imageAspectMapRef.current, deletedKeys)
          setActionMessage(`批量删除完成：成功 ${success}，失败 ${selectedItems.length - success}`)
          showAlert(`批量删除完成：成功 ${success}，失败 ${selectedItems.length - success}`, '批量删除完成')
        } finally {
          setBatchBusy(false)
        }
      })()
    }, '批量删除确认')
  }, [batchBusy, getMeta, removeMediaCardState, removeResourceIndexItem, selectedItems, showAlert, showConfirm, updateMediaCardState])

  const decryptImage = useCallback(async (
    item: MediaStreamItem,
    options?: { allowCacheIndex?: boolean }
  ): Promise<string | undefined> => {
    if (item.mediaType !== 'image') return

    const key = getMeta(item).itemKey
    if (!hasImageLocator(item)) {
      showAlert('当前图片缺少解密所需字段（imageMd5/imageDatName）', '无法解密')
      return
    }

    const nextDecryptingKeys = addSetValue(decryptingKeysRef.current, key)
    if (nextDecryptingKeys !== decryptingKeysRef.current) {
      decryptingKeysRef.current = nextDecryptingKeys
      updateMediaCardState(key, { decrypting: true })
    }

    try {
      const result = await window.electronAPI.image.decrypt({
        sessionId: item.sessionId,
        imageMd5: normalizeMediaToken(item.imageMd5) || undefined,
        imageDatName: getSafeImageDatName(item) || undefined,
        createTime: Number(item.createTime || 0) || undefined,
        force: true,
        preferFilePath: true,
        hardlinkOnly: true,
        allowCacheIndex: options?.allowCacheIndex ?? true,
        suppressEvents: true
      })
      if (!result?.success) {
        if (!isCurrentItemKey(key)) return undefined
        if (result?.failureKind === 'decrypt_failed') {
          showAlert(`解密失败：${result?.error || '解密后不是有效图片'}`, '解密失败')
        } else {
          showAlert(`本地无数据：${result?.error || '未找到原始 DAT 文件'}`, '未找到本地数据')
        }
        return undefined
      }

      if (result.localPath) {
        const localPath = result.localPath as string
        if (isCurrentItemKey(key)) {
          queuePreviewPatch(key, localPath, isLikelyThumbnailPreview(localPath))
          setActionMessage('图片解密完成')
        }
        return localPath
      }
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: item.sessionId,
          imageMd5: normalizeMediaToken(item.imageMd5) || undefined,
          imageDatName: getSafeImageDatName(item) || undefined,
          createTime: Number(item.createTime || 0) || undefined,
          preferFilePath: true,
          hardlinkOnly: true,
          allowCacheIndex: true,
          suppressEvents: true
        })
        if (resolved?.success && resolved.localPath) {
          const localPath = resolved.localPath
          if (isCurrentItemKey(key)) {
            queuePreviewPatch(key, localPath, Boolean(resolved.hasUpdate))
            setActionMessage('图片解密完成')
          }
          return localPath
        }
      } catch {
        // ignore
      }
      if (isCurrentItemKey(key)) setActionMessage('图片解密完成')
      return undefined
    } catch (e) {
      if (!isCurrentItemKey(key)) return undefined
      showAlert(`本地无数据：${String(e)}`, '未找到本地数据')
      return undefined
    } finally {
      const nextDecryptingKeys = removeSetValue(decryptingKeysRef.current, key)
      if (nextDecryptingKeys !== decryptingKeysRef.current) {
        decryptingKeysRef.current = nextDecryptingKeys
        updateMediaCardState(key, { decrypting: false })
      }
    }
  }, [getMeta, isCurrentItemKey, isLikelyThumbnailPreview, queuePreviewPatch, showAlert, updateMediaCardState])

  const onImagePreviewAction = useCallback(async (item: MediaStreamItem) => {
    if (item.mediaType !== 'image') return
    const key = getMeta(item).itemKey
    let localPath = previewPathMapRef.current[key] || previewPatchRef.current[key] || ''
    const hadRenderedPreviewAtClick = Boolean(localPath)
    if (!isCurrentItemKey(key)) return

    if (hadRenderedPreviewAtClick) {
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: item.sessionId,
          imageMd5: normalizeMediaToken(item.imageMd5) || undefined,
          imageDatName: getSafeImageDatName(item) || undefined,
          createTime: Number(item.createTime || 0) || undefined,
          preferFilePath: true,
          hardlinkOnly: true,
          allowCacheIndex: true,
          suppressEvents: true
        })
        if (resolved?.success && resolved.localPath) {
          localPath = resolved.localPath
          queuePreviewPatch(key, localPath, Boolean(resolved.hasUpdate))
        }
      } catch {
        // ignore
      }
      if (localPath && isCurrentItemKey(key)) {
        await window.electronAPI.window.openImageViewerWindow(localPath)
        return
      }
    }

    if (!hadRenderedPreviewAtClick) {
      await decryptImage(item)
      return
    }

    try {
      const resolved = await window.electronAPI.image.resolveCache({
        sessionId: item.sessionId,
        imageMd5: normalizeMediaToken(item.imageMd5) || undefined,
        imageDatName: getSafeImageDatName(item) || undefined,
        createTime: Number(item.createTime || 0) || undefined,
        preferFilePath: true,
        hardlinkOnly: true,
        allowCacheIndex: true,
        suppressEvents: true
      })
      if (resolved?.success && resolved.localPath) {
        localPath = resolved.localPath
        queuePreviewPatch(key, localPath, Boolean(resolved.hasUpdate))
        return
      }
    } catch {
      // ignore
    }

    await decryptImage(item)
  }, [decryptImage, getMeta, isCurrentItemKey, queuePreviewPatch])

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
    let notFound = 0
    let decryptFailed = 0
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
      const hardlinkMd5Set = new Set<string>()
      for (const item of imageItems) {
        if (!hasImageLocator(item)) continue
        const imageMd5 = normalizeMediaToken(item.imageMd5)
        if (imageMd5) {
          hardlinkMd5Set.add(imageMd5)
          continue
        }
        const imageDatName = getSafeImageDatName(item)
        if (/^[a-f0-9]{32}$/i.test(imageDatName)) {
          hardlinkMd5Set.add(imageDatName)
        }
      }
      if (hardlinkMd5Set.size > 0) {
        try {
          await window.electronAPI.image.preloadHardlinkMd5s(Array.from(hardlinkMd5Set), {
            chunkSize: BATCH_IMAGE_HARDLINK_PRELOAD_CHUNK_SIZE,
            yieldMs: BATCH_IMAGE_HARDLINK_PRELOAD_YIELD_MS,
            filesystemFallback: false
          })
        } catch {
          // ignore preload failures and continue decrypt
        }
      }

      const concurrency = Math.max(1, Math.min(BATCH_IMAGE_DECRYPT_CONCURRENCY, imageItems.length))
      let cursor = 0
      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= imageItems.length) return
          const item = imageItems[index]
          try {
            if (!hasImageLocator(item)) {
              notFound += 1
              continue
            }
            const result = await window.electronAPI.image.decrypt({
              sessionId: item.sessionId,
              imageMd5: normalizeMediaToken(item.imageMd5) || undefined,
              imageDatName: getSafeImageDatName(item) || undefined,
              createTime: Number(item.createTime || 0) || undefined,
              force: true,
              preferFilePath: true,
              hardlinkOnly: true,
              allowCacheIndex: true,
              suppressEvents: true
            })
            if (!result?.success) {
              if (result?.failureKind === 'decrypt_failed') decryptFailed += 1
              else notFound += 1
            } else {
              success += 1
              if (result.localPath) {
                const key = getMeta(item).itemKey
                if (!isCurrentItemKey(key)) continue
                previewPatch[key] = result.localPath
                updatePatch[key] = isLikelyThumbnailPreview(result.localPath)
                updateMediaCardState(key, {
                  previewPath: result.localPath,
                  hasPreviewUpdate: isLikelyThumbnailPreview(result.localPath)
                })
              }
            }
          } catch {
            notFound += 1
          } finally {
            completed += 1
            updateTaskProgress()
            if (BATCH_IMAGE_DECRYPT_YIELD_MS > 0 && cursor < imageItems.length) {
              await waitForBatchDecryptYield()
            }
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      updateTaskProgress(true)

      if (hasRecordEntries(previewPatch)) {
        const validPatch: Record<string, string> = {}
        let hasValidPatch = false
        for (const key in previewPatch) {
          if (!isCurrentItemKey(key)) continue
          validPatch[key] = previewPatch[key]
          hasValidPatch = true
        }
        if (hasValidPatch) {
          previewPathMapRef.current = mergeRecordPatch(previewPathMapRef.current, validPatch)
        }
      }
      if (hasRecordEntries(updatePatch)) {
        const validPatch: Record<string, boolean> = {}
        let hasValidPatch = false
        for (const key in updatePatch) {
          if (!isCurrentItemKey(key)) continue
          validPatch[key] = updatePatch[key]
          hasValidPatch = true
        }
        if (hasValidPatch) {
          previewUpdateMapRef.current = mergeRecordPatch(previewUpdateMapRef.current, validPatch)
        }
      }
      setActionMessage(`批量解密完成：成功 ${success}，未找到 ${notFound}，解密失败 ${decryptFailed}`)
      showAlert(`批量解密完成：成功 ${success}，未找到 ${notFound}，解密失败 ${decryptFailed}`, '批量解密完成')
      finishBackgroundTask(taskId, decryptFailed > 0 ? 'failed' : 'completed', {
        detail: `资源页图片批量解密完成：成功 ${success}，未找到 ${notFound}，解密失败 ${decryptFailed}`,
        progressText: `成功 ${success} / 未找到 ${notFound} / 解密失败 ${decryptFailed}`
      })
    } catch (e) {
      finishBackgroundTask(taskId, 'failed', {
        detail: `资源页图片批量解密失败：${String(e)}`
      })
      showAlert(`批量解密失败：${String(e)}`, '批量解密失败')
    } finally {
      setBatchBusy(false)
    }
  }, [batchBusy, getMeta, isCurrentItemKey, isLikelyThumbnailPreview, selectedItems, showAlert, updateMediaCardState])

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

  const computeGridItemKey = useCallback((_: number, item: MediaStreamItem) => {
    return getMeta(item).itemKey
  }, [getMeta])

  const handleGridRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    lastRangeActivityAtRef.current = Date.now()
    const nextRange = { start: range.startIndex - 3, end: range.endIndex + 6 }
    const previousRange = lastVisibleRangeRef.current
    if (previousRange && previousRange.start === nextRange.start && previousRange.end === nextRange.end) {
      bumpRuntimeCounter('rangeDuplicateSkips')
      return
    }
    lastVisibleRangeRef.current = nextRange
    scheduleRangeResolve(nextRange.start, nextRange.end)
    scheduleTransientStatePrune(nextRange)
  }, [bumpRuntimeCounter, scheduleRangeResolve, scheduleTransientStatePrune])

  const handleGridEndReached = useCallback(() => {
    if (!hasMoreRef.current || loadingRef.current || loadingMoreRef.current) return
    void loadStream(false)
  }, [loadStream])

  const renderGridItem = useCallback((_: number, item: MediaStreamItem) => {
    const meta = getMeta(item)
    const itemKey = meta.itemKey
    return (
      <MediaCardContainer
        item={item}
        itemKey={itemKey}
        stateStore={mediaCardStateStoreRef.current}
        sessionName={item.sessionDisplayName || sessionNameMap[item.sessionId] || item.sessionId}
        videoTitle={meta.videoTitle}
        onToggleSelect={toggleSelect}
        onDelete={deleteOne}
        onShowInfo={showMediaInfo}
        onImagePreviewAction={onImagePreviewAction}
        onUpdateImageQuality={updateImageQuality}
        onOpenVideo={openVideo}
        onImageLoaded={onImageLoaded}
      />
    )
  }, [
    deleteOne,
    getMeta,
    onImageLoaded,
    onImagePreviewAction,
    openVideo,
    sessionNameMap,
    showMediaInfo,
    toggleSelect,
    updateImageQuality
  ])

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
            components={GRID_COMPONENTS}
            data={items}
            computeItemKey={computeGridItemKey}
            rangeChanged={handleGridRangeChanged}
            endReached={handleGridEndReached}
            itemContent={renderGridItem}
          />
          {loading && <div className="grid-refreshing"><Loader2 size={16} className="spin" /> 正在刷新...</div>}
          {loadingMore && <div className="grid-loading-more"><Loader2 size={16} className="spin" /> 加载更多中...</div>}
          {!hasMore && <div className="grid-end">已加载到底</div>}
        </div>
      )}

      {dialog && (
        <div className="resource-dialog-mask">
          <div className="resource-dialog" role="dialog" aria-modal="true" aria-label={dialog.title}>
            <header className="dialog-header">{dialog.title}</header>
            <div className="dialog-body">
              {dialog.mode === 'info' ? (
                <div className="dialog-info-list">
                  {(dialog.infoRows || []).map((row, idx) => (
                    <div className="dialog-info-row" key={`${row.label}-${idx}`}>
                      <span className="info-label">{row.label}</span>
                      <span className="info-value" title={row.value}>{row.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                dialog.message
              )}
            </div>
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
