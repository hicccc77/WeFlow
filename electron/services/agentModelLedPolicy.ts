import type {
  AgentInvestigationPlan,
  AgentInvestigationPlanStepStatus,
} from './agentRunStore'

// 正常运行不设累计 token 或总耗时边界。唯一的时间保护是针对单次模型/工具流的
// 无活动校验：只要工作持续产生事件，就可以继续运行。
export const AGENT_INACTIVITY_TIMEOUT_MS = 10 * 60_000

// 模型自行选择每次实际读取哪些媒体以及数量；这里只保留单次调用的技术安全上限。
export const AGENT_MEDIA_REVIEW_VOICE_BATCH_SIZE = 32
export const AGENT_MEDIA_REVIEW_IMAGE_BATCH_SIZE = 32

export function explicitAgentMediaReadRequirements(questionValue: unknown): {
  voice: boolean
  image: boolean
} {
  const question = String(questionValue || '').toLocaleLowerCase()
  const voiceNoun = '(?:语音|录音|voice|audio)'
  const imageNoun = '(?:图片|照片|截图|image|photo)'
  const voiceAction = '(?:转写|听取|收听|听一下|实际听|实际读取|transcrib|listen)'
  const imageAction = '(?:查看|看一下|实际看|读取|检查|inspect|view|open)'
  return {
    voice: new RegExp(`${voiceAction}[\\s\\S]{0,32}${voiceNoun}|${voiceNoun}[\\s\\S]{0,32}${voiceAction}`, 'iu').test(question),
    image: new RegExp(`${imageAction}[\\s\\S]{0,32}${imageNoun}|${imageNoun}[\\s\\S]{0,32}${imageAction}`, 'iu').test(question),
  }
}

export type AgentScopedTemporalContext = {
  runStartedAt: number
  datasetLatestMessageAt?: number
  targetFirstMessageAt?: number
  targetLastMessageAt?: number
  wholeDaysFromTargetLastMessageToRunStart?: number
  wholeDaysFromTargetLastMessageToDatasetLatest?: number
}

function normalizeEpochSeconds(value: unknown): number {
  const numeric = Number(value || 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric)
}

function wholeDaysBetween(from: number, to: number): number | undefined {
  if (!from || !to || to < from) return undefined
  return Math.floor((to - from) / (24 * 60 * 60))
}

export function buildAgentScopedTemporalContext(input: {
  scopeKind: 'global' | 'session'
  runStartedAt: number
  datasetLatestMessageAt?: number
  targetFirstMessageAt?: number
  targetLastMessageAt?: number
}): AgentScopedTemporalContext | null {
  if (input.scopeKind !== 'session') return null
  const runStartedAt = normalizeEpochSeconds(input.runStartedAt)
  const datasetLatestMessageAt = normalizeEpochSeconds(input.datasetLatestMessageAt)
  const targetFirstMessageAt = normalizeEpochSeconds(input.targetFirstMessageAt)
  const targetLastMessageAt = normalizeEpochSeconds(input.targetLastMessageAt)
  return {
    runStartedAt,
    datasetLatestMessageAt: datasetLatestMessageAt || undefined,
    targetFirstMessageAt: targetFirstMessageAt || undefined,
    targetLastMessageAt: targetLastMessageAt || undefined,
    wholeDaysFromTargetLastMessageToRunStart: wholeDaysBetween(targetLastMessageAt, runStartedAt),
    wholeDaysFromTargetLastMessageToDatasetLatest: wholeDaysBetween(targetLastMessageAt, datasetLatestMessageAt),
  }
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim()
}

const INVESTIGATION_PLAN_STATUSES = new Set<AgentInvestigationPlanStepStatus>([
  'pending',
  'in_progress',
  'completed',
  'skipped',
])

