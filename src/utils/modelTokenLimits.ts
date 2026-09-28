export const DEFAULT_AGENT_CONTEXT_WINDOW = 32_768
export const MIN_AGENT_CONTEXT_WINDOW = 4_096
export const MAX_AGENT_CONTEXT_WINDOW = 4_000_000

export type AgentContextWindowSource = 'manual' | 'catalog' | 'inferred' | 'default'

export type ResolvedAgentContextWindow = {
  contextWindow: number
  source: AgentContextWindowSource
}

export function normalizeAgentContextWindow(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < MIN_AGENT_CONTEXT_WINDOW) return undefined
  return Math.min(MAX_AGENT_CONTEXT_WINDOW, Math.floor(parsed))
}

export function inferModelContextWindow(modelId: string): number | undefined {
  const model = String(modelId || '').trim().toLowerCase()
  if (!model) return undefined

  const leaf = model.replace(/^models\//i, '').split('/').pop() || model

  if (/(?:^|[/_-])claude(?:-|_|$)/.test(model)) return 200_000
  if (/^gemini-pro(?:$|-)/.test(leaf)) return 32_768
  if (/(?:^|[/_-])gemini(?:-|_|$)/.test(model)) return 128_000
  if (/(?:^|[/_-])grok(?:-|_|$)/.test(model)) return 256_000
  if (/(?:^|[/_-])kimi(?:-|_|$)|moonshot/.test(model)) return 256_000
  if (/minimax/.test(model)) return 200_000
  if (/deepseek/.test(model)) return 128_000
  if (/(?:^|[/_-])qwen(?:-|_|$)/.test(model)) return 128_000
  if (/(?:^|[/_-])glm(?:-|_|$)|zhipu/.test(model)) return 128_000
  if (/(?:^|[/_-])llama(?:-|_|$)|mistral|mixtral/.test(model)) return 128_000
  if (/^gpt-3\.5/.test(leaf)) return 16_385
  if (/^gpt-4-32k(?:$|-)/.test(leaf)) return 32_768
  if (/^gpt-4(?:$|-(?:0314|0613)$)/.test(leaf)) return 8_192
  if (/^gpt-4(?:o|-turbo)/.test(leaf)) return 128_000
  if (/^gpt-5|^o[134](?:-|$)/.test(leaf)) return 128_000

  return undefined
}

export function catalogModelContextWindow(limits: {
  context?: unknown
  input?: unknown
} | null | undefined): number | undefined {
  // `context` is the combined window. `input` is a separate prompt cap and
  // must not replace a larger context value (for example 272K input + 128K
  // output inside a 400K context window).
  return normalizeAgentContextWindow(limits?.context)
    ?? normalizeAgentContextWindow(limits?.input)
}

export function resolveAgentContextWindow(options: {
  manual?: unknown
  catalog?: unknown
  modelId?: string
}): ResolvedAgentContextWindow {
  const manual = normalizeAgentContextWindow(options.manual)
  if (manual) return { contextWindow: manual, source: 'manual' }

  const catalog = normalizeAgentContextWindow(options.catalog)
  if (catalog) return { contextWindow: catalog, source: 'catalog' }

  const inferred = inferModelContextWindow(String(options.modelId || ''))
  if (inferred) return { contextWindow: inferred, source: 'inferred' }

  return { contextWindow: DEFAULT_AGENT_CONTEXT_WINDOW, source: 'default' }
}

export function resolveAgentMaxOutputTokens(value: unknown, contextWindow: number): number {
  const requested = Number(value)
  const fallback = 1_024
  const normalized = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback
  const safeMaximum = Math.max(256, Math.floor(contextWindow * 0.25))
  return Math.max(1, Math.min(normalized, safeMaximum))
}

export function formatAgentContextWindow(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '未知'
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`
  }
  return Math.round(value).toLocaleString('zh-CN')
}
