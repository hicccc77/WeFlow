import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  net: { request: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue('/tmp/weflow-test') },
}))

// Use the same mock for intelligenceDb
vi.mock('../intelligenceDb', () => {
  const aliases = new Map<string, string>()
  const relationships = new Map<string, any>()
  const contacts = new Map<string, any>()

  return {
    intelligenceDb: {
      resolve: (alias: string) => aliases.get(alias) || alias,
      addAlias: (alias: string, canonical: string) => aliases.set(alias, canonical),
      addAliasesBulk: (mappings: Array<[string, string]>) => {
        for (const [a, c] of mappings) aliases.set(a, c)
      },
      getAliases: (name: string) => {
        const result: any[] = []
        for (const [a, c] of aliases.entries()) {
          if (c === name) result.push({ alias: a, canonicalName: c })
        }
        return result
      },
      getRelationship: (name: string) => relationships.get(name) || null,
      upsertRelationship: (rel: any) => relationships.set(rel.contact_name, rel),
      getContact: (name: string) => contacts.get(name) || null,
      upsertContact: (name: string, data: any) => contacts.set(name, { name, ...data }),
      getAllContacts: () => Array.from(contacts.values()),
      _reset: () => {
        aliases.clear(); relationships.clear(); contacts.clear()
      },
    },
  }
})

import { GraphService } from '../graphService'
import { intelligenceDb } from '../intelligenceDb'

describe('GraphService', () => {
  let service: GraphService

  beforeEach(() => {
    service = new GraphService()
    ;(intelligenceDb as any)._reset?.()
  })

  describe('resolve', () => {
    it('should resolve alias to canonical name', () => {
      intelligenceDb.addAlias('wxid_abc', '张三')
      expect(service.resolve('wxid_abc')).toBe('张三')
    })

    it('should return original name if no alias', () => {
      expect(service.resolve('unknown')).toBe('unknown')
    })
  })

  describe('getRelationship', () => {
    it('should return relationship for known contact', () => {
      intelligenceDb.upsertRelationship({
        contact_name: '老板',
        relationship_type: '上级',
        closeness: 0.7,
        communication_style: '正式',
        topics: ['工作'],
        dynamics: '',
        last_updated: '',
      })
      const rel = service.getRelationship('老板')
      expect(rel).not.toBeNull()
      expect(rel!.relationship_type).toBe('上级')
      expect(rel!.closeness).toBe(0.7)
    })

    it('should resolve alias before lookup', () => {
      intelligenceDb.addAlias('wxid_boss', '老板')
      intelligenceDb.upsertRelationship({
        contact_name: '老板',
        relationship_type: '上级',
        closeness: 0.7,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      const rel = service.getRelationship('wxid_boss')
      expect(rel).not.toBeNull()
      expect(rel!.relationship_type).toBe('上级')
    })

    it('should return null for unknown contact', () => {
      expect(service.getRelationship('nobody')).toBeNull()
    })
  })

  describe('applyMomentsWeight', () => {
    it('should increase closeness for existing relationship', () => {
      intelligenceDb.upsertRelationship({
        contact_name: '朋友',
        relationship_type: 'friend',
        closeness: 0.3,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      service.applyMomentsWeight('朋友', { likes: 5, comments: 2 })
      const rel = intelligenceDb.getRelationship('朋友')
      expect(rel!.closeness).toBeGreaterThan(0.3)
    })

    it('should create relationship for new contact', () => {
      service.applyMomentsWeight('新朋友', { likes: 3, comments: 1 })
      const rel = intelligenceDb.getRelationship('新朋友')
      expect(rel).not.toBeNull()
      expect(rel!.closeness).toBeGreaterThan(0)
    })

    it('should cap closeness at 1.0', () => {
      intelligenceDb.upsertRelationship({
        contact_name: 'close',
        relationship_type: 'friend',
        closeness: 0.99,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      service.applyMomentsWeight('close', { likes: 50, comments: 50 })
      const rel = intelligenceDb.getRelationship('close')
      expect(rel!.closeness).toBeLessThanOrEqual(1.0)
    })
  })

  describe('applyCrossGroupWeight', () => {
    it('should boost closeness for shared groups', () => {
      intelligenceDb.upsertRelationship({
        contact_name: '同事',
        relationship_type: 'colleague',
        closeness: 0.2,
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: '',
      })
      service.applyCrossGroupWeight('同事', ['群A', '群B', '群C'])
      const rel = intelligenceDb.getRelationship('同事')
      expect(rel!.closeness).toBeGreaterThan(0.2)
      expect(rel!.dynamics).toContain('群A')
    })

    it('should do nothing for empty shared groups', () => {
      service.applyCrossGroupWeight('user', [])
      const rel = intelligenceDb.getRelationship('user')
      expect(rel).toBeNull()
    })
  })

  describe('extractContacts', () => {
    it('should extract sender names from bracket format', () => {
      const content = '[张三] 你好\n[李四] 下午好\n[我] 嗯嗯'
      const contacts = service.extractContacts(content)
      expect(contacts).toContain('张三')
      expect(contacts).toContain('李四')
      expect(contacts).not.toContain('我')
    })

    it('should filter out non-person terms', () => {
      const content = '[系统消息] 通知\n[张三] 你好'
      const contacts = service.extractContacts(content)
      expect(contacts).not.toContain('系统消息')
      expect(contacts).toContain('张三')
    })
  })

  describe('buildFromMessages', () => {
    it('should build contacts from messages', async () => {
      const messages = [
        { contact: '小王', content: '你好', isGroup: false, timestamp: Date.now() / 1000 },
        { contact: '小王', content: '在吗', isGroup: false, timestamp: Date.now() / 1000 },
      ]
      const count = await service.buildFromMessages(messages)
      expect(count).toBe(1) // 1 unique contact
    })
  })
})
