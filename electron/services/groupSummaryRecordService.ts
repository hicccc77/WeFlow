import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { ConfigService } from './config'

export type GroupSummaryTriggerType = 'auto' | 'manual'

export interface GroupSummaryTopic {
  title: string
  participants: string[]
  keyPoints: string[]
  conclusion: string
}

export interface GroupSummaryLog {
  endpoint: string
  model: string
  temperature: number
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalSummary: string
  durationMs: number
  createdAt: number
  responseFormatJson?: boolean
  responseFormatFallback?: boolean
  responseFormatFallbackReason?: string
  parsedTopics?: GroupSummaryTopic[]
}

export interface GroupSummaryRecord {
  id: string
  accountScope: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  topics: GroupSummaryTopic[]
  summaryText: string
  rawOutput: string
  log: GroupSummaryLog
}

export interface GroupSummaryRecordSummary {
  id: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  topics: GroupSummaryTopic[]
  summaryText: string
}

export interface GroupSummaryRecordFilters {
  sessionId?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

export interface GroupSummaryRecordListResult {
  success: boolean
  records: GroupSummaryRecordSummary[]
  total: number
  error?: string
}

interface GroupSummaryIndexRecord extends GroupSummaryRecordSummary {
  accountScope: string
  logFile?: string
}

interface LegacyGroupSummaryRecord extends GroupSummaryIndexRecord {
  rawOutput?: string
  log?: GroupSummaryLog
}

class GroupSummaryRecordService {
  private readonly maxRecordsPerScope = 2000
  private filePath: string | null = null
  private logDir: string | null = null
  private loaded = false
  private records: GroupSummaryIndexRecord[] = []

  private resolveUserDataPath(): string {
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    const userDataPath = workerUserDataPath || app?.getPath?.('userData') || process.cwd()
    fs.mkdirSync(userDataPath, { recursive: true })
    return userDataPath
  }

  private resolveFilePath(): string {
    if (this.filePath) return this.filePath
    this.filePath = path.join(this.resolveUserDataPath(), 'weflow-group-summary-records.json')
    return this.filePath
  }

  private resolveLogDir(): string {
    if (this.logDir) return this.logDir
    this.logDir = path.join(this.resolveUserDataPath(), 'weflow-group-summary-logs')
    fs.mkdirSync(this.logDir, { recursive: true })
    return this.logDir
  }

  private normalizeTimestampSeconds(value: unknown): number {
    const numeric = Number(value || 0)
    if (!Number.isFinite(numeric) || numeric <= 0) return 0
    let normalized = Math.floor(numeric)
    while (normalized > 10000000000) {
      normalized = Math.floor(normalized / 1000)
    }
    return normalized
  }

  private safeLogFileName(id: string): string {
    const normalized = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')
    return `${normalized || randomUUID()}.json`
  }

  private writeLogFile(recordId: string, log: GroupSummaryLog, rawOutput: string): string | undefined {
    try {
      const fileName = this.safeLogFileName(recordId)
      const logPath = path.join(this.resolveLogDir(), fileName)
      fs.writeFileSync(logPath, JSON.stringify({ version: 1, rawOutput, log }, null, 2), 'utf-8')
      return fileName
    } catch {
      return undefined
    }
  }

  private readLogFile(fileName?: string): { rawOutput: string; log: GroupSummaryLog } | null {
    if (!fileName) return null
    try {
      const logPath = path.join(this.resolveLogDir(), this.safeLogFileName(fileName.replace(/\.json$/i, '')))
      if (!fs.existsSync(logPath)) return null
      const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8'))
      const log = parsed?.log
      if (!log || typeof log !== 'object') return null
      return {
        rawOutput: typeof parsed?.rawOutput === 'string' ? parsed.rawOutput : String(log.rawOutput || ''),
        log: log as GroupSummaryLog
      }
    } catch {
      return null
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const filePath = this.resolveFilePath()
    try {
      if (!fs.existsSync(filePath)) return
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const records = Array.isArray(parsed) ? parsed : parsed?.records
      if (!Array.isArray(records)) return

      const legacyRecords = records.filter((item) => item && typeof item === 'object') as LegacyGroupSummaryRecord[]
      const needsMigration = legacyRecords.some((record) => Boolean(record.log || record.rawOutput))
      if (needsMigration) {
        this.backupLegacyFile(filePath)
      }

      this.records = legacyRecords.map((record) => {
        const id = String(record.id || randomUUID())
        const logFile = record.log
          ? this.writeLogFile(id, record.log, String(record.rawOutput || record.log.rawOutput || ''))
          : record.logFile
        return {
          id,
          accountScope: String(record.accountScope || 'default'),
          createdAt: Number(record.createdAt || Date.now()),
          sessionId: String(record.sessionId || ''),
          displayName: String(record.displayName || record.sessionId || ''),
          avatarUrl: record.avatarUrl,
          triggerType: record.triggerType === 'auto' ? 'auto' : 'manual',
          periodStart: this.normalizeTimestampSeconds(record.periodStart),
          periodEnd: this.normalizeTimestampSeconds(record.periodEnd),
          messageCount: Math.max(0, Math.floor(Number(record.messageCount || 0))),
          readableMessageCount: Math.max(0, Math.floor(Number(record.readableMessageCount || 0))),
          topics: Array.isArray(record.topics) ? record.topics : [],
          summaryText: String(record.summaryText || ''),
          logFile
        }
      }).filter((record) => record.sessionId && record.periodStart > 0 && record.periodEnd > record.periodStart)

      if (needsMigration) {
        this.persist()
      }
    } catch {
      this.records = []
    }
  }

  private backupLegacyFile(filePath: string): void {
    try {
      const backupPath = `${filePath}.legacy-${Date.now()}.bak`
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(filePath, backupPath)
      }
    } catch {
      // Backup failure should not block reading existing records.
    }
  }

