import { appendFileSync, existsSync, mkdirSync, promises as fsPromises, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'aborted'
export type AgentRunOutcome = 'answered'

export type AgentRunPolicyDecision = {
  version: 'model-led-v1'
  scenario: 'model-led'
  localDataAvailable: boolean
  reasons: string[]
}

export type AgentRunToolRecord = {
  sequence: number
  toolName: string
  input: unknown
  outputSummary?: unknown
  status: 'started' | 'not_run' | 'completed' | 'reused' | 'failed' | 'rejected'
  startedAt: number
  finishedAt?: number
  error?: string
}

export type AgentReadPageTrace = {
  pageId: string
  pageHash: string
  sessionId: string
  displayName?: string
  startAt?: string
  endAt?: string
  requestedStartAt?: string
  requestedEndAt?: string
  direction?: 'forward' | 'backward'
  hasMore?: boolean
  coverageStatus?: 'complete' | 'partial' | 'empty'
  messageCount: number
  estimatedTokens: number
  tokenBudget?: number
  cacheHit: boolean
  readingKind?: 'reconnaissance' | 'timeline' | 'focused-range' | 'anchored-event' | 'search-context'
  eventCohesion?: {
    sourceWindowMessageCount: number
    connectedMessageCount: number
    disconnectedSegmentCount: number
    largestWindowGapSeconds: number
    largestReturnedGapSeconds: number
    omittedBeforeMessageCount: number
    omittedAfterMessageCount: number
    complete: boolean
  }
}

export type AgentResearchFeedbackTrace = {
  at: number
  confidence: 'low' | 'medium' | 'high'
  unsupportedClaims: string[]
  missingAreas: string[]
  counterpoints: string[]
  recommendation: 'continue-reading' | 'answer-with-limits' | 'ready'
}

export type AgentResearchSourceFinding = {
  sourceLabel: string
  observations: string[]
  interpretations: string[]
  counterEvidence: string[]
  openQuestions: string[]
  nextReading?: string
}

export type AgentInvestigationPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped'

export type AgentInvestigationPlan = {
  title: string
  questionUnderstanding: string
  answerRequirements: string[]
  uncertainties: string[]
  researchIntent?: {
    compareSources: boolean
    traceChangesOverTime: boolean
    readCompleteEvents: boolean
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
    status: AgentInvestigationPlanStepStatus
    note?: string
  }>
  updatedAt: number
}

export type AgentRunContinuationState = {
  version: 1
  phase: 'investigating' | 'media-review' | 'finalizing'
  retainedModelWorkingNotes?: string
  modelFocusedMediaRefs: string[]
  modelVisibleVoiceRefs: string[]
  modelVisibleImageRefs: string[]
  attemptedVoiceTranscriptionRefs: string[]
  attemptedImageInspectionRefs: string[]
  explicitlySkippedMediaRefs: string[]
  mediaReviewRecoveryPending: boolean
  mediaReviewRecoverySteps: number
  mediaReviewResultVersion: number
  mediaReviewAssimilatedVersion: number
  /** 每次聚焦原文新增媒体时递增；用于要求模型筛选一次，而不是强制清空全部媒体。 */
  focusedMediaDataVersion?: number
  /** 已经至少完成一次模型媒体筛选的最新聚焦数据版本。 */
  mediaReviewCoveredFocusedVersion?: number
  /** 聚焦原文中新出现语音/图片的独立版本，避免审查一种媒体误覆盖另一种。 */
  focusedVoiceDataVersion?: number
  focusedImageDataVersion?: number
  /** 各媒体类型已经完成语义筛选的版本。 */
  mediaReviewCoveredVoiceVersion?: number
  mediaReviewCoveredImageVersion?: number
  latestMediaReviewEvidence?: unknown[]
  inspectedImages?: Array<{
    imageRef: string
    filePath: string
    mediaType: string
    filename?: string
    presentation: Record<string, unknown>
  }>
  deliveredImageRefs?: string[]
  acknowledgedRawPageHashes: string[]
  modelVisibleRawPageHashes: string[]
  pendingNotebookRawPageHashes: string[]
  rawPageHashesAwaitingNativeInspection: string[]
  focusedTimelinePageHashes: string[]
  focusedDetailPageHashes: string[]
  focusedMonthlyClusterPageHashes: string[]
  messageThreadPageHashes: string[]
  completeMessageThreadPageHashes: string[]
  explicitlyExpandedSearchPageHashes: string[]
  searchContextPageHashes: string[]
  modelSelectedFinalPageHashes: string[]
  memoBackedFinalPageHashes: string[]
  investigationDataVersion: number
  analyzedInvestigationDataVersion: number
  focusedReadingDataVersion: number
  researchNotebookCheckpointDataVersion: number
}

export type AgentResearchTrace = {
  readPages: AgentReadPageTrace[]
  modelWorkingNotes?: string[]
  continuation?: AgentRunContinuationState
  readingCoverage?: {
    pageCount: number
    distinctSessions: number
    readMessages: number
    rawMessageBlocks: number
    uniqueRawMessages: number
    duplicateRawMessages: number
    duplicateRatio: number
    distinctDates: number
    distinctMonths: number
    earliest?: string
    latest?: string
    manifestCalls: number
    manifestSessionsSeen: number
    manifestTotalAvailable: number
    manifestHasMore: boolean
  }
  investigationPlan?: AgentInvestigationPlan
  modelReviews?: Array<{
    at: number
    phase: 'reading-strategy' | 'synthesis-consistency' | 'source-provenance' | 'delivery-semantic'
    feedback: string
  }>
  sourceMemos?: Array<{
    sourceLabel: string
    memo: string
    pageCount: number
    batchCount: number
  }>
  modelSteps?: Array<{
    at: number
    phase?: 'investigation' | 'research-memo' | 'strategy-review' | 'synthesis-review' | 'source-provenance-review' | 'finalization' | 'delivery-review' | 'finalization-revision'
    finishReason?: string
    rawFinishReason?: string
    textLength: number
    reasoningLength: number
    toolNames: string[]
    inputTokens?: number
    noCacheInputTokens?: number
    cacheReadTokens?: number
    outputTokens?: number
    totalTokens?: number
    cumulativeTotalTokens?: number
    estimatedInputTokens?: number
    workspaceRawPageCount?: number
    workspaceRawTokens?: number
    workspaceNotebookTokens?: number
    roundRawReadBudget?: number
    roundRawReadTokensUsed?: number
    uniqueRawMessagesBefore?: number
    uniqueRawMessagesAfter?: number
    newUniqueRawMessages?: number
    distinctSessionsBefore?: number
    distinctSessionsAfter?: number
    distinctMonthsBefore?: number
    distinctMonthsAfter?: number
    duplicateRawMessageRatioAfter?: number
    finalizerRawPageTokenBudget?: number
    finalizerCompactWorkspaceTokens?: number
    finalizerRevision?: boolean
    finalizerRecovery?: boolean
  }>
  checkpoints: Array<{
    at: number
    confirmedFacts: string[]
    currentInterpretations: string[]
    openQuestions: string[]
    nextReading?: string
    synthesisMemo?: string
    selectedPageIds?: string[]
    sourceLabels?: string[]
    memoKind?: 'general' | 'source' | 'cross-source'
    sourceFindings?: AgentResearchSourceFinding[]
  }>
  feedback: AgentResearchFeedbackTrace[]
  toolResultCount: number
  totalTokens?: number
  inputTokens?: number
  noCacheInputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheHitRate?: number
  outputTokens?: number
}

export type AgentRunSnapshot = {
  schemaVersion: 1 | 2 | 3
  runId: string
  resumedFromRunId?: string
  resumeFingerprint?: string
  conversationId?: number | null
  status: AgentRunStatus
  outcome?: AgentRunOutcome
  question: string
  scope: unknown
  dataContext?: {
    accountFingerprint?: string
    databaseFingerprint?: string
    datasetFingerprint?: string
  }
  currentStage: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  policyVersion: string
  policyDecision: AgentRunPolicyDecision | Record<string, unknown>
  roleContextVersion: string
  promptVersion: string
  model: {
    provider?: string
    model?: string
    protocol?: string
    reasoningEffort?: string
    contextWindow?: number
    maxOutputTokens?: number
  }
  research?: AgentResearchTrace
  stopReason?: string
  finalAnswer?: string
  finishReason?: string
  toolCalls: AgentRunToolRecord[]
  checkpoints: Array<{ at: number; stage: string; readPageCount: number; note?: string }>
}

export type AgentRunConversationSummary = {
  schemaVersion: 1
  runId: string
  resumedFromRunId?: string
  conversationId: number
  status: AgentRunStatus
  outcome?: AgentRunOutcome
  question: string
  currentStage: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  stopReason?: string
  finishReason?: string
}

function safeRunId(runId: string): string {
  const value = String(runId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
  if (!value) throw new Error('runId 不能为空')
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let persistNonce = 0

function isTransientRenameError(error: unknown): boolean {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code || '').toUpperCase()
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function waitForRenameRetry(delayMs: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, Math.max(1, delayMs))
}

type AgentRunJournalEntry = {
  type: 'tool-start'
  record: AgentRunToolRecord
}

function runJournalPath(rootDir: string, runId: string): string {
  return join(rootDir, 'agent-runs', 'state', `${safeRunId(runId)}.journal.jsonl`)
}

function mergeRunJournal(rootDir: string, snapshot: AgentRunSnapshot): AgentRunSnapshot {
  const journalPath = runJournalPath(rootDir, snapshot.runId)
  if (!existsSync(journalPath)) return snapshot
  try {
    const toolCalls = [...snapshot.toolCalls]
    for (const line of readFileSync(journalPath, 'utf8').split(/\r?\n/u)) {
      if (!line.trim()) continue
      const entry = JSON.parse(line) as AgentRunJournalEntry
      if (entry?.type !== 'tool-start' || !entry.record) continue
      const sequence = Math.max(1, Math.floor(Number(entry.record.sequence) || 0))
      if (sequence <= toolCalls.length) continue
      if (sequence !== toolCalls.length + 1) continue
      toolCalls.push(entry.record)
    }
    return toolCalls.length === snapshot.toolCalls.length ? snapshot : { ...snapshot, toolCalls }
  } catch {
    return snapshot
  }
}

function conversationSummaryOf(snapshot: AgentRunSnapshot): AgentRunConversationSummary | null {
  const conversationId = Number(snapshot.conversationId)
  if (!Number.isFinite(conversationId) || conversationId <= 0) return null
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    resumedFromRunId: snapshot.resumedFromRunId,
    conversationId,
    status: snapshot.status,
    outcome: snapshot.outcome,
    question: snapshot.question,
    currentStage: snapshot.currentStage,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    finishedAt: snapshot.finishedAt,
    stopReason: snapshot.stopReason,
    finishReason: snapshot.finishReason,
  }
}

function conversationSummaryPath(rootDir: string, conversationId: number): string {
  return join(rootDir, 'agent-runs', 'conversation-state', `${Math.trunc(conversationId)}.json`)
}

function readConversationSummary(rootDir: string, conversationId: number): AgentRunConversationSummary | null {
  const target = conversationSummaryPath(rootDir, conversationId)
  if (!existsSync(target)) return null
  try {
    const summary = JSON.parse(readFileSync(target, 'utf8')) as AgentRunConversationSummary
    return summary?.runId && Number(summary.conversationId) === conversationId ? summary : null
  } catch {
    return null
  }
}

function persistConversationSummary(rootDir: string, snapshot: AgentRunSnapshot): void {
  const summary = conversationSummaryOf(snapshot)
  if (!summary) return
  try {
    const target = conversationSummaryPath(rootDir, summary.conversationId)
    mkdirSync(join(rootDir, 'agent-runs', 'conversation-state'), { recursive: true })
    const existing = readConversationSummary(rootDir, summary.conversationId)
    if (existing && existing.runId !== summary.runId) {
      if (existing.startedAt > summary.startedAt) return
      if (existing.startedAt === summary.startedAt && existing.updatedAt > summary.updatedAt) return
    }
    if (existing?.runId === summary.runId) {
      if (existing.status !== 'running' && summary.status === 'running') return
      if (
        existing.status === summary.status
        && existing.outcome === summary.outcome
        && existing.finishReason === summary.finishReason
        && existing.stopReason === summary.stopReason
        && existing.finishedAt === summary.finishedAt
      ) return
    }

    const temporary = `${target}.${process.pid}.${Date.now()}.${++persistNonce}.tmp`
    writeFileSync(temporary, JSON.stringify(summary), 'utf8')
    try {
      try {
        renameSync(temporary, target)
      } catch {
        // 索引只有几百字节；Windows 占用导致原子替换失败时直接覆盖，不能拖慢主运行。
        writeFileSync(target, JSON.stringify(summary), 'utf8')
      }
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary) } catch { /* 下次读取会忽略临时文件。 */ }
      }
    }
  } catch {
    // 轻量索引不能反过来让 Agent 的主快照写入失败或变慢。
  }
}

