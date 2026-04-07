/**
 * Social Advisor Service — goal-directed social network analysis
 * and expansion recommendations.
 *
 * Ported from One's social_advisor.py to TypeScript.
 *
 * Features:
 * - Goal-directed group chat scoring
 * - Social network expansion suggestions
 * - Graph-based social insights
 * - LLM-powered advice generation
 */

import { llmService } from './llmService'
import { intelligenceDb } from './intelligenceDb'
import { graphService } from './graphService'

// ─── Data Models ───────────────────────────────────────────────

export interface SocialGoal {
  id: string
  label: string
  keywords: string[]
  priority: 'primary' | 'secondary'
  createdAt?: string
}

export interface GroupScore {
  groupId: string
  groupName: string
  totalScore: number     // 0-100
  dimensionScores: Record<string, number>
  verdict: 'keep' | 'deprioritize' | 'neutral'
  summary: string
}

export interface SocialRecommendation {
  contactName: string
  reason: string
  actionType: 'strengthen' | 'reconnect' | 'introduce'
  relevanceScore: number  // 0-1
}

export interface SocialReport {
  goals: SocialGoal[]
  groupScores: GroupScore[]
  blindSpots: string[]
  recommendations: SocialRecommendation[]
  llmSummary: string
  generatedAt: string
}

// ─── Weight Profiles ───────────────────────────────────────────

const GOAL_WEIGHT_PROFILES: Record<string, Record<string, number>> = {
  networking: {
    activity: 0.20, relevance: 0.15, quality: 0.10,
    members: 0.10, reciprocity: 0.10, bridge: 0.35,
  },
  learning: {
    activity: 0.10, relevance: 0.40, quality: 0.30,
    members: 0.05, reciprocity: 0.05, bridge: 0.10,
  },
  industry: {
    activity: 0.15, relevance: 0.30, quality: 0.15,
    members: 0.20, reciprocity: 0.05, bridge: 0.15,
  },
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  activity: 0.15, relevance: 0.25, quality: 0.20,
  members: 0.15, reciprocity: 0.10, bridge: 0.15,
}

function getGoalWeights(goal: SocialGoal): Record<string, number> {
  const labelLower = goal.label.toLowerCase()
  for (const [key, weights] of Object.entries(GOAL_WEIGHT_PROFILES)) {
    if (labelLower.includes(key)) return weights
  }
  for (const keyword of goal.keywords) {
    const kw = keyword.toLowerCase()
    for (const [key, weights] of Object.entries(GOAL_WEIGHT_PROFILES)) {
      if (key.includes(kw) || kw.includes(key)) return weights
    }
  }
  return DEFAULT_WEIGHTS
}

// ─── Service ───────────────────────────────────────────────────

export class SocialAdvisorService {

  // ── Goal Management ─────────────────────────────────────────

  createGoal(goal: SocialGoal): void {
    intelligenceDb.createSocialGoal({
      id: goal.id,
      label: goal.label,
      keywords: goal.keywords,
      priority: goal.priority,
    })
  }

