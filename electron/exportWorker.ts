import { parentPort, workerData } from 'worker_threads'
import { runWeliveExport, type WeliveExportEvent, type WeliveRawExportManifest } from './services/weliveBridge'

interface ExportWorkerConfig {
  mode?: 'sessions' | 'single' | 'contacts'
  sessionIds?: string[]
  sessionId?: string
  outputDir?: string
  outputPath?: string
  options?: any
  taskId?: string
  dbPath?: string
  sessionDbPath?: string
  decryptKey?: string
  myAccountId?: string
  accountDir?: string
  imageXorKey?: unknown
  imageAesKey?: string
  resourcesPath?: string
  userDataPath?: string
  cachePath?: string
  emojiCacheDir?: string
  logEnabled?: boolean
  isPackaged?: boolean
  welivePath?: string
  weliveArgsPrefix?: string[]
  wcdbLibPath?: string
}

const config = workerData as ExportWorkerConfig
const controlState = {
  pauseRequested: false,
  stopRequested: false
}
const weliveAbortController = new AbortController()

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
    weliveAbortController.abort()
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

// 消息导出强制走 WeLive 引擎（不提供 legacy 回退开关）；
// 联系人导出不是消息导出，由 worker 内置流程独立处理。

const normalizeImageXorKey = (value: unknown): string | number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value ?? '').trim()
  return text ? text : undefined
}

const resolveEmojiCacheDir = () => {
  const path = require('path') as typeof import('path')
  const explicit = String(config.emojiCacheDir || '').trim()
  if (explicit) return explicit
  const configured = String(config.cachePath || '').trim()
  if (configured) return path.join(configured, 'Emojis')
  const userDataPath = String(config.userDataPath || '').trim()
  if (userDataPath) return path.join(userDataPath, 'Emojis')
  return undefined
}

const resolveWeliveSessionDb = () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const explicit = String(config.sessionDbPath || '').trim()
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit

  const dbPath = String(config.dbPath || '').trim()
  if (dbPath && fs.existsSync(dbPath) && fs.statSync(dbPath).isFile()) return dbPath

  const accountDir = String(config.accountDir || '').trim()
  const candidates = [
    accountDir ? path.join(accountDir, 'db_storage', 'session', 'session.db') : '',
    accountDir ? path.join(accountDir, 'db_storage', 'session.db') : '',
    dbPath ? path.join(dbPath, 'db_storage', 'session', 'session.db') : '',
    dbPath ? path.join(dbPath, 'db_storage', 'session.db') : ''
  ].filter(Boolean)

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  }) || dbPath
}

const mapWeliveEventToProgress = (event: WeliveExportEvent): any | null => {
  if (event.type !== 'progress' && event.type !== 'ready') return null
  const total = Math.max(0, Number((event as any).total || 0))
  const current = Math.max(0, Number((event as any).current || 0))
  const backendPhase = event.type === 'ready' ? 'ready' : String((event as any).phase || '')
  const exportedMessages = Math.max(0, Number((event as any).exported_messages ?? 0))
  const estimatedTotalMessages = Math.max(0, Number((event as any).estimated_total_messages ?? 0))
  const phaseProgress = Math.max(0, Number((event as any).phase_progress ?? exportedMessages))
  const phaseTotal = Math.max(0, Number((event as any).phase_total ?? estimatedTotalMessages))
  const sessionRatio = phaseTotal > 0
    ? Math.max(0, Math.min(0.98, phaseProgress / phaseTotal))
    : 0
  const displayCurrent = backendPhase === 'complete'
    ? current
    : current + sessionRatio
  const phase = backendPhase === 'formatting'
    ? 'writing'
    : backendPhase === 'complete'
      ? 'complete'
      : backendPhase === 'ready' || backendPhase === 'loading' || backendPhase === 'initializing' || backendPhase === 'opening_account' || backendPhase === 'counting'
        ? 'preparing'
        : backendPhase === 'parsing' || backendPhase === 'parsed'
          ? 'exporting-media'
          : 'exporting'
  const fallbackLabel = event.type === 'ready'
    ? 'WeLive 导出引擎已启动'
    : phase === 'writing'
      ? 'WeLive 正在写入导出格式'
      : phase === 'preparing'
        ? 'WeLive 正在准备导出'
        : phase === 'exporting-media'
          ? 'WeLive 正在解析消息与媒体'
          : 'WeLive 正在读取消息'

  return {
    current: Number(displayCurrent.toFixed(3)),
    total,
    currentSession: String((event as any).session_id || ''),
    currentSessionId: String((event as any).session_id || ''),
    phase,
    phaseProgress,
    phaseTotal,
    collectedMessages: exportedMessages,
    exportedMessages,
    estimatedTotalMessages,
    phaseLabel: String((event as any).label || '').trim() || fallbackLabel
  }
}

