import { BrowserWindow, app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { copyFile, link, readFile as readFileAsync, mkdtemp, writeFile } from 'fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { tmpdir } from 'os'
import * as tar from 'tar'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { expandHomePath } from '../utils/pathUtils'

type BackupDbKind = 'session' | 'contact' | 'emoticon' | 'message' | 'media' | 'sns' | 'hardlink'
type BackupPhase = 'preparing' | 'scanning' | 'exporting' | 'packing' | 'inspecting' | 'restoring' | 'done' | 'failed'
type BackupResourceKind = 'image' | 'video' | 'file'
const TEMP_MARKER = '.weflow-backup-temp'
const TEMP_TTL_MS = 24 * 60 * 60 * 1000

export interface BackupOptions {
  includeImages?: boolean
  includeVideos?: boolean
  includeFiles?: boolean
}

interface BackupDbEntry {
  id: string
  kind: BackupDbKind
  dbPath: string
  relativePath: string
  tables: BackupTableEntry[]
}

interface BackupTableEntry {
  name: string
  snapshotPath: string
  rows: number
  columns: number
  schemaSql?: string
}

interface BackupResourceEntry {
  kind: BackupResourceKind
  id: string
  md5?: string
  sessionId?: string
  createTime?: number
  sourceFileName?: string
  archivePath: string
  targetRelativePath: string
  ext?: string
  size?: number
}

interface BackupManifest {
  version: 1
  type: 'weflow-db-snapshots'
  createdAt: string
  appVersion: string
  source: {
    wxid: string
    dbRoot: string
  }
  databases: BackupDbEntry[]
  options?: BackupOptions
  resources?: {
    images?: BackupResourceEntry[]
    videos?: BackupResourceEntry[]
    files?: BackupResourceEntry[]
  }
}

interface BackupProgress {
  phase: BackupPhase
  message: string
  current?: number
  total?: number
  detail?: string
}

function emitBackupProgress(progress: BackupProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('backup:progress', progress)
    }
  }
}

function safeName(value: string): string {
  return encodeURIComponent(value || 'unnamed').replace(/%/g, '_')
}

function toArchivePath(path: string): string {
  return path.split(sep).join('/')
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(ms = 0): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function createThrottledProgressEmitter(minIntervalMs = 120): (progress: BackupProgress, force?: boolean) => void {
  let lastEmitAt = 0
  return (progress: BackupProgress, force = false) => {
    const now = Date.now()
    if (!force && now - lastEmitAt < minIntervalMs) return
    lastEmitAt = now
    emitBackupProgress(progress)
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await worker(items[index], index)
      if (index % 50 === 0) await delay()
    }
  }))
}

function hasResourceOptions(options: BackupOptions): boolean {
  return options.includeImages === true || options.includeVideos === true || options.includeFiles === true
}

function normalizeArchivePath(value: string): string {
  return String(value || '').replace(/\\/g, '/')
}

export class BackupService {
  private configService = new ConfigService()
  private cleanedTempDirs = false

  private cleanupStaleTempDirs(): void {
    if (this.cleanedTempDirs) return
    this.cleanedTempDirs = true
    const root = tmpdir()
    const now = Date.now()
    try {
      for (const entry of readdirSync(root)) {
        if (!entry.startsWith('weflow-backup-')) continue
        const dir = join(root, entry)
        const marker = join(dir, TEMP_MARKER)
        try {
          const stat = statSync(dir)
          if (!stat.isDirectory()) continue
          if (!existsSync(marker)) continue
          const age = now - stat.mtimeMs
          if (age < TEMP_TTL_MS) continue
          rmSync(dir, { recursive: true, force: true })
        } catch {}
      }
    } catch {}
  }

  private async createTempDir(prefix: string): Promise<string> {
    this.cleanupStaleTempDirs()
    const dir = await mkdtemp(join(tmpdir(), prefix))
    await writeFile(join(dir, TEMP_MARKER), String(Date.now()), 'utf8')
    return dir
  }

  private buildWxidCandidates(wxid: string): string[] {
    const wxidCandidates = Array.from(new Set([
      String(wxid || '').trim(),
      this.cleanAccountDirName(wxid)
    ].filter(Boolean)))
    return wxidCandidates
  }

  private isCurrentAccountDir(accountDir: string, wxidCandidates: string[]): boolean {
    const accountName = basename(accountDir).toLowerCase()
    return wxidCandidates
      .map(item => item.toLowerCase())
      .some(wxid => accountName === wxid || accountName.startsWith(`${wxid}_`))
  }

