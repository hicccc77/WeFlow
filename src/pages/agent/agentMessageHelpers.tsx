/**
 * 消息/工具渲染相关的纯函数 + 小组件：工具名映射、执行过程分段、检索徽标、出处列表等。
 * 本文件从 AgentPage.tsx 拆出，供主组件和 AgentSubAgentProgress 等模块复用。
 */
import { ChevronDown, Magnifier, QuoteOpen } from '@gravity-ui/icons'
import { isToolUIPart, type UIMessage } from 'ai'
import type { ReactNode } from 'react'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { AGENT_TOOL_LABELS, formatAgentToolName } from './agentToolPresentation'

// ====== 工具名 → 中文标签 ======
export const TOOL_LABELS = AGENT_TOOL_LABELS

export type PersonaControlOutput = {
  success?: boolean
  action?: 'open_persona_chat' | 'ask_persona_build' | 'build_persona' | 'build_session_vectors'
  sessionId?: string
  displayName?: string
  message?: string
  error?: string
}

export function formatToolName(toolName: string) {
  return formatAgentToolName(toolName)
}

// ====== 工具审批一行动态说明（输入框上方审批条用）======
// 通用兜底：不为每个工具写专属映射，按常见字段名取第一个命中的当关键信息
const APPROVAL_DETAIL_KEYS = ['title', 'command', 'filePath', 'media', 'path', 'query', 'sessionId', 'md5', 'name']

export function describeToolApprovalRequest(toolName: string, input: unknown): string {
  const label = formatToolName(toolName)
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  if (!record) return label
  for (const key of APPROVAL_DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return `${label} · ${value.trim().slice(0, 60)}`
    }
  }
  return label
}

export function getPersonaControlOutput(part: unknown): PersonaControlOutput | null {
  const p = part as { type?: unknown; state?: unknown; output?: unknown }
  if (p?.type !== 'tool-persona_control' || p.state !== 'output-available') return null
  if (!p.output || typeof p.output !== 'object') return null
  return p.output as PersonaControlOutput
}

export function renderChainLabel(label: ReactNode, active: boolean) {
  if (!active) return label
  return (
    <Shimmer as="span" duration={1.25}>
      {label}
    </Shimmer>
  )
}

export function formatElapsed(ms: number) {
  return `${Math.floor(Math.max(0, ms) / 1_000)}\u202Fs`
}

export function toolProgressKey(toolName: string, toolCallId?: string) {
  return toolCallId ? `call:${toolCallId}` : `name:${toolName}`
}

export function toolPartProgressKey(part: unknown, toolName: string) {
  const toolCallId = typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
    ? (part as { toolCallId: string }).toolCallId
    : undefined
  return toolProgressKey(toolName, toolCallId)
}

export function getDelegateTasks(part: unknown): string[] {
  const input = (part as { input?: unknown }).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const tasks = (input as { tasks?: unknown }).tasks
  if (Array.isArray(tasks)) {
    return tasks
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const task = (item as { task?: unknown }).task
        return typeof task === 'string' ? task.trim() : ''
      })
      .filter(Boolean)
  }
  const task = (input as { task?: unknown }).task
  return typeof task === 'string' && task.trim() ? [task.trim()] : []
}

export type AgentMessagePart = UIMessage['parts'][number]
export type AgentChainPart = AgentMessagePart & {
  input?: unknown
  output?: unknown
  state?: string
  errorText?: string
}

export function isAgentChainPart(part: AgentMessagePart): part is AgentChainPart {
  return part.type === 'reasoning' || isToolUIPart(part)
}

// 按消息 part 的真实顺序保留连续执行组。阶段性正文会结束当前执行组；之后产生的
// 推理或工具调用进入正文下方的新组，避免把后续操作提升到它所依据的文字之前。
export type AgentRenderSegment =
  | { kind: 'chain'; items: Array<{ part: AgentChainPart; index: number }> }
  | { kind: 'part'; part: AgentMessagePart; index: number }

