import { net } from 'electron'

type AIProviderProtocol = 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google'
type AIProviderType = 'recommended-service' | 'third-party-relay' | 'model-provider' | 'custom'

export interface AIProviderCatalogEntry {
  id: string
  name: string
  displayName: string
  description: string
  baseURL?: string
  models: string[]
  modelDetails?: Array<{
    id: string
    name: string
    providerId: string
    family?: string
    modalities: { input: string[]; output: string[] }
    capabilities: {
      attachment: boolean
      reasoning: boolean
      toolCall: boolean
      structuredOutput: boolean
      temperature: boolean
      openWeights: boolean
    }
    limits: { context?: number; input?: number; output?: number }
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    status?: string
    knowledge?: string
    releaseDate?: string
    lastUpdated?: string
  }>
  pricing: string
  pricingDetail: { input: number; output: number }
  website?: string
  logo?: string
  protocol: AIProviderProtocol
  protocolOptions?: AIProviderProtocol[]
  allowCustomBaseURL?: boolean
  optionalApiKey?: boolean
  providerType?: AIProviderType
  recommended?: boolean
}

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

type ModelsDevProvider = {
  id?: string
  name?: string
  npm?: string
  api?: string
  doc?: string
  models?: Record<string, Record<string, unknown>>
}

const MODELS_DEV_URL = 'https://models.dev'
const MODELS_DEV_CATALOG_URL = `${MODELS_DEV_URL}/catalog.json`
const NON_CHAT_MODEL_MARKERS = [
  'embedding',
  'rerank',
  'whisper',
  'tts',
  'transcribe',
  'speech',
  'moderation',
  'dall-e',
  'image',
]

const EMPTY_PRICING = { pricing: '由模型服务商决定', pricingDetail: { input: 0, output: 0 } }
const POPULAR_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'alibaba-cn',
  'moonshotai-cn',
  'zhipuai',
  'minimax',
  'siliconflow-cn',
  'xai',
  'openrouter',
  'ollama',
]
const POPULAR_PROVIDER_RANK = new Map(POPULAR_PROVIDER_IDS.map((id, index) => [id, index]))

const CUSTOM_PROVIDER: AIProviderCatalogEntry = {
  id: 'custom',
  name: 'custom',
  displayName: '自定义兼容服务',
  description: '填写基础地址并从服务端读取模型',
  baseURL: '',
  models: [],
  modelDetails: [],
  ...EMPTY_PRICING,
  protocol: 'openai-compatible',
  protocolOptions: ['openai-compatible', 'openai-responses', 'anthropic', 'google'],
  allowCustomBaseURL: true,
  providerType: 'custom',
}

