/**
 * Reply Coach Service — complete rewrite with 7-step context assembly,
 * complexity analysis, discussion mode, and direct reply generation.
 *
 * Ported from One's reply_coach.py to TypeScript.
 */

import * as crypto from 'crypto'
import {
  ContextBundle, ReplySuggestion, Relationship, DiscussionRound,
  MediaContext, LLMResponse, CoachDiscussion,
} from './types'
import { llmService } from './llmService'
import { intelligenceDb } from './intelligenceDb'

// ─── System Prompts (Chinese) ──────────────────────────────────

const REPLY_COACH_SYSTEM_PROMPT = `你是一个职场高情商沟通教练。你的任务是根据用户与对方的关系、沟通历史和风格偏好，
生成贴合语境的回复建议。

核心原则：
1. 回复必须自然、像真人写的，不能有 AI 味（不要用"您好"开头、不要过度礼貌）
2. 根据关系亲密度调整语气——跟领导说话和跟好朋友说话完全不同
3. 参考历史对话中用户的实际措辞习惯，保持一致的沟通风格
4. 每个回复建议必须有明确的策略差异，不是换个说法而是换个沟通策略
5. 如果有敏感话题或近期分歧，回复要体现对这些背景的感知

输出格式：每个建议用 --- 分隔
REPLY: 回复内容
REASON: 为什么这样回复（基于哪些关系/历史信息）
STYLE: 风格标签（safe/warm/firm）

风格定义：
- safe（稳妥）：得体、不出错、保持距离感的安全回复
- warm（温暖）：亲切、拉近关系、带个人化表达的回复
- firm（坚定）：清晰表达立场、不回避分歧、尊重但有态度的回复`

const ANALYZE_SYSTEM_PROMPT = `你是一个沟通分析师。分析用户收到的消息，判断是否需要先讨论应对策略再回复。

判断标准（满足任意一条即为复杂）：
- 消息长度 >100 字
- 包含多个话题/问题需要分别回应
- 涉及利益关系、决策、承诺
- 发送者是上级/重要关系
- 包含附件/资料/链接
- 涉及敏感话题（钱、人事、冲突）

输出 JSON 格式（不要输出其他内容）：
{
  "is_complex": true/false,
  "reason": "一句话说明原因",
  "guide_questions": ["引导问题1", "引导问题2"]
}

如果不复杂，guide_questions 为空数组。如果复杂，生成 2-3 个帮助用户思考的引导问题。
引导问题应该具体、有针对性，基于消息内容和关系上下文。`

const DISCUSS_SYSTEM_PROMPT = `你是一个高情商沟通策略顾问。用户收到了一条需要策略性回复的消息。
用户想先和你讨论应对策略，而不是直接回复。

你的任务：
1. 分析用户提出的顾虑和想法
2. 结合关系背景和历史对话，给出策略分析
3. 提出一个有针对性的追问，帮助用户进一步思考

策略分析要求：
- 分析对方的可能意图
- 评估不同应对方式的利弊
- 给出明确的策略建议
- 如果用户提供了新信息（如对方的历史行为），调整策略

输出格式：
ANALYSIS: 策略分析（2-4 句话）
FOLLOWUP: 追问（1 句话，可选，如果已经讨论充分则不需要）`

const DISCUSS_REPLY_SYSTEM_PROMPT = `你是一个职场高情商沟通教练。基于用户和你之前的策略讨论，生成具体的回复建议。

讨论摘要和策略已确定。现在需要把策略转化为具体的回复文字。

输出格式：
STRATEGY: 一句话总结策略方向

---
REPLY: 回复内容
REASON: 为什么这样回复
STYLE: safe/warm/firm

---
REPLY: 回复内容
REASON: 为什么这样回复
STYLE: safe/warm/firm

---
REPLY: 回复内容
REASON: 为什么这样回复
STYLE: safe/warm/firm`

// ─── Context Cache ─────────────────────────────────────────────

interface CachedContext {
  bundle: ContextBundle
  timestamp: number
}

const CONTEXT_CACHE_TTL = 300_000 // 5 minutes

