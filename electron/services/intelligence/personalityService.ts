/**
 * Personality Service — communication style analysis and per-contact overrides.
 *
 * Enhanced with:
 * - Fingerprint service integration
 * - Per-contact fine-grained style analysis
 * - Style change tracking
 *
 * Ported from One's personality.py to TypeScript.
 */

import { intelligenceDb } from './intelligenceDb'
import { llmService } from './llmService'
import { fingerprintService, BehavioralFingerprint } from './fingerprintService'

// ─── Data Models ───────────────────────────────────────────────

export interface PersonalityProfile {
  overallStyle: string
  perContactStyle: Record<string, string>
  traits: string[]
  communicationPreferences: {
    messageLength: 'short' | 'medium' | 'long'
    emojiUsage: 'none' | 'rare' | 'moderate' | 'frequent'
    formalityLevel: 'casual' | 'neutral' | 'formal'
    responseSpeed: 'fast' | 'medium' | 'slow'
  }
  lastUpdated: string
}

export interface StyleChange {
  contactName: string
  oldStyle: string
  newStyle: string
  reason: string
  detectedAt: string
}

// ─── Service ───────────────────────────────────────────────────

export class PersonalityService {

  /**
   * Get the user's overall personality profile.
   */
  getProfile(): PersonalityProfile {
    const overallStyle = intelligenceDb.getPersonalityValue('overall_style') || ''
    const traitsJson = intelligenceDb.getPersonalityValue('traits') || '[]'
    const prefsJson = intelligenceDb.getPersonalityValue('communication_preferences') || '{}'
    const lastUpdated = intelligenceDb.getPersonalityValue('last_updated') || ''

    let traits: string[] = []
    try { traits = JSON.parse(traitsJson) } catch { /* ignore */ }

    let prefs: PersonalityProfile['communicationPreferences'] = {
      messageLength: 'medium',
      emojiUsage: 'moderate',
      formalityLevel: 'neutral',
      responseSpeed: 'medium',
    }
    try { prefs = { ...prefs, ...JSON.parse(prefsJson) } } catch { /* ignore */ }

    // Collect per-contact styles
    const perContactStyle: Record<string, string> = {}
    const contacts = intelligenceDb.getAllContacts()
    for (const contact of contacts) {
      const style = intelligenceDb.getPerContactStyle(contact.name)
      if (style) {
        perContactStyle[contact.name] = style
      }
    }

    return {
      overallStyle,
      perContactStyle,
      traits,
      communicationPreferences: prefs,
      lastUpdated,
    }
  }

  /**
   * Update the overall style description.
   */
  setOverallStyle(style: string): void {
    intelligenceDb.setPersonalityValue('overall_style', style)
    intelligenceDb.setPersonalityValue('last_updated', new Date().toISOString())
  }

  /**
   * Get per-contact style for a specific contact.
   */
  getContactStyle(contactName: string): string {
    const resolved = intelligenceDb.resolve(contactName)
    return intelligenceDb.getPerContactStyle(resolved)
      || intelligenceDb.getPerContactStyle(contactName)
      || ''
  }

  /**
   * Set per-contact style override.
   */
  setContactStyle(contactName: string, style: string): void {
    const resolved = intelligenceDb.resolve(contactName)
    intelligenceDb.setPerContactStyle(resolved, style)
  }

  /**
   * Analyze messages to derive communication style for a specific contact.
   * Uses LLM to generate a style description.
   */
  async analyzeContactStyle(
    contactName: string,
    messages: Array<{ sender: string; content: string; isSend: boolean }>,
  ): Promise<string> {
    const myMessages = messages
      .filter(m => m.isSend && m.content.length > 4)
      .slice(0, 15)

    if (myMessages.length < 3) {
      return '消息数量不足，无法分析沟通风格'
    }

    const examples = myMessages
      .map(m => `  - ${m.content.slice(0, 100)}`)
      .join('\n')

    const prompt =
      `分析以下用户发给「${contactName}」的消息，总结用户的沟通风格（2-3句话）。\n` +
      `关注：语气、措辞习惯、emoji使用、消息长度偏好、礼貌程度。\n\n` +
      `用户的消息样本：\n${examples}`

    try {
      const response = await llmService.call({
        prompt,
        systemPrompt: '你是一个沟通风格分析师。分析用户的消息样本，输出简洁的风格描述。不要客套，直接描述风格特点。',
        tier: 'fast',
        maxTokens: 200,
      })

      const style = response.text.trim()
      this.setContactStyle(contactName, style)
      return style
    } catch {
      return '风格分析服务暂不可用'
    }
  }

