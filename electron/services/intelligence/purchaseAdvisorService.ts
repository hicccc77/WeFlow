/**
 * Purchase Advisor Service — analyze spending patterns and recommend purchases.
 *
 * READ-ONLY: Analyzes and recommends. Does NOT execute any purchases.
 *
 * Scans chat messages for spending mentions, extracts amounts, categorizes
 * spending, and generates recommendations.
 */

import type { PurchaseReport, SpendingItem, PurchaseRecommendation } from './types'

/** Simplified message record for purchase analysis */
export interface PurchaseMessage {
  sender: string
  content: string
  timestamp: number
  sessionId: string
  isSelf: boolean
}

/** LLM callable interface for dependency injection */
export interface PurchaseLLM {
  complete(prompt: string, opts?: { systemPrompt?: string; maxTokens?: number }): Promise<string>
}

// Amount extraction patterns
const AMOUNT_PATTERN = /(?:¥|￥|CNY|RMB)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:元|块)|\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:USD|dollars?)/gi

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  '餐饮': ['外卖', '美食', '餐厅', '食品', '饮料', '咖啡', '奶茶', '食堂', '吃饭', 'delivery', 'food', 'restaurant'],
  '购物': ['淘宝', '京东', '拼多多', '商品', '购买', '下单', '买了', 'order', 'buy', 'shop'],
  '交通': ['打车', '地铁', '公交', '高铁', '机票', '滴滴', 'taxi', 'uber', 'transit', 'flight'],
  '娱乐': ['电影', '游戏', '会员', 'VIP', '视频', '音乐', 'movie', 'game', 'subscription'],
  '生活': ['水电', '房租', '物业', '话费', '充值', 'rent', 'utility', 'bill'],
  '教育': ['课程', '书', '培训', '学费', 'education', 'course', 'book'],
  '健康': ['医院', '药', '体检', '健身', 'gym', 'health', 'medical'],
}

const PURCHASE_SYSTEM_PROMPT = `你是一个消费顾问。基于用户最近的消费数据，分析消费习惯并给出建议。
注意：你只提供分析和建议，不执行任何购买操作。
重点关注：消费结构是否合理、是否有不必要的开支、哪些方面可以优化。
输出简洁实用的建议。`

export class PurchaseAdvisorService {
  private llm: PurchaseLLM | null

  constructor(llm: PurchaseLLM | null = null) {
    this.llm = llm
  }

  /**
   * Analyze recent messages for spending patterns.
   */
  async analyze(messages: PurchaseMessage[], periodDays = 30): Promise<PurchaseReport> {
    // Extract spending items from messages
    const items: SpendingItem[] = []
    for (const msg of messages) {
      items.push(...this._extractSpending(msg))
    }

    // Aggregate
    const total = items.reduce((sum, i) => sum + i.amount, 0)
    const byCategory: Record<string, number> = {}
    const byPlatform: Record<string, number> = {}
    for (const item of items) {
      const cat = item.category || '其他'
      byCategory[cat] = (byCategory[cat] || 0) + item.amount
      byPlatform[item.platform] = (byPlatform[item.platform] || 0) + item.amount
    }

    // Top items
    const topItems = [...items].sort((a, b) => b.amount - a.amount).slice(0, 10)

    // Generate recommendations
    const recommendations = this._generateRecommendations(items, byCategory, total)

    // Generate insights
    const insights = this._generateInsights(items, byCategory, total, periodDays)

    return {
      periodDays,
      totalSpending: Math.round(total * 100) / 100,
      currency: 'CNY',
      spendingByCategory: this._sortByValue(byCategory),
      spendingByPlatform: this._sortByValue(byPlatform),
      topItems,
      recommendations,
      insights,
      generatedAt: new Date().toISOString(),
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  private _extractSpending(msg: PurchaseMessage): SpendingItem[] {
    const items: SpendingItem[] = []
    const matches = [...msg.content.matchAll(AMOUNT_PATTERN)]

    for (const match of matches) {
      const amountStr = match[1] || match[2] || match[3] || match[4]
      if (!amountStr) continue

      const amount = parseFloat(amountStr)
      if (isNaN(amount) || amount <= 0 || amount > 1000000) continue

      const currency = (match[3] || match[4]) ? 'USD' : 'CNY'

      items.push({
        platform: 'wechat',
        amount,
        currency,
        description: msg.content.slice(0, 100),
        date: new Date(msg.timestamp).toISOString().slice(0, 10),
        category: this._categorize(msg.content),
        recordId: '',
      })
    }

    return items
  }

  private _categorize(content: string): string {
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some(kw => content.includes(kw))) {
        return category
      }
    }
    return '其他'
  }

  private _generateRecommendations(
    items: SpendingItem[],
    byCategory: Record<string, number>,
    total: number,
  ): PurchaseRecommendation[] {
    const recommendations: PurchaseRecommendation[] = []

    // Check for high dining spending
    if (byCategory['餐饮'] && byCategory['餐饮'] / total > 0.4) {
      recommendations.push({
        item: '自己做饭',
        reason: '餐饮消费占比超过40%，自己做饭可以节省不少',
        estimatedPrice: '',
        urgency: 'medium',
        category: '餐饮',
      })
    }

    // Check for frequent small purchases
    const smallItems = items.filter(i => i.amount < 50)
    if (smallItems.length > 10) {
      recommendations.push({
        item: '减少冲动消费',
        reason: `有 ${smallItems.length} 笔小额消费，累计也不少`,
        estimatedPrice: `约 ${Math.round(smallItems.reduce((s, i) => s + i.amount, 0))} 元`,
        urgency: 'low',
        category: '购物',
      })
    }

    // Check for no education spending
    if (!byCategory['教育'] && total > 1000) {
      recommendations.push({
        item: '投资学习',
        reason: '近期没有教育支出，考虑投资一些课程或书籍',
        estimatedPrice: '',
        urgency: 'low',
        category: '教育',
      })
    }

    return recommendations
  }

  private _generateInsights(
    items: SpendingItem[],
    byCategory: Record<string, number>,
    total: number,
    periodDays: number,
  ): string[] {
    const insights: string[] = []

    if (items.length === 0) {
      insights.push('未检测到明确的消费记录。实际消费可能未在聊天中体现。')
      return insights
    }

    insights.push(`近${periodDays}天检测到 ${items.length} 笔消费，总计约 ${Math.round(total)} 元`)

    const dailyAvg = total / periodDays
    insights.push(`日均消费约 ${Math.round(dailyAvg)} 元`)

    // Top category
    const topCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]
    if (topCategory) {
      const pct = Math.round((topCategory[1] / total) * 100)
      insights.push(`最大消费类别：${topCategory[0]}，占比 ${pct}%`)
    }

    return insights
  }

  private _sortByValue(obj: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
      Object.entries(obj).sort((a, b) => b[1] - a[1])
    )
  }
}
