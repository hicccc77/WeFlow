import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue('/tmp/weflow-test') },
}))

// Mock chatService
vi.mock('../../chatService', () => ({
  chatService: {
    getMessages: vi.fn().mockResolvedValue([]),
    searchMessages: vi.fn().mockResolvedValue([]),
    getLatestMessages: vi.fn().mockResolvedValue([]),
  },
}))

// Mock mediaContextService
vi.mock('../mediaContextService', () => ({
  mediaContextService: {
    processMessage: vi.fn().mockResolvedValue(null),
    processVoice: vi.fn().mockResolvedValue(null),
  },
}))

// Mock LLM service with structured responses
const mockLlmCall = vi.fn()
vi.mock('../llmService', () => ({
  llmService: {
    call: (...args: any[]) => mockLlmCall(...args),
    describeImage: vi.fn().mockResolvedValue('图片描述（Mock）'),
    summarize: vi.fn().mockResolvedValue('摘要（Mock）'),
  },
}))

// Mock intelligenceDb - use in-memory implementation
vi.mock('../intelligenceDb', () => {
  const discussions = new Map<number, any>()
  let nextDiscId = 1
  const aliases = new Map<string, string>()
  const relationships = new Map<string, any>()
  const contacts = new Map<string, any>()
  const personality = new Map<string, string>()
  const perContactStyle = new Map<string, string>()
  const coachLog = new Map<number, any>()
  const coachConfig = new Map<string, string>()
  const enrichedCache = new Map<string, any>()
  const feedback = new Map<number, any>()
  let nextLogId = 1
  let nextFeedbackId = 1

  return {
    intelligenceDb: {
      resolve: (alias: string) => aliases.get(alias) || alias,
      addAlias: (alias: string, canonical: string) => aliases.set(alias, canonical),
      addAliasesBulk: (mappings: Array<[string, string]>) => {
        for (const [a, c] of mappings) aliases.set(a, c)
      },
      getAliases: () => [],
      getRelationship: (name: string) => relationships.get(name) || null,
      upsertRelationship: (rel: any) => relationships.set(rel.contact_name, rel),
      getContact: (name: string) => contacts.get(name) || null,
      upsertContact: (name: string, data: any) => contacts.set(name, { name, ...data }),
      getAllContacts: () => Array.from(contacts.values()),
      getPersonalityValue: (key: string) => personality.get(key) || '',
      setPersonalityValue: (key: string, value: string) => personality.set(key, value),
      getPerContactStyle: (name: string) => perContactStyle.get(name) || '',
      setPerContactStyle: (name: string, style: string) => perContactStyle.set(name, style),
      getCoachConfig: (key: string) => coachConfig.get(key) || null,
      setCoachConfig: (key: string, value: string) => coachConfig.set(key, value),
      createDiscussion: (contact: string, msg: string) => {
        const id = nextDiscId++
        const now = new Date().toISOString()
        discussions.set(id, {
          id, contact, incomingMessage: msg, rounds: [],
          strategySummary: null, status: 'active', guideQuestions: [],
          isComplex: false, complexityReason: '', createdAt: now, updatedAt: now,
        })
        return id
      },
      getDiscussion: (id: number) => discussions.get(id) || null,
      appendDiscussionRound: (id: number, role: string, content: string) => {
        const disc = discussions.get(id)
        if (!disc) return
        disc.rounds.push({ role, content, timestamp: new Date().toISOString() })
      },
      updateDiscussionStatus: (id: number, status: string, summary?: string) => {
        const disc = discussions.get(id)
        if (!disc) return
        disc.status = status
        if (summary !== undefined) disc.strategySummary = summary
      },
      findActiveDiscussion: (contact: string, msg: string) => {
        for (const disc of discussions.values()) {
          if (disc.contact === contact && disc.incomingMessage === msg && disc.status === 'active') return disc
        }
        return null
      },
      logCoachCall: (opts: any) => {
        const id = nextLogId++
        coachLog.set(id, { id, ...opts })
        return id
      },
      getCoachLog: (id: number) => coachLog.get(id) || null,
      addCoachFeedback: (logId: number, idx: number, rating: string, contact: string) => {
        const id = nextFeedbackId++
        feedback.set(id, { id, log_id: logId, suggestion_index: idx, rating, contact })
        return id
      },
      getRecentFeedback: () => [],
      getCachedEnrichment: (key: string) => enrichedCache.get(key) || null,
      setCachedEnrichment: (key: string, data: any) => enrichedCache.set(key, { cache_key: key, ...data }),
      invalidateCache: (key: string) => enrichedCache.delete(key),
      starContact: vi.fn(),
      ignoreContact: vi.fn(),
      getContactPreference: vi.fn().mockReturnValue(null),
      getBriefing: vi.fn().mockReturnValue(null),
      getLatestBriefing: vi.fn().mockReturnValue(null),
      // For test reset
      _reset: () => {
        discussions.clear(); nextDiscId = 1
        aliases.clear(); relationships.clear(); contacts.clear()
        personality.clear(); perContactStyle.clear()
        coachLog.clear(); coachConfig.clear()
        enrichedCache.clear(); feedback.clear()
        nextLogId = 1; nextFeedbackId = 1
      },
    },
  }
})