  /**
   * Analyze overall communication style from message data.
   */
  async analyzeOverallStyle(
    messages: Array<{ sender: string; content: string; isSend: boolean; timestamp: number }>,
  ): Promise<PersonalityProfile> {
    const sentMessages = messages.filter(m => m.isSend && m.content.length > 4)

    // Compute basic metrics
    const avgLength = sentMessages.length > 0
      ? sentMessages.reduce((sum, m) => sum + m.content.length, 0) / sentMessages.length
      : 0

    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/gu
    const emojiCount = sentMessages.reduce((sum, m) => {
      const matches = m.content.match(emojiPattern)
      return sum + (matches ? matches.length : 0)
    }, 0)
    const emojiRate = sentMessages.length > 0 ? emojiCount / sentMessages.length : 0

    const messageLength: 'short' | 'medium' | 'long' =
      avgLength < 20 ? 'short' : avgLength < 80 ? 'medium' : 'long'

    const emojiUsage: 'none' | 'rare' | 'moderate' | 'frequent' =
      emojiRate === 0 ? 'none' : emojiRate < 0.1 ? 'rare' : emojiRate < 0.5 ? 'moderate' : 'frequent'

    // Detect formality
    const formalIndicators = sentMessages.filter(m =>
      /您|请|谢谢|感谢|辛苦/.test(m.content)
    ).length
    const formalityLevel: 'casual' | 'neutral' | 'formal' =
      formalIndicators / Math.max(1, sentMessages.length) > 0.3 ? 'formal'
      : formalIndicators / Math.max(1, sentMessages.length) > 0.1 ? 'neutral'
      : 'casual'

    const prefs = {
      messageLength,
      emojiUsage,
      formalityLevel,
      responseSpeed: 'medium' as const,
    }

    // Generate style description via LLM
    let overallStyle = ''
    try {
      const examples = sentMessages.slice(0, 10)
        .map(m => `  - ${m.content.slice(0, 80)}`)
        .join('\n')

      const response = await llmService.call({
        prompt: `分析用户的整体沟通风格（2句话）：\n${examples}`,
        systemPrompt: '你是沟通风格分析师。简洁描述用户的沟通风格特点。',
        tier: 'fast',
        maxTokens: 150,
      })
      overallStyle = response.text.trim()
    } catch {
      overallStyle = `消息风格：${messageLength}消息，${emojiUsage === 'none' ? '不用emoji' : `emoji${emojiUsage}`}，${formalityLevel}语气`
    }

    // Save
    intelligenceDb.setPersonalityValue('overall_style', overallStyle)
    intelligenceDb.setPersonalityValue('traits', JSON.stringify([]))
    intelligenceDb.setPersonalityValue('communication_preferences', JSON.stringify(prefs))
    intelligenceDb.setPersonalityValue('last_updated', new Date().toISOString())

    return this.getProfile()
  }

  /**
   * Integrate with fingerprint service: update personality based on
   * behavioral fingerprint analysis.
   */
  updateFromFingerprint(fingerprint: BehavioralFingerprint): void {
    const metrics = fingerprint.rawMetrics

    // Update communication preferences from fingerprint metrics
    if (metrics.avg_content_length !== undefined) {
      const len = metrics.avg_content_length
      const messageLength = len < 20 ? 'short' : len < 80 ? 'medium' : 'long'
      const currentPrefs = intelligenceDb.getPersonalityValue('communication_preferences') || '{}'
      try {
        const prefs = JSON.parse(currentPrefs)
        prefs.messageLength = messageLength
        intelligenceDb.setPersonalityValue('communication_preferences', JSON.stringify(prefs))
      } catch { /* ignore */ }
    }

    if (metrics.emoji_rate !== undefined) {
      const rate = metrics.emoji_rate
      const emojiUsage = rate === 0 ? 'none' : rate < 0.1 ? 'rare' : rate < 0.5 ? 'moderate' : 'frequent'
      const currentPrefs = intelligenceDb.getPersonalityValue('communication_preferences') || '{}'
      try {
        const prefs = JSON.parse(currentPrefs)
        prefs.emojiUsage = emojiUsage
        intelligenceDb.setPersonalityValue('communication_preferences', JSON.stringify(prefs))
      } catch { /* ignore */ }
    }
  }

  /**
   * Detect style changes for a contact over time.
   */
  detectStyleChanges(
    contactName: string,
    newMessages: Array<{ content: string; isSend: boolean }>,
  ): StyleChange | null {
    const currentStyle = this.getContactStyle(contactName)
    if (!currentStyle) return null

    // Simple heuristic: check if message patterns differ significantly
    const sentMsgs = newMessages.filter(m => m.isSend)
    if (sentMsgs.length < 5) return null

    const avgLen = sentMsgs.reduce((s, m) => s + m.content.length, 0) / sentMsgs.length
    const emojiCount = sentMsgs.reduce((s, m) => {
      const matches = m.content.match(/[\u{1F600}-\u{1F64F}]/gu)
      return s + (matches ? matches.length : 0)
    }, 0)
    const emojiRate = emojiCount / sentMsgs.length

    // Detect major changes
    if (currentStyle.includes('简短') && avgLen > 80) {
      return {
        contactName,
        oldStyle: currentStyle,
        newStyle: `消息变长（平均${Math.round(avgLen)}字）`,
        reason: '消息长度显著增加',
        detectedAt: new Date().toISOString(),
      }
    }
    if (currentStyle.includes('不用emoji') && emojiRate > 0.3) {
      return {
        contactName,
        oldStyle: currentStyle,
        newStyle: '开始频繁使用emoji',
        reason: 'emoji使用频率显著增加',
        detectedAt: new Date().toISOString(),
      }
    }

    return null
  }
}

export const personalityService = new PersonalityService()
