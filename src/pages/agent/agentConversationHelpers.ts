/**
 * 会话持久化相关的纯函数：标题兜底、会话记录归一化、模型配置匹配、
 * 把子助手进度和工具耗时写进消息 metadata，重开会话后仍能展示。
 * 本文件从 AgentPage.tsx 拆出。
 */
import { isToolUIPart, type UIMessage } from 'ai'
import type { AgentModelConfig, AgentProgressEvent, AgentScope } from '@/features/aiagent/transport/ipcChatTransport'
import type * as configService from '@/services/config'
import { toolPartProgressKey } from './agentMessageHelpers'

export function buildFallbackConversationTitle(text: string): string {
  const normalized = text
    .replace(/@\S+\[[^\]]+\]/g, '')
    .replace(/[？?。！!，,、：:\s]+/g, ' ')
    .trim()
  return (normalized || '新对话').slice(0, 18)
}

export type AgentConversationRecord = {
  id: number
  accountId?: string
  title: string
  titleGeneratedAt?: number
  scope?: AgentScope
  modelProvider?: string
  modelId?: string
  source?: string
  externalId?: string | null
  pinned?: boolean
  createdAt?: number
  updatedAt: number
}

export type AgentConversationLoaded = AgentConversationRecord & {
  messages: UIMessage[]
}

export const ACTIVE_AGENT_CONVERSATION_KEY = 'weflow.agent.activeConversationId'
export const NEW_AGENT_CONVERSATION_MARKER = 'new'
export const STREAMING_AGENT_SAVE_INTERVAL_MS = 2000

export type AgentRunStateSummary = {
  runId: string
  conversationId: number
  status: 'running' | 'completed' | 'failed' | 'aborted'
  outcome?: 'answered'
  question?: string
  startedAt?: number
  finishedAt?: number
  updatedAt: number
}

export const AGENT_TOOL_NOT_RUN_ERROR = '未运行：回答已结束；继续回答时将重新运行此工具。'

/** 把停止瞬间仍未产生终态的工具固定为“未运行”，避免重开会话后继续显示正在运行。 */
export function markUnfinishedAgentToolsNotRun(messages: UIMessage[]): UIMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    let messageChanged = false
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || ['output-available', 'output-error', 'output-denied'].includes(part.state)) return part
      messageChanged = true
      changed = true
      return {
        ...part,
        state: 'output-error',
        errorText: AGENT_TOOL_NOT_RUN_ERROR,
      } as typeof part
    })
    return messageChanged ? { ...message, parts } as UIMessage : message
  })
  return changed ? next : messages
}

/**
 * 只恢复最近一次运行：较早的失败运行不能盖过后来已经完成的回答。
 * 运行快照由主进程持久化，因此应用重启后仍可据此恢复。
 */
export function findLatestIncompleteAgentRun(values: unknown[]): AgentRunStateSummary | null {
  const runs = values
    .map((value): AgentRunStateSummary | null => {
      const item = value as Partial<AgentRunStateSummary> | null
      const conversationId = Number(item?.conversationId)
      const updatedAt = Number(item?.updatedAt)
      const runId = String(item?.runId || '').trim()
      const status = String(item?.status || '')
      const startedAt = finiteNumber(item?.startedAt)
      const finishedAt = finiteNumber(item?.finishedAt)
      if (
        !runId
        || !Number.isFinite(updatedAt)
        || !['running', 'completed', 'failed', 'aborted'].includes(status)
      ) return null
      return {
        runId,
        conversationId: Number.isFinite(conversationId) && conversationId > 0 ? conversationId : 0,
        status: status as AgentRunStateSummary['status'],
        outcome: item?.outcome === 'answered' ? 'answered' : undefined,
        question: typeof item?.question === 'string' ? item.question : undefined,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        updatedAt,
      } satisfies AgentRunStateSummary
    })
    .filter((run): run is AgentRunStateSummary => run !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)

  const latest = runs[0]
  if (
    !latest
    || latest.conversationId <= 0
    || (latest.status === 'completed' && latest.outcome === 'answered')
  ) return null
  return latest
}

/**
 * 只检查用户当前打开的会话。其他会话较新或较旧的运行状态都不应影响当前会话，
 * 更不能因此在进入 Agent 页面时主动切换会话。
 */
