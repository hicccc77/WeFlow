/**
 * IpcChatTransport 让 @ai-sdk/react 的 useChat 通过 Electron IPC 而不是 HTTP 通信。
 * sendMessages 把 UIMessage 发给主进程（再转交 AI 子进程），并把回推的 UIMessageChunk 组成 ReadableStream。
 * 具体流程见《密语 AI Agent 开发文档（AI SDK 版）》第 5.5 节。
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { AgentContextWindowSource } from '../../../utils/modelTokenLimits'

export type AgentDataSource = 'auto' | 'chat' | 'moments' | 'web'
export type AgentDatePreset = 'all' | '7d' | '30d' | '90d' | 'custom'
export type AgentQueryFilters = {
  datePreset?: AgentDatePreset
  startDate?: string
  endDate?: string
  source?: AgentDataSource
  targetSessions?: Array<{ sessionId: string; displayName?: string }>
}
export type AgentScope =
  | { kind: 'global'; filters?: AgentQueryFilters }
  | { kind: 'session'; sessionId: string; displayName?: string; avatarUrl?: string; filters?: AgentQueryFilters }
export type AgentMode = 'standard' | 'deep-research'
export type AgentReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentModelConfig = {
  provider?: string
  apiKey?: string
  model?: string
  baseURL?: string
  protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google'
  reasoningEffort?: AgentReasoningEffort
  maxOutputTokens?: number
  contextWindow?: number
  contextWindowSource?: AgentContextWindowSource
}

export type AgentProgressEvent = {
  stage: 'run_started' | 'compacting' | 'reasoning' | 'reviewing' | 'finalizing' | 'tool_started' | 'tool_finished' | 'indexing' | 'searching' | 'run_finished' | 'error'
  title: string
  detail?: string
  visible?: boolean
  category?: 'prep' | 'tool' | 'memory' | 'search' | 'system'
  toolName?: string
  toolCallId?: string
  parentToolCallId?: string
  subTaskId?: string
  subTaskTitle?: string
  sessionId?: string
  elapsedMs?: number
  messagesScanned?: number
  indexedCount?: number
  sessionsScanned?: number
  coverage?: string
  depth?: number
  at: number
}

interface AgentBridge {
  run: (
    runId: string,
    messages: unknown[],
    scope?: unknown,
    modelConfig?: AgentModelConfig | null,
    conversationId?: number | null,
    mode?: AgentMode,
    resumeFromRunId?: string
  ) => Promise<{ success: boolean; error?: string }>
  abort: (runId: string) => Promise<{ success: boolean }>
  onChunk: (runId: string, callback: (chunk: unknown) => void) => () => void
  onProgress: (runId: string, callback: (progress: unknown) => void) => () => void
}

function getAgentBridge(): AgentBridge {
  const bridge = (window as any)?.electronAPI?.agent as AgentBridge | undefined
  if (!bridge) throw new Error('electronAPI.agent 未就绪（preload 未加载？）')
  return bridge
}

function randomRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

type AgentStreamSmokeRun = {
  runId: string
  startedAt: number
  updatedAt: number
  scope: AgentScope
  chunkCount: number
  progressCount: number
  chunkTypes: Record<string, number>
  progressStages: Record<string, number>
  firstChunkMs?: number
  firstOutputMs?: number
  finishChunkMs?: number
  doneMs?: number
  finishReason?: string
  hasUsage: boolean
  usage?: unknown
  metadataKeys: string[]
  textPreview: string
  sampleChunks: unknown[]
  lastChunks: unknown[]
  errorText?: string
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

type AgentStreamSmokeStore = {
  last: AgentStreamSmokeRun | null
  runs: AgentStreamSmokeRun[]
  clear: () => void
}

function ensureSmokeStore(): AgentStreamSmokeStore | null {
  if (typeof window === 'undefined') return null
  const win = window as unknown as {
    __ctAgentStreamSmoke?: AgentStreamSmokeStore
  }
  if (!win.__ctAgentStreamSmoke) {
    win.__ctAgentStreamSmoke = {
      last: null,
      runs: [],
      clear: () => {
        if (!win.__ctAgentStreamSmoke) return
        win.__ctAgentStreamSmoke.last = null
        win.__ctAgentStreamSmoke.runs = []
      },
    }
  }
  return win.__ctAgentStreamSmoke
}

ensureSmokeStore()

function publishSmoke(run: AgentStreamSmokeRun): void {
  const store = ensureSmokeStore()
  if (!store || typeof window === 'undefined') return
  store.runs = [...store.runs.filter((item) => item.runId !== run.runId), run].slice(-20)
  store.last = run
  try {
    window.dispatchEvent(new CustomEvent('ct-agent-stream-smoke', { detail: run }))
  } catch {
    /* 测试环境中可能没有 CustomEvent。 */
  }
}

