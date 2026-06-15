import * as path from 'path'
import { rm, rmdir } from 'fs/promises'

export type ExportTaskControlState = 'running' | 'pause_requested' | 'cancel_requested'

export interface ExportTaskControlHooks {
  shouldPause: () => boolean
  shouldStop: () => boolean
  recordCreatedFile: (filePath: string) => void
  recordCreatedDir: (dirPath: string) => void
}

interface ExportTaskManifest {
  outputDir: string
  files: Set<string>
  dirs: Set<string>
}

interface ExportTaskControlRecord {
  state: ExportTaskControlState
  manifest: ExportTaskManifest
  createdAt: number
  updatedAt: number
}

export interface ExportTaskCleanupResult {
  success: boolean
  filesDeleted: number
  dirsDeleted: number
  error?: string
}

class ExportTaskControlService {
  private tasks = new Map<string, ExportTaskControlRecord>()

  createControl(taskId: string, outputDir: string): ExportTaskControlHooks {
    this.registerTask(taskId, outputDir)
    return {
      shouldPause: () => this.getState(taskId) === 'pause_requested',
      shouldStop: () => this.getState(taskId) === 'cancel_requested',
      recordCreatedFile: (filePath: string) => this.recordCreatedFile(taskId, filePath),
      recordCreatedDir: (dirPath: string) => this.recordCreatedDir(taskId, dirPath)
    }
  }

  registerTask(taskId: string, outputDir: string): void {
    const normalizedTaskId = this.normalizeTaskId(taskId)
    if (!normalizedTaskId) return

    const normalizedOutputDir = path.resolve(String(outputDir || '').trim() || '.')
    const existing = this.tasks.get(normalizedTaskId)
    if (existing) {
      existing.state = 'running'
      existing.updatedAt = Date.now()
      if (!existing.manifest.outputDir) {
        existing.manifest.outputDir = normalizedOutputDir
      }
      return
    }

    this.tasks.set(normalizedTaskId, {
      state: 'running',
      manifest: {
        outputDir: normalizedOutputDir,
        files: new Set<string>(),
        dirs: new Set<string>()
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }

  pauseTask(taskId: string): boolean {
    return this.setState(taskId, 'pause_requested')
  }

  resumeTask(taskId: string): boolean {
    return this.setState(taskId, 'running')
  }

  cancelTask(taskId: string): boolean {
    return this.setState(taskId, 'cancel_requested')
  }

  getState(taskId: string): ExportTaskControlState | null {
    const normalizedTaskId = this.normalizeTaskId(taskId)
    if (!normalizedTaskId) return null
    return this.tasks.get(normalizedTaskId)?.state || null
  }

  releaseTask(taskId: string): void {
    const normalizedTaskId = this.normalizeTaskId(taskId)
    if (!normalizedTaskId) return
    this.tasks.delete(normalizedTaskId)
  }

  recordCreatedFile(taskId: string, filePath: string): void {
    const task = this.getTaskForManifestWrite(taskId, filePath)
    if (!task) return
    task.manifest.files.add(path.resolve(filePath))
    task.updatedAt = Date.now()
  }

  recordCreatedDir(taskId: string, dirPath: string): void {
    const task = this.getTaskForManifestWrite(taskId, dirPath)
    if (!task) return
    task.manifest.dirs.add(path.resolve(dirPath))
    task.updatedAt = Date.now()
  }

  async cleanupTask(taskId: string): Promise<ExportTaskCleanupResult> {
    const normalizedTaskId = this.normalizeTaskId(taskId)
    const task = normalizedTaskId ? this.tasks.get(normalizedTaskId) : undefined
    if (!task) {
      return { success: true, filesDeleted: 0, dirsDeleted: 0 }
    }

    const outputDir = task.manifest.outputDir
    let filesDeleted = 0
    let dirsDeleted = 0
    const errors: string[] = []

    const files = Array.from(task.manifest.files)
      .filter(filePath => this.isInsideOutputDir(filePath, outputDir))
      .sort((a, b) => b.length - a.length)

    for (const filePath of files) {
      try {
        await rm(filePath, { force: true, recursive: false })
        filesDeleted++
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') {
          errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const dirs = Array.from(task.manifest.dirs)
      .filter(dirPath => this.isInsideOutputDir(dirPath, outputDir) || this.isSamePath(dirPath, outputDir))
      .sort((a, b) => b.length - a.length)

    for (const dirPath of dirs) {
      try {
        await rmdir(dirPath)
        dirsDeleted++
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
          errors.push(`${dirPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    if (errors.length === 0) {
      this.releaseTask(normalizedTaskId)
      return { success: true, filesDeleted, dirsDeleted }
    }

    return {
      success: false,
      filesDeleted,
      dirsDeleted,
      error: errors.slice(0, 3).join('; ')
    }
  }

  private setState(taskId: string, state: ExportTaskControlState): boolean {
    const normalizedTaskId = this.normalizeTaskId(taskId)
    if (!normalizedTaskId) return false
    const task = this.tasks.get(normalizedTaskId)
    if (!task) return false
    task.state = state
    task.updatedAt = Date.now()
    return true
  }

  private getTaskForManifestWrite(taskId: string, targetPath: string): ExportTaskControlRecord | null {
    const normalizedTaskId = this.normalizeTaskId(taskId)
    if (!normalizedTaskId) return null
    const task = this.tasks.get(normalizedTaskId)
    if (!task) return null
    if (!this.isInsideOutputDir(targetPath, task.manifest.outputDir) && !this.isSamePath(targetPath, task.manifest.outputDir)) {
      return null
    }
    return task
  }

  private isInsideOutputDir(targetPath: string, outputDir: string): boolean {
    const resolvedTarget = path.resolve(targetPath)
    const resolvedOutputDir = path.resolve(outputDir)
    const relativePath = path.relative(resolvedOutputDir, resolvedTarget)
    return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
  }

  private isSamePath(left: string, right: string): boolean {
    const resolvedLeft = path.resolve(left)
    const resolvedRight = path.resolve(right)
    if (process.platform === 'win32') {
      return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    }
    return resolvedLeft === resolvedRight
  }

  private normalizeTaskId(taskId: string): string {
    return String(taskId || '').trim()
  }
}

export const exportTaskControlService = new ExportTaskControlService()
