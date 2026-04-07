/**
 * PUA Detector Service — analyze conversations for manipulative communication patterns.
 *
 * Detects 6 types of manipulation:
 * 1. Emotional blackmail (情感勒索)
 * 2. Gaslighting (煤气灯效应)
 * 3. Double standards (双重标准)
 * 4. Isolation control (隔离控制)
 * 5. Belittling (贬低打压)
 * 6. Hot-cold cycling (热冷交替)
 *
 * Uses keyword detection + optional LLM semantic analysis.
 */

import type { PUASignal, PUAReport } from './types'

/** Simplified message record for PUA analysis */
export interface PUAMessage {
  sender: string
  content: string
  timestamp: number
  isSelf: boolean // true = user sent this, false = contact sent this
}

/** LLM callable interface for dependency injection */
export interface PUALLM {
  complete(prompt: string, opts?: { systemPrompt?: string; maxTokens?: number }): Promise<string>
}

/** Pattern definition */
interface PatternDef {
  name: string
  label: string
  keywords: RegExp
  severity: 'low' | 'medium' | 'high'
  description: string
  advice: string
}

const PATTERNS: PatternDef[] = [
  {
    name: 'emotional_blackmail',
    label: '情感勒索',
    keywords: /你不.*我就|如果你不|要不然我|我会.*自己|你不在乎我|威胁|if you don.?t/i,
    severity: 'high',
    description: '情感勒索：用威胁来控制你的行为',
    advice: '不要因为威胁而妥协。如果涉及自我伤害的威胁，建议寻求专业帮助。',
  },
  {
    name: 'gaslighting',
    label: '煤气灯效应',
    keywords: /你记错了|你想多了|我没说过|你太敏感|不是这样的|你在胡说|你疯了|you.?re (crazy|imagining|overreacting)/i,
    severity: 'high',
    description: '煤气灯效应：否认你的感受或记忆',
    advice: '相信自己的记忆和感受。建议保留聊天记录作为证据。',
  },
  {
    name: 'double_standards',
    label: '双重标准',
    keywords: /你不可以.*但是我|我可以.*你不行|轮到你.*不行|对我.*标准|你凭什么|你不配/i,
    severity: 'medium',
    description: '双重标准：对自己宽容对对方严格',
    advice: '关系中的规则应该双向适用。如果对方总是"特例"，需要认真对话。',
  },
  {
    name: 'isolation',
    label: '隔离控制',
    keywords: /别和.{1,5}(来往|联系|见面)|不要告诉|只有我|他们不好|不要跟.*玩|don.?t (talk|see|hang out) with/i,
    severity: 'high',
    description: '社交隔离：试图切断你与他人的联系',
    advice: '保持与朋友和家人的联系。如果对方反对你的社交，这是重要的警告信号。',
  },
  {
    name: 'belittling',
    label: '贬低打压',
    keywords: /你什么都做不好|离了我你怎么办|你不行|没有你不行|你太笨|你真没用|废物|你不如|你永远都/i,
    severity: 'high',
    description: '贬低打压：通过否定你的能力来控制你',
    advice: '你的价值不由他人定义。持续的贬低是精神虐待的一种形式。',
  },
  {
    name: 'hot_cold',
    label: '热冷交替',
    keywords: /不想理你|别烦我|冷暴力|不回复|消失了|忽冷忽热|ignore|silent treatment/i,
    severity: 'medium',
    description: '热冷交替：忽冷忽热、间歇性断联',
    advice: '冷暴力不是解决问题的方式。如果这是一种常态，需要重新评估这段关系。',
  },
]

// Negation patterns that may invalidate a match
const NEGATION_PATTERN = /没有|不是|不要|并非|不会|不能|从来没|don.?t|not|never|isn.?t|wasn.?t/i

const PUA_SYSTEM_PROMPT = `你是一个专业的心理分析师。分析以下对话记录，判断其中是否存在操控性沟通模式（PUA）。

关注以下6种模式：
1. 情感勒索：用威胁或情感压力控制对方
2. 煤气灯效应：否认对方的感受或记忆
3. 双重标准：对自己宽容对对方严格
4. 隔离控制：试图切断对方的社交关系
5. 贬低打压：通过否定对方能力来控制
6. 热冷交替：忽冷忽热、间歇性断联

对每种模式给出0-10的风险评分和具体证据。
输出格式：JSON数组，每项包含 pattern, score(0-10), evidence(引用原文), explanation。
只输出JSON，不要其他文字。`

export class PuaDetectorService {
  private llm: PUALLM | null

  constructor(llm: PUALLM | null = null) {
    this.llm = llm
  }