// ─── Helper: escape for prompt ─────────────────────────────────

function escapeForPrompt(text: string, maxLen: number): string {
  const trimmed = text.slice(0, maxLen)
  return trimmed.replace(/[{}]/g, c => c === '{' ? '{{' : '}}')
}

// ─── Helper: 3-char sliding window for Chinese topic search ───

function extractChineseTerms(message: string): string[] {
  const chars = message.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)
  if (!chars || chars.length < 3) return []

  const stopTerms = new Set([
    '你好吗', '什么时', '时候了', '怎么样', '可以吗', '已经了',
    '不是吗', '因为所', '所以我', '但是我', '而且还', '还是不',
    '如果你', '就是说', '没有了', '他们的', '我们的', '大家好',
    '现在的', '一个人',
  ])

  const seen = new Set<string>()
  const terms: string[] = []
  for (let i = 0; i <= chars.length - 3; i++) {
    const term = chars.slice(i, i + 3).join('')
    if (!seen.has(term) && !stopTerms.has(term)) {
      seen.add(term)
      terms.push(term)
    }
  }
  return terms.slice(0, 5)
}

// ─── Service ───────────────────────────────────────────────────

export class ReplyCoachService {
  private contextCache: Map<string, CachedContext> = new Map()
  private maxRounds = 3

  // ── 1. Context Assembly Pipeline (7 steps) ──────────────────

