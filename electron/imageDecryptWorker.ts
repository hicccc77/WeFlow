import { parentPort, workerData } from 'worker_threads'
import { existsSync } from 'fs'

// worker_threads 中 electron-store 可能不可用，第三方插件路径由主线程通过 workerData 显式传入
// Electron browser APIs are unavailable in worker_threads. The parent supplies
// the configured addon path, so this worker must not import ConfigService.
const addonPath = String(workerData?.imageNativeAddonPath || '').trim()
let addon: any = null
try {
  if (addonPath && existsSync(addonPath)) addon = require(addonPath)
} catch { /* Report unavailable through the existing worker protocol. */ }

type DecryptRequest = {
  id: number
  datPath: string
  xorKey: number
  aesKey?: string
}

parentPort?.on('message', (req: DecryptRequest) => {
  const { id, datPath, xorKey, aesKey } = req
  try {
    const raw = addon?.decryptDatNative(datPath, xorKey, aesKey)
    if (!raw || !Buffer.isBuffer(raw.data)) {
      // addonMissing 让主线程直接放弃 worker 路径，避免每次解密都白跑一次线程往返
      parentPort?.postMessage({ id, ok: false, addonMissing: !addon })
      return
    }
    // 拷贝出独立 ArrayBuffer 后转移所有权，避免结构化克隆再复制一次
    const data = new ArrayBuffer(raw.data.byteLength)
    new Uint8Array(data).set(raw.data)
    const ext = String(raw.ext || '').trim().toLowerCase()
    parentPort?.postMessage(
      { id, ok: true, data, ext: ext && (ext.startsWith('.') ? ext : `.${ext}`),
        isWxgf: Boolean(raw.isWxgf ?? raw.is_wxgf),
        meta: { version: raw.version, aes_size: raw.aes_size ?? raw.aesSize,
          xor_size: raw.xor_size ?? raw.xorSize, raw_size: raw.raw_size ?? raw.rawSize, flag: raw.flag } },
      [data]
    )
  } catch (error) {
    parentPort?.postMessage({ id, ok: false, error: String(error) })
  }
})
