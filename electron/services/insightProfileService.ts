import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { app } from 'electron'
import { randomUUID, createHash } from 'crypto'
import { ConfigService } from './config'
import { chatService, type Message } from './chatService'
import { wcdbService } from './wcdbService'

const API_TIMEOUT_MS = 45_000
const API_TEMPERATURE = 0.7
const MONTH_MATERIAL_CHAR_LIMIT = 45_000
const DIRECT_MONTH_MESSAGE_LIMIT = 1000
const MONTH_CURSOR_BATCH_SIZE = 800
const MAX_RETRY_ATTEMPTS = 5
const MONTHLY_OUTPUT_MIN_TOKENS = 1600
const FINAL_OUTPUT_MIN_TOKENS = 2400

type ProfileStatusValue = 'none' | 'ready' | 'running' | 'failed'

interface SharedAiModelConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
  maxTokens: number
}

interface ActiveProfileTask {
  taskId: string
  sessionId: string
  displayName: string
  controller: AbortController
  phase: string
  startedAt: number
  cursor?: number
}

interface MonthWindow {
  key: string
  label: string
  startSec: number
  endSec: number
}

interface MonthStats {
  total: number
  mine: number
  peer: number
  activeDays: number
  longestActiveDayStreak: number
  longestSilenceDays: number
  topHours: string[]
  firstTime?: number
  lastTime?: number
}

interface PreparedMonthMaterial {
  text: string
  compressed: boolean
  stats: MonthStats
  scannedMessages: number
  sampledMessages: number
}

interface MonthSummary {
  month: string
  messageCount: number
  compressed: boolean
  sampledMessages: number
  summary: string
}

export interface InsightProfileRecord {
  id: string
  accountScope: string
  sessionId: string
  displayName: string
  avatarUrl?: string
  createdAt: number
  updatedAt: number
  rangeStart: number
  rangeEnd: number
  months: string[]
  emptyMonths: string[]
  monthlySummaries: MonthSummary[]
  finalProfile: string
  stats: {
    scannedMessages: number
    summarizedMonths: number
    emptyMonths: number
    compressedMonths: number
  }
  model: string
}

export interface InsightProfileStatus {
  sessionId: string
  status: ProfileStatusValue
  updatedAt?: number
  error?: string
  phase?: string
  busy?: boolean
}

export interface InsightProfileStatusListResult {
  success: boolean
  statuses: Record<string, InsightProfileStatus>
  activeTask?: {
    sessionId: string
    displayName: string
    phase: string
    startedAt: number
  }
  error?: string
}

export interface InsightProfileGenerateResult {
  success: boolean
  message: string
  cancelled?: boolean
  profile?: InsightProfileRecord
  error?: string
}

class AbortRequestError extends Error {
  constructor(message = '画像任务已取消') {
    super(message)
    this.name = 'AbortError'
  }
}

class ApiRequestError extends Error {
  statusCode?: number
  responseBody?: string

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

function isAbortError(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError' || String((error as Error)?.message || '').includes('取消')
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortRequestError()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    abortIfNeeded(signal)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(new AbortRequestError())
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function normalizeApiMaxTokens(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1024
  return Math.min(2_000_000, Math.max(1, Math.floor(numeric)))
}

function buildApiUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  return `${base}${suffix}`
}

function formatPromptCurrentTime(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `当前系统时间：${year}年${month}月${day}日 ${hours}:${minutes}`
}

function appendPromptCurrentTime(prompt: string): string {
  const base = String(prompt || '').trimEnd()
  return base ? `${base}\n\n${formatPromptCurrentTime()}` : formatPromptCurrentTime()
}

function clampText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function truncateStructuredText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\u0000/g, '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function formatDateTime(timestampSeconds: number): string {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return ''
  const date = new Date(timestampSeconds * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function formatMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0)
}

function toSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