export function buildRenderSegments(parts: UIMessage['parts']): AgentRenderSegment[] {
  const segments: AgentRenderSegment[] = []
  let activeChain: Extract<AgentRenderSegment, { kind: 'chain' }> | null = null
  parts.forEach((part, index) => {
    if (part.type === 'step-start') return
    if (isAgentChainPart(part)) {
      if (!activeChain) {
        activeChain = { kind: 'chain', items: [] }
        segments.push(activeChain)
      }
      activeChain.items.push({ part, index })
      return
    }
    activeChain = null
    segments.push({ kind: 'part', part, index })
  })
  return segments
}

// ====== 检索工具输出徽标（召回方式/回退原因/命中方式）======
const RETRIEVAL_MODE_LABELS: Record<string, string> = {
  hybrid: '召回: 混合',
  keyword: '召回: 关键词',
  vector: '召回: 向量',
}

const RETRIEVAL_FALLBACK_LABELS: Record<string, string> = {
  missing_session: '回退: 未限定会话',
  embedding_not_ready: '回退: 未配置向量',
  vector_no_hits: '回退: 向量无命中',
  vector_error: '回退: 向量失败',
}

const MATCHED_BY_LABELS: Record<string, string> = {
  both: '命中: 向量+关键词',
  vector: '命中: 向量',
  keyword: '命中: 关键词',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function pushBadge(badges: string[], label?: string) {
  if (label && !badges.includes(label)) badges.push(label)
}

function collectMatchedByBadges(value: unknown, badges: string[]) {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  for (const item of items) {
    const obj = asRecord(item)
    const matchedBy = typeof obj?.matchedBy === 'string' ? obj.matchedBy : ''
    if (matchedBy) seen.add(matchedBy)
  }
  for (const key of ['both', 'vector', 'keyword']) {
    if (seen.has(key)) pushBadge(badges, MATCHED_BY_LABELS[key])
  }
}

export function collectRetrievalBadges(toolName: string, output: unknown): string[] {
  if (toolName !== 'semantic_search' && toolName !== 'recall' && toolName !== 'search_messages') return []
  const obj = asRecord(output)
  if (!obj) return []
  const retrieval = asRecord(obj.retrieval)
  const badges: string[] = []
  const mode = typeof retrieval?.mode === 'string'
    ? retrieval.mode
    : typeof obj.mode === 'string'
      ? obj.mode
      : ''
  pushBadge(badges, RETRIEVAL_MODE_LABELS[mode] || (mode ? `召回: ${mode}` : undefined))
  const fallbackReason = typeof retrieval?.fallbackReason === 'string' ? retrieval.fallbackReason : ''
  pushBadge(badges, RETRIEVAL_FALLBACK_LABELS[fallbackReason])
  const rerank = asRecord(retrieval?.rerank)
  if (rerank?.applied === true) pushBadge(badges, '重排: 已应用')
  else if (rerank?.enabled === true) pushBadge(badges, '重排: 已回退')
  collectMatchedByBadges(toolName === 'recall' ? obj.memories : obj.hits, badges)
  return badges.slice(0, 5)
}
// ====== 出处（让用户能核对答案来源）======
export type WebSourceItem = {
  id: string
  url: string
  title: string
  domain: string
}

function externalSourceUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4000) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** 收集 AI SDK 的 source-url parts，并兼容各供应商联网工具结果中的 URL。 */
export function extractWebSources(parts: any[]): WebSourceItem[] {
  const sources = new Map<string, WebSourceItem>()
  const push = (urlValue: unknown, titleValue?: unknown, idValue?: unknown) => {
    const url = externalSourceUrl(urlValue)
    if (!url) return
    url.hash = ''
    const href = url.toString()
    const domain = url.hostname.replace(/^www\./i, '')
    const title = typeof titleValue === 'string' && titleValue.trim()
      ? titleValue.replace(/\s+/g, ' ').trim().slice(0, 240)
      : domain
    const previous = sources.get(href)
    if (previous) {
      if (previous.title === previous.domain && title !== domain) sources.set(href, { ...previous, title })
      return
    }
    sources.set(href, {
      id: typeof idValue === 'string' && idValue ? idValue : href,
      url: href,
      title,
      domain,
    })
  }

  const collectOutput = (value: unknown, depth = 0) => {
    if (depth > 4 || sources.size >= 12 || !value) return
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach((entry) => collectOutput(entry, depth + 1))
      return
    }
    const record = asRecord(value)
    if (!record) return
    push(record.url, record.title || record.name, record.id)
    for (const key of ['sources', 'results', 'items', 'data', 'result'] as const) {
      collectOutput(record[key], depth + 1)
    }
  }

  // source-url 是最终回答实际引用的来源，优先展示并保留更准确的标题。
  for (const part of parts) {
    if (part?.type === 'source-url') push(part.url, part.title, part.sourceId)
  }
  for (const part of parts) {
    if (!isToolUIPart(part) || part.state !== 'output-available') continue
    const toolName = toolPartName(part)
    if (toolName === 'web_search' || toolName === 'google_search') collectOutput(part.output)
  }
  return Array.from(sources.values()).slice(0, 12)
}

