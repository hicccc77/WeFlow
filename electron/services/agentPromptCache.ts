import { createHash } from 'crypto'
import type { ProviderOptions, SystemModelMessage } from '@ai-sdk/provider-utils'
import type { ToolSet } from 'ai'

export type AgentPromptParts = {
  cacheableSystem: string
  dynamicSystem: string
}

export type AgentCacheModelConfig = {
  provider?: string
  model?: string
  baseURL?: string
  protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google'
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type AgentProviderCacheStatus = {
  providerKind: NonNullable<AgentCacheModelConfig['protocol']>
  providerName: string
  model: string
  promptCacheKey: string
  promptCacheEnabled: boolean
  promptCacheProvider: 'openai-responses' | 'anthropic' | 'google' | 'openai-compatible' | 'none'
  requestBodyPromptCacheField?: 'prompt_cache_key' | 'promptCacheKey' | 'cache_control' | 'cachedContent'
  promptCacheRetention?: string
  reason?: string
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function modelFamily(model: string): string {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/-(?:19|20)\d{6}(?:-\d+)?$/, '')
    .replace(/-(?:latest|preview)$/, '')
}

function stableToolSignature(tools: ToolSet): string {
  return JSON.stringify(Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({
      name,
      type: item.type || 'function',
      id: 'id' in item ? item.id : undefined,
      args: 'args' in item ? item.args : undefined,
      description: item.description || '',
      title: item.title || '',
      inputSchema: item.inputSchema || null,
      outputSchema: item.outputSchema || null,
    })))
}

export function buildPromptCacheKey(
  config: AgentCacheModelConfig,
  parts: AgentPromptParts,
  tools: ToolSet,
): string {
  const provider = String(config.provider || config.protocol || 'weflow').trim().toLowerCase()
  const providerModel = `${config.protocol || 'openai-compatible'}:${provider}:${modelFamily(String(config.model || ''))}`
  return [
    'wf:agent:v2',
    shortHash(providerModel),
    shortHash(parts.cacheableSystem),
    shortHash(stableToolSignature(tools)),
  ].join(':')
}

export function injectOpenAICompatiblePromptCacheKey(
  args: Record<string, any>,
  promptCacheKey: string | undefined,
): Record<string, any> {
  return promptCacheKey && !args.prompt_cache_key
    ? { ...args, prompt_cache_key: promptCacheKey }
    : args
}

function withAnthropicCacheControl(providerOptions: ProviderOptions | undefined): ProviderOptions {
  return {
    ...(providerOptions || {}),
    anthropic: {
      ...((providerOptions?.anthropic as Record<string, unknown> | undefined) || {}),
      cacheControl: { type: 'ephemeral', ttl: '5m' },
    },
  }
}

export function applyAnthropicCacheControl(
  messages: SystemModelMessage[],
  tools: ToolSet,
): { messages: SystemModelMessage[]; tools: ToolSet } {
  const nextMessages = messages.map((message, index) => index === 0
    ? { ...message, providerOptions: withAnthropicCacheControl(message.providerOptions) }
    : message)
  const entries = Object.entries(tools)
  const lastToolName = entries.at(-1)?.[0]
  const nextTools: ToolSet = {}
  for (const [name, item] of entries) {
    nextTools[name] = name === lastToolName
      ? { ...item, providerOptions: withAnthropicCacheControl(item.providerOptions) } as typeof item
      : item
  }
  return { messages: nextMessages, tools: nextTools }
}

function isDeepSeek(config: AgentCacheModelConfig): boolean {
  return [config.provider, config.baseURL, config.model]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes('deepseek')
}

function isQwen(config: AgentCacheModelConfig): boolean {
  return [config.provider, config.baseURL, config.model]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes('qwen')
}

export function resolveAgentToolChoice(
  config: AgentCacheModelConfig,
  requested: 'auto' | 'required',
): 'auto' | 'required' {
  if (requested !== 'required') return requested
  const thinkingEnabled = Boolean(config.reasoningEffort && config.reasoningEffort !== 'none')
  if (!thinkingEnabled) return 'required'
  if (config.protocol === 'anthropic') return 'auto'
  // DeepSeek 和 Qwen 的思考模式与强制 `tool_choice=required` 兼容性不稳定，
  // 因此降级为 `auto`，仍由提示词约束模型完成所需工具调用。
  if (config.protocol === 'openai-compatible' && (isDeepSeek(config) || isQwen(config))) return 'auto'
  return 'required'
}

export function resolveAgentActiveTools<T extends string>(
  config: AgentCacheModelConfig,
  preferred: readonly T[],
  available: readonly T[],
): T[] {
  return resolveAgentToolChoice(config, 'required') === 'auto'
    ? [...available]
    : [...preferred]
}

export function buildProviderCacheStatus(
  config: AgentCacheModelConfig,
  promptCacheKey: string,
): AgentProviderCacheStatus {
  const protocol = config.protocol || 'openai-compatible'
  const base = {
    providerKind: protocol,
    providerName: String(config.provider || 'weflow'),
    model: String(config.model || ''),
    promptCacheKey,
  }
  if (protocol === 'openai-responses') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'openai-responses',
      requestBodyPromptCacheField: 'promptCacheKey',
      reason: '已按稳定 system、工具签名、provider 和模型族生成缓存 key。',
    }
  }
  if (protocol === 'anthropic') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'anthropic',
      requestBodyPromptCacheField: 'cache_control',
      promptCacheRetention: '5m',
      reason: '稳定 system 与工具前缀已添加 ephemeral cache_control 断点。',
    }
  }
  if (protocol === 'google') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'google',
      requestBodyPromptCacheField: 'cachedContent',
      promptCacheRetention: '1h',
      reason: '自动创建并复用包含稳定 system 与工具声明的 cachedContent；前缀过短或创建失败时直接请求模型。',
    }
  }
  return {
    ...base,
    promptCacheEnabled: true,
    promptCacheProvider: 'openai-compatible',
    requestBodyPromptCacheField: 'prompt_cache_key',
    reason: isDeepSeek(config)
      ? 'DeepSeek 上下文缓存默认开启；已保持稳定前缀并读取 prompt_cache_hit_tokens / prompt_cache_miss_tokens。'
      : '已注入 prompt_cache_key；实际命中取决于兼容端点是否支持并回传缓存 token。',
  }
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export function normalizeProviderUsage(usage: unknown): unknown {
  if (!usage || typeof usage !== 'object') return usage
  const source = usage as Record<string, unknown>
  const inputTokens = finiteNumber(source.inputTokens)
  const details = source.inputTokenDetails && typeof source.inputTokenDetails === 'object'
    ? { ...source.inputTokenDetails as Record<string, unknown> }
    : {}
  const cacheReadTokens = finiteNumber(details.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(details.cacheWriteTokens)
  const noCacheTokens = finiteNumber(details.noCacheTokens)
    ?? (inputTokens !== undefined && cacheReadTokens !== undefined
      ? Math.max(0, inputTokens - cacheReadTokens - (cacheWriteTokens || 0))
      : undefined)
  if (noCacheTokens !== undefined) details.noCacheTokens = noCacheTokens
  return {
    ...source,
    inputTokenDetails: details,
    ...(inputTokens !== undefined && inputTokens > 0 && cacheReadTokens !== undefined
      ? { cacheHitRate: cacheReadTokens / inputTokens }
      : {}),
  }
}
