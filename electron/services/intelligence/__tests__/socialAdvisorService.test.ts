import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  net: { request: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue('/tmp/weflow-test') },
}))

const mockLlmCall = vi.fn()
vi.mock('../llmService', () => ({
  llmService: {
    call: (...args: any[]) => mockLlmCall(...args),
  },
}))

vi.mock('../intelligenceDb', () => {
  const goals = new Map<string, any>()
  const relationships = new Map<string, any>()
  const contacts = new Map<string, any>()

  return {
    intelligenceDb: {
      resolve: (alias: string) => alias,
      getRelationship: (name: string) => relationships.get(name) || null,
      upsertRelationship: (rel: any) => relationships.set(rel.contact_name, rel),
      getContact: (name: string) => contacts.get(name) || null,
      upsertContact: (name: string, data: any) => {
        contacts.set(name, { name, ...data })
        _mockContacts.set(name, { name, ...data })
      },
      getAllContacts: () => Array.from(contacts.values()),
      createSocialGoal: (goal: any) => goals.set(goal.id, { ...goal, keywords: JSON.stringify(goal.keywords) }),
      listSocialGoals: () => Array.from(goals.values()),
      deleteSocialGoal: (id: string) => goals.delete(id),
      _reset: () => { goals.clear(); relationships.clear(); contacts.clear(); _mockContacts.clear() },
    },
  }
})

// Keep a reference to the mock db's contacts
const _mockContacts = new Map<string, any>()

vi.mock('../graphService', () => ({
  graphService: {
    getAllContacts: () => Array.from(_mockContacts.values()),
  },
}))

import { SocialAdvisorService } from '../socialAdvisorService'
import { intelligenceDb } from '../intelligenceDb'

describe('SocialAdvisorService', () => {
  let service: SocialAdvisorService

  beforeEach(() => {
    service = new SocialAdvisorService()
    mockLlmCall.mockReset()
    ;(intelligenceDb as any)._reset?.()
  })

  describe('goal management', () => {
    it('should create and list goals', () => {
      service.createGoal({
        id: 'g1',
        label: '进入 AI 圈',
        keywords: ['AI', 'LLM', '机器学习'],
        priority: 'primary',
      })
      const goals = service.listGoals()
      expect(goals).toHaveLength(1)
      expect(goals[0].label).toBe('进入 AI 圈')
    })

    it('should delete a goal', () => {
      service.createGoal({ id: 'g1', label: 'test', keywords: [], priority: 'primary' })
      expect(service.deleteGoal('g1')).toBe(true)
      expect(service.listGoals()).toHaveLength(0)
    })

    it('should return false when deleting non-existent goal', () => {
      expect(service.deleteGoal('nonexistent')).toBe(false)
    })
  })

  describe('scoreGroups', () => {
    it('should return neutral scores when no goals set', async () => {
      const scores = await service.scoreGroups([
        { id: 'g1', name: '群A', messageCount: 100, memberCount: 20 },
      ])
      expect(scores).toHaveLength(1)
      expect(scores[0].verdict).toBe('neutral')
    })

    it('should score groups based on goals', async () => {
      service.createGoal({
        id: 'g1',
        label: 'AI learning',
        keywords: ['AI', 'GPT', '模型'],
        priority: 'primary',
      })
      const scores = await service.scoreGroups([
        { id: 'g1', name: 'AI讨论群', messageCount: 200, memberCount: 50, recentMessages: ['今天GPT又更新了', 'AI模型很强'] },
        { id: 'g2', name: '闲聊群', messageCount: 10, memberCount: 5, recentMessages: ['今天天气不错'] },
      ])
      expect(scores).toHaveLength(2)
      // AI group should score higher
      expect(scores[0].groupName).toBe('AI讨论群')
    })

    it('should handle groups with myMessageCount', async () => {
      service.createGoal({
        id: 'g1', label: 'networking', keywords: ['人脉'], priority: 'primary',
      })
      const scores = await service.scoreGroups([
        { id: 'g1', name: '活跃群', messageCount: 100, memberCount: 20, myMessageCount: 30 },
      ])
      expect(scores[0].dimensionScores.reciprocity).toBeGreaterThan(0)
    })
  })

  describe('getExpansionRecommendations', () => {
    it('should recommend strengthening medium-closeness contacts', async () => {
      intelligenceDb.upsertContact('小王', { name: '小王', message_count: 50 })
      intelligenceDb.upsertRelationship({
        contact_name: '小王',
        relationship_type: 'colleague',
        closeness: 0.4,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      const recs = await service.getExpansionRecommendations()
      expect(recs.length).toBeGreaterThan(0)
      expect(recs[0].actionType).toBe('strengthen')
    })

    it('should recommend reconnecting with inactive contacts', async () => {
      intelligenceDb.upsertContact('老友', { name: '老友', message_count: 50 })
      intelligenceDb.upsertRelationship({
        contact_name: '老友',
        relationship_type: 'friend',
        closeness: 0.1,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      const recs = await service.getExpansionRecommendations()
      const reconnect = recs.find(r => r.contactName === '老友')
      expect(reconnect?.actionType).toBe('reconnect')
    })
  })

  describe('generateReport', () => {
    it('should generate a social report', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '社交网络整体健康，需要扩展行业人脉。',
        model: 'mock', provider: 'mock',
      })
      const report = await service.generateReport()
      expect(report.generatedAt).toBeDefined()
      expect(report.llmSummary).toContain('健康')
    })

    it('should identify blind spots', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '建议加强社交', model: 'mock', provider: 'mock',
      })
      const report = await service.generateReport()
      expect(report.blindSpots.length).toBeGreaterThan(0)
    })
  })
})