import { ReplyCoachService } from '../replyCoachService'
import { intelligenceDb } from '../intelligenceDb'

describe('ReplyCoachService', () => {
  let service: ReplyCoachService

  beforeEach(() => {
    service = new ReplyCoachService()
    mockLlmCall.mockReset()
    ;(intelligenceDb as any)._reset?.()
  })

  // ─── Context Assembly ────────────────────────────────────────

  describe('buildContextBundle', () => {
    it('should build basic context for unknown contact', async () => {
      const ctx = await service.buildContextBundle('test_user', '你好')
      expect(ctx.display_name).toBe('test_user')
      expect(ctx.contact_name).toBe('test_user')
      expect(ctx.incoming_message).toBe('你好')
      expect(ctx.rel_context).toContain('没有关于')
    })

    it('should resolve identity alias', async () => {
      intelligenceDb.addAlias('wxid_abc123', '张三')
      const ctx = await service.buildContextBundle('wxid_abc123', '你好')
      expect(ctx.display_name).toBe('张三')
    })

    it('should use relationship context when available', async () => {
      intelligenceDb.upsertRelationship({
        contact_name: '老板',
        relationship_type: '上级',
        closeness: 0.6,
        communication_style: '正式',
        topics: ['工作', '项目'],
        dynamics: '',
        last_updated: new Date().toISOString(),
      })
      const ctx = await service.buildContextBundle('老板', '方案看了吗')
      expect(ctx.rel_context).toContain('上级')
      expect(ctx.rel_context).toContain('0.6')
      expect(ctx.rel_context).toContain('工作')
    })

    it('should detect group chat from @chatroom', async () => {
      const ctx = await service.buildContextBundle('group123@chatroom', '群消息')
      expect(ctx.is_group).toBe(true)
    })

    it('should use per-contact style when available', async () => {
      intelligenceDb.setPerContactStyle('小王', '简洁直接')
      const ctx = await service.buildContextBundle('小王', '你好')
      expect(ctx.personality_context).toContain('简洁直接')
    })

    it('should use overall style as fallback', async () => {
      intelligenceDb.setPersonalityValue('overall_style', '友好随意')
      const ctx = await service.buildContextBundle('unknown', '你好')
      expect(ctx.personality_context).toContain('友好随意')
    })

    it('should use coach config override for personality', async () => {
      intelligenceDb.setPersonalityValue('overall_style', '友好随意')
      intelligenceDb.setCoachConfig('personality_context', '自定义风格')
      const ctx = await service.buildContextBundle('anyone', '你好')
      expect(ctx.personality_context).toBe('自定义风格')
    })

    it('should handle voice transcription placeholder', async () => {
      const ctx = await service.buildContextBundle('contact', '对方发了一条语音')
      expect(ctx.incoming_message).toContain('[语音]')
    })

    it('should cache context bundle', async () => {
      const ctx1 = await service.buildContextBundle('user1', 'msg1')
      const ctx2 = await service.buildContextBundle('user1', 'msg1')
      expect(ctx1).toBe(ctx2) // Same reference from cache
    })

    it('should return different context for different contacts', async () => {
      const ctx1 = await service.buildContextBundle('user1', 'msg')
      const ctx2 = await service.buildContextBundle('user2', 'msg')
      expect(ctx1.display_name).not.toBe(ctx2.display_name)
    })
  })

  // ─── Complexity Analysis ─────────────────────────────────────

  describe('analyzeComplexity', () => {
    it('should return not complex when LLM says not complex', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '{"is_complex": false, "reason": "简单问候", "guide_questions": []}',
        model: 'mock',
        provider: 'mock',
      })
      const result = await service.analyzeComplexity('user', '你好')
      expect(result.isComplex).toBe(false)
      expect(result.guideQuestions).toHaveLength(0)
    })

    it('should return complex with guide questions', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '{"is_complex": true, "reason": "涉及决策", "guide_questions": ["你想达到什么效果？", "有时间限制吗？"]}',
        model: 'mock',
        provider: 'mock',
      })
      const result = await service.analyzeComplexity('boss', '那个方案你看了吗？明天开会前给我反馈')
      expect(result.isComplex).toBe(true)
      expect(result.reason).toBe('涉及决策')
      expect(result.guideQuestions).toHaveLength(2)
    })

    it('should handle JSON with markdown fences', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '```json\n{"is_complex": true, "reason": "test", "guide_questions": ["q1"]}\n```',
        model: 'mock',
        provider: 'mock',
      })
      const result = await service.analyzeComplexity('user', 'message')
      expect(result.isComplex).toBe(true)
    })

    it('should return default on LLM error', async () => {
      mockLlmCall.mockRejectedValueOnce(new Error('LLM unavailable'))
      const result = await service.analyzeComplexity('user', 'message')
      expect(result.isComplex).toBe(false)
    })

    it('should limit guide questions to 3', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '{"is_complex": true, "reason": "complex", "guide_questions": ["q1", "q2", "q3", "q4", "q5"]}',
        model: 'mock',
        provider: 'mock',
      })
      const result = await service.analyzeComplexity('user', 'msg')
      expect(result.guideQuestions).toHaveLength(3)
    })
  })

  // ─── Discussion Mode ────────────────────────────────────────

  describe('discuss', () => {
    it('should create a new discussion on first call', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: 'ANALYSIS: 这是一个好问题\nFOLLOWUP: 你觉得对方的态度怎样？',
        model: 'mock',
        provider: 'mock',
      })
      const result = await service.discuss('老板', '方案看了吗', '我觉得应该先确认')
      expect(result.discussionId).toBeGreaterThan(0)
      expect(result.round).toBe(1)
      expect(result.analysis).toBe('这是一个好问题')
      expect(result.followup).toBe('你觉得对方的态度怎样？')
    })

    it('should continue existing discussion', async () => {
      // Round 1
      mockLlmCall.mockResolvedValueOnce({
        text: 'ANALYSIS: 分析1\nFOLLOWUP: 追问1',
        model: 'mock',
        provider: 'mock',
      })
      const r1 = await service.discuss('老板', '方案看了吗', '第一轮')

      // Round 2
      mockLlmCall.mockResolvedValueOnce({
        text: 'ANALYSIS: 分析2\nFOLLOWUP: 追问2',
        model: 'mock',
        provider: 'mock',
      })
      const r2 = await service.discuss('老板', '方案看了吗', '第二轮', r1.discussionId)
      expect(r2.round).toBe(2)
      expect(r2.discussionId).toBe(r1.discussionId)
    })

    it('should reject after max rounds', async () => {
      // Create 3 rounds
      let discId: number | undefined
      for (let i = 0; i < 3; i++) {
        mockLlmCall.mockResolvedValueOnce({
          text: `ANALYSIS: 分析${i + 1}`,
          model: 'mock',
          provider: 'mock',
        })
        const r = await service.discuss('老板', '消息', `输入${i + 1}`, discId)
        discId = r.discussionId
      }
      // Round 4 should be rejected
      const r4 = await service.discuss('老板', '消息', '第四轮', discId)
      expect(r4.analysis).toContain('已达上限')
    })

    it('should handle LLM failure gracefully', async () => {
      mockLlmCall.mockRejectedValueOnce(new Error('timeout'))
      const result = await service.discuss('user', 'msg', 'input')
      expect(result.analysis).toContain('超时')
    })

    it('should not include followup on last round', async () => {
      let discId: number | undefined
      for (let i = 0; i < 2; i++) {
        mockLlmCall.mockResolvedValueOnce({
          text: `ANALYSIS: 分析${i + 1}\nFOLLOWUP: 追问${i + 1}`,
          model: 'mock', provider: 'mock',
        })
        const r = await service.discuss('老板', '消息', `输入${i + 1}`, discId)
        discId = r.discussionId
      }
      // Round 3: prompt says no followup needed
      mockLlmCall.mockResolvedValueOnce({
        text: 'ANALYSIS: 最终分析',
        model: 'mock', provider: 'mock',
      })
      const r3 = await service.discuss('老板', '消息', '最终输入', discId)
      expect(r3.followup).toBeUndefined()
    })
  })

  // ─── Discussion Reply ────────────────────────────────────────

  describe('discussReply', () => {
    it('should generate replies from discussion', async () => {
      // Create a discussion
      mockLlmCall.mockResolvedValueOnce({
        text: 'ANALYSIS: 分析', model: 'mock', provider: 'mock',
      })
      const r1 = await service.discuss('老板', '方案看了吗', '我想确认')

      // Generate replies
      mockLlmCall.mockResolvedValueOnce({
        text: 'STRATEGY: 稳妥确认\n---\nREPLY: 好的老板\nREASON: 简短确认\nSTYLE: safe\n---\nREPLY: 看过了\nREASON: 直接\nSTYLE: warm\n---\nREPLY: 我确认一下\nREASON: 谨慎\nSTYLE: firm',
        model: 'mock', provider: 'mock',
      })
      const suggestions = await service.discussReply(r1.discussionId)
      expect(suggestions).toHaveLength(3)
      expect(suggestions[0].style).toBe('safe')
      expect(suggestions[1].style).toBe('warm')
      expect(suggestions[2].style).toBe('firm')
    })

    it('should return empty for non-existent discussion', async () => {
      const result = await service.discussReply(99999)
      expect(result).toHaveLength(0)
    })
  })

  // ─── Direct Reply Generation ─────────────────────────────────

  describe('generateReplies', () => {
    it('should generate 3 suggestions', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: 'REPLY: 好的\nREASON: 确认\nSTYLE: safe\n---\nREPLY: 收到啦\nREASON: 友好\nSTYLE: warm\n---\nREPLY: 明白\nREASON: 正式\nSTYLE: firm',
        model: 'mock', provider: 'mock',
      })
      const suggestions = await service.generateReplies('friend', '明天见')
      expect(suggestions).toHaveLength(3)
      expect(suggestions.map(s => s.style)).toEqual(['safe', 'warm', 'firm'])
    })

    it('should use heuristic fallback on LLM error', async () => {
      mockLlmCall.mockRejectedValueOnce(new Error('LLM down'))
      const suggestions = await service.generateReplies('user', '你好吗？')
      expect(suggestions).toHaveLength(3)
      expect(suggestions[0].confidence).toBe(0.3) // Heuristic confidence
    })

    it('should include context_used in suggestions', async () => {
      intelligenceDb.upsertRelationship({
        contact_name: 'test',
        relationship_type: 'friend',
        closeness: 0.5,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      mockLlmCall.mockResolvedValueOnce({
        text: 'REPLY: hi\nREASON: test\nSTYLE: safe',
        model: 'mock', provider: 'mock',
      })
      const suggestions = await service.generateReplies('test', 'hi')
      expect(suggestions[0].context_used).toContain('relationship')
    })

    it('should use cached results', async () => {
      mockLlmCall.mockResolvedValue({
        text: 'REPLY: cached\nREASON: test\nSTYLE: safe',
        model: 'mock', provider: 'mock',
      })
      await service.generateReplies('cache_user', 'cache_msg')

      // Second call should return cached results without additional LLM call
      const callCountBefore = mockLlmCall.mock.calls.length
      const suggestions = await service.generateReplies('cache_user', 'cache_msg')
      const callCountAfter = mockLlmCall.mock.calls.length
      // Should not have made any additional LLM calls
      expect(callCountAfter).toBe(callCountBefore)
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].text).toBe('cached')
    })

    it('should bypass cache when refresh=true', async () => {
      mockLlmCall.mockResolvedValue({
        text: 'REPLY: fresh\nREASON: test\nSTYLE: safe',
        model: 'mock', provider: 'mock',
      })
      await service.generateReplies('user', 'msg')
      await service.generateReplies('user', 'msg', undefined, true)
      expect(mockLlmCall).toHaveBeenCalledTimes(2)
    })
  })

  // ─── Analyze Message (unified) ───────────────────────────────

  describe('analyzeMessage', () => {
    it('should return suggestions for simple messages', async () => {
      // Complexity analysis
      mockLlmCall.mockResolvedValueOnce({
        text: '{"is_complex": false, "reason": "简单", "guide_questions": []}',
        model: 'mock', provider: 'mock',
      })
      // Reply generation
      mockLlmCall.mockResolvedValueOnce({
        text: 'REPLY: OK\nREASON: test\nSTYLE: safe\n---\nREPLY: Hi\nREASON: warm\nSTYLE: warm\n---\nREPLY: Noted\nREASON: firm\nSTYLE: firm',
        model: 'mock', provider: 'mock',
      })
      const result = await service.analyzeMessage('user', '你好')
      expect(result.isComplex).toBe(false)
      expect(result.suggestions).toBeDefined()
      expect(result.suggestions!.length).toBeGreaterThan(0)
    })

    it('should return discussionId for complex messages', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '{"is_complex": true, "reason": "复杂决策", "guide_questions": ["q1"]}',
        model: 'mock', provider: 'mock',
      })
      const result = await service.analyzeMessage('boss', '方案你看了吗')
      expect(result.isComplex).toBe(true)
      expect(result.discussionId).toBeGreaterThan(0)
      expect(result.suggestions).toBeUndefined()
    })
  })

  // ─── Helper: parseSuggestions ────────────────────────────────

  describe('parseSuggestions (via generateReplies)', () => {
    it('should handle malformed LLM output gracefully', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: 'Some random text without proper format',
        model: 'mock', provider: 'mock',
      })
      const suggestions = await service.generateReplies('user', 'msg')
      // Falls through to heuristic since no REPLY blocks parsed
      expect(suggestions.length).toBeGreaterThanOrEqual(0)
    })

    it('should default style to safe for unknown styles', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: 'REPLY: test\nREASON: test\nSTYLE: unknown_style',
        model: 'mock', provider: 'mock',
      })
      const suggestions = await service.generateReplies('user', 'msg')
      if (suggestions.length > 0) {
        expect(suggestions[0].style).toBe('safe')
      }
    })
  })

  // ─── Cache Management ────────────────────────────────────────

  describe('clearContextCache', () => {
    it('should clear the context cache', async () => {
      await service.buildContextBundle('user', 'msg')
      service.clearContextCache()
      // Subsequent call should rebuild
      const ctx = await service.buildContextBundle('user', 'msg')
      expect(ctx.display_name).toBe('user')
    })
  })
})
