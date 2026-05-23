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
  accountDir?: string
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

function isExportControlInterruption(error: unknown): boolean {
  const text = error instanceof Error
    ? `${(error as Error & { code?: string }).code || ''} ${error.message}`
    : String(error || '')
  return (
    text.includes('WEFLOW_EXPORT_STOP_REQUESTED') ||
    text.includes('WEFLOW_EXPORT_PAUSE_REQUESTED') ||
    text.includes('导出任务已停止') ||
    text.includes('导出任务已暂停')
  )
}

async function run() {
  const [
    { wcdbService },
    { exportService },
    { chooseExportEngine, getRustExportDisabledReason },
    { exportSessionsWithRustStreaming },
    { canUseTypeScriptStreamingExport, exportSessionsWithTypeScriptStreaming }
  ] = await Promise.all([
    import('./services/wcdbService'),
    import('./services/exportService'),
    import('./services/export/exportEngineRouter'),
    import('./services/export/rustStreamingExporter'),
    import('./services/export/typescriptStreamingExporter')
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
    const [{ contactExportService }, { chatService }] = await Promise.all([
      import('./services/contactExportService'),
      import('./services/chatService')
    ])
    chatService.setRuntimeConfig({
      dbPath: config.dbPath,
      decryptKey: config.decryptKey,
      myWxid: config.myWxid
    })
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
    const options = config.options || { format: 'json' }
    const requestedEngine = String(options.engine || 'auto')
    const resolvedEngine = chooseExportEngine(options)
    const rustDisabledReason = getRustExportDisabledReason(options)
    const rustProgress = (progress: any) => onProgress({
      ...progress,
      exportEngine: 'rust',
      exportEngineLabel: 'Rust'
    })
    let typeScriptEngineLabel = requestedEngine === 'typescript'
      ? 'TypeScript · 手动指定'
      : rustDisabledReason
        ? `TypeScript · Rust未启用：${rustDisabledReason}`
        : 'TypeScript'
    const typeScriptProgress = (progress: any) => onProgress({
      ...progress,
      exportEngine: 'typescript',
      exportEngineLabel: typeScriptEngineLabel
    })
    const runTypeScriptExport = async () => exportService.exportSessions(
      Array.isArray(config.sessionIds) ? config.sessionIds : [],
      String(config.outputDir || ''),
      options,
      typeScriptProgress,
      taskControl
    )
    const runTypeScriptStreamingExport = async () => exportSessionsWithTypeScriptStreaming({
      source: wcdbService,
      sessionIds: Array.isArray(config.sessionIds) ? config.sessionIds : [],
      outputDir: String(config.outputDir || ''),
      options,
      accountDir: String(config.accountDir || config.dbPath || ''),
      decryptKey: String(config.decryptKey || ''),
      cleanedMyWxid: String(config.myWxid || ''),
      onProgress: typeScriptProgress,
      control: taskControl
    })
    const runRustStreamingExport = async () => exportSessionsWithRustStreaming({
      source: wcdbService,
      sessionIds: Array.isArray(config.sessionIds) ? config.sessionIds : [],
      outputDir: String(config.outputDir || ''),
      options,
      accountDir: String(config.accountDir || config.dbPath || ''),
      decryptKey: String(config.decryptKey || ''),
      cleanedMyWxid: String(config.myWxid || ''),
      resourcesPath: String(config.resourcesPath || ''),
      onProgress: rustProgress,
      control: taskControl
    })

    if (resolvedEngine === 'rust') {
      try {
        onProgress({
          current: 0,
          total: 100,
          currentSession: '',
          currentSessionId: '',
          phase: 'preparing',
          phaseLabel: 'Rust 引擎准备导出',
          exportEngine: 'rust',
          exportEngineLabel: 'Rust'
        })
        result = await runRustStreamingExport()
      } catch (error) {
        if (requestedEngine === 'rust' || isExportControlInterruption(error)) {
          throw error
        }
        const fallbackReason = error instanceof Error ? error.message : String(error)
        typeScriptEngineLabel = `TypeScript · Rust回退：${fallbackReason.slice(0, 160)}`
        console.warn(`[exportWorker] Rust exporter unavailable, falling back to TypeScript: ${fallbackReason}`)
        onProgress({
          current: 0,
          total: 100,
          currentSession: '',
          currentSessionId: '',
          phase: 'preparing',
          phaseLabel: `Rust 引擎不可用，已回退 TypeScript：${fallbackReason.slice(0, 160)}`,
          exportEngine: 'typescript',
          exportEngineLabel: typeScriptEngineLabel
        })
        result = await runTypeScriptExport()
      }
    } else {
      if (requestedEngine === 'auto' && rustDisabledReason) {
        onProgress({
          current: 0,
          total: 100,
          currentSession: '',
          currentSessionId: '',
          phase: 'preparing',
          phaseLabel: `TypeScript 引擎导出（Rust 未启用：${rustDisabledReason}）`
        })
      }
      if (requestedEngine === 'typescript') {
        onProgress({
          current: 0,
          total: 100,
          currentSession: '',
          currentSessionId: '',
          phase: 'preparing',
          phaseLabel: canUseTypeScriptStreamingExport(options)
            ? 'TypeScript 流式引擎准备导出'
            : 'TypeScript 引擎准备导出'
        })
      }
      result = requestedEngine === 'typescript' && canUseTypeScriptStreamingExport(options)
        ? await runTypeScriptStreamingExport()
        : await runTypeScriptExport()
    }
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
