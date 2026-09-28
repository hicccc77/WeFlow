import { createHash } from 'crypto'
import type { AgentMemoryCategory } from './agentMemoryService'

export type AgentMemoryMutationIntent = {
  intentId: string
  content: string
  category?: AgentMemoryCategory
}

export type AgentMemoryMutationIntentStatus =
  | 'pending'
  | 'running'
  | 'updated'
  | 'already-covered'
  | 'failed'

export type AgentMemoryMutationIntentResult = {
  intentId: string
  status: Exclude<AgentMemoryMutationIntentStatus, 'pending' | 'running'> | 'already-completed'
  changed?: boolean
  revision?: number
  error?: string
}

export type AgentMemoryMutationExecutionResult = {
  success: boolean
  changed?: boolean
  skipped?: boolean
  revision?: number
  error?: string
}

export type AgentMemoryMutationBatchResult = {
  success: boolean
  complete: boolean
  transactionId: string
  results: AgentMemoryMutationIntentResult[]
  completedIntentIds: string[]
  failedIntentIds: string[]
  nextAction: string
}

type IntentState = {
  intent: AgentMemoryMutationIntent
  fingerprint: string
  status: AgentMemoryMutationIntentStatus
  changed?: boolean
  revision?: number
  error?: string
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim()
}

function normalizeIntentId(value: unknown): string {
  return clean(value).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 64)
}

function intentFingerprint(intent: AgentMemoryMutationIntent): string {
  return createHash('sha256')
    .update(`${intent.content}\u0000${intent.category || ''}`)
    .digest('base64url')
    .slice(0, 24)
}

export function normalizeAgentMemoryMutationIntents(values: unknown): AgentMemoryMutationIntent[] {
  if (!Array.isArray(values)) return []
  return values.slice(0, 12).flatMap((value, index) => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const content = clean(record.content).slice(0, 600)
    if (!content) return []
    const intentId = normalizeIntentId(record.intentId) || `intent-${index + 1}`
    const category = clean(record.category) as AgentMemoryCategory
    return [{
      intentId,
      content,
      category: category || undefined,
    }]
  })
}

export class AgentMemoryMutationTransaction {
  private readonly intents = new Map<string, IntentState>()
  private sealed = false

  constructor(readonly transactionId: string) {}

  get declared(): boolean {
    return this.sealed
  }

  get complete(): boolean {
    return this.sealed
      && this.intents.size > 0
      && Array.from(this.intents.values()).every((state) => (
        state.status === 'updated' || state.status === 'already-covered'
      ))
  }

  get hasFailures(): boolean {
    return Array.from(this.intents.values()).some((state) => state.status === 'failed')
  }

  processedTurnId(intent: AgentMemoryMutationIntent): string {
    const fingerprint = intentFingerprint(intent)
    return `explicit-memory-${this.transactionId}-${intent.intentId}-${fingerprint}`.slice(0, 180)
  }

  register(values: unknown): {
    executable: AgentMemoryMutationIntent[]
    immediate: AgentMemoryMutationIntentResult[]
  } {
    const normalized = normalizeAgentMemoryMutationIntents(values)
    const executable: AgentMemoryMutationIntent[] = []
    const immediate: AgentMemoryMutationIntentResult[] = []

    if (!this.sealed) {
      for (const intent of normalized) {
        const existing = this.intents.get(intent.intentId)
        if (existing) {
          immediate.push({
            intentId: intent.intentId,
            status: 'failed',
            error: existing.fingerprint === intentFingerprint(intent)
              ? '同一批次中出现了重复的 intentId'
              : '同一批次中的 intentId 对应了不同内容',
          })
          continue
        }
        this.intents.set(intent.intentId, {
          intent,
          fingerprint: intentFingerprint(intent),
          status: 'pending',
        })
      }
      this.sealed = this.intents.size > 0
    }

    for (const intent of normalized) {
      const state = this.intents.get(intent.intentId)
      if (!state) {
        immediate.push({
          intentId: intent.intentId,
          status: 'failed',
          error: '本轮记忆意图清单已经确定，不能在后续调用中追加新项目',
        })
        continue
      }
      if (state.fingerprint !== intentFingerprint(intent)) {
        immediate.push({
          intentId: intent.intentId,
          status: 'failed',
          error: '同一个 intentId 的内容与首次声明不一致',
        })
        continue
      }
      if (state.status === 'updated' || state.status === 'already-covered') {
        immediate.push({
          intentId: intent.intentId,
          status: 'already-completed',
          changed: state.changed,
          revision: state.revision,
        })
        continue
      }
      if (state.status === 'running') {
        immediate.push({
          intentId: intent.intentId,
          status: 'failed',
          error: '这一记忆意图正在执行，不能并行重复提交',
        })
        continue
      }
      state.status = 'running'
      if (!executable.some((candidate) => candidate.intentId === intent.intentId)) executable.push(state.intent)
    }
    return { executable, immediate }
  }

