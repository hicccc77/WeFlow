/**
 * AI 模型信息
 */
export interface AIModelInfo {
  id: string
  name: string
  providerId: string
  family?: string
  modalities: {
    input: string[]
    output: string[]
  }
  capabilities: {
    attachment: boolean
    reasoning: boolean
    toolCall: boolean
    structuredOutput: boolean
    temperature: boolean
    openWeights: boolean
  }
  limits: {
    context?: number
    input?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    inputAudio?: number
    outputAudio?: number
    reasoning?: number
    tiers?: unknown[]
    contextOver200k?: unknown
  }
  status?: string
  knowledge?: string
  releaseDate?: string
  lastUpdated?: string
  interleaved?: {
    field?: string
  }
  provider?: {
    npm?: string
    api?: string
    shape?: string
  }
}

export type AIProviderProtocol = 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google'
export type AIProviderType = 'recommended-service' | 'third-party-relay' | 'model-provider' | 'custom'

export interface AIModelMetadataResolution {
  success: boolean
  requestedProvider: string
  requestedModel: string
  matchedProviderId?: string
  matchedModelId?: string
  canonicalModelId?: string
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  canonicalContextWindow?: number
  providerOverride?: boolean
  source?: 'models.dev-provider' | 'models.dev-model'
  checkedAt?: number
  lastUpdated?: string
  stale?: boolean
  error?: string
}

/**
 * AI 提供商信息
 */
export interface AIProviderInfo {
  id: string
  name: string
  displayName: string
  description: string
  baseURL?: string
  models: string[]
  modelDetails?: AIModelInfo[]
  pricing: string
  pricingDetail: {
    input: number
    output: number
  }
  website?: string
  logo?: string
  protocol?: AIProviderProtocol
  protocolOptions?: AIProviderProtocol[]
  allowCustomBaseURL?: boolean
  optionalApiKey?: boolean
  providerType?: AIProviderType
  recommended?: boolean
}

/**
 * 获取所有 AI 提供商（从后端获取）
 */
export async function getAIProviders(): Promise<AIProviderInfo[]> {
  try {
    return await window.electronAPI.ai.getProviders()
  } catch (e) {
    console.error('获取 AI 提供商列表失败:', e)
    return []
  }
}
