import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IntelligenceDb } from '../intelligenceDb'
import { BriefingService, type BriefingMessage, type BriefingLLM } from '../briefingService'

describe('BriefingService', () => {
  let db: IntelligenceDb
  let service: BriefingService

  beforeEach(() => {
    db = new IntelligenceDb(':memory:')
    service = new BriefingService(db)
  })

  afterEach(() => {
    db.close()
  })

  function makeMsg(overrides: Partial<BriefingMessage> = {}): BriefingMessage {
    return {
      sender: 'Alice',
      content: 'Hello',
      timestamp: Date.now(),
      sessionId: 'session_1',
      isGroup: false,
      ...overrides,
    }
  }

  // ── Basic generation ─────────────────────────────────────────

  it('generates a briefing from messages', async () => {
    const messages = [
      makeMsg({ sender: 'Alice', content: '你好，有空吗？' }),
      makeMsg({ sender: 'Bob', content: '记得提交报告' }),
    ]
    const result = await service.generate(messages)
    expect(result.date).toBeTruthy()
    expect(result.summary).toBeTruthy()
  })

  it('generates empty briefing when no messages', async () => {
    const result = await service.generate([])
    expect(result.unrepliedCount).toBe(0)
    expect(result.priorityItems).toHaveLength(0)
    expect(result.todoItems).toHaveLength(0)
    expect(result.summary).toContain('没有需要特别注意')
  })

  // ── Priority items ───────────────────────────────────────────

  it('extracts priority items from question messages', async () => {
    const messages = [
      makeMsg({ sender: 'Alice', content: '方案看了吗？' }),
      makeMsg({ sender: 'Bob', content: '今天天气不错' }),
    ]
    const result = await service.generate(messages)
    expect(result.priorityItems).toHaveLength(1)
    expect(result.priorityItems[0].contact).toBe('Alice')
  })

  it('marks starred contacts as high urgency', async () => {
    db.starContact('Boss')
    const messages = [
      makeMsg({ sender: 'Boss', content: '什么时候能完成？' }),
    ]
    const result = await service.generate(messages)
    expect(result.priorityItems).toHaveLength(1)
    expect(result.priorityItems[0].urgency).toBe('high')
  })

  // ── Ignored contacts ─────────────────────────────────────────

  it('filters out ignored contacts', async () => {
    db.ignoreContact('Spammer')
    const messages = [
      makeMsg({ sender: 'Spammer', content: '有空吗？参加活动' }),
      makeMsg({ sender: 'Alice', content: '你好' }),
    ]
    const result = await service.generate(messages)
    expect(result.activeContacts.find(c => c.name === 'Spammer')).toBeUndefined()
  })

  // ── Todo items ───────────────────────────────────────────────

  it('extracts todo items with keywords', async () => {
    const messages = [
      makeMsg({ sender: 'Boss', content: '记得明天前提交报告' }),
      makeMsg({ sender: 'Alice', content: '今天天气真好' }),
    ]
    const result = await service.generate(messages)
    expect(result.todoItems).toHaveLength(1)
    expect(result.todoItems[0].source).toBe('Boss')
  })

  it('extracts deadline from todo items', async () => {
    const messages = [
      makeMsg({ sender: 'Boss', content: '3月15日前必须完成方案' }),
    ]
    const result = await service.generate(messages)
    expect(result.todoItems).toHaveLength(1)
    expect(result.todoItems[0].deadline).toBeTruthy()
  })

  // ── Schedule items ───────────────────────────────────────────

  it('extracts schedule items with time expressions', async () => {
    const messages = [
      makeMsg({ sender: 'Alice', content: '明天下午3:00开会' }),
    ]
    const result = await service.generate(messages)
    expect(result.scheduleItems).toHaveLength(1)
    expect(result.scheduleItems[0].time).toBeTruthy()
  })

  // ── Active contacts ──────────────────────────────────────────

  it('counts active contacts sorted by message count', async () => {
    const messages = [
      makeMsg({ sender: 'Alice' }),
      makeMsg({ sender: 'Alice' }),
      makeMsg({ sender: 'Alice' }),
      makeMsg({ sender: 'Bob' }),
    ]
    const result = await service.generate(messages)
    expect(result.activeContacts).toHaveLength(2)
    expect(result.activeContacts[0].name).toBe('Alice')
    expect(result.activeContacts[0].messageCount).toBe(3)
  })

  // ── LLM summary ──────────────────────────────────────────────

  it('uses LLM for summary when available', async () => {
    const mockLLM: BriefingLLM = {
      complete: vi.fn().mockResolvedValue('今天最重要的是回复老板的消息。'),
    }
    const llmService = new BriefingService(db, mockLLM)
    const messages = [
      makeMsg({ sender: 'Boss', content: '什么时候能完成？' }),
    ]
    const result = await llmService.generate(messages)
    expect(result.summary).toBe('今天最重要的是回复老板的消息。')
    expect(mockLLM.complete).toHaveBeenCalled()
  })

  it('falls back to local summary when LLM fails', async () => {
    const mockLLM: BriefingLLM = {
      complete: vi.fn().mockRejectedValue(new Error('API error')),
    }
    const llmService = new BriefingService(db, mockLLM)
    const messages = [
      makeMsg({ sender: 'Alice', content: '记得买菜' }),
    ]
    const result = await llmService.generate(messages)
    expect(result.summary).toBeTruthy()
    expect(result.summary).not.toBe('')
  })

  // ── DB persistence ───────────────────────────────────────────

  it('saves briefing to database', async () => {
    const messages = [
      makeMsg({ sender: 'Alice', content: '你好' }),
    ]
    await service.generate(messages)
    const cached = service.getCachedBriefing()
    expect(cached).not.toBeNull()
  })
})
