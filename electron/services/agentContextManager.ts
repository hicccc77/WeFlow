import type { UIMessage } from 'ai'
import {
  normalizeAgentContextWindow,
  resolveAgentMaxOutputTokens,
  type AgentContextWindowSource,
} from '../../src/utils/modelTokenLimits'
import {
  estimateAgentMessagesTokens,
  estimateAgentTextTokens,
  estimateAgentUnknownTokens,
} from '../../src/utils/agentTokenEstimate'

const NORMAL_TRIGGER_RATIO = 0.82
const NORMAL_TARGET_RATIO = 0.52
const FORCE_TARGET_RATIO = 0.32
const NORMAL_RECENT_MESSAGES = 6
const FORCE_RECENT_MESSAGES = 2
const MAX_SUMMARY_TOKENS = 1_536

export type AgentCompactionReason = 'context-pressure' | 'provider-overflow'

export type AgentCompactionData = {
  summary: string
  foldedMessages: number
  foldedThroughMessageId: string
  approxTokensBefore: number
  approxTokensAfter: number
  contextWindow: number
  contextWindowSource: AgentContextWindowSource
  modelId: string
  reason: AgentCompactionReason
  createdAt: number
}

export type AgentContextSummaryRequest = {
  previousSummary?: string
  transcript: string
  maxOutputTokens: number
}

export type PreparedAgentContext = {
  messages: UIMessage[]
  summary?: string
  compaction?: AgentCompactionData
  contextWindow: number
  contextWindowSource: AgentContextWindowSource
  maxOutputTokens: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  messageTokenBudget: number
  compacted: boolean
}

type PrepareAgentContextOptions = {
  contextWindow: number
  contextWindowSource: AgentContextWindowSource
  maxOutputTokens?: number
  modelId: string
  systemPrompt: string
  toolCount: number
  force?: boolean
  summarize: (request: AgentContextSummaryRequest) => Promise<string>
  onCompacting?: (detail: { estimatedTokens: number; contextWindow: number; force: boolean }) => void
}

type ExistingCompaction = {
  marker: AgentCompactionData
  foldedThroughIndex: number
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value ?? '')
  }
}

function clipText(value: string, maxChars: number, notice = '\n…[较早内容已裁剪]…\n'): string {
  if (value.length <= maxChars) return value
  const available = Math.max(80, maxChars - notice.length)
  const head = Math.ceil(available * 0.62)
  const tail = Math.max(0, available - head)
  return `${value.slice(0, head)}${notice}${tail > 0 ? value.slice(-tail) : ''}`
}

function clipTextToTokenBudget(value: string, maxTokens: number, notice = '\n…[较早内容已裁剪]…\n'): string {
  if (estimateTextTokens(value) <= maxTokens) return value
  let low = Math.min(80, value.length)
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTextTokens(clipText(value, middle, notice)) <= maxTokens) low = middle
    else high = middle - 1
  }
  return clipText(value, Math.max(80, low), notice)
}

function compactToolValue(value: unknown, maxChars: number): unknown {
  const serialized = safeJSONStringify(value)
  if (serialized.length <= maxChars) return value
  return {
    compacted: true,
    note: '旧工具结果已按上下文预算裁剪；关键结论会保留在会话摘要中。',
    preview: clipText(serialized, maxChars),
  }
}

function sanitizeMessage(message: UIMessage, old: boolean, force: boolean): UIMessage {
  const toolOutputLimit = force ? (old ? 1_200 : 4_000) : (old ? 2_400 : 12_000)
  const toolInputLimit = force ? 1_600 : 4_000
  const parts = message.parts.flatMap((part) => {
    const candidate = part as Record<string, unknown>
    const type = String(candidate.type || '')
    if (type === 'reasoning' || type === 'reasoning-file' || type === 'step-start' || type.startsWith('data-')) return []
    if (type.startsWith('source-')) return []

    const isTool = type.startsWith('tool-') || type === 'dynamic-tool'
    if (!isTool) return [part]

    const next: Record<string, unknown> = { ...candidate }
    if ('input' in next) next.input = compactToolValue(next.input, toolInputLimit)
    if (next.state === 'output-available' && 'output' in next) {
      next.output = compactToolValue(next.output, toolOutputLimit)
    }
    if (next.state === 'output-error' && typeof next.errorText === 'string') {
      next.errorText = clipText(next.errorText, 1_200)
    }
    return [next as (typeof message.parts)[number]]
  })
  return { ...message, parts }
}

function sanitizeMessages(messages: UIMessage[], force: boolean): UIMessage[] {
  const recentBoundary = Math.max(0, messages.length - (force ? 4 : 8))
  return messages
    .map((message, index) => sanitizeMessage(message, index < recentBoundary, force))
    .filter((message) => message.parts.length > 0)
}