export function MessageWebSources({ items }: { items: WebSourceItem[] }) {
  if (items.length === 0) return null
  return (
    <Sources className="agent-sources">
      <SourcesTrigger className="agent-sources-trigger" count={items.length}>
        <Magnifier aria-hidden="true" className="size-3.5" />
        <span className="font-medium">网页来源</span>
        <span className="agent-sources-count">{items.length}</span>
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </SourcesTrigger>
      <SourcesContent className="agent-sources-content">
        <ol aria-label="网页来源" className="flex w-full flex-col gap-1.5">
          {items.map((item, index) => (
            <li key={item.id}>
              <Source
                className="group/source w-full min-w-0 rounded-lg border border-border/50 bg-card/40 px-3 py-2 text-foreground transition-colors hover:bg-card/70"
                href={item.url}
                title={item.title}
              >
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.title}</span>
                <span className="max-w-36 shrink-0 truncate text-[11px] text-muted-foreground">{item.domain}</span>
              </Source>
            </li>
          ))}
        </ol>
      </SourcesContent>
    </Sources>
  )
}

export type SourceItem = {
  id: string
  sessionId: string
  sessionName?: string
  localId?: number
  createTime?: number
  time?: string
  sender?: string
  text: string
}

type SourceContext = {
  sessionId?: string
  sessionName?: string
}

const CHAT_SOURCE_TOOLS = new Set([
  'list_conversation_manifest',
  'read_raw_messages',
  'read_raw_message_ranges',
  'search_raw_messages',
  'search_and_read_raw_messages',
  'read_message_thread',
  'transcribe_voice_messages',
])

const CHAT_SOURCE_DISPLAY_LIMIT = 30
const CHAT_SOURCE_SCAN_LIMIT = 5_000
const SOURCE_COLLECTION_KEYS = ['messages', 'transcripts', 'records', 'results', 'hits'] as const
const NESTED_SOURCE_COLLECTION_KEYS = [...SOURCE_COLLECTION_KEYS, 'recentMessages', 'events'] as const
const SOURCE_TEXT_KEYS = [
  'text',
  'excerpt',
  'snippet',
  'quote',
  'parsedContent',
  'content',
  'messageText',
  'rawContent',
  'message',
] as const
const SOURCE_SESSION_KEYS = ['sessionId', 'session_id', 'chatId', 'conversationId'] as const
const SOURCE_SESSION_NAME_KEYS = ['sessionName', 'displayName', 'chatName', 'conversationName'] as const
const SOURCE_SENDER_KEYS = ['senderDisplayName', 'senderName', 'sender', 'from', 'authorName', 'author', 'senderUsername'] as const
const SOURCE_TIME_KEYS = ['time', 'at', 'createTime', 'createdAt', 'timestamp'] as const
const SOURCE_LOCAL_ID_KEYS = ['localId', 'local_id', 'messageId', 'message_id', 'msgId'] as const

const SOURCE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function firstValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function sourceString(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\u0000/g, '').trim()
}

function sourceText(record: Record<string, unknown>): string {
  for (const key of SOURCE_TEXT_KEYS) {
    const value = sourceString(record[key])
    if (value) return value.length > 1200 ? `${value.slice(0, 1199)}…` : value
  }
  return ''
}

