import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { readdir, mkdir, copyFile, rm } from 'fs/promises'
import { ConfigService } from '../services/config'

export type SnsCacheMigrationCandidate = {
  label: string
  sourceDir: string
  targetDir: string
  fileCount: number
}

export type SnsCacheMigrationPlan = {
  legacyBaseDir: string
  currentBaseDir: string
  candidates: SnsCacheMigrationCandidate[]
  totalFiles: number
}

export type SnsCacheMigrationProgressPayload = {
  status: 'running' | 'done' | 'error'
  phase: 'copying' | 'cleanup' | 'done' | 'error'
  current: number
  total: number
  copied: number
  skipped: number
  remaining: number
  message?: string
  currentItemLabel?: string
}

const normalizeFsPathForCompare = (value: string): string => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const countFilesInDir = async (dirPath: string): Promise<number> => {
  if (!dirPath || !existsSync(dirPath)) return 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        count += await countFilesInDir(fullPath)
        continue
      }
      if (entry.isFile()) count += 1
    }
    return count
  } catch {
    return 0
  }
}

const migrateDirectoryPreserveNewFiles = async (
  sourceDir: string,
  targetDir: string,
  onFileProcessed?: (payload: { copied: boolean }) => void
): Promise<{ copied: number; skipped: number; processed: number }> => {
  let copied = 0
  let skipped = 0
  let processed = 0

  if (!existsSync(sourceDir)) return { copied, skipped, processed }
  await mkdir(targetDir, { recursive: true })

  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)

    if (entry.isDirectory()) {
      const nested = await migrateDirectoryPreserveNewFiles(sourcePath, targetPath, onFileProcessed)
      copied += nested.copied
      skipped += nested.skipped
      processed += nested.processed
      continue
    }

    if (!entry.isFile()) continue

    if (existsSync(targetPath)) {
      skipped += 1
      processed += 1
      onFileProcessed?.({ copied: false })
      continue
    }

    await mkdir(dirname(targetPath), { recursive: true })
    await copyFile(sourcePath, targetPath)
    copied += 1
    processed += 1
    onFileProcessed?.({ copied: true })
  }

  return { copied, skipped, processed }
}

export function createSnsCacheMigrationRuntime(getConfigService: () => ConfigService | null) {
  let snsCacheMigrationInProgress = false

  const collectLegacySnsCacheMigrationPlan = async (): Promise<SnsCacheMigrationPlan | null> => {
    const configService = getConfigService()
    if (!configService) return null

    const legacyBaseDir = configService.getCacheBasePath()
    const configuredCachePath = String(configService.get('cachePath') || '').trim()
    const currentBaseDir = configuredCachePath || join(app.getPath('documents'), 'WeFlow')

    if (!legacyBaseDir || !currentBaseDir) return null

    const candidates = [
      {
        label: '朋友圈媒体缓存',
        sourceDir: join(legacyBaseDir, 'sns_cache'),
        targetDir: join(currentBaseDir, 'sns_cache')
      },
      {
        label: '朋友圈表情缓存（合并到 Emojis）',
        sourceDir: join(legacyBaseDir, 'sns_emoji_cache'),
        targetDir: join(currentBaseDir, 'Emojis')
      },
      {
        label: '朋友圈表情缓存（当前目录残留）',
        sourceDir: join(currentBaseDir, 'sns_emoji_cache'),
        targetDir: join(currentBaseDir, 'Emojis')
      }
    ]

    const pendingKeys = new Set<string>()
    const pending: SnsCacheMigrationCandidate[] = []
    for (const item of candidates) {
      const sourceKey = normalizeFsPathForCompare(item.sourceDir)
      const targetKey = normalizeFsPathForCompare(item.targetDir)
      if (!sourceKey || sourceKey === targetKey) continue
      const dedupeKey = `${sourceKey}=>${targetKey}`
      if (pendingKeys.has(dedupeKey)) continue
      const fileCount = await countFilesInDir(item.sourceDir)
      if (fileCount <= 0) continue
      pendingKeys.add(dedupeKey)
      pending.push({ ...item, fileCount })
    }
    if (pending.length === 0) return null

    const totalFiles = pending.reduce((sum, item) => sum + item.fileCount, 0)
    return {
      legacyBaseDir,
      currentBaseDir,
      candidates: pending,
      totalFiles
    }
  }

  const runLegacySnsCacheMigration = async (
    plan: SnsCacheMigrationPlan,
    onProgress: (payload: SnsCacheMigrationProgressPayload) => void
  ): Promise<{ copied: number; skipped: number; totalFiles: number }> => {
    let processed = 0
    let copied = 0
    let skipped = 0
    const total = plan.totalFiles

    const emitProgress = (patch?: Partial<SnsCacheMigrationProgressPayload>) => {
      onProgress({
        status: 'running',
        phase: 'copying',
        current: processed,
        total,
        copied,
        skipped,
        remaining: Math.max(0, total - processed),
        ...patch
      })
    }

    emitProgress({ message: '准备迁移缓存...' })

    for (const item of plan.candidates) {
      emitProgress({ currentItemLabel: item.label, message: `正在迁移：${item.label}` })
      const result = await migrateDirectoryPreserveNewFiles(item.sourceDir, item.targetDir, ({ copied: copiedThisFile }) => {
        processed += 1
        if (copiedThisFile) copied += 1
        else skipped += 1
        emitProgress({ currentItemLabel: item.label })
      })
      const expectedProcessed = copied + skipped
      if (processed !== expectedProcessed) {
        processed = expectedProcessed
        copied = Math.max(copied, result.copied)
        skipped = Math.max(skipped, result.skipped)
        emitProgress({ currentItemLabel: item.label })
      }
    }

    emitProgress({ phase: 'cleanup', message: '正在清理旧目录...' })
    for (const item of plan.candidates) {
      await rm(item.sourceDir, { recursive: true, force: true })
    }

    if (existsSync(plan.legacyBaseDir)) {
      try {
        const remaining = await readdir(plan.legacyBaseDir)
        if (remaining.length === 0) {
          await rm(plan.legacyBaseDir, { recursive: true, force: true })
        }
      } catch {
        // 忽略旧目录清理失败，不影响迁移结果
      }
    }

    onProgress({
      status: 'done',
      phase: 'done',
      current: processed,
      total,
      copied,
      skipped,
      remaining: Math.max(0, total - processed),
      message: '迁移完成'
    })

    return { copied, skipped, totalFiles: total }
  }

  return {
    getInProgress: () => snsCacheMigrationInProgress,
    setInProgress: (value: boolean) => { snsCacheMigrationInProgress = value },
    collectLegacySnsCacheMigrationPlan,
    runLegacySnsCacheMigration
  }
}

export type SnsCacheMigrationRuntime = ReturnType<typeof createSnsCacheMigrationRuntime>