export function findLatestIncompleteAgentRunForConversation(
  values: unknown[],
  conversationId: number,
): AgentRunStateSummary | null {
  if (!Number.isFinite(conversationId) || conversationId <= 0) return null
  return findLatestIncompleteAgentRun(values.filter((value) => (
    Number((value as Partial<AgentRunStateSummary> | null)?.conversationId) === conversationId
  )))
}

export function readStoredActiveAgentConversation(): number | 'new' | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_AGENT_CONVERSATION_KEY)
    if (raw === NEW_AGENT_CONVERSATION_MARKER) return 'new'
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function storeActiveAgentConversation(id: number | null): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      ACTIVE_AGENT_CONVERSATION_KEY,
      id && id > 0 ? String(id) : NEW_AGENT_CONVERSATION_MARKER,
    )
  } catch {
    // 某些受限渲染上下文可能禁用 sessionStorage。
  }
}

export function canApplyDeferredConversationRestore(input: {
  cancelled: boolean
  expectedRuntimeKey: string
  currentRuntimeKey?: string | null
  conversationId?: number | null
  messageCount: number
  draft?: string
}): boolean {
  return !input.cancelled
    && Boolean(input.expectedRuntimeKey)
    && input.currentRuntimeKey === input.expectedRuntimeKey
    && !input.conversationId
    && input.messageCount === 0
    && !String(input.draft || '').trim()
}

export function normalizeConversationRecord(value: any): AgentConversationRecord | null {
  const id = Number(value?.id)
  if (!Number.isFinite(id) || id <= 0) return null
  return {
    id,
    accountId: value?.accountId ? String(value.accountId) : undefined,
    title: String(value?.title || '新对话'),
    titleGeneratedAt: Number(value?.titleGeneratedAt || 0) || undefined,
    scope: value?.scope,
    modelProvider: value?.modelProvider,
    modelId: value?.modelId,
    source: typeof value?.source === 'string' ? value.source : undefined,
    externalId: value?.externalId == null ? null : String(value.externalId),
    pinned: value?.pinned === true || undefined,
    createdAt: Number(value?.createdAt || 0) || undefined,
    updatedAt: Number(value?.updatedAt || Date.now()),
  }
}


export function normalizeLoadedConversation(value: any): AgentConversationLoaded | null {
  const record = normalizeConversationRecord(value)
  if (!record) return null
  return {
    ...record,
    messages: Array.isArray(value?.messages) ? value.messages as UIMessage[] : [],
  }
}

export function modelConfigProvider(config: AgentModelConfig | null): string {
  return String(config?.provider || 'current')
}

export function modelConfigId(config: AgentModelConfig | null): string {
  return String(config?.model || '')
}

function normalizeConfigText(value?: string) {
  return String(value || '').trim()
}

function normalizeConfigBaseURL(value?: string) {
  return normalizeConfigText(value).replace(/\/+$/, '')
}

export function presetMatchesCurrentConfig(
  preset: configService.AiConfigPreset,
  provider: string,
  currentConfig: configService.AiProviderConfig | null,
) {
  if (!currentConfig) return false
  return preset.provider === provider
    && normalizeConfigText(preset.apiKey) === normalizeConfigText(currentConfig.apiKey)
    && normalizeConfigText(preset.model) === normalizeConfigText(currentConfig.model)
    && normalizeConfigBaseURL(preset.baseURL) === normalizeConfigBaseURL(currentConfig.baseURL)
    && normalizeConfigText(preset.protocol) === normalizeConfigText(currentConfig.protocol)
}

export function resolveDefaultPresetId(
  presets: configService.AiConfigPreset[],
  provider: string,
  currentConfig: configService.AiProviderConfig | null,
  activePresetId: string,
) {
  const activePreset = presets.find((preset) => preset.id === activePresetId)
  if (activePreset && presetMatchesCurrentConfig(activePreset, provider, currentConfig)) return activePreset.id
  return presets.find((preset) => presetMatchesCurrentConfig(preset, provider, currentConfig))?.id || 'current'
}

export type AgentUsage = {
  inputTokens?: number
  cacheHitRate?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokens?: number
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
  totalTokens?: number
  raw?: unknown
}

