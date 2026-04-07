import { imageDecryptService } from './imageDecryptService'

type PreloadImagePayload = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
}

type PreloadOptions = {
  allowDecrypt?: boolean
  allowCacheIndex?: boolean
}

type PreloadTask = PreloadImagePayload & {
  key: string
  allowDecrypt: boolean
  allowCacheIndex: boolean
}

export class ImagePreloadService {
  private queue: PreloadTask[] = []
  private pending = new Set<string>()
  private activeCache = 0
  private activeDecrypt = 0
  private readonly maxCacheConcurrent = 8
  private readonly maxDecryptConcurrent = 2
  private readonly maxQueueSize = 320

  enqueue(payloads: PreloadImagePayload[], options?: PreloadOptions): void {
    if (!Array.isArray(payloads) || payloads.length === 0) return
    const allowDecrypt = options?.allowDecrypt !== false
    const allowCacheIndex = options?.allowCacheIndex !== false
    for (const payload of payloads) {
      if (!allowDecrypt && this.queue.length >= this.maxQueueSize) break
      const cacheKey = payload.imageMd5 || payload.imageDatName
      if (!cacheKey) continue
      const key = `${payload.sessionId || 'unknown'}|${cacheKey}`
      if (this.pending.has(key)) continue
      this.pending.add(key)
      this.queue.push({ ...payload, key, allowDecrypt, allowCacheIndex })
    }
    this.processQueue()
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const taskIndex = this.queue.findIndex((task) => (
        task.allowDecrypt
          ? this.activeDecrypt < this.maxDecryptConcurrent
          : this.activeCache < this.maxCacheConcurrent
      ))
      if (taskIndex < 0) return

      const task = this.queue.splice(taskIndex, 1)[0]
      if (!task) return

      if (task.allowDecrypt) this.activeDecrypt += 1
      else this.activeCache += 1

      void this.handleTask(task).finally(() => {
        if (task.allowDecrypt) this.activeDecrypt = Math.max(0, this.activeDecrypt - 1)
        else this.activeCache = Math.max(0, this.activeCache - 1)
        this.pending.delete(task.key)
        this.processQueue()
      })
    }
  }

  private async handleTask(task: PreloadTask): Promise<void> {
    const cacheKey = task.imageMd5 || task.imageDatName
    if (!cacheKey) return
    try {
      const cached = await imageDecryptService.resolveCachedImage({
        sessionId: task.sessionId,
        imageMd5: task.imageMd5,
        imageDatName: task.imageDatName,
        disableUpdateCheck: !task.allowDecrypt,
        allowCacheIndex: task.allowCacheIndex
      })
      if (cached.success) return
      if (!task.allowDecrypt) return
      await imageDecryptService.decryptImage({
        sessionId: task.sessionId,
        imageMd5: task.imageMd5,
        imageDatName: task.imageDatName
      })
    } catch {
      // ignore preload failures
    }
  }
}

export const imagePreloadService = new ImagePreloadService()
