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
  const personality = new Map<string, string>()
  const perContactStyle = new Map<string, string>()
  const contacts = new Map<string, any>()

  return {
    intelligenceDb: {
      resolve: (alias: string) => alias,
      getPersonalityValue: (key: string) => personality.get(key) || '',
      setPersonalityValue: (key: string, value: string) => personality.set(key, value),
      getPerContactStyle: (name: string) => perContactStyle.get(name) || '',
      setPerContactStyle: (name: string, style: string) => perContactStyle.set(name, style),
      getAllContacts: () => Array.from(contacts.values()),
      upsertContact: (name: string, data: any) => contacts.set(name, { name, ...data }),
      getRelationship: vi.fn().mockReturnValue(null),
      _reset: () => { personality.clear(); perContactStyle.clear(); contacts.clear() },
    },
  }
})

import { PersonalityService } from '../personalityService'
import { intelligenceDb } from '../intelligenceDb'

describe('PersonalityService', () => {
  let service: PersonalityService

  beforeEach(() => {
    service = new PersonalityService()
    mockLlmCall.mockReset()
    ;(intelligenceDb as any)._reset?.()
  })

  describe('getProfile', () => {
    it('should return empty profile initially', () => {
      const profile = service.getProfile()
      expect(profile.overallStyle).toBe('')
      expect(Object.keys(profile.perContactStyle)).toHaveLength(0)
    })

    it('should return stored profile data', () => {
      intelligenceDb.setPersonalityValue('overall_style', '简洁直接')
      const profile = service.getProfile()
      expect(profile.overallStyle).toBe('简洁直接')
    })
  })

  describe('setOverallStyle', () => {
    it('should save overall style', () => {
      service.setOverallStyle('友好随意')
      expect(intelligenceDb.getPersonalityValue('overall_style')).toBe('友好随意')
    })
  })

  describe('getContactStyle / setContactStyle', () => {
    it('should get and set per-contact style', () => {
      service.setContactStyle('老板', '正式尊重')
      expect(service.getContactStyle('老板')).toBe('正式尊重')
    })

    it('should return empty for unknown contact', () => {
      expect(service.getContactStyle('nobody')).toBe('')
    })
  })

  describe('analyzeContactStyle', () => {
    it('should analyze messages and save style', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '简洁直接，偶尔使用emoji，语气随意',
        model: 'mock', provider: 'mock',
      })
      const style = await service.analyzeContactStyle('小王', [
        { sender: '小王', content: '你好', isSend: false },
        { sender: '我', content: '在的没问题', isSend: true },
        { sender: '我', content: '明天见吧好的', isSend: true },
        { sender: '我', content: '好的收到了谢谢', isSend: true },
      ])
      expect(style).toContain('简洁')
    })

    it('should require minimum messages', async () => {
      const style = await service.analyzeContactStyle('test', [
        { sender: '我', content: 'hi', isSend: true },
      ])
      expect(style).toContain('不足')
    })
  })

  describe('analyzeOverallStyle', () => {
    it('should analyze and save overall style', async () => {
      mockLlmCall.mockResolvedValueOnce({
        text: '用户沟通风格偏简洁，少用emoji',
        model: 'mock', provider: 'mock',
      })
      const profile = await service.analyzeOverallStyle([
        { sender: '我', content: '好的收到', isSend: true, timestamp: Date.now() / 1000 },
        { sender: '我', content: '明白了', isSend: true, timestamp: Date.now() / 1000 },
        { sender: '我', content: '可以的', isSend: true, timestamp: Date.now() / 1000 },
        { sender: '我', content: '我来处理', isSend: true, timestamp: Date.now() / 1000 },
        { sender: '对方', content: '你好', isSend: false, timestamp: Date.now() / 1000 },
      ])
      expect(profile.overallStyle).toContain('简洁')
    })
  })

  describe('updateFromFingerprint', () => {
    it('should update preferences from fingerprint metrics', () => {
      intelligenceDb.setPersonalityValue('communication_preferences', JSON.stringify({
        messageLength: 'medium',
        emojiUsage: 'moderate',
        formalityLevel: 'neutral',
        responseSpeed: 'medium',
      }))

      service.updateFromFingerprint({
        periodStart: '', periodEnd: '',
        dimensions: {},
        rawMetrics: { avg_content_length: 10, emoji_rate: 0 },
        generatedAt: '',
      })

      const prefs = JSON.parse(intelligenceDb.getPersonalityValue('communication_preferences'))
      expect(prefs.messageLength).toBe('short')
      expect(prefs.emojiUsage).toBe('none')
    })
  })

  describe('detectStyleChanges', () => {
    it('should detect when messages get longer', () => {
      // Style must contain '简短' to trigger detection
      service.setContactStyle('test', '简短消息，语气随意')
      // Each message needs to be > 80 chars so avgLen > 80
      const longMsg = '这是一条很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的消息。这条消息非常非常长。'
      const change = service.detectStyleChanges('test', [
        { content: longMsg, isSend: true },
        { content: longMsg + '额外2', isSend: true },
        { content: longMsg + '额外3', isSend: true },
        { content: longMsg + '额外4', isSend: true },
        { content: longMsg + '额外5', isSend: true },
      ])
      expect(change).not.toBeNull()
      expect(change!.reason).toContain('长度')
    })

    it('should return null when no style is set', () => {
      const change = service.detectStyleChanges('unknown', [
        { content: '消息', isSend: true },
      ])
      expect(change).toBeNull()
    })
  })
})
