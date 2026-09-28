import type {
  AgentRunContinuationState,
  AgentRunToolRecord,
} from './agentRunStore'

type MediaDecision = {
  mediaRef?: unknown
  action?: unknown
}

type AgentDerivedMediaResumeState = {
  sawMediaReview: boolean
  sawVoiceReview: boolean
  sawImageReview: boolean
  modelFocusedMediaRefs: Set<string>
  modelVisibleVoiceRefs: Set<string>
  modelVisibleImageRefs: Set<string>
  attemptedVoiceTranscriptionRefs: Set<string>
  attemptedImageInspectionRefs: Set<string>
  explicitlySkippedMediaRefs: Set<string>
}

const completedStatuses = new Set<AgentRunToolRecord['status']>(['completed', 'reused'])

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function strings(values: unknown): string[] {
  return Array.isArray(values) ? values.map(text).filter(Boolean) : []
}

export function deriveAgentMediaResumeState(
  toolCalls: AgentRunToolRecord[],
  continuation?: AgentRunContinuationState,
): AgentDerivedMediaResumeState {
  const state: AgentDerivedMediaResumeState = {
    sawMediaReview: Boolean(continuation?.mediaReviewResultVersion || continuation?.mediaReviewRecoveryPending),
    sawVoiceReview: false,
    sawImageReview: false,
    modelFocusedMediaRefs: new Set(strings(continuation?.modelFocusedMediaRefs)),
    modelVisibleVoiceRefs: new Set(strings(continuation?.modelVisibleVoiceRefs)),
    modelVisibleImageRefs: new Set(strings(continuation?.modelVisibleImageRefs)),
    attemptedVoiceTranscriptionRefs: new Set(strings(continuation?.attemptedVoiceTranscriptionRefs)),
    attemptedImageInspectionRefs: new Set(strings(continuation?.attemptedImageInspectionRefs)),
    explicitlySkippedMediaRefs: new Set(strings(continuation?.explicitlySkippedMediaRefs)),
  }

  for (const call of toolCalls || []) {
    if (!completedStatuses.has(call.status)) continue
    const input = record(call.input)
    if (!input) continue
    if (call.toolName === 'transcribe_voice_messages') {
      strings(input.voiceRefs).forEach((mediaRef) => state.attemptedVoiceTranscriptionRefs.add(mediaRef))
      continue
    }
    if (call.toolName === 'inspect_media_image') {
      const mediaRef = text(input.imageRef)
      if (mediaRef) state.attemptedImageInspectionRefs.add(mediaRef)
      continue
    }
    if (call.toolName !== 'review_focused_voice' && call.toolName !== 'review_focused_images') continue
    state.sawMediaReview = true
    const selections = Array.isArray(input.selections) ? input.selections : []
    const persistedItems = selections.length > 0
      ? selections
      : (Array.isArray(input.decisions) ? input.decisions : [])
    for (const rawDecision of persistedItems) {
      const decision = record(rawDecision) as MediaDecision | null
      const mediaRef = text(decision?.mediaRef)
      if (!mediaRef) continue
      state.modelFocusedMediaRefs.add(mediaRef)
      if (mediaRef.startsWith('voice_')) state.modelVisibleVoiceRefs.add(mediaRef)
      if (mediaRef.startsWith('image_')) state.modelVisibleImageRefs.add(mediaRef)
      if (selections.length === 0 && text(decision?.action) === 'skip') {
        state.explicitlySkippedMediaRefs.add(mediaRef)
      } else if (mediaRef.startsWith('voice_')) {
        state.sawVoiceReview = true
        state.attemptedVoiceTranscriptionRefs.add(mediaRef)
      } else if (mediaRef.startsWith('image_')) {
        state.sawImageReview = true
        state.attemptedImageInspectionRefs.add(mediaRef)
      }
    }
  }
  return state
}

const resumeHydrationToolNames = new Set([
  'read_raw_messages',
  'read_message_thread',
  'read_event_contexts',
  'read_raw_timeline_samples',
  'read_raw_timeline',
  'read_raw_message_ranges',
  'search_and_read_raw_messages',
])

const leafHydrationToolNames = new Set([
  'read_raw_messages',
  'read_message_thread',
])

export function isAgentResumeHydrationToolName(toolName: string): boolean {
  return resumeHydrationToolNames.has(toolName)
}

/**
 * Persisted aggregate tools contain the leaf calls they spawned. Replaying both is the source
 * of the previous 28 -> 52 call expansion. Prefer the leaf cache reads and keep an aggregate
 * only when its recorded time range contains no persisted leaf call.
 */
export function selectAgentResumeHydrationCalls(toolCalls: AgentRunToolRecord[]): AgentRunToolRecord[] {
  const completed = (toolCalls || [])
    .filter((call) => completedStatuses.has(call.status))
    .filter((call) => resumeHydrationToolNames.has(call.toolName))
    .filter((call) => Boolean(record(call.input)))
    .sort((left, right) => left.startedAt - right.startedAt || left.sequence - right.sequence)
  const leaves = completed.filter((call) => leafHydrationToolNames.has(call.toolName))
  const selected = completed.filter((call) => {
    if (leafHydrationToolNames.has(call.toolName)) return true
    const finishedAt = Math.max(call.startedAt, Number(call.finishedAt) || call.startedAt)
    return !leaves.some((leaf) => (
      leaf.startedAt >= call.startedAt
      && leaf.startedAt <= finishedAt
    ))
  })
  const signatures = new Set<string>()
  return selected.filter((call) => {
    const signature = `${call.toolName}\u0000${JSON.stringify(call.input)}`
    if (signatures.has(signature)) return false
    signatures.add(signature)
    return true
  })
}