  record(intentId: string, result: AgentMemoryMutationExecutionResult): AgentMemoryMutationIntentResult {
    const state = this.intents.get(intentId)
    if (!state) return { intentId, status: 'failed', error: '未找到对应的记忆意图' }
    if (!result.success) {
      state.status = 'failed'
      state.error = clean(result.error).slice(0, 500) || '记忆更新失败'
      state.changed = false
      state.revision = result.revision
      return {
        intentId,
        status: 'failed',
        changed: false,
        revision: result.revision,
        error: state.error,
      }
    }
    state.status = result.changed === true ? 'updated' : 'already-covered'
    state.changed = result.changed === true
    state.revision = result.revision
    state.error = undefined
    return {
      intentId,
      status: state.status,
      changed: state.changed,
      revision: state.revision,
    }
  }

  restore(values: unknown, results: unknown): void {
    const { executable } = this.register(values)
    const byId = new Map(executable.map((intent) => [intent.intentId, intent]))
    for (const value of Array.isArray(results) ? results : []) {
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const intentId = normalizeIntentId(record.intentId)
      const state = this.intents.get(intentId)
      if (!state || !byId.has(intentId)) continue
      const status = clean(record.status)
      if (status === 'updated' || status === 'already-covered' || status === 'already-completed') {
        state.status = status === 'updated' ? 'updated' : 'already-covered'
        state.changed = record.changed === true
        state.revision = Number.isFinite(Number(record.revision)) ? Number(record.revision) : undefined
        state.error = undefined
      } else if (status === 'failed') {
        state.status = 'failed'
        state.changed = false
        state.error = clean(record.error).slice(0, 500) || '记忆更新失败'
      }
    }
  }

  result(callResults: AgentMemoryMutationIntentResult[] = []): AgentMemoryMutationBatchResult {
    const completedIntentIds: string[] = []
    const failedIntentIds: string[] = []
    const results = Array.from(this.intents.values()).map((state): AgentMemoryMutationIntentResult => {
      if (state.status === 'updated' || state.status === 'already-covered') {
        completedIntentIds.push(state.intent.intentId)
        return {
          intentId: state.intent.intentId,
          status: state.status,
          changed: state.changed,
          revision: state.revision,
        }
      }
      if (state.status === 'failed' || state.status === 'pending' || state.status === 'running') {
        failedIntentIds.push(state.intent.intentId)
      }
      return {
        intentId: state.intent.intentId,
        status: state.status === 'pending' || state.status === 'running' ? 'failed' : state.status,
        changed: state.changed,
        revision: state.revision,
        error: state.error || (
          state.status === 'running'
            ? '记忆意图正在执行'
            : state.status === 'pending' ? '记忆意图尚未执行' : undefined
        ),
      }
    })
    for (const result of callResults) {
      if (!results.some((candidate) => candidate.intentId === result.intentId)) results.push(result)
    }
    const complete = this.complete && !callResults.some((result) => result.status === 'failed')
    return {
      success: complete,
      complete,
      transactionId: this.transactionId,
      results,
      completedIntentIds,
      failedIntentIds,
      nextAction: complete
        ? '本轮声明的记忆意图已经全部完成。不要再次调用记忆更新工具，请直接完成对用户的回答。'
        : '只重试 failedIntentIds 中尚未完成的项目，并沿用首次声明的 intentId 和原始内容；不要重写已经完成的项目。',
    }
  }

  feedback(label: string): string {
    if (!this.declared) return ''
    const result = this.result()
    return result.complete
      ? `${label}已完成：${result.completedIntentIds.join('、')}。不要再次调用对应的记忆工具，直接完成回答。`
      : `${label}尚未全部完成。已完成：${result.completedIntentIds.join('、') || '无'}；待重试：${result.failedIntentIds.join('、') || '无'}。只能重试失败项目，不能改写成功项目。`
  }
}

export async function executeAgentMemoryMutationBatch(
  transaction: AgentMemoryMutationTransaction,
  values: unknown,
  execute: (intent: AgentMemoryMutationIntent, processedTurnId: string) => Promise<AgentMemoryMutationExecutionResult>,
): Promise<AgentMemoryMutationBatchResult> {
  const prepared = transaction.register(values)
  const callResults = [...prepared.immediate]
  for (const intent of prepared.executable) {
    try {
      const result = await execute(intent, transaction.processedTurnId(intent))
      callResults.push(transaction.record(intent.intentId, result))
    } catch (error) {
      callResults.push(transaction.record(intent.intentId, {
        success: false,
        error: error instanceof Error ? error.message : String(error || '记忆更新失败'),
      }))
    }
  }
  return transaction.result(callResults)
}