  async buildContextBundle(
    contact: string,
    message: string,
    selectedContext?: string[],
  ): Promise<ContextBundle> {
    // Check cache
    const cacheKey = `${contact}:${message}:${(selectedContext || []).join(',')}`
    const now = Date.now()

    // Evict expired entries
    for (const [key, cached] of this.contextCache.entries()) {
      if (now - cached.timestamp >= CONTEXT_CACHE_TTL) {
        this.contextCache.delete(key)
      }
    }

    const cached = this.contextCache.get(cacheKey)
    if (cached && now - cached.timestamp < CONTEXT_CACHE_TTL) {
      return cached.bundle
    }

    // Step 1: Identity Resolution
    const resolvedName = intelligenceDb.resolve(contact)
    const displayName = resolvedName !== contact ? resolvedName : contact

    // Step 2: Voice Transcription
    let transcribedMessage = message
    if (message.includes('发了一条语音')) {
      try {
        const { mediaContextService } = await import('./mediaContextService')
        const voiceResult = await mediaContextService.processMessage({
          localId: 0,
          localType: 34,
          parsedContent: message,
        })
        if (voiceResult?.processedContent) {
          transcribedMessage = voiceResult.processedContent
        } else {
          transcribedMessage = message.replace(/发了一条语音/g, '[语音] (转写不可用)')
        }
      } catch {
        transcribedMessage = message.replace(/发了一条语音/g, '[语音] (转写不可用)')
      }
    }

    // Step 3: Relationship Lookup
    const relationship = intelligenceDb.getRelationship(displayName)
      || intelligenceDb.getRelationship(contact)
    const contactData = intelligenceDb.getContact(displayName)
      || intelligenceDb.getContact(contact)

    // Detect group chat
    const isGroup = contact.includes('@chatroom') || (contactData?.is_group === true)

    let relContext = ''
    if (isGroup) {
      const msgCount = contactData?.message_count || 0
      relContext = `这是群聊「${displayName}」，共 ${msgCount} 条消息记录。`
    } else if (relationship) {
      relContext = `${displayName} 是你的${relationship.relationship_type}，沟通风格${relationship.communication_style}，亲密度 ${relationship.closeness.toFixed(1)}/1.0。`
      if (relationship.topics?.length) {
        relContext += `常讨论话题：${relationship.topics.join('、')}。`
      }
      if (relationship.dynamics) {
        relContext += `关系动态：${relationship.dynamics}`
      }
    } else if (contactData) {
      relContext = `${displayName}，共 ${contactData.message_count || 0} 条消息记录。`
    } else {
      relContext = `没有关于 ${displayName} 的历史记录。`
    }

    // Step 4: History Context (from chatService)
    let historyContext = ''
    try {
      const { chatService } = await import('../chatService')
      // Get recent messages from last 3 days
      const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 3600
      const msgs = await chatService.getMessages(contact, 0, 15, threeDaysAgo)
      if (msgs?.length) {
        historyContext = msgs
          .map((m: any) => {
            const sender = m.isSend ? '[我]' : `[${displayName}]`
            const content = (m.parsedContent || '').slice(0, 200)
            return `${sender} ${content}`
          })
          .join('\n')
      }

      // Topic-related search via sliding window
      const topicTerms = extractChineseTerms(transcribedMessage)
      if (topicTerms.length > 0) {
        for (const term of topicTerms.slice(0, 3)) {
          try {
            const topicResults = await chatService.searchMessages(term, undefined, 3)
            if (topicResults?.length) {
              historyContext += '\n--- 相关话题记录 ---\n'
              for (const r of topicResults) {
                historyContext += `[${r.senderUsername || '?'}] ${(r.parsedContent || '').slice(0, 150)}\n`
              }
            }
          } catch {
            // Topic search not critical
          }
        }
      }
    } catch {
      historyContext = '(历史消息暂不可用)'
    }

    // Step 5: Personality Context
    const perContactStyle = intelligenceDb.getPerContactStyle(displayName)
      || intelligenceDb.getPerContactStyle(contact)
    const overallStyle = intelligenceDb.getPersonalityValue('overall_style')

    let personalityContext = ''
    if (perContactStyle) {
      personalityContext = `你和 ${displayName} 的沟通风格：${perContactStyle}`
    } else if (overallStyle) {
      personalityContext = `你的整体沟通风格：${overallStyle}`
    }

    // Check for global override
    const override = intelligenceDb.getCoachConfig('personality_context')
    if (override) {
      personalityContext = override
    }

    // Step 6: Style Examples — last 5 messages from [我]
    let styleExamples = ''
    try {
      const { chatService } = await import('../chatService')
      const recentSent = await chatService.getMessages(contact, 0, 20)
      if (recentSent?.length) {
        const myMsgs = recentSent
          .filter((m: any) => m.isSend && m.parsedContent && m.parsedContent.length > 4)
          .slice(0, 5)
          .map((m: any) => `  - ${(m.parsedContent || '').slice(0, 100)}`)
        if (myMsgs.length > 0) {
          styleExamples = `用户的真实回复示例（请模仿这种风格）：\n${myMsgs.join('\n')}`
        }
      }
    } catch {
      // Style examples not critical
    }

    // Step 7: Media Processing (for non-text messages)
    // Media is processed inline when voice/image messages are detected in context

    // Build feedback context
    const feedbackContext = this.buildFeedbackContext(displayName)

    const bundle: ContextBundle = {
      display_name: displayName,
      contact_name: contact,
      incoming_message: transcribedMessage,
      rel_context: relContext,
      history_context: historyContext,
      personality_context: personalityContext,
      style_examples: styleExamples,
      feedback_context: feedbackContext,
      is_group: isGroup,
      relationship,
      recent_records: [],
    }

    // Cache
    this.contextCache.set(cacheKey, { bundle, timestamp: now })

    return bundle
  }

  // ── 2. Complexity Analysis ──────────────────────────────────