export type AgentInvestigationPlanDraft = {
  title: string
  questionUnderstanding: string
  answerRequirements?: string[]
  uncertainties?: string[]
  researchIntent?: {
    compareSources?: boolean
    traceChangesOverTime?: boolean
    readCompleteEvents?: boolean
    focusSources?: string[]
    focusEvents?: Array<{
      source: string
      anchorAt: string
      purpose?: string
    }>
    rationale?: string
  }
  steps: Array<{
    id: string
    title: string
    purpose?: string
    status?: AgentInvestigationPlanStepStatus
    note?: string
  }>
}

export type AgentInvestigationPlanUpdate = {
  title?: string
  questionUnderstanding?: string
  answerRequirements?: string[]
  uncertainties?: string[]
  researchIntent?: AgentInvestigationPlanDraft['researchIntent']
  researchMemo?: string
  sourceMemos?: Array<{
    sourceLabel: string
    memo: string
    nextReading?: string
  }>
  selectedPageIds?: string[]
  stepUpdates?: Array<{
    id: string
    title?: string
    purpose?: string
    status?: AgentInvestigationPlanStepStatus
    note?: string
  }>
  addSteps?: Array<{
    id: string
    title: string
    purpose?: string
    status?: AgentInvestigationPlanStepStatus
    note?: string
  }>
}

function cleanPlanList(values: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.map((item) => cleanText(item).slice(0, maxLength)).filter(Boolean))).slice(0, limit)
}

function cleanResearchIntent(
  value: AgentInvestigationPlanDraft['researchIntent'] | undefined,
  fallback?: AgentInvestigationPlan['researchIntent'],
): AgentInvestigationPlan['researchIntent'] | undefined {
  if (!value) return fallback ? { ...fallback } : undefined
  const focusEvents = value.focusEvents === undefined
    ? (fallback?.focusEvents || []).map((event) => ({ ...event }))
    : (Array.isArray(value.focusEvents) ? value.focusEvents : [])
      .map((event) => ({
        source: cleanText(event?.source).slice(0, 512),
        anchorAt: cleanText(event?.anchorAt).slice(0, 32),
        purpose: cleanText(event?.purpose).slice(0, 400) || undefined,
      }))
      .filter((event) => event.source && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(event.anchorAt))
      .filter((event, index, events) => events.findIndex((candidate) => (
        candidate.source === event.source && candidate.anchorAt === event.anchorAt
      )) === index)
      .slice(0, 16)
  return {
    compareSources: value.compareSources === undefined
      ? Boolean(fallback?.compareSources)
      : value.compareSources === true,
    traceChangesOverTime: value.traceChangesOverTime === undefined
      ? Boolean(fallback?.traceChangesOverTime)
      : value.traceChangesOverTime === true,
    readCompleteEvents: value.readCompleteEvents === undefined
      ? Boolean(fallback?.readCompleteEvents)
      : value.readCompleteEvents === true,
    focusSources: value.focusSources === undefined
      ? [...(fallback?.focusSources || [])]
      : cleanPlanList(value.focusSources, 12, 512),
    focusEvents,
    rationale: cleanText(value.rationale).slice(0, 500) || fallback?.rationale,
  }
}

function cleanPlanStep(
  step: AgentInvestigationPlanDraft['steps'][number],
): AgentInvestigationPlan['steps'][number] | null {
  const id = cleanText(step?.id).slice(0, 80)
  const title = cleanText(step?.title).slice(0, 200)
  if (!id || !title) return null
  const status = INVESTIGATION_PLAN_STATUSES.has(step.status as AgentInvestigationPlanStepStatus)
    ? step.status as AgentInvestigationPlanStepStatus
    : 'pending'
  return {
    id,
    title,
    purpose: cleanText(step.purpose).slice(0, 400) || undefined,
    status,
    note: cleanText(step.note).slice(0, 500) || undefined,
  }
}