function sourceLocalId(record: Record<string, unknown>): number | undefined {
  const anchor = asRecord(record.anchor)
  const raw = firstValue(record, SOURCE_LOCAL_ID_KEYS) ?? (anchor ? firstValue(anchor, SOURCE_LOCAL_ID_KEYS) : undefined)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function sourceTime(value: unknown): string | undefined {
  const raw = sourceString(value)
  if (!raw) return undefined
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return SOURCE_TIME_FORMATTER.format(date)
  }
  const parsed = Date.parse(raw)
  if (!Number.isNaN(parsed)) return SOURCE_TIME_FORMATTER.format(new Date(parsed))
  return raw.slice(0, 80)
}

function sourceCreateTime(value: unknown): number | undefined {
  const raw = sourceString(value)
  if (!raw) return undefined
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric < 100_000_000_000 ? numeric : numeric / 1000)
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000)
}

function sourceContext(record: Record<string, unknown>, parent: SourceContext): SourceContext {
  return {
    sessionId: sourceString(firstValue(record, SOURCE_SESSION_KEYS)) || parent.sessionId,
    sessionName: sourceString(firstValue(record, SOURCE_SESSION_NAME_KEYS)) || parent.sessionName,
  }
}

export function toolPartName(part: any): string {
  const dynamicName = sourceString(part?.toolName)
  if (dynamicName) return dynamicName
  const type = sourceString(part?.type)
  return type.replace(/^tool-/, '')
}

function parsePossibleJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2_000_000 || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/**
 * 从助手消息的工具结果里抽出真实聊天证据。
 *
 * 当前 Electron 工具会把真实消息放在 messages、transcripts、records、results 或 hits 中，
 * 当前工具结果中的消息来源会被统一提取为可核对的原文出处。
 * 若调用方提供 selectedSourceIds，则按该顺序优先收集来源；
 * 扫描与展示分别设置上限，避免异常工具结果撑大页面。
 */
export type ExtractedSources = {
  items: SourceItem[]
  total: number
  truncated: boolean
}

export function extractSources(parts: any[], selectedSourceIds?: string[]): ExtractedSources {
  const items: SourceItem[] = []
  const selectedItems = new Map<string, SourceItem>()
  const selectedOrder = Array.isArray(selectedSourceIds)
    ? Array.from(new Set(selectedSourceIds.map(sourceString).filter(Boolean))).slice(0, CHAT_SOURCE_DISPLAY_LIMIT)
    : null
  const selectedSet = selectedOrder ? new Set(selectedOrder) : null
  const seen = new Set<string>()
  let truncated = false

  const pushRecord = (value: unknown, parent: SourceContext) => {
    const record = asRecord(value)
    if (!record) return
    const context = sourceContext(record, parent)
    const sessionId = context.sessionId || ''
    const text = sourceText(record)
    if (!sessionId || !text) return

    const localId = sourceLocalId(record)
    const rawTime = firstValue(record, SOURCE_TIME_KEYS)
    const time = sourceTime(rawTime)
    const createTime = sourceCreateTime(rawTime)
    const sender = sourceString(firstValue(record, SOURCE_SENDER_KEYS)) || undefined
    const identity = localId
      ? `${sessionId}:local:${localId}`
      : `${sessionId}:message:${time || ''}:${sender || ''}:${text.replace(/\s+/g, ' ').slice(0, 180)}`
    if (seen.has(identity)) return
    if (seen.size >= CHAT_SOURCE_SCAN_LIMIT) {
      truncated = true
      return
    }
    seen.add(identity)
    const item = {
      id: identity,
      sessionId,
      sessionName: context.sessionName,
      localId,
      createTime,
      time,
      sender,
      text,
    }
    if (selectedSet) {
      if (selectedSet.has(identity)) selectedItems.set(identity, item)
    } else if (items.length < CHAT_SOURCE_DISPLAY_LIMIT) items.push(item)
  }

  const collectRecords = (value: unknown, parent: SourceContext, depth = 0) => {
    if (!Array.isArray(value) || depth > 3 || truncated) return
    for (const entry of value) {
      if (truncated) break
      const record = asRecord(entry)
      if (!record) continue
      const context = sourceContext(record, parent)
      pushRecord(record, context)
      for (const key of NESTED_SOURCE_COLLECTION_KEYS) {
        collectRecords(record[key], context, depth + 1)
      }
    }
  }

  const collectOutput = (toolName: string, value: unknown, depth = 0) => {
    if (depth > 2 || truncated) return
    const parsed = parsePossibleJson(value)
    const output = asRecord(parsed)
    if (output?.success === false || sourceString(output?.error)) return
    const allowed = CHAT_SOURCE_TOOLS.has(toolName)

    if (Array.isArray(parsed)) {
      if (allowed) collectRecords(parsed, {})
      return
    }
    if (!output) return

    const context = sourceContext(output, {})
    collectRecords(output.messages, context)
    collectRecords(output.transcripts, context)
    collectRecords(output.records, context)
    if (allowed) {
      pushRecord(output, context)
      for (const key of SOURCE_COLLECTION_KEYS) collectRecords(output[key], context)
    }

    // 支持常见的 data/result 包装，但不遍历任意字段。
    for (const key of ['data', 'result'] as const) {
      const wrapped = parsePossibleJson(output[key])
      if (wrapped && wrapped !== parsed) collectOutput(toolName, wrapped, depth + 1)
    }
  }

  for (const part of parts) {
    if (!isToolUIPart(part) || part.state !== 'output-available') continue
    collectOutput(toolPartName(part), part.output)
    if (truncated) break
  }
  return {
    items: selectedOrder ? selectedOrder.flatMap((evidenceId) => {
      const item = selectedItems.get(evidenceId)
      return item ? [item] : []
    }) : items,
    total: seen.size,
    truncated,
  }
}

