export type InvestigationPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped'

export type InvestigationPlanStep = {
  id: string
  title: string
  purpose?: string
  status: InvestigationPlanStepStatus
  note?: string
}

export type InvestigationPlan = {
  title: string
  questionUnderstanding: string
  answerRequirements: string[]
  uncertainties: string[]
  researchIntent?: {
    compareSources: boolean
    traceChangesOverTime: boolean
    readCompleteEvents: boolean
    rationale?: string
  }
  steps: InvestigationPlanStep[]
  updatedAt?: number
}

const PLAN_TOOL_NAMES = new Set(['set_investigation_plan', 'update_investigation_plan'])
const PLAN_STATUSES = new Set<InvestigationPlanStepStatus>(['pending', 'in_progress', 'completed', 'skipped'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, maxLength) : ''
}

function cleanList(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => cleanText(item, 400)).filter(Boolean))).slice(0, limit)
}

function normalizeResearchIntent(value: unknown, fallback?: InvestigationPlan['researchIntent']): InvestigationPlan['researchIntent'] | undefined {
  const record = asRecord(value)
  if (!record) return fallback ? { ...fallback } : undefined
  return {
    compareSources: record.compareSources === undefined ? Boolean(fallback?.compareSources) : record.compareSources === true,
    traceChangesOverTime: record.traceChangesOverTime === undefined ? Boolean(fallback?.traceChangesOverTime) : record.traceChangesOverTime === true,
    readCompleteEvents: record.readCompleteEvents === undefined ? Boolean(fallback?.readCompleteEvents) : record.readCompleteEvents === true,
    rationale: cleanText(record.rationale, 500) || fallback?.rationale,
  }
}

function normalizeStep(value: unknown): InvestigationPlanStep | null {
  const record = asRecord(value)
  if (!record) return null
  const id = cleanText(record.id, 80)
  const title = cleanText(record.title, 200)
  if (!id || !title) return null
  const status = PLAN_STATUSES.has(record.status as InvestigationPlanStepStatus)
    ? record.status as InvestigationPlanStepStatus
    : 'pending'
  return {
    id,
    title,
    purpose: cleanText(record.purpose, 400) || undefined,
    status,
    note: cleanText(record.note, 500) || undefined,
  }
}

function normalizedSteps(value: unknown): InvestigationPlanStep[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const steps: InvestigationPlanStep[] = []
  for (const valueStep of value) {
    const step = normalizeStep(valueStep)
    if (!step || seen.has(step.id)) continue
    seen.add(step.id)
    steps.push(step)
    if (steps.length >= 20) break
  }
  return steps
}

export function normalizeInvestigationPlan(value: unknown): InvestigationPlan | null {
  const record = asRecord(value)
  if (!record) return null
  const questionUnderstanding = cleanText(record.questionUnderstanding, 1_000)
  const title = cleanText(record.title, 120)
  const steps = normalizedSteps(record.steps)
  if (!questionUnderstanding && steps.length === 0) return null
  const updatedAt = Number(record.updatedAt)
  return {
    title: title || '调查计划',
    questionUnderstanding,
    answerRequirements: cleanList(record.answerRequirements),
    uncertainties: cleanList(record.uncertainties),
    researchIntent: normalizeResearchIntent(record.researchIntent),
    steps,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : undefined,
  }
}

function toolNameOf(part: unknown): string {
  const record = asRecord(part)
  if (!record) return ''
  const dynamicName = cleanText(record.toolName, 200)
  if (dynamicName) return dynamicName
  return cleanText(record.type, 240).replace(/^tool-/, '')
}

export function isInvestigationPlanToolPart(part: unknown): boolean {
  return PLAN_TOOL_NAMES.has(toolNameOf(part))
}

function isRejectedToolPart(part: Record<string, unknown>): boolean {
  if (part.state === 'output-error' || part.state === 'output-denied') return true
  const output = asRecord(part.output)
  return part.state === 'output-available' && output?.success === false
}

function planFromToolOutput(part: Record<string, unknown>): InvestigationPlan | null {
  const output = asRecord(part.output)
  return normalizeInvestigationPlan(output?.plan)
}