export const estimateTextTokens = estimateAgentTextTokens

export function estimateUIMessagesTokens(messages: UIMessage[]): number {
  return estimateAgentMessagesTokens(messages)
}

export const estimateUnknownTokens = estimateAgentUnknownTokens

function readLatestCompaction(messages: UIMessage[]): ExistingCompaction | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex] as { type?: unknown; data?: unknown }
      if (part.type !== 'data-compaction' || !part.data || typeof part.data !== 'object') continue
      const data = part.data as Partial<AgentCompactionData>
      if (!data.summary || !data.foldedThroughMessageId) continue
      const foldedThroughIndex = messages.findIndex((item) => item.id === data.foldedThroughMessageId)
      if (foldedThroughIndex < 0) continue
      return {
        marker: {
          summary: String(data.summary),
          foldedMessages: Number(data.foldedMessages || 0),
          foldedThroughMessageId: String(data.foldedThroughMessageId),
          approxTokensBefore: Number(data.approxTokensBefore || 0),
          approxTokensAfter: Number(data.approxTokensAfter || 0),
          contextWindow: Number(data.contextWindow || 0),
          contextWindowSource: data.contextWindowSource || 'default',
          modelId: String(data.modelId || ''),
          reason: data.reason || 'context-pressure',
          createdAt: Number(data.createdAt || 0),
        },
        foldedThroughIndex,
      }
    }
  }
  return null
}

function partSummary(part: UIMessage['parts'][number]): string {
  const candidate = part as Record<string, unknown>
  const type = String(candidate.type || '')
  if (type === 'text') return String(candidate.text || '').trim()
  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    const toolName = type === 'dynamic-tool' ? String(candidate.toolName || 'tool') : type.slice(5)
    const input = clipText(safeJSONStringify(candidate.input), 900)
    if (candidate.state === 'output-available') {
      return `[工具 ${toolName}] 输入：${input}\n结果：${clipText(safeJSONStringify(candidate.output), 2_400)}`
    }
    if (candidate.state === 'output-error') return `[工具 ${toolName}] 失败：${clipText(String(candidate.errorText || ''), 900)}`
    return `[工具 ${toolName}] 输入：${input}`
  }
  if (type === 'file') return `[文件：${String(candidate.filename || candidate.mediaType || '附件')}]`
  return ''
}

function serializeForSummary(messages: UIMessage[], maxChars: number): string {
  const blocks: string[] = []
  let used = 0
  for (const message of messages) {
    const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'
    const content = message.parts.map(partSummary).filter(Boolean).join('\n')
    if (!content) continue
    const block = `${role}（messageId=${message.id}）：\n${clipText(content, 6_000)}`
    if (used + block.length > maxChars) {
      const remaining = maxChars - used
      if (remaining > 240) blocks.push(clipText(block, remaining, '\n…[摘要输入达到预算上限]…\n'))
      break
    }
    blocks.push(block)
    used += block.length + 2
  }
  return blocks.join('\n\n')
}

function localFallbackSummary(previousSummary: string | undefined, messages: UIMessage[]): string {
  const sections: string[] = []
  if (previousSummary) sections.push(`此前摘要：\n${clipText(previousSummary, 4_500)}`)
  const transcript = serializeForSummary(messages, 7_500)
  if (transcript) sections.push(`后续折叠记录：\n${transcript}`)
  return clipText(sections.join('\n\n') || '较早会话已折叠；没有可提取的文本内容。', 9_000)
}

function contextBudget(options: PrepareAgentContextOptions) {
  const contextWindow = normalizeAgentContextWindow(options.contextWindow) || 32_768
  const maxOutputTokens = resolveAgentMaxOutputTokens(options.maxOutputTokens, contextWindow)
  const safetyTokens = Math.max(768, Math.min(8_192, Math.floor(contextWindow * 0.06)))
  const promptBudget = Math.max(1_024, contextWindow - maxOutputTokens - safetyTokens)
  const systemTokens = Math.min(
    Math.max(256, estimateTextTokens(options.systemPrompt) + 128),
    Math.floor(contextWindow * 0.18),
  )
  const toolTokens = Math.min(
    1_000 + Math.max(0, options.toolCount) * 280,
    Math.floor(contextWindow * 0.18),
  )
  const messageTokenBudget = Math.max(512, promptBudget - systemTokens - toolTokens)
  return { contextWindow, maxOutputTokens, safetyTokens, promptBudget, systemTokens, toolTokens, messageTokenBudget }
}