function buildRecentTwelveMonthWindows(now: Date = new Date()): MonthWindow[] {
  const currentMonthStart = getMonthStart(now)
  const windows: MonthWindow[] = []
  for (let index = 11; index >= 0; index -= 1) {
    const start = new Date(currentMonthStart)
    start.setMonth(currentMonthStart.getMonth() - index)
    const next = new Date(start)
    next.setMonth(start.getMonth() + 1)
    const isCurrentMonth = index === 0
    const end = isCurrentMonth ? now : new Date(next.getTime() - 1000)
    const key = formatMonthKey(start)
    windows.push({
      key,
      label: key,
      startSec: toSeconds(start),
      endSec: Math.max(toSeconds(start), toSeconds(end))
    })
  }
  return windows
}

function callProfileApi(
  config: SharedAiModelConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      abortIfNeeded(signal)
      const endpoint = buildApiUrl(config.apiBaseUrl, '/chat/completions')
      const urlObj = new URL(endpoint)
      const payload = JSON.stringify({
        model: config.model,
        messages,
        max_tokens: normalizeApiMaxTokens(maxTokens),
        temperature: API_TEMPERATURE,
        stream: false
      })
      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST' as const,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
          Authorization: `Bearer ${config.apiKey}`
        }
      }

      const requestFn = urlObj.protocol === 'https:' ? https.request : http.request
      const req = requestFn(requestOptions, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new ApiRequestError(`API 请求失败 (${res.statusCode}): ${data.slice(0, 200)}`, res.statusCode, data))
              return
            }
            const parsed = JSON.parse(data)
            const content = parsed?.choices?.[0]?.message?.content
            if (typeof content === 'string' && content.trim()) {
              resolve(content.trim())
            } else {
              reject(new Error(`API 返回格式异常: ${data.slice(0, 200)}`))
            }
          } catch {
            reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`))
          }
        })
      })

      const onAbort = () => {
        req.destroy(new AbortRequestError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      req.setTimeout(API_TIMEOUT_MS, () => {
        req.destroy()
        reject(new Error('API 请求超时'))
      })
      req.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(isAbortError(error) || signal?.aborted ? new AbortRequestError() : error)
      })
      req.on('close', () => {
        signal?.removeEventListener('abort', onAbort)
      })
      req.write(payload)
      req.end()
    } catch (error) {
      reject(error)
    }
  })
}

async function callProfileApiWithRetry(
  config: SharedAiModelConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  signal?: AbortSignal
): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    abortIfNeeded(signal)
    try {
      return await callProfileApi(config, messages, maxTokens, signal)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new AbortRequestError()
      lastError = error
      if (attempt >= MAX_RETRY_ATTEMPTS) break
      await sleep(Math.min(10_000, 800 * Math.pow(2, attempt - 1)), signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'API 请求失败'))
}

class InsightProfileService {
  private readonly config = ConfigService.getInstance()
  private filePath: string | null = null
  private loaded = false
  private records: InsightProfileRecord[] = []
  private activeTask: ActiveProfileTask | null = null
  private failedStatus = new Map<string, { error: string; updatedAt: number }>()

  private resolveFilePath(): string {
    if (this.filePath) return this.filePath
    const userDataPath = app?.getPath?.('userData') || process.cwd()
    fs.mkdirSync(userDataPath, { recursive: true })
    this.filePath = path.join(userDataPath, 'weflow-insight-profiles.json')
    return this.filePath
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const filePath = this.resolveFilePath()
      if (!fs.existsSync(filePath)) return
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const records = Array.isArray(parsed) ? parsed : parsed?.records
      if (Array.isArray(records)) {
        this.records = records.filter((item) => item && typeof item === 'object') as InsightProfileRecord[]
      }
    } catch {
      this.records = []
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.resolveFilePath(), JSON.stringify({ version: 1, records: this.records }, null, 2), 'utf-8')
    } catch {
      // Profile generation should not crash when local persistence fails.
    }
  }

  private getCurrentAccountScope(): string {
    const myWxid = String(this.config.getMyWxidCleaned() || '').trim()
    if (myWxid) return `wxid:${myWxid}`
    const dbPath = String(this.config.get('dbPath') || '').trim()
    if (dbPath) {
      const hash = createHash('sha1').update(dbPath).digest('hex').slice(0, 16)
      return `db:${hash}`
    }
    return 'default'
  }

  private getSharedAiModelConfig(): SharedAiModelConfig {
    const apiBaseUrl = String(
      this.config.get('aiModelApiBaseUrl')
      || this.config.get('aiInsightApiBaseUrl')
      || ''
    ).trim().replace(/\/+$/, '')
    const apiKey = String(
      this.config.get('aiModelApiKey')
      || this.config.get('aiInsightApiKey')
      || ''
    ).trim()
    const model = String(
      this.config.get('aiModelApiModel')
      || this.config.get('aiInsightApiModel')
      || 'gpt-4o-mini'
    ).trim() || 'gpt-4o-mini'
    const maxTokens = normalizeApiMaxTokens(this.config.get('aiModelApiMaxTokens'))
    return { apiBaseUrl, apiKey, model, maxTokens }
  }

  private findLatestRecord(sessionId: string): InsightProfileRecord | null {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return null
    const matches = this.records
      .filter((record) => record.accountScope === scope && record.sessionId === normalizedSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return matches[0] || null
  }

  listProfileStatuses(sessionIds: string[]): InsightProfileStatusListResult {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    const normalizedIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
    const latestBySession = new Map<string, InsightProfileRecord>()
    for (const record of this.records.filter((item) => item.accountScope === scope)) {
      const existing = latestBySession.get(record.sessionId)
      if (!existing || record.updatedAt > existing.updatedAt) {
        latestBySession.set(record.sessionId, record)
      }
    }

    const statuses: Record<string, InsightProfileStatus> = {}
    for (const sessionId of normalizedIds) {
      const activeForSession = this.activeTask?.sessionId === sessionId
      if (activeForSession && this.activeTask) {
        statuses[sessionId] = {
          sessionId,
          status: 'running',
          phase: this.activeTask.phase,
          updatedAt: this.activeTask.startedAt,
          busy: false
        }
        continue
      }

      const record = latestBySession.get(sessionId)
      if (record) {
        statuses[sessionId] = {
          sessionId,
          status: 'ready',
          updatedAt: record.updatedAt,
          busy: Boolean(this.activeTask)
        }
        continue
      }

      const failed = this.failedStatus.get(sessionId)
      if (failed) {
        statuses[sessionId] = {
          sessionId,
          status: 'failed',
          updatedAt: failed.updatedAt,
          error: failed.error,
          busy: Boolean(this.activeTask)
        }
        continue
      }

      statuses[sessionId] = {
        sessionId,
        status: 'none',
        busy: Boolean(this.activeTask)
      }
    }

    return {
      success: true,
      statuses,
      activeTask: this.activeTask
        ? {
          sessionId: this.activeTask.sessionId,
          displayName: this.activeTask.displayName,
          phase: this.activeTask.phase,
          startedAt: this.activeTask.startedAt
        }
        : undefined
    }
  }

  getProfileContextSection(sessionId: string): string {
    const record = this.findLatestRecord(sessionId)
    if (!record?.finalProfile) return ''
    const rangeStart = formatDateTime(record.rangeStart)
    const rangeEnd = formatDateTime(record.rangeEnd)
    return [
      `联系人长期 AI 画像（覆盖 ${rangeStart} 至 ${rangeEnd}，生成于 ${new Date(record.updatedAt).toLocaleString('zh-CN')}）：`,
      clampText(record.finalProfile, 3000)
    ].join('\n')
  }

  cancelProfile(sessionId?: string): { success: boolean; message: string } {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!this.activeTask) return { success: true, message: '当前没有画像任务' }
    if (normalizedSessionId && normalizedSessionId !== this.activeTask.sessionId) {
      return { success: false, message: '当前运行中的画像任务不属于该联系人' }
    }
    this.activeTask.phase = '正在取消画像...'
    this.activeTask.controller.abort()
    return { success: true, message: '已请求取消画像任务' }
  }

  cancelActiveTask(reason = '画像任务已取消'): void {
    if (!this.activeTask) return
    this.activeTask.phase = reason
    this.activeTask.controller.abort()
  }

  async generateProfile(params: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
  }): Promise<InsightProfileGenerateResult> {
    const sessionId = String(params?.sessionId || '').trim()
    if (!sessionId || sessionId.endsWith('@chatroom')) {
      return { success: false, message: 'AI 画像仅支持私聊联系人' }
    }
    if (this.activeTask) {
      return {
        success: false,
        message: `「${this.activeTask.displayName}」的画像正在生成，请等待完成或取消后再试`
      }
    }

    const aiConfig = this.getSharedAiModelConfig()
    if (!aiConfig.apiBaseUrl || !aiConfig.apiKey) {
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    const existing = this.findLatestRecord(sessionId)
    const displayName = clampText(params?.displayName || existing?.displayName || sessionId, 80) || sessionId
    const controller = new AbortController()
    const task: ActiveProfileTask = {
      taskId: randomUUID(),
      sessionId,
      displayName,
      controller,
      phase: '正在初始化画像...',
      startedAt: Date.now()
    }
    this.activeTask = task

    try {
      const connectResult = await chatService.connect()
      abortIfNeeded(controller.signal)
      if (!connectResult.success) {
        throw new Error('数据库连接失败，请先在“数据库连接”页完成配置')
      }

      const windows = buildRecentTwelveMonthWindows()
      const monthlySummaries: MonthSummary[] = []
      const emptyMonths: string[] = []
      let scannedMessages = 0
      let compressedMonths = 0

      for (let index = 0; index < windows.length; index += 1) {
        abortIfNeeded(controller.signal)
        const month = windows[index]
        task.phase = `正在读取 ${month.label} 聊天记录 (${index + 1}/12)...`
        const messages = await this.readMonthMessages(sessionId, month, task)
        scannedMessages += messages.length

        if (messages.length === 0) {
          emptyMonths.push(month.label)
          continue
        }

        const material = this.prepareMonthMaterial(messages, displayName)
        if (material.compressed) compressedMonths += 1

        task.phase = `正在生成 ${month.label} 月度画像 (${monthlySummaries.length + 1})...`
        const summary = await this.generateMonthlySummary(aiConfig, displayName, month.label, material, controller.signal)
        monthlySummaries.push({
          month: month.label,
          messageCount: material.scannedMessages,
          compressed: material.compressed,
          sampledMessages: material.sampledMessages,
          summary
        })
      }

      if (monthlySummaries.length === 0) {
        throw new Error('最近 12 个自然月没有可用于画像的聊天记录')
      }

      task.phase = '正在汇总完整 AI 画像...'
      const finalProfile = await this.generateFinalProfile(aiConfig, displayName, windows, emptyMonths, monthlySummaries, controller.signal)
      abortIfNeeded(controller.signal)

      const now = Date.now()
      const record: InsightProfileRecord = {
        id: randomUUID(),
        accountScope: this.getCurrentAccountScope(),
        sessionId,
        displayName,
        avatarUrl: String(params?.avatarUrl || existing?.avatarUrl || '').trim() || undefined,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        rangeStart: windows[0].startSec,
        rangeEnd: windows[windows.length - 1].endSec,
        months: windows.map((month) => month.label),
        emptyMonths,
        monthlySummaries,
        finalProfile,
        stats: {
          scannedMessages,
          summarizedMonths: monthlySummaries.length,
          emptyMonths: emptyMonths.length,
          compressedMonths
        },
        model: aiConfig.model
      }

      this.upsertRecord(record)
      this.failedStatus.delete(sessionId)
      return {
        success: true,
        message: `已完成「${displayName}」的 AI 画像`,
        profile: record
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        return { success: false, cancelled: true, message: '画像已取消' }
      }
      const message = (error as Error).message || String(error)
      if (!existing) {
        this.failedStatus.set(sessionId, { error: message, updatedAt: Date.now() })
      }
      return { success: false, message: `画像失败：${message}`, error: message }
    } finally {
      if (task.cursor) {
        await wcdbService.closeMessageCursor(task.cursor).catch(() => {})
      }
      if (this.activeTask?.taskId === task.taskId) {
        this.activeTask = null
      }
    }
  }

  private upsertRecord(record: InsightProfileRecord): void {
    this.ensureLoaded()
    this.records = this.records.filter((item) => !(item.accountScope === record.accountScope && item.sessionId === record.sessionId))
    this.records.push(record)
    this.persist()
  }

  private async readMonthMessages(sessionId: string, month: MonthWindow, task: ActiveProfileTask): Promise<Message[]> {
    const cursorResult = await wcdbService.openMessageCursorLite(
      sessionId,
      MONTH_CURSOR_BATCH_SIZE,
      true,
      month.startSec,
      month.endSec
    )
    if (!cursorResult.success || !cursorResult.cursor) {
      throw new Error(cursorResult.error || `读取 ${month.label} 聊天记录失败`)
    }

    task.cursor = cursorResult.cursor
    const messages: Message[] = []
    try {
      while (true) {
        abortIfNeeded(task.controller.signal)
        const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        if (!batch.success) {
          throw new Error(batch.error || `读取 ${month.label} 聊天记录失败`)
        }
        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        if (rows.length > 0) {
          const mapped = chatService.mapRowsToMessagesLiteForApi(rows)
          for (const message of mapped) {
            const createTime = Number(message.createTime || 0)
            if (createTime < month.startSec || createTime > month.endSec) continue
            messages.push({
              ...message,
              rawContent: clampText(message.rawContent || message.content || '', 1200),
              content: undefined
            })
          }
        }
        if (!batch.hasMore) break
      }
      messages.sort((a, b) => (a.createTime - b.createTime) || (a.sortSeq - b.sortSeq) || (a.localId - b.localId))
      return messages
    } finally {
      await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
      if (task.cursor === cursorResult.cursor) task.cursor = undefined
    }
  }

  private prepareMonthMaterial(messages: Message[], peerDisplayName: string): PreparedMonthMaterial {
    const stats = this.computeMonthStats(messages)
    const lines = messages.map((message) => this.formatMessageLine(message, peerDisplayName))
    const fullText = lines.join('\n')
    if (messages.length <= DIRECT_MONTH_MESSAGE_LIMIT && fullText.length <= MONTH_MATERIAL_CHAR_LIMIT) {
      return {
        text: fullText,
        compressed: false,
        stats,
        scannedMessages: messages.length,
        sampledMessages: messages.length
      }
    }

    const statsText = this.formatMonthStats(stats)
    const selectedIndices = this.selectRepresentativeIndices(messages)
    const sampledLines = Array.from(selectedIndices)
      .sort((a, b) => a - b)
      .map((index) => lines[index])

    const sampledText = this.fitLinesToBudget(sampledLines, Math.max(10_000, MONTH_MATERIAL_CHAR_LIMIT - statsText.length - 800))
    const text = [
      '本月聊天记录已完整扫描。由于原文过长，以下为本地统计摘要、时间均匀抽样与高信息密度片段；请基于这些证据谨慎概括，不要把抽样片段视为全部事实。',
      '',
      statsText,
      '',
      '代表性聊天片段（按时间顺序）：',
      sampledText || '无可读文本片段'
    ].join('\n')

    return {
      text: truncateStructuredText(text, MONTH_MATERIAL_CHAR_LIMIT),
      compressed: true,
      stats,
      scannedMessages: messages.length,
      sampledMessages: sampledLines.length
    }
  }

  private computeMonthStats(messages: Message[]): MonthStats {
    const daySet = new Set<string>()
    const hourCounts = new Map<number, number>()
    let mine = 0
    let peer = 0
    let firstTime = 0
    let lastTime = 0

    for (const message of messages) {
      const ts = Math.max(0, Math.floor(Number(message.createTime || 0)))
      if (ts > 0) {
        if (!firstTime || ts < firstTime) firstTime = ts
        if (!lastTime || ts > lastTime) lastTime = ts
        const date = new Date(ts * 1000)
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        daySet.add(day)
        const hour = date.getHours()
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
      }
      if (message.isSend === 1) mine += 1
      else peer += 1
    }

    const sortedDays = Array.from(daySet).sort()
    let longestActiveDayStreak = 0
    let currentStreak = 0
    let longestSilenceDays = 0
    let prevDayTime = 0
    for (const day of sortedDays) {
      const dayTime = new Date(`${day}T00:00:00`).getTime()
      if (!prevDayTime || dayTime - prevDayTime === 86_400_000) {
        currentStreak += 1
      } else {
        currentStreak = 1
        longestSilenceDays = Math.max(longestSilenceDays, Math.floor((dayTime - prevDayTime) / 86_400_000) - 1)
      }
      prevDayTime = dayTime
      longestActiveDayStreak = Math.max(longestActiveDayStreak, currentStreak)
    }

    const topHours = Array.from(hourCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, count]) => `${String(hour).padStart(2, '0')}:00（${count}条）`)

    return {
      total: messages.length,
      mine,
      peer,
      activeDays: daySet.size,
      longestActiveDayStreak,
      longestSilenceDays,
      topHours,
      firstTime: firstTime || undefined,
      lastTime: lastTime || undefined
    }
  }

  private formatMonthStats(stats: MonthStats): string {
    return [
      '本月统计摘要：',
      `消息总数：${stats.total}`,
      `我发送：${stats.mine}；对方发送：${stats.peer}`,
      `活跃天数：${stats.activeDays}`,
      `最长连续活跃：${stats.longestActiveDayStreak} 天`,
      `最长无互动间隔：${stats.longestSilenceDays} 天`,
      `主要互动时段：${stats.topHours.length > 0 ? stats.topHours.join('、') : '无'}`,
      `首条消息时间：${stats.firstTime ? formatDateTime(stats.firstTime) : '无'}`,
      `末条消息时间：${stats.lastTime ? formatDateTime(stats.lastTime) : '无'}`
    ].join('\n')
  }

  private selectRepresentativeIndices(messages: Message[]): Set<number> {
    const selected = new Set<number>()
    const addWindow = (center: number, radius = 2) => {
      for (let index = Math.max(0, center - radius); index <= Math.min(messages.length - 1, center + radius); index += 1) {
        selected.add(index)
      }
    }

    if (messages.length === 0) return selected

    const bucketCount = Math.min(24, Math.max(6, Math.ceil(messages.length / 250)))
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const start = Math.floor((messages.length * bucket) / bucketCount)
      const end = Math.max(start, Math.floor((messages.length * (bucket + 1)) / bucketCount) - 1)
      addWindow(start, 1)
      addWindow(Math.floor((start + end) / 2), 1)
      addWindow(end, 1)
    }

    const scored = messages.map((message, index) => ({
      index,
      score: this.scoreMessageForProfile(message)
    }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 120)

    for (const item of scored) {
      addWindow(item.index, 2)
    }

    addWindow(0, 3)
    addWindow(Math.floor(messages.length / 2), 3)
    addWindow(messages.length - 1, 3)
    return selected
  }

  private scoreMessageForProfile(message: Message): number {
    const content = this.extractReadableContent(message)
    if (!content || content.startsWith('[')) return 0
    const emotionWords = [
      '谢谢', '感谢', '抱歉', '对不起', '开心', '高兴', '难过', '委屈', '生气', '焦虑', '压力', '累',
      '想你', '喜欢', '爱', '在乎', '担心', '害怕', '烦', '崩溃', '见面', '一起', '约', '陪', '帮'
    ]
    let score = Math.min(80, content.length)
    if (/[?？]/.test(content)) score += 18
    if (/[!！]{1,}/.test(content)) score += 8
    for (const word of emotionWords) {
      if (content.includes(word)) score += 24
    }
    if (message.quotedContent) score += 12
    if (content.length >= 80) score += 16
    return score
  }

  private fitLinesToBudget(lines: string[], budget: number): string {
    const output: string[] = []
    let used = 0
    for (const line of lines) {
      const normalized = clampText(line, 700)
      const nextUsed = used + normalized.length + 1
      if (nextUsed > budget) break
      output.push(normalized)
      used = nextUsed
    }
    return output.join('\n')
  }

  private extractReadableContent(message: Message): string {
    const parsed = String(message.parsedContent || '').trim()
    if (parsed) return clampText(parsed, 600)
    const raw = String(message.rawContent || message.content || '').trim()
    if (!raw) return '[其他消息]'
    if (/^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b|&lt;)/i.test(raw)) {
      return '[其他消息]'
    }
    return clampText(raw, 600)
  }

  private formatMessageLine(message: Message, peerDisplayName: string): string {
    const sender = message.isSend === 1 ? '我' : peerDisplayName
    const content = this.extractReadableContent(message)
    const quoted = message.quotedContent ? ` [引用：${clampText(message.quotedContent, 120)}]` : ''
    return `${formatDateTime(message.createTime)} ${sender}：${content}${quoted}`
  }

  private async generateMonthlySummary(
    config: SharedAiModelConfig,
    displayName: string,
    monthLabel: string,
    material: PreparedMonthMaterial,
    signal?: AbortSignal
  ): Promise<string> {
    const systemPrompt = `你是一个克制、细致的长期关系画像分析助手。你只根据给定聊天材料分析，不做诊断，不给道德评判，不编造事实。你的目标是从一个自然月的聊天中提炼这个人的沟通风格、情绪模式、关系需求、关注主题、互动节奏，以及与“我”的关系变化线索。

要求：
1. 输出中文纯文本，不使用 Markdown。
2. 控制在 400-600 字。
3. 必须区分“有证据支持的观察”和“不确定但可留意的倾向”。
4. 不要逐条复述聊天记录，要提炼稳定模式和本月变化。
5. 对敏感内容使用概括，不输出隐私细节。
6. 如果材料经过压缩或抽样，明确保持谨慎，不把局部片段当成全部事实。`

    const userPrompt = appendPromptCurrentTime(`对象：${displayName}
月份：${monthLabel}
材料状态：${material.compressed ? '本月原始记录过长，已完整扫描后进行本地结构化压缩与代表性抽样' : '本月记录未超过预算，按时间顺序提供'}
扫描消息数：${material.scannedMessages}
用于输入的代表消息数：${material.sampledMessages}

本月聊天材料：
${material.text}

请输出本月画像总结，覆盖：沟通风格、情绪与压力线索、关注主题、与我的互动模式、本月关系变化、后续相处建议。`)

    return callProfileApiWithRetry(
      config,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      Math.max(config.maxTokens, MONTHLY_OUTPUT_MIN_TOKENS),
      signal
    )
  }

  private async generateFinalProfile(
    config: SharedAiModelConfig,
    displayName: string,
    months: MonthWindow[],
    emptyMonths: string[],
    monthlySummaries: MonthSummary[],
    signal?: AbortSignal
  ): Promise<string> {
    const systemPrompt = `你是用户的私人关系画像整理助手。你需要把最近 12 个自然月的月度画像总结合成为一份长期 AI 画像。你只能基于月度总结和空月信息判断，不编造缺失月份内容。

要求：
1. 输出中文纯文本，不使用 Markdown。
2. 控制在 900-1400 字。
3. 画像要稳定、克制、可用于后续 AI 见解上下文。
4. 优先总结长期模式，其次指出近三个月变化。
5. 给出与这个人互动时最值得注意的 3-5 条原则。
6. 不做医学、法律、心理诊断；避免贴标签式结论。`

    const summaryText = monthlySummaries
      .map((item) => `【${item.month}】消息数：${item.messageCount}；材料${item.compressed ? '已压缩抽样' : '未压缩'}\n${item.summary}`)
      .join('\n\n')

    const userPrompt = appendPromptCurrentTime(`对象：${displayName}
时间范围：${months[0].label} 至 ${months[months.length - 1].label}
空月：${emptyMonths.length > 0 ? emptyMonths.join('、') : '无'}

月度总结：
${summaryText}

请生成完整 AI 画像，结构包含：整体印象、沟通风格、情绪/压力模式、核心关注、关系互动模式、最近变化、相处建议、后续 AI 见解使用注意事项。`)

    return callProfileApiWithRetry(
      config,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      Math.max(config.maxTokens, FINAL_OUTPUT_MIN_TOKENS),
      signal
    )
  }
}

export const insightProfileService = new InsightProfileService()
