import { parentPort, workerData } from 'worker_threads'
import type { ExportOptions } from './services/exportService'

interface ExportWorkerConfig {
  sessionIds: string[]
  outputDir: string
  options: ExportOptions
  dbPath?: string
  decryptKey?: string
  myWxid?: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

const config = workerData as ExportWorkerConfig
process.env.WEFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}
if (config.userDataPath) {
  process.env.WEFLOW_USER_DATA_PATH = config.userDataPath
  process.env.WEFLOW_CONFIG_CWD = config.userDataPath
}
process.env.WEFLOW_PROJECT_NAME = process.env.WEFLOW_PROJECT_NAME || 'WeFlow'

async function run() {
  const [{ wcdbService }, { exportService }] = await Promise.all([
    import('./services/wcdbService'),
    import('./services/exportService')
  ])

  wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
  wcdbService.setLogEnabled(config.logEnabled === true)
  exportService.setRuntimeConfig({
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    myWxid: config.myWxid
  })

  const result = await exportService.exportSessions(
    Array.isArray(config.sessionIds) ? config.sessionIds : [],
    String(config.outputDir || ''),
    config.options || { format: 'json' },
    (progress) => {
      parentPort?.postMessage({
        type: 'export:progress',
        data: progress
      })
    }
  )

  parentPort?.postMessage({
    type: 'export:result',
    data: result
  })
}

run().catch((error) => {
  parentPort?.postMessage({
    type: 'export:error',
    error: String(error)
  })
})
