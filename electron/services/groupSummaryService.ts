import https from 'https'
import http from 'http'
import { URL } from 'url'
import groupSummaryPrompt from '../../shared/groupSummaryPrompt.json'
import { ConfigService } from './config'
import { chatService, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import {
  groupSummaryRecordService,
  type GroupSummaryLog,
  type GroupSummaryRecord,
  type GroupSummaryRecordFilters,
  type GroupSummaryRecordListResult,
  type GroupSummaryRecordSummary,
  type GroupSummaryTopic,
  type GroupSummaryTriggerType
} from './groupSummaryRecordService'

const API_TIMEOUT_MS = 90_000
const API_TEMPERATURE = 0.4
const MIN_SUMMARY_MESSAGES = 5
const MAX_MANUAL_RANGE_SECONDS = 48 * 60 * 60
const MAX_MESSAGES_PER_SUMMARY = 3000
const SUMMARY_CURSOR_BATCH_SIZE = 360
const DEFAULT_GROUP_SUMMARY_SYSTEM_PROMPT = String(groupSummaryPrompt.defaultSystemPrompt || '').trim()
const SUMMARY_CONFIG_KEYS = new Set([
  'aiGroupSummaryEnabled',
  'aiGroupSummaryIntervalHours',
  'aiGroupSummarySystemPrompt',
  'aiGroupSummaryFilterMode',
  'aiGroupSummaryFilterList',
  'aiModelApiBaseUrl',
  'aiModelApiKey',
  'aiModelApiModel',
  'aiInsightApiBaseUrl',
  'aiInsightApiKey',
  'aiInsightApiModel',
  'dbPath',
  'decryptKey',
  'myWxid'
])

interface SharedAiModelConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
}

interface GroupSummaryTriggerResult {
  success: boolean
  message: string
  recordId?: string
  record?: GroupSummaryRecordSummary
  skipped?: boolean
  skippedReason?: string
}

interface GroupSummaryDayTriggerResult {
  success: boolean
  message: string
  generated: number
  skipped: number
  records: GroupSummaryRecordSummary[]
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

function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function normalizeSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
}

function normalizeIntervalHours(value: unknown): number {
  const allowed = new Set([1, 2, 4, 8, 12, 24])
  const numeric = Math.floor(Number(value) || 4)
  return allowed.has(numeric) ? numeric : 4
}

function getStartOfDaySeconds(date: Date = new Date()): number {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return Math.floor(next.getTime() / 1000)
}

function clampText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function stripJsonFence(value: string): string {
  const text = String(value || '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim()
  }
  return text
}

function shouldFallbackJsonMode(error: unknown): boolean {
  const statusCode = (error as ApiRequestError)?.statusCode
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) return true
  const text = `${(error as Error)?.message || ''}\n${(error as ApiRequestError)?.responseBody || ''}`.toLowerCase()
  return text.includes('response_format') || text.includes('json_object') || text.includes('json mode')
}

