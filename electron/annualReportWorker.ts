import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { annualReportService } from './services/annualReportService'

interface WorkerConfig {
  year: number
  dbPath: string
  decryptKey: string
  myWxid: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

const config = workerData as WorkerConfig
process.env.WEFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}

wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
wcdbService.setLogEnabled(config.logEnabled === true)

async function run() {
  const result = await annualReportService.generateReportWithConfig({
    year: config.year,
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    wxid: config.myWxid,
    onProgress: (status: string, progress: number) => {
      parentPort?.postMessage({
        type: 'annualReport:progress',
        data: { status, progress }
      })
    }
  })

  parentPort?.postMessage({ type: 'annualReport:result', data: result })
}

run().catch((err) => {
  parentPort?.postMessage({ type: 'annualReport:error', error: String(err) })
})