export function createAgentInvestigationPlan(
  input: AgentInvestigationPlanDraft,
  updatedAt = Date.now(),
): AgentInvestigationPlan {
  const seen = new Set<string>()
  const steps = (input.steps || [])
    .map((step) => cleanPlanStep(step))
    .filter((step): step is AgentInvestigationPlan['steps'][number] => Boolean(step))
    .filter((step) => {
      if (seen.has(step.id)) return false
      seen.add(step.id)
      return true
    })
    .slice(0, 20)
  return {
    title: cleanText(input.title).slice(0, 120),
    questionUnderstanding: cleanText(input.questionUnderstanding).slice(0, 1_000),
    answerRequirements: cleanPlanList(input.answerRequirements, 16, 400),
    uncertainties: cleanPlanList(input.uncertainties, 16, 400),
    researchIntent: cleanResearchIntent(input.researchIntent),
    steps,
    updatedAt,
  }
}

export function updateAgentInvestigationPlan(
  current: AgentInvestigationPlan,
  input: AgentInvestigationPlanUpdate,
  updatedAt = Date.now(),
): AgentInvestigationPlan {
  const steps = current.steps.map((step) => ({ ...step }))
  const byId = new Map(steps.map((step) => [step.id, step]))
  for (const patch of (input.stepUpdates || []).slice(0, 20)) {
    const step = byId.get(cleanText(patch.id).slice(0, 80))
    if (!step) continue
    const title = cleanText(patch.title).slice(0, 200)
    const purpose = cleanText(patch.purpose).slice(0, 400)
    const note = cleanText(patch.note).slice(0, 500)
    if (title) step.title = title
    if (patch.purpose !== undefined) step.purpose = purpose || undefined
    if (patch.note !== undefined) step.note = note || undefined
    if (INVESTIGATION_PLAN_STATUSES.has(patch.status as AgentInvestigationPlanStepStatus)) {
      step.status = patch.status as AgentInvestigationPlanStepStatus
    }
  }
  for (const candidate of (input.addSteps || []).slice(0, 20)) {
    if (steps.length >= 20) break
    const step = cleanPlanStep(candidate)
    if (!step || byId.has(step.id)) continue
    steps.push(step)
    byId.set(step.id, step)
  }
  const questionUnderstanding = cleanText(input.questionUnderstanding).slice(0, 1_000)
  const title = cleanText(input.title).slice(0, 120)
  const currentTitle = cleanText(current.title).slice(0, 120) || '调查计划'
  return {
    title: input.title === undefined ? currentTitle : title || currentTitle,
    questionUnderstanding: input.questionUnderstanding === undefined
      ? current.questionUnderstanding
      : questionUnderstanding || current.questionUnderstanding,
    answerRequirements: input.answerRequirements === undefined
      ? [...current.answerRequirements]
      : cleanPlanList(input.answerRequirements, 16, 400),
    uncertainties: input.uncertainties === undefined
      ? [...current.uncertainties]
      : cleanPlanList(input.uncertainties, 16, 400),
    researchIntent: input.researchIntent === undefined
      ? current.researchIntent ? { ...current.researchIntent } : undefined
      : cleanResearchIntent(input.researchIntent, current.researchIntent),
    steps,
    updatedAt,
  }
}

export function summarizeAgentInvestigationPlan(plan?: AgentInvestigationPlan) {
  if (!plan) return null
  const count = (status: AgentInvestigationPlanStepStatus) => plan.steps.filter((step) => step.status === status).length
  return {
    total: plan.steps.length,
    completed: count('completed'),
    inProgress: count('in_progress'),
    pending: count('pending'),
    skipped: count('skipped'),
    activeSteps: plan.steps
      .filter((step) => step.status === 'in_progress')
      .map((step) => ({ id: step.id, title: step.title })),
    unresolvedUncertainties: plan.uncertainties,
  }
}