function formatTimestamp(createTime: number): string {
  const ms = createTime > 1_000_000_000_000 ? createTime : createTime * 1000
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function callChatCompletions(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  options?: { responseFormatJson?: boolean }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch {
      reject(new Error(`无效的 API URL: ${endpoint}`))
      return
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: API_TEMPERATURE,
      stream: false
    }
    if (options?.responseFormatJson) {
      payload.response_format = { type: 'json_object' }
    }

    const body = JSON.stringify(payload)
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        Authorization: `Bearer ${apiKey}`
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

    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('API 请求超时'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function parseTopics(rawOutput: string): GroupSummaryTopic[] {
  const parsed = JSON.parse(stripJsonFence(rawOutput)) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型输出格式异常：JSON 根节点不是对象')
  }
  const source = parsed as Record<string, unknown>
  const rawTopics = Array.isArray(source.topics) ? source.topics : []
  const topics = rawTopics.map((item, index) => {
    const topic = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const participantsRaw = Array.isArray(topic.participants) ? topic.participants : []
    const keyPointsRaw = Array.isArray(topic.key_points)
      ? topic.key_points
      : (Array.isArray(topic.keyPoints) ? topic.keyPoints : [])
    return {
      title: clampText(topic.title || `话题 ${index + 1}`, 48) || `话题 ${index + 1}`,
      participants: participantsRaw.map((value) => clampText(value, 24)).filter(Boolean).slice(0, 12),
      keyPoints: keyPointsRaw.map((value) => clampText(value, 120)).filter(Boolean).slice(0, 8),
      conclusion: clampText(topic.conclusion, 180) || '无明确结论'
    }
  }).filter((topic) => topic.title || topic.keyPoints.length > 0 || topic.conclusion)

  if (topics.length === 0) {
    throw new Error('模型输出格式异常：topics 为空')
  }
  return topics
}

function buildSummaryText(topics: GroupSummaryTopic[]): string {
  return topics.map((topic) => {
    const participants = topic.participants.length > 0 ? topic.participants.join('、') : '未明确'
    const keyPoints = topic.keyPoints.length > 0 ? topic.keyPoints.join('；') : '无'
    return `【${topic.title}】参与者：${participants}。关键/矛盾点：${keyPoints}。结论：${topic.conclusion}`
  }).join('\n')
}

function fallbackTopicFromRaw(rawOutput: string): GroupSummaryTopic {
  return {
    title: '未归类总结',
    participants: [],
    keyPoints: [clampText(rawOutput, 500)],
    conclusion: '模型未按固定 JSON 格式返回，请查看完整日志。'
  }
}

class GroupSummaryService {
  private config: ConfigService
  private started = false
  private scanTimer: NodeJS.Timeout | null = null
  private processing = false
  private pendingAutoRun = false
  private dbConnected = false

  constructor() {
    this.config = ConfigService.getInstance()
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  stop(): void {
    this.started = false
    this.clearTimers()
    this.processing = false
    this.pendingAutoRun = false
    this.dbConnected = false
  }

  async handleConfigChanged(key: string): Promise<void> {
    const normalizedKey = String(key || '').trim()
    if (!SUMMARY_CONFIG_KEYS.has(normalizedKey)) return
    if (normalizedKey === 'aiGroupSummarySystemPrompt') return
    if (normalizedKey === 'dbPath' || normalizedKey === 'decryptKey' || normalizedKey === 'myWxid') {
      this.dbConnected = false
      groupSummaryRecordService.clearRuntimeCache()
    }
    await this.refreshConfiguration(`config:${normalizedKey}`)
  }

  handleConfigCleared(): void {
    this.clearTimers()
    this.processing = false
    this.pendingAutoRun = false
    this.dbConnected = false
    groupSummaryRecordService.clearRuntimeCache()
  }

  listRecords(filters?: GroupSummaryRecordFilters): GroupSummaryRecordListResult {
    return groupSummaryRecordService.listRecords(filters || {})
  }

  getRecord(id: string): { success: boolean; record?: GroupSummaryRecord; error?: string } {
    return groupSummaryRecordService.getRecord(id)
  }

  async triggerManual(params: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
    startTime: number
    endTime: number
  }): Promise<GroupSummaryTriggerResult> {
    if (!this.isEnabled()) {
      return { success: false, message: '请先在设置中开启「AI 群聊总结」' }
    }
    const sessionId = String(params?.sessionId || '').trim()
    if (!sessionId.endsWith('@chatroom')) {
      return { success: false, message: 'AI 群聊总结仅支持群聊' }
    }
    const startTime = this.normalizeTimestampSeconds(params?.startTime)
    const endTime = this.normalizeTimestampSeconds(params?.endTime)
    if (startTime <= 0 || endTime <= startTime) {
      return { success: false, message: '请选择有效的总结时段' }
    }
    if (endTime - startTime > MAX_MANUAL_RANGE_SECONDS) {
      return { success: false, message: '手动总结时段不能超过 48 小时' }
    }

    const rawDisplayName = typeof params?.displayName === 'string' ? params.displayName : ''
    const displayName = rawDisplayName.length > 0 ? (rawDisplayName.trim() || rawDisplayName) : sessionId
    const avatarUrl = String(params?.avatarUrl || '').trim() || undefined
    return this.generateSummaryForPeriod({
      sessionId,
      displayName,
      avatarUrl,
      periodStart: startTime,
      periodEnd: endTime,
      triggerType: 'manual'
    })
  }

  async triggerDay(params: {
    sessionId: string
    displayName?: string
    avatarUrl?: string
    date: string
  }): Promise<GroupSummaryDayTriggerResult> {
    if (!this.isEnabled()) {
      return { success: false, message: '请先在设置中开启「AI 群聊总结」', generated: 0, skipped: 0, records: [] }
    }
    const sessionId = String(params?.sessionId || '').trim()
    if (!sessionId.endsWith('@chatroom')) {
      return { success: false, message: 'AI 群聊总结仅支持群聊', generated: 0, skipped: 0, records: [] }
    }
    const dayRange = this.parseLocalDateDayRange(params?.date)
    if (!dayRange) {
      return { success: false, message: '请选择有效日期', generated: 0, skipped: 0, records: [] }
    }
    const todayStart = getStartOfDaySeconds(new Date())
    if (dayRange.start > todayStart) {
      return { success: false, message: '不能总结未来日期', generated: 0, skipped: 0, records: [] }
    }

    const now = Math.floor(Date.now() / 1000)
    const effectiveEnd = dayRange.start === todayStart ? Math.min(dayRange.end, now) : dayRange.end
    const periods = this.getIntervalPeriods(dayRange.start, effectiveEnd, false)
    if (periods.length === 0) {
      return { success: true, message: '当前日期暂无已完成的总结时段', generated: 0, skipped: 0, records: [] }
    }

    const rawDisplayName = typeof params?.displayName === 'string' ? params.displayName : ''
    const displayName = rawDisplayName.length > 0 ? (rawDisplayName.trim() || rawDisplayName) : sessionId
    const avatarUrl = String(params?.avatarUrl || '').trim() || undefined
    return this.generateSummariesForPeriods({
      sessionId,
      displayName,
      avatarUrl,
      periods,
      triggerType: 'manual'
    })
  }

  private async refreshConfiguration(_reason: string): Promise<void> {
    if (!this.started) return
    this.clearTimers()
    if (!this.isEnabled()) return
    await this.queueDueAutoSummaries()
    this.scheduleNextAutoRun()
  }

  private isEnabled(): boolean {
    return this.config.get('aiGroupSummaryEnabled') === true
  }

  private clearTimers(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  }

  private scheduleNextAutoRun(): void {
    if (!this.started || !this.isEnabled()) return
    const intervalHours = normalizeIntervalHours(this.config.get('aiGroupSummaryIntervalHours'))
    const now = Math.floor(Date.now() / 1000)
    const dayStart = getStartOfDaySeconds(new Date())
    const intervalSeconds = intervalHours * 60 * 60
    const elapsed = Math.max(0, now - dayStart)
    const nextBoundary = dayStart + (Math.floor(elapsed / intervalSeconds) + 1) * intervalSeconds
    const delayMs = Math.max(1_000, (nextBoundary - now) * 1000 + 1_000)

    this.scanTimer = setTimeout(async () => {
      this.scanTimer = null
      await this.queueDueAutoSummaries()
      this.scheduleNextAutoRun()
    }, delayMs)
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.dbConnected) return true
    const result = await chatService.connect()
    this.dbConnected = result.success === true
    return this.dbConnected
  }

  private getSharedAiModelConfig(): SharedAiModelConfig {
    const apiBaseUrl = String(
      this.config.get('aiModelApiBaseUrl')
      || this.config.get('aiInsightApiBaseUrl')
      || ''
    ).trim()
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
    return { apiBaseUrl, apiKey, model }
  }

  private getAutoScopeSessionIds(): string[] {
    return normalizeSessionIdList(this.config.get('aiGroupSummaryFilterList'))
      .filter((sessionId) => sessionId.endsWith('@chatroom'))
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

  private parseLocalDateDayRange(value: unknown): { start: number; end: number } | null {
    const text = String(value || '').trim()
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const start = new Date(year, month - 1, day, 0, 0, 0, 0)
    if (
      !Number.isFinite(start.getTime()) ||
      start.getFullYear() !== year ||
      start.getMonth() !== month - 1 ||
      start.getDate() !== day
    ) {
      return null
    }
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return {
      start: Math.floor(start.getTime() / 1000),
      end: Math.floor(end.getTime() / 1000)
    }
  }

  private getIntervalPeriods(startTime: number, endTime: number, includePartial: boolean): Array<{ start: number; end: number }> {
    const intervalHours = normalizeIntervalHours(this.config.get('aiGroupSummaryIntervalHours'))
    const intervalSeconds = intervalHours * 60 * 60
    const periods: Array<{ start: number; end: number }> = []
    for (let start = startTime; start < endTime; start += intervalSeconds) {
      const end = Math.min(start + intervalSeconds, endTime)
      if (!includePartial && end - start < intervalSeconds) continue
      if (end > start) periods.push({ start, end })
    }
    return periods
  }

  private getCompletedPeriodsToday(): Array<{ start: number; end: number }> {
    const dayStart = getStartOfDaySeconds(new Date())
    const now = Math.floor(Date.now() / 1000)
    return this.getIntervalPeriods(dayStart, now, false)
  }

  private async queueDueAutoSummaries(): Promise<void> {
    if (!this.started || !this.isEnabled()) return
    if (this.processing) {
      this.pendingAutoRun = true
      return
    }
    this.processing = true
    try {
      do {
        this.pendingAutoRun = false
        await this.runDueAutoSummariesOnce()
      } while (this.pendingAutoRun && this.started && this.isEnabled())
    } finally {
      this.processing = false
    }
  }

  private async runDueAutoSummariesOnce(): Promise<void> {
    if (!this.started || !this.isEnabled()) return
    try {
      const { apiBaseUrl, apiKey } = this.getSharedAiModelConfig()
      if (!apiBaseUrl || !apiKey) return
      const scopeSessionIds = this.getAutoScopeSessionIds()
      if (scopeSessionIds.length === 0) return
      if (!await this.ensureConnected()) return

      const contacts = (await chatService.enrichSessionsContactInfo(scopeSessionIds).catch(() => null))?.contacts || {}

      const periods = this.getCompletedPeriodsToday()
      for (const period of periods) {
        for (const sessionId of scopeSessionIds) {
          if (!this.started || !this.isEnabled()) return
          if (!sessionId) continue
          if (groupSummaryRecordService.hasAutoRecord(sessionId, period.start, period.end)) continue
          await this.generateSummaryForPeriod({
            sessionId,
            displayName: contacts[sessionId]?.displayName || sessionId,
            avatarUrl: contacts[sessionId]?.avatarUrl,
            periodStart: period.start,
            periodEnd: period.end,
            triggerType: 'auto'
          })
        }
      }
    } catch (error) {
      console.warn('[GroupSummaryService] 自动总结失败:', error)
    }
  }

  private async readMessagesInPeriod(sessionId: string, startTime: number, endTime: number): Promise<Message[]> {
    if (!await this.ensureConnected()) {
      throw new Error('数据库连接失败，请先在“数据库连接”页完成配置')
    }
    const cursorResult = await wcdbService.openMessageCursor(
      sessionId,
      SUMMARY_CURSOR_BATCH_SIZE,
      true,
      startTime,
      endTime
    )
    if (!cursorResult.success || !cursorResult.cursor) {
      throw new Error(cursorResult.error || '打开消息游标失败')
    }

    const cursor = cursorResult.cursor
    const messages: Message[] = []
    try {
      let hasMore = true
      while (hasMore && messages.length < MAX_MESSAGES_PER_SUMMARY) {
        const batch = await wcdbService.fetchMessageBatch(cursor)
        if (!batch.success) {
          throw new Error(batch.error || '读取消息失败')
        }
        hasMore = batch.hasMore === true
        const rows = Array.isArray(batch.rows) ? batch.rows as Record<string, any>[] : []
        if (rows.length === 0) {
          if (!hasMore) break
          continue
        }
        const mapped = chatService.mapRowsToMessagesForApi(rows, sessionId)
        for (const message of mapped) {
          const createTime = Number(message.createTime || 0)
          if (createTime < startTime || createTime > endTime) continue
          messages.push(message)
          if (messages.length >= MAX_MESSAGES_PER_SUMMARY) break
        }
      }
    } finally {
      await wcdbService.closeMessageCursor(cursor).catch(() => {})
    }

    return messages.sort((a, b) => {
      if (a.createTime !== b.createTime) return a.createTime - b.createTime
      if (a.sortSeq !== b.sortSeq) return a.sortSeq - b.sortSeq
      return a.localId - b.localId
    })
  }

  private normalizeMessageText(message: Message): string {
    const parsedContent = String(message.parsedContent || '').replace(/\s+/g, ' ').trim()
    const quotedContent = String(message.quotedContent || '').replace(/\s+/g, ' ').trim()
    const quotedSender = String(message.quotedSender || '').replace(/\s+/g, ' ').trim()
    let text = parsedContent
    if (quotedContent) {
      const quote = quotedSender ? `${quotedSender}：${quotedContent}` : quotedContent
      text = text && text !== '[引用消息]' ? `${text} [引用 ${quote}]` : `[引用 ${quote}]`
    }
    if (!text) {
      text = String(message.linkTitle || message.fileName || message.appMsgDesc || '').replace(/\s+/g, ' ').trim()
    }
    if (!text) return ''
    if (/^<\?xml|^<msg\b|^<appmsg\b|^<img\b|^<emoji\b/i.test(text)) return ''
    return text
  }

  private async buildTranscript(sessionId: string, messages: Message[]): Promise<{ transcript: string; readableMessages: Message[] }> {
    const readableMessages = messages.filter((message) => this.normalizeMessageText(message))
    const senderIds = Array.from(new Set(
      readableMessages
        .map((message) => String(message.senderUsername || '').trim())
        .filter(Boolean)
    ))
    const contacts = senderIds.length > 0
      ? (await chatService.enrichSessionsContactInfo(senderIds).catch(() => null))?.contacts || {}
      : {}
    const myWxid = String(this.config.getMyWxidCleaned() || '').trim()

    const lines = readableMessages.map((message) => {
      const senderUsername = String(message.senderUsername || '').trim()
      const senderName = message.isSend === 1 || (senderUsername && myWxid && senderUsername === myWxid)
        ? '我'
        : (contacts[senderUsername]?.displayName || senderUsername || '未知成员')
      return `${formatTimestamp(message.createTime)} ${senderName}：${this.normalizeMessageText(message)}`
    })

    return {
      transcript: lines.join('\n'),
      readableMessages
    }
  }

  private async generateSummaryForPeriod(params: {
    sessionId: string
    displayName: string
    avatarUrl?: string
    periodStart: number
    periodEnd: number
    triggerType: GroupSummaryTriggerType
  }): Promise<GroupSummaryTriggerResult> {
    const { apiBaseUrl, apiKey, model } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    try {
      const messages = await this.readMessagesInPeriod(params.sessionId, params.periodStart, params.periodEnd)
      const { transcript, readableMessages } = await this.buildTranscript(params.sessionId, messages)
      if (readableMessages.length < MIN_SUMMARY_MESSAGES) {
        return {
          success: true,
          skipped: true,
          skippedReason: 'message_count_too_low',
          message: `该时段可总结消息少于 ${MIN_SUMMARY_MESSAGES} 条，已跳过`
        }
      }

      const customPrompt = String(this.config.get('aiGroupSummarySystemPrompt') || '').trim()
      const systemPrompt = customPrompt || DEFAULT_GROUP_SUMMARY_SYSTEM_PROMPT
      const userPrompt = `群聊：${params.displayName}
总结时段：${formatTimestamp(params.periodStart)} 至 ${formatTimestamp(params.periodEnd)}
消息数量：${readableMessages.length}

群聊记录：
${transcript}

请只输出指定 JSON。`
      const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
      const requestMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]

      let rawOutput = ''
      let responseFormatJson = true
      let responseFormatFallback = false
      let responseFormatFallbackReason = ''
      const startedAt = Date.now()
      try {
        rawOutput = await callChatCompletions(apiBaseUrl, apiKey, model, requestMessages, { responseFormatJson: true })
      } catch (error) {
        if (!shouldFallbackJsonMode(error)) throw error
        responseFormatJson = false
        responseFormatFallback = true
        responseFormatFallbackReason = (error as Error).message || 'response_format 不受支持'
        rawOutput = await callChatCompletions(apiBaseUrl, apiKey, model, requestMessages)
      }

      let topics: GroupSummaryTopic[]
      let finalSummary: string
      try {
        topics = parseTopics(rawOutput)
        finalSummary = buildSummaryText(topics)
      } catch {
        topics = [fallbackTopicFromRaw(rawOutput)]
        finalSummary = buildSummaryText(topics)
      }

      const log: GroupSummaryLog = {
        endpoint,
        model,
        temperature: API_TEMPERATURE,
        triggerType: params.triggerType,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        messageCount: messages.length,
        readableMessageCount: readableMessages.length,
        systemPrompt,
        userPrompt,
        rawOutput,
        finalSummary,
        durationMs: Date.now() - startedAt,
        createdAt: Date.now(),
        responseFormatJson,
        responseFormatFallback,
        responseFormatFallbackReason,
        parsedTopics: topics
      }

      const record = groupSummaryRecordService.addRecord({
        sessionId: params.sessionId,
        displayName: params.displayName,
        avatarUrl: params.avatarUrl,
        triggerType: params.triggerType,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        messageCount: messages.length,
        readableMessageCount: readableMessages.length,
        topics,
        summaryText: finalSummary,
        rawOutput,
        log
      })

      return { success: true, message: '群聊总结已生成', recordId: record.id, record }
    } catch (error) {
      return { success: false, message: `生成失败：${(error as Error).message || String(error)}` }
    }
  }

  private async generateSummariesForPeriods(params: {
    sessionId: string
    displayName: string
    avatarUrl?: string
    periods: Array<{ start: number; end: number }>
    triggerType: GroupSummaryTriggerType
  }): Promise<GroupSummaryDayTriggerResult> {
    const records: GroupSummaryRecordSummary[] = []
    let skipped = 0
    let failed = 0
    let firstError = ''

    for (const period of params.periods) {
      const result = await this.generateSummaryForPeriod({
        sessionId: params.sessionId,
        displayName: params.displayName,
        avatarUrl: params.avatarUrl,
        periodStart: period.start,
        periodEnd: period.end,
        triggerType: params.triggerType
      })
      if (result.success && result.record) {
        records.push(result.record)
        continue
      }
      if (result.success && result.skipped) {
        skipped += 1
        continue
      }
      failed += 1
      if (!firstError) firstError = result.message
    }

    const generated = records.length
    const parts = [`生成 ${generated} 段`, `跳过 ${skipped} 段`]
    if (failed > 0) parts.push(`失败 ${failed} 段`)
    const message = failed > 0 && generated === 0 && skipped === 0
      ? (firstError || '群聊总结生成失败')
      : `群聊总结完成：${parts.join('，')}`

    return {
      success: generated > 0 || skipped > 0 || failed === 0,
      message,
      generated,
      skipped,
      records
    }
  }
}

export const groupSummaryService = new GroupSummaryService()
