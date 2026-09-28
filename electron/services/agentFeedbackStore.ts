import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { AgentRunStore } from './agentRunStore'

export type AgentAnswerFeedback = {
  messageId: string
  runId?: string
  conversationId?: number
  rating: 'up' | 'down'
  reason?: AgentFeedbackReason
  at: number
  answerHash?: string
  runContext?: {
    datasetFingerprint?: string
    pageHashes: string[]
    tools: string[]
    finalAnswerHash?: string
  }
}

export type AgentFeedbackReason =
  | 'incorrect'
  | 'missing'
  | 'overreach'
  | 'unclear'
  | 'verbose'
  | 'shallow'
  | 'direct'
  | 'clear'
  | 'thorough'
  | 'evidence'
  | 'tone'
  | 'method'

export type AgentFeedbackMemorySample = {
  evidenceId: string
  messageId: string
  runId: string
  conversationId?: number
  rating: AgentAnswerFeedback['rating']
  reason?: AgentFeedbackReason
  at: number
  question: string
  answer: string
  answerHash: string
}

export type AgentFeedbackMemoryEvidence = {
  eligible: boolean
  fingerprint: string
  helpfulCount: number
  needsImprovementCount: number
  samples: AgentFeedbackMemorySample[]
}

export type AgentFeedbackSummary = {
  ratedAnswers: number
  helpful: number
  needsImprovement: number
  reasonCounts: Partial<Record<NonNullable<AgentAnswerFeedback['reason']>, number>>
  recent: Array<Pick<AgentAnswerFeedback, 'rating' | 'reason' | 'at'>>
}

type FeedbackEnvelope = {
  version: 1
  records: AgentAnswerFeedback[]
}

function normalize(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim()
}

const POSITIVE_FEEDBACK_REASONS = new Set<AgentFeedbackReason>(['direct', 'clear', 'thorough', 'evidence', 'tone', 'method'])
const NEGATIVE_FEEDBACK_REASONS = new Set<AgentFeedbackReason>(['incorrect', 'missing', 'overreach', 'unclear', 'verbose', 'shallow', 'tone', 'method'])

const MIN_MATCHING_FEEDBACK = 3
const MAX_MEMORY_FEEDBACK_SAMPLES = 48

function feedbackReasonAllowed(rating: AgentAnswerFeedback['rating'], reason: unknown): reason is AgentFeedbackReason {
  return rating === 'up'
    ? POSITIVE_FEEDBACK_REASONS.has(reason as AgentFeedbackReason)
    : NEGATIVE_FEEDBACK_REASONS.has(reason as AgentFeedbackReason)
}

function normalizeFeedbackMemorySamples(
  samples: AgentFeedbackMemorySample[],
  limit = MAX_MEMORY_FEEDBACK_SAMPLES,
): AgentFeedbackMemorySample[] {
  const byEvidence = new Map<string, AgentFeedbackMemorySample>()
  const ordered = [...samples].sort((left, right) => left.at - right.at)
  for (const sample of ordered) {
    const question = normalize(sample.question).slice(0, 2_000)
    const answer = normalize(sample.answer).slice(0, 6_000)
    const runId = normalize(sample.runId).slice(0, 180)
    const messageId = normalize(sample.messageId).slice(0, 240)
    if (!runId || !messageId || !question || !answer) continue
    const answerHash = normalize(sample.answerHash)
      || createHash('sha256').update(answer).digest('base64url')
    // 同一个运行或完全相同的回答只算一份证据，防止重复消息和重放放大权重。
    const evidenceId = answerHash || runId
    byEvidence.set(evidenceId, {
      evidenceId,
      messageId,
      runId,
      conversationId: Number(sample.conversationId) > 0 ? Number(sample.conversationId) : undefined,
      rating: sample.rating,
      reason: feedbackReasonAllowed(sample.rating, sample.reason) ? sample.reason : undefined,
      at: Math.max(1, Number(sample.at) || Date.now()),
      question,
      answer,
      answerHash,
    })
  }
  return Array.from(byEvidence.values())
    .sort((left, right) => left.at - right.at)
    .slice(-Math.max(1, Math.min(MAX_MEMORY_FEEDBACK_SAMPLES, Math.floor(limit || MAX_MEMORY_FEEDBACK_SAMPLES))))
}

export function buildAgentFeedbackMemoryEvidence(
  samples: AgentFeedbackMemorySample[],
  limit = MAX_MEMORY_FEEDBACK_SAMPLES,
): AgentFeedbackMemoryEvidence {
  const normalized = normalizeFeedbackMemorySamples(samples, limit)
  const helpfulCount = normalized.filter((sample) => sample.rating === 'up').length
  const needsImprovementCount = normalized.filter((sample) => sample.rating === 'down').length
  const fingerprintSource = [...normalized]
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map((sample) => ({
      evidenceId: sample.evidenceId,
      rating: sample.rating,
      reason: sample.reason || '',
    }))
  return {
    eligible: helpfulCount >= MIN_MATCHING_FEEDBACK || needsImprovementCount >= MIN_MATCHING_FEEDBACK,
    fingerprint: normalized.length > 0
      ? createHash('sha256').update(JSON.stringify(fingerprintSource)).digest('base64url')
      : '',
    helpfulCount,
    needsImprovementCount,
    samples: normalized,
  }
}

