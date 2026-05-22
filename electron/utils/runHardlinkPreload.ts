import {
  IMAGE_HARDLINK_PRELOAD_BATCH_SIZE,
  IMAGE_HARDLINK_PRELOAD_SKIP_THRESHOLD
} from '../constants/imageDecrypt'
import { imageDecryptService } from '../services/imageDecryptService'

export type HardlinkPreloadProgressHandler = (payload: {
  current: number
  total: number
  hits: number
}) => void

export type HardlinkPreloadResult = {
  skipped: boolean
  success?: boolean
  total?: number
  hits?: number
  error?: string
}

const normalizeMd5List = (md5List: string[]): string[] => {
  return Array.from(
    new Set(
      (md5List || [])
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => /^[a-f0-9]{32}$/i.test(item))
    )
  )
}

/**
 * 批量解密/导出前预热 hardlink 索引：超过阈值则跳过；否则批量查询。
 */
export async function runHardlinkPreloadIfNeeded(
  md5List: string[],
  options?: {
    skipThreshold?: number
    batchSize?: number
    onProgress?: HardlinkPreloadProgressHandler
  }
): Promise<HardlinkPreloadResult> {
  const unique = normalizeMd5List(md5List)
  if (unique.length === 0) {
    return { skipped: true }
  }

  const skipThreshold = options?.skipThreshold ?? IMAGE_HARDLINK_PRELOAD_SKIP_THRESHOLD
  if (unique.length > skipThreshold) {
    return { skipped: true }
  }

  const result = await imageDecryptService.preloadImageHardlinkMd5s(unique, {
    batchSize: options?.batchSize ?? IMAGE_HARDLINK_PRELOAD_BATCH_SIZE,
    onProgress: options?.onProgress
  })

  return { skipped: false, ...result }
}
