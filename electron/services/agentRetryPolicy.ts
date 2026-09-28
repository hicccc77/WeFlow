function transportErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>
    const nested = source.error && typeof source.error === 'object'
      ? source.error as Record<string, unknown>
      : null
    return [
      source.type,
      source.code,
      source.message,
      nested?.type,
      nested?.code,
      nested?.message,
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ')
  }
  return String(error || '')
}

export const AGENT_NETWORK_RETRY_LIMIT = 5
const AGENT_PROVIDER_POOL_RETRY_LIMIT = 2

export function isAgentProviderPoolExhaustedError(error: unknown): boolean {
  return /all available accounts? exhausted|no available accounts?|available accounts? (?:are )?exhausted|account pool (?:is )?exhausted|上游账[号户].{0,8}(?:耗尽|不可用)|没有可用.{0,6}上游账户|所有.{0,8}账[号户].{0,8}(?:耗尽|不可用)/i
    .test(transportErrorMessage(error))
}

export function agentTransportRetryLimit(error: unknown): number {
  return isAgentProviderPoolExhaustedError(error)
    ? AGENT_PROVIDER_POOL_RETRY_LIMIT
    : AGENT_NETWORK_RETRY_LIMIT
}

export class AgentNetworkRetryExhaustedError extends Error {
  readonly code = 'AGENT_NETWORK_ERROR'
  readonly retryCount: number
  readonly lastError: Error

  constructor(error: unknown, retryCount = AGENT_NETWORK_RETRY_LIMIT) {
    const lastError = error instanceof Error ? error : new Error(transportErrorMessage(error) || '网络连接失败')
    const normalizedRetryCount = Math.max(1, Math.floor(retryCount) || AGENT_NETWORK_RETRY_LIMIT)
    super(isAgentProviderPoolExhaustedError(lastError)
      ? `模型供应商当前没有可用的上游账户。已间隔等待并重试 ${normalizedRetryCount} 次；已经取得的工具结果仍会保留，可在供应商恢复后继续回答。请检查 RelayOne 账户池、额度或冷却状态。`
      : `网络连接连续 ${normalizedRetryCount} 次重试仍未恢复。本次任务已停止，未使用未完成的调查材料生成回答。请检查网络或模型服务后重试。最后错误：${lastError.message}`)
    this.name = 'AgentNetworkRetryExhaustedError'
    this.retryCount = normalizedRetryCount
    this.lastError = lastError
  }
}

export class AgentModelRetryExhaustedError extends Error {
  readonly code = 'AGENT_MODEL_RETRY_EXHAUSTED'
  readonly retryCount: number
  readonly lastError: Error

  constructor(error: unknown, retryCount = AGENT_NETWORK_RETRY_LIMIT) {
    const lastError = error instanceof Error ? error : new Error(transportErrorMessage(error) || '模型调用未完成')
    const normalizedRetryCount = Math.max(1, Math.floor(retryCount) || AGENT_NETWORK_RETRY_LIMIT)
    super(`模型调用连续 ${normalizedRetryCount} 次重试仍未完成。本次任务已停止，未交付不完整回答。最后错误：${lastError.message}`)
    this.name = 'AgentModelRetryExhaustedError'
    this.retryCount = normalizedRetryCount
    this.lastError = lastError
  }
}

export function isAgentNetworkRetryExhaustedError(error: unknown): error is AgentNetworkRetryExhaustedError {
  return error instanceof AgentNetworkRetryExhaustedError
    || String((error as { code?: unknown } | null)?.code || '') === 'AGENT_NETWORK_ERROR'
}

export function isAgentRetryExhaustedError(error: unknown): error is AgentNetworkRetryExhaustedError | AgentModelRetryExhaustedError {
  const code = String((error as { code?: unknown } | null)?.code || '')
  return isAgentNetworkRetryExhaustedError(error) || code === 'AGENT_MODEL_RETRY_EXHAUSTED'
}

export function isAgentConcurrencyLimitError(error: unknown): boolean {
  return isAgentProviderPoolExhaustedError(error)
    || /concurrenc(?:y|ies)(?: limit)?(?: exceeded| reached)?|too many (?:concurrent )?requests|rate[ -]?limit|HTTP\s*429|status(?:Code)?["':=\s]+429|resource[_ -]?exhausted|overloaded|quota(?: limit)? exceeded|请求过于频繁|并发.{0,8}(?:限制|超限|已满)/i
    .test(transportErrorMessage(error))
}

export function isAgentNetworkError(error: unknown): boolean {
  const status = Number((error as { statusCode?: unknown; status?: unknown } | null)?.statusCode
    ?? (error as { status?: unknown } | null)?.status)
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true
  const message = transportErrorMessage(error)
  return isAgentConcurrencyLimitError(error)
    || /(?:step|chunk|tool|provider request) timeout(?: of \d+ms)? exceeded|operation was aborted due to timeout|upstream(?:[_ -](?:request )?)?(?:failed|error)|stream[_ -]?(?:read[_ -]?)?error|cannot close an errored readable stream|failed to execute ['"]close['"] on ['"]ReadableStreamDefaultController['"]|fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|terminated|premature close|connection closed|service unavailable|temporarily unavailable/i.test(message)
}

export function isRetryableAgentTransportError(error: unknown): boolean {
  if (isAgentNetworkError(error)) return true
  const message = transportErrorMessage(error)
  return /no output generated|incomplete output generated|最终回答在完整句子结束前中断|AI_RetryError|maxRetriesExceeded|made no progress|hard deadline|invalid JSON response|AI_InvalidToolInputError|AI_TypeValidationError|invalid input for tool/i.test(message)
}

export function agentTransportRetryDelayMs(error: unknown, attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(AGENT_NETWORK_RETRY_LIMIT, Math.floor(attempt) || 1))
  const regularDelays = [2_000, 5_000, 10_000, 20_000, 40_000]
  const busyServiceDelays = [5_000, 10_000, 20_000, 40_000, 60_000]
  return (isAgentConcurrencyLimitError(error) ? busyServiceDelays : regularDelays)[boundedAttempt - 1]
}

export async function waitForAgentTransportRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const error = new Error('已停止')
    error.name = 'AbortError'
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, Math.max(0, Math.floor(delayMs)))
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const error = new Error('已停止')
      error.name = 'AbortError'
      reject(error)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