  async analyzeComplexity(
    contact: string,
    message: string,
    selectedContext?: string[],
  ): Promise<{ isComplex: boolean; reason: string; guideQuestions: string[] }> {
    const defaultResult = { isComplex: false, reason: '', guideQuestions: [] as string[] }

    const ctx = await this.buildContextBundle(contact, message, selectedContext)

    const prompt =
      `消息来自「${escapeForPrompt(ctx.display_name, 100)}」：\n` +
      `<user_message>${escapeForPrompt(ctx.incoming_message, 500)}</user_message>\n\n` +
      `<context>关系背景：${ctx.rel_context}</context>\n`

    const t0 = Date.now()

    try {
      const response = await llmService.call({
        prompt,
        systemPrompt: ANALYZE_SYSTEM_PROMPT,
        maxTokens: 300,
        tier: 'fast',
      })

      const durationMs = Date.now() - t0

      // Log
      try {
        intelligenceDb.logCoachCall({
          contact: ctx.display_name,
          incomingMessage: ctx.incoming_message,
          relationshipContext: ctx.rel_context,
          systemPrompt: ANALYZE_SYSTEM_PROMPT,
          userPrompt: prompt,
          llmResponse: response.text,
          modelUsed: response.model,
          durationMs,
          isGroup: ctx.is_group,
          callType: 'analyze',
        })
      } catch { /* non-critical */ }

      // Parse JSON response
      let jsonStr = response.text.trim()
      if (jsonStr.includes('```')) {
        const match = jsonStr.match(/```(?:json)?\s*(\{.*?\})\s*```/s)
        if (match) jsonStr = match[1]
      }

      try {
        const parsed = JSON.parse(jsonStr)
        return {
          isComplex: !!parsed.is_complex,
          reason: String(parsed.reason || ''),
          guideQuestions: (parsed.guide_questions || []).slice(0, 3),
        }
      } catch {
        return defaultResult
      }
    } catch {
      return defaultResult
    }
  }

  // ── 3. Discussion Mode (3 rounds) ──────────────────────────

  async discuss(
    contact: string,
    message: string,
    userInput: string,
    discussionId?: number,
  ): Promise<{
    analysis: string
    followup?: string
    discussionId: number
    round: number
  }> {
    const ctx = await this.buildContextBundle(contact, message)

    // Get or create discussion
    let disc: CoachDiscussion | null = null
    if (discussionId) {
      disc = intelligenceDb.getDiscussion(discussionId)
    }
    if (!disc) {
      const newId = intelligenceDb.createDiscussion(ctx.display_name, ctx.incoming_message)
      disc = intelligenceDb.getDiscussion(newId)!
    }

    const currentDiscId = disc.id
    const rounds = disc.rounds || []
    const currentRound = rounds.filter((r) => r.role === 'user').length + 1

    // Reject if exceeds max rounds
    if (currentRound > this.maxRounds) {
      return {
        analysis: '讨论轮次已达上限，请点击"生成回复"获取最终建议。',
        discussionId: currentDiscId,
        round: currentRound,
      }
    }

    // Build discussion history
    let discussionHistory = ''
    for (const r of rounds) {
      const prefix = r.role === 'user' ? '> ' : ''
      discussionHistory += `${prefix}${r.content}\n\n`
    }
    discussionHistory += `> ${userInput}\n`

    const prompt =
      `用户收到了来自「${escapeForPrompt(ctx.display_name, 100)}」的消息：\n` +
      `<user_message>${escapeForPrompt(ctx.incoming_message, 500)}</user_message>\n\n` +
      `<context>\n关系背景：${ctx.rel_context}\n` +
      `沟通风格：${ctx.personality_context}\n` +
      `历史对话：\n${ctx.history_context}\n</context>\n\n` +
      `讨论记录（第 ${currentRound} 轮）：\n${discussionHistory}\n\n` +
      `请分析用户的想法，给出策略建议。` +
      (currentRound >= this.maxRounds ? '这是最后一轮讨论，请给出最终策略建议，不需要追问。' : '')

    const t0 = Date.now()
    let analysis = ''
    let followup: string | undefined

    try {
      const response = await llmService.call({
        prompt,
        systemPrompt: DISCUSS_SYSTEM_PROMPT,
        maxTokens: 500,
        tier: 'smart',
      })

      const durationMs = Date.now() - t0

      // Parse ANALYSIS and FOLLOWUP
      const analysisMatch = response.text.match(/ANALYSIS:\s*(.*?)(?=FOLLOWUP:|$)/s)
      const followupMatch = response.text.match(/FOLLOWUP:\s*(.*?)$/s)

      analysis = analysisMatch ? analysisMatch[1].trim() : response.text.trim()

      if (followupMatch && currentRound < this.maxRounds) {
        const fu = followupMatch[1].trim()
        if (fu && !['无', 'none', 'n/a'].includes(fu.toLowerCase())) {
          followup = fu
        }
      }

      // Log
      try {
        intelligenceDb.logCoachCall({
          contact: ctx.display_name,
          incomingMessage: ctx.incoming_message,
          systemPrompt: DISCUSS_SYSTEM_PROMPT,
          userPrompt: prompt,
          llmResponse: response.text,
          modelUsed: response.model,
          durationMs,
          isGroup: ctx.is_group,
          callType: 'discuss',
        })
      } catch { /* non-critical */ }

      // Save rounds only after LLM succeeds
      intelligenceDb.appendDiscussionRound(currentDiscId, 'user', userInput)
      intelligenceDb.appendDiscussionRound(currentDiscId, 'assistant', analysis)
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      if (errMsg.includes('timed out') || errMsg.includes('timeout')) {
        analysis = 'AI 响应超时，请重试。'
      } else if (errMsg.includes('429') || errMsg.includes('rate')) {
        analysis = 'AI 服务请求过于频繁，请稍后重试。'
      } else if (errMsg.includes('401') || errMsg.includes('auth') || errMsg.includes('key')) {
        analysis = 'AI 服务认证失败，请检查设置中的 API Key 配置。'
      } else {
        analysis = `AI 分析失败：${errMsg.slice(0, 100)}`
      }
    }

    return {
      analysis,
      followup,
      discussionId: currentDiscId,
      round: currentRound,
    }
  }

