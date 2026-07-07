import { parentPort, workerData } from 'worker_threads'
import { decryptDatViaNative, nativeAddonLocation } from './services/nativeImageDecrypt'

// worker_threads 中没有 Electron 注入的 resourcesPath，由主线程通过 workerData 传入，
// 供 nativeImageDecrypt 定位 .node 原生模块
if (workerData?.resourcesPath && !process.resourcesPath) {
  ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = workerData.resourcesPath
}

type DecryptRequest = {
  id: number
  datPath: string
  xorKey: number
  aesKey?: string
}

parentPort?.on('message', (req: DecryptRequest) => {
  const { id, datPath, xorKey, aesKey } = req
  try {
    const result = decryptDatViaNative(datPath, xorKey, aesKey)
    if (!result) {
      // addonMissing 让主线程直接放弃 worker 路径，避免每次解密都白跑一次线程往返
      parentPort?.postMessage({ id, ok: false, addonMissing: !nativeAddonLocation() })
      return
    }
    // 拷贝出独立 ArrayBuffer 后转移所有权，避免结构化克隆再复制一次
    const data = new ArrayBuffer(result.data.byteLength)
    new Uint8Array(data).set(result.data)
    parentPort?.postMessage(
      { id, ok: true, data, ext: result.ext, isWxgf: result.isWxgf, meta: result.meta },
      [data]
    )
  } catch (error) {
    parentPort?.postMessage({ id, ok: false, error: String(error) })
  }
})
