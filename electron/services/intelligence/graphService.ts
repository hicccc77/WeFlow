/**
 * Social Graph Service — relationship tracking, cross-group analysis,
 * identity aliases, Moments weight, and shared group discovery.
 *
 * Ported from One's graph.py to TypeScript.
 */

import { Relationship, IdentityAlias } from './types'
import { intelligenceDb } from './intelligenceDb'

// ─── Constants ─────────────────────────────────────────────────

const NOT_PERSON = new Set([
  '时间', '费用', '地址', '地点', '电话', '联系', '价格', '日期',
  '备注', '说明', '主题', '标题', '内容', '通知', '公告', '提醒',
  '温馨提示', '注意事项', '活动', '报名', '签到', '接龙',
  '链接', '文件', '图片', '视频', '语音', '表情', '位置',
  '系统', '系统消息', '撤回', '红包', '转账',
  'am', 'pm', 'url', 'http', 'https',
  'time', 'date', 'cost', 'price', 'note', 'info', 'link', 'file',
])

const AI_ROLES = new Set([
  'assistant', 'claude', 'gpt', 'gpt-4', 'gpt-3.5', 'gemini', 'llama',
  'system', 'tool', 'bot', 'ai', 'copilot', 'openai', 'anthropic',
])

// ─── Service ───────────────────────────────────────────────────

export class GraphService {

  // ── Relationship Access ─────────────────────────────────────

  getRelationship(contactName: string): Relationship | null {
    const resolved = intelligenceDb.resolve(contactName)
    return intelligenceDb.getRelationship(resolved)
      || intelligenceDb.getRelationship(contactName)
  }

  updateRelationship(rel: Relationship): void {
    intelligenceDb.upsertRelationship(rel)
  }

  // ── Identity Aliases ────────────────────────────────────────

  resolve(name: string): string {
    return intelligenceDb.resolve(name)
  }

  addAlias(alias: string, canonicalName: string): void {
    intelligenceDb.addAlias(alias, canonicalName)
  }

  addAliasesBulk(mappings: Array<[string, string]>): void {
    intelligenceDb.addAliasesBulk(mappings)
  }

  getAliases(canonicalName: string): IdentityAlias[] {
    return intelligenceDb.getAliases(canonicalName)
  }

  // ── Moments (朋友圈) Weight Enhancement ─────────────────────

  /**
   * Increase closeness based on Moments interactions.
   * Likes increase by 0.02, comments by 0.05.
   */
  applyMomentsWeight(contactName: string, interactions: {
    likes: number
    comments: number
  }): void {
    const resolved = intelligenceDb.resolve(contactName)
    const rel = intelligenceDb.getRelationship(resolved)

    const likeWeight = 0.02
    const commentWeight = 0.05
    const boost = interactions.likes * likeWeight + interactions.comments * commentWeight

    if (rel) {
      const newCloseness = Math.min(1.0, rel.closeness + boost)
      intelligenceDb.upsertRelationship({
        ...rel,
        closeness: newCloseness,
        last_updated: new Date().toISOString(),
      })
    } else {
      intelligenceDb.upsertRelationship({
        contact_name: resolved,
        relationship_type: 'acquaintance',
        closeness: Math.min(1.0, boost),
        communication_style: '',
        topics: [],
        dynamics: '',
        last_updated: new Date().toISOString(),
      })
    }
  }

  // ── Cross-Group Analysis ────────────────────────────────────

  /**
   * Analyze shared group memberships to boost closeness.
   * People who share multiple groups are likely closer.
   */
  applyCrossGroupWeight(
    contactName: string,
    sharedGroups: string[],
  ): void {
    if (sharedGroups.length === 0) return

    const resolved = intelligenceDb.resolve(contactName)
    const rel = intelligenceDb.getRelationship(resolved)

    // Each shared group adds 0.03 closeness, diminishing after 3
    const boost = sharedGroups.slice(0, 5).reduce((acc, _, i) => {
      return acc + (i < 3 ? 0.03 : 0.01)
    }, 0)

    if (rel) {
      const newCloseness = Math.min(1.0, rel.closeness + boost)
      const existingTopics = rel.topics || []
      intelligenceDb.upsertRelationship({
        ...rel,
        closeness: newCloseness,
        dynamics: rel.dynamics
          ? `${rel.dynamics}；共同群聊：${sharedGroups.join('、')}`
          : `共同群聊：${sharedGroups.join('、')}`,
        last_updated: new Date().toISOString(),
      })
    } else {
      intelligenceDb.upsertRelationship({
        contact_name: resolved,
        relationship_type: 'acquaintance',
        closeness: Math.min(1.0, boost),
        communication_style: '',
        topics: [],
        dynamics: `共同群聊：${sharedGroups.join('、')}`,
        last_updated: new Date().toISOString(),
      })
    }
  }

  // ── Shared Group Discovery ──────────────────────────────────

