/**
 * Intelligence module type definitions
 *
 * Exports:
 * - MediaContext: processed media content for LLM context
 * - WCDBMessage: simplified WCDB message structure
 * - ContentFilter / ContentItem / ContentAnalysis: content hub types
 * - ContextBundle / DiscussionRound / DiscussionSession: discussion mode types
 * - ReplySuggestion / Relationship: reply coach types
 * - LLMProvider / LLMRequest / LLMResponse: LLM service types
 * - IntelligenceConfig: configuration interface
 */

// ─── Media Context ──────────────────────────────────────────────

export interface MediaContext {
  type: 'image' | 'voice' | 'video' | 'article' | 'video-channel' | 'forward' | 'miniapp'
  originalContent: string
  processedContent: string
  base64Data?: string
  mediaType?: string
  metadata?: Record<string, any>
}

// ─── WCDB Message (simplified) ──────────────────────────────────

export interface WCDBMessage {
  localId: number
  localType: number
  parsedContent?: string
  rawContent?: string
  sessionId?: string
  createTime?: number
  sender?: string
  /** Parsed type 49 fields */
  xmlType?: string
  appMsgKind?: string
  linkTitle?: string
  linkUrl?: string
  linkThumb?: string
  appMsgDesc?: string
  appMsgAppName?: string
  appMsgSourceName?: string
  appMsgSourceUsername?: string
  finderNickname?: string
  finderCoverUrl?: string
  finderDuration?: number
  fileName?: string
  fileSize?: number
  fileExt?: string
  imageMd5?: string
  chatRecordTitle?: string
  chatRecordList?: ChatRecordItem[]
}

export interface ChatRecordItem {
  datatype: number
  sourcename: string
  sourcetime: string
  sourceheadurl?: string
  datadesc?: string
  datatitle?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  dataurl?: string
  datathumburl?: string
  chatRecordTitle?: string
  chatRecordList?: ChatRecordItem[]
}

// ─── Content Hub ────────────────────────────────────────────────

export interface ContentFilter {
  types?: Array<'official-article' | 'video-channel' | 'link' | 'file' | 'miniapp'>
  sources?: Array<'private' | 'group' | 'sns'>
  contactId?: string
  timeRange?: {
    start: number
    end: number
  }
  keyword?: string
  page?: number
  pageSize?: number
}

export interface ContentItem {
  id: string
  type: 'official-article' | 'video-channel' | 'link' | 'file' | 'miniapp'
  title: string
  description?: string
  url?: string
  thumbnailUrl?: string
  source: {
    contactName: string
    sessionId: string
    sessionName?: string
    isGroup: boolean
  }
  metadata?: Record<string, any>
  timestamp: number
  bookmarked?: boolean
  ignored?: boolean
}

export interface ContentAnalysis {
  contentId: string
  summary: string
  senderContext: string
  motivation: string
  relevance: string
  suggestedResponse: string
  analyzedAt: string
}

// ─── Discussion Mode ────────────────────────────────────────────

export interface ContextBundle {
  display_name: string
  contact_name: string
  incoming_message: string
  rel_context: string
  history_context: string
  personality_context: string
  style_examples: string
  feedback_context: string
  is_group: boolean
  relationship: Relationship | null
  recent_records: any[]
}

export interface DiscussionRound {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface DiscussionSession {
  id: number
  contact: string
  incoming_message: string
  rounds: DiscussionRound[]
  strategy_summary: string | null
  status: 'active' | 'completed' | 'cancelled'
  guide_questions: string[]
  is_complex: boolean
  complexity_reason: string
  created_at: string
  updated_at: string
}

// ─── Reply Coach ────────────────────────────────────────────────

export interface ReplySuggestion {
  text: string
  reasoning: string
  style: 'safe' | 'warm' | 'firm'
  confidence: number
  context_used: string[]
}

export interface Relationship {
  contact_name: string
  relationship_type: string
  closeness: number
  communication_style: string
  topics: string[]
  dynamics: string
  last_updated: string
}

// ─── LLM Service ────────────────────────────────────────────────

export type LLMProviderType = 'anthropic' | 'openai' | 'ollama' | 'claude-code' | 'mock'

export interface LLMRequest {
  prompt: string
  systemPrompt?: string
  model?: string
  maxTokens?: number
  temperature?: number
  /** For vision requests */
  images?: Array<{
    base64Data: string
    mediaType: string
  }>
  /** fast = small model, smart = large model */
  tier?: 'fast' | 'smart'
}

export interface LLMResponse {
  text: string
  model: string
  provider: LLMProviderType
  tokensUsed?: number
  latencyMs?: number
}

// ─── Intelligence Config ────────────────────────────────────────

export interface IntelligenceConfig {
  llmProvider: LLMProviderType
  llmModel: string
  llmFastModel: string
  llmApiKey: string
  llmBaseUrl: string

