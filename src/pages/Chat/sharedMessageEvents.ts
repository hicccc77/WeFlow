export type ImageUpdatePayload = {
  cacheKey: string
  sessionId?: string
  createTime?: number
  imageMd5?: string
  imageDatName?: string
}
export type ImageCacheResolvedPayload = ImageUpdatePayload & { localPath: string }
export type VoiceTranscriptPartialPayload = { sessionId?: string; msgId: string; createTime?: number; text: string }

const imageUpdateSubscribers = new Set<(payload: ImageUpdatePayload) => void>()
const imageCacheResolvedSubscribers = new Set<(payload: ImageCacheResolvedPayload) => void>()
const voiceTranscriptPartialSubscribers = new Set<(payload: VoiceTranscriptPartialPayload) => void>()
let unsubscribeImageUpdateSource: (() => void) | null = null
let unsubscribeImageCacheResolvedSource: (() => void) | null = null
let unsubscribeVoiceTranscriptPartialSource: (() => void) | null = null

export function subscribeSharedImageUpdate(callback: (payload: ImageUpdatePayload) => void): () => void {
  imageUpdateSubscribers.add(callback)
  if (!unsubscribeImageUpdateSource) {
    unsubscribeImageUpdateSource = window.electronAPI.image.onUpdateAvailable((payload: ImageUpdatePayload) => {
      for (const subscriber of imageUpdateSubscribers) subscriber(payload)
    })
  }
  return () => {
    imageUpdateSubscribers.delete(callback)
    if (imageUpdateSubscribers.size === 0) {
      unsubscribeImageUpdateSource?.()
      unsubscribeImageUpdateSource = null
    }
  }
}

export function subscribeSharedImageCacheResolved(callback: (payload: ImageCacheResolvedPayload) => void): () => void {
  imageCacheResolvedSubscribers.add(callback)
  if (!unsubscribeImageCacheResolvedSource) {
    unsubscribeImageCacheResolvedSource = window.electronAPI.image.onCacheResolved((payload: ImageCacheResolvedPayload) => {
      for (const subscriber of imageCacheResolvedSubscribers) subscriber(payload)
    })
  }
  return () => {
    imageCacheResolvedSubscribers.delete(callback)
    if (imageCacheResolvedSubscribers.size === 0) {
      unsubscribeImageCacheResolvedSource?.()
      unsubscribeImageCacheResolvedSource = null
    }
  }
}

export function subscribeSharedVoiceTranscriptPartial(callback: (payload: VoiceTranscriptPartialPayload) => void): () => void {
  voiceTranscriptPartialSubscribers.add(callback)
  if (!unsubscribeVoiceTranscriptPartialSource && window.electronAPI.chat.onVoiceTranscriptPartial) {
    unsubscribeVoiceTranscriptPartialSource = window.electronAPI.chat.onVoiceTranscriptPartial((payload: VoiceTranscriptPartialPayload) => {
      for (const subscriber of voiceTranscriptPartialSubscribers) subscriber(payload)
    })
  }
  return () => {
    voiceTranscriptPartialSubscribers.delete(callback)
    if (voiceTranscriptPartialSubscribers.size === 0) {
      unsubscribeVoiceTranscriptPartialSource?.()
      unsubscribeVoiceTranscriptPartialSource = null
    }
  }
}