export class AgentRunStore {
  readonly directory: string
  private readonly rootDir: string
  private snapshotValue: AgentRunSnapshot
  private persistTimer: NodeJS.Timeout | null = null
  private persistInFlight: Promise<void> | null = null
  private persistDirty = false
  private persistGeneration = 0
  private finalized = false

  constructor(rootDir: string, initial: Omit<AgentRunSnapshot, 'schemaVersion' | 'toolCalls' | 'checkpoints' | 'updatedAt'>) {
    this.rootDir = rootDir
    this.directory = join(rootDir, 'agent-runs', 'state')
    mkdirSync(this.directory, { recursive: true })
    this.snapshotValue = {
      ...initial,
      schemaVersion: 3,
      updatedAt: Date.now(),
      toolCalls: [],
      checkpoints: [],
    }
    this.persistSync()
  }

  get filePath(): string {
    return join(this.directory, `${safeRunId(this.snapshotValue.runId)}.json`)
  }

  get snapshot(): AgentRunSnapshot {
    return clone(this.snapshotValue)
  }

  private get journalPath(): string {
    return runJournalPath(this.rootDir, this.snapshotValue.runId)
  }

  update(patch: Partial<AgentRunSnapshot>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...clone(patch),
      schemaVersion: 3,
      runId: this.snapshotValue.runId,
      updatedAt: Date.now(),
      toolCalls: patch.toolCalls || this.snapshotValue.toolCalls,
      checkpoints: patch.checkpoints || this.snapshotValue.checkpoints,
    }
    this.persist()
  }

  checkpoint(options: {
    stage: string
    readPageCount?: number
    note?: string
    research?: AgentResearchTrace
    stopReason?: string
  }): void {
    this.snapshotValue.currentStage = options.stage
    this.snapshotValue.updatedAt = Date.now()
    this.snapshotValue.checkpoints.push({
      at: Date.now(),
      stage: options.stage,
      readPageCount: Math.max(0, Math.floor(options.readPageCount || 0)),
      note: options.note,
    })
    if (options.research) this.snapshotValue.research = clone(options.research)
    if (options.stopReason !== undefined) this.snapshotValue.stopReason = options.stopReason
    this.persist()
  }

  recordTool(record: Omit<AgentRunToolRecord, 'sequence'>): number {
    const sequence = this.snapshotValue.toolCalls.length + 1
    const persistedRecord = { sequence, ...clone(record) }
    this.snapshotValue.toolCalls.push(persistedRecord)
    this.snapshotValue.updatedAt = Date.now()
    // 工具参数先写入很小的追加日志。即使用户在原生调用中立即强制结束，主进程也能
    // 把这一项恢复成 not_run；完整快照则在后台合并，避免每个工具开始都重写数百 KB。
    try {
      appendFileSync(this.journalPath, `${JSON.stringify({ type: 'tool-start', record: persistedRecord } satisfies AgentRunJournalEntry)}\n`, 'utf8')
    } catch {
      // 日志失败时仍由后台完整快照兜底；不能让诊断持久化阻止工具运行。
    }
    this.persist()
    return sequence
  }

  updateTool(sequence: number, patch: Partial<Omit<AgentRunToolRecord, 'sequence' | 'toolName' | 'startedAt'>>): void {
    const record = this.snapshotValue.toolCalls.find((item) => item.sequence === sequence)
    if (!record) return
    Object.assign(record, clone(patch))
    this.snapshotValue.updatedAt = Date.now()
    this.persist()
  }

  finish(options: {
    status: Exclude<AgentRunStatus, 'running'>
    outcome?: AgentRunOutcome
    finalAnswer?: string
    finishReason?: string
    stopReason?: string
    research?: AgentResearchTrace
  }): void {
    this.snapshotValue.status = options.status
    this.snapshotValue.currentStage = options.status
    this.snapshotValue.finishedAt = Date.now()
    this.snapshotValue.updatedAt = Date.now()
    if (options.status === 'aborted') {
      this.snapshotValue.toolCalls = this.snapshotValue.toolCalls.map((toolCall) => toolCall.status === 'started'
        ? { ...toolCall, status: 'not_run' as const, error: undefined, finishedAt: this.snapshotValue.updatedAt }
        : toolCall)
    }
    if (options.outcome !== undefined) this.snapshotValue.outcome = options.outcome
    if (options.finalAnswer !== undefined) this.snapshotValue.finalAnswer = options.finalAnswer
    if (options.finishReason !== undefined) this.snapshotValue.finishReason = options.finishReason
    if (options.stopReason !== undefined) this.snapshotValue.stopReason = options.stopReason
    if (options.research !== undefined) this.snapshotValue.research = clone(options.research)
    this.finalized = true
    this.persistSync()
    try { unlinkSync(this.journalPath) } catch { /* 已合并或不存在。 */ }
  }

  private persist(): void {
    if (this.finalized) return
    this.persistDirty = true
    if (this.persistTimer || this.persistInFlight) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.flushInBackground()
    }, 12)
    this.persistTimer.unref?.()
  }

  private async flushInBackground(): Promise<void> {
    if (this.finalized || this.persistInFlight || !this.persistDirty) return
    this.persistDirty = false
    const generation = ++this.persistGeneration
    const snapshot = clone(this.snapshotValue)
    const target = this.filePath
    const temporary = `${target}.${process.pid}.${Date.now()}.${++persistNonce}.tmp`
    const operation = (async () => {
      try {
        await fsPromises.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
        if (this.finalized || generation !== this.persistGeneration) return
        const retryDelays = [5, 15, 35, 75, 150]
        for (let attempt = 0; ; attempt += 1) {
          try {
            await fsPromises.rename(temporary, target)
            break
          } catch (error) {
            if (!isTransientRenameError(error) || attempt >= retryDelays.length) throw error
            await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]))
          }
        }
        if (!this.finalized && generation === this.persistGeneration) persistConversationSummary(this.rootDir, snapshot)
      } catch {
        // 下一次状态变化会重新尝试；终态始终使用同步原子写入。
        this.persistDirty = true
      } finally {
        await fsPromises.rm(temporary, { force: true }).catch(() => undefined)
      }
    })()
    this.persistInFlight = operation
    await operation
    if (this.persistInFlight === operation) this.persistInFlight = null
    if (this.persistDirty && !this.finalized) this.persist()
  }

  private persistSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistDirty = false
    this.persistGeneration += 1
    const target = this.filePath
    const temporary = `${target}.${process.pid}.${Date.now()}.${++persistNonce}.tmp`
    writeFileSync(temporary, JSON.stringify(this.snapshotValue, null, 2), 'utf8')
    const retryDelays = [5, 15, 35, 75, 150]
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          renameSync(temporary, target)
          break
        } catch (error) {
          if (!isTransientRenameError(error) || attempt >= retryDelays.length) throw error
          waitForRenameRetry(retryDelays[attempt])
        }
      }
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary) } catch { /* 过期临时文件不会被读取。 */ }
      }
    }
    persistConversationSummary(this.rootDir, this.snapshotValue)
  }

  static load(rootDir: string, runId: string): AgentRunSnapshot | null {
    const filePath = join(rootDir, 'agent-runs', 'state', `${safeRunId(runId)}.json`)
    if (!existsSync(filePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as AgentRunSnapshot
      return parsed?.runId === runId ? mergeRunJournal(rootDir, parsed) : null
    } catch {
      return null
    }
  }

  /**
   * Worker 最外层兜底：即使异常发生在 AgentService 自己的 try/catch 之外，
   * 也不能把快照永久留在 running，随后被“继续回答”反复当成可恢复任务。
   */
  static failIncomplete(rootDir: string, runId: string, error: unknown, aborted = false): boolean {
    const snapshot = AgentRunStore.load(rootDir, runId)
    if (!snapshot || snapshot.status !== 'running') return false
    const now = Date.now()
    const target = join(rootDir, 'agent-runs', 'state', `${safeRunId(runId)}.json`)
    const temporary = `${target}.${process.pid}.${now}.${++persistNonce}.tmp`
    const message = error instanceof Error ? error.message : String(error || 'Agent 运行失败')
    const failed: AgentRunSnapshot = {
      ...snapshot,
      status: aborted ? 'aborted' : 'failed',
      currentStage: aborted ? 'aborted' : 'failed',
      finishReason: aborted ? 'abort' : 'error',
      stopReason: message,
      finishedAt: now,
      updatedAt: now,
      toolCalls: snapshot.toolCalls.map((toolCall) => toolCall.status === 'started'
        ? {
            ...toolCall,
            status: 'not_run' as const,
            error: undefined,
            finishedAt: now,
          }
        : toolCall),
    }
    writeFileSync(temporary, JSON.stringify(failed, null, 2), 'utf8')
    try {
      renameSync(temporary, target)
      try { unlinkSync(runJournalPath(rootDir, runId)) } catch { /* 已清理。 */ }
      persistConversationSummary(rootDir, failed)
      return true
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary) } catch { /* 下次列表读取会忽略临时文件。 */ }
      }
    }
  }

  static list(rootDir: string, limit = 100): AgentRunSnapshot[] {
    const directory = join(rootDir, 'agent-runs', 'state')
    if (!existsSync(directory)) return []
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(directory, name), 'utf8')) as AgentRunSnapshot
        } catch {
          return null
        }
      })
      .filter((item): item is AgentRunSnapshot => Boolean(item?.runId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.min(1_000, Math.floor(limit || 100))))
  }

  static latestForConversation(rootDir: string, conversationId: number): AgentRunSnapshot | null {
    const normalizedConversationId = Number(conversationId)
    if (!Number.isFinite(normalizedConversationId) || normalizedConversationId <= 0) return null
    const directory = join(rootDir, 'agent-runs', 'state')
    if (!existsSync(directory)) return null
    let latest: AgentRunSnapshot | null = null
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue
      try {
        const snapshot = JSON.parse(readFileSync(join(directory, name), 'utf8')) as AgentRunSnapshot
        if (!snapshot?.runId || Number(snapshot.conversationId) !== normalizedConversationId) continue
        if (!latest || Number(snapshot.updatedAt || 0) > Number(latest.updatedAt || 0)) latest = snapshot
      } catch {
        // 单个损坏快照不能阻止这条会话读取其他可用状态。
      }
    }
    return latest
  }

  /**
   * 历史会话只读取一个轻量索引。旧版没有索引时使用异步 I/O 渐进回填，
   * 避免在 Electron 主进程同步扫描所有大快照而冻结界面。
   */
  static async latestConversationSummary(rootDir: string, conversationId: number): Promise<AgentRunConversationSummary | null> {
    const normalizedConversationId = Number(conversationId)
    if (!Number.isFinite(normalizedConversationId) || normalizedConversationId <= 0) return null
    const indexPath = conversationSummaryPath(rootDir, normalizedConversationId)
    try {
      const summary = JSON.parse(await fsPromises.readFile(indexPath, 'utf8')) as AgentRunConversationSummary
      if (summary?.runId && Number(summary.conversationId) === normalizedConversationId) return summary
    } catch {
      // 旧版运行快照没有按会话建立索引，下面在后台异步回填。
    }

    const directory = join(rootDir, 'agent-runs', 'state')
    let names: string[]
    try {
      names = (await fsPromises.readdir(directory)).filter((name) => name.endsWith('.json'))
    } catch {
      return null
    }
    let latest: AgentRunSnapshot | null = null
    for (const name of names) {
      try {
        const snapshot = JSON.parse(await fsPromises.readFile(join(directory, name), 'utf8')) as AgentRunSnapshot
        if (!snapshot?.runId || Number(snapshot.conversationId) !== normalizedConversationId) continue
        if (!latest || Number(snapshot.updatedAt || 0) > Number(latest.updatedAt || 0)) latest = snapshot
      } catch {
        // 单个损坏快照不影响其他恢复点。
      }
    }
    if (!latest) return null
    persistConversationSummary(rootDir, latest)
    return conversationSummaryOf(latest)
  }

  static listRecent(rootDir: string, limit = 24): AgentRunSnapshot[] {
    const directory = join(rootDir, 'agent-runs', 'state')
    if (!existsSync(directory)) return []
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit || 24)))
    const candidateLimit = Math.max(64, boundedLimit * 3)
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return { name, modifiedAt: statSync(join(directory, name)).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((item): item is { name: string; modifiedAt: number } => Boolean(item))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, candidateLimit)
      .map(({ name }) => {
        try {
          return JSON.parse(readFileSync(join(directory, name), 'utf8')) as AgentRunSnapshot
        } catch {
          return null
        }
      })
      .filter((item): item is AgentRunSnapshot => Boolean(item?.runId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, boundedLimit)
  }
}

export function assessAgentRunResume(
  snapshot: AgentRunSnapshot,
  expected: { question: string; resumeFingerprint: string },
): { accepted: boolean; reason: string } {
  if (snapshot.resumeFingerprint !== expected.resumeFingerprint) return { accepted: false, reason: 'scope-mismatch' }
  if (String(snapshot.question || '').trim() !== String(expected.question || '').trim()) return { accepted: false, reason: 'question-mismatch' }
  if (snapshot.status === 'completed' && snapshot.outcome === 'answered') return { accepted: false, reason: 'completed-answer-must-use-replay' }
  return { accepted: true, reason: 'incomplete-run' }
}

export function findAgentRunResumeCandidate(
  snapshots: AgentRunSnapshot[],
  expected: { runId: string; conversationId?: number | null; question: string; resumeFingerprint: string },
): AgentRunSnapshot | null {
  return snapshots
    .filter((snapshot) => snapshot.runId !== expected.runId)
    .filter((snapshot) => snapshot.conversationId === expected.conversationId)
    .filter((snapshot) => assessAgentRunResume(snapshot, expected).accepted)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null
}
