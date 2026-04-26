import { parentPort, workerData } from 'worker_threads'

interface ExportWorkerConfig {
  mode?: 'sessions' | 'single' | 'contacts'
  sessionIds?: string[]
  sessionId?: string
  outputDir?: string
  outputPath?: string
  options?: any
  taskId?: string
  dbPath?: string
  decryptKey?: string
  myWxid?: string
  imageXorKey?: unknown
  imageAesKey?: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

const config = workerData as ExportWorkerConfig
const controlState = {
  pauseRequested: false,
  stopRequested: false
}

const CREATED_PATH_FLUSH_INTERVAL_MS = 200
const CREATED_PATH_BATCH_LIMIT = 256
const PROGRESS_POST_INTERVAL_MS = 180
let queuedCreatedFiles: string[] = []
let queuedCreatedDirs: string[] = []
let createdPathFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingProgress: any = null
let progressPostTimer: ReturnType<typeof setTimeout> | null = null
let lastProgressPostedAt = 0

function flushCreatedPaths() {
  if (createdPathFlushTimer) {
    clearTimeout(createdPathFlushTimer)
    createdPathFlushTimer = null
  }
  const filePaths = queuedCreatedFiles
  const dirPaths = queuedCreatedDirs
  queuedCreatedFiles = []
  queuedCreatedDirs = []
  if (!parentPort) return
  if (filePaths.length > 0) {
    parentPort.postMessage({ type: 'export:createdFiles', filePaths })
  }
  if (dirPaths.length > 0) {
    parentPort.postMessage({ type: 'export:createdDirs', dirPaths })
  }
}

function scheduleCreatedPathFlush() {
  if (createdPathFlushTimer) return
  createdPathFlushTimer = setTimeout(flushCreatedPaths, CREATED_PATH_FLUSH_INTERVAL_MS)
}

function queueCreatedFile(filePath: string) {
  const normalized = String(filePath || '').trim()
  if (!normalized) return
  queuedCreatedFiles.push(normalized)
  if (queuedCreatedFiles.length + queuedCreatedDirs.length >= CREATED_PATH_BATCH_LIMIT) {
    flushCreatedPaths()
  } else {
    scheduleCreatedPathFlush()
  }
}

function queueCreatedDir(dirPath: string) {
  const normalized = String(dirPath || '').trim()
  if (!normalized) return
  queuedCreatedDirs.push(normalized)
  if (queuedCreatedFiles.length + queuedCreatedDirs.length >= CREATED_PATH_BATCH_LIMIT) {
    flushCreatedPaths()
  } else {
    scheduleCreatedPathFlush()
  }
}

function flushProgress() {
  if (!pendingProgress) return
  if (progressPostTimer) {
    clearTimeout(progressPostTimer)
    progressPostTimer = null
  }
  parentPort?.postMessage({
    type: 'export:progress',
    data: pendingProgress
  })
  pendingProgress = null
  lastProgressPostedAt = Date.now()
}

function queueProgress(progress: any) {
  pendingProgress = progress
  if (progress?.phase === 'complete') {
    flushProgress()
    return
  }

  const now = Date.now()
  const elapsed = now - lastProgressPostedAt
  if (elapsed >= PROGRESS_POST_INTERVAL_MS) {
    flushProgress()
    return
  }

  if (progressPostTimer) return
  progressPostTimer = setTimeout(flushProgress, PROGRESS_POST_INTERVAL_MS - elapsed)
}

parentPort?.on('message', (message: any) => {
  if (!message || typeof message.type !== 'string') return
  if (message.type === 'export:pause') {
    controlState.pauseRequested = true
    return
  }
  if (message.type === 'export:resume') {
    controlState.pauseRequested = false
    return
  }
  if (message.type === 'export:cancel') {
    controlState.stopRequested = true
    controlState.pauseRequested = false
  }
})

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
    myWxid: config.myWxid,
    imageXorKey: config.imageXorKey,
    imageAesKey: config.imageAesKey
  })

  const onProgress = (progress: any) => queueProgress(progress)

  const taskControl = config.taskId
    ? {
        shouldPause: () => controlState.pauseRequested,
        shouldStop: () => controlState.stopRequested,
        recordCreatedFile: queueCreatedFile,
        recordCreatedDir: queueCreatedDir
      }
    : undefined

  let result: any
  if (config.mode === 'contacts') {
    const { contactExportService } = await import('./services/contactExportService')
    result = await contactExportService.exportContacts(
      String(config.outputDir || ''),
      config.options || {}
    )
  } else if (config.mode === 'single') {
    result = await exportService.exportSessionToChatLab(
      String(config.sessionId || '').trim(),
      String(config.outputPath || '').trim(),
      config.options || { format: 'chatlab' },
      onProgress,
      taskControl
    )
  } else {
    result = await exportService.exportSessions(
      Array.isArray(config.sessionIds) ? config.sessionIds : [],
      String(config.outputDir || ''),
      config.options || { format: 'json' },
      onProgress,
      taskControl
    )
  }

  flushProgress()
  flushCreatedPaths()

  parentPort?.postMessage({
    type: 'export:result',
    data: result
  })
}

run().catch((error) => {
  flushProgress()
  flushCreatedPaths()
  parentPort?.postMessage({
    type: 'export:error',
    error: String(error)
  })
})
