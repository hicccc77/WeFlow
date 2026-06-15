import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export interface ExportRecord {
  exportTime: number
  format: string
  messageCount: number
  sourceLatestMessageTimestamp?: number
  outputPath?: string
}

type RecordStore = Record<string, ExportRecord[]>

class ExportRecordService {
  private filePath: string | null = null
  private loaded = false
  private store: RecordStore = {}

  private resolveFilePath(): string {
    if (this.filePath) return this.filePath
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    const userDataPath = workerUserDataPath || app?.getPath?.('userData') || process.cwd()
    fs.mkdirSync(userDataPath, { recursive: true })
    this.filePath = path.join(userDataPath, 'weflow-export-records.json')
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
      if (parsed && typeof parsed === 'object') {
        this.store = parsed as RecordStore
      }
    } catch {
      this.store = {}
    }
  }

  private persist(): void {
    try {
      const filePath = this.resolveFilePath()
      fs.writeFileSync(filePath, JSON.stringify(this.store), 'utf-8')
    } catch {
      // ignore persist errors to avoid blocking export flow
    }
  }

  getLatestRecord(sessionId: string, format: string): ExportRecord | null {
    this.ensureLoaded()
    const records = this.store[sessionId]
    if (!records || records.length === 0) return null
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]
      if (record && record.format === format) return record
    }
    return null
  }

  saveRecord(
    sessionId: string,
    format: string,
    messageCount: number,
    extra?: {
      sourceLatestMessageTimestamp?: number
      outputPath?: string
    }
  ): void {
    this.ensureLoaded()
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return
    if (!this.store[normalizedSessionId]) {
      this.store[normalizedSessionId] = []
    }
    const list = this.store[normalizedSessionId]
    list.push({
      exportTime: Date.now(),
      format,
      messageCount,
      sourceLatestMessageTimestamp: extra?.sourceLatestMessageTimestamp,
      outputPath: extra?.outputPath
    })
    // keep the latest 30 records per session
    if (list.length > 30) {
      this.store[normalizedSessionId] = list.slice(-30)
    }
    this.persist()
  }
}

export const exportRecordService = new ExportRecordService()