export function openAgentInvestigationPlanItems(plan?: AgentInvestigationPlan): {
  steps: Array<{ id: string; title: string; status: AgentInvestigationPlanStepStatus }>
  uncertainties: string[]
} {
  if (!plan) return { steps: [], uncertainties: [] }
  return {
    steps: plan.steps
      .filter((step) => step.status === 'pending' || step.status === 'in_progress')
      .map((step) => ({ id: step.id, title: step.title, status: step.status })),
    uncertainties: [...plan.uncertainties],
  }
}

export function settleAgentInvestigationPlanForDelivery(
  plan: AgentInvestigationPlan | undefined,
  options: { reachedBoundary: boolean; updatedAt?: number },
): AgentInvestigationPlan | undefined {
  if (!plan) return undefined
  return {
    ...plan,
    steps: plan.steps.map((step) => (
      step.status === 'pending' || step.status === 'in_progress'
        ? { ...step, status: 'skipped' as const }
        : { ...step }
    )),
    updatedAt: options.updatedAt ?? Date.now(),
  }
}

export function sanitizeAgentFinalAnswer(
  value: string,
  sessionDisplayNames: ReadonlyMap<string, string>,
): string {
  let answer = String(value || '')
  for (const [sessionId, displayName] of sessionDisplayNames) {
    if (!sessionId) continue
    answer = answer.split(sessionId).join(displayName || '该联系人')
  }
  return answer
    .replace(/\bpage_[A-Za-z0-9_-]{6,}\b/g, '已核对原文')
    .replace(/\b(?:voice|image)_[A-Za-z0-9_-]{4,}\b/g, '对应媒体')
    .replace(/\b(?:accountId|gh)_[A-Za-z0-9_-]+\b/gi, '该联系人')
    .replace(/\b(?:local[\s_*`-]*id)\s*(?:[=:：]|为)?\s*[*_`]*\d+[*_`]*/gi, '')
    .replace(/\b(?:message[\s_*`-]*(?:key|ref)|page[\s_*`-]*hash|dataset[\s_*`-]*fingerprint|session[\s_*`-]*id|next[\s_*`-]*cursor)\s*(?:[=:：]|为)?\s*[*_`]*[^\s,，、。;；]+[*_`]*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Detects a draft that presents an unattempted voice transcription as if the
 * assistant lacked the capability. The runtime uses this signal to transcribe
 * the visible voice messages and ask the model to answer again.
 */
export function agentAnswerDefersAvailableVoiceTranscription(value: unknown): boolean {
  const answer = String(value ?? '').replace(/\u0000/g, '').trim().replace(/\s+/g, ' ')
  if (!/(?:语音|音频|voice|audio)/i.test(answer)) return false
  return [
    /(?:语音|音频).{0,60}(?:只能|只)(?:看|看到|知道).{0,24}(?:回话|回复|文字|消息|内容)/u,
    /(?:语音|音频).{0,60}(?:尚未|还没|没有|没能|不能|无法|没法).{0,16}(?:转写|识别|听|读取|看到|知道|理解)/u,
    /(?:尚未|还没|没有|没能|不能|无法|没法).{0,16}(?:转写|识别|听|读取|理解).{0,60}(?:语音|音频)/u,
    /(?:voice|audio).{0,80}(?:not transcribed|not available|can't|cannot|unable|could not|haven't|have not)/i,
    /(?:can't|cannot|unable|could not|haven't|have not).{0,80}(?:hear|transcribe|read|understand).{0,40}(?:voice|audio)/i,
  ].some((pattern) => pattern.test(answer))
}

/** Collects opaque voice references only from fields that can be shown to the model. */
export function collectAgentVoiceRefs(value: unknown, refs = new Set<string>(), depth = 0): Set<string> {
  if (depth > 5 || value === null || value === undefined) return refs
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(?<![A-Za-z0-9_-])voice_[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g)) refs.add(match[0])
    return refs
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAgentVoiceRefs(item, refs, depth + 1)
    return refs
  }
  if (typeof value !== 'object') return refs
  const record = value as Record<string, unknown>
  for (const key of ['voiceRef', 'mediaRefs', 'pageText', 'pages', 'contexts', 'conversations', 'results']) {
    collectAgentVoiceRefs(record[key], refs, depth + 1)
  }
  return refs
}