const cleanupTempDir = async (dirPath: string) => {
  const fs = require('fs') as typeof import('fs')
  const normalized = String(dirPath || '').trim()
  if (!normalized) return
  try {
    await fs.promises.rm(normalized, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150
    })
  } catch (error) {
    console.warn('[exportWorker] 清理临时导出目录失败，已忽略:', normalized, error)
  }
}

interface DirectoryTreeSnapshot {
  root: string
  files: Set<string>
  dirs: Set<string>
}

const normalizeSnapshotPath = (value: string) => {
  const path = require('path') as typeof import('path')
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const snapshotDirectoryTree = (rootPath: string): DirectoryTreeSnapshot => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const root = path.resolve(rootPath)
  const snapshot: DirectoryTreeSnapshot = { root, files: new Set(), dirs: new Set() }
  if (!fs.existsSync(root)) return snapshot

  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    snapshot.dirs.add(normalizeSnapshotPath(current))
    let entries: import('fs').Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
      } else {
        snapshot.files.add(normalizeSnapshotPath(entryPath))
      }
    }
  }
  return snapshot
}

const recordNewDirectoryTreeEntries = (before: DirectoryTreeSnapshot) => {
  const after = snapshotDirectoryTree(before.root)
  for (const filePath of after.files) {
    if (!before.files.has(filePath)) queueCreatedFile(filePath)
  }
  for (const dirPath of after.dirs) {
    if (!before.dirs.has(dirPath)) queueCreatedDir(dirPath)
  }
}