export type AgentTraceStep = {
  stepNumber: number
  callId?: string
  provider?: string
  modelId?: string
  finishReason?: string
  usage?: AgentUsage
  elapsedMs?: number
  responseMs?: number
  timeToFirstOutputMs?: number
  outputTokensPerSecond?: number
  effectiveOutputTokensPerSecond?: number
}

export type AgentTraceTool = {
  toolCallId: string
  toolName: string
  elapsedMs: number
  error?: string
}

export type AgentTraceMetadata = {
  startedAt: number
  finishedAt?: number
  totalElapsedMs?: number
  elapsedBeforeMs?: number
  executionState?: 'running' | 'completed' | 'stopped'
  firstStreamEventMs?: number
  firstOutputMs?: number
  stepCount?: number
  toolCount?: number
  steps?: AgentTraceStep[]
  tools?: AgentTraceTool[]
}

export type AgentProviderCacheStatus = {
  providerKind?: string
  providerName?: string
  model?: string
  promptCacheKey?: string
  promptCacheRetention?: '24h' | string
  promptCacheEnabled?: boolean
  promptCacheProvider?: 'openai-responses' | 'anthropic' | 'google' | 'openai-compatible' | 'none' | string
  requestBodyPromptCacheField?: 'prompt_cache_key' | 'promptCacheKey' | string
  reason?: string
}

export type AgentMessageMetadata = {
  createdAt?: number
  usage?: AgentUsage
  finishReason?: string
  rawFinishReason?: string
  modelProvider?: string
  modelId?: string
  context?: {
    contextWindow?: number
    contextWindowSource?: 'manual' | 'catalog' | 'inferred' | 'default'
    maxOutputTokens?: number
    finalAnswerBudget?: number
    finalAnswerTokensUsed?: number
    finalAnswerSegments?: number
    estimatedTokensBefore?: number
    estimatedTokensAfter?: number
    compacted?: boolean
  }
  ciphertalk?: {
    subAgentProgress?: AgentProgressEvent[]
    toolElapsed?: Record<string, number>
    providerCache?: AgentProviderCacheStatus
    trace?: AgentTraceMetadata
  }
  agent?: {
    runId?: string
    resumedFromRunId?: string
    architecture?: 'model-led-raw-reading' | string
    mode?: 'standard' | 'deep-research'
    policy?: {
      version?: string
      scenario?: string
      localDataAvailable?: boolean
      reasons?: string[]
    }
    research?: {
      investigationPlan?: {
        title?: string
        questionUnderstanding?: string
        answerRequirements?: string[]
        uncertainties?: string[]
        steps?: Array<{
          id?: string
          title?: string
          purpose?: string
          status?: 'pending' | 'in_progress' | 'completed' | 'skipped'
          note?: string
        }>
        updatedAt?: number
      }
      readPages?: Array<{
        pageId?: string
        pageHash?: string
        sessionId?: string
        displayName?: string
        startAt?: string
        endAt?: string
        messageCount?: number
        estimatedTokens?: number
        cacheHit?: boolean
      }>
      checkpoints?: number
      feedback?: Array<Record<string, unknown>>
      toolResultCount?: number
    }
    privacy?: {
      phoneMatches?: number
      identityCardMatches?: number
      uniquePhones?: number
      uniqueIdentityCards?: number
    }
    debugLogPath?: string
    subAgentProgress?: AgentProgressEvent[]
    toolElapsed?: Record<string, number>
    providerCache?: AgentProviderCacheStatus
    trace?: AgentTraceMetadata
  }
}

export function readAgentMessageTimestamp(message: UIMessage, nextMessage?: UIMessage): number | undefined {
  const metadata = (message as { metadata?: AgentMessageMetadata }).metadata
  const directCreatedAt = (message as UIMessage & { createdAt?: number | string | Date }).createdAt
  const directTimestamp = directCreatedAt instanceof Date
    ? directCreatedAt.getTime()
    : typeof directCreatedAt === 'string' && !/^\d+(?:\.\d+)?$/.test(directCreatedAt.trim())
      ? Date.parse(directCreatedAt)
      : finiteNumber(directCreatedAt)
  const ownTimestamp = finiteNumber(metadata?.createdAt)
    ?? finiteNumber(directTimestamp)
  if (ownTimestamp !== undefined && ownTimestamp > 0) return ownTimestamp
  if (message.role !== 'user' || nextMessage?.role !== 'assistant') return undefined
  const nextMetadata = (nextMessage as { metadata?: AgentMessageMetadata }).metadata
  const traceTimestamp = finiteNumber(nextMetadata?.agent?.trace?.startedAt)
    ?? finiteNumber(nextMetadata?.ciphertalk?.trace?.startedAt)
  return traceTimestamp !== undefined && traceTimestamp > 0 ? traceTimestamp : undefined
}

