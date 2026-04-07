/**
 * LLM Service — multi-provider LLM routing with Vision support
 *
 * Exports:
 * - LLMService class: main LLM interaction service
 * - llmService: singleton instance
 *
 * Features:
 * - Multi-provider: Anthropic, OpenAI, Ollama, Claude Code CLI, Mock
 * - VisionLLM: base64 image support for Claude and OpenAI Vision APIs
 * - Fast/Smart routing: simple queries use small models, complex use large models
 * - Request deduplication: 3-second debounce for identical requests
 * - Request/response logging: saved to {userData}/intelligence/llm_context/
 */

import { LLMProviderType, LLMRequest, LLMResponse } from './types'

// Lazy imports — only loaded when needed
let _fs: typeof import('fs') | null = null
let _path: typeof import('path') | null = null
let _childProcess: typeof import('child_process') | null = null

function getFs() {
  if (!_fs) _fs = require('fs')
  return _fs!
}
function getPath() {
  if (!_path) _path = require('path')
  return _path!
}
function getChildProcess() {
  if (!_childProcess) _childProcess = require('child_process')
  return _childProcess!
}

// ─── Provider Model Defaults ────────────────────────────────────

const PROVIDER_MODELS: Record<LLMProviderType, { smart: string; fast: string }> = {
  anthropic: { smart: 'claude-sonnet-4-20250514', fast: 'claude-haiku-4-5-20251001' },
  openai: { smart: 'gpt-4o', fast: 'gpt-4o-mini' },
  ollama: { smart: 'llama3.2', fast: 'llama3.2' },
  'claude-code': { smart: 'claude-code', fast: 'claude-code' },
  mock: { smart: 'mock', fast: 'mock' },
}

// ─── Deduplication Cache ────────────────────────────────────────

interface PendingRequest {
  promise: Promise<LLMResponse>
  timestamp: number
}

const DEDUP_WINDOW_MS = 3000

export class LLMService {
  private provider: LLMProviderType = 'mock'
  private apiKey: string = ''
  private baseUrl: string = ''
  private smartModel: string = ''
  private fastModel: string = ''
  private logDir: string = ''
  private pendingRequests = new Map<string, PendingRequest>()

  configure(opts: {
    provider?: LLMProviderType
    apiKey?: string
    baseUrl?: string
    smartModel?: string
    fastModel?: string
    logDir?: string
  }): void {
    if (opts.provider) this.provider = opts.provider
    if (opts.apiKey) this.apiKey = opts.apiKey
    if (opts.baseUrl) this.baseUrl = opts.baseUrl
    if (opts.smartModel) this.smartModel = opts.smartModel
    if (opts.fastModel) this.fastModel = opts.fastModel
    if (opts.logDir) this.logDir = opts.logDir
  }

  getProvider(): LLMProviderType {
    return this.provider
  }

  /**
   * Send a request to the configured LLM provider.
   * Supports text and vision (image) requests.
   */
  async call(request: LLMRequest): Promise<LLMResponse> {
    const dedupKey = this.buildDedupKey(request)
    const now = Date.now()

    // Check dedup cache
    const pending = this.pendingRequests.get(dedupKey)
    if (pending && now - pending.timestamp < DEDUP_WINDOW_MS) {
      return pending.promise
    }

    const promise = this.executeCall(request)
    this.pendingRequests.set(dedupKey, { promise, timestamp: now })

    // Clean up after resolution — attach .catch to prevent unhandled rejection
    promise
      .catch(() => { /* error will be re-thrown to the caller */ })
      .finally(() => {
        setTimeout(() => {
          const entry = this.pendingRequests.get(dedupKey)
          if (entry && entry.timestamp === now) {
            this.pendingRequests.delete(dedupKey)
          }
        }, DEDUP_WINDOW_MS)
      })

    return promise
  }

  /**
   * Convenience: describe an image using Vision LLM.
   */
  async describeImage(base64Data: string, mediaType: string, prompt?: string): Promise<string> {
    const response = await this.call({
      prompt: prompt || '用50字以内描述这张图片的内容',
      images: [{ base64Data, mediaType }],
      tier: 'fast',
      maxTokens: 200,
    })
    return response.text
  }

  /**
   * Convenience: summarize text using LLM.
   */
  async summarize(text: string, maxChars: number = 1500): Promise<string> {
    const response = await this.call({
      prompt: `用不超过${maxChars}字总结以下内容的核心要点：\n\n${text}`,
      tier: 'fast',
      maxTokens: Math.ceil(maxChars * 1.5),
    })
    return response.text
  }

  /**
   * Convenience: analyze content for content hub.
   */
  async analyzeContent(prompt: string): Promise<string> {
    const response = await this.call({
      prompt,
      systemPrompt: '你是一个信息分析助手。用户收到了来自社交网络的分享内容。请基于内容本身、发送者与用户的关系、以及对话上下文，分析：1. 内容核心要点（3句话以内）2. 对方分享这个内容的可能动机 3. 这个内容与用户当前处境的关联 4. 建议的回应方式',
      tier: 'smart',
      maxTokens: 2000,
    })
    return response.text
  }

  // ─── Internal ───────────────────────────────────────────────