async function runWeliveEngine() {
  const path = require('path') as typeof import('path')
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const { exportService } = await import('./services/export')
  const { wcdbService } = await import('./services/wcdbService')
  const {
    buildSessionExportBaseName,
    normalizeExportConflictStrategy,
    reserveUniqueOutputPath
  } = await import('./services/export/utils/fileNaming')
  const sessionIds = config.mode === 'single'
    ? [String(config.sessionId || '').trim()].filter(Boolean)
    : (Array.isArray(config.sessionIds) ? config.sessionIds : []).map((id) => String(id || '').trim()).filter(Boolean)
  const outputDir = String(config.outputDir || (config.outputPath ? path.dirname(config.outputPath) : '') || '').trim()
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-welive-raw-'))

  exportService.setRuntimeConfig({
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    myAccountId: config.myAccountId,
    accountDir: config.accountDir,
    imageXorKey: config.imageXorKey,
    imageAesKey: config.imageAesKey,
    resourcesPath: config.resourcesPath,
    appPath: config.resourcesPath ? path.dirname(config.resourcesPath) : __dirname,
    isPackaged: config.isPackaged
  })
  wcdbService.setPaths(String(config.resourcesPath || ''), String(config.userDataPath || ''))
  wcdbService.setLibPath(String(config.wcdbLibPath || ''))
  wcdbService.setLogEnabled(config.logEnabled === true)

  const options = config.options || { format: 'json' }
  const normalizedOptions = exportService.context.normalizeExportOptionsForRun(options)
  const effectiveOptions = exportService.context.isMediaContentBatchExport(normalizedOptions)
    ? { ...normalizedOptions, exportVoiceAsText: false }
    : normalizedOptions
  await exportService.context.ensureConnected().catch(() => null)
  const exportMediaEnabled = exportService.context.isMediaExportEnabled(effectiveOptions)
  const writeLayout = exportService.context.resolveExportWriteLayout(effectiveOptions)
  const exportBaseDir = writeLayout === 'A'
    ? path.join(outputDir, 'texts')
    : outputDir
  const sessionLayout = exportMediaEnabled
    ? (effectiveOptions.sessionLayout ?? 'per-session')
    : 'shared'
  const reservedOutputPaths = new Set<string>()
  const rawExportsDir = path.join(rawRoot, 'exports')

  const getFormatExtension = (format: string) => {
    if (format === 'chatlab-jsonl') return '.jsonl'
    if (format === 'excel') return '.xlsx'
    if (format === 'txt') return '.txt'
    if (format === 'markdown') return '.md'
    if (format === 'weclone') return '.csv'
    if (format === 'html') return '.html'
    if (format === 'sql') return '.sql'
    return '.json'
  }
  const resolveFinalOutputPath = async (sessionId: string) => {
    if (config.mode === 'single' && String(config.outputPath || '').trim()) {
      return String(config.outputPath || '').trim()
    }
    const sessionInfo = await exportService.context.getContactInfo(sessionId)
    const safeName = buildSessionExportBaseName(sessionId, sessionInfo.displayName || sessionId, effectiveOptions)
    const sessionNameWithTypePrefix = effectiveOptions.sessionNameWithTypePrefix !== false
    const sessionTypePrefix = sessionNameWithTypePrefix ? await exportService.context.getSessionFilePrefix(sessionId) : ''
    const fileNameWithPrefix = `${sessionTypePrefix}${safeName}`
    const useSessionFolder = sessionLayout === 'per-session'
    const sessionDirName = sessionNameWithTypePrefix ? `${sessionTypePrefix}${safeName}` : safeName
    const sessionDir = useSessionFolder ? path.join(exportBaseDir, sessionDirName) : exportBaseDir
    const preferredOutputPath = path.join(sessionDir, `${fileNameWithPrefix}${getFormatExtension(String(effectiveOptions.format || 'json'))}`)
    return normalizeExportConflictStrategy(effectiveOptions.exportConflictStrategy) === 'rename'
      ? reserveUniqueOutputPath(preferredOutputPath, reservedOutputPaths)
      : preferredOutputPath
  }

  const finalOutputPaths: Record<string, string> = {}
  const mediaDirs: Record<string, string | undefined> = {}
  const mediaTypes = [
    effectiveOptions.exportImages ? 'image' : '',
    effectiveOptions.exportVoices ? 'voice' : '',
    effectiveOptions.exportVideos ? 'video' : '',
    effectiveOptions.exportEmojis ? 'emoji' : '',
    effectiveOptions.exportFiles ? 'file' : ''
  ].filter(Boolean) as Array<'image' | 'voice' | 'video' | 'emoji' | 'file'>
  for (const sessionId of sessionIds) {
    const finalOutputPath = await resolveFinalOutputPath(sessionId)
    finalOutputPaths[sessionId] = finalOutputPath
    const mediaLayout = exportService.context.getMediaLayout(finalOutputPath, effectiveOptions)
    mediaDirs[sessionId] = mediaLayout.exportMediaEnabled
      ? path.resolve(path.join(mediaLayout.mediaRootDir, mediaLayout.mediaRelativePrefix))
      : undefined
  }
  const mediaDirectorySnapshots = Array.from(new Set(
    Object.values(mediaDirs).map((value) => String(value || '').trim()).filter(Boolean)
  )).map(snapshotDirectoryTree)
  const recordNewMediaArtifacts = () => {
    for (const snapshot of mediaDirectorySnapshots) recordNewDirectoryTreeEntries(snapshot)
  }

  const rawSessionOutputPaths: Record<string, string> = {}
  const rawExportManifests: Record<string, WeliveRawExportManifest> = {}
  const failedSessionIds: string[] = []
  const failedSessionErrors: Record<string, string> = {}
  const failedSessionIdSet = new Set<string>()
  const markRawSessionFailed = (sessionId: string, error: unknown) => {
    if (!failedSessionIdSet.has(sessionId)) {
      failedSessionIdSet.add(sessionId)
      failedSessionIds.push(sessionId)
    }
    failedSessionErrors[sessionId] = String(error || 'WeLive export failed')
  }

  // 纯文本导出可以在一个 WeLive 进程中复用账号连接和消息分库缓存。
  // 媒体导出需要每个会话独立的 mediaDir，仍维持单会话进程。
  const WELIVE_TEXT_SESSION_CHUNK_SIZE = 100
  const rawChunkSize = exportMediaEnabled ? 1 : WELIVE_TEXT_SESSION_CHUNK_SIZE
  for (let chunkStart = 0; chunkStart < sessionIds.length; chunkStart += rawChunkSize) {
    const chunkSessionIds = sessionIds.slice(chunkStart, chunkStart + rawChunkSize)
    const firstChunkSessionId = chunkSessionIds[0] || ''
    const result = await runWeliveExport({
      resourcesPath: String(config.resourcesPath || ''),
      appPath: config.resourcesPath ? path.dirname(config.resourcesPath) : __dirname,
      welivePath: config.welivePath,
      weliveArgsPrefix: Array.isArray(config.weliveArgsPrefix) ? config.weliveArgsPrefix : undefined,
      signal: weliveAbortController.signal,
      request: {
        account: {
          sessionDb: resolveWeliveSessionDb(),
          dbKey: String(config.decryptKey || '').trim(),
          myAccountId: String(config.myAccountId || '').trim() || undefined,
          accountDir: String(config.accountDir || '').trim() || undefined,
          imageXorKey: normalizeImageXorKey(config.imageXorKey),
          imageAesKey: String(config.imageAesKey || '').trim() || undefined
        },
        sessionIds: chunkSessionIds,
        outputDir,
        exportsDir: rawExportsDir,
        mediaDir: chunkSessionIds.length === 1 ? mediaDirs[firstChunkSessionId] : undefined,
        mediaTypes,
        emojiCacheDir: resolveEmojiCacheDir(),
        format: 'raw-jsonl',
        parseContent: true,
        preserveMessageContent: true,
        compactRaw: true,
        sanitize: config.options?.sanitize === true,
        batchSize: Number(config.options?.batchSize || 20_000),
        ascending: config.options?.ascending !== false,
        options: { ...effectiveOptions }
      },
      onEvent: (event) => {
        const createdPath = String((event as any).path || '').trim()
        const isTempWelivePath = createdPath && path.resolve(createdPath).startsWith(path.resolve(rawRoot))
        if (event.type === 'created_file' && createdPath && !isTempWelivePath) queueCreatedFile(createdPath)
        if (event.type === 'created_dir' && createdPath && !isTempWelivePath) queueCreatedDir(createdPath)
        const backendPhase = event.type === 'ready' ? 'ready' : String((event as any).phase || '')
        const eventSessionId = String((event as any).session_id || '').trim()
        const fallbackLocalIndex = Math.max(0, chunkSessionIds.indexOf(eventSessionId))
        const backendCurrent = Number((event as any).current)
        const localCurrent = Number.isFinite(backendCurrent)
          ? Math.max(0, backendCurrent)
          : (backendPhase === 'complete' ? fallbackLocalIndex + 1 : fallbackLocalIndex)
        const normalizedEvent = (event.type === 'progress' || event.type === 'ready')
          ? {
              ...(event as any),
              total: sessionIds.length,
              current: Math.min(sessionIds.length, chunkStart + localCurrent),
              session_id: eventSessionId || chunkSessionIds[fallbackLocalIndex] || firstChunkSessionId
            }
          : event
        const progress = mapWeliveEventToProgress(normalizedEvent as WeliveExportEvent)
        if (progress) queueProgress(progress)
      }
    })

    if (result.stopped || controlState.stopRequested) {
      recordNewMediaArtifacts()
      await cleanupTempDir(rawRoot)
      return {
        success: true,
        stopped: true,
        successCount: 0,
        failCount: 0,
        failedSessionIds: [],
        failedSessionErrors: {},
        sessionOutputPaths: {},
        rawSessionStats: {},
        rawFailedSessionIds: [],
        formattedFailedSessionIds: []
      }
    }

    for (const sessionId of chunkSessionIds) {
      const rawOutputPath = String(
        result.rawSessionOutputPaths?.[sessionId] ||
        result.sessionOutputPaths?.[sessionId] ||
        ''
      ).trim()
      const manifest = result.rawExportManifests?.[sessionId]
      const hasValidManifest = Boolean(
        manifest &&
        Number.isSafeInteger(Number(manifest.rows)) && Number(manifest.rows) >= 0 &&
        Number.isSafeInteger(Number(manifest.bytes)) && Number(manifest.bytes) >= 0
      )
      if (rawOutputPath && hasValidManifest) {
        rawSessionOutputPaths[sessionId] = rawOutputPath
        rawExportManifests[sessionId] = {
          ...manifest!,
          path: String(manifest!.path || rawOutputPath),
          rows: Number(manifest!.rows),
          bytes: Number(manifest!.bytes)
        }
        continue
      }
      markRawSessionFailed(
        sessionId,
        result.failedSessionErrors?.[sessionId] ||
        result.error ||
        (rawOutputPath ? 'WeLive 未返回该会话的完整性清单' : 'WeLive 未返回该会话的原始导出文件')
      )
    }
  }

  const rawSuccessSessionIds = sessionIds.filter((sessionId) => Boolean(rawSessionOutputPaths[sessionId]))
  const rawSessionStats = Object.fromEntries(rawSuccessSessionIds.map((sessionId) => {
    const manifest = rawExportManifests[sessionId]
    return [sessionId, {
      rows: Number(manifest?.rows || 0),
      bytes: Number(manifest?.bytes || 0),
      mediaFailures: [
        manifest?.images_failed,
        manifest?.voices_failed,
        manifest?.videos_failed,
        manifest?.emojis_failed,
        manifest?.files_failed
      ].reduce<number>((sum, value) => sum + Number(value || 0), 0)
    }]
  }))
  if (rawSuccessSessionIds.length === 0) {
    await cleanupTempDir(rawRoot)
    return {
      success: false,
      successCount: 0,
      failCount: failedSessionIds.length,
      failedSessionIds,
      failedSessionErrors,
      sessionOutputPaths: {},
      rawSessionStats,
      rawFailedSessionIds: [...failedSessionIds],
      formattedFailedSessionIds: [],
      error: failedSessionIds.map((id) => `${id}: ${failedSessionErrors[id]}`).join('; ')
    }
  }

  exportService.setWeliveRawExportPaths(rawSessionOutputPaths, rawExportManifests)

  const taskControl = config.taskId
    ? {
        shouldPause: () => controlState.pauseRequested,
        shouldStop: () => controlState.stopRequested,
        recordCreatedFile: queueCreatedFile,
        recordCreatedDir: queueCreatedDir
      }
    : undefined

  try {
    if (config.mode === 'single') {
      const sessionId = String(config.sessionId || '').trim()
      const outputPath = String(config.outputPath || '').trim()
      const options = config.options || { format: 'chatlab' }
      const format = String(options.format || 'chatlab')
      if (format === 'json' || format === 'arkme-json') {
        return await exportService.orchestrator.exportSessionToDetailedJson(sessionId, outputPath, options, queueProgress, taskControl)
      }
      if (format === 'excel') {
        return await exportService.orchestrator.exportSessionToExcel(sessionId, outputPath, options, queueProgress, taskControl)
      }
      if (format === 'txt') {
        return await exportService.orchestrator.exportSessionToTxt(sessionId, outputPath, options, queueProgress, taskControl)
      }
      if (format === 'markdown') {
        return await exportService.orchestrator.exportSessionToMarkdown(sessionId, outputPath, options, queueProgress, taskControl)
      }
      if (format === 'weclone') {
        return await exportService.orchestrator.exportSessionToWeCloneCsv(sessionId, outputPath, options, queueProgress, taskControl)
      }
      if (format === 'html') {
        return await exportService.orchestrator.exportSessionToHtml(sessionId, outputPath, options, queueProgress, taskControl)
      }
      if (format === 'sql') {
        return await exportService.orchestrator.exportSessionToSql(sessionId, outputPath, options, queueProgress, taskControl)
      }
      return await exportService.orchestrator.exportSessionToChatLab(sessionId, outputPath, options, queueProgress, taskControl)
    }

    const formatProgress = failedSessionIds.length > 0
      ? (progress: any) => queueProgress({
          ...progress,
          current: Math.min(
            sessionIds.length,
            failedSessionIds.length + Math.max(0, Number(progress?.current || 0))
          ),
          total: sessionIds.length
        })
      : queueProgress
    const formattedResult = await exportService.exportSessions(
      rawSuccessSessionIds,
      outputDir,
      config.options || { format: 'json' },
      formatProgress,
      taskControl
    )
    const formattedFailedSessionIds = Array.isArray(formattedResult.failedSessionIds)
      ? formattedResult.failedSessionIds
      : []
    const combinedFailedSessionIds = Array.from(new Set([
      ...failedSessionIds,
      ...formattedFailedSessionIds
    ]))
    const combinedFailedSessionErrors = {
      ...failedSessionErrors,
      ...(formattedResult.failedSessionErrors || {})
    }
    const successSessionIds = Array.isArray(formattedResult.successSessionIds)
      ? formattedResult.successSessionIds
      : []
    const skippedSessionIds = Array.isArray(formattedResult.skippedSessionIds)
      ? formattedResult.skippedSessionIds
      : []
    const successCount = Math.max(0, Number(formattedResult.successCount || successSessionIds.length))
    const handledCount = successCount + skippedSessionIds.length
    const success = formattedResult.paused || formattedResult.stopped
      ? formattedResult.success !== false
      : combinedFailedSessionIds.length === 0 && handledCount === sessionIds.length

    return {
      ...formattedResult,
      success,
      successCount,
      failCount: combinedFailedSessionIds.length,
      successSessionIds,
      failedSessionIds: combinedFailedSessionIds,
      failedSessionErrors: combinedFailedSessionErrors,
      rawSessionStats,
      rawFailedSessionIds: [...failedSessionIds],
      formattedFailedSessionIds: [...formattedFailedSessionIds],
      error: success
        ? undefined
        : (formattedResult.error || combinedFailedSessionIds.map((id) => `${id}: ${combinedFailedSessionErrors[id] || '导出失败'}`).join('; '))
    }
  } finally {
    if (controlState.stopRequested) recordNewMediaArtifacts()
    exportService.clearWeliveRawExportPaths()
    await cleanupTempDir(rawRoot)
  }
}

async function runContactExport() {
  const [{ wcdbService }, { contactExportService }, { chatService }] = await Promise.all([
    import('./services/wcdbService'),
    import('./services/contactExportService'),
    import('./services/chatService')
  ])

  wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
  wcdbService.setLibPath(config.wcdbLibPath || '')
  wcdbService.setLogEnabled(config.logEnabled === true)
  chatService.setRuntimeConfig({
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    myAccountId: config.myAccountId,
    resourcesPath: config.resourcesPath,
    appPath: config.resourcesPath ? require('path').dirname(config.resourcesPath) : __dirname,
    isPackaged: config.isPackaged
  })
  const result = await contactExportService.exportContacts(
    String(config.outputDir || ''),
    config.options || {}
  )

  flushProgress()
  flushCreatedPaths()

  parentPort?.postMessage({
    type: 'export:result',
    data: result
  })
}

async function run() {
  if (config.mode === 'contacts') {
    await runContactExport()
    return
  }

  const result = await runWeliveEngine()
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
