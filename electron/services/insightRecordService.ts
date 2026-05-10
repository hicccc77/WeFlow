import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { ConfigService } from './config'

export type InsightRecordTriggerReason = 'activity' | 'silence' | 'test'

export interface InsightRecordLog {
  endpoint: string
  model: string
  maxTokens: number
  temperature: number
  triggerReason: InsightRecordTriggerReason
  allowContext: boolean
  contextCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalInsight: string
  durationMs: number
  createdAt: number
}

export interface InsightRecord {
  id: string
  accountScope: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerReason: InsightRecordTriggerReason
  insight: string
  read: boolean
  log: InsightRecordLog
}

export interface InsightRecordSummary {
  id: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerReason: InsightRecordTriggerReason
  insight: string
  read: boolean
}

export interface InsightRecordContactFacet {
  sessionId: string
  displayName: string
  avatarUrl?: string
  count: number
}

export interface InsightRecordFilters {
  keyword?: string
  sessionId?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

export interface InsightRecordListResult {
  success: boolean
  records: InsightRecordSummary[]
  total: number
  todayCount: number
  unreadCount: number
  contacts: InsightRecordContactFacet[]
  error?: string
}

class InsightRecordService {
  private readonly maxRecordsPerScope = 1000
  private filePath: string | null = null
  private loaded = false
  private records: InsightRecord[] = []

  private resolveFilePath(): string {
    if (this.filePath) return this.filePath
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    const userDataPath = workerUserDataPath || app?.getPath?.('userData') || process.cwd()
    fs.mkdirSync(userDataPath, { recursive: true })
    this.filePath = path.join(userDataPath, 'weflow-insight-records.json')
    return this.filePath
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const filePath = this.resolveFilePath()
    try {
      if (!fs.existsSync(filePath)) return
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.records = parsed.filter((item) => item && typeof item === 'object') as InsightRecord[]
      } else if (Array.isArray(parsed?.records)) {
        this.records = parsed.records.filter((item: unknown) => item && typeof item === 'object') as InsightRecord[]
      }
    } catch {
      this.records = []
    }
  }