  private buildDedupKey(request: LLMRequest): string {
    const parts = [
      request.prompt.slice(0, 200),
      request.systemPrompt?.slice(0, 100) || '',
      request.tier || 'smart',
      (request.images?.length || 0).toString(),
    ]
    return parts.join('|')
  }

  private resolveModel(request: LLMRequest): string {
    if (request.model) return request.model
    const tier = request.tier || 'smart'
    const defaults = PROVIDER_MODELS[this.provider]
    if (tier === 'fast') return this.fastModel || defaults.fast
    return this.smartModel || defaults.smart
  }

  private async executeCall(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now()
    const model = this.resolveModel(request)

    let response: LLMResponse

    switch (this.provider) {
      case 'anthropic':
        response = await this.callAnthropic(request, model)
        break
      case 'openai':
        response = await this.callOpenAI(request, model)
        break
      case 'ollama':
        response = await this.callOllama(request, model)
        break
      case 'claude-code':
        response = await this.callClaudeCode(request)
        break
      case 'mock':
      default:
        response = this.callMock(request, model)
        break
    }

    response.latencyMs = Date.now() - startTime

    // Log request/response asynchronously
    this.logCall(request, response).catch(() => { /* ignore logging errors */ })

    return response
  }

  private async callAnthropic(request: LLMRequest, model: string): Promise<LLMResponse> {
    const url = this.baseUrl || 'https://api.anthropic.com'
    const messages: any[] = []

    // Build content blocks
    const content: any[] = []

    // Add images first (for Vision)
    if (request.images?.length) {
      for (const img of request.images) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64Data,
          },
        })
      }
    }

    content.push({ type: 'text', text: request.prompt })
    messages.push({ role: 'user', content })

    const body: any = {
      model,
      max_tokens: request.maxTokens || 1024,
      messages,
    }
    if (request.systemPrompt) {
      body.system = request.systemPrompt
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${errorText}`)
    }

    const data = await res.json()
    const text = data.content?.map((b: any) => b.text || '').join('') || ''

    return {
      text,
      model,
      provider: 'anthropic',
      tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    }
  }

  private async callOpenAI(request: LLMRequest, model: string): Promise<LLMResponse> {
    const url = this.baseUrl || 'https://api.openai.com'
    const messages: any[] = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }

    // Build user message content
    const content: any[] = []
    content.push({ type: 'text', text: request.prompt })

    if (request.images?.length) {
      for (const img of request.images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.mediaType};base64,${img.base64Data}`,
          },
        })
      }
    }

    messages.push({ role: 'user', content })

    const body: any = {
      model,
      max_tokens: request.maxTokens || 1024,
      messages,
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${errorText}`)
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content || ''

    return {
      text,
      model,
      provider: 'openai',
      tokensUsed: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0),
    }
  }

  private async callOllama(request: LLMRequest, model: string): Promise<LLMResponse> {
    const url = this.baseUrl || 'http://localhost:11434'
    const messages: any[] = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    messages.push({ role: 'user', content: request.prompt })

    // Ollama vision: add images to the message
    if (request.images?.length) {
      messages[messages.length - 1].images = request.images.map(i => i.base64Data)
    }

    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`Ollama API error ${res.status}: ${errorText}`)
    }

    const data = await res.json()
    return {
      text: data.message?.content || '',
      model,
      provider: 'ollama',
    }
  }

  private async callClaudeCode(request: LLMRequest): Promise<LLMResponse> {
    const cp = getChildProcess()

    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.prompt}`
      : request.prompt

    return new Promise((resolve, reject) => {
      const proc = cp.spawn('claude', ['-p', prompt], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let killed = false

      // Manual timeout enforcement (spawn timeout doesn't kill on Node.js)
      const timer = setTimeout(() => {
        killed = true
        proc.kill('SIGTERM')
        reject(new Error('Claude Code CLI timed out after 120 seconds'))
      }, 120_000)

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (killed) return
        if (code !== 0) {
          reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr}`))
        } else {
          resolve({
            text: stdout.trim(),
            model: 'claude-code',
            provider: 'claude-code',
          })
        }
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timer)
        if (killed) return
        reject(new Error(`Claude Code CLI error: ${err.message}`))
      })
    })
  }

  private callMock(_request: LLMRequest, model: string): LLMResponse {
    if (_request.images?.length) {
      return {
        text: '这是一张图片的描述（Mock）',
        model,
        provider: 'mock',
        tokensUsed: 10,
      }
    }
    return {
      text: '这是一段Mock回复文本。',
      model,
      provider: 'mock',
      tokensUsed: 10,
    }
  }

  private async logCall(request: LLMRequest, response: LLMResponse): Promise<void> {
    if (!this.logDir) return

    try {
      const fs = getFs()
      const path = getPath()

      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const logFile = path.join(this.logDir, `${timestamp}.json`)

      const logEntry = {
        timestamp: new Date().toISOString(),
        provider: response.provider,
        model: response.model,
        tier: request.tier || 'smart',
        latencyMs: response.latencyMs,
        tokensUsed: response.tokensUsed,
        prompt: request.prompt.slice(0, 500),
        systemPrompt: request.systemPrompt?.slice(0, 200),
        hasImages: !!request.images?.length,
        imageCount: request.images?.length || 0,
        response: response.text.slice(0, 1000),
      }

      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2))
    } catch {
      // Silently ignore logging errors
    }
  }
}

export const llmService = new LLMService()