export function MessageSources({
  items,
  total,
  truncated,
  nameOf,
  onOpenSource,
}: {
  items: SourceItem[]
  total: number
  truncated?: boolean
  nameOf: (sessionId: string) => string
  onOpenSource?: (item: SourceItem) => void
}) {
  if (items.length === 0) return null
  const excerptOf = (text: string) => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized
  }
  const senderNameOf = (item: SourceItem, sessionName: string) => {
    if (!item.sender || item.sender === item.sessionId) return sessionName
    if (item.sender === '对方') return item.sessionId.endsWith('@chatroom') ? '对方' : sessionName
    return item.sender
  }
  return (
    <Sources className="agent-sources">
      <SourcesTrigger className="agent-sources-trigger" count={total}>
        <QuoteOpen aria-hidden="true" className="size-3.5" />
        <span className="font-medium">聊天证据</span>
        <span className="agent-sources-count">
          {items.length < total ? `${items.length} / ${total}${truncated ? '+' : ''}` : total}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </SourcesTrigger>
      <SourcesContent className="agent-sources-content">
        <ol aria-label="聊天证据" className="agent-source-list">
          {items.map((it, index) => {
            const sessionName = it.sessionName || nameOf(it.sessionId) || it.sessionId
            const senderName = senderNameOf(it, sessionName)
            const sourceName = senderName && senderName !== sessionName
              ? `${senderName} · ${sessionName}`
              : sessionName
            const displayText = excerptOf(it.text)
            const header = (
              <span className="agent-source-header">
                <span className="agent-source-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{sourceName}</span>
                {it.time && <time className="agent-source-time">{it.time}</time>}
              </span>
            )
            return (
              <li className="agent-source-item" key={it.id}>
                <article className="agent-source-article">
                  {header}
                  <blockquote className="agent-source-quote">
                    {onOpenSource ? (
                      <button
                        aria-label={`在原聊天中查看：${displayText}`}
                        className="agent-source-quote-link"
                        title="在原聊天中查看"
                        type="button"
                        onClick={() => onOpenSource(it)}
                      >{displayText}</button>
                    ) : displayText}
                  </blockquote>
                </article>
              </li>
            )
          })}
        </ol>
      </SourcesContent>
    </Sources>
  )
}