/** Collects opaque image references only from fields that can be shown to the model. */
export function collectAgentImageRefs(value: unknown, refs = new Set<string>(), depth = 0): Set<string> {
  if (depth > 5 || value === null || value === undefined) return refs
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(?<![A-Za-z0-9_-])image_[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g)) refs.add(match[0])
    return refs
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAgentImageRefs(item, refs, depth + 1)
    return refs
  }
  if (typeof value !== 'object') return refs
  const record = value as Record<string, unknown>
  for (const key of ['imageRef', 'mediaRefs', 'pageText', 'pages', 'contexts', 'conversations', 'results']) {
    collectAgentImageRefs(record[key], refs, depth + 1)
  }
  return refs
}

export type AgentMediaReviewDecision = {
  mediaRef: string
  action: 'inspect' | 'skip'
  reason: string
}

export type AgentMediaReviewSelection = {
  mediaRef: string
  reason: string
}

/**
 * A review call is an execution request, not a candidate ballot. Every selected
 * ref must be known, unique, and accompanied by the model's contextual reason;
 * omission is how the model decides not to read an item.
 */
export function validateAgentMediaReviewSelections(
  availableRefs: string[],
  selections: AgentMediaReviewSelection[],
  maximumSelections: number,
): {
  success: boolean
  duplicateRefs: string[]
  unknownRefs: string[]
  invalidReasonRefs: string[]
  tooMany: boolean
} {
  const available = new Set(
    availableRefs.map((value) => String(value || '').trim()).filter(Boolean),
  )
  const counts = new Map<string, number>()
  const unknownRefs: string[] = []
  const invalidReasonRefs: string[] = []
  for (const selection of selections || []) {
    const mediaRef = String(selection?.mediaRef || '').trim()
    if (!mediaRef) continue
    counts.set(mediaRef, (counts.get(mediaRef) || 0) + 1)
    if (!available.has(mediaRef) && !unknownRefs.includes(mediaRef)) unknownRefs.push(mediaRef)
    if (!String(selection?.reason || '').trim() && !invalidReasonRefs.includes(mediaRef)) {
      invalidReasonRefs.push(mediaRef)
    }
  }
  const duplicateRefs = Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([mediaRef]) => mediaRef)
  const limit = Math.max(1, Math.floor(Number(maximumSelections) || 1))
  return {
    success: counts.size > 0
      && duplicateRefs.length === 0
      && unknownRefs.length === 0
      && invalidReasonRefs.length === 0
      && selections.length <= limit,
    duplicateRefs,
    unknownRefs,
    invalidReasonRefs,
    tooMany: selections.length > limit,
  }
}

/**
 * Validates semantic media decisions. Voice review normally requires the whole
 * offered batch; adaptive image review may deliberately select a non-empty
 * subset and leave the rest pending for a later batch.
 */
export function validateAgentMediaReviewDecisions(
  expectedRefs: string[],
  decisions: AgentMediaReviewDecision[],
  options: { requireAll?: boolean } = {},
): {
  success: boolean
  missingRefs: string[]
  duplicateRefs: string[]
  unknownRefs: string[]
  invalidReasonRefs: string[]
} {
  const expected = Array.from(new Set(expectedRefs.map((value) => String(value || '').trim()).filter(Boolean)))
  const expectedSet = new Set(expected)
  const counts = new Map<string, number>()
  const unknownRefs: string[] = []
  const invalidReasonRefs: string[] = []
  for (const decision of decisions || []) {
    const mediaRef = String(decision?.mediaRef || '').trim()
    if (!mediaRef) continue
    counts.set(mediaRef, (counts.get(mediaRef) || 0) + 1)
    if (!expectedSet.has(mediaRef) && !unknownRefs.includes(mediaRef)) unknownRefs.push(mediaRef)
    if (!String(decision?.reason || '').trim() && !invalidReasonRefs.includes(mediaRef)) {
      invalidReasonRefs.push(mediaRef)
    }
  }
  const missingRefs = options.requireAll === false
    ? []
    : expected.filter((mediaRef) => !counts.has(mediaRef))
  const duplicateRefs = expected.filter((mediaRef) => (counts.get(mediaRef) || 0) > 1)
  return {
    success: missingRefs.length === 0
      && duplicateRefs.length === 0
      && unknownRefs.length === 0
      && invalidReasonRefs.length === 0
      && (options.requireAll !== false || counts.size > 0),
    missingRefs,
    duplicateRefs,
    unknownRefs,
    invalidReasonRefs,
  }
}