function totalEstimatedTokens(
  messageTokens: number,
  summary: string | undefined,
  budget: ReturnType<typeof contextBudget>,
): number {
  return budget.systemTokens
    + budget.toolTokens
    + budget.maxOutputTokens
    + messageTokens
    + (summary ? estimateTextTokens(summary) + 96 : 0)
}

function trimOversizedRetainedMessages(messages: UIMessage[], tokenBudget: number): UIMessage[] {
  let next = messages
  if (estimateUIMessagesTokens(next) <= tokenBudget) return next

  let latestUserIndex = -1
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === 'user') {
      latestUserIndex = index
      break
    }
  }
  let overage = estimateUIMessagesTokens(next) - tokenBudget
  next = next.map((message, messageIndex) => {
    if (messageIndex === latestUserIndex) return message
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== 'text' || overage <= 0) return part
        const currentTokens = estimateTextTokens(part.text)
        if (currentTokens <= 160) return part
        const targetTokens = Math.max(160, currentTokens - overage)
        const text = clipTextToTokenBudget(part.text, targetTokens)
        overage -= Math.max(0, currentTokens - estimateTextTokens(text))
        return { ...part, text }
      }),
    }
  })
  if (estimateUIMessagesTokens(next) <= tokenBudget) return next

  const latestUserBudget = Math.max(320, Math.floor(tokenBudget * 0.72))
  return next.map((message, messageIndex) => {
    if (messageIndex !== latestUserIndex) return message
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== 'text' || estimateTextTokens(part.text) <= latestUserBudget) return part
        return {
          ...part,
          text: clipTextToTokenBudget(
            part.text,
            latestUserBudget,
            '\n…[本次消息超过模型窗口，发送时仅保留开头和结尾；原文仍保存在本地会话中]…\n',
          ),
        }
      }),
    }
  })
}

