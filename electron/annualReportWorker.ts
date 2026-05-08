import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { annualReportService } from './services/annualReportService'

interface WorkerConfig {
  year: number
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

interface SensitiveConfig {
  dbPath: string
  decryptKey: string
  myWxid: string
}

const config = workerData as WorkerConfig
let sensitiveConfig: SensitiveConfig | null = null

process.env.WEFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}

wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
wcdbService.setLogEnabled(config.logEnabled === true)

parentPort?.on('message', (message: { type: string; data?: SensitiveConfig }) => {
  if (message.type === 'annualReport:config' && message.data) {
    sensitiveConfig = message.data
  }
})

async function run() {
  if (!sensitiveConfig) {
    parentPort?.postMessage({ type: 'annualReport:error', error: 'Missing sensitive config' })
    return
  }

  const result = await annualReportService.generateReportWithConfig({
    year: config.year,
    dbPath: sensitiveConfig.dbPath,
    decryptKey: sensitiveConfig.decryptKey,
    wxid: sensitiveConfig.myWxid,
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