  intelligenceEnabled: boolean
  replyCoachEnabled: boolean
  discussionEnabled: boolean
  briefingEnabled: boolean
  graphEnabled: boolean

  mediaVisionEnabled: boolean
  mediaVideoEnabled: boolean
  mediaArticleFetchEnabled: boolean
  mediaMaxImageSizeMB: number
  mediaKeyframeCount: number
  mediaKeyframeIntervalSec: number

  discussionMaxRounds: number
  discussionAutoAnalyze: boolean

  briefingAutoGenerate: boolean
  briefingTime: string

  coachLogEnabled: boolean
  coachLogRetentionDays: number
}

// ─── Coach Discussion (DB) ─────────────────────────────────────

export interface CoachDiscussion {
  id: number
  contact: string
  incomingMessage: string
  rounds: DiscussionRound[]
  strategySummary: string | null
  status: 'active' | 'completed' | 'cancelled'
  guideQuestions: string[]
  isComplex: boolean
  complexityReason: string
  createdAt: string
  updatedAt: string
}

// ─── Contact Preference ────────────────────────────────────────

export interface ContactPreference {
  contactName: string
  isStarred: boolean
  isIgnored: boolean
  priority: number
  updatedAt: string
}

// ─── Identity Alias ────────────────────────────────────────────

export interface IdentityAlias {
  alias: string
  canonicalName: string
}

// ─── Enriched Cache ────────────────────────────────────────────

export interface EnrichedCacheEntry {
  cacheKey: string
  mediaType: string
  processedContent: string
  base64Data: string | null
  metadata: Record<string, any>
  createdAt: string
  expiresAt: string | null
}

// ─── Daily Briefing ────────────────────────────────────────────

export interface BriefingItem {
  category: 'unreplied' | 'delivery' | 'reminder' | 'event' | 'insight'
  title: string
  detail: string
  sourcePlatform: string
  contact: string
  priority: number
  recordId: string
}

export interface DailyBriefing {
  date: string
  items: BriefingItem[]
  summary: string
  generatedAt: string
  modelUsed: string
}

// ─── PUA Detection ─────────────────────────────────────────────

export interface PUASignal {
  pattern: string
  severity: 'low' | 'medium' | 'high'
  description: string
  evidence: string
  contact: string
  advice: string
  recordId: string
}

export interface PUAReport {
  contact: string
  signals: PUASignal[]
  riskLevel: 'low' | 'medium' | 'high'
  summary: string
  analyzedAt: string
}

// ─── Growth Advisor ────────────────────────────────────────────

export interface GrowthInsight {
  category: 'communication' | 'productivity' | 'social' | 'learning' | 'health' | 'finance'
  observation: string
  suggestion: string
  evidence: string
  priority: 'low' | 'medium' | 'high'
}

export interface GrowthReport {
  periodDays: number
  insights: GrowthInsight[]
  strengths: string[]
  areasToImprove: string[]
  weeklyGoals: string[]
  summary: string
  generatedAt: string
}

// ─── Purchase Advisor ──────────────────────────────────────────

export interface SpendingItem {
  platform: string
  amount: number
  currency: string
  description: string
  date: string
  category: string
  recordId: string
}

export interface PurchaseRecommendation {
  item: string
  reason: string
  estimatedPrice: string
  urgency: 'low' | 'medium' | 'high'
  category: string
}

export interface PurchaseReport {
  periodDays: number
  totalSpending: number
  currency: string
  spendingByCategory: Record<string, number>
  spendingByPlatform: Record<string, number>
  topItems: SpendingItem[]
  recommendations: PurchaseRecommendation[]
  insights: string[]
  generatedAt: string
}

export const INTELLIGENCE_DEFAULTS: IntelligenceConfig = {
  llmProvider: 'mock',
  llmModel: '',
  llmFastModel: '',
  llmApiKey: '',
  llmBaseUrl: '',

  intelligenceEnabled: true,
  replyCoachEnabled: true,
  discussionEnabled: true,
  briefingEnabled: true,
  graphEnabled: true,

  mediaVisionEnabled: true,
  mediaVideoEnabled: false,
  mediaArticleFetchEnabled: true,
  mediaMaxImageSizeMB: 5,
  mediaKeyframeCount: 4,
  mediaKeyframeIntervalSec: 5,

  discussionMaxRounds: 3,
  discussionAutoAnalyze: true,

  briefingAutoGenerate: false,
  briefingTime: '08:00',

  coachLogEnabled: true,
  coachLogRetentionDays: 30,
}