  listGoals(): SocialGoal[] {
    const rows = intelligenceDb.listSocialGoals()
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      keywords: JSON.parse(r.keywords || '[]'),
      priority: r.priority as 'primary' | 'secondary',
      createdAt: r.created_at,
    }))
  }

  deleteGoal(goalId: string): boolean {
    return intelligenceDb.deleteSocialGoal(goalId)
  }

  // ── Group Chat Scoring ──────────────────────────────────────

  /**
   * Score all group chats against the user's social goals.
   */
  async scoreGroups(
    groups: Array<{
      id: string
      name: string
      messageCount: number
      memberCount: number
      recentMessages?: string[]
      myMessageCount?: number
    }>,
    goals?: SocialGoal[],
  ): Promise<GroupScore[]> {
    const activeGoals = goals || this.listGoals()
    if (activeGoals.length === 0) {
      // No goals — return neutral scores
      return groups.map(g => ({
        groupId: g.id,
        groupName: g.name,
        totalScore: 50,
        dimensionScores: {},
        verdict: 'neutral' as const,
        summary: '未设定社交目标，无法评分',
      }))
    }

    const scores: GroupScore[] = []

    for (const group of groups) {
      let totalWeightedScore = 0
      let totalWeight = 0
      const dimensionScores: Record<string, number> = {}

      for (const goal of activeGoals) {
        const weights = getGoalWeights(goal)
        const goalWeight = goal.priority === 'primary' ? 1.0 : 0.5

        // Activity score (0-100): based on message count
        const activityScore = Math.min(100, (group.messageCount / 100) * 100)
        dimensionScores.activity = activityScore

        // Relevance score: keyword match in recent messages
        let relevanceScore = 0
        if (group.recentMessages?.length) {
          const allText = group.recentMessages.join(' ').toLowerCase()
          const matchCount = goal.keywords.filter(k =>
            allText.includes(k.toLowerCase())
          ).length
          relevanceScore = Math.min(100, (matchCount / Math.max(1, goal.keywords.length)) * 100)
        }
        dimensionScores.relevance = relevanceScore

        // Quality score: message length and diversity heuristic
        const qualityScore = Math.min(100, (group.memberCount > 5 ? 60 : 30) + (group.messageCount > 50 ? 30 : 10))
        dimensionScores.quality = qualityScore

        // Members score: group size
        const membersScore = Math.min(100, group.memberCount * 2)
        dimensionScores.members = membersScore

        // Reciprocity score: ratio of user's messages to total
        const reciprocityScore = group.myMessageCount
          ? Math.min(100, (group.myMessageCount / Math.max(1, group.messageCount)) * 200)
          : 0
        dimensionScores.reciprocity = reciprocityScore

        // Bridge score: how many unique contacts from this group appear elsewhere
        dimensionScores.bridge = 30 // Default; would need cross-reference for real value

        // Weighted sum
        for (const [dim, weight] of Object.entries(weights)) {
          totalWeightedScore += (dimensionScores[dim] || 0) * weight * goalWeight
          totalWeight += weight * goalWeight
        }
      }

      const finalScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 50
      const verdict: 'keep' | 'deprioritize' | 'neutral' =
        finalScore >= 60 ? 'keep' : finalScore <= 30 ? 'deprioritize' : 'neutral'

      scores.push({
        groupId: group.id,
        groupName: group.name,
        totalScore: Math.round(finalScore),
        dimensionScores,
        verdict,
        summary: verdict === 'keep'
          ? `「${group.name}」与你的社交目标高度匹配`
          : verdict === 'deprioritize'
          ? `「${group.name}」与当前目标关联度较低`
          : `「${group.name}」价值中等`,
      })
    }

    return scores.sort((a, b) => b.totalScore - a.totalScore)
  }

  // ── Social Expansion Recommendations ────────────────────────

  /**
   * Recommend contacts to strengthen connections with,
   * based on graph analysis.
   */
  async getExpansionRecommendations(
    limit: number = 5,
  ): Promise<SocialRecommendation[]> {
    const allContacts = graphService.getAllContacts()
    const recommendations: SocialRecommendation[] = []

    // Find contacts with medium closeness (0.2-0.6) who haven't been contacted recently
    for (const contact of allContacts) {
      const rel = intelligenceDb.getRelationship(contact.name)
      if (!rel) continue
      if (rel.relationship_type === 'group') continue

      const closeness = rel.closeness
      if (closeness >= 0.2 && closeness <= 0.6) {
        recommendations.push({
          contactName: contact.name,
          reason: `与 ${contact.name} 的关系亲密度为 ${closeness.toFixed(1)}，有潜力加强联系`,
          actionType: 'strengthen',
          relevanceScore: closeness,
        })
      } else if (closeness > 0 && closeness < 0.2 && (contact.message_count || 0) > 10) {
        recommendations.push({
          contactName: contact.name,
          reason: `与 ${contact.name} 有 ${contact.message_count} 条消息记录，但近期联系减少`,
          actionType: 'reconnect',
          relevanceScore: 0.3,
        })
      }
    }

    // Sort by relevance and return top N
    return recommendations
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit)
  }

  // ── Social Insights (LLM-powered) ──────────────────────────

  /**
   * Generate a comprehensive social report with LLM insights.
   */
  async generateReport(): Promise<SocialReport> {
    const goals = this.listGoals()
    const allContacts = graphService.getAllContacts()

    // Build context for LLM
    const contactSummaries = allContacts.slice(0, 20).map(c => {
      const rel = intelligenceDb.getRelationship(c.name)
      return `${c.name}（${rel?.relationship_type || '未知'}，亲密度${(rel?.closeness || 0).toFixed(1)}，${c.message_count || 0}条消息）`
    }).join('\n')

    const goalText = goals.map(g => `- ${g.label}（关键词：${g.keywords.join('、')}）`).join('\n')

    // Identify blind spots
    const blindSpots: string[] = []
    const relTypes = new Set(allContacts.map(c => {
      const rel = intelligenceDb.getRelationship(c.name)
      return rel?.relationship_type
    }).filter(Boolean))

    if (!relTypes.has('colleague')) blindSpots.push('职场社交关系数据不足')
    if (!relTypes.has('family')) blindSpots.push('家庭关系数据不足')
    if (allContacts.length < 10) blindSpots.push('社交联系人数量较少')

    // Get expansion recommendations
    const recommendations = await this.getExpansionRecommendations()

    // Generate LLM summary
    let llmSummary = ''
    try {
      const prompt =
        `分析以下社交数据，给出一段简短的社交健康评估（3-5句话）：\n\n` +
        `社交目标：\n${goalText || '（未设定）'}\n\n` +
        `主要联系人：\n${contactSummaries || '（无数据）'}\n\n` +
        `盲点：${blindSpots.join('、') || '无'}`

      const response = await llmService.call({
        prompt,
        systemPrompt: '你是一个社交关系分析师。基于用户的社交数据，给出简短、有洞见的分析。不要客套，直接给出有价值的观察。',
        tier: 'fast',
        maxTokens: 300,
      })
      llmSummary = response.text.trim()
    } catch {
      llmSummary = '社交分析服务暂不可用'
    }

    return {
      goals,
      groupScores: [],
      blindSpots,
      recommendations,
      llmSummary,
      generatedAt: new Date().toISOString(),
    }
  }
}

export const socialAdvisorService = new SocialAdvisorService()
