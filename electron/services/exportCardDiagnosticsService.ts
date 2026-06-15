import { mkdir, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'

export type ExportCardDiagSource = 'frontend' | 'main' | 'backend' | 'worker'
export type ExportCardDiagLevel = 'debug' | 'info' | 'warn' | 'error'
export type ExportCardDiagStatus = 'running' | 'done' | 'failed' | 'timeout'

export interface ExportCardDiagLogEntry {
  id: string
  ts: number
  source: ExportCardDiagSource
  level: ExportCardDiagLevel
  message: string
  traceId?: string
  stepId?: string
  stepName?: string
  status?: ExportCardDiagStatus
  durationMs?: number
  data?: Record<string, unknown>
}

interface ActiveStepState {
  key: string
  traceId: string
  stepId: string
  stepName: string
  source: ExportCardDiagSource
  startedAt: number
  lastUpdatedAt: number
  message?: string
}

interface StepStartInput {
  traceId: string
  stepId: string
  stepName: string
  source: ExportCardDiagSource
  level?: ExportCardDiagLevel
  message?: string
  data?: Record<string, unknown>
}

interface StepEndInput {
  traceId: string
  stepId: string
  stepName: string
  source: ExportCardDiagSource
  status?: Extract<ExportCardDiagStatus, 'done' | 'failed' | 'timeout'>
  level?: ExportCardDiagLevel
  message?: string
  data?: Record<string, unknown>
  durationMs?: number
}

interface LogInput {
  ts?: number
  source: ExportCardDiagSource
  level?: ExportCardDiagLevel
  message: string
  traceId?: string
  stepId?: string
  stepName?: string
  status?: ExportCardDiagStatus
  durationMs?: number
  data?: Record<string, unknown>
}

export interface ExportCardDiagSnapshot {
  logs: ExportCardDiagLogEntry[]
  activeSteps: Array<{
    traceId: string
    stepId: string
    stepName: string
    source: ExportCardDiagSource
    elapsedMs: number
    stallMs: number
    startedAt: number
    lastUpdatedAt: number
    message?: string
  }>
  summary: {
    totalLogs: number
    activeStepCount: number
    errorCount: number
    warnCount: number
    timeoutCount: number
    lastUpdatedAt: number
  }
}

export class ExportCardDiagnosticsService {
  private readonly maxLogs = 6000
  private logs: ExportCardDiagLogEntry[] = []
  private activeSteps = new Map<string, ActiveStepState>()
  private seq = 0

  private nextId(ts: number): string {
    this.seq += 1
    return `export-card-diag-${ts}-${this.seq}`
  }

  private trimLogs() {
    if (this.logs.length <= this.maxLogs) return
    const drop = this.logs.length - this.maxLogs
    this.logs.splice(0, drop)
  }

  log(input: LogInput): ExportCardDiagLogEntry {
    const ts = Number.isFinite(input.ts) ? Math.max(0, Math.floor(input.ts as number)) : Date.now()
    const entry: ExportCardDiagLogEntry = {
      id: this.nextId(ts),
      ts,
      source: input.source,
      level: input.level || 'info',
      message: input.message,
      traceId: input.traceId,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status,
      durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.floor(input.durationMs as number)) : undefined,
      data: input.data
    }

    this.logs.push(entry)
    this.trimLogs()

    if (entry.traceId && entry.stepId && entry.stepName) {
      const key = `${entry.traceId}::${entry.stepId}`
      if (entry.status === 'running') {
        const previous = this.activeSteps.get(key)
        this.activeSteps.set(key, {
          key,
          traceId: entry.traceId,
          stepId: entry.stepId,
          stepName: entry.stepName,
          source: entry.source,
          startedAt: previous?.startedAt || entry.ts,
          lastUpdatedAt: entry.ts,
          message: entry.message
        })
      } else if (entry.status === 'done' || entry.status === 'failed' || entry.status === 'timeout') {
        this.activeSteps.delete(key)
      }
    }

    return entry
  }

  stepStart(input: StepStartInput): ExportCardDiagLogEntry {
    return this.log({
      source: input.source,
      level: input.level || 'info',
      message: input.message || `${input.stepName} 开始`,
      traceId: input.traceId,
      stepId: input.stepId,
      stepName: input.stepName,
      status: 'running',
      data: input.data
    })
  }

  stepEnd(input: StepEndInput): ExportCardDiagLogEntry {
    return this.log({
      source: input.source,
      level: input.level || (input.status === 'done' ? 'info' : 'warn'),
      message: input.message || `${input.stepName} ${input.status === 'done' ? '完成' : '结束'}`,
      traceId: input.traceId,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status || 'done',
      durationMs: input.durationMs,
      data: input.data
    })
  }

  clear() {
    this.logs = []
    this.activeSteps.clear()
  }

  snapshot(limit = 1200): ExportCardDiagSnapshot {
    const capped = Number.isFinite(limit) ? Math.max(100, Math.min(5000, Math.floor(limit))) : 1200
    const logs = this.logs.slice(-capped)
    const now = Date.now()

    const activeSteps = Array.from(this.activeSteps.values())
      .map(step => ({
        traceId: step.traceId,
        stepId: step.stepId,
        stepName: step.stepName,
        source: step.source,
        startedAt: step.startedAt,
        lastUpdatedAt: step.lastUpdatedAt,
        elapsedMs: Math.max(0, now - step.startedAt),
        stallMs: Math.max(0, now - step.lastUpdatedAt),
        message: step.message
      }))
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)

    let errorCount = 0
    let warnCount = 0
    let timeoutCount = 0
    for (const item of logs) {
      if (item.level === 'error') errorCount += 1
      if (item.level === 'warn') warnCount += 1
      if (item.status === 'timeout') timeoutCount += 1
    }

    return {
      logs,
      activeSteps,
      summary: {
        totalLogs: this.logs.length,
        activeStepCount: activeSteps.length,
        errorCount,
        warnCount,
        timeoutCount,
        lastUpdatedAt: logs.length > 0 ? logs[logs.length - 1].ts : 0
      }
    }
  }

  private normalizeExternalLogs(value: unknown[]): ExportCardDiagLogEntry[] {
    const result: ExportCardDiagLogEntry[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const tsRaw = row.ts ?? row.timestamp
      const tsNum = Number(tsRaw)
      const ts = Number.isFinite(tsNum) && tsNum > 0 ? Math.floor(tsNum) : Date.now()

      const sourceRaw = String(row.source || 'frontend')
      const source: ExportCardDiagSource = sourceRaw === 'main' || sourceRaw === 'backend' || sourceRaw === 'worker'
        ? sourceRaw
        : 'frontend'
      const levelRaw = String(row.level || 'info')
      const level: ExportCardDiagLevel = levelRaw === 'debug' || levelRaw === 'warn' || levelRaw === 'error'
        ? levelRaw
        : 'info'

      const statusRaw = String(row.status || '')
      const status: ExportCardDiagStatus | undefined = statusRaw === 'running' || statusRaw === 'done' || statusRaw === 'failed' || statusRaw === 'timeout'
        ? statusRaw
        : undefined

      const durationRaw = Number(row.durationMs)
      result.push({
        id: String(row.id || this.nextId(ts)),
        ts,
        source,
        level,
        message: String(row.message || ''),
        traceId: typeof row.traceId === 'string' ? row.traceId : undefined,
        stepId: typeof row.stepId === 'string' ? row.stepId : undefined,
        stepName: typeof row.stepName === 'string' ? row.stepName : undefined,
        status,
        durationMs: Number.isFinite(durationRaw) ? Math.max(0, Math.floor(durationRaw)) : undefined,
        data: row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : undefined
      })
    }
    return result
  }

  private serializeLogEntry(log: ExportCardDiagLogEntry): string {
    return JSON.stringify(log)
  }

  private buildSummaryText(logs: ExportCardDiagLogEntry[], activeSteps: ExportCardDiagSnapshot['activeSteps']): string {
    const total = logs.length
    let errorCount = 0
    let warnCount = 0
    let timeoutCount = 0
    let frontendCount = 0
    let backendCount = 0
    let mainCount = 0
    let workerCount = 0

    for (const item of logs) {
      if (item.level === 'error') errorCount += 1
      if (item.level === 'warn') warnCount += 1
      if (item.status === 'timeout') timeoutCount += 1
      if (item.source === 'frontend') frontendCount += 1
      if (item.source === 'backend') backendCount += 1
      if (item.source === 'main') mainCount += 1
      if (item.source === 'worker') workerCount += 1
    }

    const lines: string[] = []
    lines.push('WeFlow 导出卡片诊断摘要')
    lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`)
    lines.push(`日志总数: ${total}`)
    lines.push(`来源统计: frontend=${frontendCount}, main=${mainCount}, backend=${backendCount}, worker=${workerCount}`)
    lines.push(`级别统计: warn=${warnCount}, error=${errorCount}, timeout=${timeoutCount}`)
    lines.push(`当前活跃步骤: ${activeSteps.length}`)

    if (activeSteps.length > 0) {
      lines.push('')
      lines.push('活跃步骤:')
      for (const step of activeSteps.slice(0, 12)) {
        lines.push(`- [${step.source}] ${step.stepName} trace=${step.traceId} elapsed=${step.elapsedMs}ms stall=${step.stallMs}ms`)
      }
    }

    const latestErrors = logs.filter(item => item.level === 'error' || item.status === 'failed' || item.status === 'timeout').slice(-12)
    if (latestErrors.length > 0) {
      lines.push('')
      lines.push('最近异常:')
      for (const item of latestErrors) {
        lines.push(`- ${new Date(item.ts).toLocaleTimeString('zh-CN')} [${item.source}] ${item.stepName || item.stepId || 'unknown'} ${item.status || item.level} ${item.message}`)
      }
    }

    return lines.join('\n')
  }

  async exportCombinedLogs(filePath: string, frontendLogs: unknown[] = []): Promise<{
    success: boolean
    filePath?: string
    summaryPath?: string
    count?: number
    error?: string
  }> {
    try {
      const normalizedFrontend = this.normalizeExternalLogs(Array.isArray(frontendLogs) ? frontendLogs : [])
      const merged = [...this.logs, ...normalizedFrontend]
        .sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id))

      const lines = merged.map(item => this.serializeLogEntry(item)).join('\n')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, lines ? `${lines}\n` : '', 'utf8')

      const ext = extname(filePath)
      const baseName = ext ? basename(filePath, ext) : basename(filePath)
      const summaryPath = join(dirname(filePath), `${baseName}.txt`)
      const snapshot = this.snapshot(1500)
      const summaryText = this.buildSummaryText(merged, snapshot.activeSteps)
      await writeFile(summaryPath, summaryText, 'utf8')

      return {
        success: true,
        filePath,
        summaryPath,
        count: merged.length
      }
    } catch (error) {
      return {
        success: false,
        error: String(error)
      }
    }
  }
}

export const exportCardDiagnosticsService = new ExportCardDiagnosticsService()
