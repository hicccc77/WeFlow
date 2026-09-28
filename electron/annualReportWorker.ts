import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { annualReportService } from './services/annualReportService'

interface WorkerConfig {
  year: number
  dbPath: string
  decryptKey: string
  myAccountId: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
  wcdbLibPath?: string
}

const config = workerData as WorkerConfig
process.env.WEFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}

wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
wcdbService.setLibPath(config.wcdbLibPath || '')
wcdbService.setLogEnabled(config.logEnabled === true)

async function run() {
  const result = await annualReportService.generateReportWithConfig({
    year: config.year,
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    accountId: config.myAccountId,
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