function startSmokeRun(input: {
  runId: string
  scope: AgentScope
}): AgentStreamSmokeRun | null {
  const startedAt = nowMs()
  const run: AgentStreamSmokeRun = {
    ...input,
    startedAt,
    updatedAt: Date.now(),
    chunkCount: 0,
    progressCount: 0,
    chunkTypes: {},
    progressStages: {},
    hasUsage: false,
    metadataKeys: [],
    textPreview: '',
    sampleChunks: [],
    lastChunks: [],
  }
  publishSmoke(run)
  return run
}

function updateSmoke(run: AgentStreamSmokeRun | null, updater: (run: AgentStreamSmokeRun) => void): void {
  if (!run) return
  updater(run)
  run.updatedAt = Date.now()
  publishSmoke(run)
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

/** Normalize supported field aliases and reject incomplete stream events at the IPC boundary. */
export function normalizeAgentUIMessageChunk(value: unknown): UIMessageChunk | null {
  const record = readObject(value)
  if (!record) return null
  const type = String(record.type || '')
  if (!type) return null
  const hasString = (key: string) => typeof record[key] === 'string' && record[key] !== ''
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(record, key)
  if (type === 'text-delta' || type === 'reasoning-delta') {
    const delta = firstString(record, ['delta', 'textDelta', 'text', 'content'])
    if (delta === undefined || !hasString('id')) return null
    return { ...record, type, id: String(record.id), delta } as UIMessageChunk
  }
  if (type === 'tool-input-delta') {
    const inputTextDelta = firstString(record, ['inputTextDelta', 'delta', 'argumentsDelta', 'arguments'])
    if (inputTextDelta === undefined || !hasString('toolCallId')) return null
    return { ...record, type, toolCallId: String(record.toolCallId), inputTextDelta } as UIMessageChunk
  }
  if (type === 'error') {
    return {
      ...record,
      type,
      errorText: firstString(record, ['errorText', 'error', 'message']) || 'Agent 流返回了未知错误',
    } as UIMessageChunk
  }
  if (['text-start', 'text-end', 'reasoning-start', 'reasoning-end'].includes(type)) {
    return hasString('id') ? record as UIMessageChunk : null
  }
  if (type === 'tool-input-start') {
    return hasString('toolCallId') && hasString('toolName') ? record as UIMessageChunk : null
  }
  if (type === 'tool-input-available' || type === 'tool-input-error') {
    if (!hasString('toolCallId') || !hasString('toolName') || !hasOwn('input')) return null
    if (type === 'tool-input-error' && !hasString('errorText')) return null
    return record as UIMessageChunk
  }
  if (type === 'tool-output-available') {
    return hasString('toolCallId') && hasOwn('output') ? record as UIMessageChunk : null
  }
  if (type === 'tool-output-error') {
    return hasString('toolCallId') && hasString('errorText') ? record as UIMessageChunk : null
  }
  if (type === 'tool-output-denied') {
    return hasString('toolCallId') ? record as UIMessageChunk : null
  }
  if (type === 'tool-approval-request') {
    return hasString('approvalId') && hasString('toolCallId') ? record as UIMessageChunk : null
  }
  if (type === 'tool-approval-response') {
    return hasString('approvalId') && typeof record.approved === 'boolean' ? record as UIMessageChunk : null
  }
  if (type === 'source-url') {
    return hasString('sourceId') && hasString('url') ? record as UIMessageChunk : null
  }
  if (type === 'source-document') {
    return hasString('sourceId') && hasString('mediaType') && hasString('title') ? record as UIMessageChunk : null
  }
  if (type === 'file' || type === 'reasoning-file') {
    return hasString('url') && hasString('mediaType') ? record as UIMessageChunk : null
  }
  if (type === 'custom') {
    return hasString('kind') && String(record.kind).includes('.') ? record as UIMessageChunk : null
  }
  if (type.startsWith('data-')) {
    return hasOwn('data') ? record as UIMessageChunk : null
  }
  if (type === 'message-metadata') {
    return hasOwn('messageMetadata') ? record as UIMessageChunk : null
  }
  if (['start', 'finish', 'abort', 'start-step', 'finish-step'].includes(type)) {
    return record as UIMessageChunk
  }
  return null
}

/**
 * Keep the IPC stream structurally valid for the AI SDK consumer.
 *
 * Provider-compatible gateways occasionally repeat closing events, and an event delayed across
 * a step boundary is effectively orphaned because AI SDK clears active parts at finish-step.
 * Repairing at this final boundary prevents one malformed close from discarding an otherwise
 * completed Agent answer.
 */
export class AgentUIMessageChunkSequence {
  private readonly activeTextIds = new Set<string>()
  private readonly activeReasoningIds = new Set<string>()
  private readonly closedTextIds = new Set<string>()
  private readonly closedReasoningIds = new Set<string>()

  accept(chunk: UIMessageChunk): UIMessageChunk[] {
    const record = chunk as unknown as Record<string, unknown>
    const type = String(record.type || '')
    const id = typeof record.id === 'string' ? record.id : ''

    if (type === 'text-start') {
      if (this.activeTextIds.has(id)) return []
      this.closedTextIds.delete(id)
      this.activeTextIds.add(id)
      return [chunk]
    }
    if (type === 'text-delta') {
      if (this.activeTextIds.has(id)) return [chunk]
      if (this.closedTextIds.has(id)) return []
      this.activeTextIds.add(id)
      return [{ type: 'text-start', id } as UIMessageChunk, chunk]
    }
    if (type === 'text-end') {
      if (!this.activeTextIds.delete(id)) return []
      this.closedTextIds.add(id)
      return [chunk]
    }
    if (type === 'reasoning-start') {
      if (this.activeReasoningIds.has(id)) return []
      this.closedReasoningIds.delete(id)
      this.activeReasoningIds.add(id)
      return [chunk]
    }
    if (type === 'reasoning-delta') {
      if (this.activeReasoningIds.has(id)) return [chunk]
      if (this.closedReasoningIds.has(id)) return []
      this.activeReasoningIds.add(id)
      return [{ type: 'reasoning-start', id } as UIMessageChunk, chunk]
    }
    if (type === 'reasoning-end') {
      if (!this.activeReasoningIds.delete(id)) return []
      this.closedReasoningIds.add(id)
      return [chunk]
    }
    if (type === 'finish-step' || type === 'finish' || type === 'abort' || type === 'error') {
      return [...this.closeActiveParts(), chunk]
    }
    return [chunk]
  }

  private closeActiveParts(): UIMessageChunk[] {
    const closingChunks: UIMessageChunk[] = []
    for (const id of this.activeTextIds) {
      closingChunks.push({ type: 'text-end', id } as UIMessageChunk)
      this.closedTextIds.add(id)
    }
    for (const id of this.activeReasoningIds) {
      closingChunks.push({ type: 'reasoning-end', id } as UIMessageChunk)
      this.closedReasoningIds.add(id)
    }
    this.activeTextIds.clear()
    this.activeReasoningIds.clear()
    return closingChunks
  }
}

function observeSmokeChunk(run: AgentStreamSmokeRun | null, chunk: unknown): void {
  updateSmoke(run, (item) => {
    item.chunkCount += 1
    const elapsed = nowMs() - item.startedAt
    if (item.firstChunkMs === undefined) item.firstChunkMs = elapsed
    const object = readObject(chunk)
    const type = String(object?.type || 'unknown')
    item.chunkTypes[type] = (item.chunkTypes[type] || 0) + 1
    if (item.sampleChunks.length < 12) item.sampleChunks.push(chunk)
    item.lastChunks = [...item.lastChunks, chunk].slice(-12)
    if (item.firstOutputMs === undefined && ['text-delta', 'reasoning-delta', 'tool-input-start'].includes(type)) {
      item.firstOutputMs = elapsed
    }
    if (type === 'text-delta' && typeof object?.delta === 'string') {
      item.textPreview = `${item.textPreview}${object.delta}`.slice(-1000)
    }
    if (type === 'finish') {
      item.finishChunkMs = elapsed
      const metadata = readObject(object?.messageMetadata)
      item.metadataKeys = metadata ? Object.keys(metadata) : []
      item.finishReason = String(object?.finishReason || metadata?.finishReason || '') || undefined
      item.usage = metadata?.usage
      item.hasUsage = Boolean(metadata?.usage)
    }
    if (type === 'error') item.errorText = String(object?.errorText || object?.error || '') || 'stream error'
  })
}

function observeSmokeProgress(run: AgentStreamSmokeRun | null, progress: unknown): void {
  updateSmoke(run, (item) => {
    item.progressCount += 1
    const object = readObject(progress)
    const stage = String(object?.stage || 'unknown')
    item.progressStages[stage] = (item.progressStages[stage] || 0) + 1
  })
}

export function agentResumeRequestMessages(messages: unknown[]): unknown[] {
  const source = Array.isArray(messages) ? messages : []
  let lastUserIndex = -1
  for (let index = 0; index < source.length; index += 1) {
    if (readObject(source[index])?.role === 'user') lastUserIndex = index
  }
  return lastUserIndex >= 0 ? source.slice(0, lastUserIndex + 1) : [...source]
}

export class IpcChatTransport<UI_MESSAGE extends UIMessage = UIMessage> implements ChatTransport<UI_MESSAGE> {
  private lastIncompleteRunId: string | null = null
  private lastSubmittedMessages: unknown[] | null = null
  private activeRunId: string | null = null
  private forceStopActiveStream: (() => void) | null = null

  constructor(
    private readonly getScope?: () => AgentScope,
    private readonly getModelConfig?: () => AgentModelConfig | null,
    private readonly getConversationId?: () => number | null,
    private readonly getMode?: () => AgentMode,
    private readonly onProgress?: (progress: AgentProgressEvent) => void,
    private readonly getMessages?: () => UI_MESSAGE[],
  ) {}

  setResumeCandidate(runId: string | null | undefined): void {
    this.lastIncompleteRunId = String(runId || '').trim() || null
  }

  /**
   * Renderer-side hard stop. This closes the local stream immediately and independently asks
   * the main process to terminate the Worker, so a stuck tool cannot keep the composer busy.
   */
  stopImmediately(): void {
    const stop = this.forceStopActiveStream
    if (stop) {
      stop()
      return
    }
    const runId = this.activeRunId
    if (!runId) return
    this.lastIncompleteRunId = runId
    void getAgentBridge().abort(runId).catch(() => {})
  }

  private createRunStream(input: {
    runId: string
    messages: unknown[]
    scope: AgentScope
    modelConfig: AgentModelConfig | null
    conversationId: number | null
    mode: AgentMode
    resumeFromRunId?: string
    abortSignal?: AbortSignal
  }): ReadableStream<UIMessageChunk> {
    const bridge = getAgentBridge()
    this.activeRunId = input.runId
    const smokeRun = startSmokeRun({ runId: input.runId, scope: input.scope })
    const chunkSequence = new AgentUIMessageChunkSequence()
    const progressHandler = this.onProgress
    this.lastIncompleteRunId = input.runId
    let streamTerminated = false
    let cleanupStream = () => {}

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let streamFailed = false
        let cleanedUp = false
        let off = () => {}
        let offProgress = () => {}
        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          off()
          offProgress()
          input.abortSignal?.removeEventListener('abort', abortRun)
          if (this.activeRunId === input.runId) {
            this.activeRunId = null
            this.forceStopActiveStream = null
          }
        }
        cleanupStream = cleanup
        const closeStream = () => {
          if (streamTerminated) return
          streamTerminated = true
          try { controller.close() } catch { /* already closed or errored */ }
          cleanup()
        }
        const enqueueChunk = (chunk: UIMessageChunk): boolean => {
          if (streamTerminated) return false
          try {
            controller.enqueue(chunk)
            return true
          } catch {
            streamTerminated = true
            cleanup()
            return false
          }
        }
        const abortRun = () => {
          this.lastIncompleteRunId = input.runId
          updateSmoke(smokeRun, (item) => { item.errorText = 'aborted' })
          // `useChat.stop()` expects the transport stream to settle immediately.
          // The Agent process may still be inside a synchronous database/tool call,
          // so never keep the renderer coupled to its cooperative shutdown latency.
          closeStream()
          void bridge.abort(input.runId).catch(() => {})
        }
        this.forceStopActiveStream = abortRun

        off = bridge.onChunk(input.runId, (chunk) => {
          if (streamTerminated) return
          if (chunk === '[DONE]') {
            updateSmoke(smokeRun, (item) => { item.doneMs = nowMs() - item.startedAt })
            closeStream()
            return
          }
          const normalizedChunk = normalizeAgentUIMessageChunk(chunk)
          if (!normalizedChunk) {
            updateSmoke(smokeRun, (item) => {
              item.errorText = `dropped malformed ${String(readObject(chunk)?.type || 'unknown')} chunk`
            })
            return
          }
          for (const safeChunk of chunkSequence.accept(normalizedChunk)) {
            observeSmokeChunk(smokeRun, safeChunk)
            if (readObject(safeChunk)?.type === 'error') {
              streamFailed = true
              this.lastIncompleteRunId = input.runId
            }
            enqueueChunk(safeChunk)
          }
        })
        offProgress = bridge.onProgress(input.runId, (progress) => {
          if (progress && typeof progress === 'object') {
            observeSmokeProgress(smokeRun, progress)
            progressHandler?.(progress as AgentProgressEvent)
          }
        })

        if (input.abortSignal?.aborted) {
          abortRun()
          return
        }
        input.abortSignal?.addEventListener('abort', abortRun, { once: true })

        void bridge.run(
          input.runId,
          input.messages,
          input.scope,
          input.modelConfig,
          input.conversationId,
          input.mode,
          input.resumeFromRunId,
        ).then((result) => {
          if (result.success && !streamFailed) this.lastIncompleteRunId = null
          else this.lastIncompleteRunId = input.runId
        }).catch((error: unknown) => {
          this.lastIncompleteRunId = input.runId
          try {
            const errorChunk = { type: 'error', errorText: error instanceof Error ? error.message : String(error) } as UIMessageChunk
            observeSmokeChunk(smokeRun, errorChunk)
            enqueueChunk(errorChunk)
            closeStream()
          } catch { /* 已关闭 */ }
          cleanupStream()
        }).finally(() => {
          offProgress()
          input.abortSignal?.removeEventListener('abort', abortRun)
        })
      },
      cancel: () => {
        this.lastIncompleteRunId = input.runId
        streamTerminated = true
        cleanupStream()
        // Stream cancellation must not wait for the main-process round trip.
        void bridge.abort(input.runId).catch(() => {})
      },
    })
  }

  async sendMessages(
    options: Parameters<ChatTransport<UI_MESSAGE>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const runId = randomRunId()
    const scope = this.getScope?.() ?? { kind: 'global' }
    const messages = [...(options.messages as unknown[])]
    const modelConfig = this.getModelConfig?.() ?? null
    const conversationId = this.getConversationId?.() ?? null
    const mode = this.getMode?.() ?? 'standard'
    const resumeFromRunId = options.trigger === 'regenerate-message'
      ? this.lastIncompleteRunId || '__auto__'
      : undefined
    this.lastSubmittedMessages = messages
    return this.createRunStream({
      runId,
      messages,
      scope,
      modelConfig,
      conversationId,
      mode,
      resumeFromRunId,
      abortSignal: options.abortSignal,
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    const resumeFromRunId = this.lastIncompleteRunId || '__auto__'
    const currentMessages = this.lastSubmittedMessages
      || (this.getMessages?.() as unknown[] | undefined)
      || []
    const messages = agentResumeRequestMessages(currentMessages)
    if (messages.length === 0) return null
    const runId = randomRunId()
    this.lastSubmittedMessages = messages
    return this.createRunStream({
      runId,
      messages,
      scope: this.getScope?.() ?? { kind: 'global' },
      modelConfig: this.getModelConfig?.() ?? null,
      conversationId: this.getConversationId?.() ?? null,
      mode: this.getMode?.() ?? 'standard',
      resumeFromRunId,
    })
  }
}