  private normalizeExistingPath(inputPath: string): string {
    const expanded = expandHomePath(String(inputPath || '').trim()).replace(/[\\/]+$/, '')
    if (!expanded) return expanded
    try {
      if (existsSync(expanded) && statSync(expanded).isFile()) {
        return dirname(expanded)
      }
    } catch {}
    return expanded
  }

  private resolveAncestorDbStorage(normalized: string, wxidCandidates: string[]): string | null {
    let current = normalized
    for (let i = 0; i < 8; i += 1) {
      if (!current) break
      if (basename(current).toLowerCase() === 'db_storage') {
        const accountDir = dirname(current)
        if (this.isCurrentAccountDir(accountDir, wxidCandidates) && existsSync(current)) {
          return current
        }
      }
      const parent = dirname(current)
      if (!parent || parent === current) break
      current = parent
    }
    return null
  }

  private resolveCurrentAccountDbStorageFromRoot(rootPath: string, wxidCandidates: string[]): string | null {
    if (!rootPath || !existsSync(rootPath)) return null

    for (const candidateWxid of wxidCandidates) {
      const viaWxid = join(rootPath, candidateWxid, 'db_storage')
      if (existsSync(viaWxid)) return viaWxid
    }

    try {
      const entries = readdirSync(rootPath)
      const loweredWxids = wxidCandidates.map(item => item.toLowerCase())
      for (const entry of entries) {
        const entryPath = join(rootPath, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
        } catch {
          continue
        }
        const lowerEntry = entry.toLowerCase()
        if (!loweredWxids.some(id => lowerEntry === id || lowerEntry.startsWith(`${id}_`))) continue
        const candidate = join(entryPath, 'db_storage')
        if (existsSync(candidate)) return candidate
      }
    } catch {}

    return null
  }

  private resolveDbStoragePath(dbPath: string, wxid: string): string | null {
    const normalized = this.normalizeExistingPath(dbPath)
    if (!normalized) return null

    const wxidCandidates = this.buildWxidCandidates(wxid)
    const ancestor = this.resolveAncestorDbStorage(normalized, wxidCandidates)
    if (ancestor) return ancestor

    const direct = join(normalized, 'db_storage')
    if (existsSync(direct) && this.isCurrentAccountDir(normalized, wxidCandidates)) return direct

    const roots = Array.from(new Set([
      normalized,
      join(normalized, 'WeChat Files'),
      join(normalized, 'xwechat_files')
    ]))
    for (const root of roots) {
      const dbStorage = this.resolveCurrentAccountDbStorageFromRoot(root, wxidCandidates)
      if (dbStorage) return dbStorage
    }

    return null
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const dbStorage = this.resolveDbStoragePath(dbPath, wxid)
    return dbStorage ? dirname(dbStorage) : null
  }

  private cleanAccountDirName(wxid: string): string {
    const trimmed = String(wxid || '').trim()
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      return match?.[1] || trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
  }

  private async listFilesForArchive(root: string, rel = '', state = { visited: 0 }): Promise<string[]> {
    const dir = join(root, rel)
    const files: string[] = []
    for (const entry of readdirSync(dir)) {
      const entryRel = rel ? join(rel, entry) : entry
      const entryPath = join(root, entryRel)
      try {
        const stat = statSync(entryPath)
        if (stat.isDirectory()) {
          files.push(...await this.listFilesForArchive(root, entryRel, state))
        } else if (stat.isFile()) {
          files.push(toArchivePath(entryRel))
        }
        state.visited += 1
        if (state.visited % 200 === 0) await delay()
      } catch {}
    }
    return files
  }

  private resolveExtractedPath(extractDir: string, archivePath: string): string | null {
    const normalized = normalizeArchivePath(archivePath)
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null
    const root = resolve(extractDir)
    const target = resolve(join(extractDir, normalized))
    if (target !== root && !target.startsWith(`${root}${sep}`)) return null
    return target
  }

  private resolveStagingPath(stagingDir: string, archivePath: string): string | null {
    return this.resolveExtractedPath(stagingDir, archivePath)
  }

  private resolveTargetResourcePath(accountDir: string, relativePath: string): string | null {
    const normalized = normalizeArchivePath(relativePath)
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null
    const root = resolve(accountDir)
    const target = resolve(join(accountDir, normalized))
    if (target !== root && !target.startsWith(`${root}${sep}`)) return null
    return target
  }