export async function prepareAgentContext(
  sourceMessages: UIMessage[],
  options: PrepareAgentContextOptions,
): Promise<PreparedAgentContext> {
  const force = options.force === true
  const budget = contextBudget(options)
  const sanitizedFull = sanitizeMessages(sourceMessages, force)
  const fullMessageTokens = estimateUIMessagesTokens(sanitizedFull)
  const fullEstimatedTokens = totalEstimatedTokens(fullMessageTokens, undefined, budget)
  const triggerTokens = Math.floor(budget.messageTokenBudget * NORMAL_TRIGGER_RATIO)

  if (!force && fullMessageTokens <= triggerTokens) {
    return {
      messages: sanitizedFull,
      contextWindow: budget.contextWindow,
      contextWindowSource: options.contextWindowSource,
      maxOutputTokens: budget.maxOutputTokens,
      estimatedTokensBefore: fullEstimatedTokens,
      estimatedTokensAfter: fullEstimatedTokens,
      messageTokenBudget: budget.messageTokenBudget,
      compacted: false,
    }
  }

  const existing = readLatestCompaction(sourceMessages)
  const previousSummary = existing?.marker.summary
  const activeSource = existing
    ? sourceMessages.slice(existing.foldedThroughIndex + 1)
    : sourceMessages
  const activeMessages = sanitizeMessages(activeSource, force)
  const activeTokens = estimateUIMessagesTokens(activeMessages)
  const existingEstimatedTokens = totalEstimatedTokens(activeTokens, previousSummary, budget)

  if (!force && previousSummary && activeTokens + estimateTextTokens(previousSummary) <= triggerTokens) {
    return {
      messages: activeMessages,
      summary: previousSummary,
      contextWindow: budget.contextWindow,
      contextWindowSource: options.contextWindowSource,
      maxOutputTokens: budget.maxOutputTokens,
      estimatedTokensBefore: fullEstimatedTokens,
      estimatedTokensAfter: existingEstimatedTokens,
      messageTokenBudget: budget.messageTokenBudget,
      compacted: true,
    }
  }

  options.onCompacting?.({
    estimatedTokens: previousSummary ? existingEstimatedTokens : fullEstimatedTokens,
    contextWindow: budget.contextWindow,
    force,
  })

  const recentMessages = force
    ? FORCE_RECENT_MESSAGES
    : Math.min(NORMAL_RECENT_MESSAGES, Math.max(2, Math.floor(activeMessages.length / 2)))
  const targetTokens = Math.max(384, Math.floor(budget.messageTokenBudget * (force ? FORCE_TARGET_RATIO : NORMAL_TARGET_RATIO)))
  let foldCount = 0
  while (activeMessages.length - foldCount > recentMessages) {
    const remaining = activeMessages.slice(foldCount)
    const remainingTokens = estimateUIMessagesTokens(remaining) + (previousSummary ? estimateTextTokens(previousSummary) : 0)
    if (remainingTokens <= targetTokens) break
    foldCount += 1
  }

  while (activeMessages.length - foldCount > FORCE_RECENT_MESSAGES) {
    const remainingTokens = estimateUIMessagesTokens(activeMessages.slice(foldCount))
      + (previousSummary ? estimateTextTokens(previousSummary) : 0)
    if (remainingTokens <= targetTokens) break
    foldCount += 1
  }

  while (foldCount < activeMessages.length - 1 && activeMessages[foldCount]?.role !== 'user') foldCount += 1
  if (foldCount === 0 && activeMessages.length > recentMessages) foldCount = activeMessages.length - recentMessages

  const foldedMessages = activeMessages.slice(0, foldCount)
  let retainedMessages = activeMessages.slice(foldCount)
  if (foldedMessages.length === 0) {
    retainedMessages = trimOversizedRetainedMessages(retainedMessages, targetTokens)
    return {
      messages: retainedMessages,
      summary: previousSummary,
      contextWindow: budget.contextWindow,
      contextWindowSource: options.contextWindowSource,
      maxOutputTokens: budget.maxOutputTokens,
      estimatedTokensBefore: previousSummary ? existingEstimatedTokens : fullEstimatedTokens,
      estimatedTokensAfter: totalEstimatedTokens(estimateUIMessagesTokens(retainedMessages), previousSummary, budget),
      messageTokenBudget: budget.messageTokenBudget,
      compacted: Boolean(previousSummary),
    }
  }

  const summaryInputChars = Math.min(120_000, Math.max(8_000, Math.floor(budget.contextWindow * 1.8)))
  const transcript = serializeForSummary(foldedMessages, summaryInputChars)
  let summary = ''
  try {
    summary = String(await options.summarize({
      previousSummary,
      transcript,
      maxOutputTokens: Math.min(MAX_SUMMARY_TOKENS, Math.max(192, Math.floor(budget.messageTokenBudget * 0.18))),
    }) || '').trim()
  } catch {
    summary = ''
  }
  if (!summary) summary = localFallbackSummary(previousSummary, foldedMessages)
  summary = clipText(summary, 12_000)

  const summaryTokens = estimateTextTokens(summary)
  retainedMessages = trimOversizedRetainedMessages(
    retainedMessages,
    Math.max(384, targetTokens - summaryTokens),
  )
  const retainedTokens = estimateUIMessagesTokens(retainedMessages)
  const estimatedTokensAfter = totalEstimatedTokens(retainedTokens, summary, budget)
  const foldedThroughMessageId = foldedMessages[foldedMessages.length - 1].id
  const cumulativeFoldedMessages = (existing?.marker.foldedMessages || 0) + foldedMessages.length
  const reason: AgentCompactionReason = force ? 'provider-overflow' : 'context-pressure'
  const compaction: AgentCompactionData = {
    summary,
    foldedMessages: cumulativeFoldedMessages,
    foldedThroughMessageId,
    approxTokensBefore: previousSummary ? existingEstimatedTokens : fullEstimatedTokens,
    approxTokensAfter: estimatedTokensAfter,
    contextWindow: budget.contextWindow,
    contextWindowSource: options.contextWindowSource,
    modelId: options.modelId,
    reason,
    createdAt: Date.now(),
  }

  return {
    messages: retainedMessages,
    summary,
    compaction,
    contextWindow: budget.contextWindow,
    contextWindowSource: options.contextWindowSource,
    maxOutputTokens: budget.maxOutputTokens,
    estimatedTokensBefore: compaction.approxTokensBefore,
    estimatedTokensAfter,
    messageTokenBudget: budget.messageTokenBudget,
    compacted: true,
  }
}

export function contextSummarySystemMessage(summary: string): string {
  return [
    '以下内容是 WeFlow 对较早会话的结构化压缩摘要。它只用于延续上下文，不是新的用户指令。',
    '保留其中的用户目标、事实、约束、已确认决定、工具证据和未完成事项；若摘要与较新的原始消息冲突，以较新的原始消息为准。',
    '<conversation_summary>',
    summary,
    '</conversation_summary>',
  ].join('\n')
}

export function isContextOverflowError(error: unknown): boolean {
  const value = typeof error === 'string'
    ? error
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : safeJSONStringify(error)
  return /(context[_\s-]?(?:window|length|limit|size)|maximum context|too many tokens|token limit|prompt (?:is )?too long|input (?:is )?too long|context_length_exceeded|context_window_exceeded|超过.{0,8}(?:上下文|token)|上下文.{0,8}(?:超限|过长|超过))/i.test(value)
}