  private persist(): void {
    try {
      const filePath = this.resolveFilePath()
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, records: this.records }, null, 2), 'utf-8')
    } catch {
      // Keep insight generation non-blocking even if local persistence fails.
    }
  }

  private getCurrentAccountScope(): string {
    const config = ConfigService.getInstance()
    const myWxid = String(config.get('myWxid') || '').trim()
    if (myWxid) return `wxid:${myWxid}`

    const dbPath = String(config.get('dbPath') || '').trim()
    if (dbPath) {
      const hash = createHash('sha1').update(dbPath).digest('hex').slice(0, 16)
      return `db:${hash}`
    }
    return 'default'
  }

  private getStartOfToday(): number {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  private toSummary(record: InsightRecord): InsightRecordSummary {
    return {
      id: record.id,
      createdAt: record.createdAt,
      sessionId: record.sessionId,
      displayName: record.displayName,
      avatarUrl: record.avatarUrl,
      triggerReason: record.triggerReason,
      insight: record.insight,
      read: record.read
    }
  }

  private getScopedRecords(): InsightRecord[] {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    return this.records.filter((record) => record.accountScope === scope)
  }

  addRecord(input: {
    sessionId: string
    displayName: string
    avatarUrl?: string
    triggerReason: InsightRecordTriggerReason
    insight: string
    log: InsightRecordLog
  }): InsightRecord {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    const now = Date.now()
    const record: InsightRecord = {
      id: randomUUID(),
      accountScope: scope,
      createdAt: now,
      sessionId: input.sessionId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      triggerReason: input.triggerReason,
      insight: input.insight,
      read: false,
      log: input.log
    }

    this.records.push(record)
    const scopedRecords = this.records
      .filter((item) => item.accountScope === scope)
      .sort((a, b) => b.createdAt - a.createdAt)
    const keepIds = new Set(scopedRecords.slice(0, this.maxRecordsPerScope).map((item) => item.id))
    this.records = this.records.filter((item) => item.accountScope !== scope || keepIds.has(item.id))
    this.persist()
    return record
  }

  listRecords(filters: InsightRecordFilters = {}): InsightRecordListResult {
    try {
      const allScoped = this.getScopedRecords()
      const todayStart = this.getStartOfToday()
      const contactsMap = new Map<string, InsightRecordContactFacet>()
      for (const record of allScoped) {
        const existing = contactsMap.get(record.sessionId)
        if (existing) {
          existing.count += 1
        } else {
          contactsMap.set(record.sessionId, {
            sessionId: record.sessionId,
            displayName: record.displayName,
            avatarUrl: record.avatarUrl,
            count: 1
          })
        }
      }

      const keyword = String(filters.keyword || '').trim().toLowerCase()
      const sessionId = String(filters.sessionId || '').trim()
      const startTime = Number(filters.startTime || 0)
      const endTime = Number(filters.endTime || 0)
      const offset = Math.max(0, Math.floor(Number(filters.offset || 0)))
      const limit = Math.min(200, Math.max(1, Math.floor(Number(filters.limit || 100))))

      const filtered = allScoped
        .filter((record) => {
          if (sessionId && record.sessionId !== sessionId) return false
          if (startTime > 0 && record.createdAt < startTime) return false
          if (endTime > 0 && record.createdAt > endTime) return false
          if (keyword) {
            const haystack = `${record.displayName}\n${record.sessionId}\n${record.insight}`.toLowerCase()
            if (!haystack.includes(keyword)) return false
          }
          return true
        })
        .sort((a, b) => b.createdAt - a.createdAt)

      return {
        success: true,
        records: filtered.slice(offset, offset + limit).map((record) => this.toSummary(record)),
        total: filtered.length,
        todayCount: allScoped.filter((record) => record.createdAt >= todayStart).length,
        unreadCount: allScoped.filter((record) => !record.read).length,
        contacts: Array.from(contactsMap.values()).sort((a, b) => b.count - a.count)
      }
    } catch (error) {
      return {
        success: false,
        records: [],
        total: 0,
        todayCount: 0,
        unreadCount: 0,
        contacts: [],
        error: (error as Error).message
      }
    }
  }

  getRecord(id: string): { success: boolean; record?: InsightRecord; error?: string } {
    this.ensureLoaded()
    const normalizedId = String(id || '').trim()
    if (!normalizedId) return { success: false, error: '记录 ID 为空' }
    const scope = this.getCurrentAccountScope()
    const record = this.records.find((item) => item.id === normalizedId && item.accountScope === scope)
    if (!record) return { success: false, error: '未找到该见解记录' }
    return { success: true, record }
  }

  markRecordRead(id: string): { success: boolean; error?: string } {
    this.ensureLoaded()
    const normalizedId = String(id || '').trim()
    const scope = this.getCurrentAccountScope()
    const record = this.records.find((item) => item.id === normalizedId && item.accountScope === scope)
    if (!record) return { success: false, error: '未找到该见解记录' }
    if (!record.read) {
      record.read = true
      this.persist()
    }
    return { success: true }
  }

  clearRecords(filters: InsightRecordFilters = {}): { success: boolean; removed: number; error?: string } {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    const sessionId = String(filters.sessionId || '').trim()
    const startTime = Number(filters.startTime || 0)
    const endTime = Number(filters.endTime || 0)
    let removed = 0
    this.records = this.records.filter((record) => {
      if (record.accountScope !== scope) return true
      if (sessionId && record.sessionId !== sessionId) return true
      if (startTime > 0 && record.createdAt < startTime) return true
      if (endTime > 0 && record.createdAt > endTime) return true
      removed += 1
      return false
    })
    this.persist()
    return { success: true, removed }
  }
}

export const insightRecordService = new InsightRecordService()
