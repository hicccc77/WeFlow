export type MediaTab = 'image' | 'video'

export interface MediaStreamItem {
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

export interface ContactOption {
  id: string
  name: string
}

export type ImagePreloadPayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

export type DialogState = {
  mode: 'alert' | 'confirm' | 'info'
  title: string
  message?: string
  infoRows?: Array<{ label: string; value: string }>
  confirmText?: string
  cancelText?: string
  onConfirm?: (() => void) | null
}

export const PAGE_SIZE = 96
export const MAX_IMAGE_CACHE_RESOLVE_PER_TICK = 12
export const MAX_IMAGE_CACHE_PRELOAD_PER_TICK = 12
export const MAX_IMAGE_PREDECRYPT_PER_TICK = 4
export const MAX_VIDEO_POSTER_RESOLVE_PER_TICK = 8
export const MAX_MEDIA_PATCHES_PER_FLUSH = 32
export const INITIAL_IMAGE_PRELOAD_END = 48
export const INITIAL_IMAGE_RESOLVE_END = 12
export const INITIAL_IMAGE_PREDECRYPT_END = 28
export const IMAGE_PREDECRYPT_LOOKAHEAD = 36
export const IMAGE_PREDECRYPT_IDLE_DELAY_MS = 1200
export const IMAGE_PREDECRYPT_TIMER_MS = 900
export const TASK_PROGRESS_UPDATE_MIN_INTERVAL_MS = 250
export const TASK_PROGRESS_UPDATE_MAX_STEPS = 100
export const BATCH_IMAGE_DECRYPT_CONCURRENCY = 2
export const BATCH_IMAGE_DECRYPT_YIELD_MS = 16
export const BATCH_IMAGE_HARDLINK_PRELOAD_CHUNK_SIZE = 8
export const BATCH_IMAGE_HARDLINK_PRELOAD_YIELD_MS = 16

export function getRangeTimestampStart(date: string): number | undefined {
  if (!date) return undefined
  const parsed = new Date(`${date}T00:00:00`)
  const n = Math.floor(parsed.getTime() / 1000)
  return Number.isFinite(n) ? n : undefined
}

export function getRangeTimestampEnd(date: string): number | undefined {
  if (!date) return undefined
  const parsed = new Date(`${date}T23:59:59`)
  const n = Math.floor(parsed.getTime() / 1000)
  return Number.isFinite(n) ? n : undefined
}

export function normalizeMediaToken(value?: string): string {
  return String(value || '').trim().toLowerCase()
}

export function getSafeImageDatName(item: Pick<MediaStreamItem, 'imageDatName' | 'imageMd5'>): string {
  const datName = normalizeMediaToken(item.imageDatName)
  if (!datName) return ''
  return datName
}

export function hasImageLocator(item: Pick<MediaStreamItem, 'imageDatName' | 'imageMd5'>): boolean {
  return Boolean(normalizeMediaToken(item.imageMd5) || getSafeImageDatName(item))
}

export function getItemKey(item: MediaStreamItem): string {
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
      : (item.imageMd5 || getSafeImageDatName(item) || '')
  ).trim().toLowerCase()
  return `${sessionId}|${createTime}|${localType}|${serverId}|${mediaId}`
}

export function formatTimeLabel(timestampSec: number): string {
  if (!timestampSec) return '--:--'
  return new Date(timestampSec * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatInfoValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  const text = String(value).trim()
  return text || '-'
}

export function extractVideoTitle(content?: string): string {
  const xml = String(content || '')
  if (!xml) return '视频'
  const match = /<title>([\s\S]*?)<\/title>/i.exec(xml)
  const text = String(match?.[1] || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  return text || '视频'
}

export function extractVideoMd5(content?: string): string {
  const xml = String(content || '')
  if (!xml) return ''
  const patterns = [
    /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
    /<videomsg[^>]*\srawmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
    /(?:^|[^a-z])md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i,
    /<md5>([a-fA-F0-9]+)<\/md5>/i,
    /\srawmd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(xml)
    if (match?.[1]) return match[1].toLowerCase()
  }
  return ''
}

export function toRenderableMediaSrc(rawPath?: string): string {
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
