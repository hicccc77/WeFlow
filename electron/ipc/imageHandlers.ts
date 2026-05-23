import { ipcMain } from 'electron'
import { imageDecryptService } from '../services/imageDecryptService'
import { imagePreloadService } from '../services/imagePreloadService'
import { imageDownloadService } from '../services/imageDownloadService'

export function registerImageHandlers() {
  ipcMain.handle('image:decrypt', async (_, payload: {
    sessionId?: string
    imageMd5?: string
    imageDatName?: string
    createTime?: number
    force?: boolean
    preferFilePath?: boolean
    hardlinkOnly?: boolean
    disableUpdateCheck?: boolean
    allowCacheIndex?: boolean
    suppressEvents?: boolean
  }) => {
    return imageDecryptService.decryptImage(payload)
  })

  ipcMain.handle('image:resolveCache', async (_, payload: {
    sessionId?: string
    imageMd5?: string
    imageDatName?: string
    createTime?: number
    preferFilePath?: boolean
    hardlinkOnly?: boolean
    disableUpdateCheck?: boolean
    allowCacheIndex?: boolean
    suppressEvents?: boolean
  }) => {
    return imageDecryptService.resolveCachedImage(payload)
  })

  ipcMain.handle(
    'image:resolveCacheBatch',
    async (
      _,
      payloads: Array<{
        sessionId?: string
        imageMd5?: string
        imageDatName?: string
        createTime?: number
        preferFilePath?: boolean
        hardlinkOnly?: boolean
        suppressEvents?: boolean
      }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean; preferFilePath?: boolean; hardlinkOnly?: boolean; suppressEvents?: boolean }
    ) => {
      const list = Array.isArray(payloads) ? payloads : []
      if (list.length === 0) return { success: true, rows: [] }

      const maxConcurrentRaw = Number(process.env.WEFLOW_IMAGE_RESOLVE_BATCH_CONCURRENCY || 10)
      const maxConcurrent = Number.isFinite(maxConcurrentRaw)
        ? Math.max(1, Math.min(Math.floor(maxConcurrentRaw), 48))
        : 10
      const workerCount = Math.min(maxConcurrent, list.length)

      const rows: Array<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }> = new Array(list.length)
      let cursor = 0
      const dedupe = new Map<string, Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>>()

      const makeDedupeKey = (payload: typeof list[number]): string => {
        const sessionId = String(payload.sessionId || '').trim().toLowerCase()
        const imageMd5 = String(payload.imageMd5 || '').trim().toLowerCase()
        const imageDatName = String(payload.imageDatName || '').trim().toLowerCase()
        const createTime = Number(payload.createTime || 0) || 0
        const preferFilePath = payload.preferFilePath ?? options?.preferFilePath === true
        const hardlinkOnly = payload.hardlinkOnly ?? options?.hardlinkOnly === true
        const allowCacheIndex = options?.allowCacheIndex !== false
        const disableUpdateCheck = options?.disableUpdateCheck === true
        const suppressEvents = payload.suppressEvents ?? options?.suppressEvents === true
        return [
          sessionId,
          imageMd5,
          imageDatName,
          String(createTime),
          preferFilePath ? 'pf1' : 'pf0',
          hardlinkOnly ? 'hl1' : 'hl0',
          allowCacheIndex ? 'ci1' : 'ci0',
          disableUpdateCheck ? 'du1' : 'du0',
          suppressEvents ? 'se1' : 'se0'
        ].join('|')
      }

      const resolveOne = (payload: typeof list[number]) => imageDecryptService.resolveCachedImage({
        ...payload,
        preferFilePath: payload.preferFilePath ?? options?.preferFilePath === true,
        hardlinkOnly: payload.hardlinkOnly ?? options?.hardlinkOnly === true,
        disableUpdateCheck: options?.disableUpdateCheck === true,
        allowCacheIndex: options?.allowCacheIndex !== false,
        suppressEvents: payload.suppressEvents ?? options?.suppressEvents === true
      })

      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= list.length) return
          const payload = list[index]
          const key = makeDedupeKey(payload)
          const existing = dedupe.get(key)
          if (existing) {
            rows[index] = await existing
            continue
          }
          const task = resolveOne(payload).catch((error) => ({
            success: false,
            error: String(error)
          }))
          dedupe.set(key, task)
          rows[index] = await task
        }
      }

      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      return { success: true, rows }
    }
  )

  ipcMain.handle(
    'image:preload',
    async (
      _,
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean }
    ) => {
      imagePreloadService.enqueue(payloads || [], options)
      return true
    }
  )

  ipcMain.handle(
    'image:preloadHardlinkMd5s',
    async (event, md5List?: string[], options?: { batchSize?: number }) => {
      const sender = event.sender
      return imageDecryptService.preloadImageHardlinkMd5s(Array.isArray(md5List) ? md5List : [], {
        batchSize: options?.batchSize,
        onProgress: (payload) => {
          if (!sender.isDestroyed()) {
            sender.send('image:preloadHardlinkProgress', payload)
          }
        }
      })
    }
  )

  ipcMain.handle('image:startAutoDownload', async (_, whitelist?: string[]) => {
    return await imageDownloadService.startAutoDownload(whitelist || [])
  })

  ipcMain.handle('image:stopAutoDownload', async () => {
    await imageDownloadService.stopAutoDownload()
    return { success: true }
  })

  ipcMain.handle('image:getAutoDownloadStatus', async () => {
    return await imageDownloadService.getStatus()
  })
}