  /**
   * Analyze a conversation for PUA patterns.
   * @param contactName - The contact being analyzed
   * @param messages - Recent conversation messages (both sides)
   */
  async analyze(contactName: string, messages: PUAMessage[]): Promise<PUAReport> {
    if (messages.length === 0) {
      return {
        contact: contactName,
        signals: [],
        riskLevel: 'low',
        summary: `没有找到与 ${contactName} 相关的对话记录。`,
        analyzedAt: new Date().toISOString(),
      }
    }

    // Only analyze messages FROM the contact (not user's own messages)
    const contactMessages = messages.filter(m => !m.isSelf)

    // Step 1: Keyword-based pattern detection
    const signals = this._detectPatterns(contactName, contactMessages)

    // Step 2: Optional LLM semantic analysis
    if (this.llm && contactMessages.length > 0) {
      try {
        const llmSignals = await this._llmAnalysis(contactName, messages)
        // Merge LLM signals with keyword signals (avoid duplicates)
        for (const s of llmSignals) {
          if (!signals.some(existing => existing.pattern === s.pattern && existing.evidence === s.evidence)) {
            signals.push(s)
          }
        }
      } catch {
        // LLM analysis failed, keyword results are still valid
      }
    }

    // Calculate overall risk level
    const riskLevel = this._calculateRiskLevel(signals)
    const summary = this._generateSummary(contactName, signals, riskLevel)

    return {
      contact: contactName,
      signals,
      riskLevel,
      summary,
      analyzedAt: new Date().toISOString(),
    }
  }

  /**
   * Get all pattern definitions (for display purposes).
   */
  getPatternDefinitions(): Array<{ name: string; label: string; severity: string; description: string }> {
    return PATTERNS.map(p => ({
      name: p.name,
      label: p.label,
      severity: p.severity,
      description: p.description,
    }))
  }

  // ── Private helpers ──────────────────────────────────────────

  private _detectPatterns(contactName: string, messages: PUAMessage[]): PUASignal[] {
    const signals: PUASignal[] = []

    for (const msg of messages) {
      for (const pattern of PATTERNS) {
        const matches = [...msg.content.matchAll(new RegExp(pattern.keywords.source, pattern.keywords.flags + 'g'))]
        for (const match of matches) {
          const idx = match.index ?? 0

          // Check for negation before the match (30 chars context)
          const contextBefore = msg.content.slice(Math.max(0, idx - 30), idx)
          if (NEGATION_PATTERN.test(contextBefore)) continue

          // Extract evidence with context
          const start = Math.max(0, idx - 20)
          const end = Math.min(msg.content.length, idx + (match[0]?.length ?? 0) + 20)
          const evidence = msg.content.slice(start, end)

          signals.push({
            pattern: pattern.name,
            severity: pattern.severity,
            description: pattern.description,
            evidence,
            contact: contactName,
            advice: pattern.advice,
            recordId: '',
          })
        }
      }
    }

    return signals
  }

  private async _llmAnalysis(contactName: string, messages: PUAMessage[]): Promise<PUASignal[]> {
    if (!this.llm) return []

    // Build conversation context (limit to last 50 messages)
    const recentMessages = messages.slice(-50)
    const conversationText = recentMessages
      .map(m => `[${m.isSelf ? '我' : contactName}]: ${m.content}`)
      .join('\n')

    const prompt = `分析以下对话记录中是否存在PUA/操控性沟通模式:\n\n${conversationText}\n\n请按要求的JSON格式输出分析结果。`

    const response = await this.llm.complete(prompt, {
      systemPrompt: PUA_SYSTEM_PROMPT,
      maxTokens: 1000,
    })

    try {
      const parsed = JSON.parse(response)
      if (!Array.isArray(parsed)) return []

      return parsed
        .filter((item: any) => item.score > 3) // Only include meaningful signals
        .map((item: any) => {
          const patternDef = PATTERNS.find(p => p.name === item.pattern)
          return {
            pattern: item.pattern || 'unknown',
            severity: item.score >= 7 ? 'high' : item.score >= 4 ? 'medium' : 'low' as const,
            description: patternDef?.description || item.explanation || '',
            evidence: item.evidence || '',
            contact: contactName,
            advice: patternDef?.advice || '建议保持警惕，必要时寻求专业帮助。',
            recordId: '',
          }
        })
    } catch {
      return []
    }
  }

  private _calculateRiskLevel(signals: PUASignal[]): 'low' | 'medium' | 'high' {
    if (signals.length === 0) return 'low'

    const highCount = signals.filter(s => s.severity === 'high').length
    const mediumCount = signals.filter(s => s.severity === 'medium').length

    if (highCount >= 2 || (highCount >= 1 && mediumCount >= 2)) return 'high'
    if (highCount >= 1 || mediumCount >= 2) return 'medium'
    return 'low'
  }

  private _generateSummary(
    contactName: string,
    signals: PUASignal[],
    riskLevel: 'low' | 'medium' | 'high',
  ): string {
    if (signals.length === 0) {
      return `与 ${contactName} 的对话中未发现明显的操控性沟通模式。`
    }

    const patternNames = [...new Set(signals.map(s => {
      const p = PATTERNS.find(pat => pat.name === s.pattern)
      return p?.label || s.pattern
    }))]

    const riskText = riskLevel === 'high' ? '较高' : riskLevel === 'medium' ? '中等' : '较低'
    return `与 ${contactName} 的对话存在${riskText}风险。发现以下模式：${patternNames.join('、')}。共${signals.length}个信号。`
  }
}
