/**
 * Content Hub Service — aggregate and index rich media content from WCDB
 *
 * Exports:
 * - ContentHubService class: content aggregation + AI analysis
 * - contentHubService: singleton instance
 *
 * Features:
 * - Scan all type 49 messages from WCDB, classify by xmlType
 * - Filter by type, source, contact, time range
 * - AI analysis with context assembly (content + sender + conversation + topic)
 * - Bookmark and ignore content items
 *
 * IPC Channels:
 * - 'intel:getContentFeed': (filters: ContentFilter) => Promise<ContentItem[]>
 * - 'intel:analyzeContent': (contentId: string) => Promise<ContentAnalysis>
 * - 'intel:bookmarkContent': (contentId: string) => Promise<void>
 * - 'intel:ignoreContent': (contentId: string) => Promise<void>
 */

import { ContentFilter, ContentItem, ContentAnalysis } from './types'
import { llmService } from './llmService'
import { mediaContextService } from './mediaContextService'

// ─── Content Type Mapping ───────────────────────────────────────

type ContentType = ContentItem['type']

function xmlTypeToContentType(xmlType: string, sourceUsername?: string): ContentType | null {
  switch (xmlType) {
    case '5':
    case '49':
      if (sourceUsername?.startsWith('gh_')) return 'official-article'
      return 'link'
    case '51':
      return 'video-channel'
    case '6':
      return 'file'
    case '33':
    case '36':
      return 'miniapp'
    default:
      return null
  }
}

// ─── Service ────────────────────────────────────────────────────

export class ContentHubService {
  // External dependencies — injected for testability
  private wcdbQuery: ((sql: string, params?: any[]) => any[]) | null = null
  private graphService: any = null
  private chatService: any = null

  private bookmarks = new Set<string>()
  private ignored = new Set<string>()

  setWcdbQuery(queryFn: (sql: string, params?: any[]) => any[]): void {
    this.wcdbQuery = queryFn
  }

  setGraphService(service: any): void {
    this.graphService = service
  }

  setChatService(service: any): void {
    this.chatService = service
  }

  /**
   * Get content feed with filters.
   * Scans WCDB for type 49 messages and returns structured content items.
   */
  async getContentFeed(filters: ContentFilter = {}): Promise<ContentItem[]> {
    const rawMessages = this.queryContentMessages(filters)
    const items: ContentItem[] = []

    for (const msg of rawMessages) {
      const item = this.messageToContentItem(msg)
      if (!item) continue

      // Apply type filter
      if (filters.types?.length && !filters.types.includes(item.type)) continue

      // Apply source filter
      if (filters.sources?.length) {
        const source = item.source.isGroup ? 'group' : 'private'
        if (!filters.sources.includes(source as any)) continue
      }

      // Apply contact filter
      if (filters.contactId && item.source.contactName !== filters.contactId) continue

      // Apply keyword filter
      if (filters.keyword) {
        const kw = filters.keyword.toLowerCase()
        const searchable = `${item.title} ${item.description || ''} ${item.source.contactName}`.toLowerCase()
        if (!searchable.includes(kw)) continue
      }

      // Apply bookmark/ignore state
      item.bookmarked = this.bookmarks.has(item.id)
      item.ignored = this.ignored.has(item.id)

      items.push(item)
    }

    // Pagination
    const page = filters.page || 1
    const pageSize = filters.pageSize || 50
    const start = (page - 1) * pageSize
    return items.slice(start, start + pageSize)
  }