  // ── 4. Discussion-based Reply Generation ────────────────────

  async discussReply(discussionId: number): Promise<ReplySuggestion[]> {
    const disc = intelligenceDb.getDiscussion(discussionId)
    if (!disc) {
      return []
    }

    const contact = disc.contact
    const incomingMessage = disc.incomingMessage
    const ctx = await this.buildContextBundle(contact, incomingMessage)

    const rounds = disc.rounds || []

    let discussionText = ''
    for (const r of rounds) {
      const prefix = r.role === 'user' ? '> 用户: ' : 'AI: '
      discussionText += `${prefix}${r.content}\n\n`
    }

    const prompt =
      `用户收到了来自「${escapeForPrompt(ctx.display_name, 100)}」的消息：\n` +
      `<user_message>${escapeForPrompt(ctx.incoming_message, 500)}</user_message>\n\n` +
      `<context>\n关系背景：${ctx.rel_context}\n` +
      `沟通风格：${ctx.personality_context}\n</context>\n\n` +
      `策略讨论记录：\n${discussionText}\n` +
      `请基于以上讨论，先总结策略方向（一句话），` +
      `然后生成 3 个不同风格的回复建议（稳妥safe、温暖warm、坚定firm各一个）。`

    const t0 = Date.now()

    try {
      const response = await llmService.call({
        prompt,
        systemPrompt: DISCUSS_REPLY_SYSTEM_PROMPT,
        maxTokens: 800,
        tier: 'smart',
      })

      const durationMs = Date.now() - t0

      // Parse strategy
      const strategyMatch = response.text.match(/STRATEGY:\s*(.*?)(?=---|$)/s)
      const strategySummary = strategyMatch ? strategyMatch[1].trim() : ''

      // Parse suggestions
      const suggestions = this.parseSuggestions(response.text, ['discussion'])

      // Update discussion status
      intelligenceDb.updateDiscussionStatus(discussionId, 'completed', strategySummary)

      // Log
      try {
        intelligenceDb.logCoachCall({
          contact: ctx.display_name,
          incomingMessage: ctx.incoming_message,
          systemPrompt: DISCUSS_REPLY_SYSTEM_PROMPT,
          userPrompt: prompt,
          llmResponse: response.text,
          parsedSuggestions: JSON.stringify(suggestions),
          modelUsed: response.model,
          durationMs,
          isGroup: ctx.is_group,
          callType: 'discuss_reply',
        })
      } catch { /* non-critical */ }

      return suggestions
    } catch {
      return []
    }
  }

