import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { dualReportService } from './services/dualReportService'

interface WorkerConfig {
  year: number
  friendUsername: string
  dbPath: string
  decryptKey: string
  myWxid: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
  excludeWords?: string[]
}

const config = workerData as WorkerConfig
process.env.WEFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}

wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
wcdbService.setLogEnabled(config.logEnabled === true)

async function run() {
  const result = await dualReportService.generateReportWithConfig({
    year: config.year,
    friendUsername: config.friendUsername,
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    wxid: config.myWxid,
    excludeWords: config.excludeWords,
    onProgress: (status: string, progress: number) => {
      parentPort?.postMessage({
        type: 'dualReport:progress',
        data: { status, progress }
      })
    }
  })

  parentPort?.postMessage({ type: 'dualReport:result', data: result })
}

run().catch((err) => {
  parentPort?.postMessage({ type: 'dualReport:error', error: String(err) })
})