  private isSafeAccountRelativePath(accountDir: string, filePath: string): string | null {
    const rel = toArchivePath(relative(accountDir, filePath))
    if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null
    return rel
  }

  private async listFilesUnderDir(root: string, state = { visited: 0 }): Promise<string[]> {
    const files: string[] = []
    if (!existsSync(root)) return files
    try {
      for (const entry of readdirSync(root)) {
        const fullPath = join(root, entry)
        let stat
        try {
          stat = statSync(fullPath)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          files.push(...await this.listFilesUnderDir(fullPath, state))
        } else if (stat.isFile()) {
          files.push(fullPath)
        }
        state.visited += 1
        if (state.visited % 300 === 0) await delay()
      }
    } catch {}
    return files
  }

  private async stagePlainResource(sourcePath: string, outputPath: string): Promise<void> {
    mkdirSync(dirname(outputPath), { recursive: true })
    try {
      await link(sourcePath, outputPath)
    } catch {
      await copyFile(sourcePath, outputPath)
    }
  }

  private async writeTarEntryToFile(entry: any, outputPath: string): Promise<void> {
    mkdirSync(dirname(outputPath), { recursive: true })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const out = createWriteStream(outputPath)
      const fail = (error: unknown) => rejectPromise(error instanceof Error ? error : new Error(String(error)))
      out.on('finish', resolvePromise)
      out.on('error', fail)
      entry.on('error', fail)
      entry.pipe(out)
    })
  }

  private async listChatImageDatFiles(accountDir: string): Promise<string[]> {
    const attachRoot = join(accountDir, 'msg', 'attach')
    const result: string[] = []
    if (!existsSync(attachRoot)) return result

    const scanImgDir = async (imgDir: string): Promise<void> => {
      let entries: string[] = []
      try {
        entries = readdirSync(imgDir)
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = join(imgDir, entry)
        let stat
        try {
          stat = statSync(fullPath)
        } catch {
          continue
        }
        if (stat.isFile() && entry.toLowerCase().endsWith('.dat')) {
          result.push(fullPath)
        } else if (stat.isDirectory()) {
          let nestedEntries: string[] = []
          try {
            nestedEntries = readdirSync(fullPath)
          } catch {
            continue
          }
          for (const nestedEntry of nestedEntries) {
            const nestedPath = join(fullPath, nestedEntry)
            try {
              if (statSync(nestedPath).isFile() && nestedEntry.toLowerCase().endsWith('.dat')) {
                result.push(nestedPath)
              }
            } catch {}
          }
        }
        if (result.length > 0 && result.length % 500 === 0) await delay()
      }
    }

    const walk = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: () => boolean }> = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const child = join(dir, entry.name)
        if (entry.name.toLowerCase() === 'img') {
          await scanImgDir(child)
        } else {
          await walk(child)
        }
        if (result.length > 0 && result.length % 500 === 0) await delay()
      }
    }

    await walk(attachRoot)
    return Array.from(new Set(result))
  }

  private async ensureConnected(wxidOverride?: string): Promise<{ success: boolean; wxid?: string; dbPath?: string; dbStorage?: string; error?: string }> {
    const configuredWxid = String(this.configService.get('myWxid') || '').trim()
    const wxid = String(wxidOverride || configuredWxid || '').trim()
    const dbPath = String(this.configService.get('dbPath') || '').trim()
    const decryptKey = String(this.configService.get('decryptKey') || '').trim()
    if (!wxid || !dbPath) return { success: false, error: '请先配置数据库路径和微信账号' }
    if (!decryptKey) return { success: false, error: '请先配置数据库解密密钥' }

    // 使用 ConfigService 统一解析账号目录
    const accountDir = this.configService.getAccountDir(dbPath, wxid)
    if (!accountDir) return { success: false, error: `未在配置的 dbPath 下找到账号目录：${wxid}` }
    const dbStorage = join(accountDir, 'db_storage')
    if (!existsSync(dbStorage)) return { success: false, error: '未找到 db_storage 目录' }

    const opened = await withTimeout(
      wcdbService.open(accountDir, decryptKey),
      15000,
      '连接目标账号数据库超时，请检查数据库路径、密钥是否正确'
    )
    if (!opened) {
      const detail = await wcdbService.getLastInitError().catch(() => null)
      return { success: false, error: detail || `目标账号 ${accountDirName} 数据库连接失败` }
    }

    return { success: true, wxid: accountDirName, dbPath, dbStorage }
  }

  private buildDbId(kind: BackupDbKind, index: number, dbPath: string): string {
    if (kind === 'session' || kind === 'contact' || kind === 'emoticon' || kind === 'sns' || kind === 'hardlink') return kind
    return `${kind}-${index}-${safeName(basename(dbPath)).slice(0, 80)}`
  }

  private toDbRelativePath(dbStorage: string, dbPath: string): string {
    const rel = toArchivePath(relative(dbStorage, dbPath))
    if (!rel || rel.startsWith('..') || rel.startsWith('/')) return basename(dbPath)
    return rel
  }

  private resolveTargetDbPath(dbStorage: string, relativePath: string): string | null {
    const normalized = String(relativePath || '').replace(/\\/g, '/')
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null
    const root = resolve(dbStorage)
    const target = resolve(join(dbStorage, normalized))
    if (target !== root && !target.startsWith(`${root}${sep}`)) return null
    return target
  }

  private defaultRelativeDbPath(kind: BackupDbKind): string | null {
    if (kind === 'session') return 'session/session.db'
    if (kind === 'contact') return 'contact/contact.db'
    if (kind === 'emoticon') return 'emoticon/emoticon.db'
    if (kind === 'sns') return 'sns/sns.db'
    if (kind === 'hardlink') return 'hardlink/hardlink.db'
    return null
  }

  private resolveRestoreTargetDbPath(dbStorage: string, db: BackupDbEntry): string | null {
    const normalized = String(db.relativePath || '').replace(/\\/g, '/')
    const legacyFixedPath = this.defaultRelativeDbPath(db.kind)
    if (legacyFixedPath && (!normalized.includes('/') || !normalized.toLowerCase().endsWith('.db'))) {
      return this.resolveTargetDbPath(dbStorage, legacyFixedPath)
    }
    return this.resolveTargetDbPath(dbStorage, db.relativePath)
  }

  private findFirstExisting(paths: string[]): string {
    for (const path of paths) {
      try {
        if (existsSync(path) && statSync(path).isFile()) return path
      } catch {}
    }
    return ''
  }

  private resolveKnownDbPath(kind: BackupDbKind, dbStorage: string): string {
    if (kind === 'session') {
      return this.findFirstExisting([
        join(dbStorage, 'session', 'session.db'),
        join(dbStorage, 'Session', 'session.db'),
        join(dbStorage, 'session.db')
      ])
    }
    if (kind === 'contact') {
      return this.findFirstExisting([
        join(dbStorage, 'Contact', 'contact.db'),
        join(dbStorage, 'Contact', 'Contact.db'),
        join(dbStorage, 'contact', 'contact.db'),
        join(dbStorage, 'session', 'contact.db')
      ])
    }
    if (kind === 'emoticon') {
      return this.findFirstExisting([
        join(dbStorage, 'emoticon', 'emoticon.db'),
        join(dbStorage, 'emotion', 'emoticon.db')
      ])
    }
    if (kind === 'sns') {
      return this.findFirstExisting([
        join(dbStorage, 'sns', 'sns.db'),
        join(dirname(dbStorage), 'sns', 'sns.db')
      ])
    }
    if (kind === 'hardlink') {
      return this.findFirstExisting([
        join(dbStorage, 'hardlink', 'hardlink.db'),
        join(dbStorage, 'hardlink.db'),
        join(dirname(dbStorage), 'hardlink.db')
      ])
    }
    return ''
  }

  private async collectDatabases(dbStorage: string): Promise<Array<Omit<BackupDbEntry, 'tables'>>> {
    const result: Array<Omit<BackupDbEntry, 'tables'>> = []
    for (const kind of ['session', 'contact', 'emoticon', 'sns', 'hardlink'] as const) {
      const dbPath = this.resolveKnownDbPath(kind, dbStorage)
      result.push({
        id: kind,
        kind,
        dbPath,
        relativePath: dbPath ? this.toDbRelativePath(dbStorage, dbPath) : kind
      })
    }

    const messageDbs = await wcdbService.listMessageDbs()
    if (messageDbs.success && Array.isArray(messageDbs.data)) {
      messageDbs.data.forEach((dbPath, index) => {
        result.push({
          id: this.buildDbId('message', index, dbPath),
          kind: 'message',
          dbPath,
          relativePath: this.toDbRelativePath(dbStorage, dbPath)
        })
      })
    }

    const mediaDbs = await wcdbService.listMediaDbs()
    if (mediaDbs.success && Array.isArray(mediaDbs.data)) {
      mediaDbs.data.forEach((dbPath, index) => {
        result.push({
          id: this.buildDbId('media', index, dbPath),
          kind: 'media',
          dbPath,
          relativePath: this.toDbRelativePath(dbStorage, dbPath)
        })
      })
    }

    return result
  }

  private async collectImageResources(
    connected: { wxid: string; dbStorage: string },
    stagingDir: string,
    manifest: BackupManifest
  ): Promise<void> {
    const accountDir = dirname(connected.dbStorage)
    const imagesDir = join(stagingDir, 'resources', 'images')
    const imagePaths = await this.listChatImageDatFiles(accountDir)
    if (imagePaths.length === 0) return

    mkdirSync(imagesDir, { recursive: true })
    const resources: BackupResourceEntry[] = []
    const emitImageProgress = createThrottledProgressEmitter(160)
    for (let index = 0; index < imagePaths.length; index += 1) {
      const sourcePath = imagePaths[index]
      const relativeTarget = this.isSafeAccountRelativePath(accountDir, sourcePath)
      if (!relativeTarget) continue
      emitImageProgress({
        phase: 'exporting',
        message: '正在打包图片资源',
        current: index + 1,
        total: imagePaths.length,
        detail: relativeTarget
      })
      const archivePath = toArchivePath(join('resources', 'images', relativeTarget))
      const outputPath = join(stagingDir, archivePath)
      await this.stagePlainResource(sourcePath, outputPath)
      const stem = basename(sourcePath).replace(/\.dat$/i, '').toLowerCase()
      const stat = statSync(sourcePath)
      resources.push({
        kind: 'image',
        id: relativeTarget,
        md5: /^[a-f0-9]{32}$/i.test(stem) ? stem : undefined,
        sourceFileName: basename(sourcePath),
        archivePath,
        targetRelativePath: relativeTarget,
        size: stat.size
      })
      if (index % 20 === 0) await delay()
    }

    if (resources.length > 0) {
      manifest.resources = { ...(manifest.resources || {}), images: resources }
    }
  }

  private async collectPlainResources(
    connected: { dbStorage: string },
    stagingDir: string,
    manifest: BackupManifest,
    kind: 'video' | 'file'
  ): Promise<void> {
    const accountDir = dirname(connected.dbStorage)
    const roots = kind === 'video'
      ? [
          join(accountDir, 'msg', 'video'),
          join(accountDir, 'FileStorage', 'Video')
        ]
      : [
          join(accountDir, 'FileStorage', 'File'),
          join(accountDir, 'msg', 'file')
        ]
    const listed = await Promise.all(roots.map(root => this.listFilesUnderDir(root)))
    const uniqueFiles = Array.from(new Set(listed.flat()))
    if (uniqueFiles.length === 0) return

    const resources: BackupResourceEntry[] = []
    const bucket = kind === 'video' ? 'videos' : 'files'
    const emitResourceProgress = createThrottledProgressEmitter(180)
    await runWithConcurrency(uniqueFiles, 4, async (sourcePath, index) => {
      emitResourceProgress({
        phase: 'exporting',
        message: kind === 'video' ? '正在归档视频资源' : '正在归档文件资源',
        current: index + 1,
        total: uniqueFiles.length,
        detail: basename(sourcePath)
      })
      const relativeTarget = this.isSafeAccountRelativePath(accountDir, sourcePath)
      if (!relativeTarget) return
      const archivePath = toArchivePath(join('resources', bucket, relativeTarget))
      const outputPath = join(stagingDir, archivePath)
      await this.stagePlainResource(sourcePath, outputPath)
      let size = 0
      try { size = statSync(sourcePath).size } catch {}
      const entry: BackupResourceEntry = {
        kind,
        id: relativeTarget,
        sourceFileName: basename(sourcePath),
        archivePath,
        targetRelativePath: relativeTarget,
        size
      }
      resources.push(entry)
    })

    if (resources.length > 0) {
      manifest.resources = {
        ...(manifest.resources || {}),
        [bucket]: resources
      }
    }
  }

  async createBackup(outputPath: string, options: BackupOptions = {}): Promise<{ success: boolean; filePath?: string; manifest?: BackupManifest; error?: string }> {
    let stagingDir = ''
    try {
      emitBackupProgress({ phase: 'preparing', message: '正在连接数据库' })
      const connected = await this.ensureConnected()
      if (!connected.success || !connected.wxid || !connected.dbPath || !connected.dbStorage) {
        return { success: false, error: connected.error || '数据库未连接' }
      }

      stagingDir = await this.createTempDir('weflow-backup-')
      const snapshotsDir = join(stagingDir, 'snapshots')
      mkdirSync(snapshotsDir, { recursive: true })

      const dbs = await this.collectDatabases(connected.dbStorage)
      const manifest: BackupManifest = {
        version: 1,
        type: 'weflow-db-snapshots',
        createdAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        source: {
          wxid: connected.wxid,
          dbRoot: connected.dbPath
        },
        databases: [],
        options: {
          includeImages: options.includeImages === true,
          includeVideos: options.includeVideos === true,
          includeFiles: options.includeFiles === true
        }
      }

      const tableJobs: Array<{ db: Omit<BackupDbEntry, 'tables'>; table: string; schemaSql: string; snapshotPath: string; outputPath: string }> = []
      for (let index = 0; index < dbs.length; index += 1) {
        const db = dbs[index]
        emitBackupProgress({
          phase: 'scanning',
          message: '正在扫描数据库和表',
          current: index + 1,
          total: dbs.length,
          detail: `${db.kind}:${db.relativePath || db.dbPath || db.id}`
        })
        const tablesResult = await wcdbService.listTables(db.kind, db.dbPath)
        if (!tablesResult.success || !Array.isArray(tablesResult.tables) || tablesResult.tables.length === 0) continue
        const dbDir = join(snapshotsDir, db.id)
        mkdirSync(dbDir, { recursive: true })
        const entry: BackupDbEntry = { ...db, tables: [] }
        manifest.databases.push(entry)
        for (const table of tablesResult.tables) {
          const schemaResult = await wcdbService.getTableSchema(db.kind, db.dbPath, table)
          if (!schemaResult.success || !schemaResult.schema) continue
          const snapshotPath = toArchivePath(join('snapshots', db.id, `${safeName(table)}.wfsnap`))
          tableJobs.push({
            db,
            table,
            schemaSql: schemaResult.schema,
            snapshotPath,
            outputPath: join(stagingDir, snapshotPath)
          })
        }
      }

      let current = 0
      for (const job of tableJobs) {
        current++
        emitBackupProgress({
          phase: 'exporting',
          message: '正在导出数据库快照',
          current,
          total: tableJobs.length,
          detail: `${job.db.kind}:${job.table}`
        })
        const exported = await wcdbService.exportTableSnapshot(job.db.kind, job.db.dbPath, job.table, job.outputPath)
        if (!exported.success) {
          throw new Error(`${job.db.kind}:${job.table} 导出失败：${exported.error || 'unknown'}`)
        }
        const dbEntry = manifest.databases.find(item => item.id === job.db.id)
        dbEntry?.tables.push({
          name: job.table,
          snapshotPath: job.snapshotPath,
          rows: exported.rows || 0,
          columns: exported.columns || 0,
          schemaSql: job.schemaSql
        })
      }

      if (options.includeImages === true) {
        await this.collectImageResources(
          { wxid: connected.wxid, dbStorage: connected.dbStorage },
          stagingDir,
          manifest
        )
      }
      if (options.includeVideos === true) {
        await this.collectPlainResources({ dbStorage: connected.dbStorage }, stagingDir, manifest, 'video')
      }
      if (options.includeFiles === true) {
        await this.collectPlainResources({ dbStorage: connected.dbStorage }, stagingDir, manifest, 'file')
      }

      await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
      mkdirSync(dirname(outputPath), { recursive: true })
      const archiveFiles = await this.listFilesForArchive(stagingDir)
      const shouldCompress = !hasResourceOptions(options)
      let packed = 0
      const emitPackingProgress = createThrottledProgressEmitter(150)
      emitBackupProgress({ phase: 'packing', message: '正在生成备份包', current: 0, total: archiveFiles.length })
      await tar.c({
        gzip: shouldCompress ? { level: 1 } : false,
        cwd: stagingDir,
        file: outputPath,
        portable: true,
        noMtime: true,
        sync: false,
        onWriteEntry: (entry: any) => {
          packed += 1
          emitPackingProgress({
            phase: 'packing',
            message: '正在写入备份包',
            current: Math.min(packed, archiveFiles.length),
            total: archiveFiles.length,
            detail: String(entry?.path || entry || '')
          })
        }
      } as any, archiveFiles)
      emitBackupProgress({
        phase: 'packing',
        message: '正在写入备份包',
        current: archiveFiles.length,
        total: archiveFiles.length
      })
      emitBackupProgress({ phase: 'done', message: '备份完成', current: tableJobs.length, total: tableJobs.length })
      return { success: true, filePath: outputPath, manifest }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      emitBackupProgress({ phase: 'failed', message: error })
      return { success: false, error }
    } finally {
      if (stagingDir) {
        try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      }
    }
  }

  async inspectBackup(archivePath: string): Promise<{ success: boolean; manifest?: BackupManifest; error?: string }> {
    let extractDir = ''
    try {
      emitBackupProgress({ phase: 'inspecting', message: '正在读取备份包' })
      extractDir = await this.createTempDir('weflow-backup-inspect-')
      await tar.x({
        file: archivePath,
        cwd: extractDir,
        filter: (entryPath: string) => entryPath.replace(/\\/g, '/') === 'manifest.json'
      } as any)
      const manifestPath = join(extractDir, 'manifest.json')
      if (!existsSync(manifestPath)) return { success: false, error: '备份包缺少 manifest.json' }
      const manifest = JSON.parse(await readFileAsync(manifestPath, 'utf8')) as BackupManifest
      if (manifest?.type !== 'weflow-db-snapshots' || manifest.version !== 1) {
        return { success: false, error: '不支持的备份包格式' }
      }
      return { success: true, manifest }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      if (extractDir) {
        try { rmSync(extractDir, { recursive: true, force: true }) } catch {}
      }
    }
  }

  private async streamRestoreArchive(
    archivePath: string,
    extractDir: string,
    manifest: BackupManifest,
    connected: { dbStorage: string; wxid?: string },
    startCurrent: number,
    total: number
  ): Promise<{ current: number; skipped: number }> {
    const snapshotPaths = new Set<string>()
    for (const db of manifest.databases || []) {
      for (const table of db.tables || []) {
        const path = normalizeArchivePath(table.snapshotPath)
        if (path) snapshotPaths.add(path)
      }
    }

    const imageByPath = new Map<string, BackupResourceEntry>()
    for (const image of manifest.resources?.images || []) {
      const path = normalizeArchivePath(image.archivePath)
      if (path) imageByPath.set(path, image)
    }

    const plainByPath = new Map<string, BackupResourceEntry>()
    for (const resource of [
      ...(manifest.resources?.videos || []),
      ...(manifest.resources?.files || [])
    ]) {
      const path = normalizeArchivePath(resource.archivePath)
      if (path) plainByPath.set(path, resource)
    }

    const accountDir = dirname(connected.dbStorage)
    let current = startCurrent
    let skipped = 0
    const pending: Promise<void>[] = []
    const emitRestoreProgress = createThrottledProgressEmitter(160)
    await tar.t({
      file: archivePath,
      onReadEntry: (entry: any) => {
        const entryPath = normalizeArchivePath(entry.path)
        if (snapshotPaths.has(entryPath)) {
          const outputPath = this.resolveStagingPath(extractDir, entryPath)
          if (!outputPath) {
            entry.resume()
            return
          }
          pending.push(this.writeTarEntryToFile(entry, outputPath))
          return
        }

        const image = imageByPath.get(entryPath)
        if (image) {
          const targetPath = this.resolveTargetResourcePath(accountDir, image.targetRelativePath)
          if (!targetPath) {
            skipped += 1
            entry.resume()
            return
          }
          current += 1
          emitRestoreProgress({
            phase: 'restoring',
            message: '正在写回图片资源',
            current,
            total,
            detail: image.md5 || image.targetRelativePath
          })
          if (existsSync(targetPath)) {
            skipped += 1
            entry.resume()
            return
          }
          pending.push(this.writeTarEntryToFile(entry, targetPath))
          return
        }

        const resource = plainByPath.get(entryPath)
        if (resource) {
          const targetPath = this.resolveTargetResourcePath(accountDir, resource.targetRelativePath)
          current += 1
          emitRestoreProgress({
            phase: 'restoring',
            message: resource.kind === 'video' ? '正在写回视频资源' : '正在写回文件资源',
            current,
            total,
            detail: resource.targetRelativePath
          })
          if (!targetPath || existsSync(targetPath)) {
            skipped += 1
            entry.resume()
            return
          }
          pending.push(this.writeTarEntryToFile(entry, targetPath))
          return
        }

        entry.resume()
      }
    } as any)

    await Promise.all(pending)
    return { current, skipped }
  }

  async restoreBackup(archivePath: string): Promise<{ success: boolean; inserted?: number; ignored?: number; skipped?: number; error?: string }> {
    let extractDir = ''
    try {
      emitBackupProgress({ phase: 'inspecting', message: '正在读取备份信息' })
      extractDir = await this.createTempDir('weflow-backup-restore-')
      await tar.x({
        file: archivePath,
        cwd: extractDir,
        filter: (entryPath: string) => normalizeArchivePath(entryPath) === 'manifest.json'
      } as any)
      const manifestPath = join(extractDir, 'manifest.json')
      if (!existsSync(manifestPath)) return { success: false, error: '备份包缺少 manifest.json' }
      const manifest = JSON.parse(await readFileAsync(manifestPath, 'utf8')) as BackupManifest
      if (manifest?.type !== 'weflow-db-snapshots' || manifest.version !== 1) {
        return { success: false, error: '不支持的备份包格式' }
      }
      const targetWxid = String(manifest.source?.wxid || '').trim()
      if (!targetWxid) return { success: false, error: '备份包缺少来源账号 wxid，无法定位目标账号目录' }

      emitBackupProgress({ phase: 'preparing', message: '正在连接目标数据库', detail: targetWxid })
      const connected = await this.ensureConnected(targetWxid)
      if (!connected.success || !connected.dbStorage) return { success: false, error: connected.error || '数据库未连接' }

      const tableJobs = manifest.databases.flatMap(db => db.tables.map(table => ({ db, table })))
      const imageJobs = manifest.resources?.images || []
      const plainResourceJobs = [
        ...(manifest.resources?.videos || []),
        ...(manifest.resources?.files || [])
      ]
      const totalRestoreJobs = tableJobs.length + imageJobs.length + plainResourceJobs.length
      let inserted = 0
      let ignored = 0
      let skipped = 0
      let current = 0
      if (imageJobs.length > 0 || plainResourceJobs.length > 0 || tableJobs.length > 0) {
        emitBackupProgress({
          phase: 'inspecting',
          message: '正在按需读取备份包',
          current: 0,
          total: totalRestoreJobs,
          detail: archivePath
        })
        const streamed = await this.streamRestoreArchive(
          archivePath,
          extractDir,
          manifest,
          { dbStorage: connected.dbStorage, wxid: connected.wxid },
          0,
          totalRestoreJobs
        )
        current = streamed.current
        skipped += streamed.skipped
      }

      for (const job of tableJobs) {
        current++
        const targetDbPath = this.resolveRestoreTargetDbPath(connected.dbStorage, job.db)
        if (targetDbPath === null) {
          skipped++
          continue
        }
        if (!job.table.schemaSql) {
          skipped++
          continue
        }

        emitBackupProgress({
          phase: 'restoring',
          message: '正在通过 WCDB 写入数据库',
          current,
          total: totalRestoreJobs,
          detail: `${job.db.kind}:${job.table.name}`
        })
        const inputPath = this.resolveExtractedPath(extractDir, job.table.snapshotPath)
        if (!inputPath || !existsSync(inputPath)) {
          skipped++
          continue
        }
        mkdirSync(dirname(targetDbPath), { recursive: true })
        const restored = await wcdbService.importTableSnapshotWithSchema(
          job.db.kind,
          targetDbPath,
          job.table.name,
          inputPath,
          job.table.schemaSql
        )
        if (!restored.success) {
          skipped++
          continue
        }
        inserted += restored.inserted || 0
        ignored += restored.ignored || 0
        if (current % 4 === 0) await delay()
      }

      emitBackupProgress({ phase: 'done', message: '载入完成', current: totalRestoreJobs, total: totalRestoreJobs })
      return { success: true, inserted, ignored, skipped }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      emitBackupProgress({ phase: 'failed', message: error })
      return { success: false, error }
    } finally {
      if (extractDir) {
        try { rmSync(extractDir, { recursive: true, force: true }) } catch {}
      }
    }
  }
}

export const backupService = new BackupService()
