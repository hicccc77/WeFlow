export const BYTES_PER_MEGABYTE = 1024 * 1024
export const EMOJI_CACHE_MAX_ENTRIES = 260
export const EMOJI_CACHE_MAX_BYTES = 32 * BYTES_PER_MEGABYTE
export const IMAGE_CACHE_MAX_ENTRIES = 360
export const IMAGE_CACHE_MAX_BYTES = 64 * BYTES_PER_MEGABYTE
export const VOICE_CACHE_MAX_ENTRIES = 120
export const VOICE_CACHE_MAX_BYTES = 24 * BYTES_PER_MEGABYTE
export const VOICE_TRANSCRIPT_CACHE_MAX_ENTRIES = 1800
export const VOICE_TRANSCRIPT_CACHE_MAX_BYTES = 2 * BYTES_PER_MEGABYTE
export const SENDER_AVATAR_CACHE_MAX_ENTRIES = 2000
export const AUTO_MEDIA_TASK_MAX_CONCURRENCY = 2
export const AUTO_MEDIA_TASK_MAX_QUEUE = 80

type RequestIdleCallbackCompat = (callback: () => void, options?: { timeout?: number }) => number

export type BoundedCacheOptions<V> = {
  maxEntries: number
  maxBytes?: number
  estimate?: (value: V) => number
}

export type BoundedCache<V> = {
  get: (key: string) => V | undefined
  set: (key: string, value: V) => void
  has: (key: string) => boolean
  delete: (key: string) => boolean
  clear: () => void
  readonly size: number
}

export function estimateStringBytes(value: string): number {
  return Math.max(0, value.length * 2)
}

export function createBoundedCache<V>(options: BoundedCacheOptions<V>): BoundedCache<V> {
  const { maxEntries, maxBytes, estimate } = options
  const storage = new Map<string, V>()
  const valueSizes = new Map<string, number>()
  let currentBytes = 0

  const estimateSize = (value: V): number => {
    if (!estimate) return 1
    const raw = estimate(value)
    if (!Number.isFinite(raw) || raw <= 0) return 1
    return Math.max(1, Math.round(raw))
  }

  const removeKey = (key: string): boolean => {
    if (!storage.has(key)) return false
    const previousSize = valueSizes.get(key) || 0
    currentBytes = Math.max(0, currentBytes - previousSize)
    valueSizes.delete(key)
    return storage.delete(key)
  }

  const touch = (key: string, value: V) => {
    storage.delete(key)
    storage.set(key, value)
  }

  const prune = () => {
    const shouldPruneByBytes = Number.isFinite(maxBytes) && (maxBytes as number) > 0
    while (storage.size > maxEntries || (shouldPruneByBytes && currentBytes > (maxBytes as number))) {
      const oldestKey = storage.keys().next().value as string | undefined
      if (!oldestKey) break
      removeKey(oldestKey)
    }
  }

  return {
    get(key: string) {
      const value = storage.get(key)
      if (value === undefined) return undefined
      touch(key, value)
      return value
    },
    set(key: string, value: V) {
      const nextSize = estimateSize(value)
      if (storage.has(key)) {
        const previousSize = valueSizes.get(key) || 0
        currentBytes = Math.max(0, currentBytes - previousSize)
      }
      storage.set(key, value)
      valueSizes.set(key, nextSize)
      currentBytes += nextSize
      prune()
    },
    has(key: string) {
      return storage.has(key)
    },
    delete(key: string) {
      return removeKey(key)
    },
    clear() {
      storage.clear()
      valueSizes.clear()
      currentBytes = 0
    },
    get size() {
      return storage.size
    }
  }
}

const autoMediaTaskQueue: Array<() => void> = []
let autoMediaTaskRunningCount = 0
let autoMediaTasksPaused = false

export function setAutoMediaTasksPaused(paused: boolean): void {
  autoMediaTasksPaused = paused
}

export function enqueueAutoMediaTask<T>(task: () => Promise<T>): Promise<T> {
  if (autoMediaTasksPaused) {
    return Promise.reject(new Error('AUTO_MEDIA_TASKS_PAUSED'))
  }

  return new Promise<T>((resolve, reject) => {
    const runTask = () => {
      autoMediaTaskRunningCount += 1
      task()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          autoMediaTaskRunningCount = Math.max(0, autoMediaTaskRunningCount - 1)
          const next = autoMediaTaskQueue.shift()
          if (next) next()
        })
    }

    if (autoMediaTaskRunningCount < AUTO_MEDIA_TASK_MAX_CONCURRENCY) {
      runTask()
      return
    }
    if (autoMediaTaskQueue.length >= AUTO_MEDIA_TASK_MAX_QUEUE) {
      reject(new Error('AUTO_MEDIA_TASK_QUEUE_FULL'))
      return
    }
    autoMediaTaskQueue.push(runTask)
  })
}

export function scheduleWhenIdle(task: () => void, options?: { timeout?: number; fallbackDelay?: number }): void {
  const requestIdleCallbackFn = (
    globalThis as typeof globalThis & { requestIdleCallback?: RequestIdleCallbackCompat }
  ).requestIdleCallback

  if (typeof requestIdleCallbackFn === 'function') {
    requestIdleCallbackFn(task, options?.timeout !== undefined ? { timeout: options.timeout } : undefined)
    return
  }

  window.setTimeout(task, options?.fallbackDelay ?? 0)
}