function isAgentProgressEvent(value: unknown): value is AgentProgressEvent {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AgentProgressEvent>
  return typeof item.stage === 'string'
    && typeof item.title === 'string'
    && typeof item.at === 'number'
}

export function readSubAgentProgressFromMessage(message: UIMessage): AgentProgressEvent[] {
  const metadata = (message as { metadata?: AgentMessageMetadata }).metadata
  const value = metadata?.agent?.subAgentProgress || metadata?.ciphertalk?.subAgentProgress
  return Array.isArray(value) ? value.filter(isAgentProgressEvent) : []
}

function progressSignature(events: AgentProgressEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    stage: event.stage,
    title: event.title,
    detail: event.detail,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    parentToolCallId: event.parentToolCallId,
    subTaskId: event.subTaskId,
    subTaskTitle: event.subTaskTitle,
    depth: event.depth,
    at: event.at,
  })))
}

function attachSubAgentProgressToLastAssistant(messages: UIMessage[], progress: AgentProgressEvent[]): UIMessage[] {
  if (progress.length === 0) return messages
  const targetIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant')
  if (targetIndex < 0) return messages
  const index = messages.length - 1 - targetIndex
  const current = readSubAgentProgressFromMessage(messages[index])
  if (progressSignature(current) === progressSignature(progress)) return messages

  return messages.map((message, i) => {
    if (i !== index) return message
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    return {
      ...message,
      metadata: {
        ...metadata,
        ciphertalk: {
          ...(metadata.ciphertalk || {}),
          subAgentProgress: progress,
        },
        agent: {
          ...(metadata.agent || {}),
          subAgentProgress: progress,
        },
      },
    } as UIMessage
  })
}

export function readToolElapsedFromMessage(message: UIMessage): Record<string, number> {
  const value = (message as { metadata?: AgentMessageMetadata }).metadata?.agent?.toolElapsed || (message as { metadata?: AgentMessageMetadata }).metadata?.ciphertalk?.toolElapsed
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, ms] of Object.entries(value)) {
    if (typeof ms === 'number' && Number.isFinite(ms)) out[key] = ms
  }
  return out
}

function lastAssistantMessageIndex(messages: UIMessage[]): number {
  const reversedIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant')
  return reversedIndex < 0 ? -1 : messages.length - 1 - reversedIndex
}

function executionTraceOf(message: UIMessage | undefined): AgentTraceMetadata | undefined {
  const metadata = (message as { metadata?: AgentMessageMetadata } | undefined)?.metadata
  return metadata?.agent?.trace || metadata?.ciphertalk?.trace
}

function updateLastAssistantExecutionTrace(
  messages: UIMessage[],
  update: (trace: AgentTraceMetadata | undefined) => AgentTraceMetadata,
): UIMessage[] {
  const index = lastAssistantMessageIndex(messages)
  if (index < 0) return messages
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index) return message
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    const trace = update(executionTraceOf(message))
    return {
      ...message,
      metadata: {
        ...metadata,
        agent: {
          ...(metadata.agent || {}),
          trace,
        },
      },
    } as UIMessage
  })
}

export function readLatestStoppedAgentExecutionElapsed(messages: UIMessage[]): number {
  const index = lastAssistantMessageIndex(messages)
  const trace = index < 0 ? undefined : executionTraceOf(messages[index])
  if (trace?.executionState !== 'stopped') return 0
  return Math.max(0, finiteNumber(trace.totalElapsedMs) || 0)
}

export function markAgentExecutionResumed(messages: UIMessage[], resumedAt: number, elapsedOverrideMs?: number): UIMessage[] {
  const elapsedBeforeMs = Math.max(
    readLatestStoppedAgentExecutionElapsed(messages),
    finiteNumber(elapsedOverrideMs) || 0,
  )
  return updateLastAssistantExecutionTrace(messages, (trace) => ({
    ...(trace || { startedAt: resumedAt }),
    startedAt: resumedAt,
    finishedAt: undefined,
    totalElapsedMs: elapsedBeforeMs,
    elapsedBeforeMs,
    executionState: 'running',
  }))
}