  private persist(): void {
    try {
      const filePath = this.resolveFilePath()
      fs.writeFileSync(filePath, JSON.stringify({ version: 2, records: this.records }, null, 2), 'utf-8')
    } catch {
      // Summary generation should not fail because local record persistence failed.
    }
  }

  private getCurrentAccountScope(): string {
    const config = ConfigService.getInstance()
    const myWxid = String(config.getMyWxidCleaned() || '').trim()
    if (myWxid) return `wxid:${myWxid}`

    const dbPath = String(config.get('dbPath') || '').trim()
    if (dbPath) {
      const hash = createHash('sha1').update(dbPath).digest('hex').slice(0, 16)
      return `db:${hash}`
    }
    return 'default'
  }

  private toSummary(record: GroupSummaryIndexRecord): GroupSummaryRecordSummary {
    return {
      id: record.id,
      createdAt: record.createdAt,
      sessionId: record.sessionId,
      displayName: record.displayName,
      avatarUrl: record.avatarUrl,
      triggerType: record.triggerType,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      messageCount: record.messageCount,
      readableMessageCount: record.readableMessageCount,
      topics: Array.isArray(record.topics) ? record.topics : [],
      summaryText: record.summaryText || ''
    }
  }

  private getScopedRecords(): GroupSummaryIndexRecord[] {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    return this.records.filter((record) => record.accountScope === scope)
  }

  addRecord(input: {
    sessionId: string
    displayName: string
    avatarUrl?: string
    triggerType: GroupSummaryTriggerType
    periodStart: number
    periodEnd: number
    messageCount: number
    readableMessageCount: number
    topics: GroupSummaryTopic[]
    summaryText: string
    rawOutput: string
    log: GroupSummaryLog
  }): GroupSummaryRecordSummary {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    const id = randomUUID()
    const logFile = this.writeLogFile(id, input.log, input.rawOutput)
    const record: GroupSummaryIndexRecord = {
      id,
      accountScope: scope,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      triggerType: input.triggerType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      messageCount: input.messageCount,
      readableMessageCount: input.readableMessageCount,
      topics: input.topics,
      summaryText: input.summaryText,
      logFile
    }

    this.records.push(record)
    const scopedRecords = this.records
      .filter((item) => item.accountScope === scope)
      .sort((a, b) => b.createdAt - a.createdAt)
    const keepIds = new Set(scopedRecords.slice(0, this.maxRecordsPerScope).map((item) => item.id))
    this.records = this.records.filter((item) => item.accountScope !== scope || keepIds.has(item.id))
    this.persist()
    return this.toSummary(record)
  }

  hasAutoRecord(sessionId: string, periodStart: number, periodEnd: number): boolean {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return false
    return this.getScopedRecords().some((record) =>
      record.triggerType === 'auto' &&
      record.sessionId === normalizedSessionId &&
      Number(record.periodStart || 0) === periodStart &&
      Number(record.periodEnd || 0) === periodEnd
    )
  }

  listRecords(filters: GroupSummaryRecordFilters = {}): GroupSummaryRecordListResult {
    try {
      const sessionId = String(filters.sessionId || '').trim()
      const startTime = this.normalizeTimestampSeconds(filters.startTime)
      const endTime = this.normalizeTimestampSeconds(filters.endTime)
      const offset = Math.max(0, Math.floor(Number(filters.offset || 0)))
      const limit = Math.min(200, Math.max(1, Math.floor(Number(filters.limit || 100))))

      const filtered = this.getScopedRecords()
        .filter((record) => {
          if (sessionId && record.sessionId !== sessionId) return false
          const periodStart = Number(record.periodStart || 0)
          const periodEnd = Number(record.periodEnd || 0)
          if (startTime > 0 && periodEnd < startTime) return false
          if (endTime > 0 && periodStart > endTime) return false
          return true
        })
        .sort((a, b) => Number(b.periodStart || b.createdAt) - Number(a.periodStart || a.createdAt))

      return {
        success: true,
        records: filtered.slice(offset, offset + limit).map((record) => this.toSummary(record)),
        total: filtered.length
      }
    } catch (error) {
      return { success: false, records: [], total: 0, error: (error as Error).message || String(error) }
    }
  }

  getRecord(id: string): { success: boolean; record?: GroupSummaryRecord; error?: string } {
    this.ensureLoaded()
    const normalizedId = String(id || '').trim()
    if (!normalizedId) return { success: false, error: '记录 ID 为空' }
    const scope = this.getCurrentAccountScope()
    const record = this.records.find((item) => item.id === normalizedId && item.accountScope === scope)
    if (!record) return { success: false, error: '未找到该群聊总结记录' }

    const logData = this.readLogFile(record.logFile)
    if (!logData) return { success: false, error: '未找到该群聊总结日志' }

    return {
      success: true,
      record: {
        ...this.toSummary(record),
        accountScope: record.accountScope,
        rawOutput: logData.rawOutput,
        log: logData.log
      }
    }
  }

  clearRuntimeCache(): void {
    this.loaded = false
    this.records = []
    this.filePath = null
    this.logDir = null
  }
}

export const groupSummaryRecordService = new GroupSummaryRecordService()