export class AgentFeedbackStore {
  constructor(private readonly rootDir: string) {}

  private filePath(): string {
    return join(this.rootDir, 'agent-feedback.json')
  }

  private read(): AgentAnswerFeedback[] {
    if (!existsSync(this.filePath())) return []
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(), 'utf8')) as FeedbackEnvelope
      return parsed?.version === 1 && Array.isArray(parsed.records) ? parsed.records : []
    } catch {
      return []
    }
  }

  private write(records: AgentAnswerFeedback[]): void {
    const path = this.filePath()
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, records } satisfies FeedbackEnvelope, null, 2), 'utf8')
    renameSync(temporary, path)
  }

  save(input: {
    messageId: string
    runId?: string
    conversationId?: number | null
    rating: 'up' | 'down'
    reason?: AgentAnswerFeedback['reason']
    at?: number
    answer?: string
  }): AgentAnswerFeedback {
    const messageId = normalize(input.messageId).slice(0, 240)
    if (!messageId) throw new Error('反馈缺少 messageId')
    const runId = normalize(input.runId).slice(0, 180) || undefined
    const run = runId ? AgentRunStore.load(this.rootDir, runId) : null
    const answer = normalize(input.answer)
    const reason = feedbackReasonAllowed(input.rating, input.reason) ? input.reason : undefined
    const record: AgentAnswerFeedback = {
      messageId,
      runId,
      conversationId: Number(input.conversationId) > 0 ? Number(input.conversationId) : undefined,
      rating: input.rating,
      reason,
      at: Math.max(1, Number(input.at) || Date.now()),
      answerHash: answer ? createHash('sha256').update(answer).digest('base64url') : undefined,
      runContext: run ? {
        datasetFingerprint: run.dataContext?.datasetFingerprint,
        pageHashes: (run.research?.readPages || []).map((page) => page.pageHash),
        tools: run.toolCalls.map((call) => call.toolName),
        finalAnswerHash: run.finalAnswer
          ? createHash('sha256').update(run.finalAnswer).digest('base64url')
          : undefined,
      } : undefined,
    }
    const records = this.read()
    const index = records.findIndex((item) => item.messageId === messageId)
    if (index >= 0) records[index] = record
    else records.push(record)
    this.write(records.slice(-5_000))
    return record
  }

  delete(messageId: string): boolean {
    const normalized = normalize(messageId)
    const records = this.read()
    const next = records.filter((record) => record.messageId !== normalized)
    if (next.length === records.length) return false
    this.write(next)
    return true
  }

  list(limit = 500): AgentAnswerFeedback[] {
    return this.read()
      .sort((left, right) => right.at - left.at)
      .slice(0, Math.max(1, Math.min(5_000, Math.floor(limit || 500))))
  }

  memoryEvidence(limit = MAX_MEMORY_FEEDBACK_SAMPLES): AgentFeedbackMemoryEvidence {
    const samples = this.read().flatMap((record): AgentFeedbackMemorySample[] => {
      const runId = normalize(record.runId).slice(0, 180)
      if (!runId) return []
      const run = AgentRunStore.load(this.rootDir, runId)
      const question = normalize(run?.question)
      const answer = normalize(run?.finalAnswer)
      if (!run || run.status !== 'completed' || !question || !answer) return []
      const answerHash = createHash('sha256').update(answer).digest('base64url')
      return [{
        evidenceId: answerHash,
        messageId: record.messageId,
        runId,
        conversationId: record.conversationId,
        rating: record.rating,
        reason: record.reason,
        at: record.at,
        question,
        answer,
        answerHash,
      }]
    })
    return buildAgentFeedbackMemoryEvidence(samples, limit)
  }

  summarizeForConversation(conversationId?: number | null, limit = 20): AgentFeedbackSummary | null {
    const normalizedConversationId = Number(conversationId) > 0 ? Number(conversationId) : 0
    if (!normalizedConversationId) return null
    const records = this.read()
      .filter((record) => record.conversationId === normalizedConversationId)
      .sort((left, right) => right.at - left.at)
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit || 20))))
    if (records.length === 0) return null
    const reasonCounts: AgentFeedbackSummary['reasonCounts'] = {}
    for (const record of records) {
      if (record.reason) reasonCounts[record.reason] = (reasonCounts[record.reason] || 0) + 1
    }
    return {
      ratedAnswers: records.length,
      helpful: records.filter((record) => record.rating === 'up').length,
      needsImprovement: records.filter((record) => record.rating === 'down').length,
      reasonCounts,
      recent: records.slice(0, 8).map(({ rating, reason, at }) => ({ rating, reason, at })),
    }
  }
}
