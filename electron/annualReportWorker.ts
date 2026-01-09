import { parentPort, workerData } from 'worker_threads'
import { annualReportService } from './services/annualReportService'

type WorkerPayload = {
  year: number
  dbPath: string
  decryptKey: string
  wxid: string
  resourcesPath?: string
}

const payload = workerData as WorkerPayload

async function run() {
  process.env.WEFLOW_WORKER = '1'
  if (payload.resourcesPath) {
    process.env.WCDB_RESOURCES_PATH = payload.resourcesPath
  }

  const result = await annualReportService.generateReportWithConfig({
    year: payload.year,
    dbPath: payload.dbPath,
    decryptKey: payload.decryptKey,
    wxid: payload.wxid,
    onProgress: (status, progress) => {
      parentPort?.postMessage({ type: 'progress', status, progress })
    }
  })

  parentPort?.postMessage({ type: 'done', result })
}

run().catch((err) => {
  parentPort?.postMessage({ type: 'error', error: String(err) })
})
