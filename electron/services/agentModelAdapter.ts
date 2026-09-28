import { net } from 'electron'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createOpenAICompatibleFetch } from './openAICompatibleFetch'
import { withGoogleExplicitCache } from './googleCacheFetch'
import { injectOpenAICompatiblePromptCacheKey } from './agentPromptCache'
import { withAgentModelStreamSafety } from './agentModelSafety'
import type { AgentModelConfig } from './agentService'

function normalizeBaseURL(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}
function electronAwareFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): ReturnType<typeof globalThis.fetch> {
  if (typeof net?.fetch === 'function') {
    return net.fetch(input instanceof URL ? input.toString() : input, init)
  }
  return globalThis.fetch(input, init)
}

function electronAwareFetchWithProviderStatus(
  onProviderEvent?: (type: string, data: Record<string, unknown>) => void,
) {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): ReturnType<typeof globalThis.fetch> => {
    const response = await electronAwareFetch(input, init)
    if (response.ok) return response

  // 某些兼容 Responses 的网关会返回有用的非 2xx JSON 错误，
  // 但 SDK 随后可能只将其暴露为通用的空流。这里只保留状态码和长度受限的
  // 供应商错误字段，让重试分类能够区分上游/网络故障与模型正常作出的空决策。
    let providerDetail = ''
    try {
      const body = await response.clone().text()
      const parsed = JSON.parse(body) as {
        error?: { type?: unknown; code?: unknown; message?: unknown } | unknown
        type?: unknown
        code?: unknown
        message?: unknown
      }
      const nested = parsed.error && typeof parsed.error === 'object'
        ? parsed.error as { type?: unknown; code?: unknown; message?: unknown }
        : null
      providerDetail = [
        nested?.type ?? parsed.type,
        nested?.code ?? parsed.code,
        nested?.message ?? parsed.message,
      ].map((value) => String(value || '').trim()).filter(Boolean).join(' ')
    } catch {
      // 仅凭状态码就足以完成重试分类。
    }
    const boundedDetail = providerDetail.slice(0, 400)
    onProviderEvent?.('provider_http_error', {
      statusCode: response.status,
      detail: boundedDetail,
    })
    const error = new Error(`HTTP ${response.status}${boundedDetail ? ` ${boundedDetail}` : ''}`)
    ;(error as Error & { statusCode?: number }).statusCode = response.status
    throw error
  }
}

/**
 * 根据协议创建统一的模型适配器，并复用 Electron 网络栈、供应商缓存和超时诊断。
 * 调用方只接收标准 `LanguageModel`，无需感知各供应商的传输差异。
 */
export function createAgentModel(
  config: AgentModelConfig,
  promptCacheKey?: string,
  onProviderEvent?: (type: string, data: Record<string, unknown>) => void,
): LanguageModel {
  const configuredApiKey = String(config.apiKey || '').trim()
  const apiKey = configuredApiKey || (config.provider === 'ollama' ? 'ollama' : '')
  const model = String(config.model || '').trim()
  const baseURL = normalizeBaseURL(String(config.baseURL || ''))
  if (!apiKey) throw new Error('请先在设置中填写 AI API Key')
  if (!model) throw new Error('请先在设置中选择 AI 模型')
  if (!baseURL) throw new Error('请先在设置中填写 AI Base URL')

  if (config.protocol === 'anthropic') {
    return withAgentModelStreamSafety(
      createAnthropic({ apiKey, baseURL, fetch: electronAwareFetch })(model),
      onProviderEvent,
    )
  }
  if (config.protocol === 'google') {
    return withAgentModelStreamSafety(
      createGoogleGenerativeAI({ apiKey, baseURL, fetch: withGoogleExplicitCache(electronAwareFetch) })(model),
      onProviderEvent,
    )
  }
  if (config.protocol === 'openai-responses') {
    return withAgentModelStreamSafety(
      createOpenAI({ apiKey, baseURL, fetch: electronAwareFetchWithProviderStatus(onProviderEvent) }).responses(model),
      onProviderEvent,
    )
  }
  return withAgentModelStreamSafety(
    createOpenAICompatible({
      name: config.provider || 'weflow',
      apiKey,
      baseURL,
      includeUsage: true,
      fetch: createOpenAICompatibleFetch(electronAwareFetch, {
        // 深度 Agent 请求可能在供应商发送首字节前推理数分钟。让传输校验与
        // Agent 的无活动策略保持一致，避免把正常的高强度推理请求误判为网络故障，
        // 并携带同一份大输入重新发送。
        idleTimeoutMs: 10 * 60_000,
        maxDurationMs: 30 * 60_000,
        onEvent: (event) => onProviderEvent?.(event.type, event.data),
      }),
      transformRequestBody: (args) => injectOpenAICompatiblePromptCacheKey(args, promptCacheKey),
    }).chatModel(model),
    onProviderEvent,
  )
}
