/**
 * Briefing Service — generate actionable daily briefing from recent messages.
 *
 * Analyzes the past 24 hours of WeChat messages:
 * - Prioritizes starred contacts
 * - Extracts todo items (deadlines, reminders)
 * - Extracts schedule items (time expressions)
 * - Generates an LLM summary
 * - Stores briefing in daily_briefing table
 */

import type { IntelligenceDb } from './intelligenceDb'
import type { DailyBriefing, BriefingItem, LLMResponse } from './types'

/** Simplified message record for briefing analysis */
export interface BriefingMessage {
  sender: string
  content: string
  timestamp: number // epoch ms
  sessionId: string
  isGroup: boolean
}

/** LLM callable interface for dependency injection */
export interface BriefingLLM {
  complete(prompt: string, opts?: { systemPrompt?: string; maxTokens?: number }): Promise<string>
}

/** Structured briefing output for the frontend */
export interface BriefingOutput {
  date: string
  unrepliedCount: number
  priorityItems: Array<{ contact: string; summary: string; urgency: 'high' | 'medium' | 'low' }>
  todoItems: Array<{ content: string; source: string; deadline?: string }>
  scheduleItems: Array<{ content: string; source: string; time?: string }>
  activeContacts: Array<{ name: string; messageCount: number }>
  summary: string
}

// Keywords indicating a todo/action item
const TODO_KEYWORDS = /deadline|提交|记得|别忘了|截止|到期|必须|需要.*完成|赶紧|尽快|ASAP|urgent|紧急|务必/i
// Keywords indicating a schedule/event
const SCHEDULE_KEYWORDS = /(\d{1,2}[:.]\d{2})|明天|后天|下周|周[一二三四五六日]|今天.*点|今晚|今早|上午|下午|晚上|会议|开会|面试|约|见面/i
// Keywords indicating questions needing a reply
const QUESTION_KEYWORDS = /[？?]|能不能|可以吗|怎么|什么时候|有空|在吗|回复|回一下|收到.*请/i

// Time extraction pattern
const TIME_PATTERN = /(\d{1,2}[:.]\d{2})|((今天|明天|后天|下周[一二三四五六日]?)[\s,，]*(上午|下午|晚上)?[\s]*(\d{1,2}[:.点]\d{0,2})?)/i
// Deadline extraction pattern
const DEADLINE_PATTERN = /((\d{1,2}月\d{1,2}[日号])|((今天|明天|后天|本周[一二三四五六日]|下周[一二三四五六日])[\s]*(前|之前|以前)?)|(\d{4}-\d{2}-\d{2}))/i

const BRIEFING_SYSTEM_PROMPT = `你是一个日程管理助手。根据用户过去24小时收到的微信消息，生成今日简报。
重点关注：1.未回复的重要消息 2.含有截止日期的待办 3.日程安排 4.需要关注的群聊动态
输出JSON格式。`

export class BriefingService {
  private db: IntelligenceDb
  private llm: BriefingLLM | null

  constructor(db: IntelligenceDb, llm: BriefingLLM | null = null) {
    this.db = db
    this.llm = llm
  }

  /**
   * Generate a daily briefing from recent messages.
   */
  async generate(messages: BriefingMessage[]): Promise<BriefingOutput> {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)

    // Get preference sets for filtering
    const { starred, ignored } = this.db.getPreferenceSets()

    // Filter out ignored contacts
    const filtered = messages.filter(m => !ignored.has(m.sender))

    // Extract items
    const priorityItems = this._extractPriorityItems(filtered, starred)
    const todoItems = this._extractTodoItems(filtered)
    const scheduleItems = this._extractScheduleItems(filtered)
    const unrepliedCount = this._countUnreplied(filtered)
    const activeContacts = this._getActiveContacts(filtered)

    // Generate LLM summary
    let summary = ''
    if (this.llm && filtered.length > 0) {
      try {
        summary = await this._generateSummary(filtered, priorityItems, todoItems, scheduleItems)
      } catch {
        // fallback
      }
    }
    if (!summary) {
      summary = this._generateFallbackSummary(unrepliedCount, todoItems.length, scheduleItems.length)
    }

    // Build briefing items for DB storage
    const briefingItems: BriefingItem[] = [
      ...priorityItems.map(p => ({
        category: 'unreplied' as const,
        title: `${p.contact} 的消息待关注`,
        detail: p.summary,
        sourcePlatform: 'wechat',
        contact: p.contact,
        priority: p.urgency === 'high' ? 0 : p.urgency === 'medium' ? 1 : 2,
        recordId: '',
      })),
      ...todoItems.map(t => ({
        category: 'reminder' as const,
        title: t.content.slice(0, 50),
        detail: t.content,
        sourcePlatform: 'wechat',
        contact: t.source,
        priority: 1,
        recordId: '',
      })),
      ...scheduleItems.map(s => ({
        category: 'event' as const,
        title: s.content.slice(0, 50),
        detail: s.content,
        sourcePlatform: 'wechat',
        contact: s.source,
        priority: 1,
        recordId: '',
      })),
    ]

    // Save to DB
    const briefing: DailyBriefing = {
      date: dateStr,
      items: briefingItems,
      summary,
      generatedAt: now.toISOString(),
      modelUsed: this.llm ? 'llm' : 'local',
    }
    this.db.saveBriefing(briefing)