  /**
   * AI analysis of a content item.
   * Assembles context from content + sender + conversation + topic.
   */
  async analyzeContent(contentId: string): Promise<ContentAnalysis> {
    const item = await this.getContentItemById(contentId)

    if (!item) {
      return {
        contentId,
        summary: '内容不存在或已过期',
        senderContext: '',
        motivation: '',
        relevance: '',
        suggestedResponse: '',
        analyzedAt: new Date().toISOString(),
      }
    }

    // 1. Content extraction
    let contentText = `${item.title}\n${item.description || ''}`
    if (item.url && (item.type === 'official-article' || item.type === 'link')) {
      try {
        const mediaCtx = await mediaContextService.processArticle(item.url, item.title, item.description)
        if (mediaCtx.processedContent) {
          contentText = mediaCtx.processedContent
        }
      } catch {
        // Use title+description fallback
      }
    }

    // 2. Sender context
    let senderContext = `发送者: ${item.source.contactName}`
    if (this.graphService) {
      try {
        const relationship = await this.graphService.getRelationship?.(item.source.contactName)
        if (relationship) {
          senderContext += `\n关系: ${relationship.relationship_type}`
          senderContext += `\n亲密度: ${relationship.closeness}`
          senderContext += `\n沟通风格: ${relationship.communication_style}`
        }
      } catch {
        // Use basic sender info
      }
    }

    // 3. Conversation context
    let conversationContext = ''
    if (this.chatService) {
      try {
        const surroundingMessages = await this.getSurroundingMessages(item)
        if (surroundingMessages.length > 0) {
          conversationContext = '对话上下文:\n' + surroundingMessages
            .map((m: any) => `${m.sender || '未知'}: ${m.content || ''}`)
            .join('\n')
        }
      } catch {
        // No conversation context
      }
    }

    // 4. Assemble prompt and call LLM
    const prompt = [
      `## 分享的内容`,
      contentText,
      '',
      `## ${senderContext}`,
      item.source.isGroup ? `来源群聊: ${item.source.sessionName || item.source.sessionId}` : '',
      '',
      conversationContext ? `## ${conversationContext}` : '',
      '',
      `请分析：`,
      `1. 内容核心要点（3句话以内）`,
      `2. 对方分享这个内容的可能动机`,
      `3. 这个内容与用户当前处境的关联`,
      `4. 建议的回应方式`,
    ].filter(Boolean).join('\n')

    try {
      const analysisText = await llmService.analyzeContent(prompt)

      // Parse analysis into structured fields
      const analysis = this.parseAnalysis(analysisText)

      return {
        contentId,
        summary: analysis.summary || '(分析失败)',
        senderContext,
        motivation: analysis.motivation || '',
        relevance: analysis.relevance || '',
        suggestedResponse: analysis.suggestedResponse || '',
        analyzedAt: new Date().toISOString(),
      }
    } catch {
      return {
        contentId,
        summary: '(AI分析暂不可用)',
        senderContext,
        motivation: '',
        relevance: '',
        suggestedResponse: '',
        analyzedAt: new Date().toISOString(),
      }
    }
  }

  /**
   * Bookmark a content item
   */
  async bookmarkContent(contentId: string): Promise<void> {
    this.bookmarks.add(contentId)
    this.ignored.delete(contentId)
  }

  /**
   * Ignore a content item
   */
  async ignoreContent(contentId: string): Promise<void> {
    this.ignored.add(contentId)
    this.bookmarks.delete(contentId)
  }

  /**
   * Check if a content item is bookmarked
   */
  isBookmarked(contentId: string): boolean {
    return this.bookmarks.has(contentId)
  }

  /**
   * Check if a content item is ignored
   */
  isIgnored(contentId: string): boolean {
    return this.ignored.has(contentId)
  }

  // ─── Internal ───────────────────────────────────────────────

  private queryContentMessages(filters: ContentFilter): any[] {
    if (!this.wcdbQuery) {
      return this.getMockMessages()
    }

    try {
      let sql = `SELECT localId, type as localType, content as rawContent, createTime, talker as sessionId FROM message WHERE type = 49`
      const params: any[] = []

      if (filters.timeRange) {
        sql += ` AND createTime >= ? AND createTime <= ?`
        params.push(filters.timeRange.start, filters.timeRange.end)
      }

      sql += ` ORDER BY createTime DESC`

      const limit = (filters.pageSize || 50) * 3 // Over-fetch for filtering
      sql += ` LIMIT ?`
      params.push(limit)

      return this.wcdbQuery(sql, params)
    } catch {
      return []
    }
  }

