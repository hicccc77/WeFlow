/**
 * insightService.ts
 *
 * AI 见解后台服务：
 * 1. 监听 DB 变更事件（debounce 500ms 防抖，避免开机/重连时爆发大量事件阻塞主线程）
 * 2. 沉默联系人扫描（独立 setInterval，每 4 小时一次）
 * 3. 触发后拉取真实聊天上下文（若用户授权），组装 prompt 调用单一 AI 模型
 * 4. 输出 ≤80 字见解，通过现有 showNotification 弹出右下角通知
 *
 * 设计原则：
 * - 不引入任何额外 npm 依赖，使用 Node 原生 https 模块调用 OpenAI 兼容 API
 * - 所有失败静默处理，不影响主流程
 * - 触发频率、冷却与名单过滤均在本地完成，不把调度统计塞进模型 prompt
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { ConfigService } from './config'
import { chatService, ChatSession, Message } from './chatService'
import { snsService } from './snsService'
import { weiboService } from './social/weiboService'
import { showNotification } from '../windows/notificationWindow'
import { insightRecordService, type InsightRecordLog, type InsightRecordTriggerReason } from './insightRecordService'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/**
 * DB 变更防抖延迟（毫秒）。
 * 设为 2s：微信写库通常是批量操作，500ms 过短会在开机/重连时产生大量连续触发。
 */
const DB_CHANGE_DEBOUNCE_MS = 2000

/** 首次沉默扫描延迟（毫秒），避免启动期间抢占资源 */
const SILENCE_SCAN_INITIAL_DELAY_MS = 3 * 60 * 1000

/** 单次 API 请求超时（毫秒） */
const API_TIMEOUT_MS = 45_000
const API_MAX_TOKENS_DEFAULT = 200
const API_MAX_TOKENS_MIN = 1
const API_MAX_TOKENS_MAX = 65_535
const API_TEMPERATURE = 0.7
const INSIGHT_NOTIFICATION_AVATAR_URL = './assets/insight/AI_Insight.png'

/** 沉默天数阈值默认值 */
const DEFAULT_SILENCE_DAYS = 3
const INSIGHT_CONFIG_KEYS = new Set([
  'aiInsightEnabled',
  'aiInsightScanIntervalHours',
  'aiModelApiBaseUrl',
  'aiModelApiKey',
  'aiModelApiModel',
  'aiModelApiMaxTokens',
  'aiInsightFilterMode',
  'aiInsightFilterList',
  'aiInsightAllowMomentsContext',
  'aiInsightMomentsContextCount',
  'aiInsightMomentsBindings',
  'aiInsightAllowSocialContext',
  'aiInsightSocialContextCount',
  'aiInsightWeiboCookie',
  'aiInsightWeiboBindings',
  'dbPath',
  'decryptKey',
  'myWxid'
])

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface TodayTriggerRecord {
  /** 该会话今日触发的时间戳列表（毫秒） */
  timestamps: number[]
}

interface SharedAiModelConfig {
  apiBaseUrl: string
  apiKey: string
  model: string
  maxTokens: number
}

type InsightFilterMode = 'whitelist' | 'blacklist'

// ─── 日志 ─────────────────────────────────────────────────────────────────────

type InsightLogLevel = 'INFO' | 'WARN' | 'ERROR'

function insightDebugLine(_level: InsightLogLevel, _message: string): void {
  // Desktop debug log export has been replaced by per-insight request logs.
}

function insightDebugSection(_level: InsightLogLevel, _title: string, _payload: unknown): void {
  // Desktop debug log export has been replaced by per-insight request logs.
}

/**
 * 仅输出到 console，不落盘到文件。
 */
function insightLog(level: InsightLogLevel, message: string): void {
  if (level === 'ERROR' || level === 'WARN') {
    console.warn(`[InsightService] ${message}`)
  } else {
    console.log(`[InsightService] ${message}`)
  }
  insightDebugLine(level, message)
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 绝对拼接 baseUrl 与路径，避免 Node.js URL 相对路径陷阱。
 *
 * 例如：
 *   baseUrl = "https://api.ohmygpt.com/v1"
 *   path    = "/chat/completions"
 * 结果为  "https://api.ohmygpt.com/v1/chat/completions"
 *
 * 如果 baseUrl 末尾没有斜杠，直接用字符串拼接（而非 new URL(path, base)），
 * 因为 new URL("chat/completions", "https://api.example.com/v1") 会错误地
 * 丢弃 v1，变成 https://api.example.com/chat/completions。
 */
function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '') // 去掉末尾斜杠
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function getStartOfDay(date: Date = new Date()): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
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
  if (!base) return formatPromptCurrentTime()
  return `${base}\n\n${formatPromptCurrentTime()}`
}

function normalizeApiMaxTokens(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return API_MAX_TOKENS_DEFAULT
  return Math.min(API_MAX_TOKENS_MAX, Math.max(API_MAX_TOKENS_MIN, Math.floor(numeric)))
}

function normalizeSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
}

/**
 * 调用 OpenAI 兼容 API（非流式），返回模型第一条消息内容。
 * 使用 Node 原生 https/http 模块，无需任何第三方 SDK。
 */