export function markAgentExecutionStopped(messages: UIMessage[], options: {
  stoppedAt: number
  segmentStartedAt?: number | null
  elapsedBeforeMs?: number
}): UIMessage[] {
  return updateLastAssistantExecutionTrace(messages, (trace) => {
    if (trace?.executionState === 'stopped' && options.segmentStartedAt == null) return trace
    const elapsedBeforeMs = Math.max(0, finiteNumber(options.elapsedBeforeMs) ?? finiteNumber(trace?.elapsedBeforeMs) ?? 0)
    const segmentStartedAt = finiteNumber(options.segmentStartedAt) ?? finiteNumber(trace?.startedAt) ?? options.stoppedAt
    const totalElapsedMs = elapsedBeforeMs + Math.max(0, options.stoppedAt - segmentStartedAt)
    return {
      ...(trace || { startedAt: segmentStartedAt }),
      startedAt: segmentStartedAt,
      finishedAt: options.stoppedAt,
      totalElapsedMs,
      elapsedBeforeMs: totalElapsedMs,
      executionState: 'stopped',
    }
  })
}

export function markAgentExecutionCompleted(messages: UIMessage[], options: {
  finishedAt: number
  segmentStartedAt?: number | null
  elapsedBeforeMs?: number
}): UIMessage[] {
  return updateLastAssistantExecutionTrace(messages, (trace) => {
    const elapsedBeforeMs = Math.max(0, finiteNumber(options.elapsedBeforeMs) ?? finiteNumber(trace?.elapsedBeforeMs) ?? 0)
    const segmentStartedAt = finiteNumber(options.segmentStartedAt) ?? finiteNumber(trace?.startedAt) ?? options.finishedAt
    const totalElapsedMs = elapsedBeforeMs + Math.max(0, options.finishedAt - segmentStartedAt)
    return {
      ...(trace || { startedAt: segmentStartedAt }),
      startedAt: segmentStartedAt,
      finishedAt: options.finishedAt,
      totalElapsedMs,
      elapsedBeforeMs,
      executionState: 'completed',
    }
  })
}

function sameToolElapsed(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/** 把工具步骤耗时写进各助手消息 metadata，重开会话后思考链里的工具步骤仍显示“· X.Xs”。 */
function attachToolElapsedToMessages(messages: UIMessage[], toolElapsedByKey: Record<string, number>): UIMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const elapsed: Record<string, number> = {}
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue
      const toolName = part.type.replace(/^tool-/, '')
      const ms = toolElapsedByKey[toolPartProgressKey(part, toolName)]
      if (typeof ms === 'number' && Number.isFinite(ms)) elapsed[toolPartProgressKey(part, toolName)] = ms
    }
    if (Object.keys(elapsed).length === 0) return message
    if (sameToolElapsed(readToolElapsedFromMessage(message), elapsed)) return message
    changed = true
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    return {
      ...message,
      metadata: {
        ...metadata,
        ciphertalk: {
          ...(metadata.ciphertalk || {}),
          toolElapsed: elapsed,
        },
        agent: {
          ...(metadata.agent || {}),
          toolElapsed: elapsed,
        },
      },
    } as UIMessage
  })
  return changed ? next : messages
}

export function prepareAgentMessagesForPersist(
  messages: UIMessage[],
  subAgentProgress: AgentProgressEvent[],
  toolElapsedByKey: Record<string, number>,
): UIMessage[] {
  return attachToolElapsedToMessages(
    attachSubAgentProgressToLastAssistant(messages, subAgentProgress),
    toolElapsedByKey,
  )
}

export function signatureAgentMessages(messages: UIMessage[]): string {
  try {
    return JSON.stringify(messages)
  } catch {
    return `${messages.length}:${Date.now()}`
  }
}

export function finiteNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function parseAgentMessageMetadata(metadata: unknown): AgentMessageMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = metadata as AgentMessageMetadata
  return value.usage && typeof value.usage === 'object' ? value : null
}