/**
 * Returns literal surrounding lines for media refs so the model can judge them
 * in conversation context. Selection remains entirely with the model.
 */
export function buildAgentMediaReviewContexts(
  pageTexts: string[],
  mediaRefs: string[],
  surroundingLines = 3,
): Array<{ mediaRef: string; context: string }> {
  const pages = pageTexts.map((value) => String(value || '')).filter(Boolean)
  const radius = Math.max(0, Math.min(8, Math.floor(Number(surroundingLines) || 0)))
  return Array.from(new Set(mediaRefs.map((value) => String(value || '').trim()).filter(Boolean))).map((mediaRef) => {
    for (const pageText of pages) {
      const lines = pageText.split(/\r?\n/)
      const index = lines.findIndex((line) => line.includes(mediaRef))
      if (index < 0) continue
      return {
        mediaRef,
        context: lines.slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1)).join('\n'),
      }
    }
    return { mediaRef, context: '' }
  })
}

function collectAgentRawPageTexts(value: unknown, texts = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || value === null || value === undefined) return texts
  if (Array.isArray(value)) {
    for (const item of value) collectAgentRawPageTexts(item, texts, depth + 1)
    return texts
  }
  if (typeof value !== 'object') return texts
  const record = value as Record<string, unknown>
  const pageText = String(record.pageText || '').trim()
  if (pageText) texts.add(pageText)
  for (const key of ['pages', 'contexts', 'conversations', 'results']) {
    collectAgentRawPageTexts(record[key], texts, depth + 1)
  }
  return texts
}

/**
 * Builds a literal, per-window reminder that media is available. It exposes
 * every visible ref by type and a bounded set of surrounding contexts, but
 * deliberately makes no importance decision for the model.
 */
export function buildAgentMediaAvailabilityReminder(
  value: unknown,
  contextLimitValue = 24,
): {
  voiceCount: number
  imageCount: number
  voiceRefs: string[]
  imageRefs: string[]
  contextCandidates: Array<{ mediaRef: string; context: string }>
  remainingContextCount: number
  instruction: string
} | null {
  const voiceRefs = Array.from(collectAgentVoiceRefs(value))
  const imageRefs = Array.from(collectAgentImageRefs(value))
  const mediaRefs = [...voiceRefs, ...imageRefs]
  if (mediaRefs.length === 0) return null
  const contextLimit = Math.max(1, Math.min(48, Math.floor(Number(contextLimitValue) || 24)))
  const contextRefs = mediaRefs.slice(0, contextLimit)
  const pageTexts = Array.from(collectAgentRawPageTexts(value))
  return {
    voiceCount: voiceRefs.length,
    imageCount: imageRefs.length,
    voiceRefs,
    imageRefs,
    contextCandidates: buildAgentMediaReviewContexts(pageTexts, contextRefs, 2),
    remainingContextCount: Math.max(0, mediaRefs.length - contextRefs.length),
    instruction: '本次原文窗口含可读取媒体：模型只把真正需要读取的 voiceRef 交给 review_focused_voice、把真正需要查看的 imageRef 交给 review_focused_images；工具参数中的每一项都会被实际读取，不支持在调用内部跳过。无需读取的项不要提交。本地窗口与 token 预算不代表媒体重要性。',
  }
}