  // ── 5. Direct Reply Generation (simple messages) ────────────

  async generateReplies(
    contact: string,
    message: string,
    selectedContext?: string[],
    refresh?: boolean,
  ): Promise<ReplySuggestion[]> {
    // Check enriched cache
    const cacheKey = contact + crypto.createHash('md5').update(message).digest('hex')
    if (!refresh) {
      const cached = intelligenceDb.getCachedEnrichment(cacheKey)
      if (cached) {
        try {
          return JSON.parse(cached.processedContent)
        } catch { /* fall through */ }
      }
    }

    const ctx = await this.buildContextBundle(contact, message, selectedContext)
    const t0 = Date.now()

    // Build prompt
    const contextParts: string[] = []
    const contextUsed: string[] = []

    if (ctx.rel_context) {
      contextParts.push(`关系信息：${ctx.rel_context}`)
      contextUsed.push('relationship')
    }
    if (ctx.personality_context) {
      contextParts.push(`你的沟通风格：${ctx.personality_context}`)
      contextUsed.push('personality')
    }
    if (ctx.style_examples) {
      contextParts.push(ctx.style_examples)
      contextUsed.push('style_examples')
    }
    if (ctx.feedback_context) {
      contextParts.push(ctx.feedback_context)
      contextUsed.push('feedback')
    }
    if (ctx.history_context) {
      contextParts.push(`最近对话历史：\n${ctx.history_context}`)
      contextUsed.push('history')
    }

    const contextStr = contextParts.length > 0 ? contextParts.join('\n') : '没有额外上下文。'

    const prompt =
      `用户收到了来自「${escapeForPrompt(ctx.display_name, 100)}」的消息：\n` +
      `<user_message>${escapeForPrompt(ctx.incoming_message, 500)}</user_message>\n\n` +
      `<context>\n${contextStr}\n</context>\n\n` +
      `请生成 3 个不同风格的回复建议（稳妥safe、温暖warm、坚定firm各一个）。`

    try {
      const response = await llmService.call({
        prompt,
        systemPrompt: REPLY_COACH_SYSTEM_PROMPT,
        maxTokens: 800,
        tier: 'smart',
      })

      const durationMs = Date.now() - t0
      const suggestions = this.parseSuggestions(response.text, contextUsed)

      // Log
      try {
        intelligenceDb.logCoachCall({
          contact: ctx.display_name,
          incomingMessage: ctx.incoming_message,
          relationshipContext: ctx.rel_context,
          historyContext: ctx.history_context,
          personalityContext: ctx.personality_context,
          systemPrompt: REPLY_COACH_SYSTEM_PROMPT,
          userPrompt: prompt,
          llmResponse: response.text,
          parsedSuggestions: JSON.stringify(suggestions),
          modelUsed: response.model,
          durationMs,
          isGroup: ctx.is_group,
          callType: 'suggest',
        })
      } catch { /* non-critical */ }

      // Cache result
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
      intelligenceDb.setCachedEnrichment(cacheKey, {
        mediaType: 'reply',
        processedContent: JSON.stringify(suggestions),
        expiresAt,
      })

      return suggestions
    } catch {
      return this.generateHeuristicReplies(ctx)
    }
  }

  // ── 6. Analyze Message (unified entry point) ────────────────

