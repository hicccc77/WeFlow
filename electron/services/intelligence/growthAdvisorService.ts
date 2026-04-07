/**
 * Growth Advisor Service — analyze communication data for personal growth insights.
 *
 * Analyzes:
 * - Communication patterns (response time, message length, active hours)
 * - Social circle quality (contact diversity, relationship depth)
 * - Topic distribution (what the user talks about)
 * - Productivity patterns (platform usage, AI tool adoption)
 *
 * Generates actionable growth suggestions and weekly goals.
 */

import type { IntelligenceDb } from './intelligenceDb'
import type { GrowthInsight, GrowthReport } from './types'

/** Simplified message record for growth analysis */
export interface GrowthMessage {
  sender: string
  content: string
  timestamp: number // epoch ms
  sessionId: string
  isGroup: boolean
  isSelf: boolean
}

/** LLM callable interface for dependency injection */
export interface GrowthLLM {
  complete(prompt: string, opts?: { systemPrompt?: string; maxTokens?: number }): Promise<string>
}

const GROWTH_SYSTEM_PROMPT = `你是一个个人成长顾问。基于用户的微信沟通数据，分析其沟通模式和社交健康度，提供具体可操作的成长建议。
重点关注：沟通质量、时间管理、社交圈质量、学习成长。
语气温和但坦诚，像一个好朋友给建议。`

export class GrowthAdvisorService {
  private db: IntelligenceDb
  private llm: GrowthLLM | null

  constructor(db: IntelligenceDb, llm: GrowthLLM | null = null) {
    this.db = db
    this.llm = llm
  }

  /**
   * Generate a growth report from recent messages.
   */
  async analyze(messages: GrowthMessage[], periodDays = 7): Promise<GrowthReport> {
    const insights: GrowthInsight[] = []

    insights.push(...this._analyzeCommunication(messages))
    insights.push(...this._analyzeSocial(messages))
    insights.push(...this._analyzeProductivity(messages))
    insights.push(...this._analyzeLearning(messages))

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    insights.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

    const strengths = this._identifyStrengths(messages, insights)
    const areasToImprove = this._identifyAreas(insights)
    const weeklyGoals = this._generateGoals(insights)

    // LLM summary
    let summary = ''
    if (this.llm && insights.length > 0) {
      try {
        summary = await this._generateSummary(insights, strengths, areasToImprove)
      } catch {
        // fallback
      }
    }
    if (!summary) {
      summary = this._generateFallbackSummary(insights, strengths)
    }

    return {
      periodDays,
      insights,
      strengths,
      areasToImprove,
      weeklyGoals,
      summary,
      generatedAt: new Date().toISOString(),
    }
  }

  // ── Communication Analysis ───────────────────────────────────

