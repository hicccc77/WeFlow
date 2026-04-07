import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMService } from '../llmService'

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// Mock path
vi.mock('path', () => ({
  join: (...args: string[]) => args.join('/'),
}))

describe('LLMService', () => {
  let service: LLMService

  beforeEach(() => {
    service = new LLMService()
    vi.clearAllMocks()
  })

  // ─── Configuration ──────────────────────────────────────────

  describe('configure', () => {
    it('sets provider', () => {
      service.configure({ provider: 'anthropic' })
      expect(service.getProvider()).toBe('anthropic')
    })

    it('defaults to mock provider', () => {
      expect(service.getProvider()).toBe('mock')
    })
  })

  // ─── Mock Provider ──────────────────────────────────────────

  describe('mock provider', () => {
    it('returns mock text response', async () => {
      const result = await service.call({ prompt: 'Hello' })
      expect(result.provider).toBe('mock')
      expect(result.text).toBeTruthy()
      expect(result.model).toBe('mock')
    })

    it('returns mock image description', async () => {
      const result = await service.call({
        prompt: '描述图片',
        images: [{ base64Data: 'abc123', mediaType: 'image/jpeg' }],
      })
      expect(result.provider).toBe('mock')
      expect(result.text).toContain('图片')
    })

    it('includes latency measurement', async () => {
      const result = await service.call({ prompt: 'test' })
      expect(result.latencyMs).toBeDefined()
      expect(result.latencyMs!).toBeGreaterThanOrEqual(0)
    })
  })

  // ─── Convenience Methods ───────────────────────────────────

  describe('describeImage', () => {
    it('calls LLM with image data', async () => {
      const result = await service.describeImage('base64data', 'image/jpeg')
      expect(result).toBeTruthy()
    })

    it('uses custom prompt', async () => {
      const result = await service.describeImage('base64data', 'image/png', '这是什么')
      expect(result).toBeTruthy()
    })
  })

  describe('summarize', () => {
    it('returns summary text', async () => {
      const result = await service.summarize('这是一段很长的文章...')
      expect(result).toBeTruthy()
    })
  })

  describe('analyzeContent', () => {
    it('returns analysis text', async () => {
      const result = await service.analyzeContent('分析这个内容')
      expect(result).toBeTruthy()
    })
  })

  // ─── Deduplication ──────────────────────────────────────────

  describe('deduplication', () => {
    it('deduplicates identical requests within 3 seconds', async () => {
      const spy = vi.spyOn(service as any, 'executeCall')

      const promise1 = service.call({ prompt: 'same query', tier: 'fast' })
      const promise2 = service.call({ prompt: 'same query', tier: 'fast' })

      const [result1, result2] = await Promise.all([promise1, promise2])

      // Should only call executeCall once
      expect(spy).toHaveBeenCalledTimes(1)
      expect(result1).toBe(result2)
    })

    it('does not deduplicate different requests', async () => {
      const spy = vi.spyOn(service as any, 'executeCall')

      await service.call({ prompt: 'query A' })
      await service.call({ prompt: 'query B' })

      expect(spy).toHaveBeenCalledTimes(2)
    })
  })

  // ─── Tier Routing ──────────────────────────────────────────

  describe('tier routing', () => {
    it('uses fast model for fast tier', async () => {
      service.configure({ provider: 'mock', fastModel: 'test-fast' })
      const result = await service.call({ prompt: 'test', tier: 'fast' })
      expect(result.model).toBe('test-fast')
    })

    it('uses smart model for smart tier', async () => {
      service.configure({ provider: 'mock', smartModel: 'test-smart' })
      const result = await service.call({ prompt: 'test', tier: 'smart' })
      expect(result.model).toBe('test-smart')
    })

    it('defaults to smart tier', async () => {
      service.configure({ provider: 'mock', smartModel: 'test-smart' })
      const result = await service.call({ prompt: 'test' })
      expect(result.model).toBe('test-smart')
    })
  })

  // ─── Custom Model Override ─────────────────────────────────

  describe('model override', () => {
    it('uses explicit model from request', async () => {
      const result = await service.call({ prompt: 'test', model: 'custom-model-v1' })
      expect(result.model).toBe('custom-model-v1')
    })
  })

  // ─── Anthropic Provider ────────────────────────────────────

  describe('anthropic provider', () => {
    it('sends correct request format', async () => {
      service.configure({ provider: 'anthropic', apiKey: 'test-key' })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: 'Hello from Claude' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      })
      global.fetch = mockFetch

      const result = await service.call({
        prompt: 'test',
        systemPrompt: 'You are helpful',
        temperature: 0.5,
      })

      expect(result.text).toBe('Hello from Claude')
      expect(result.provider).toBe('anthropic')
      expect(result.tokensUsed).toBe(30)

      const fetchCall = mockFetch.mock.calls[0]
      expect(fetchCall[0]).toContain('/v1/messages')
      const body = JSON.parse(fetchCall[1].body)
      expect(body.system).toBe('You are helpful')
      expect(body.temperature).toBe(0.5)
    })

    it('sends vision request with images', async () => {
      service.configure({ provider: 'anthropic', apiKey: 'test-key' })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '图片描述' }],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      })
      global.fetch = mockFetch

      const result = await service.call({
        prompt: '描述图片',
        images: [{ base64Data: 'abc123', mediaType: 'image/jpeg' }],
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.messages[0].content).toHaveLength(2)
      expect(body.messages[0].content[0].type).toBe('image')
      expect(body.messages[0].content[0].source.type).toBe('base64')
    })

    it('throws on API error', async () => {
      service.configure({ provider: 'anthropic', apiKey: 'bad-key' })

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      })

      await expect(service.call({ prompt: 'test' })).rejects.toThrow('Anthropic API error 401')
    })
  })

  // ─── OpenAI Provider ──────────────────────────────────────

  describe('openai provider', () => {
    it('sends correct request format', async () => {
      service.configure({ provider: 'openai', apiKey: 'test-key' })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello from GPT' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      })
      global.fetch = mockFetch

      const result = await service.call({
        prompt: 'test',
        systemPrompt: 'system instruction',
      })

      expect(result.text).toBe('Hello from GPT')
      expect(result.provider).toBe('openai')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[1].role).toBe('user')
    })

    it('sends vision request with image_url format', async () => {
      service.configure({ provider: 'openai', apiKey: 'test-key' })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '图片描述' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
      })
      global.fetch = mockFetch

      await service.call({
        prompt: '描述图片',
        images: [{ base64Data: 'abc123', mediaType: 'image/jpeg' }],
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      const userContent = body.messages[body.messages.length - 1].content
      expect(userContent).toHaveLength(2)
      expect(userContent[1].type).toBe('image_url')
      expect(userContent[1].image_url.url).toContain('data:image/jpeg;base64,')
    })

    it('throws on API error', async () => {
      service.configure({ provider: 'openai', apiKey: 'bad-key' })

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      })

      await expect(service.call({ prompt: 'test' })).rejects.toThrow('OpenAI API error 429')
    })
  })

  // ─── Ollama Provider ──────────────────────────────────────

  describe('ollama provider', () => {
    it('sends correct request format', async () => {
      service.configure({ provider: 'ollama' })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          message: { content: 'Hello from Ollama' },
        }),
      })
      global.fetch = mockFetch

      const result = await service.call({ prompt: 'test' })
      expect(result.text).toBe('Hello from Ollama')
      expect(result.provider).toBe('ollama')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.stream).toBe(false)
    })
  })

  // ─── Logging ───────────────────────────────────────────────

  describe('logging', () => {
    it('logs calls when logDir is set', async () => {
      service.configure({ logDir: '/tmp/test-logs' })
      const logSpy = vi.spyOn(service as any, 'logCall')
      await service.call({ prompt: 'test' })

      expect(logSpy).toHaveBeenCalled()
    })

    it('does not crash when logDir is not set', async () => {
      const result = await service.call({ prompt: 'test' })
      expect(result.text).toBeTruthy()
    })
  })
})