  async analyzeMessage(
    contact: string,
    message: string,
    selectedContext?: string[],
  ): Promise<{
    isComplex: boolean
    reason: string
    guideQuestions: string[]
    suggestions?: ReplySuggestion[]
    discussionId?: number
  }> {
    const complexity = await this.analyzeComplexity(contact, message, selectedContext)

    if (complexity.isComplex) {
      // Create discussion session
      const ctx = await this.buildContextBundle(contact, message, selectedContext)
      const discussionId = intelligenceDb.createDiscussion(ctx.display_name, ctx.incoming_message, {
        isComplex: complexity.isComplex,
        complexityReason: complexity.reason,
        guideQuestions: complexity.guideQuestions,
      })
      return {
        ...complexity,
        discussionId,
      }
    }

    // Simple message — generate direct replies
    const suggestions = await this.generateReplies(contact, message, selectedContext)
    return {
      ...complexity,
      suggestions,
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private parseSuggestions(text: string, contextUsed: string[]): ReplySuggestion[] {
    const suggestions: ReplySuggestion[] = []
    const blocks = text.split('---').filter(b => b.trim())

    for (const block of blocks) {
      const replyMatch = block.match(/REPLY:\s*(.*?)(?=REASON:|$)/s)
      const reasonMatch = block.match(/REASON:\s*(.*?)(?=STYLE:|$)/s)
      const styleMatch = block.match(/STYLE:\s*(.*?)$/sm)

      if (replyMatch) {
        const replyText = replyMatch[1].trim()
        const reason = reasonMatch ? reasonMatch[1].trim() : ''
        const styleRaw = styleMatch ? styleMatch[1].trim().toLowerCase() : 'safe'
        const style = (['safe', 'warm', 'firm'].includes(styleRaw) ? styleRaw : 'safe') as 'safe' | 'warm' | 'firm'

        if (replyText) {
          suggestions.push({
            text: replyText,
            reasoning: reason,
            style,
            confidence: 0.8,
            context_used: contextUsed,
          })
        }
      }
    }

    return suggestions
  }

  private generateHeuristicReplies(ctx: ContextBundle): ReplySuggestion[] {
    const msg = ctx.incoming_message
    const hasQuestion = /[？?]|吗|呢/.test(msg)

    if (hasQuestion) {
      return [
        { text: '好的，我看看', reasoning: '简短确认', style: 'safe', confidence: 0.3, context_used: [] },
        { text: '收到，稍后回复你', reasoning: '争取时间', style: 'warm', confidence: 0.3, context_used: [] },
        { text: '这个我需要确认一下', reasoning: '谨慎回应', style: 'firm', confidence: 0.3, context_used: [] },
      ]
    }

    return [
      { text: '好的', reasoning: '简短确认', style: 'safe', confidence: 0.3, context_used: [] },
      { text: '收到啦', reasoning: '友好确认', style: 'warm', confidence: 0.3, context_used: [] },
      { text: '明白', reasoning: '正式确认', style: 'firm', confidence: 0.3, context_used: [] },
    ]
  }

  private buildFeedbackContext(contact: string): string {
    try {
      const feedback = intelligenceDb.getRecentFeedback(contact, 20)
      if (!feedback.length) return ''

      const liked: string[] = []
      const disliked: string[] = []

      for (const f of feedback) {
        const logEntry = intelligenceDb.getCoachLog(f.log_id)
        if (!logEntry) continue
        const suggestions = JSON.parse(logEntry.parsed_suggestions || '[]')
        const idx = f.suggestion_index
        if (idx < suggestions.length) {
          const text = (suggestions[idx].text || '').slice(0, 80)
          const style = suggestions[idx].style || ''
          if (f.rating === 'good') {
            liked.push(`${style}: ${text}`)
          } else if (f.rating === 'bad') {
            disliked.push(`${style}: ${text}`)
          }
        }
      }

      const parts: string[] = []
      if (liked.length) {
        parts.push('用户喜欢的回复风格：\n' + liked.slice(0, 5).map(l => `  ✓ ${l}`).join('\n'))
      }
      if (disliked.length) {
        parts.push('用户不喜欢的回复风格：\n' + disliked.slice(0, 5).map(d => `  ✗ ${d}`).join('\n'))
      }

      // E4: Style learning — inject learned preference
      const pref = intelligenceDb.getStylePreference(contact)
      if (pref) {
        parts.push(`用户对此联系人偏好「${pref.preferred}」风格的回复（基于 ${pref.count} 次选择记录）。请优先推荐此风格。`)
      }

      return parts.join('\n')
    } catch {
      return ''
    }
  }

  // ── Context eviction ────────────────────────────────────────

  clearContextCache(): void {
    this.contextCache.clear()
  }
}

export const replyCoachService = new ReplyCoachService()