    return {
      date: dateStr,
      unrepliedCount,
      priorityItems,
      todoItems,
      scheduleItems,
      activeContacts,
      summary,
    }
  }

  /**
   * Get today's briefing from cache if available.
   */
  getCachedBriefing(): DailyBriefing | null {
    const today = new Date().toISOString().slice(0, 10)
    return this.db.getBriefing(today)
  }

  // ── Private helpers ──────────────────────────────────────────

  private _extractPriorityItems(
    messages: BriefingMessage[],
    starred: Set<string>,
  ): Array<{ contact: string; summary: string; urgency: 'high' | 'medium' | 'low' }> {
    // Group messages by sender
    const bySender = new Map<string, BriefingMessage[]>()
    for (const m of messages) {
      const existing = bySender.get(m.sender) || []
      existing.push(m)
      bySender.set(m.sender, existing)
    }

    const items: Array<{ contact: string; summary: string; urgency: 'high' | 'medium' | 'low' }> = []
    for (const [sender, msgs] of bySender) {
      const hasQuestion = msgs.some(m => QUESTION_KEYWORDS.test(m.content))
      if (!hasQuestion) continue

      let urgency: 'high' | 'medium' | 'low' = 'low'
      if (starred.has(sender)) {
        urgency = 'high'
      } else if (msgs.length >= 3 || msgs.some(m => TODO_KEYWORDS.test(m.content))) {
        urgency = 'medium'
      }

      const lastMsg = msgs[msgs.length - 1]
      items.push({
        contact: sender,
        summary: lastMsg.content.slice(0, 100),
        urgency,
      })
    }

    // Sort: high > medium > low, starred first
    const urgencyOrder = { high: 0, medium: 1, low: 2 }
    items.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency])
    return items
  }

  private _extractTodoItems(
    messages: BriefingMessage[],
  ): Array<{ content: string; source: string; deadline?: string }> {
    const items: Array<{ content: string; source: string; deadline?: string }> = []
    for (const m of messages) {
      if (TODO_KEYWORDS.test(m.content)) {
        const deadlineMatch = DEADLINE_PATTERN.exec(m.content)
        items.push({
          content: m.content.slice(0, 200),
          source: m.sender,
          deadline: deadlineMatch?.[0],
        })
      }
    }
    return items
  }

  private _extractScheduleItems(
    messages: BriefingMessage[],
  ): Array<{ content: string; source: string; time?: string }> {
    const items: Array<{ content: string; source: string; time?: string }> = []
    for (const m of messages) {
      if (SCHEDULE_KEYWORDS.test(m.content) && !TODO_KEYWORDS.test(m.content)) {
        const timeMatch = TIME_PATTERN.exec(m.content)
        items.push({
          content: m.content.slice(0, 200),
          source: m.sender,
          time: timeMatch?.[0],
        })
      }
    }
    return items
  }

  private _countUnreplied(messages: BriefingMessage[]): number {
    return messages.filter(m => QUESTION_KEYWORDS.test(m.content)).length
  }

  private _getActiveContacts(
    messages: BriefingMessage[],
  ): Array<{ name: string; messageCount: number }> {
    const counts = new Map<string, number>()
    for (const m of messages) {
      counts.set(m.sender, (counts.get(m.sender) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([name, messageCount]) => ({ name, messageCount }))
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 10)
  }

  private async _generateSummary(
    messages: BriefingMessage[],
    priorityItems: Array<{ contact: string; summary: string; urgency: string }>,
    todoItems: Array<{ content: string; source: string }>,
    scheduleItems: Array<{ content: string; source: string }>,
  ): Promise<string> {
    if (!this.llm) return ''

    const parts: string[] = []
    if (priorityItems.length > 0) {
      parts.push('待回复消息:')
      for (const p of priorityItems.slice(0, 5)) {
        parts.push(`- [${p.urgency}] ${p.contact}: ${p.summary}`)
      }
    }
    if (todoItems.length > 0) {
      parts.push('待办事项:')
      for (const t of todoItems.slice(0, 5)) {
        parts.push(`- ${t.source}: ${t.content.slice(0, 80)}`)
      }
    }
    if (scheduleItems.length > 0) {
      parts.push('日程安排:')
      for (const s of scheduleItems.slice(0, 5)) {
        parts.push(`- ${s.source}: ${s.content.slice(0, 80)}`)
      }
    }

    const prompt = `过去24小时的消息摘要:\n${parts.join('\n')}\n\n用一句话总结今天最重要的事情。只输出一句话。`

    return await this.llm.complete(prompt, {
      systemPrompt: BRIEFING_SYSTEM_PROMPT,
      maxTokens: 100,
    })
  }

  private _generateFallbackSummary(
    unreplied: number,
    todos: number,
    schedules: number,
  ): string {
    const parts: string[] = []
    if (unreplied > 0) parts.push(`${unreplied}条消息待回复`)
    if (todos > 0) parts.push(`${todos}项待办`)
    if (schedules > 0) parts.push(`${schedules}个日程`)
    if (parts.length === 0) return '今天没有需要特别注意的事情。'
    return `今天有${parts.join('、')}需要处理。`
  }
}
