import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContentHubService } from '../contentHubService'
import { ContentFilter } from '../types'

// Mock llmService
vi.mock('../llmService', () => ({
  llmService: {
    describeImage: vi.fn().mockResolvedValue('图片描述'),
    summarize: vi.fn().mockResolvedValue('文章摘要'),
    analyzeContent: vi.fn().mockResolvedValue('1. 核心要点\n2. 分享动机\n3. 关联分析\n4. 建议回应'),
    call: vi.fn().mockResolvedValue({ text: 'mock', model: 'mock', provider: 'mock' }),
  },
}))

// Mock mediaContextService
vi.mock('../mediaContextService', () => ({
  mediaContextService: {
    processArticle: vi.fn().mockResolvedValue({
      type: 'article',
      originalContent: '',
      processedContent: '[已解析的分享内容] 文章摘要内容',
    }),
  },
}))

describe('ContentHubService', () => {
  let service: ContentHubService

  beforeEach(() => {
    service = new ContentHubService()
    vi.clearAllMocks()
  })

  // ─── getContentFeed ─────────────────────────────────────────

  describe('getContentFeed', () => {
    it('returns mock data when no WCDB connected', async () => {
      const items = await service.getContentFeed()
      expect(items.length).toBeGreaterThan(0)
    })

    it('filters by content type', async () => {
      const filter: ContentFilter = { types: ['video-channel'] }
      const items = await service.getContentFeed(filter)
      for (const item of items) {
        expect(item.type).toBe('video-channel')
      }
    })

    it('filters by keyword', async () => {
      const filter: ContentFilter = { keyword: '深度学习' }
      const items = await service.getContentFeed(filter)
      for (const item of items) {
        const searchable = `${item.title} ${item.description || ''}`.toLowerCase()
        expect(searchable).toContain('深度学习')
      }
    })

    it('paginates results', async () => {
      const filter: ContentFilter = { page: 1, pageSize: 1 }
      const items = await service.getContentFeed(filter)
      expect(items.length).toBeLessThanOrEqual(1)
    })

    it('returns items with correct structure', async () => {
      const items = await service.getContentFeed()
      for (const item of items) {
        expect(item).toHaveProperty('id')
        expect(item).toHaveProperty('type')
        expect(item).toHaveProperty('title')
        expect(item).toHaveProperty('source')
        expect(item.source).toHaveProperty('contactName')
        expect(item.source).toHaveProperty('sessionId')
        expect(item.source).toHaveProperty('isGroup')
        expect(item).toHaveProperty('timestamp')
      }
    })

    it('handles WCDB query errors gracefully', async () => {
      service.setWcdbQuery(() => { throw new Error('DB error') })
      const items = await service.getContentFeed()
      expect(items).toEqual([])
    })
  })

  // ─── bookmarkContent / ignoreContent ────────────────────────

  describe('bookmark and ignore', () => {
    it('bookmarks a content item', async () => {
      await service.bookmarkContent('1001')
      expect(service.isBookmarked('1001')).toBe(true)
      expect(service.isIgnored('1001')).toBe(false)
    })

    it('ignores a content item', async () => {
      await service.ignoreContent('1001')
      expect(service.isIgnored('1001')).toBe(true)
      expect(service.isBookmarked('1001')).toBe(false)
    })

    it('bookmark removes ignore state', async () => {
      await service.ignoreContent('1001')
      await service.bookmarkContent('1001')
      expect(service.isBookmarked('1001')).toBe(true)
      expect(service.isIgnored('1001')).toBe(false)
    })

    it('ignore removes bookmark state', async () => {
      await service.bookmarkContent('1001')
      await service.ignoreContent('1001')
      expect(service.isIgnored('1001')).toBe(true)
      expect(service.isBookmarked('1001')).toBe(false)
    })
  })

  // ─── analyzeContent ────────────────────────────────────────

  describe('analyzeContent', () => {
    it('returns error for non-existent content', async () => {
      const result = await service.analyzeContent('999999')
      expect(result.summary).toContain('不存在')
    })

    it('returns analysis with correct structure', async () => {
      service.setWcdbQuery((sql, params) => {
        if (sql.includes('localId = ?')) {
          return [{
            localId: 1001,
            localType: 49,
            rawContent: '<msg><appmsg><type>5</type><title>Test Article</title><des>Test desc</des><url>https://example.com</url><sourceusername>gh_test</sourceusername></appmsg></msg>',
            createTime: Date.now() / 1000,
            sessionId: 'wxid_test@chatroom',
          }]
        }
        return []
      })

      const result = await service.analyzeContent('1001')
      expect(result).toHaveProperty('contentId', '1001')
      expect(result).toHaveProperty('summary')
      expect(result).toHaveProperty('senderContext')
      expect(result).toHaveProperty('analyzedAt')
    })

    it('includes graph relationship context when available', async () => {
      service.setWcdbQuery((sql) => {
        if (sql.includes('localId = ?')) {
          return [{
            localId: 1002,
            localType: 49,
            rawContent: '<msg><appmsg><type>5</type><title>Test</title><url>https://test.com</url><sourceusername>gh_abc</sourceusername></appmsg></msg>',
            createTime: Date.now() / 1000,
            sessionId: 'wxid_friend',
          }]
        }
        return []
      })
      service.setGraphService({
        getRelationship: vi.fn().mockResolvedValue({
          relationship_type: 'friend',
          closeness: 0.8,
          communication_style: '亲切',
        }),
      })

      const result = await service.analyzeContent('1002')
      expect(result.senderContext).toContain('关系')
    })
  })

  // ─── messageToContentItem ──────────────────────────────────

  describe('content item parsing', () => {
    it('parses file content items', async () => {
      service.setWcdbQuery(() => [{
        localId: 2001,
        localType: 49,
        rawContent: '<msg><appmsg><type>6</type><title>report.pdf</title><totallen>245000</totallen><fileext>pdf</fileext></appmsg></msg>',
        createTime: Date.now() / 1000,
        sessionId: 'wxid_test',
      }])

      const items = await service.getContentFeed({ types: ['file'] })
      expect(items.length).toBe(1)
      expect(items[0].type).toBe('file')
      expect(items[0].metadata?.fileExt).toBe('pdf')
    })

    it('parses miniapp content items', async () => {
      service.setWcdbQuery(() => [{
        localId: 2002,
        localType: 49,
        rawContent: '<msg><appmsg><type>33</type><title>天气查询</title><appname>天气助手</appname></appmsg></msg>',
        createTime: Date.now() / 1000,
        sessionId: 'wxid_test@chatroom',
      }])

      const items = await service.getContentFeed({ types: ['miniapp'] })
      expect(items.length).toBe(1)
      expect(items[0].type).toBe('miniapp')
      expect(items[0].source.isGroup).toBe(true)
    })

    it('skips unsupported xmlTypes', async () => {
      service.setWcdbQuery(() => [{
        localId: 2003,
        localType: 49,
        rawContent: '<msg><appmsg><type>2000</type><title>转账</title></appmsg></msg>',
        createTime: Date.now() / 1000,
        sessionId: 'wxid_test',
      }])

      const items = await service.getContentFeed()
      expect(items.length).toBe(0)
    })

    it('returns empty for messages with no content', async () => {
      service.setWcdbQuery(() => [{ localId: 2004, localType: 49, rawContent: '' }])
      const items = await service.getContentFeed()
      expect(items.length).toBe(0)
    })
  })

  // ─── filter combinations ──────────────────────────────────

  describe('filter source', () => {
    it('filters by private source', async () => {
      const items = await service.getContentFeed({ sources: ['private'] })
      for (const item of items) {
        expect(item.source.isGroup).toBe(false)
      }
    })

    it('filters by group source', async () => {
      const items = await service.getContentFeed({ sources: ['group'] })
      for (const item of items) {
        expect(item.source.isGroup).toBe(true)
      }
    })
  })
})
