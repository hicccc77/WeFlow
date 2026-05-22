import {
  IMAGE_HARDLINK_PRELOAD_BATCH_SIZE,
  IMAGE_HARDLINK_PRELOAD_SKIP_THRESHOLD
} from '../constants/imageDecrypt'

export type HardlinkPreloadProgressHandler = (detail: string) => void

/**
 * 批量解密前预热 hardlink 索引：超过阈值则跳过；否则批量查询并回调进度。
 */
export async function runHardlinkPreloadIfNeeded(
  md5List: string[],
  onStatus: HardlinkPreloadProgressHandler,
  skipThreshold: number = IMAGE_HARDLINK_PRELOAD_SKIP_THRESHOLD
): Promise<{ skipped: boolean; hits?: number; total?: number }> {
  const unique = Array.from(
    new Set(
      md5List
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => /^[a-f0-9]{32}$/i.test(item))
    )
  )
  if (unique.length === 0) {
    return { skipped: true }
  }

  if (unique.length > skipThreshold) {
    onStatus(
      `批量较大（${unique.length} 个标识），已跳过索引预热，解密时将按需查找文件`
    )
    return { skipped: true }
  }

  onStatus(`正在预热图片索引（0/${unique.length}）...`)
  const unsubscribe = window.electronAPI.image.onPreloadHardlinkProgress((payload) => {
    onStatus(
      `正在预热图片索引（${payload.current}/${payload.total}，hardlink 命中 ${payload.hits}）...`
    )
  })

  try {
    const result = await window.electronAPI.image.preloadHardlinkMd5s(unique, {
      batchSize: IMAGE_HARDLINK_PRELOAD_BATCH_SIZE
    })
    if (result.success) {
      onStatus(
        `索引预热完成（${result.hits}/${result.total} 命中 hardlink），开始解密...`
      )
    } else {
      onStatus(
        `索引预热未完成（${result.error || '未知原因'}），将直接开始解密...`
      )
    }
    return { skipped: false, hits: result.hits, total: result.total }
  } catch {
    onStatus('索引预热失败，将直接开始解密...')
    return { skipped: false }
  } finally {
    unsubscribe()
  }
}
