import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IntelligenceDb } from '../intelligenceDb'
import { GrowthAdvisorService, type GrowthMessage, type GrowthLLM } from '../growthAdvisorService'

describe('GrowthAdvisorService', () => {
  let db: IntelligenceDb
  let service: GrowthAdvisorService

  beforeEach(() => {
    db = new IntelligenceDb(':memory:')
    service = new GrowthAdvisorService(db)
  })

  afterEach(() => {
    db.close()
  })

  function makeMsg(overrides: Partial<GrowthMessage> = {}): GrowthMessage {
    return {
      sender: 'Alice',
      content: '你好',
      timestamp: Date.now(),
      sessionId: 'session_1',
      isGroup: false,
      isSelf: false,
      ...overrides,
    }
  }

  // ── Basic analysis ───────────────────────────────────────────

  it('generates a growth report', async () => {
    const messages = [
      makeMsg({ isSelf: true, content: '我今天很开心' }),
      makeMsg({ sender: 'Bob', content: '明天见' }),
    ]
    const result = await service.analyze(messages)
    expect(result.periodDays).toBe(7)
    expect(result.generatedAt).toBeTruthy()
    expect(result.summary).toBeTruthy()
  })

  it('generates report for empty messages', async () => {
    const result = await service.analyze([])
    expect(result.insights).toHaveLength(0)
    expect(result.strengths.length).toBeGreaterThan(0)
  })

  // ── Communication insights ───────────────────────────────────

  it('detects late-night messaging pattern', async () => {
    const lateNight = new Date()
    lateNight.setHours(2, 30) // 2:30 AM
    const messages = Array.from({ length: 20 }, () =>
      makeMsg({ isSelf: true, timestamp: lateNight.getTime(), content: 'late msg' })
    )
    const result = await service.analyze(messages)
    expect(result.insights.some(i =>
      i.category === 'communication' && i.observation.includes('深夜')
    )).toBe(true)
  })

  it('detects short message pattern', async () => {
    const messages = Array.from({ length: 20 }, () =>
      makeMsg({ isSelf: true, content: '好的' })
    )
    const result = await service.analyze(messages)
    expect(result.insights.some(i =>
      i.category === 'communication' && i.observation.includes('短')
    )).toBe(true)
  })

  // ── Social insights ──────────────────────────────────────────

  it('detects narrow social circle', async () => {
    const messages = Array.from({ length: 25 }, (_, i) =>
      makeMsg({ sender: i % 2 === 0 ? 'Alice' : 'Bob', content: 'chat' })
    )
    const result = await service.analyze(messages)
    expect(result.insights.some(i =>
      i.category === 'social' && i.observation.includes('个人')
    )).toBe(true)
  })

  it('detects missing starred contact interaction', async () => {
    db.starContact('ImportantPerson')
    const messages = [
      makeMsg({ sender: 'RandomPerson', content: 'test' }),
    ]
    const result = await service.analyze(messages)
    expect(result.insights.some(i =>
      i.category === 'social' && i.observation.includes('重要联系人')
    )).toBe(true)
  })

  // ── Goals generation ─────────────────────────────────────────

  it('generates weekly goals based on insights', async () => {
    const lateNight = new Date()
    lateNight.setHours(3, 0)
    const messages = Array.from({ length: 20 }, () =>
      makeMsg({ isSelf: true, timestamp: lateNight.getTime(), content: 'late' })
    )
    const result = await service.analyze(messages)
    expect(result.weeklyGoals.length).toBeGreaterThan(0)
  })

  // ── LLM integration ──────────────────────────────────────────

  it('uses LLM for summary when available', async () => {
    const mockLLM: GrowthLLM = {
      complete: vi.fn().mockResolvedValue('本周最重要的是改善作息时间。'),
    }
    const llmService = new GrowthAdvisorService(db, mockLLM)
    const lateNight = new Date()
    lateNight.setHours(3, 0)
    const messages = Array.from({ length: 20 }, () =>
      makeMsg({ isSelf: true, timestamp: lateNight.getTime(), content: 'late' })
    )
    const result = await llmService.analyze(messages)
    expect(result.summary).toBe('本周最重要的是改善作息时间。')
  })
})