function updatePlan(current: InvestigationPlan, value: unknown): InvestigationPlan {
  const input = asRecord(value)
  if (!input) return current
  const steps = current.steps.map((step) => ({ ...step }))
  const byId = new Map(steps.map((step) => [step.id, step]))
  const stepUpdates = Array.isArray(input.stepUpdates) ? input.stepUpdates.slice(0, 20) : []
  for (const valueUpdate of stepUpdates) {
    const patch = asRecord(valueUpdate)
    if (!patch) continue
    const step = byId.get(cleanText(patch.id, 80))
    if (!step) continue
    const title = cleanText(patch.title, 200)
    if (title) step.title = title
    if (patch.purpose !== undefined) step.purpose = cleanText(patch.purpose, 400) || undefined
    if (patch.note !== undefined) step.note = cleanText(patch.note, 500) || undefined
    if (PLAN_STATUSES.has(patch.status as InvestigationPlanStepStatus)) {
      step.status = patch.status as InvestigationPlanStepStatus
    }
  }
  const additions = normalizedSteps(input.addSteps)
  for (const step of additions) {
    if (steps.length >= 20) break
    if (byId.has(step.id)) continue
    steps.push(step)
    byId.set(step.id, step)
  }
  const questionUnderstanding = input.questionUnderstanding === undefined
    ? current.questionUnderstanding
    : cleanText(input.questionUnderstanding, 1_000) || current.questionUnderstanding
  return {
    title: input.title === undefined
      ? current.title
      : cleanText(input.title, 120) || current.title,
    questionUnderstanding,
    answerRequirements: input.answerRequirements === undefined
      ? [...current.answerRequirements]
      : cleanList(input.answerRequirements),
    uncertainties: input.uncertainties === undefined
      ? [...current.uncertainties]
      : cleanList(input.uncertainties),
    researchIntent: input.researchIntent === undefined
      ? current.researchIntent ? { ...current.researchIntent } : undefined
      : normalizeResearchIntent(input.researchIntent, current.researchIntent),
    steps,
    updatedAt: current.updatedAt,
  }
}

/**
 * 流式输出期间，按消息顺序重放模型的计划工具调用。一旦最终消息元数据存在，
 * 就以服务端持久化的计划为准。
 */
export function resolveInvestigationPlan(parts: readonly unknown[], persistedPlan?: unknown): InvestigationPlan | null {
  let plan: InvestigationPlan | null = null
  for (const valuePart of parts) {
    const part = asRecord(valuePart)
    if (!part || isRejectedToolPart(part)) continue
    const toolName = toolNameOf(part)
    if (!PLAN_TOOL_NAMES.has(toolName)) continue

    const outputPlan = planFromToolOutput(part)
    if (outputPlan) {
      plan = outputPlan
      continue
    }
    if (toolName === 'set_investigation_plan') {
      const inputPlan = normalizeInvestigationPlan(part.input)
      if (inputPlan) plan = inputPlan
      continue
    }
    if (plan) plan = updatePlan(plan, part.input)
  }
  return normalizeInvestigationPlan(persistedPlan) || plan
}

type InvestigationPlanMessage = {
  role?: unknown
  parts?: readonly unknown[]
  metadata?: unknown
}

/**
 * 输入区计划只属于本地跟踪的当前轮次。持久化计划会保留在消息元数据中，以维持模型连续性，
 * 但历史轮次的计划绝不会重新提升到临时输入区面板。
 */
export function resolveCurrentTurnInvestigationPlan(
  messages: readonly InvestigationPlanMessage[],
  turnStartIndex: number | null | undefined,
): InvestigationPlan | null {
  if (turnStartIndex == null || !Number.isFinite(turnStartIndex)) return null
  const start = Math.max(0, Math.floor(turnStartIndex))
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.parts)) continue
    const metadata = asRecord(message.metadata)
    const agent = asRecord(metadata?.agent)
    const research = asRecord(agent?.research)
    const plan = resolveInvestigationPlan(message.parts, research?.investigationPlan)
    if (plan) return plan
  }
  return null
}