  /**
   * Find groups where both the user and the specified contact are members.
   * Uses contact metadata to check group membership.
   */
  findSharedGroups(contactName: string): string[] {
    const resolved = intelligenceDb.resolve(contactName)
    const contact = intelligenceDb.getContact(resolved)
    if (!contact) return []

    const groups: string[] = []
    try {
      const contactGroups = JSON.parse(contact.groups || '[]')
      if (Array.isArray(contactGroups)) {
        groups.push(...contactGroups)
      }
    } catch { /* ignore parse errors */ }

    return groups
  }

  // ── Contact Extraction from Messages ────────────────────────

  /**
   * Extract contact names from message content.
   * Filters out known non-person terms and AI roles.
   */
  extractContacts(content: string): string[] {
    const bracketPattern = /^\[([^\[\]]{1,30})\]\s/gm
    const contacts = new Set<string>()
    let match: RegExpExecArray | null

    while ((match = bracketPattern.exec(content)) !== null) {
      const name = match[1].trim()
      if (name && !NOT_PERSON.has(name) && !AI_ROLES.has(name.toLowerCase()) && name !== '我') {
        contacts.add(name)
      }
    }

    return Array.from(contacts)
  }

  // ── Graph Building ──────────────────────────────────────────

  /**
   * Build/update social graph from a batch of messages.
   * Groups messages by contact, updates contacts and relationships.
   */
  async buildFromMessages(messages: Array<{
    contact: string
    content: string
    isGroup: boolean
    timestamp: number
    senders?: string[]
  }>): Promise<number> {
    // Build identity map from senders
    const identityMappings: Array<[string, string]> = []
    for (const msg of messages) {
      if (msg.senders) {
        for (const sender of msg.senders) {
          if (sender && msg.contact && sender !== msg.contact) {
            identityMappings.push([sender, msg.contact])
          }
        }
      }
    }
    if (identityMappings.length > 0) {
      this.addAliasesBulk(identityMappings)
    }

    // Group by contact
    const byContact = new Map<string, typeof messages>()
    for (const msg of messages) {
      const resolved = this.resolve(msg.contact)
      const existing = byContact.get(resolved) || []
      existing.push(msg)
      byContact.set(resolved, existing)
    }

    let updated = 0
    for (const [contactName, contactMsgs] of byContact.entries()) {
      // Update contact record
      const messageCount = contactMsgs.length
      const isGroup = contactMsgs.some(m => m.isGroup)
      const timestamps = contactMsgs.map(m => m.timestamp).sort()

      intelligenceDb.upsertContact(contactName, {
        platform: 'wechat',
        message_count: messageCount,
        is_group: isGroup,
        first_seen: new Date(timestamps[0] * 1000).toISOString(),
        last_seen: new Date(timestamps[timestamps.length - 1] * 1000).toISOString(),
      })

      // Extract topics from content
      const allContent = contactMsgs.map(m => m.content).join('\n')
      const extractedContacts = this.extractContacts(allContent)

      // Update relationship
      const existing = intelligenceDb.getRelationship(contactName)
      if (!existing) {
        intelligenceDb.upsertRelationship({
          contact_name: contactName,
          relationship_type: isGroup ? 'group' : 'acquaintance',
          closeness: Math.min(1.0, messageCount * 0.01),
          communication_style: '',
          topics: [],
          dynamics: '',
          last_updated: new Date().toISOString(),
        })
      }

      updated++
    }

    return updated
  }

  // ── All Relationships ────────────────────────────────────────

  getAllContacts(): any[] {
    return intelligenceDb.getAllContacts()
  }

  // ── Graph Visualization Data ───────────────────────────────────

  getNodes(): any[] {
    const contacts = intelligenceDb.getAllContacts()
    const relationships = intelligenceDb.listRelationships()
    const relMap = new Map(relationships.map((r: any) => [r.contact_name, r]))

    const nodes: any[] = [
      { id: 'me', name: '我', category: 0, symbolSize: 50, value: 100, groups: [] },
    ]

    for (const contact of contacts) {
      const rel = relMap.get(contact.name)
      const closeness = rel?.closeness || 0
      const category = closeness > 0.6 ? 1 : closeness > 0.3 ? 2 : 3
      nodes.push({
        id: contact.name,
        name: contact.name,
        category,
        symbolSize: Math.max(20, Math.min(50, (contact.message_count || 0) * 0.3 + 15)),
        value: contact.message_count || 0,
        groups: contact.aliases || [],
      })
    }

    return nodes
  }

  getEdges(): any[] {
    const relationships = intelligenceDb.listRelationships()
    return relationships.map((r: any) => ({
      source: 'me',
      target: r.contact_name,
      value: Math.max(1, Math.round((r.closeness || 0) * 10)),
    }))
  }

  getContactDetail(contactId: string): any {
    const rel = intelligenceDb.getRelationship(contactId)
    const contact = intelligenceDb.getContact(contactId)
    const sharedGroups = this.findSharedGroups(contactId)

    return {
      name: contactId,
      relationship_type: rel?.relationship_type || '联系人',
      closeness: rel?.closeness || 0,
      communication_style: rel?.communication_style || '',
      topics: rel?.topics || [],
      frequency: contact?.message_count || 0,
      lastContact: contact?.last_seen || '未知',
      shared_groups: sharedGroups,
    }
  }
}

export const graphService = new GraphService()