/** Raw timelines are model-selected longitudinal evidence, not reconnaissance. */
export function isAgentFocusedMediaReading(toolNameValue: unknown, readingPurposeValue?: unknown): boolean {
  const toolName = String(toolNameValue || '').trim()
  const readingPurpose = String(readingPurposeValue || '').trim()
  if ([
    'read_raw_timeline',
    'read_message_thread',
    'read_event_contexts',
    'search_and_read_raw_messages',
    'read_raw_message_ranges',
  ].includes(toolName)) return true
  return toolName === 'read_raw_messages'
    && !['timeline', 'reconnaissance'].includes(readingPurpose)
}

export type AgentReadDepth = {
  windows: number
  tokenBudget: number
}

/**
 * A previous sampled read covers a new one only when it is at least as wide and
 * at least as deep. Comparing either dimension alone can incorrectly turn two
 * shallow windows into a completed 24-window read (or vice versa).
 */
export function agentReadDepthCovers(completed: AgentReadDepth, requested: AgentReadDepth): boolean {
  return completed.windows >= requested.windows
    && completed.tokenBudget >= requested.tokenBudget
}

/** Keep the non-dominated coverage points without inventing a depth never read. */
export function mergeAgentReadDepthCoverage(
  existing: readonly AgentReadDepth[],
  next: AgentReadDepth,
): AgentReadDepth[] {
  if (existing.some((completed) => agentReadDepthCovers(completed, next))) return [...existing]
  return [
    ...existing.filter((completed) => !agentReadDepthCovers(next, completed)),
    next,
  ]
}

/** A date range is reusable as completed only when the result explicitly proves full coverage. */
export function isAgentExplicitRawRangeComplete(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.success === true
    && (record.requestSatisfied === true || record.coverageStatus === 'complete')
    && record.hasMore !== true
}

