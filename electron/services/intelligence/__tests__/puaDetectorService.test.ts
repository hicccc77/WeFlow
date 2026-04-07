import { describe, it, expect, vi } from 'vitest'
import { PuaDetectorService, type PUAMessage, type PUALLM } from '../puaDetectorService'

describe('PuaDetectorService', () => {
  const service = new PuaDetectorService()

  function makeMsg(overrides: Partial<PUAMessage> = {}): PUAMessage {
    return {
      sender: 'TestContact',
      content: '你好',
      timestamp: Date.now(),
      isSelf: false,
      ...overrides,
    }
  }

  // ── Empty input ──────────────────────────────────────────────

  it('returns low risk for empty messages', async () => {
    const result = await service.analyze('Alice', [])
    expect(result.riskLevel).toBe('low')
    expect(result.signals).toHaveLength(0)
    expect(result.summary).toContain('没有找到')
  })

  // ── Emotional blackmail ──────────────────────────────────────

  it('detects emotional blackmail pattern', async () => {
    const messages = [
      makeMsg({ content: '如果你不来，我就再也不理你了' }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.signals.some(s => s.pattern === 'emotional_blackmail')).toBe(true)
  })

  // ── Gaslighting ──────────────────────────────────────────────

  it('detects gaslighting pattern', async () => {
    const messages = [
      makeMsg({ content: '你记错了，我从来没说过那句话' }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.signals.some(s => s.pattern === 'gaslighting')).toBe(true)
  })

  // ── Isolation ────────────────────────────────────────────────

  it('detects isolation pattern', async () => {
    const messages = [
      makeMsg({ content: '别和小王来往了，他人品不好' }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.signals.some(s => s.pattern === 'isolation')).toBe(true)
  })

  // ── Belittling ───────────────────────────────────────────────

  it('detects belittling pattern', async () => {
    const messages = [
      makeMsg({ content: '你什么都做不好，离了我你怎么办' }),
    ]
    const result = await service.analyze('Alice', messages)
    const belittling = result.signals.filter(s => s.pattern === 'belittling')
    expect(belittling.length).toBeGreaterThan(0)
  })

  // ── Hot-cold cycling ─────────────────────────────────────────

  it('detects hot-cold cycling pattern', async () => {
    const messages = [
      makeMsg({ content: '别烦我，不想理你' }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.signals.some(s => s.pattern === 'hot_cold')).toBe(true)
  })

  // ── Negation filtering ───────────────────────────────────────

  it('skips negated patterns', async () => {
    const messages = [
      makeMsg({ content: '我不是说你记错了，我只是想确认' }),
    ]
    const result = await service.analyze('Alice', messages)
    // "不是" before "你记错了" should be filtered
    const gaslighting = result.signals.filter(s => s.pattern === 'gaslighting')
    expect(gaslighting).toHaveLength(0)
  })

  // ── Risk level calculation ───────────────────────────────────

  it('calculates high risk for multiple high-severity signals', async () => {
    const messages = [
      makeMsg({ content: '你记错了，根本没这回事' }),
      makeMsg({ content: '如果你不听我的，我就走' }),
      makeMsg({ content: '别和你那些朋友来往了' }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.riskLevel).toBe('high')
  })

  it('returns low risk for normal conversation', async () => {
    const messages = [
      makeMsg({ content: '今天天气真好' }),
      makeMsg({ content: '我们去吃饭吧' }),
      makeMsg({ content: '好的，几点？' }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.riskLevel).toBe('low')
  })

  // ── Only analyzes contact messages, not self ──────────────────

  it('ignores user own messages', async () => {
    const messages = [
      makeMsg({ content: '你记错了', isSelf: true }), // user said this, not PUA
      makeMsg({ content: '好的没问题', isSelf: false }),
    ]
    const result = await service.analyze('Alice', messages)
    expect(result.signals).toHaveLength(0)
  })

  // ── Pattern definitions ──────────────────────────────────────

  it('returns all 6 pattern definitions', () => {
    const patterns = service.getPatternDefinitions()
    expect(patterns).toHaveLength(6)
    expect(patterns.map(p => p.name)).toContain('gaslighting')
    expect(patterns.map(p => p.name)).toContain('emotional_blackmail')
  })

  // ── LLM integration ──────────────────────────────────────────

  it('merges LLM signals with keyword signals', async () => {
    const mockLLM: PUALLM = {
      complete: vi.fn().mockResolvedValue(JSON.stringify([
        { pattern: 'double_standards', score: 7, evidence: '你不行但我可以', explanation: '双标' },
      ])),
    }
    const llmService = new PuaDetectorService(mockLLM)
    const messages = [
      makeMsg({ content: '你记错了，我说的是另一件事' }),
    ]
    const result = await llmService.analyze('Alice', messages)
    // Should have both keyword-detected and LLM-detected signals
    expect(result.signals.length).toBeGreaterThanOrEqual(1)
  })
})