  private messageToContentItem(msg: any): ContentItem | null {
    const rawContent = msg.rawContent || msg.content || ''
    if (!rawContent) return null

    // Extract xmlType
    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(rawContent)
    let xmlType = ''
    if (appmsgMatch) {
      const inner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(inner)
      if (typeMatch) xmlType = typeMatch[1].trim()
    }
    if (!xmlType) return null

    // Extract common fields
    const title = this.extractXmlVal(rawContent, 'title')
    const url = this.extractXmlVal(rawContent, 'url')
    const desc = this.extractXmlVal(rawContent, 'des') || this.extractXmlVal(rawContent, 'description')
    const thumbUrl = this.extractXmlVal(rawContent, 'thumburl') || this.extractXmlVal(rawContent, 'cdnthumburl')
    const sourceUsername = this.extractXmlVal(rawContent, 'sourceusername')
    const sourceName = this.extractXmlVal(rawContent, 'sourcename')
    const appName = this.extractXmlVal(rawContent, 'appname')

    const contentType = xmlTypeToContentType(xmlType, sourceUsername || undefined)
    if (!contentType) return null

    const sessionId = msg.sessionId || msg.talker || ''
    const isGroup = sessionId.endsWith('@chatroom')

    const item: ContentItem = {
      id: `${msg.localId}`,
      type: contentType,
      title: title || appName || '(无标题)',
      description: desc || undefined,
      url: url || undefined,
      thumbnailUrl: thumbUrl || undefined,
      source: {
        contactName: msg.sender || sourceName || sessionId,
        sessionId,
        sessionName: isGroup ? sessionId : undefined,
        isGroup,
      },
      timestamp: msg.createTime || 0,
    }

    // Type-specific metadata
    if (contentType === 'file') {
      const fileName = this.extractXmlVal(rawContent, 'filename') || title
      const fileSizeStr = this.extractXmlVal(rawContent, 'totallen') || this.extractXmlVal(rawContent, 'filesize')
      const fileExt = this.extractXmlVal(rawContent, 'fileext')
      item.metadata = {
        fileName,
        fileSize: fileSizeStr ? parseInt(fileSizeStr, 10) : undefined,
        fileExt,
      }
    } else if (contentType === 'video-channel') {
      const finderNickname = this.extractXmlVal(rawContent, 'findernickname') || this.extractXmlVal(rawContent, 'finder_nickname')
      const durationStr = this.extractXmlVal(rawContent, 'videoPlayDuration') || this.extractXmlVal(rawContent, 'duration')
      item.metadata = {
        creator: finderNickname,
        duration: durationStr ? parseInt(durationStr, 10) : undefined,
      }
    } else if (contentType === 'miniapp') {
      item.metadata = { appName: appName || sourceName }
    }

    return item
  }

  private extractXmlVal(content: string, tag: string): string | undefined {
    const regex = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`, 'i')
    const match = regex.exec(content)
    return match ? match[1].trim() || undefined : undefined
  }

  private async getContentItemById(contentId: string): Promise<ContentItem | null> {
    if (!this.wcdbQuery) return null

    try {
      const results = this.wcdbQuery(
        `SELECT localId, type as localType, content as rawContent, createTime, talker as sessionId FROM message WHERE localId = ?`,
        [parseInt(contentId, 10)]
      )
      if (results.length === 0) return null
      return this.messageToContentItem(results[0])
    } catch {
      return null
    }
  }

  private async getSurroundingMessages(item: ContentItem): Promise<any[]> {
    if (!this.wcdbQuery) return []

    try {
      const localId = parseInt(item.id, 10)
      // Get 3 messages before and after
      const results = this.wcdbQuery(
        `SELECT localId, content, talker, createTime FROM message
         WHERE talker = ? AND localId BETWEEN ? AND ?
         ORDER BY createTime ASC
         LIMIT 7`,
        [item.source.sessionId, localId - 5, localId + 5]
      )
      return results
    } catch {
      return []
    }
  }

  private parseAnalysis(text: string): {
    summary: string
    motivation: string
    relevance: string
    suggestedResponse: string
  } {
    // Simple numbered-section parser
    const sections = text.split(/\d+\.\s*/)
    return {
      summary: sections[1]?.trim() || text.slice(0, 200),
      motivation: sections[2]?.trim() || '',
      relevance: sections[3]?.trim() || '',
      suggestedResponse: sections[4]?.trim() || '',
    }
  }

  private getMockMessages(): any[] {
    // Mock data for testing without WCDB
    return [
      {
        localId: 1001,
        localType: 49,
        rawContent: '<msg><appmsg><type>5</type><title>深度学习在金融领域的应用</title><des>AI量化交易的三种主流方案</des><url>https://mp.weixin.qq.com/s/test123</url><sourceusername>gh_abc123</sourceusername><sourcename>技术周刊</sourcename></appmsg></msg>',
        createTime: Math.floor(Date.now() / 1000) - 86400,
        sessionId: 'wxid_test@chatroom',
        sender: '王泽旺',
      },
      {
        localId: 1002,
        localType: 49,
        rawContent: '<msg><appmsg><type>51</type><title>极视角港股上市现场直播</title><findernickname>极视角</findernickname><thumbUrl>https://example.com/cover.jpg</thumbUrl></appmsg></msg>',
        createTime: Math.floor(Date.now() / 1000) - 172800,
        sessionId: 'wxid_test2@chatroom',
        sender: '刘富胜',
      },
    ]
  }
}

export const contentHubService = new ContentHubService()