export function isLikelyIncompleteAgentAnswer(value: string): boolean {
  const answer = String(value || '').trim()
  if (!answer) return true

  const fencedCodeBlocks = answer.match(/```/g)?.length || 0
  if (fencedCodeBlocks % 2 !== 0) return true

  const pairedMarkers: Array<[string, string]> = [
    ['**', '**'],
    ['__', '__'],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
    ['（', '）'],
    ['(', ')'],
    ['【', '】'],
    ['[', ']'],
  ]
  for (const [opening, closing] of pairedMarkers) {
    const openingCount = answer.split(opening).length - 1
    const closingCount = opening === closing
      ? openingCount
      : answer.split(closing).length - 1
    if (opening === closing ? openingCount % 2 !== 0 : openingCount > closingCount) return true
  }

  // 已闭合的代码块是有效的结束产物，即使最后一行代码没有正文标点。
  if (fencedCodeBlocks > 0 && /```\s*$/.test(answer)) return false

  const terminalText = answer
    .replace(/(?:\*\*|__|~~)+\s*$/g, '')
    .replace(/[”’"'）)\]】」』]+\s*$/g, '')
    .trimEnd()
  if (!terminalText) return true
  if (/[。！？!?…\.](?:\s*)$/.test(terminalText)) return false

  // 没有结束标记的最终正文含义不明；实践中，这是判断流式回答在输出或传输边界
  // 被截断的最强供应商无关信号。重新合成比静默发布可能断裂的句子更安全。
  return true
}

/**
 * Decide whether an already generated answer needs another model request.
 * A provider `stop` means the model deliberately completed the response; punctuation and
 * Markdown-shape heuristics must not turn that successful answer into a mandatory rewrite.
 * Those heuristics remain useful only when the provider cannot tell us how the stream ended.
 */
export function agentAnswerNeedsFinalSynthesis(value: string, finishReason: string): boolean {
  const answer = String(value || '').trim()
  if (!answer) return true

  const normalizedFinishReason = String(finishReason || '').trim().toLowerCase()
  if (normalizedFinishReason === 'stop') return false
  if (['length', 'content-filter', 'error', 'tool-calls'].includes(normalizedFinishReason)) return true
  return isLikelyIncompleteAgentAnswer(answer)
}

export function longestCompleteAgentAnswerPrefix(value: string, minimumLength = 320): string {
  const answer = String(value || '').trim()
  if (!answer) return ''
  if (!isLikelyIncompleteAgentAnswer(answer)) return answer

  const closeDanglingFormatting = (candidate: string): string => {
    const stack: string[] = []
    const symmetricMarkers = ['```', '**', '__']
    const pairedMarkers = new Map<string, string>([
      ['“', '”'],
      ['「', '」'],
      ['『', '』'],
      ['（', '）'],
      ['(', ')'],
      ['【', '】'],
      ['[', ']'],
    ])
    const closingMarkers = new Set(pairedMarkers.values())
    for (let index = 0; index < candidate.length;) {
      const symmetric = symmetricMarkers.find((marker) => candidate.startsWith(marker, index))
      if (symmetric) {
        if (stack.at(-1) === symmetric) stack.pop()
        else stack.push(symmetric)
        index += symmetric.length
        continue
      }
      const character = candidate[index]
      const expectedClosing = pairedMarkers.get(character)
      if (expectedClosing) stack.push(expectedClosing)
      else if (closingMarkers.has(character) && stack.at(-1) === character) stack.pop()
      index += 1
    }
    return `${candidate}${stack.reverse().join('')}`
  }

  const terminalIndexes: number[] = []
  for (let index = 0; index < answer.length; index += 1) {
    if (/[。！？!?…\.]/.test(answer[index])) terminalIndexes.push(index)
  }
  for (let index = terminalIndexes.length - 1; index >= 0; index -= 1) {
    const candidate = answer.slice(0, terminalIndexes[index] + 1).trim()
    if (candidate.length < minimumLength) break
    if (!isLikelyIncompleteAgentAnswer(candidate)) return candidate
    const repairedCandidate = closeDanglingFormatting(candidate)
    if (!isLikelyIncompleteAgentAnswer(repairedCandidate)) return repairedCandidate
  }
  return ''
}

export function sanitizeAgentSourceQuotes(value: string, sourceTexts: readonly string[]): string {
  const normalizedSources = sourceTexts
    .map((source) => String(source || '').replace(/\s+/g, ''))
    .filter(Boolean)
  if (normalizedSources.length === 0) return value
  const appearsInSource = (quote: string) => normalizedSources.some((source) => source.includes(quote))
  const sanitizeQuote = (captured: string) => {
    const quote = String(captured || '').trim()
    const normalized = quote.replace(/\s+/g, '')
    if (appearsInSource(normalized)) return `“${quote}”`
    const withoutEdgePunctuation = normalized.replace(/^[，,。！？!?；;：:]+|[，,。！？!?；;：:]+$/g, '')
    if (withoutEdgePunctuation.length >= 2 && appearsInSource(withoutEdgePunctuation)) {
      return `“${quote.replace(/^[，,。！？!?；;：:]+|[，,。！？!?；;：:]+$/g, '')}”`
    }
    return quote
  }
  // 移除不支持的引号前，先把相邻的带引号概念作为一对处理；否则
  // “A”“B”会变成难以阅读的“AB”。
  return String(value || '')
    .replace(/[“"]([^”"\n]{2,160})[”"]\s*[“"]([^”"\n]{2,160})[”"]/g, (_full, left: string, right: string) => {
      const sanitizedLeft = sanitizeQuote(left)
      const sanitizedRight = sanitizeQuote(right)
      return `${sanitizedLeft}和${sanitizedRight}`
    })
    .replace(/[“"]([^”"\n]{2,160})[”"]/g, (_full, captured: string) => sanitizeQuote(captured))
}