const FALLBACK_PROVIDERS: AIProviderCatalogEntry[] = [
  {
    id: 'openai', name: 'openai', displayName: 'OpenAI', description: 'OpenAI Responses API',
    baseURL: 'https://api.openai.com/v1', protocol: 'openai-responses', allowCustomBaseURL: true,
    models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-chat-latest', 'gpt-5.2'],
    ...EMPTY_PRICING,
  },
  {
    id: 'anthropic', name: 'anthropic', displayName: 'Anthropic', description: 'Claude API',
    baseURL: 'https://api.anthropic.com/v1', protocol: 'anthropic', allowCustomBaseURL: true,
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-haiku-4-5'],
    ...EMPTY_PRICING,
  },
  {
    id: 'google', name: 'google', displayName: 'Google Gemini', description: 'Google Generative AI',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'google', allowCustomBaseURL: true,
    models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    ...EMPTY_PRICING,
  },
  {
    id: 'deepseek', name: 'deepseek', displayName: 'DeepSeek', description: 'DeepSeek API',
    baseURL: 'https://api.deepseek.com', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-reasoner', 'deepseek-chat'],
    ...EMPTY_PRICING,
  },
  {
    id: 'xai', name: 'xai', displayName: 'xAI', description: 'Grok API',
    baseURL: 'https://api.x.ai/v1', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-4.20-multi-agent-0309'],
    ...EMPTY_PRICING,
  },
  {
    id: 'alibaba-cn', name: 'alibaba-cn', displayName: '阿里云百炼', description: 'DashScope 兼容接口',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['qwen3.7-max', 'qwen3.6-max-preview', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash'],
    ...EMPTY_PRICING,
  },
  {
    id: 'moonshotai-cn', name: 'moonshotai-cn', displayName: 'Moonshot AI（中国）', description: 'Kimi API',
    baseURL: 'https://api.moonshot.cn/v1', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking-turbo', 'kimi-k2-thinking'],
    ...EMPTY_PRICING,
  },
  {
    id: 'zhipuai', name: 'zhipuai', displayName: '智谱 AI', description: 'GLM API',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6'],
    ...EMPTY_PRICING,
  },
  {
    id: 'minimax', name: 'minimax', displayName: 'MiniMax', description: 'MiniMax Anthropic 兼容接口',
    baseURL: 'https://api.minimax.io/anthropic/v1', protocol: 'anthropic', allowCustomBaseURL: true,
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.1'],
    ...EMPTY_PRICING,
  },
  {
    id: 'siliconflow-cn', name: 'siliconflow-cn', displayName: '硅基流动', description: 'SiliconFlow API',
    baseURL: 'https://api.siliconflow.cn/v1', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['deepseek-ai/DeepSeek-V4-Pro', 'Pro/moonshotai/Kimi-K2.6', 'Qwen/Qwen3.6-35B-A3B', 'Pro/zai-org/GLM-5.1'],
    ...EMPTY_PRICING,
  },
  {
    id: 'openrouter', name: 'openrouter', displayName: 'OpenRouter', description: '聚合模型服务',
    baseURL: 'https://openrouter.ai/api/v1', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: ['anthropic/claude-opus-4.8', 'google/gemini-3.5-flash', 'qwen/qwen3.7-max', 'openai/gpt-5.4'],
    ...EMPTY_PRICING,
  },
  {
    id: 'ollama', name: 'ollama', displayName: 'Ollama', description: '本地 Ollama 服务',
    baseURL: 'http://localhost:11434/v1', protocol: 'openai-compatible', allowCustomBaseURL: true, optionalApiKey: true,
    models: [],
    ...EMPTY_PRICING,
  },
  {
    id: 'relayone', name: 'relayone', displayName: 'RelayOne', description: 'WeFlow 快速接入 · 注册、余额与充值',
    baseURL: 'https://aiapi.aiqji.cn/v1', protocol: 'openai-compatible', allowCustomBaseURL: false,
    models: [],
    website: 'https://aiapi.aiqji.cn',
    providerType: 'recommended-service',
    recommended: true,
    ...EMPTY_PRICING,
  },
  {
    id: 'tianjige', name: 'tianjige', displayName: '天机阁', description: '三方中转 · OpenAI Compatible',
    baseURL: 'https://yujianwudi.top/v1', protocol: 'openai-compatible', allowCustomBaseURL: true,
    models: [],
    website: 'https://yujianwudi.top/sign-up?aff=crW7',
    providerType: 'third-party-relay',
    ...EMPTY_PRICING,
  },
]

const FALLBACK_BY_ID = new Map(FALLBACK_PROVIDERS.map((provider) => [provider.id, provider]))
type ModelsDevCatalogSnapshot = {
  timestamp: number
  providers: AIProviderCatalogEntry[]
  rawProviders: Record<string, ModelsDevProvider>
  canonicalModels: Record<string, Record<string, unknown>>
}

let catalogCache: ModelsDevCatalogSnapshot | null = null
let catalogRequest: Promise<ModelsDevCatalogSnapshot> | null = null
let catalogLoadError: Error | null = null
const modelMetadataCache = new Map<string, AIModelMetadataResolution>()
/**
 * Electron's Node/undici TLS path can be reset by some domestic network routes
 * before the handshake completes, while Chromium's network service succeeds.
 * This catalog runs in the Electron main process, so prefer net.fetch there;
 * retain the standard fetch fallback for tests and non-Electron execution.
 */
function fetchFromElectronMain(input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): ReturnType<typeof globalThis.fetch> {
  if (typeof net?.fetch === 'function') return net.fetch(input instanceof URL ? input.toString() : input, init)
  return globalThis.fetch(input, init)
}

function compareModelProviders(left: AIProviderCatalogEntry, right: AIProviderCatalogEntry): number {
  const leftRank = POPULAR_PROVIDER_RANK.get(left.id) ?? Number.MAX_SAFE_INTEGER
  const rightRank = POPULAR_PROVIDER_RANK.get(right.id) ?? Number.MAX_SAFE_INTEGER
  return leftRank - rightRank
    || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN', { numeric: true })
}

function orderProviderCatalog(providers: AIProviderCatalogEntry[]): AIProviderCatalogEntry[] {
  const recommendedProviders = providers
    .filter((provider) => provider.providerType === 'recommended-service')
    .sort((left, right) => Number(right.recommended) - Number(left.recommended)
      || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN', { numeric: true }))
  const relayProviders = providers
    .filter((provider) => provider.providerType === 'third-party-relay')
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-Hans-CN', { numeric: true }))
  const modelProviders = providers
    .filter((provider) => provider.providerType !== 'recommended-service'
      && provider.providerType !== 'third-party-relay'
      && provider.providerType !== 'custom'
      && provider.id !== 'custom')
    .sort(compareModelProviders)
  const customProviders = providers.filter((provider) => provider.providerType === 'custom' || provider.id === 'custom')
  return [...recommendedProviders, ...relayProviders, ...modelProviders, ...customProviders]
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function inferProtocol(provider: ModelsDevProvider): AIProviderProtocol | null {
  const packageName = String(provider.npm || '')
  if (packageName === '@ai-sdk/openai') return 'openai-responses'
  if (packageName === '@ai-sdk/anthropic') return 'anthropic'
  if (packageName === '@ai-sdk/google') return 'google'
  if (packageName === '@ai-sdk/openai-compatible' || packageName === '@ai-sdk/xai' || packageName === '@openrouter/ai-sdk-provider') {
    return 'openai-compatible'
  }
  return null
}

function isTextChatModel(model: Record<string, unknown>): boolean {
  const id = String(model.id || model.name || '').toLowerCase()
  const modalities = model.modalities as { input?: unknown; output?: unknown } | undefined
  const input = Array.isArray(modalities?.input) ? modalities.input.map(String) : []
  const output = Array.isArray(modalities?.output) ? modalities.output.map(String) : []
  if (input.length > 0 && !input.includes('text')) return false
  if (output.length > 0 && !output.includes('text')) return false
  return !NON_CHAT_MODEL_MARKERS.some((marker) => id.includes(marker))
}

function toModelDetails(providerId: string, provider: ModelsDevProvider) {
  return Object.values(provider.models || {})
    .filter(isTextChatModel)
    .sort((left, right) => {
      const leftDate = String(left.last_updated || left.release_date || '')
      const rightDate = String(right.last_updated || right.release_date || '')
      return rightDate.localeCompare(leftDate) || String(left.name || left.id || '').localeCompare(String(right.name || right.id || ''), 'en', { numeric: true })
    })
    .map((model) => {
      const modalities = model.modalities as { input?: unknown; output?: unknown } | undefined
      const limit = model.limit as Record<string, unknown> | undefined
      const cost = model.cost as Record<string, unknown> | undefined
      return {
        id: String(model.id || model.name || '').replace(/^models\//, ''),
        name: String(model.name || model.id || ''),
        providerId,
        family: model.family ? String(model.family) : undefined,
        modalities: {
          input: Array.isArray(modalities?.input) ? modalities.input.map(String) : ['text'],
          output: Array.isArray(modalities?.output) ? modalities.output.map(String) : ['text'],
        },
        capabilities: {
          attachment: Boolean(model.attachment),
          reasoning: Boolean(model.reasoning),
          toolCall: Boolean(model.tool_call),
          structuredOutput: Boolean(model.structured_output),
          temperature: model.temperature !== false,
          openWeights: Boolean(model.open_weights),
        },
        limits: {
          context: optionalNumber(limit?.context),
          input: optionalNumber(limit?.input),
          output: optionalNumber(limit?.output),
        },
        cost: cost ? {
          input: optionalNumber(cost.input),
          output: optionalNumber(cost.output),
          cacheRead: optionalNumber(cost.cache_read),
          cacheWrite: optionalNumber(cost.cache_write),
        } : undefined,
        status: model.status ? String(model.status) : undefined,
        knowledge: model.knowledge ? String(model.knowledge) : undefined,
        releaseDate: model.release_date ? String(model.release_date) : undefined,
        lastUpdated: model.last_updated ? String(model.last_updated) : undefined,
      }
    })
    .filter((model) => Boolean(model.id))
}

function providerBaseURL(providerId: string, provider: ModelsDevProvider): string {
  const direct = String(provider.api || '').trim().replace(/\/+$/, '')
  if (direct) return direct
  return FALLBACK_BY_ID.get(providerId)?.baseURL || ''
}

function parseModelsDevCatalog(payload: unknown): AIProviderCatalogEntry[] {
  const source = payload && typeof payload === 'object' && 'providers' in payload
    ? (payload as { providers?: unknown }).providers
    : payload
  if (!source || typeof source !== 'object' || Array.isArray(source)) return []

  const providers = Object.entries(source as Record<string, ModelsDevProvider>)
    .map(([providerId, provider]): AIProviderCatalogEntry | null => {
      const protocol = inferProtocol(provider)
      if (!protocol) return null
      const baseURL = providerBaseURL(providerId, provider)
      if (!baseURL) return null
      const modelDetails = toModelDetails(providerId, provider)
      return {
        id: providerId,
        name: providerId,
        displayName: String(provider.name || providerId),
        description: [protocol, provider.npm].filter(Boolean).join(' · '),
        baseURL,
        models: modelDetails.map((model) => model.id),
        modelDetails,
        ...EMPTY_PRICING,
        website: provider.doc,
        logo: `${MODELS_DEV_URL}/logos/${providerId}.svg`,
        protocol,
        allowCustomBaseURL: true,
        optionalApiKey: providerId === 'ollama',
        providerType: 'model-provider',
      }
    })
    .filter((provider): provider is AIProviderCatalogEntry => Boolean(provider))

  const onlineById = new Map(providers.map((provider) => [provider.id, provider]))
  for (const fallback of FALLBACK_PROVIDERS) {
    const online = onlineById.get(fallback.id)
    onlineById.set(fallback.id, online ? {
      ...fallback,
      ...online,
      models: online.models.length > 0 ? online.models : fallback.models,
      modelDetails: online.modelDetails?.length ? online.modelDetails : fallback.modelDetails,
      providerType: fallback.providerType || online.providerType || 'model-provider',
    } : fallback)
  }

  return orderProviderCatalog([CUSTOM_PROVIDER, ...Array.from(onlineById.values())])
}

function modelsDevPayloadSection<T>(payload: unknown, key: 'providers' | 'models'): Record<string, T> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const section = (payload as Record<string, unknown>)[key]
  if (!section || typeof section !== 'object' || Array.isArray(section)) return {}
  return section as Record<string, T>
}

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalogSnapshot> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetchFromElectronMain(MODELS_DEV_CATALOG_URL, {
      headers: { 'User-Agent': 'WeFlow' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`models.dev ${response.status}`)
    const payload = await response.json()
    const providers = parseModelsDevCatalog(payload)
    const rawProviders = modelsDevPayloadSection<ModelsDevProvider>(payload, 'providers')
    const canonicalModels = modelsDevPayloadSection<Record<string, unknown>>(payload, 'models')
    if (providers.length <= 1 || Object.keys(rawProviders).length === 0) {
      throw new Error('models.dev 未返回可用供应商')
    }
    const timestamp = Date.now()
    return {
      timestamp,
      providers,
      rawProviders,
      canonicalModels,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function loadModelsDevCatalog(forceRefresh = false): Promise<{ snapshot: ModelsDevCatalogSnapshot; stale: boolean }> {
  // catalog.json already contains every provider and model. Keep that complete
  // snapshot for the whole main-process lifetime instead of downloading it
  // again for individual models or on a timer.
  if (!forceRefresh && catalogCache) return { snapshot: catalogCache, stale: false }
  if (!forceRefresh && catalogLoadError) throw catalogLoadError
  if (!catalogRequest) {
    catalogRequest = fetchModelsDevCatalog()
      .then((snapshot) => {
        catalogCache = snapshot
        catalogLoadError = null
        modelMetadataCache.clear()
        return snapshot
      })
      .finally(() => {
        catalogRequest = null
      })
  }
  try {
    return { snapshot: await catalogRequest, stale: false }
  } catch (error) {
    if (catalogCache) return { snapshot: catalogCache, stale: true }
    catalogLoadError = error instanceof Error ? error : new Error(String(error))
    throw catalogLoadError
  }
}

export async function getAIProviderCatalog(options: { forceRefresh?: boolean } = {}): Promise<AIProviderCatalogEntry[]> {
  try {
    return (await loadModelsDevCatalog(options.forceRefresh === true)).snapshot.providers
  } catch {
    return orderProviderCatalog([CUSTOM_PROVIDER, ...FALLBACK_PROVIDERS])
  }
}

const PROVIDER_LAB_IDS: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  xai: 'xai',
  'moonshotai-cn': 'moonshotai',
  moonshotai: 'moonshotai',
  'alibaba-cn': 'alibaba',
  alibaba: 'alibaba',
  zhipuai: 'zhipuai',
  minimax: 'minimax',
  mistral: 'mistral',
}

const MODEL_NAMESPACE_PROVIDER_IDS: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  'deepseek-ai': 'deepseek',
  moonshotai: 'moonshotai-cn',
  qwen: 'alibaba-cn',
  alibaba: 'alibaba-cn',
  zhipuai: 'zhipuai',
  'zai-org': 'zhipuai',
  minimax: 'minimax',
  mistralai: 'mistral',
}

const FIRST_PARTY_PROVIDER_IDS = Array.from(new Set(Object.values(MODEL_NAMESPACE_PROVIDER_IDS)))

function normalizeModelLookupId(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^models\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

function modelLookupCandidates(value: unknown): string[] {
  const normalized = normalizeModelLookupId(value)
  if (!normalized) return []
  const result = new Set<string>([normalized])
  const withoutRouterVariant = normalized.replace(/:(?:free|online|extended|thinking|exacto|nitro)$/i, '')
  result.add(withoutRouterVariant)
  const segments = withoutRouterVariant.split('/').filter(Boolean)
  for (let index = 1; index < segments.length; index += 1) {
    result.add(segments.slice(index).join('/'))
  }
  return Array.from(result).filter(Boolean)
}

function positiveLimit(value: unknown): number | undefined {
  const parsed = optionalNumber(value)
  return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined
}

function modelLimits(model: Record<string, unknown> | undefined): { context?: number; input?: number; output?: number } {
  const limit = model?.limit as Record<string, unknown> | undefined
  return {
    context: positiveLimit(limit?.context),
    input: positiveLimit(limit?.input),
    output: positiveLimit(limit?.output),
  }
}

function findModelRecord(
  models: Record<string, Record<string, unknown>> | undefined,
  requestedModel: string,
): { key: string; model: Record<string, unknown> } | null {
  const entries = Object.entries(models || {})
  for (const candidate of modelLookupCandidates(requestedModel)) {
    const found = entries.find(([key, model]) => (
      normalizeModelLookupId(key) === candidate
      || normalizeModelLookupId(model.id || model.name) === candidate
    ))
    if (found) return { key: found[0], model: found[1] }
  }
  return null
}

function comparableBaseURL(value: unknown): string {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase()
}

function modelMetadataCacheKey(options: { provider?: string; model?: string; baseURL?: string }): string {
  return [
    String(options.provider || '').trim().toLowerCase() || 'custom',
    normalizeModelLookupId(options.model),
    comparableBaseURL(options.baseURL),
  ].join('::')
}

function findServingProvider(
  providers: Record<string, ModelsDevProvider>,
  requestedProvider: string,
  baseURL?: string,
): { id: string; provider: ModelsDevProvider } | null {
  const providerId = String(requestedProvider || '').trim().toLowerCase()
  if (providerId && providers[providerId]) return { id: providerId, provider: providers[providerId] }
  const requestedBaseURL = comparableBaseURL(baseURL)
  if (!requestedBaseURL) return null
  const matched = Object.entries(providers).find(([, provider]) => (
    comparableBaseURL(provider.api) === requestedBaseURL
  ))
  return matched ? { id: matched[0], provider: matched[1] } : null
}

function findCanonicalModel(
  models: Record<string, Record<string, unknown>>,
  requestedModel: string,
  servingProviderId?: string,
  servingModel?: Record<string, unknown>,
): { key: string; model: Record<string, unknown> } | null {
  const entries = Object.entries(models)
  const candidates = new Set<string>()
  const baseModel = normalizeModelLookupId(servingModel?.base_model)
  if (baseModel) candidates.add(baseModel)
  for (const candidate of modelLookupCandidates(requestedModel)) candidates.add(candidate)
  const servingModelId = normalizeModelLookupId(servingModel?.id)
  if (servingModelId) {
    for (const candidate of modelLookupCandidates(servingModelId)) candidates.add(candidate)
  }
  const labId = PROVIDER_LAB_IDS[String(servingProviderId || '').toLowerCase()]
  if (labId) {
    for (const candidate of [...candidates]) {
      if (!candidate.includes('/')) candidates.add(`${labId}/${candidate}`)
    }
  }

  for (const candidate of candidates) {
    const exact = entries.find(([key, model]) => (
      normalizeModelLookupId(key) === candidate
      || normalizeModelLookupId(model.id) === candidate
    ))
    if (exact) return { key: exact[0], model: exact[1] }
  }

  // Relay and custom endpoints often prepend routing namespaces such as
  // `Pro/moonshotai/`. Only accept a suffix match when it identifies exactly
  // one canonical model; ambiguous family guesses are intentionally rejected.
  for (const candidate of candidates) {
    const bare = candidate.split('/').pop()
    if (!bare) continue
    const matches = entries.filter(([key, model]) => (
      normalizeModelLookupId(key).split('/').pop() === bare
      || normalizeModelLookupId(model.id).split('/').pop() === bare
    ))
    if (matches.length === 1) return { key: matches[0][0], model: matches[0][1] }
  }
  return null
}

export async function resolveAIModelMetadata(options: {
  provider?: string
  model?: string
  baseURL?: string
  forceRefresh?: boolean
}): Promise<AIModelMetadataResolution> {
  const requestedProvider = String(options.provider || '').trim() || 'custom'
  const requestedModel = String(options.model || '').trim()
  const baseResult = { requestedProvider, requestedModel }
  if (!requestedModel) return { success: false, ...baseResult, error: '缺少模型 ID' }

  const cacheKey = modelMetadataCacheKey(options)
  if (!options.forceRefresh) {
    const cached = modelMetadataCache.get(cacheKey)
    if (cached) return { ...cached, ...baseResult }
  }

  const remember = (result: AIModelMetadataResolution): AIModelMetadataResolution => {
    modelMetadataCache.set(cacheKey, result)
    return result
  }

  try {
    const { snapshot, stale } = await loadModelsDevCatalog(options.forceRefresh === true)
    let servingProvider = findServingProvider(snapshot.rawProviders, requestedProvider, options.baseURL)
    let servingMatch = servingProvider
      ? findModelRecord(servingProvider.provider.models, requestedModel)
      : null
    if (!servingMatch && (!servingProvider || ['custom', 'tianjige'].includes(requestedProvider.toLowerCase()))) {
      const namespace = normalizeModelLookupId(requestedModel).split('/')[0]
      const namespacedProviderId = MODEL_NAMESPACE_PROVIDER_IDS[namespace] || namespace
      const namespacedProvider = snapshot.rawProviders[namespacedProviderId]
      const namespacedMatch = namespacedProvider
        ? findModelRecord(namespacedProvider.models, requestedModel)
        : null
      if (namespacedProvider && namespacedMatch) {
        servingProvider = { id: namespacedProviderId, provider: namespacedProvider }
        servingMatch = namespacedMatch
      }
    }
    if (!servingMatch && !servingProvider) {
      const firstPartyMatches = FIRST_PARTY_PROVIDER_IDS.flatMap((providerId) => {
        const provider = snapshot.rawProviders[providerId]
        const match = provider ? findModelRecord(provider.models, requestedModel) : null
        return provider && match ? [{ providerId, provider, match }] : []
      })
      if (firstPartyMatches.length === 1) {
        const onlyMatch = firstPartyMatches[0]
        servingProvider = { id: onlyMatch.providerId, provider: onlyMatch.provider }
        servingMatch = onlyMatch.match
      }
    }
    const canonicalMatch = findCanonicalModel(
      snapshot.canonicalModels,
      requestedModel,
      servingProvider?.id,
      servingMatch?.model,
    )
    if (!servingMatch && !canonicalMatch) {
      return remember({
        success: false,
        ...baseResult,
        checkedAt: snapshot.timestamp,
        stale,
        error: 'Models.dev 暂无这个模型的精确记录，已保留保守推断',
      })
    }

    const servingLimits = modelLimits(servingMatch?.model)
    const canonicalLimits = modelLimits(canonicalMatch?.model)
    const contextWindow = servingLimits.context
      ?? canonicalLimits.context
      ?? servingLimits.input
      ?? canonicalLimits.input
    const source = servingLimits.context || servingLimits.input
      ? 'models.dev-provider' as const
      : 'models.dev-model' as const
    if (!contextWindow) {
      return remember({
        success: false,
        ...baseResult,
        matchedProviderId: servingProvider?.id,
        matchedModelId: String(servingMatch?.model.id || servingMatch?.key || '') || undefined,
        canonicalModelId: String(canonicalMatch?.model.id || canonicalMatch?.key || '') || undefined,
        checkedAt: snapshot.timestamp,
        stale,
        error: 'Models.dev 已找到模型，但没有可用的上下文限制',
      })
    }

    return remember({
      success: true,
      ...baseResult,
      matchedProviderId: servingProvider?.id,
      matchedModelId: String(servingMatch?.model.id || servingMatch?.key || '') || undefined,
      canonicalModelId: String(canonicalMatch?.model.id || canonicalMatch?.key || '') || undefined,
      contextWindow,
      maxInputTokens: servingLimits.input ?? canonicalLimits.input,
      maxOutputTokens: servingLimits.output ?? canonicalLimits.output,
      canonicalContextWindow: canonicalLimits.context,
      providerOverride: Boolean(
        servingLimits.context
        && canonicalLimits.context
        && servingLimits.context !== canonicalLimits.context
      ),
      source,
      checkedAt: snapshot.timestamp,
      lastUpdated: String(servingMatch?.model.last_updated || canonicalMatch?.model.last_updated || '') || undefined,
      stale,
    })
  } catch (error) {
    return {
      success: false,
      ...baseResult,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizeModelsEndpoint(baseURL: string, protocol: AIProviderProtocol, apiKey: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, '')
  if (protocol === 'google') {
    const separator = normalized.includes('?') ? '&' : '?'
    return `${normalized}/models${separator}key=${encodeURIComponent(apiKey)}`
  }
  return `${normalized}/models`
}

function modelsRequestHeaders(protocol: AIProviderProtocol, apiKey: string): Record<string, string> | undefined {
  if (!apiKey || protocol === 'google') return undefined
  if (protocol === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
  return { Authorization: `Bearer ${apiKey}` }
}

export async function listModelsFromProvider(options: {
  baseURL?: string
  apiKey?: string
  protocol?: AIProviderProtocol
}): Promise<{ success: boolean; models?: string[]; error?: string }> {
  const baseURL = String(options.baseURL || '').trim()
  if (!baseURL) return { success: false, error: '请先填写基础地址' }
  const apiKey = String(options.apiKey || '').trim()
  const protocol = options.protocol || 'openai-compatible'

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchFromElectronMain(normalizeModelsEndpoint(baseURL, protocol, apiKey), {
      headers: modelsRequestHeaders(protocol, apiKey),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`)
    const payload = await response.json() as { data?: unknown; models?: unknown }
    const values = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
    const models = Array.from(new Set(values
      .map((value) => {
        if (typeof value === 'string') return value
        if (!value || typeof value !== 'object') return ''
        const record = value as Record<string, unknown>
        return String(record.id || record.name || '').replace(/^models\//, '')
      })
      .map((value) => value.trim())
      .filter((value) => value && !NON_CHAT_MODEL_MARKERS.some((marker) => value.toLowerCase().includes(marker)))))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
    return models.length > 0
      ? { success: true, models }
      : { success: false, error: '服务端没有返回可用的对话模型' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}