  private _analyzeCommunication(messages: GrowthMessage[]): GrowthInsight[] {
    const insights: GrowthInsight[] = []
    const selfMessages = messages.filter(m => m.isSelf)

    if (selfMessages.length === 0) return insights

    // Active hours analysis
    const hourCounts = new Map<number, number>()
    for (const m of selfMessages) {
      const hour = new Date(m.timestamp).getHours()
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
    }
    const peakHours = [...hourCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h]) => h)

    if (peakHours.some(h => h >= 23 || h <= 4)) {
      insights.push({
        category: 'communication',
        observation: '你经常在深夜回复消息',
        suggestion: '尝试在白天处理消息，保证睡眠质量。可以设置「勿扰模式」',
        evidence: `过去一周在 ${peakHours.join(', ')} 点最活跃`,
        priority: 'medium',
      })
    }

    // Message length analysis
    const avgLen = selfMessages.reduce((sum, m) => sum + m.content.length, 0) / selfMessages.length
    if (avgLen < 20) {
      insights.push({
        category: 'communication',
        observation: '你的消息平均很短（不到20字）',
        suggestion: '短消息有时会让对方觉得不够重视。对重要的人，可以尝试多说一些',
        evidence: `平均消息长度 ${Math.round(avgLen)} 字`,
        priority: 'low',
      })
    } else if (avgLen > 200) {
      insights.push({
        category: 'communication',
        observation: '你的消息通常很长',
        suggestion: '长消息阅读成本高。考虑分段发送或提炼要点',
        evidence: `平均消息长度 ${Math.round(avgLen)} 字`,
        priority: 'low',
      })
    }

    return insights
  }

  // ── Social Analysis ──────────────────────────────────────────

  private _analyzeSocial(messages: GrowthMessage[]): GrowthInsight[] {
    const insights: GrowthInsight[] = []

    // Contact diversity
    const contacts = new Set(messages.filter(m => !m.isSelf).map(m => m.sender))
    const contactCount = contacts.size

    if (contactCount <= 3 && messages.length > 20) {
      insights.push({
        category: 'social',
        observation: `过去一周你只和 ${contactCount} 个人交流`,
        suggestion: '社交圈较窄。可以主动联系老朋友或参加新活动',
        evidence: `活跃联系人仅 ${contactCount} 位`,
        priority: 'medium',
      })
    }

    // Group vs private ratio
    const groupMessages = messages.filter(m => m.isGroup)
    const privateMessages = messages.filter(m => !m.isGroup)
    if (groupMessages.length > privateMessages.length * 3 && privateMessages.length > 0) {
      insights.push({
        category: 'social',
        observation: '群聊消息远多于私聊',
        suggestion: '群聊信息密度较低。考虑多花时间在深度私聊上',
        evidence: `群聊 ${groupMessages.length} 条 vs 私聊 ${privateMessages.length} 条`,
        priority: 'low',
      })
    }

    // Check starred contacts interaction
    const { starred } = this.db.getPreferenceSets()
    if (starred.size > 0) {
      const starredInteractions = messages.filter(m => starred.has(m.sender)).length
      if (starredInteractions === 0) {
        insights.push({
          category: 'social',
          observation: '你标记了重要联系人但本周没有和他们互动',
          suggestion: '主动给重要的人发消息，保持关系温度',
          evidence: `${starred.size} 位星标联系人，0次互动`,
          priority: 'high',
        })
      }
    }

    return insights
  }

  // ── Productivity Analysis ────────────────────────────────────

  private _analyzeProductivity(messages: GrowthMessage[]): GrowthInsight[] {
    const insights: GrowthInsight[] = []
    const selfMessages = messages.filter(m => m.isSelf)

    if (selfMessages.length === 0) return insights

    // Session diversity (how many different conversations)
    const sessions = new Set(selfMessages.map(m => m.sessionId))
    if (sessions.size > 20 && selfMessages.length > 50) {
      insights.push({
        category: 'productivity',
        observation: `你在 ${sessions.size} 个不同的对话中活跃`,
        suggestion: '频繁切换上下文降低专注力。考虑集中时段处理消息',
        evidence: `${sessions.size} 个活跃会话`,
        priority: 'medium',
      })
    }

    // Total message volume
    if (selfMessages.length > 500) {
      insights.push({
        category: 'productivity',
        observation: `本周发送了 ${selfMessages.length} 条消息`,
        suggestion: '消息量较大。检查是否有可以通过电话或面谈替代的沟通',
        evidence: `每天约 ${Math.round(selfMessages.length / 7)} 条`,
        priority: 'low',
      })
    }

    return insights
  }

  // ── Learning Analysis ────────────────────────────────────────

  private _analyzeLearning(messages: GrowthMessage[]): GrowthInsight[] {
    const insights: GrowthInsight[] = []

    // Detect learning-related content
    const learningKeywords = /学习|课程|读书|论文|教程|培训|技术|编程|英语|知识|成长/
    const learningMessages = messages.filter(m => learningKeywords.test(m.content))

    if (learningMessages.length > 5) {
      insights.push({
        category: 'learning',
        observation: `发现 ${learningMessages.length} 条与学习相关的对话`,
        suggestion: '保持学习习惯！可以记录学习笔记并定期回顾',
        evidence: `学习相关消息 ${learningMessages.length} 条`,
        priority: 'low',
      })
    }

    return insights
  }

  // ── Strengths & Areas ────────────────────────────────────────

  private _identifyStrengths(messages: GrowthMessage[], insights: GrowthInsight[]): string[] {
    const strengths: string[] = []
    const selfMessages = messages.filter(m => m.isSelf)

    if (selfMessages.length > 0) {
      const contacts = new Set(messages.filter(m => !m.isSelf).map(m => m.sender))
      if (contacts.size >= 10) strengths.push('社交圈活跃，与多人保持联系')
    }

    const avgLen = selfMessages.length > 0
      ? selfMessages.reduce((s, m) => s + m.content.length, 0) / selfMessages.length
      : 0
    if (avgLen >= 30 && avgLen <= 150) strengths.push('消息长度适中，沟通效率高')

    if (!insights.some(i => i.category === 'communication' && i.observation.includes('深夜'))) {
      strengths.push('作息规律，消息回复时间健康')
    }

    if (strengths.length === 0) strengths.push('持续使用沟通工具，保持社交活跃')

    return strengths
  }

  private _identifyAreas(insights: GrowthInsight[]): string[] {
    return insights
      .filter(i => i.priority === 'high' || i.priority === 'medium')
      .map(i => i.suggestion)
      .slice(0, 3)
  }

  private _generateGoals(insights: GrowthInsight[]): string[] {
    const goals: string[] = []
    const categories = new Set(insights.map(i => i.category))

    if (categories.has('communication')) {
      goals.push('本周改善一个沟通习惯')
    }
    if (categories.has('social')) {
      goals.push('主动联系一位重要但许久未联系的朋友')
    }
    if (categories.has('productivity')) {
      goals.push('设定固定时段集中处理消息')
    }

    if (goals.length === 0) goals.push('保持当前的良好习惯')

    return goals
  }

  // ── Summary ──────────────────────────────────────────────────

  private async _generateSummary(
    insights: GrowthInsight[],
    strengths: string[],
    areas: string[],
  ): Promise<string> {
    if (!this.llm) return ''

    const parts = [
      `优势: ${strengths.join('; ')}`,
      `需要改善: ${areas.join('; ')}`,
      `发现 ${insights.length} 个观察点`,
    ]

    const prompt = `基于以下分析结果，用一句话给出本周最重要的成长建议:\n${parts.join('\n')}\n\n只输出一句话。`

    return await this.llm.complete(prompt, {
      systemPrompt: GROWTH_SYSTEM_PROMPT,
      maxTokens: 100,
    })
  }

  private _generateFallbackSummary(insights: GrowthInsight[], strengths: string[]): string {
    if (insights.length === 0) return '本周沟通状态良好，继续保持！'
    const topInsight = insights[0]
    return `本周建议关注：${topInsight.observation}。${topInsight.suggestion}`
  }
}