function callApi(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number = API_TIMEOUT_MS,
  maxTokens: number = API_MAX_TOKENS_DEFAULT
): Promise<string> {
  return new Promise((resolve, reject) => {
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch (e) {
      reject(new Error(`无效的 API URL: ${endpoint}`))
      return
    }

    const body = JSON.stringify({
      model,
      messages,
      max_tokens: normalizeApiMaxTokens(maxTokens),
      temperature: API_TEMPERATURE,
      stream: false
    })

    const options = {
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

    const isHttps = urlObj.protocol === 'https:'
    const requestFn = isHttps ? https.request : http.request
    const req = requestFn(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.trim()) {
            resolve(content.trim())
          } else {
            reject(new Error(`API 返回格式异常: ${data.slice(0, 200)}`))
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`))
        }
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('API 请求超时'))
    })

    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

// ─── InsightService 主类 ──────────────────────────────────────────────────────

class InsightService {
  private readonly config: ConfigService

  /** DB 变更防抖定时器 */
  private dbDebounceTimer: NodeJS.Timeout | null = null

  /** 沉默扫描定时器 */
  private silenceScanTimer: NodeJS.Timeout | null = null
  private silenceInitialDelayTimer: NodeJS.Timeout | null = null

  /** 是否正在处理中（防重入） */
  private processing = false

  /**
   * 当日触发记录：sessionId -> TodayTriggerRecord
   * 每天 00:00 之后自动重置（通过检查日期实现）
   */
  private todayTriggers: Map<string, TodayTriggerRecord> = new Map()
  private todayDate = getStartOfDay()

  /**
   * 活跃分析冷却记录：sessionId -> 上次分析时间戳（毫秒）
   * 同一会话 2 小时内不重复触发活跃分析，防止 DB 频繁变更时爆量调用 API。
   */
  private lastActivityAnalysis: Map<string, number> = new Map()

  /**
   * 跟踪每个会话上次见到的最新消息时间戳，用于判断是否有真正的新消息。
   * sessionId -> lastMessageTimestamp（秒，与微信 DB 保持一致）
   */
  private lastSeenTimestamp: Map<string, number> = new Map()

  /**
   * 本地会话快照缓存，避免 analyzeRecentActivity 在每次 DB 变更时都做全量读取。
   * 首次调用时填充，此后只在沉默扫描里刷新（沉默扫描间隔更长，更合适做全量刷新）。
   */
  private sessionCache: ChatSession[] | null = null
  /** sessionCache 最后刷新时间戳（ms），超过 15 分钟强制重新拉取 */
  private sessionCacheAt = 0
  /** 缓存 TTL 设为 15 分钟，大幅减少 connect() + getSessions() 调用频率 */
  private static readonly SESSION_CACHE_TTL_MS = 15 * 60 * 1000
  /** 数据库是否已连接（避免重复调用 chatService.connect()） */
  private dbConnected = false

  private started = false

  constructor() {
    this.config = ConfigService.getInstance()
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  stop(): void {
    const hadActiveFlow =
      this.dbDebounceTimer !== null ||
      this.silenceScanTimer !== null ||
      this.silenceInitialDelayTimer !== null ||
      this.processing
    this.started = false
    this.clearTimers()
    this.clearRuntimeCache()
    this.processing = false
    if (hadActiveFlow) {
      insightLog('INFO', '已停止')
    }
  }

  async handleConfigChanged(key: string): Promise<void> {
    const normalizedKey = String(key || '').trim()
    if (!INSIGHT_CONFIG_KEYS.has(normalizedKey)) return

    // 数据库相关配置变更后，丢弃缓存并强制下次重连
    if (normalizedKey === 'aiInsightAllowSocialContext' || normalizedKey === 'aiInsightSocialContextCount' || normalizedKey === 'aiInsightWeiboCookie' || normalizedKey === 'aiInsightWeiboBindings') {
      weiboService.clearCache()
    }

    if (normalizedKey === 'dbPath' || normalizedKey === 'decryptKey' || normalizedKey === 'myWxid') {
      this.clearRuntimeCache()
    }

    await this.refreshConfiguration(`config:${normalizedKey}`)
  }

  handleConfigCleared(): void {
    this.clearTimers()
    this.clearRuntimeCache()
    this.processing = false
  }

  private async refreshConfiguration(_reason: string): Promise<void> {
    if (!this.started) return
    if (!this.isEnabled()) {
      this.clearTimers()
      this.clearRuntimeCache()
      this.processing = false
      return
    }
    this.scheduleSilenceScan()
  }

  private clearRuntimeCache(): void {
    this.dbConnected = false
    this.sessionCache = null
    this.sessionCacheAt = 0
    this.lastActivityAnalysis.clear()
    this.lastSeenTimestamp.clear()
    this.todayTriggers.clear()
    this.todayDate = getStartOfDay()
    weiboService.clearCache()
  }

  private clearTimers(): void {
    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
      this.dbDebounceTimer = null
    }
    if (this.silenceScanTimer !== null) {
      clearTimeout(this.silenceScanTimer)
      this.silenceScanTimer = null
    }
    if (this.silenceInitialDelayTimer !== null) {
      clearTimeout(this.silenceInitialDelayTimer)
      this.silenceInitialDelayTimer = null
    }
  }

  /**
   * 由 main.ts 在 addDbMonitorListener 回调中调用。
   * 加入 2s 防抖，防止开机/重连时大量事件并发阻塞主线程。
   * 如果当前正在处理中，直接忽略此次事件（不创建新的 timer），避免 timer 堆积。
   */
  handleDbMonitorChange(_type: string, _json: string): void {
    if (!this.started) return
    if (!this.isEnabled()) return
    // 正在处理时忽略新事件，避免 timer 堆积
    if (this.processing) return

    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
    }
    this.dbDebounceTimer = setTimeout(() => {
      this.dbDebounceTimer = null
      void this.analyzeRecentActivity()
    }, DB_CHANGE_DEBOUNCE_MS)
  }

  /**
   * 测试 API 连接，返回 { success, message }。
   * 供设置页"测试连接"按钮调用。
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()

    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写 API 地址和 API Key' }
    }

    try {
      const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
      const requestMessages = [{ role: 'user', content: '请回复"连接成功"四个字。' }]
      insightDebugSection(
        'INFO',
        'AI 测试连接请求',
        [
          `Endpoint: ${endpoint}`,
          `Model: ${model}`,
          `Max Tokens: ${maxTokens}`,
          '',
          '用户提示词：',
          requestMessages[0].content
        ].join('\n')
      )

      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        requestMessages,
        15_000,
        maxTokens
      )
      insightDebugSection('INFO', 'AI 测试连接输出原文', result)
      return { success: true, message: `连接成功，模型回复：${result.slice(0, 50)}` }
    } catch (e) {
      insightDebugSection(
        'ERROR',
        'AI 测试连接失败',
        `错误信息：${(e as Error).message}\n\n堆栈：\n${(e as Error).stack || '[无堆栈]'}`
      )
      return { success: false, message: `连接失败：${(e as Error).message}` }
    }
  }

  /**
   * 强制立即对最近一个私聊会话触发一次见解（忽略冷却，用于测试）。
   * 返回触发结果描述，供设置页展示。
   */
  async triggerTest(): Promise<{ success: boolean; message: string }> {
    insightLog('INFO', '手动触发测试见解...')
    const { apiBaseUrl, apiKey } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写 API 地址和 Key' }
    }
    try {
      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        return { success: false, message: '数据库连接失败，请先在"数据库连接"页完成配置' }
      }
      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions || sessionsResult.sessions.length === 0) {
        return { success: false, message: '未找到任何会话，请确认数据库已正确连接' }
      }
      // 找第一个允许的私聊
      const session = (sessionsResult.sessions as ChatSession[]).find((s) => {
        const id = s.username?.trim() || ''
        return id && !id.endsWith('@chatroom') && !id.toLowerCase().includes('placeholder') && this.isSessionAllowed(id)
      })
      if (!session) {
        return { success: false, message: '未找到任何可触发的私聊会话（请检查黑白名单模式与选择列表）' }
      }
      const sessionId = session.username?.trim() || ''
      const displayName = session.displayName || sessionId
      insightLog('INFO', `测试目标会话：${displayName} (${sessionId})`)
      await this.generateInsightForSession({
        sessionId,
        displayName,
        triggerReason: 'test'
      })
      const notificationEnabled = this.config.get('aiInsightNotificationEnabled') !== false
      return {
        success: true,
        message: notificationEnabled
          ? `已向「${displayName}」发送测试见解，请查看通知弹窗`
          : `已生成「${displayName}」的测试见解，AI 见解消息通知当前已关闭`
      }
    } catch (e) {
      return { success: false, message: `测试失败：${(e as Error).message}` }
    }
  }

  /** 获取今日触发统计（供设置页展示） */
  getTodayStats(): { sessionId: string; count: number; times: string[] }[] {
    this.resetIfNewDay()
    const result: { sessionId: string; count: number; times: string[] }[] = []
    for (const [sessionId, record] of this.todayTriggers.entries()) {
      result.push({
        sessionId,
        count: record.timestamps.length,
        times: record.timestamps.map(formatTimestamp)
      })
    }
    return result
  }

  async generateFootprintInsight(params: {
    rangeLabel: string
    summary: {
      private_inbound_people?: number
      private_replied_people?: number
      private_outbound_people?: number
      private_reply_rate?: number
      mention_count?: number
      mention_group_count?: number
    }
    privateSegments?: Array<{ displayName?: string; session_id?: string; incoming_count?: number; outgoing_count?: number; message_count?: number; replied?: boolean }>
    mentionGroups?: Array<{ displayName?: string; session_id?: string; count?: number }>
  }): Promise<{ success: boolean; message: string; insight?: string }> {
    const enabled = this.config.get('aiFootprintEnabled') === true
    if (!enabled) {
      return { success: false, message: '请先在设置中开启「AI 足迹总结」' }
    }

    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()
    if (!apiBaseUrl || !apiKey) {
      return { success: false, message: '请先填写通用 AI 模型配置（API 地址和 Key）' }
    }

    const summary = params?.summary || {}
    const rangeLabel = String(params?.rangeLabel || '').trim() || '当前范围'
    const privateSegments = Array.isArray(params?.privateSegments) ? params.privateSegments.slice(0, 6) : []
    const mentionGroups = Array.isArray(params?.mentionGroups) ? params.mentionGroups.slice(0, 6) : []

    const topPrivateText = privateSegments.length > 0
      ? privateSegments
        .map((item, idx) => {
          const name = String(item.displayName || item.session_id || `联系人${idx + 1}`).trim()
          const inbound = Number(item.incoming_count) || 0
          const outbound = Number(item.outgoing_count) || 0
          const total = Math.max(Number(item.message_count) || 0, inbound + outbound)
          return `${idx + 1}. ${name}（收${inbound}/发${outbound}/总${total}${item.replied ? '/已回复' : ''}）`
        })
        .join('\n')
      : '无'

    const topMentionText = mentionGroups.length > 0
      ? mentionGroups
        .map((item, idx) => {
          const name = String(item.displayName || item.session_id || `群聊${idx + 1}`).trim()
          const count = Number(item.count) || 0
          return `${idx + 1}. ${name}（@我 ${count} 次）`
        })
        .join('\n')
      : '无'

    const defaultSystemPrompt = `你是用户的聊天足迹教练，负责基于统计数据给出一段简明复盘。
要求：
1. 输出 2-3 句，总长度不超过 180 字。
2. 必须包含：总体观察 + 一个可执行建议。
3. 语气务实，不夸张，不使用 Markdown。`
    const customPrompt = String(this.config.get('aiFootprintSystemPrompt') || '').trim()
    const systemPrompt = customPrompt || defaultSystemPrompt

    const userPromptBase = `统计范围：${rangeLabel}
有聊天的人数：${Number(summary.private_inbound_people) || 0}
我有回复的人数：${Number(summary.private_outbound_people) || 0}
回复率：${(((Number(summary.private_reply_rate) || 0) * 100)).toFixed(1)}%
@我次数：${Number(summary.mention_count) || 0}
涉及群聊：${Number(summary.mention_group_count) || 0}

私聊重点：
${topPrivateText}

群聊@我重点：
${topMentionText}

请给出足迹复盘（2-3句，含建议）：`
    const userPrompt = appendPromptCurrentTime(userPromptBase)

    try {
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        25_000,
        maxTokens
      )
      const insight = result.trim().slice(0, 400)
      if (!insight) return { success: false, message: '模型返回为空' }
      return { success: true, message: '生成成功', insight }
    } catch (error) {
      return { success: false, message: `生成失败：${(error as Error).message}` }
    }
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.config.get('aiInsightEnabled') === true
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
    const maxTokens = normalizeApiMaxTokens(this.config.get('aiModelApiMaxTokens'))

    return { apiBaseUrl, apiKey, model, maxTokens }
  }

  private looksLikeWxid(text: string): boolean {
    const normalized = String(text || '').trim()
    if (!normalized) return false
    return /^wxid_[a-z0-9]+$/i.test(normalized)
      || /^[a-z0-9_]+@chatroom$/i.test(normalized)
  }

  private looksLikeXmlPayload(text: string): boolean {
    const normalized = String(text || '').trim()
    if (!normalized) return false
    return /^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b|&lt;\?xml|&lt;msg\b|&lt;appmsg\b)/i.test(normalized)
  }

  private normalizeInsightText(text: string): string {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u0000/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  private formatInsightMessageTimestamp(createTime: number): string {
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

  private async resolveInsightSessionDisplayName(sessionId: string, fallbackDisplayName: string): Promise<string> {
    const fallback = String(fallbackDisplayName || '').trim()
    if (fallback && !this.looksLikeWxid(fallback)) {
      return fallback
    }

    try {
      const sessions = await this.getSessionsCached()
      const matched = sessions.find((session) => String(session.username || '').trim() === sessionId)
      const cachedDisplayName = String(matched?.displayName || '').trim()
      if (cachedDisplayName && !this.looksLikeWxid(cachedDisplayName)) {
        return cachedDisplayName
      }
    } catch {
      // ignore display name lookup failures
    }

    try {
      const contact = await chatService.getContactAvatar(sessionId)
      const contactDisplayName = String(contact?.displayName || '').trim()
      if (contactDisplayName && !this.looksLikeWxid(contactDisplayName)) {
        return contactDisplayName
      }
    } catch {
      // ignore display name lookup failures
    }

    return fallback || sessionId
  }

  private formatInsightMessageContent(message: Message): string {
    const parsedContent = this.normalizeInsightText(String(message.parsedContent || ''))
    const quotedPreview = this.normalizeInsightText(String(message.quotedContent || ''))
    const quotedSender = this.normalizeInsightText(String(message.quotedSender || ''))

    if (quotedPreview) {
      const cleanQuotedSender = quotedSender && !this.looksLikeWxid(quotedSender) ? quotedSender : ''
      const quoteLabel = cleanQuotedSender ? `${cleanQuotedSender}：${quotedPreview}` : quotedPreview
      const replyText = parsedContent && parsedContent !== '[引用消息]' ? parsedContent : ''
      return replyText ? `${replyText}[引用 ${quoteLabel}]` : `[引用 ${quoteLabel}]`
    }

    if (parsedContent) {
      return parsedContent
    }

    const rawContent = this.normalizeInsightText(String(message.rawContent || ''))
    if (rawContent && !this.looksLikeXmlPayload(rawContent)) {
      return rawContent
    }

    return '[其他消息]'
  }

  private buildInsightContextSection(messages: Message[], peerDisplayName: string): string {
    if (!messages.length) return ''

    const lines = messages.map((message) => {
      const senderName = message.isSend === 1 ? '我' : peerDisplayName
      const content = this.formatInsightMessageContent(message)
      return `${this.formatInsightMessageTimestamp(message.createTime)} '${senderName}'\n${content}`
    })

    return `近期聊天记录（最近 ${lines.length} 条）：\n\n${lines.join('\n\n')}`
  }

  /**
   * 判断某个会话是否允许触发见解。
   * white/black 模式二选一：
   * - whitelist：仅名单内允许
   * - blacklist：名单内屏蔽，其他允许
   */
  private getInsightFilterConfig(): { mode: InsightFilterMode; list: string[] } {
    const modeRaw = String(this.config.get('aiInsightFilterMode') || '').trim().toLowerCase()
    const mode: InsightFilterMode = modeRaw === 'blacklist' ? 'blacklist' : 'whitelist'
    const list = normalizeSessionIdList(this.config.get('aiInsightFilterList'))
    return { mode, list }
  }

  private isSessionAllowed(sessionId: string): boolean {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return false
    const { mode, list } = this.getInsightFilterConfig()
    if (mode === 'whitelist') return list.includes(normalizedSessionId)
    return !list.includes(normalizedSessionId)
  }

  /**
   * 获取会话列表，优先使用缓存（15 分钟 TTL）。
   * 缓存命中时完全跳过数据库访问，避免频繁 connect() + getSessions() 消耗 CPU。
   * forceRefresh=true 时强制重新拉取（仅用于沉默扫描等低频场景）。
   */
  private async getSessionsCached(forceRefresh = false): Promise<ChatSession[]> {
    const now = Date.now()
    // 缓存命中：直接返回，零数据库操作
    if (
      !forceRefresh &&
      this.sessionCache !== null &&
      now - this.sessionCacheAt < InsightService.SESSION_CACHE_TTL_MS
    ) {
      return this.sessionCache
    }
    // 缓存未命中或强制刷新：连接数据库并拉取
    try {
      // 只在首次或强制刷新时调用 connect()，避免重复建立连接
      if (!this.dbConnected || forceRefresh) {
        const connectResult = await chatService.connect()
        if (!connectResult.success) {
          insightLog('WARN', '数据库连接失败，使用旧缓存')
          return this.sessionCache ?? []
        }
        this.dbConnected = true
      }
      const result = await chatService.getSessions()
      if (result.success && result.sessions) {
        this.sessionCache = result.sessions as ChatSession[]
        this.sessionCacheAt = now
      }
    } catch (e) {
      insightLog('WARN', `获取会话缓存失败: ${(e as Error).message}`)
      // 连接可能已断开，下次强制重连
      this.dbConnected = false
    }
    return this.sessionCache ?? []
  }

  private resetIfNewDay(): void {
    const todayStart = getStartOfDay()
    if (todayStart > this.todayDate) {
      this.todayDate = todayStart
      this.todayTriggers.clear()
    }
  }

  /**
   * 记录成功推送的见解，用于设置页展示今日触发统计。
   */
  private recordTrigger(sessionId: string): void {
    this.resetIfNewDay()
    const existing = this.todayTriggers.get(sessionId) ?? { timestamps: [] }
    existing.timestamps.push(Date.now())
    this.todayTriggers.set(sessionId, existing)
  }

  private formatWeiboTimestamp(raw: string): string {
    const parsed = Date.parse(String(raw || ''))
    if (!Number.isFinite(parsed)) {
      return String(raw || '').trim()
    }
    return new Date(parsed).toLocaleString('zh-CN')
  }

  private formatMomentsTimestamp(raw: unknown): string {
    const numeric = Number(raw)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return ''
    }
    const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    return new Date(ms).toLocaleString('zh-CN')
  }

  private extractMomentReadableText(post: { contentDesc?: unknown; linkTitle?: unknown }): string {
    const contentDesc = this.normalizeInsightText(String(post.contentDesc || '')).replace(/\s+/g, ' ').trim()
    if (contentDesc) return contentDesc

    const linkTitle = this.normalizeInsightText(String(post.linkTitle || '')).replace(/\s+/g, ' ').trim()
    if (linkTitle) return `[链接] ${linkTitle}`

    return ''
  }

  private async getMomentsContextSection(sessionId: string): Promise<string> {
    const allowMomentsContext = this.config.get('aiInsightAllowMomentsContext') === true
    if (!allowMomentsContext) return ''

    const bindings =
      (this.config.get('aiInsightMomentsBindings') as Record<string, { enabled?: boolean }> | undefined) || {}
    const isEnabledForSession = bindings[sessionId]?.enabled === true
    if (!isEnabledForSession) return ''

    const countRaw = Number(this.config.get('aiInsightMomentsContextCount') || 5)
    const momentsCount = Math.max(1, Math.min(20, Math.floor(countRaw) || 5))

    try {
      const result = await snsService.getTimeline(momentsCount, 0, [sessionId])
      const posts = result.success && Array.isArray(result.timeline) ? result.timeline : []
      if (posts.length === 0) return ''

      const lines = posts
        .map((post) => {
          const text = this.extractMomentReadableText(post as { contentDesc?: unknown; linkTitle?: unknown })
          if (!text) return ''
          const shortText = text.length > 180 ? `${text.slice(0, 180)}...` : text
          const time = this.formatMomentsTimestamp((post as { createTime?: unknown }).createTime)
          return time ? `[朋友圈 ${time}] ${shortText}` : `[朋友圈] ${shortText}`
        })
        .filter(Boolean) as string[]

      if (lines.length === 0) return ''
      insightLog('INFO', `已加载 ${lines.length} 条朋友圈内容 (sessionId=${sessionId})`)
      return `近期朋友圈内容（最近 ${lines.length} 条）：\n${lines.join('\n')}`
    } catch (error) {
      insightLog('WARN', `拉取朋友圈内容失败 (sessionId=${sessionId}): ${(error as Error).message}`)
      return ''
    }
  }

  private async getSocialContextSection(sessionId: string): Promise<string> {
    const allowSocialContext = this.config.get('aiInsightAllowSocialContext') === true
    if (!allowSocialContext) return ''

    const rawCookie = String(this.config.get('aiInsightWeiboCookie') || '').trim()

    const bindings =
      (this.config.get('aiInsightWeiboBindings') as Record<string, { uid?: string; screenName?: string }> | undefined) || {}
    const binding = bindings[sessionId]
    const uid = String(binding?.uid || '').trim()
    if (!uid) return ''

    const socialCountRaw = Number(this.config.get('aiInsightSocialContextCount') || 3)
    const socialCount = Math.max(1, Math.min(5, Math.floor(socialCountRaw) || 3))

    try {
      const posts = await weiboService.fetchRecentPosts(uid, rawCookie, socialCount)
      if (posts.length === 0) return ''

      const lines = posts.map((post) => {
        const time = this.formatWeiboTimestamp(post.createdAt)
        const text = post.text.length > 180 ? `${post.text.slice(0, 180)}...` : post.text
        return `[微博 ${time}] ${text}`
      })
      insightLog('INFO', `已加载 ${lines.length} 条微博公开内容 (uid=${uid})`)
      return `近期公开社交平台内容（来源：微博，最近 ${lines.length} 条）：\n${lines.join('\n')}`
    } catch (error) {
      insightLog('WARN', `拉取微博公开内容失败 (uid=${uid}): ${(error as Error).message}`)
      return ''
    }
  }

  // ── 沉默联系人扫描 ──────────────────────────────────────────────────────────

  private scheduleSilenceScan(): void {
    this.clearTimers()
    if (!this.started || !this.isEnabled()) return

    // 等待扫描完成后再安排下一次，避免并发堆积
    const scheduleNext = () => {
      if (!this.started || !this.isEnabled()) return
      const intervalHours = (this.config.get('aiInsightScanIntervalHours') as number) || 4
      const intervalMs = Math.max(0.1, intervalHours) * 60 * 60 * 1000
      insightLog('INFO', `下次沉默扫描将在 ${intervalHours} 小时后执行`)
      this.silenceScanTimer = setTimeout(async () => {
        this.silenceScanTimer = null
        await this.runSilenceScan()
        scheduleNext()
      }, intervalMs)
    }

    this.silenceInitialDelayTimer = setTimeout(async () => {
      this.silenceInitialDelayTimer = null
      await this.runSilenceScan()
      scheduleNext()
    }, SILENCE_SCAN_INITIAL_DELAY_MS)
  }

  private async runSilenceScan(): Promise<void> {
    if (!this.isEnabled()) {
      return
    }
    if (this.processing) {
      insightLog('INFO', '沉默扫描：正在处理中，跳过本次')
      return
    }

    this.processing = true
    insightLog('INFO', '开始沉默联系人扫描...')
    try {
      const silenceDays = (this.config.get('aiInsightSilenceDays') as number) || DEFAULT_SILENCE_DAYS
      const thresholdMs = silenceDays * 24 * 60 * 60 * 1000
      const now = Date.now()

      insightLog('INFO', `沉默阈值：${silenceDays} 天`)

      // 沉默扫描间隔较长，强制刷新缓存以获取最新数据
      const sessions = await this.getSessionsCached(true)
      if (sessions.length === 0) {
        insightLog('WARN', '获取会话列表失败，跳过沉默扫描')
        return
      }

      insightLog('INFO', `共 ${sessions.length} 个会话，开始过滤...`)

      let silentCount = 0
      for (const session of sessions) {
        if (!this.isEnabled()) return
        const sessionId = session.username?.trim() || ''
        if (!sessionId || sessionId.endsWith('@chatroom')) continue
        if (sessionId.toLowerCase().includes('placeholder')) continue
        if (!this.isSessionAllowed(sessionId)) continue

        const lastTimestamp = (session.lastTimestamp || 0) * 1000
        if (!lastTimestamp || lastTimestamp <= 0) continue

        const silentMs = now - lastTimestamp
        if (silentMs < thresholdMs) continue

        silentCount++
        const silentDays = Math.floor(silentMs / (24 * 60 * 60 * 1000))
        insightLog('INFO', `发现沉默联系人：${session.displayName || sessionId}，已沉默 ${silentDays} 天`)

        await this.generateInsightForSession({
          sessionId,
          displayName: session.displayName || session.username,
          triggerReason: 'silence',
          silentDays
        })
      }
      insightLog('INFO', `沉默扫描完成，共发现 ${silentCount} 个沉默联系人`)
    } catch (e) {
      insightLog('ERROR', `沉默扫描出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
    }
  }

  // ── 活跃会话分析 ────────────────────────────────────────────────────────────

  /**
   * 在 DB 变更防抖后执行，分析最近活跃的会话。
   *
   * 触发条件（必须同时满足）：
   * 1. 会话有真正的新消息（lastTimestamp 比上次见到的更新）
   * 2. 该会话距上次活跃分析已超过冷却期
   *
   * whitelist 模式：直接使用名单里的 sessionId，完全跳过 getSessions()。
   * blacklist 模式：从缓存拉取会话后过滤名单。
   */
  private async analyzeRecentActivity(): Promise<void> {
    if (!this.isEnabled()) return
    if (this.processing) return

    this.processing = true
    try {
      const now = Date.now()
      const cooldownMinutes = (this.config.get('aiInsightCooldownMinutes') as number) ?? 120
      const cooldownMs = cooldownMinutes * 60 * 1000
      const { mode: filterMode, list: filterList } = this.getInsightFilterConfig()

      // whitelist 模式且有勾选项时，直接用名单 sessionId，无需查数据库全量会话列表。
      // 通过拉取该会话最新 1 条消息时间戳判断是否真正有新消息，开销极低。
      if (filterMode === 'whitelist' && filterList.length > 0) {
        // 确保数据库已连接（首次时连接，之后复用）
        if (!this.dbConnected) {
          const connectResult = await chatService.connect()
          if (!connectResult.success) return
          this.dbConnected = true
        }

        for (const sessionId of filterList) {
          if (!sessionId || sessionId.toLowerCase().includes('placeholder')) continue

          // 冷却期检查（先过滤，减少不必要的 DB 查询）
          if (cooldownMs > 0) {
            const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
            if (cooldownMs - (now - lastAnalysis) > 0) continue
          }

          // 拉取最新 1 条消息，用时间戳判断是否有新消息，避免全量 getSessions()
          try {
            const msgsResult = await chatService.getLatestMessages(sessionId, 1)
            if (!msgsResult.success || !msgsResult.messages || msgsResult.messages.length === 0) continue

            const latestMsg = msgsResult.messages[0]
            const latestTs = Number(latestMsg.createTime) || 0
            const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0

            if (latestTs <= lastSeen) continue // 没有新消息
            this.lastSeenTimestamp.set(sessionId, latestTs)
          } catch {
            continue
          }

          insightLog('INFO', `白名单会话 ${sessionId} 有新消息，准备生成见解...`)
          this.lastActivityAnalysis.set(sessionId, now)

          // displayName 使用白名单 sessionId，generateInsightForSession 内部会从上下文里获取真实名称
          await this.generateInsightForSession({
            sessionId,
            displayName: sessionId,
            triggerReason: 'activity'
          })
          break // 每次最多处理 1 个会话
        }
        return
      }

      if (filterMode === 'whitelist' && filterList.length === 0) {
        insightLog('INFO', '白名单模式且名单为空，跳过活跃分析')
        return
      }

      // blacklist 模式：拉取会话缓存后按过滤规则筛选
      const sessions = await this.getSessionsCached()
      if (sessions.length === 0) return

      const candidateSessions = sessions.filter((s) => {
        const id = s.username?.trim() || ''
        if (!id || id.toLowerCase().includes('placeholder')) return false
        return this.isSessionAllowed(id)
      })

      for (const session of candidateSessions.slice(0, 10)) {
        const sessionId = session.username?.trim() || ''
        if (!sessionId) continue

        const currentTimestamp = session.lastTimestamp || 0
        const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0
        if (currentTimestamp <= lastSeen) continue
        this.lastSeenTimestamp.set(sessionId, currentTimestamp)

        if (cooldownMs > 0) {
          const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
          if (cooldownMs - (now - lastAnalysis) > 0) continue
        }

        insightLog('INFO', `${session.displayName || sessionId} 有新消息，准备生成见解...`)
        this.lastActivityAnalysis.set(sessionId, now)

        await this.generateInsightForSession({
          sessionId,
          displayName: session.displayName || session.username,
          triggerReason: 'activity'
        })
        break
      }
    } catch (e) {
      insightLog('ERROR', `活跃分析出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
    }
  }

  // ── 核心见解生成 ────────────────────────────────────────────────────────────

  private async generateInsightForSession(params: {
    sessionId: string
    displayName: string
    triggerReason: InsightRecordTriggerReason
    silentDays?: number
  }): Promise<void> {
    const { sessionId, displayName, triggerReason, silentDays } = params
    if (!sessionId) return
    if (!this.isEnabled()) return

    const { apiBaseUrl, apiKey, model, maxTokens } = this.getSharedAiModelConfig()
    const allowContext = this.config.get('aiInsightAllowContext') as boolean
    const contextCount = (this.config.get('aiInsightContextCount') as number) || 40
    const resolvedDisplayName = await this.resolveInsightSessionDisplayName(sessionId, displayName)
    let resolvedAvatarUrl: string | undefined
    try {
      const contact = await chatService.getContactAvatar(sessionId)
      resolvedAvatarUrl = String(contact?.avatarUrl || '').trim() || undefined
    } catch {
      resolvedAvatarUrl = undefined
    }

    insightLog('INFO', `generateInsightForSession: sessionId=${sessionId}, reason=${triggerReason}, contextCount=${contextCount}, api=${apiBaseUrl ? '已配置' : '未配置'}`)

    if (!apiBaseUrl || !apiKey) {
      insightLog('WARN', 'API 地址或 Key 未配置，跳过见解生成')
      return
    }

    // ── 构建 prompt ────────────────────────────────────────────────────────────

    let contextSection = ''
    if (allowContext) {
      try {
        const msgsResult = await chatService.getLatestMessages(sessionId, contextCount)
        if (msgsResult.success && msgsResult.messages && msgsResult.messages.length > 0) {
          const messages: Message[] = msgsResult.messages
          contextSection = this.buildInsightContextSection(messages, resolvedDisplayName)
          insightLog('INFO', `已加载 ${messages.length} 条上下文消息`)
        }
      } catch (e) {
        insightLog('WARN', `拉取上下文失败: ${(e as Error).message}`)
      }
    }

    const momentsContextSection = await this.getMomentsContextSection(sessionId)
    const socialContextSection = await this.getSocialContextSection(sessionId)

    // ── 默认 system prompt（稳定内容，有利于 provider 端 prompt cache 命中）────
    const DEFAULT_SYSTEM_PROMPT = `你是用户的私人关系观察助手，名叫"见解"。你的任务是主动提供有价值的观察和建议。

要求：
1. 必须给出见解。基于聊天记录分析对方情绪、话题趋势、关系动态，或给出回复建议、聊天话题推荐。
2. 控制在 80 字以内，直接、具体、一针见血。不要废话。
3. 输出纯文本，不使用 Markdown。
4. 只有在完全没有任何可说的内容时（比如对话只有一条"嗯"），才回复"SKIP"。绝大多数情况下你应该输出见解。`

    // 优先使用用户自定义 prompt，为空则使用默认值
    const customPrompt = (this.config.get('aiInsightSystemPrompt') as string) || ''
    const systemPrompt = customPrompt.trim() || DEFAULT_SYSTEM_PROMPT

    const userPromptBase = [
      triggerReason === 'silence' && silentDays
        ? `已 ${silentDays} 天未联系「${resolvedDisplayName}」。`
        : '',
      contextSection,
      momentsContextSection,
      socialContextSection,
      '请给出你的见解（≤80字）：'
    ].filter(Boolean).join('\n\n')
    const userPrompt = appendPromptCurrentTime(userPromptBase)

    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    const requestMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    insightLog('INFO', `准备调用 API: ${endpoint}，模型: ${model}`)
    insightDebugSection(
      'INFO',
      `AI 请求 ${resolvedDisplayName} (${sessionId})`,
      [
        `接口地址：${endpoint}`,
        `模型：${model}`,
        `Max Tokens：${maxTokens}`,
        `触发类型：${triggerReason}`,
        `上下文开关：${allowContext ? '开启' : '关闭'}`,
        `上下文条数：${contextCount}`,
        '',
        '系统提示词：',
        systemPrompt,
        '',
        '用户提示词：',
        userPrompt
      ].join('\n')
    )

    try {
      const apiStartedAt = Date.now()
      const result = await callApi(
        apiBaseUrl,
        apiKey,
        model,
        requestMessages,
        API_TIMEOUT_MS,
        maxTokens
      )
      const apiDurationMs = Date.now() - apiStartedAt

      insightLog('INFO', `API 返回原文: ${result.slice(0, 150)}`)
      insightDebugSection('INFO', `AI 输出原文 ${resolvedDisplayName} (${sessionId})`, result)

      // 模型主动选择跳过
      if (result.trim().toUpperCase() === 'SKIP' || result.trim().startsWith('SKIP')) {
        insightLog('INFO', `模型选择跳过 ${resolvedDisplayName}`)
        return
      }
      if (!this.isEnabled()) return

      const insight = result.slice(0, 120)
      const notifTitle = `见解 · ${resolvedDisplayName}`
      const recordLog: InsightRecordLog = {
        endpoint,
        model,
        maxTokens,
        temperature: API_TEMPERATURE,
        triggerReason,
        allowContext,
        contextCount,
        systemPrompt,
        userPrompt,
        rawOutput: result,
        finalInsight: insight,
        durationMs: apiDurationMs,
        createdAt: Date.now()
      }
      const record = insightRecordService.addRecord({
        sessionId,
        displayName: resolvedDisplayName,
        avatarUrl: resolvedAvatarUrl,
        triggerReason,
        insight,
        log: recordLog
      })

      const insightNotificationEnabled = this.config.get('aiInsightNotificationEnabled') !== false
      if (insightNotificationEnabled) {
        insightLog('INFO', `推送通知 → ${resolvedDisplayName}: ${insight}`)

        // 渠道一：应用内通知窗口。AI 见解使用独立通知开关，不受新消息通知开关和会话过滤影响。
        await showNotification({
          title: notifTitle,
          content: insight,
          avatarUrl: INSIGHT_NOTIFICATION_AVATAR_URL,
          sessionId,
          insightRecordId: record.id,
          channel: 'ai-insight'
        })
      } else {
        insightLog('INFO', `AI 见解消息通知已关闭，跳过应用通知 → ${resolvedDisplayName}: ${insight}`)
      }

      // 渠道二：Telegram Bot 推送（可选）
      const telegramEnabled = this.config.get('aiInsightTelegramEnabled') as boolean
      if (telegramEnabled) {
        const telegramToken = (this.config.get('aiInsightTelegramToken') as string) || ''
        const telegramChatIds = (this.config.get('aiInsightTelegramChatIds') as string) || ''
        if (telegramToken && telegramChatIds) {
          const chatIds = telegramChatIds.split(',').map((s) => s.trim()).filter(Boolean)
          const telegramText = `【WeFlow】 ${notifTitle}\n\n${insight}`
          for (const chatId of chatIds) {
            this.sendTelegram(telegramToken, chatId, telegramText).catch((e) => {
              insightLog('WARN', `Telegram 推送失败 (chatId=${chatId}): ${(e as Error).message}`)
            })
          }
        } else {
          insightLog('WARN', 'Telegram 已启用但 Token 或 Chat ID 未填写，跳过')
        }
      }

      insightLog('INFO', `已完成 ${resolvedDisplayName} 的见解处理`)
      this.recordTrigger(sessionId)
    } catch (e) {
      insightDebugSection(
        'ERROR',
        `AI 请求失败 ${resolvedDisplayName} (${sessionId})`,
        `错误信息：${(e as Error).message}\n\n堆栈：\n${(e as Error).stack || '[无堆栈]'}`
      )
      insightLog('ERROR', `API 调用失败 (${resolvedDisplayName}): ${(e as Error).message}`)
    }
  }

  /**
   * 通过 Telegram Bot API 发送消息。
   * 使用 Node 原生 https 模块，无需第三方依赖。
   */
  private sendTelegram(token: string, chatId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST' as const,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString()
        }
      }
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.ok) {
              resolve()
            } else {
              reject(new Error(parsed.description || '未知错误'))
            }
          } catch {
            reject(new Error(`响应解析失败: ${data.slice(0, 100)}`))
          }
        })
      })
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Telegram 请求超时')) })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

export const insightService = new InsightService()


