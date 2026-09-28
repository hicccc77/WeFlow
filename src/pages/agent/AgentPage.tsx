import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type ComponentProps, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Chat, useChat } from '@ai-sdk/react'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, type ChatStatus, type UIMessage } from 'ai'
import { Button as HeroButton, Surface, Tooltip } from '@heroui/react'
import { CircleInfo, PencilToSquare } from '@gravity-ui/icons'
import { X } from 'lucide-react'
import '@/styles/agent.css'
import '@/styles/agent-token-meter.css'
import {
  Conversation,
  ConversationAutoScroll,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputControllerProps,
  type PromptInputMessage,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input'
import { IpcChatTransport, type AgentMode, type AgentModelConfig, type AgentProgressEvent, type AgentReasoningEffort, type AgentScope } from '@/features/aiagent/transport/ipcChatTransport'
import * as configService from '@/services/config'
import { buildFallbackConversationTitle, findLatestIncompleteAgentRunForConversation, markAgentExecutionCompleted, markAgentExecutionResumed, markAgentExecutionStopped, markUnfinishedAgentToolsNotRun, normalizeConversationRecord, normalizeLoadedConversation, readAgentMessageTimestamp, readLatestStoppedAgentExecutionElapsed, storeActiveAgentConversation, type AgentConversationRecord } from './agentConversationHelpers'
import { AgentMessageItem, type AgentImagePreviewPayload } from './AgentMessageItem'
import { AgentRecordsMenu } from './AgentRecordsMenu'
import { AgentMemoryPanel } from './AgentMemoryPanel'
import { AgentReasoningEffortControl } from './AgentReasoningEffortControl'
import { ModelWaitingLine } from './AgentSubAgentProgress'
import { AgentModelSelector, AgentPromptPrimaryAction, AgentTokenMeter, PromptInputControllerBridge } from './AgentPromptToolbar'
import { encodeMentionText, filterMentionTargets, findActiveMentionQuery, findNextUnresolvedMentionQuery, getUserMessageDisplay, MentionTriggerButton, MentionTypeahead, segmentComposerMentionText, toMentionTarget, type MentionInputQuery, type MentionTarget } from './AgentMentions'
import { ImagePreview } from '@/components/ImagePreview'
import { VoiceTranscribeDialog } from '@/components/VoiceTranscribeDialog'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { messageTextOf, UsageDetailsModal } from './AgentUsageStats'
import type { AgentMessageMetadata } from './agentConversationHelpers'
import { getAIProviders, type AIModelInfo, type AIModelMetadataResolution, type AIProviderInfo } from '@/types/ai'
import { catalogModelContextWindow, resolveAgentContextWindow } from '@/utils/modelTokenLimits'
import { toolProgressKey, type SourceItem } from './agentMessageHelpers'
import type { AgentMessageFeedback } from './AgentUsageStats'
import { scheduleAgentConversationPersist, sendWithImmediateAgentConversationPersist } from './agentConversationPersistence'
import { InvestigationPlanPanel } from './AgentInvestigationPlanPanel'
import { resolveCurrentTurnInvestigationPlan } from './agentInvestigationPlan'
import { estimateAgentContextMessagesTokens } from '@/utils/agentTokenEstimate'
import { collectToolSessionIds } from './agentToolPresentation'

const EMPTY_PROMPT_LINES = [
  '随时准备好，只等你需要',
  '从聊天里，找到真正有用的答案',
  '想找回哪一段聊天？',
  '你的本地聊天记忆，随时可查',
]

type AgentRuntimeWindow = Window & {
  __weflowAgentEmptyCopyIndex?: number
  __weflowAgentEmptyCopyKey?: string
}

function emptyCopyKeyForMention(target: MentionTarget | null): string {
  return target ? `mention:${target.username}` : 'global'
}

function storeRuntimeEmptyCopyIndex(index: number, key: string): number {
  const runtimeWindow = window as AgentRuntimeWindow
  runtimeWindow.__weflowAgentEmptyCopyIndex = index
  runtimeWindow.__weflowAgentEmptyCopyKey = key
  return index
}

function initialEmptyCopyIndex(key: string): number {
  const runtimeWindow = window as AgentRuntimeWindow
  const stored = runtimeWindow.__weflowAgentEmptyCopyIndex
  const valid = typeof stored === 'number'
    && Number.isInteger(stored)
    && stored >= 0
    && stored < EMPTY_PROMPT_LINES.length
  if (valid && runtimeWindow.__weflowAgentEmptyCopyKey === key) return stored
  if (valid) return nextEmptyCopyIndex(stored, key)
  return storeRuntimeEmptyCopyIndex(Math.floor(Math.random() * EMPTY_PROMPT_LINES.length), key)
}

function nextEmptyCopyIndex(current: number, key: string): number {
  if (EMPTY_PROMPT_LINES.length <= 1) return storeRuntimeEmptyCopyIndex(0, key)
  const offset = 1 + Math.floor(Math.random() * (EMPTY_PROMPT_LINES.length - 1))
  return storeRuntimeEmptyCopyIndex((current + offset) % EMPTY_PROMPT_LINES.length, key)
}

const MENTION_LOOKUP_LIMIT = 60
const MENTION_AVATAR_VISIBLE_LIMIT = 30
const AGENT_MENTION_CACHE_TTL_MS = 5 * 60 * 1000
const NO_AGENT_PROGRESS: AgentProgressEvent[] = []
const NO_TOOL_ELAPSED_BY_KEY: Record<string, number> = {}
const AGENT_VOICE_MODEL_REQUIRED_ERROR_CODE = 'AGENT_VOICE_MODEL_REQUIRED'

function mentionLookupQuery(query: string): string {
  const normalized = query.trim()
  if (!normalized) return ''
  const asciiBeforeHan = normalized.match(/^[A-Za-z0-9_.-]+(?=\p{Script=Han})/u)?.[0]
  if (asciiBeforeHan) return asciiBeforeHan
  if (/^\p{Script=Han}/u.test(normalized)) return Array.from(normalized).slice(0, 2).join('')
  return normalized
}

type AgentMentionPromptTextareaProps = Omit<ComponentProps<typeof PromptInputTextarea>, 'ref'> & {
  mentions: MentionTarget[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

function AgentMentionPromptTextarea({
  mentions,
  textareaRef,
  onScroll,
  ...props
}: AgentMentionPromptTextareaProps) {
  const controller = usePromptInputController()
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, scrollbarWidth: 0 })
  const segments = useMemo(
    () => segmentComposerMentionText(controller.textInput.value, mentions),
    [controller.textInput.value, mentions],
  )

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const next = {
      top: textarea.scrollTop,
      scrollbarWidth: Math.max(0, textarea.offsetWidth - textarea.clientWidth),
    }
    setScrollMetrics((current) => (
      current.top === next.top && current.scrollbarWidth === next.scrollbarWidth ? current : next
    ))
  }, [controller.textInput.value, textareaRef])

  return (
    <div className="agent-prompt-textarea-shell">
      <div aria-hidden="true" className="agent-prompt-highlight-layer">
        <div
          className="agent-prompt-highlight-content"
          style={{
            paddingRight: `${16 + scrollMetrics.scrollbarWidth}px`,
            transform: `translateY(${-scrollMetrics.top}px)`,
          }}
        >
          {segments.map((segment, index) => segment.kind === 'mention' ? (
            <span className="agent-prompt-mention-highlight" key={`mention-${segment.target.username}-${index}`}>
              @{segment.target.displayName}
            </span>
          ) : (
            <span key={`text-${index}`}>{segment.text}</span>
          ))}
          <span>{'\u200b'}</span>
        </div>
      </div>
      <PromptInputTextarea
        {...props}
        ref={textareaRef}
        onScroll={(event) => {
          const textarea = event.currentTarget
          setScrollMetrics({
            top: textarea.scrollTop,
            scrollbarWidth: Math.max(0, textarea.offsetWidth - textarea.clientWidth),
          })
          onScroll?.(event)
        }}
      />
    </div>
  )
}

function isAgentModelReady(config: AgentModelConfig | null | undefined): boolean {
  return Boolean(config?.model && config.baseURL && (config.apiKey || config.provider === 'ollama'))
}

function agentRunErrorNotice(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '回答失败')
  if (/concurrenc(?:y|ies)(?: limit)?(?: exceeded| reached)?|too many (?:concurrent )?requests|rate[ -]?limit|HTTP\s*429|resource[_ -]?exhausted|overloaded|请求过于频繁|并发.{0,8}(?:限制|超限|已满)/i.test(message)) {
    return '模型服务限制了同一账号或 API Key 的并发请求。已完成的工具调用和执行检查点均已保留；稍后点击“继续回答”会从中断处续接。'
  }
  if (/no output generated|service temporarily unavailable|upstream service|HTTP\s*50[234]|(?:step|chunk|provider request) timeout|operation was aborted due to timeout|cannot close an errored readable stream|ReadableStreamDefaultController/i.test(message)) {
    return '模型服务暂时不可用或响应超时。已完成的原文读取和进度均已保留，稍后点击“继续回答”会从中断处续接。'
  }
  return message || '回答失败'
}

function isRetryableAgentRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /concurrenc(?:y|ies)(?: limit)?(?: exceeded| reached)?|too many (?:concurrent )?requests|rate[ -]?limit|HTTP\s*(?:429|50[234])|resource[_ -]?exhausted|overloaded|no output generated|service temporarily unavailable|upstream service|(?:step|chunk|tool|provider request) timeout|operation was aborted due to timeout|cannot close an errored readable stream|ReadableStreamDefaultController|stream[_ -]?(?:read[_ -]?)?error|fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|terminated|premature close|connection closed|请求过于频繁|并发.{0,8}(?:限制|超限|已满)/i.test(message)
}

function isAgentVoiceModelRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.includes(AGENT_VOICE_MODEL_REQUIRED_ERROR_CODE)
}

const AGENT_RESUME_NOTICE = '回答已中断。已完成的工具调用和执行检查点均已保留；可使用输入框右侧的“继续回答”按钮从中断处续接。'

// 只有真实的空查询目录响应才能填充此缓存。渲染工具结果时发现的搜索命中和会话 ID
// 在本地有用，但不能证明提及目录已经加载。
let cachedAgentMentionDirectoryTargets: MentionTarget[] = []
let cachedAgentMentionDirectoryAt = 0

type AgentRuntimeSnapshot = {
  messages: UIMessage[]
  conversationId: number | null
  conversationTitle: string
  conversationTitleGenerated: boolean
  mentions: MentionTarget[]
  scope: AgentScope
  mode: AgentMode
  resumeAvailable: boolean
}

let agentRuntimeSnapshot: AgentRuntimeSnapshot | null = null
let agentRuntimeSequence = 0

type AgentConversationRuntime = {
  key: string
  chat: Chat<UIMessage>
  transport: IpcChatTransport<UIMessage>
  conversationId: number | null
  conversationTitle: string
  conversationTitleGenerated: boolean
  mentions: MentionTarget[]
  scope: AgentScope
  mode: AgentMode
  modelConfig: AgentModelConfig | null
  progress: AgentProgressEvent[]
  toolStartedAtByKey: Record<string, number>
  notice: string
  draft: string
  queuedMessage: PromptInputMessage | null
  resumeAvailable: boolean
  stopRequested: boolean
  executionElapsedBeforeMs: number
  executionSegmentStartedAt: number | null
  voiceModelDownloadRequired: boolean
  activePlanStartIndex: number | null
  saveTimer: number | null
  transportRetryTimer: number | null
  transportRetryAttempt: number
  dispose: () => void
}

function readCachedAgentMentionDirectoryTargets(): MentionTarget[] {
  if (Date.now() - cachedAgentMentionDirectoryAt > AGENT_MENTION_CACHE_TTL_MS) return []
  return cachedAgentMentionDirectoryTargets
}

function writeCachedAgentMentionDirectoryTargets(targets: MentionTarget[]) {
  cachedAgentMentionDirectoryTargets = targets
  cachedAgentMentionDirectoryAt = Date.now()
}

function isGenericMentionName(name: string | undefined, username: string): boolean {
  const normalized = String(name || '').trim()
  return !normalized || normalized === username
}

function mergeMentionTarget(current: MentionTarget, incoming: MentionTarget): MentionTarget {
  const displayName = isGenericMentionName(current.displayName, current.username)
    ? incoming.displayName
    : current.displayName
  const avatarUrl = incoming.avatarUrl || current.avatarUrl
  if (displayName === current.displayName && avatarUrl === current.avatarUrl && incoming.kind === current.kind) return current
  return { ...current, kind: incoming.kind, displayName, avatarUrl }
}

function mergeMentionTargetLists(...lists: MentionTarget[][]): MentionTarget[] {
  const result = new Map<string, MentionTarget>()
  for (const list of lists) {
    for (const target of list) {
      const username = String(target.username || '').trim()
      if (!username) continue
      const normalized = { ...target, username }
      const current = result.get(username)
      result.set(username, current ? mergeMentionTarget(current, normalized) : normalized)
    }
  }
  return Array.from(result.values())
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function scopeForMentions(mentions: MentionTarget[]): AgentScope {
  return mentions.length === 1
    ? {
        kind: 'session',
        sessionId: mentions[0].username,
        displayName: mentions[0].displayName,
        avatarUrl: mentions[0].avatarUrl,
      }
    : mentions.length > 1
      ? {
          kind: 'global',
          filters: {
            targetSessions: mentions.map((item) => ({ sessionId: item.username, displayName: item.displayName })),
          },
        }
      : { kind: 'global' }
}

function encodeMessage(text: string, mentions: MentionTarget[]): string {
  return encodeMentionText(text, mentions)
}

function buildAgentModelConfiguration(
  profile: configService.AiConfigPreset | undefined,
  fallbackProvider: string,
  providers: AIProviderInfo[],
  verifiedMetadata?: AIModelMetadataResolution,
): AgentModelConfig | null {
  if (!profile) return null
  const provider = profile.provider || fallbackProvider
  const providerInfo = providers.find((item) => item.id === provider)
  const normalizedActiveModel = String(profile.model || '').replace(/^models\//i, '').toLowerCase()
  const catalogModel = providerInfo?.modelDetails?.find((item) => (
    item.id.replace(/^models\//i, '').toLowerCase() === normalizedActiveModel
  ))
  const catalogContextWindow = verifiedMetadata?.success
    ? verifiedMetadata.contextWindow
    : catalogModelContextWindow(catalogModel?.limits)
  const resolvedContext = resolveAgentContextWindow({
    manual: profile.contextWindow,
    catalog: catalogContextWindow,
    modelId: profile.model,
  })
  const catalogOutputLimit = verifiedMetadata?.success
    ? verifiedMetadata.maxOutputTokens
    : catalogModel?.limits.output
  // 1024 是历史配置的回退值，对模型主导的调查和最终合成来说太小。
  // 如果旧配置仍携带该值，则使用供应商上限（或服务默认值）。
  const configuredOutput = Number(profile.maxTokens) || 0
  const requestedOutput = configuredOutput > 1_024
    ? configuredOutput
    : catalogOutputLimit || 16_000
  return {
    provider,
    apiKey: profile.apiKey,
    model: profile.model,
    baseURL: profile.baseURL,
    protocol: profile.protocol,
    maxOutputTokens: catalogOutputLimit
      ? Math.min(requestedOutput, catalogOutputLimit)
      : requestedOutput,
    contextWindow: resolvedContext.contextWindow,
    contextWindowSource: resolvedContext.source,
  }
}

function agentModelMetadataKey(profile: configService.AiConfigPreset, fallbackProvider: string): string {
  return [profile.provider || fallbackProvider, profile.model, profile.baseURL || '']
    .map((value) => String(value || '').trim().toLowerCase())
    .join('::')
}

function buildContinuationConversationTitle(title: string): string {
  const normalized = String(title || '新对话').replace(/\s*[·・]\s*续聊(?:\s*\d+)?$/u, '').trim() || '新对话'
  return `${normalized.slice(0, 19)} · 续聊`.slice(0, 24)
}

export type AgentPageProps = {
  active?: boolean
  routeSessionId?: string
  routeState?: { displayName?: string; avatarUrl?: string } | null
}

export default function AgentPage({ active = true, routeSessionId: routeSessionIdOverride, routeState: routeStateOverride }: AgentPageProps = {}) {
  const navigate = useNavigate()
  const { sessionId: routeSessionIdParam } = useParams<{ sessionId?: string }>()
  const routeLocation = useLocation()
  const routeSessionIdRaw = routeSessionIdOverride ?? routeSessionIdParam
  const routeSessionId = routeSessionIdRaw ? decodeURIComponent(routeSessionIdRaw) : ''
  const routeState = routeStateOverride !== undefined
    ? routeStateOverride
    : routeLocation.state as { displayName?: string; avatarUrl?: string } | null
  const routeDisplayName = String(routeState?.displayName || routeSessionId)
  const routeAvatarUrl = String(routeState?.avatarUrl || '').trim() || undefined
  const routedMention = useMemo(
    () => routeSessionId ? toMentionTarget(routeSessionId, routeDisplayName, routeAvatarUrl) : null,
    [routeAvatarUrl, routeDisplayName, routeSessionId],
  )
  const initialRuntimeSnapshotRef = useRef<AgentRuntimeSnapshot | null>(
    routedMention ? null : agentRuntimeSnapshot,
  )
  const initialRuntimeSnapshot = initialRuntimeSnapshotRef.current
  const initialMentionTargetsRef = useRef(readCachedAgentMentionDirectoryTargets())

  const [mentions, setMentions] = useState<MentionTarget[]>(() => (
    routedMention ? [routedMention] : initialRuntimeSnapshot?.mentions || []
  ))
  const [sessions, setSessions] = useState<MentionTarget[]>(() => initialMentionTargetsRef.current)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [activeMentionQuery, setActiveMentionQuery] = useState<MentionInputQuery | null>(null)
  const [mentionSuggestionIndex, setMentionSuggestionIndex] = useState(0)
  const [modelConfig, setModelConfig] = useState<AgentModelConfig | null>(null)
  const [modelProfiles, setModelProfiles] = useState<configService.AiConfigPreset[]>([])
  const [modelProviders, setModelProviders] = useState<AIProviderInfo[]>([])
  const [activeModelProfileId, setActiveModelProfileId] = useState('')
  const [modelLoading, setModelLoading] = useState(true)
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false)
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>('high')
  const [agentMode, setAgentMode] = useState<AgentMode>(() => initialRuntimeSnapshot?.mode || 'standard')
  const agentModeRef = useRef<AgentMode>('standard')
  agentModeRef.current = agentMode
  const modelConfigRef = useRef<AgentModelConfig | null>(null)
  modelConfigRef.current = modelConfig ? { ...modelConfig, reasoningEffort } : modelConfig
  const [conversationId, setConversationId] = useState<number | null>(() => initialRuntimeSnapshot?.conversationId ?? null)
  const conversationIdRef = useRef<number | null>(null)
  conversationIdRef.current = conversationId
  const [conversationTitle, setConversationTitle] = useState(() => initialRuntimeSnapshot?.conversationTitle || '新对话')
  const [conversationTitleGenerated, setConversationTitleGenerated] = useState(() => Boolean(initialRuntimeSnapshot?.conversationTitleGenerated))
  const [records, setRecords] = useState<AgentConversationRecord[]>([])
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [notice, setNotice] = useState(() => initialRuntimeSnapshot?.resumeAvailable ? AGENT_RESUME_NOTICE : '')
  const [progress, setProgress] = useState<AgentProgressEvent[]>([])
  const [copiedMessageId, setCopiedMessageId] = useState('')
  const [speakingMessageId, setSpeakingMessageId] = useState('')
  const [regeneratingMessageId, setRegeneratingMessageId] = useState('')
  const [forkingMessageId, setForkingMessageId] = useState('')
  const [usageDetails, setUsageDetails] = useState<AgentMessageMetadata | null>(null)
  const [preview, setPreview] = useState<AgentImagePreviewPayload | null>(null)
  const [responsePendingVisible, setResponsePendingVisible] = useState(false)
  const [responsePendingLeaving, setResponsePendingLeaving] = useState(false)
  const [voiceModelDownloadRuntime, setVoiceModelDownloadRuntime] = useState<AgentConversationRuntime | null>(null)
  const [planRevision, setPlanRevision] = useState(0)
  const [, setRuntimeStateRevision] = useState(0)
  const [queuedMessage, setQueuedMessage] = useState<PromptInputMessage | null>(null)
  const [messageFeedback, setMessageFeedback] = useState<Record<string, AgentMessageFeedback>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem('weflow.agent.messageFeedback') || '{}')
    } catch {
      return {}
    }
  })
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.agent.listFeedback(5_000).then((result) => {
      if (cancelled || !result.success || !Array.isArray(result.feedback)) return
      const persisted = Object.fromEntries(result.feedback.map((item) => [item.messageId, {
        rating: item.rating,
        reason: item.reason,
        at: item.at,
      } satisfies AgentMessageFeedback]))
      setMessageFeedback(persisted)
      window.localStorage.setItem('weflow.agent.messageFeedback', JSON.stringify(persisted))
    }).catch(() => {
      // 如果持久化暂时不可用，localStorage 仍作为即时回退方案。
    })
    return () => { cancelled = true }
  }, [])
  const [emptyCopyIndex, setEmptyCopyIndex] = useState(
    () => initialEmptyCopyIndex(emptyCopyKeyForMention(routedMention)),
  )
  const promptControllerRef = useRef<PromptInputControllerProps | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionPastePendingRef = useRef(false)
  const mentionPasteSequenceRef = useRef(false)
  const lastMentionSuggestionQueryRef = useRef<string | null>(null)
  const scopeRef = useRef<AgentScope>(scopeForMentions(mentions))
  const messagesRef = useRef<UIMessage[]>([])
  const routedMentionKeyRef = useRef(routedMention?.username || '')
  const pendingTitleIdsRef = useRef(new Set<number>())
  const titleRequestsInFlightRef = useRef(new Set<number>())
  const titleAttemptCountsRef = useRef(new Map<number, number>())
  const titleRetryTimersRef = useRef(new Map<number, number>())
  const pendingTitleTextsRef = useRef(new Map<number, string>())
  const verifiedGeneratedTitleIdsRef = useRef(new Set<number>())
  const requestConversationTitleRef = useRef<(
    targetId: number,
    firstUserText: string,
  ) => void>(() => {})
  const deletingConversationIdsRef = useRef(new Set<number>())
  const activeRef = useRef(active)
  activeRef.current = active
  const selectionVersionRef = useRef(0)
  const mentionRequestVersionRef = useRef(0)
  const mentionLoadedQueriesRef = useRef(new Set<string>())
  const modelProvidersRef = useRef(modelProviders)
  const modelCatalogRequestRef = useRef<Promise<void> | null>(null)
  const modelConfigurationRequestRef = useRef(0)
  const verifiedModelMetadataRef = useRef(new Map<string, AIModelMetadataResolution>())
  const selectedRuntimeRef = useRef<AgentConversationRuntime | null>(null)
  const allRuntimesRef = useRef(new Set<AgentConversationRuntime>())
  const runtimesByConversationIdRef = useRef(new Map<number, AgentConversationRuntime>())
  const persistRuntimeRef = useRef<(runtime: AgentConversationRuntime, messages?: UIMessage[]) => Promise<boolean>>(async () => false)
  modelProvidersRef.current = modelProviders

  const createConversationRuntime = useCallback((input: {
    conversationId?: number | null
    conversationTitle?: string
    conversationTitleGenerated?: boolean
    messages?: UIMessage[]
    mentions?: MentionTarget[]
    scope?: AgentScope
    mode?: AgentMode
    modelConfig?: AgentModelConfig | null
    resumeAvailable?: boolean
    resumeRunId?: string | null
  } = {}): AgentConversationRuntime => {
    const runtimeMentions = input.mentions || []
    const runtimeMessages = input.messages || []
    const runtime: AgentConversationRuntime = {
      key: `agent-runtime-${++agentRuntimeSequence}`,
      chat: null as unknown as Chat<UIMessage>,
      transport: null as unknown as IpcChatTransport<UIMessage>,
      conversationId: input.conversationId ?? null,
      conversationTitle: input.conversationTitle || '新对话',
      conversationTitleGenerated: Boolean(input.conversationTitleGenerated),
      mentions: runtimeMentions,
      scope: input.scope || scopeForMentions(runtimeMentions),
      mode: input.mode || 'standard',
      modelConfig: input.modelConfig || null,
      progress: [],
      toolStartedAtByKey: {},
      notice: input.resumeAvailable || input.resumeRunId ? AGENT_RESUME_NOTICE : '',
      draft: '',
      queuedMessage: null,
      resumeAvailable: Boolean(input.resumeAvailable || input.resumeRunId),
      stopRequested: false,
      executionElapsedBeforeMs: readLatestStoppedAgentExecutionElapsed(runtimeMessages),
      executionSegmentStartedAt: null,
      voiceModelDownloadRequired: false,
      activePlanStartIndex: null,
      saveTimer: null,
      transportRetryTimer: null,
      transportRetryAttempt: 0,
      dispose: () => {},
    }

    const transport = new IpcChatTransport<UIMessage>(
      () => runtime.scope,
      () => runtime.modelConfig || modelConfigRef.current,
      () => runtime.conversationId,
      () => runtime.mode,
      (event) => {
        if ((event.depth ?? 0) === 0 && event.stage === 'run_started' && runtime.executionSegmentStartedAt === null) {
          runtime.executionSegmentStartedAt = Number.isFinite(event.at) ? event.at : Date.now()
        }
        if ((event.depth ?? 0) === 0 && event.stage === 'run_started') {
          runtime.toolStartedAtByKey = {}
        }
        if (
          event.toolName
          && Number.isFinite(event.at)
          && (event.stage === 'tool_started' || event.stage === 'searching')
        ) {
          runtime.toolStartedAtByKey = {
            ...runtime.toolStartedAtByKey,
            [toolProgressKey(event.toolName, event.toolCallId)]: event.at,
            // 某些兼容供应商不会把进度事件与工具 part 的 call id 原样关联；
            // 同时保留名称键作为回退，确保当前运行工具仍有稳定计时起点。
            [toolProgressKey(event.toolName)]: event.at,
          }
        }
        if (
          event.toolName
          && Number.isFinite(event.at)
          && (event.stage === 'tool_finished' || event.stage === 'error')
        ) {
          const nextToolStartedAtByKey = { ...runtime.toolStartedAtByKey }
          delete nextToolStartedAtByKey[toolProgressKey(event.toolName, event.toolCallId)]
          // 名称键只服务于确实没有 call id 的兼容流。工具一结束就清掉，不能让下一次
          // 同名调用沿用旧起点，把十秒工具显示成数百秒。
          delete nextToolStartedAtByKey[toolProgressKey(event.toolName)]
          runtime.toolStartedAtByKey = nextToolStartedAtByKey
        }
        runtime.progress = event.stage === 'run_finished'
          ? []
          : [...runtime.progress.filter((item) => item.stage !== 'run_finished'), event].slice(-12)
        if (selectedRuntimeRef.current === runtime) setProgress(runtime.progress)
      },
      () => runtime.chat?.messages || [],
    )
    transport.setResumeCandidate(input.resumeRunId)
    runtime.transport = transport

    runtime.chat = new Chat<UIMessage>({
      id: runtime.key,
      messages: runtimeMessages,
      transport,
      sendAutomaticallyWhen: ({ messages: nextMessages }) => lastAssistantMessageIsCompleteWithApprovalResponses({ messages: nextMessages }),
      onError: (error) => {
        runtime.resumeAvailable = true
        if (isAgentVoiceModelRequiredError(error)) {
          runtime.voiceModelDownloadRequired = true
          runtime.notice = '需要先下载约 245 MB 的 SenseVoiceSmall 本地模型，下载完成后会从当前检查点继续回答。'
          if (selectedRuntimeRef.current === runtime) {
            setNotice(runtime.notice)
            setVoiceModelDownloadRuntime(runtime)
          }
          return
        }
        if (isRetryableAgentRunError(error)) {
          runtime.notice = ''
          runtime.transportRetryAttempt += 1
          const delayMs = Math.min(15_000, 1_500 * (2 ** Math.min(4, runtime.transportRetryAttempt - 1)))
          const retryProgress: AgentProgressEvent = {
            at: Date.now(),
            stage: 'reasoning',
            title: '模型连接中断，正在等待恢复',
            detail: `${Math.ceil(delayMs / 1000)} 秒后自动继续已完成的步骤`,
            category: 'system',
            visible: true,
          }
          runtime.progress = [...runtime.progress, retryProgress].slice(-12)
          if (selectedRuntimeRef.current === runtime) {
            setNotice('')
            setProgress(runtime.progress)
          }
          if (runtime.transportRetryTimer !== null) window.clearTimeout(runtime.transportRetryTimer)
          runtime.transportRetryTimer = window.setTimeout(() => {
            runtime.transportRetryTimer = null
            const preservedMessages = [...runtime.chat.messages]
            void (async () => {
              await persistRuntimeRef.current(runtime, preservedMessages)
              await runtime.chat.resumeStream()
            })().catch((retryError) => {
              runtime.chat.messages = preservedMessages
              void persistRuntimeRef.current(runtime, preservedMessages)
              if (!isRetryableAgentRunError(retryError)) {
                runtime.notice = agentRunErrorNotice(retryError)
                if (selectedRuntimeRef.current === runtime) setNotice(runtime.notice)
              }
            })
          }, delayMs)
          return
        }
        runtime.notice = agentRunErrorNotice(error)
        if (selectedRuntimeRef.current === runtime) setNotice(runtime.notice)
      },
      onFinish: ({ messages: finishedMessages, isAbort, isError }) => {
        const stopped = isAbort || runtime.stopRequested
        const finishedAt = Date.now()
        let persistedMessages = stopped
          ? markUnfinishedAgentToolsNotRun(finishedMessages)
          : finishedMessages
        if (stopped) {
          persistedMessages = markAgentExecutionStopped(persistedMessages, {
            stoppedAt: finishedAt,
            segmentStartedAt: runtime.executionSegmentStartedAt,
            elapsedBeforeMs: runtime.executionElapsedBeforeMs,
          })
          runtime.executionElapsedBeforeMs = readLatestStoppedAgentExecutionElapsed(persistedMessages)
          runtime.executionSegmentStartedAt = null
        } else if (!isError) {
          persistedMessages = markAgentExecutionCompleted(persistedMessages, {
            finishedAt,
            segmentStartedAt: runtime.executionSegmentStartedAt,
            elapsedBeforeMs: runtime.executionElapsedBeforeMs,
          })
          runtime.executionElapsedBeforeMs = 0
          runtime.executionSegmentStartedAt = null
        }
        if (persistedMessages !== finishedMessages) runtime.chat.messages = persistedMessages
        runtime.stopRequested = false
        if (runtime.saveTimer !== null) {
          window.clearTimeout(runtime.saveTimer)
          runtime.saveTimer = null
        }
        void persistRuntimeRef.current(runtime, persistedMessages)
        if (!isError || runtime.transportRetryTimer === null) {
          runtime.progress = []
          if (selectedRuntimeRef.current === runtime) setProgress([])
        }
        if (stopped) {
          runtime.resumeAvailable = true
          runtime.notice = AGENT_RESUME_NOTICE
          if (selectedRuntimeRef.current === runtime) {
            setNotice(runtime.notice)
            setRuntimeStateRevision((current) => current + 1)
          }
        } else if (!isError) {
          runtime.resumeAvailable = false
          runtime.voiceModelDownloadRequired = false
          runtime.transportRetryAttempt = 0
          if (runtime.transportRetryTimer !== null) {
            window.clearTimeout(runtime.transportRetryTimer)
            runtime.transportRetryTimer = null
          }
        }
        if (!stopped && !isError && (!activeRef.current || selectedRuntimeRef.current !== runtime)) {
          window.electronAPI.notification?.show({
            title: 'AI 聊天已完成',
            content: runtime.conversationTitle && runtime.conversationTitle !== '新对话'
              ? `“${runtime.conversationTitle}”已经回答完成`
              : '你的问题已经回答完成',
            avatarUrl: './logo.png',
            sessionId: 'weflow-agent',
            channel: 'agent',
            targetRoute: '/ai',
          })
        }
      },
    })

    const unsubscribeMessages = runtime.chat['~registerMessagesCallback'](() => {
      if (!runtime.conversationId || runtime.chat.messages.length === 0) return
      // 高频流式回调不能不断重置计时器，否则持续输出时持久化会被无限推迟。
      // 保留最先安排的保存：前台运行中每 5 秒、后台每 12 秒写一次，
      // 运行停止后则在 200 毫秒内尽快落盘。
      const running = runtime.chat.status === 'submitted' || runtime.chat.status === 'streaming'
      const foreground = activeRef.current && selectedRuntimeRef.current === runtime
      runtime.saveTimer = scheduleAgentConversationPersist({
        currentTimer: runtime.saveTimer,
        delayMs: running ? (foreground ? 5000 : 12000) : 200,
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        onDue: () => {
          runtime.saveTimer = null
          void persistRuntimeRef.current(runtime)
        },
      })
    }, 50)
    runtime.dispose = () => {
      unsubscribeMessages()
      if (runtime.saveTimer !== null) window.clearTimeout(runtime.saveTimer)
      if (runtime.transportRetryTimer !== null) window.clearTimeout(runtime.transportRetryTimer)
      runtime.saveTimer = null
      runtime.transportRetryTimer = null
      allRuntimesRef.current.delete(runtime)
    }
    allRuntimesRef.current.add(runtime)
    return runtime
  }, [])

  const [selectedRuntime, setSelectedRuntime] = useState<AgentConversationRuntime>(() => {
    const runtimeMentions = routedMention ? [routedMention] : initialRuntimeSnapshot?.mentions || []
    const runtime = createConversationRuntime({
      conversationId: routedMention ? null : initialRuntimeSnapshot?.conversationId ?? null,
      conversationTitle: routedMention ? '新对话' : initialRuntimeSnapshot?.conversationTitle || '新对话',
      conversationTitleGenerated: routedMention ? false : Boolean(initialRuntimeSnapshot?.conversationTitleGenerated),
      messages: routedMention ? [] : initialRuntimeSnapshot?.messages || [],
      mentions: runtimeMentions,
      scope: scopeForMentions(runtimeMentions),
      mode: routedMention ? 'standard' : initialRuntimeSnapshot?.mode || 'standard',
      resumeAvailable: routedMention ? false : Boolean(initialRuntimeSnapshot?.resumeAvailable),
    })
    selectedRuntimeRef.current = runtime
    if (runtime.conversationId) runtimesByConversationIdRef.current.set(runtime.conversationId, runtime)
    return runtime
  })
  selectedRuntimeRef.current = selectedRuntime
  const modelInfoByKey = useMemo(() => {
    const result = new Map<string, AIModelInfo>()
    for (const provider of modelProviders) {
      for (const model of provider.modelDetails || []) {
        result.set(`${provider.id}::${model.id}`, model)
        if (!result.has(model.id)) result.set(model.id, model)
      }
    }
    return result
  }, [modelProviders])

  const reloadModelConfiguration = useCallback(async () => {
    const requestVersion = ++modelConfigurationRequestRef.current
    setModelLoading(true)
    try {
      const [provider, profiles, activeId] = await Promise.all([
        configService.getAiProvider(),
        configService.getAiConfigPresets(),
        configService.getActiveAiConfigPresetId(),
      ])
      const activeProfile = profiles.find((profile) => profile.id === activeId) || profiles[0]
      if (requestVersion !== modelConfigurationRequestRef.current) return
      setModelProfiles(profiles)
      setActiveModelProfileId(activeProfile?.id || '')
      if (!activeProfile) {
        setModelConfig(null)
        return
      }
      const metadataKey = agentModelMetadataKey(activeProfile, provider)
      const cachedMetadata = verifiedModelMetadataRef.current.get(metadataKey)
      setModelConfig(buildAgentModelConfiguration(activeProfile, provider, modelProvidersRef.current, cachedMetadata))
      if (cachedMetadata) return

      try {
        const metadata = await window.electronAPI.ai.resolveModelMetadata({
          provider: activeProfile.provider || provider,
          model: activeProfile.model,
          baseURL: activeProfile.baseURL,
        })
        if (requestVersion !== modelConfigurationRequestRef.current) return
        // checkedAt 有值表示完整目录当时可用，并且已经明确检查过该模型，其中也包括
        // “没有精确记录”的结果。目录加载的临时故障仍可重试。
        if (metadata.checkedAt) verifiedModelMetadataRef.current.set(metadataKey, metadata)
        setModelConfig(buildAgentModelConfiguration(
          activeProfile,
          provider,
          modelProvidersRef.current,
          metadata.success ? metadata : cachedMetadata,
        ))
      } catch {
        // 模型目录解析失败时保留前面已按配置、目录和缓存构建的保守值；
        // 元数据校验是增强步骤，不能让模型选择整体失效。
      }
    } finally {
      if (requestVersion === modelConfigurationRequestRef.current) setModelLoading(false)
    }
  }, [])

  const loadModelCatalog = useCallback(async () => {
    if (modelProvidersRef.current.length > 0) return
    if (modelCatalogRequestRef.current) return modelCatalogRequestRef.current
    const request = (async () => {
      setModelCatalogLoading(true)
      try {
        const providers = await getAIProviders()
        modelProvidersRef.current = providers
        setModelProviders(providers)
      } finally {
        setModelCatalogLoading(false)
        modelCatalogRequestRef.current = null
      }
    })()
    modelCatalogRequestRef.current = request
    return request
  }, [])

  useEffect(() => {
    if (modelProviders.length === 0 || modelProfiles.length === 0) return
    const activeProfile = modelProfiles.find((profile) => profile.id === activeModelProfileId) || modelProfiles[0]
    const fallbackProvider = activeProfile?.provider || 'custom'
    const metadata = activeProfile
      ? verifiedModelMetadataRef.current.get(agentModelMetadataKey(activeProfile, fallbackProvider))
      : undefined
    setModelConfig(buildAgentModelConfiguration(activeProfile, fallbackProvider, modelProviders, metadata))
  }, [activeModelProfileId, modelProfiles, modelProviders])

  useEffect(() => {
    if (!active) return
    void reloadModelConfiguration()
  }, [active, reloadModelConfiguration])

  useEffect(() => {
    let refreshTimer: number | null = null
    const handleChange = (key: string) => {
      if (key === configService.CONFIG_KEYS.AI_MODEL_PROFILES_JSON
        || key === configService.CONFIG_KEYS.ACTIVE_AI_MODEL_PROFILE_ID) {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null
          void reloadModelConfiguration()
        }, 40)
      }
    }
    const handleLocalChange = (event: Event) => {
      handleChange(String((event as CustomEvent<{ key?: string }>).detail?.key || ''))
    }
    window.addEventListener('weflow:config-changed', handleLocalChange)
    const subscribe = window.electronAPI.config.onChanged
    const unsubscribe = typeof subscribe === 'function'
      ? subscribe(({ key }) => handleChange(key))
      : undefined
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      window.removeEventListener('weflow:config-changed', handleLocalChange)
      unsubscribe?.()
    }
  }, [reloadModelConfiguration])

  const refreshRecords = useCallback(async () => {
    const result = await window.electronAPI.agent.listConversations()
    if (!result.success || !Array.isArray(result.conversations)) return []
    const next = result.conversations.map(normalizeConversationRecord).filter((item): item is AgentConversationRecord => Boolean(item))
    setRecords(next)
    return next
  }, [])
  persistRuntimeRef.current = async (runtime, runtimeMessages = runtime.chat.messages) => {
    const targetId = runtime.conversationId
    if (!targetId || runtimeMessages.length === 0 || deletingConversationIdsRef.current.has(targetId)) return false
    try {
      const result = await window.electronAPI.agent.saveConversationMessages({
        id: targetId,
        messages: runtimeMessages,
        scope: runtime.scope,
        modelProvider: runtime.modelConfig?.provider || 'weflow',
        modelId: runtime.modelConfig?.model || '',
      })
      if (result.success) return true
      runtime.notice = result.error || '对话保存失败，请勿关闭应用并重试。'
    } catch (error) {
      runtime.notice = error instanceof Error ? `对话保存失败：${error.message}` : '对话保存失败，请勿关闭应用并重试。'
    }
    if (selectedRuntimeRef.current === runtime) setNotice(runtime.notice)
    return false
  }

  const loadMentionTargets = useCallback(async (query: string) => {
    const normalizedQuery = query.trim().toLowerCase()
    const cachedTargets = readCachedAgentMentionDirectoryTargets()
    if (!normalizedQuery && cachedTargets.length > 0) {
      mentionRequestVersionRef.current += 1
      setMentionLoading(false)
      setSessions(cachedTargets)
      return
    }
    if (mentionLoadedQueriesRef.current.has(normalizedQuery)) return

    const requestVersion = ++mentionRequestVersionRef.current
    setMentionLoading(true)
    try {
      const sessionResult = await window.electronAPI.chat.getMentionTargets(0, MENTION_LOOKUP_LIMIT, normalizedQuery)
      if (requestVersion !== mentionRequestVersionRef.current) return
      const fetchedTargets = sessionResult.success && Array.isArray(sessionResult.sessions)
        ? sessionResult.sessions.map((item) => toMentionTarget(item.username, item.displayName, item.avatarUrl))
        : []
      mentionLoadedQueriesRef.current.add(normalizedQuery)
      if (!normalizedQuery) writeCachedAgentMentionDirectoryTargets(fetchedTargets)
      setSessions((current) => {
        const next = mergeMentionTargetLists(current, fetchedTargets)
        return next
      })

      const avatarTargets = fetchedTargets
        .filter((target) => !target.avatarUrl)
        .slice(0, MENTION_AVATAR_VISIBLE_LIMIT)
      if (avatarTargets.length === 0) return
      const enriched = await window.electronAPI.chat.enrichSessionsContactInfo(
        avatarTargets.map((target) => target.username),
        { onlyMissingAvatar: true },
      )
      if (requestVersion !== mentionRequestVersionRef.current || !enriched.success || !enriched.contacts) return
      const details = new Map<string, MentionTarget>()
      for (const [username, detail] of Object.entries(enriched.contacts)) {
        details.set(username, toMentionTarget(username, detail.displayName, detail.avatarUrl))
      }
      if (!normalizedQuery) {
        writeCachedAgentMentionDirectoryTargets(fetchedTargets.map((target) => {
          const detail = details.get(target.username)
          return detail ? mergeMentionTarget(target, detail) : target
        }))
      }
      setSessions((current) => {
        const next = current.map((target) => {
          const detail = details.get(target.username)
          return detail ? mergeMentionTarget(target, detail) : target
        })
        return next
      })
      setMentions((current) => {
        let changed = false
        const next = current.map((target) => {
          const detail = details.get(target.username)
          if (!detail) return target
          const merged = mergeMentionTarget(target, detail)
          if (merged !== target) changed = true
          return merged
        })
        if (changed) scopeRef.current = scopeForMentions(next)
        return changed ? next : current
      })
    } catch (error) {
      if (requestVersion === mentionRequestVersionRef.current) console.error('加载 Agent 提及对象失败:', error)
    } finally {
      if (requestVersion === mentionRequestVersionRef.current) setMentionLoading(false)
    }
  }, [])
  const mentionTargetsById = useMemo(
    () => new Map(sessions.map((target) => [target.username, target])),
    [sessions],
  )
  const mentionTargetsByIdRef = useRef(mentionTargetsById)
  mentionTargetsByIdRef.current = mentionTargetsById
  const mentionTargetOf = useCallback((username: string, displayName?: string) => {
    const target = mentionTargetsById.get(username)
    if (!target) return toMentionTarget(username, displayName)
    return displayName ? { ...target, displayName } : target
  }, [mentionTargetsById])
  const mentionTypeaheadTargets = useMemo(
    () => activeMentionQuery ? filterMentionTargets(sessions, activeMentionQuery.query) : [],
    [activeMentionQuery, sessions],
  )
  const dismissMentionTypeahead = useCallback(() => {
    mentionPastePendingRef.current = false
    mentionPasteSequenceRef.current = false
    setActiveMentionQuery(null)
    setMentionSuggestionIndex(0)
  }, [])
  const activateMentionQuery = useCallback((query: MentionInputQuery | null, highlight = false) => {
    if (!query) lastMentionSuggestionQueryRef.current = null
    setActiveMentionQuery(query)
    setMentionSuggestionIndex(0)
    if (!query || !highlight) return
    window.requestAnimationFrame(() => {
      promptTextareaRef.current?.focus()
      promptTextareaRef.current?.setSelectionRange(query.start, query.end)
    })
  }, [])
  const insertMentionAtCursor = useCallback((target: MentionTarget, replaceRange?: MentionInputQuery | null) => {
    const alreadySelected = mentions.some((item) => item.username === target.username)
    if (!alreadySelected && mentions.length >= 4) {
      setNotice('一次最多比较 4 个联系人或群。')
      dismissMentionTypeahead()
      return
    }
    const nextMentions = alreadySelected ? mentions : [...mentions, target]
    if (!alreadySelected) setMentions(nextMentions)

    const controller = promptControllerRef.current
    const textarea = promptTextareaRef.current
    const currentText = controller?.textInput.value || ''
    const activeRange = replaceRange || null
    const originalSelectionStart = textarea?.selectionStart ?? currentText.length
    const originalSelectionEnd = textarea?.selectionEnd ?? originalSelectionStart
    const selectionStart = activeRange?.start ?? originalSelectionStart
    let selectionEnd = activeRange?.end ?? originalSelectionEnd
    if (
      activeRange
      && mentionPasteSequenceRef.current
      && currentText.startsWith(target.displayName, selectionStart + 1)
    ) {
      selectionEnd = Math.max(selectionEnd, selectionStart + 1 + target.displayName.length)
    }
    const before = currentText.slice(0, selectionStart)
    const after = currentText.slice(selectionEnd)
    const leadingSpace = before && !/\s$/u.test(before) ? ' ' : ''
    const trailingSpace = !/^\s/u.test(after) ? ' ' : ''
    const token = `${leadingSpace}@${target.displayName}${trailingSpace}`
    const nextText = `${before}${token}${after}`
    const replacementDelta = token.length - (selectionEnd - selectionStart)
    const caret = activeRange && !mentionPasteSequenceRef.current && originalSelectionStart > selectionEnd
      ? originalSelectionStart + replacementDelta
      : selectionStart + token.length
    const nextQuery = mentionPasteSequenceRef.current
      ? findNextUnresolvedMentionQuery(nextText, nextMentions, sessions, caret)
      : null
    controller?.textInput.setInput(nextText)
    if (nextQuery) {
      const lookupQuery = mentionLookupQuery(nextQuery.query)
      lastMentionSuggestionQueryRef.current = lookupQuery
      void loadMentionTargets(lookupQuery)
      activateMentionQuery(nextQuery, true)
      return
    }
    mentionPasteSequenceRef.current = false
    setActiveMentionQuery(null)
    setMentionSuggestionIndex(0)
    window.requestAnimationFrame(() => {
      promptTextareaRef.current?.focus()
      promptTextareaRef.current?.setSelectionRange(caret, caret)
    })
  }, [activateMentionQuery, dismissMentionTypeahead, loadMentionTargets, mentions, sessions])
  const handlePromptPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    mentionPastePendingRef.current = Boolean(event.clipboardData.getData('text/plain'))
  }, [])
  const handlePromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const inputType = (event.nativeEvent as InputEvent).inputType || ''
    const pasted = mentionPastePendingRef.current || inputType === 'insertFromPaste' || inputType === 'insertFromDrop'
    mentionPastePendingRef.current = false
    if (pasted) {
      const nextQuery = findNextUnresolvedMentionQuery(event.currentTarget.value, mentions, sessions)
      if (nextQuery) {
        const lookupQuery = mentionLookupQuery(nextQuery.query)
        lastMentionSuggestionQueryRef.current = lookupQuery
        void loadMentionTargets(lookupQuery)
      }
      mentionPasteSequenceRef.current = Boolean(nextQuery)
      activateMentionQuery(nextQuery, Boolean(nextQuery))
      return
    }
    mentionPasteSequenceRef.current = false
    const liveQuery = findActiveMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)
    if (liveQuery) {
      const lookupQuery = mentionLookupQuery(liveQuery.query)
      if (lastMentionSuggestionQueryRef.current !== lookupQuery) {
        lastMentionSuggestionQueryRef.current = lookupQuery
        void loadMentionTargets(lookupQuery)
      }
    }
    const knownQuery = findNextUnresolvedMentionQuery(
      event.currentTarget.value,
      mentions,
      sessions,
      liveQuery?.start || 0,
      true,
    )
    activateMentionQuery(knownQuery?.start === liveQuery?.start || !liveQuery ? knownQuery || liveQuery : liveQuery)
  }, [activateMentionQuery, loadMentionTargets, mentions, sessions])
  useEffect(() => {
    const currentText = promptControllerRef.current?.textInput.value || ''
    if (!currentText.includes('@')) return
    const rescanned = findNextUnresolvedMentionQuery(
      currentText,
      mentions,
      sessions,
      mentionPasteSequenceRef.current ? activeMentionQuery?.start || 0 : 0,
      !mentionPasteSequenceRef.current,
    )
    if (
      !rescanned
      || (
        activeMentionQuery
        && rescanned.start === activeMentionQuery.start
        && rescanned.end === activeMentionQuery.end
        && rescanned.query === activeMentionQuery.query
      )
    ) return
    activateMentionQuery(rescanned, mentionPasteSequenceRef.current)
  }, [activateMentionQuery, activeMentionQuery, mentions, sessions])
  const handlePromptKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!activeMentionQuery) return
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissMentionTypeahead()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (mentionTypeaheadTargets.length === 0) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setMentionSuggestionIndex((current) => (
        (current + direction + mentionTypeaheadTargets.length) % mentionTypeaheadTargets.length
      ))
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && mentionTypeaheadTargets.length > 0) {
      event.preventDefault()
      const target = mentionTypeaheadTargets[Math.min(mentionSuggestionIndex, mentionTypeaheadTargets.length - 1)]
      if (target) insertMentionAtCursor(target, activeMentionQuery)
    }
  }, [activeMentionQuery, dismissMentionTypeahead, insertMentionAtCursor, mentionSuggestionIndex, mentionTypeaheadTargets])
  const sessionNameOf = useCallback(
    (id: string) => mentionTargetsById.get(id)?.displayName || id,
    [mentionTargetsById],
  )

  const {
    messages,
    sendMessage,
    regenerate,
    status,
    addToolApprovalResponse,
    clearError,
  } = useChat({
    chat: selectedRuntime.chat,
    experimental_throttle: 50,
  })
  messagesRef.current = messages
  const resolvingToolSessionIdsRef = useRef(new Set<string>())
  const toolSessionIds = useMemo(
    () => collectToolSessionIds(messages.map((message) => message.parts)),
    [messages],
  )
  useEffect(() => {
    const unresolved = Array.from(toolSessionIds)
      .filter((sessionId) => !mentionTargetsById.has(sessionId) && !resolvingToolSessionIdsRef.current.has(sessionId))
      .slice(0, 24)
    if (unresolved.length === 0) return
    let cancelled = false
    unresolved.forEach((sessionId) => resolvingToolSessionIdsRef.current.add(sessionId))
    void Promise.all(unresolved.map(async (sessionId) => {
      try {
        const result = await window.electronAPI.chat.getMentionTargets(0, 2, sessionId)
        if (!result.success || !Array.isArray(result.sessions)) return null
        const exact = result.sessions.find((item) => item.username === sessionId)
        return exact ? toMentionTarget(exact.username, exact.displayName, exact.avatarUrl) : null
      } catch {
        return null
      }
    })).then((resolved) => {
      unresolved.forEach((sessionId) => resolvingToolSessionIdsRef.current.delete(sessionId))
      if (cancelled) return
      const targets = resolved.filter((target): target is MentionTarget => Boolean(target))
      if (targets.length === 0) return
      setSessions((current) => {
        const next = mergeMentionTargetLists(current, targets)
        return next
      })
    })
    return () => { cancelled = true }
  }, [mentionTargetsById, toolSessionIds])

  const selectConversationRuntime = useCallback((runtime: AgentConversationRuntime, closeRecords = true) => {
    selectionVersionRef.current += 1
    const previousRuntime = selectedRuntimeRef.current
    if (previousRuntime && previousRuntime !== runtime) {
      previousRuntime.draft = promptControllerRef.current?.textInput.value || ''
    }
    if (
      previousRuntime
      && previousRuntime !== runtime
      && !previousRuntime.conversationId
      && previousRuntime.chat.status === 'ready'
      && previousRuntime.chat.messages.length === 0
    ) {
      previousRuntime.dispose()
    }
    selectedRuntimeRef.current = runtime
    setSelectedRuntime(runtime)
    conversationIdRef.current = runtime.conversationId
    setConversationId(runtime.conversationId)
    setConversationTitle(runtime.conversationTitle)
    setConversationTitleGenerated(runtime.conversationTitleGenerated)
    setMentions(runtime.mentions)
    mentionPastePendingRef.current = false
    mentionPasteSequenceRef.current = false
    setActiveMentionQuery(null)
    setMentionSuggestionIndex(0)
    setQueuedMessage(runtime.queuedMessage)
    scopeRef.current = runtime.scope
    agentModeRef.current = runtime.mode
    setAgentMode(runtime.mode)
    setProgress(runtime.progress)
    setNotice(runtime.notice)
    setVoiceModelDownloadRuntime(runtime.voiceModelDownloadRequired ? runtime : null)
    if (closeRecords) setRecordsOpen(false)
    storeActiveAgentConversation(runtime.conversationId)
    window.requestAnimationFrame(() => {
      promptControllerRef.current?.textInput.setInput(runtime.draft)
    })
  }, [])

  useEffect(() => {
    const runtime = selectedRuntimeRef.current
    if (!runtime) return
    runtime.mentions = mentions
    runtime.scope = scopeForMentions(mentions)
    scopeRef.current = runtime.scope
  }, [mentions, selectedRuntime])

  useEffect(() => {
    selectedRuntime.mode = agentMode
  }, [agentMode, selectedRuntime])

  useEffect(() => {
    selectedRuntime.conversationTitle = conversationTitle
    selectedRuntime.conversationTitleGenerated = conversationTitleGenerated
  }, [conversationTitle, conversationTitleGenerated, selectedRuntime])

  useEffect(() => {
    selectedRuntime.notice = notice
    selectedRuntime.progress = progress
  }, [notice, progress, selectedRuntime])

  useEffect(() => {
    selectedRuntime.queuedMessage = queuedMessage
  }, [queuedMessage, selectedRuntime])

  useEffect(() => {
    const nextRouteKey = routedMention?.username || ''
    if (routedMentionKeyRef.current === nextRouteKey) return
    routedMentionKeyRef.current = nextRouteKey
    const runtimeMentions = routedMention ? [routedMention] : []
    const runtime = createConversationRuntime({ mentions: runtimeMentions })
    setEmptyCopyIndex((current) => nextEmptyCopyIndex(current, emptyCopyKeyForMention(routedMention)))
    selectConversationRuntime(runtime)
  }, [createConversationRuntime, routedMention, selectConversationRuntime])

  const selectedResumeAvailable = selectedRuntime.resumeAvailable
  useEffect(() => {
    agentRuntimeSnapshot = {
      messages,
      conversationId,
      conversationTitle,
      conversationTitleGenerated,
      mentions,
      scope: scopeRef.current,
      mode: agentMode,
      resumeAvailable: selectedResumeAvailable,
    }
  }, [agentMode, conversationId, conversationTitle, conversationTitleGenerated, mentions, messages, selectedResumeAvailable])
  const busy = status === 'submitted' || status === 'streaming'
  const stopping = selectedRuntime.stopRequested
  const displayBusy = busy && !stopping
  const displayStatus: ChatStatus = stopping ? 'ready' : status as ChatStatus
  const requestRuntimeStop = useCallback((runtime: AgentConversationRuntime) => {
    if (runtime.stopRequested) return
    runtime.stopRequested = true
    runtime.resumeAvailable = true
    runtime.notice = AGENT_RESUME_NOTICE
    runtime.progress = []
    if (runtime.transportRetryTimer !== null) {
      window.clearTimeout(runtime.transportRetryTimer)
      runtime.transportRetryTimer = null
    }
    const stoppedAt = Date.now()
    const stoppedMessages = markAgentExecutionStopped(
      markUnfinishedAgentToolsNotRun([...runtime.chat.messages]),
      {
        stoppedAt,
        segmentStartedAt: runtime.executionSegmentStartedAt,
        elapsedBeforeMs: runtime.executionElapsedBeforeMs,
      },
    )
    runtime.executionElapsedBeforeMs = readLatestStoppedAgentExecutionElapsed(stoppedMessages)
    runtime.executionSegmentStartedAt = null
    if (stoppedMessages !== runtime.chat.messages) runtime.chat.messages = stoppedMessages
    void persistRuntimeRef.current(runtime, stoppedMessages)
    if (selectedRuntimeRef.current === runtime) {
      setNotice(runtime.notice)
      setProgress([])
      setResponsePendingVisible(false)
      setResponsePendingLeaving(false)
      setRuntimeStateRevision((current) => current + 1)
    }
    // SDK abort 与 transport 硬停止双保险：前者维护 Chat 状态，后者立即关闭本地流并终止 Worker。
    void runtime.chat.stop().catch(() => {})
    runtime.transport.stopImmediately()
  }, [])
  const isEmptyConversation = messages.length === 0
  const agentPageRef = useRef<HTMLDivElement | null>(null)
  const composerTrackRef = useRef<HTMLDivElement | null>(null)
  const composerTransitionOriginRef = useRef<DOMRect | null>(null)
  const composerTrackAnimationRef = useRef<Animation | null>(null)
  const previousEmptyConversationRef = useRef(isEmptyConversation)

  useEffect(() => {
    if (!active) return
    const updateSelectionState = () => {
      const page = agentPageRef.current
      const selection = window.getSelection()
      if (!page || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        page?.classList.remove('has-active-selection')
        return
      }
      const range = selection.getRangeAt(0)
      const commonAncestor = range.commonAncestorContainer
      const selectionNode = commonAncestor.nodeType === Node.ELEMENT_NODE
        ? commonAncestor
        : commonAncestor.parentElement
      page.classList.toggle('has-active-selection', Boolean(selectionNode && page.contains(selectionNode)))
    }
    document.addEventListener('selectionchange', updateSelectionState)
    return () => {
      document.removeEventListener('selectionchange', updateSelectionState)
      agentPageRef.current?.classList.remove('has-active-selection')
    }
  }, [active])

  useLayoutEffect(() => {
    const wasEmpty = previousEmptyConversationRef.current
    previousEmptyConversationRef.current = isEmptyConversation
    if (!wasEmpty || isEmptyConversation) {
      if (isEmptyConversation) composerTransitionOriginRef.current = null
      return
    }

    const node = composerTrackRef.current
    const origin = composerTransitionOriginRef.current
    composerTransitionOriginRef.current = null
    if (!node || !origin || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const target = node.getBoundingClientRect()
    const translateY = origin.top - target.top
    if (Math.abs(translateY) < 0.5) return

    composerTrackAnimationRef.current?.cancel()
    composerTrackAnimationRef.current = node.animate([
      { transform: `translate3d(0, ${translateY}px, 0)` },
      { transform: 'translate3d(0, 0, 0)' },
    ], {
      duration: 560,
      easing: 'cubic-bezier(.22, 1, .36, 1)',
      fill: 'both',
    })
  }, [isEmptyConversation])

  useEffect(() => () => composerTrackAnimationRef.current?.cancel(), [])

  const loadConversation = useCallback(async (id: number) => {
    if (deletingConversationIdsRef.current.has(id)) return false
    const requestVersion = ++selectionVersionRef.current
    const existingRuntime = runtimesByConversationIdRef.current.get(id)
    if (existingRuntime) {
      if (existingRuntime.chat.messages.length === 0) {
        setRecordsOpen(false)
        setNotice('这条历史会话只有标题，正文没有成功保存，无法恢复。')
        return false
      }
      selectConversationRuntime(existingRuntime)
      return true
    }
    // 历史正文是点击后的唯一关键路径，不能被恢复状态查询拖住。
    // 未完成运行的检查会在正文已经切换后再从后台补上。
    const result = await window.electronAPI.agent.loadConversation(id)
    if (deletingConversationIdsRef.current.has(id)) return false
    if (selectionVersionRef.current !== requestVersion) return false
    const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
    if (!loaded) {
      setRecordsOpen(false)
      setNotice(result.error || '历史会话加载失败。')
      return false
    }
    if (loaded.messages.length === 0) {
      setRecordsOpen(false)
      setNotice('这条历史会话只有标题，正文没有成功保存，无法恢复。')
      return false
    }
    let restoredMentions: MentionTarget[] = []
    if (loaded.scope?.kind === 'session') {
      const storedTarget = toMentionTarget(loaded.scope.sessionId, loaded.scope.displayName, loaded.scope.avatarUrl)
      const knownTarget = mentionTargetsByIdRef.current.get(storedTarget.username)
      restoredMentions = [knownTarget ? mergeMentionTarget(storedTarget, knownTarget) : storedTarget]
    } else if (Array.isArray(loaded.scope?.filters?.targetSessions)) {
      restoredMentions = loaded.scope.filters.targetSessions.map((item) => {
        const storedTarget = toMentionTarget(item.sessionId, item.displayName)
        const knownTarget = mentionTargetsByIdRef.current.get(storedTarget.username)
        return knownTarget ? mergeMentionTarget(storedTarget, knownTarget) : storedTarget
      })
    }
    const runtime = createConversationRuntime({
      conversationId: loaded.id,
      conversationTitle: loaded.title,
      conversationTitleGenerated: Boolean(loaded.titleGeneratedAt),
      messages: loaded.messages,
      mentions: restoredMentions,
      scope: scopeForMentions(restoredMentions),
    })
    runtimesByConversationIdRef.current.set(loaded.id, runtime)
    selectConversationRuntime(runtime)

    // 先完成会话切换，再查询这一条会话的恢复点。该查询无论多慢都不会阻塞正文。
    void window.electronAPI.agent.getConversationRunState(loaded.id).then((runStatesResult) => {
      if (!runStatesResult?.success || !runStatesResult.run) return
      if (deletingConversationIdsRef.current.has(loaded.id)) return
      if (runtimesByConversationIdRef.current.get(loaded.id) !== runtime) return
      if (runtime.chat.status !== 'ready' || runtime.stopRequested) return

      const resumeCandidate = findLatestIncompleteAgentRunForConversation([runStatesResult.run], loaded.id)
      if (!resumeCandidate) return
      const latestUserMessage = [...runtime.chat.messages].reverse().find((message) => message.role === 'user')
      const latestUserQuestion = latestUserMessage?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim() || ''
      if (resumeCandidate.question && resumeCandidate.question.trim() !== latestUserQuestion) return

      if (readLatestStoppedAgentExecutionElapsed(runtime.chat.messages) <= 0) {
        const inferredStartedAt = resumeCandidate.startedAt
        const inferredStoppedAt = resumeCandidate.finishedAt || resumeCandidate.updatedAt
        if (
          typeof inferredStartedAt === 'number'
          && Number.isFinite(inferredStartedAt)
          && Number.isFinite(inferredStoppedAt)
          && inferredStoppedAt >= inferredStartedAt
        ) {
          const upgradedMessages = markAgentExecutionStopped(runtime.chat.messages, {
            stoppedAt: inferredStoppedAt,
            segmentStartedAt: inferredStartedAt,
            elapsedBeforeMs: 0,
          })
          runtime.chat.messages = upgradedMessages
          runtime.executionElapsedBeforeMs = readLatestStoppedAgentExecutionElapsed(upgradedMessages)
          void persistRuntimeRef.current(runtime, upgradedMessages)
        }
      }
      runtime.resumeAvailable = true
      runtime.transport.setResumeCandidate(resumeCandidate.runId)
      runtime.notice = AGENT_RESUME_NOTICE
      if (selectedRuntimeRef.current === runtime) {
        setNotice(runtime.notice)
        setRuntimeStateRevision((current) => current + 1)
      }
    }).catch(() => {
      // 恢复点是渐进增强；查询失败不影响已经打开的历史会话。
    })
    return true
  }, [createConversationRuntime, selectConversationRuntime])

  useEffect(() => {
    void refreshRecords()
    return window.electronAPI.agent.onConversationUpdated((event) => {
      // messages-replaced 是当前运行流式持久化产生的高频事件，消息状态已由运行时持有；
      // 仅在创建、重命名、删除或元数据变化时重新拉取记录列表。
      if (event.changeType !== 'messages-replaced') void refreshRecords()
    })
  }, [refreshRecords])

  useEffect(() => () => {
    for (const runtime of [...allRuntimesRef.current]) runtime.dispose()
    for (const timer of titleRetryTimersRef.current.values()) window.clearTimeout(timer)
    titleRetryTimersRef.current.clear()
  }, [])

  const newConversation = useCallback(() => {
    const runtimeMentions = routedMention ? [routedMention] : []
    const runtime = createConversationRuntime({ mentions: runtimeMentions })
    setEmptyCopyIndex((current) => nextEmptyCopyIndex(current, emptyCopyKeyForMention(routedMention)))
    selectConversationRuntime(runtime)
  }, [createConversationRuntime, routedMention, selectConversationRuntime])

  const ensureConversation = useCallback(async (text: string, scope: AgentScope, runtime: AgentConversationRuntime) => {
    if (runtime.conversationId) return { id: runtime.conversationId, created: false }
    const title = buildFallbackConversationTitle(text)
    const result = await window.electronAPI.agent.createConversation({
      title,
      scope,
      modelProvider: modelConfigRef.current?.provider || 'weflow',
      modelId: modelConfigRef.current?.model || '',
    })
    const record = result.success ? normalizeConversationRecord(result.conversation) : null
    if (!record) return null
    pendingTitleIdsRef.current.add(record.id)
    runtime.conversationId = record.id
    runtime.conversationTitle = record.title
    runtime.conversationTitleGenerated = Boolean(record.titleGeneratedAt)
    runtimesByConversationIdRef.current.set(record.id, runtime)
    if (selectedRuntimeRef.current === runtime) {
      conversationIdRef.current = record.id
      setConversationId(record.id)
      setConversationTitle(record.title)
      setConversationTitleGenerated(runtime.conversationTitleGenerated)
      storeActiveAgentConversation(record.id)
    }
    return { id: record.id, created: true }
  }, [])

  const requestConversationTitle = useCallback((
    targetId: number,
    firstUserText: string,
  ) => {
    const normalizedText = String(firstUserText || '').trim()
    if (!targetId || !normalizedText) return
    pendingTitleIdsRef.current.add(targetId)
    pendingTitleTextsRef.current.set(targetId, normalizedText)
    if (titleRequestsInFlightRef.current.has(targetId) || titleRetryTimersRef.current.has(targetId)) return
    const previousAttempts = titleAttemptCountsRef.current.get(targetId) || 0
    if (previousAttempts >= 3) return
    const attempt = previousAttempts + 1
    titleAttemptCountsRef.current.set(targetId, attempt)
    titleRequestsInFlightRef.current.add(targetId)
    const titleRuntime = runtimesByConversationIdRef.current.get(targetId)
    void (async () => {
      let completed = false
      try {
        const result = await window.electronAPI.agent.generateTitle(
          `用户：${normalizedText}`,
          titleRuntime?.modelConfig || modelConfigRef.current || undefined,
        )
        const title = String(result.title || '').trim()
        if (!result.success || result.generated !== true || !title || !pendingTitleIdsRef.current.has(targetId)) return
        const renamed = await window.electronAPI.agent.renameConversation(targetId, title)
        if (!renamed.success || !pendingTitleIdsRef.current.has(targetId)) return
        completed = true
        pendingTitleIdsRef.current.delete(targetId)
        pendingTitleTextsRef.current.delete(targetId)
        titleAttemptCountsRef.current.delete(targetId)
        verifiedGeneratedTitleIdsRef.current.add(targetId)
        const runtime = runtimesByConversationIdRef.current.get(targetId)
        if (runtime) {
          runtime.conversationTitle = title
          runtime.conversationTitleGenerated = true
        }
        if (selectedRuntimeRef.current === runtime) {
          setConversationTitle(title)
          setConversationTitleGenerated(true)
        }
        await refreshRecords()
      } catch {
        // 标题生成失败不影响对话；finally 会按退避间隔继续重试，最多三次。
      } finally {
        titleRequestsInFlightRef.current.delete(targetId)
        if (!completed && pendingTitleIdsRef.current.has(targetId) && attempt < 3) {
          const delayMs = attempt === 1 ? 2000 : 8000
          const timer = window.setTimeout(() => {
            titleRetryTimersRef.current.delete(targetId)
            const retryText = pendingTitleTextsRef.current.get(targetId)
            if (retryText) requestConversationTitleRef.current(targetId, retryText)
          }, delayMs)
          titleRetryTimersRef.current.set(targetId, timer)
        }
      }
    })()
  }, [refreshRecords])
  requestConversationTitleRef.current = requestConversationTitle

  useEffect(() => {
    if (busy || status !== 'ready' || selectedRuntime.resumeAvailable || !conversationId) return
    const firstUserMessage = messages.find((message) => message.role === 'user')
    if (!firstUserMessage) return
    const firstUserText = messageTextOf(firstUserMessage).trim()
    if (!firstUserText) return
    const looksLikeLegacyFallback = conversationTitle.trim() === buildFallbackConversationTitle(firstUserText)
    const needsTitle = !conversationTitleGenerated
      || (looksLikeLegacyFallback && !verifiedGeneratedTitleIdsRef.current.has(conversationId))
    if (!needsTitle) return
    requestConversationTitle(conversationId, firstUserText)
  }, [busy, conversationId, conversationTitle, conversationTitleGenerated, messages, requestConversationTitle, selectedRuntime.resumeAvailable, status])

  const handleSubmit = useCallback(async (message: PromptInputMessage) => {
    const targetRuntime = selectedRuntimeRef.current
    if (!targetRuntime) return
    const text = message.text.trim()
    mentionPastePendingRef.current = false
    mentionPasteSequenceRef.current = false
    setActiveMentionQuery(null)
    setMentionSuggestionIndex(0)
    if (busy) {
      if (!text && message.files.length === 0) {
        requestRuntimeStop(targetRuntime)
        return
      }
      const queued = { ...message, text }
      targetRuntime.queuedMessage = queued
      setQueuedMessage(queued)
      promptControllerRef.current?.textInput.clear()
      promptControllerRef.current?.attachments.clear()
      return
    }
    if (!text && message.files.length === 0) return
    if (!isAgentModelReady(modelConfigRef.current)) {
      setNotice('请先在设置中完成 AI 模型、Base URL 和 API Key 配置。')
      return
    }
    let imageParts = message.files
    if (message.files.length > 0) {
      try {
        const saved = await Promise.all(message.files.map(async (part) => {
          if (!part.mediaType?.startsWith('image/')) throw new Error('本地仅支持上传图片。')
          const result = await window.electronAPI.agent.saveImageAttachment({
            dataUrl: part.url,
            filename: part.filename,
            mediaType: part.mediaType,
          })
          if (!result.success || !result.url) throw new Error(result.error || '图片保存失败')
          return {
            ...part,
            url: result.url,
            mediaType: result.mediaType || part.mediaType,
            filename: result.filename || part.filename,
            sizeBytes: result.sizeBytes ?? (part as typeof part & { sizeBytes?: number }).sizeBytes,
          }
        }))
        imageParts = saved
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '图片保存失败')
        throw error
      }
    }
    composerTransitionOriginRef.current = isEmptyConversation
      ? composerTrackRef.current?.getBoundingClientRect() || null
      : null
    // 提交被接受后立即清空编辑器，不等待 sendMessage 的整段流式响应结束。
    promptControllerRef.current?.textInput.clear()
    promptControllerRef.current?.attachments.clear()
    const scope = scopeForMentions(mentions)
    scopeRef.current = scope
    targetRuntime.scope = scope
    targetRuntime.mentions = mentions
    targetRuntime.mode = agentModeRef.current
    targetRuntime.modelConfig = modelConfigRef.current
    const targetConversation = await ensureConversation(text || '附件对话', scope, targetRuntime)
    if (!targetConversation) {
      targetRuntime.notice = '创建对话失败，请重试。'
      if (selectedRuntimeRef.current === targetRuntime) setNotice(targetRuntime.notice)
      return
    }
    // 新会话创建后立即启动标题请求，不等待主回答完成；两次模型请求直接并行。
    if (targetConversation.created) {
      requestConversationTitle(targetConversation.id, text || '附件对话')
    }
    targetRuntime.notice = ''
    targetRuntime.resumeAvailable = false
    targetRuntime.stopRequested = false
    targetRuntime.executionElapsedBeforeMs = 0
    targetRuntime.executionSegmentStartedAt = Date.now()
    targetRuntime.voiceModelDownloadRequired = false
    targetRuntime.progress = []
    targetRuntime.activePlanStartIndex = targetRuntime.chat.messages.length
    if (selectedRuntimeRef.current === targetRuntime) {
      setNotice('')
      setVoiceModelDownloadRuntime((current) => current === targetRuntime ? null : current)
      setProgress([])
      setPlanRevision((current) => current + 1)
    }
    // sendMessage 会先把用户消息同步加入运行时，但它的 Promise 要等整段响应结束。
    // 因此立即复制并持久化初始消息，避免流式期间切页或退出导致首条用户消息丢失；
    // 随后再共同等待发送和首次持久化完成。
    await sendWithImmediateAgentConversationPersist({
      send: () => targetRuntime.chat.sendMessage({
        text: encodeMessage(text, mentions),
        files: imageParts,
        metadata: { createdAt: Date.now() } satisfies AgentMessageMetadata,
      }),
      readMessages: () => targetRuntime.chat.messages,
      persist: (initialMessages) => persistRuntimeRef.current(targetRuntime, initialMessages),
    })
  }, [agentMode, busy, ensureConversation, isEmptyConversation, mentions, requestConversationTitle, requestRuntimeStop])

  const hasPendingToolApproval = useMemo(() => messages.some((message) => (
    message.role === 'assistant'
    && message.parts.some((part) => isToolUIPart(part) && part.state === 'approval-requested')
  )), [messages])

  useEffect(() => {
    if (!queuedMessage || busy || status === 'error' || hasPendingToolApproval) return
    const next = queuedMessage
    selectedRuntime.queuedMessage = null
    setQueuedMessage(null)
    void handleSubmit(next)
  }, [busy, handleSubmit, hasPendingToolApproval, queuedMessage, selectedRuntime, status])

  const handleCancelQueued = useCallback(() => {
    selectedRuntime.queuedMessage = null
    setQueuedMessage(null)
  }, [selectedRuntime])

  const handleSendQueuedNow = useCallback(() => {
    if (!queuedMessage) return
    if (status === 'error') {
      clearError()
      setNotice('')
    }
    if (busy) {
      requestRuntimeStop(selectedRuntime)
      return
    }
    const next = queuedMessage
    selectedRuntime.queuedMessage = null
    setQueuedMessage(null)
    void handleSubmit(next)
  }, [busy, clearError, handleSubmit, queuedMessage, requestRuntimeStop, selectedRuntime, status])

  const handleRetryLastTurn = useCallback(() => {
    if (busy || selectedRuntime.chat.messages.length === 0) return
    const preservedMessages = [...selectedRuntime.chat.messages]
    const resumedAt = Date.now()
    const elapsedBeforeMs = Math.max(
      readLatestStoppedAgentExecutionElapsed(preservedMessages),
      selectedRuntime.executionElapsedBeforeMs,
    )
    const resumedMessages = markAgentExecutionResumed(preservedMessages, resumedAt, elapsedBeforeMs)
    if (status === 'error') clearError()
    selectedRuntime.resumeAvailable = false
    selectedRuntime.stopRequested = false
    selectedRuntime.executionElapsedBeforeMs = elapsedBeforeMs
    selectedRuntime.executionSegmentStartedAt = resumedAt
    selectedRuntime.notice = ''
    setNotice('')
    selectedRuntime.modelConfig = modelConfigRef.current
    selectedRuntime.chat.messages = resumedMessages
    void (async () => {
      // 恢复前先持久化被中断的助手消息。SDK 的替换 API 按设计会移除该消息，
      // 过去这会从 UI 和磁盘中同时抹去所有已完成的工具步骤。
      await persistRuntimeRef.current(selectedRuntime, resumedMessages)
      await selectedRuntime.chat.resumeStream()
    })().catch((error) => {
      selectedRuntime.chat.messages = preservedMessages
      void persistRuntimeRef.current(selectedRuntime, preservedMessages)
      selectedRuntime.executionElapsedBeforeMs = elapsedBeforeMs
      selectedRuntime.executionSegmentStartedAt = null
      selectedRuntime.resumeAvailable = true
      selectedRuntime.notice = agentRunErrorNotice(error)
      setNotice(selectedRuntime.notice)
    })
  }, [busy, clearError, selectedRuntime, status])
  const handleCloseVoiceModelDownload = useCallback(() => {
    setVoiceModelDownloadRuntime(null)
  }, [])
  const handleVoiceModelDownloadComplete = useCallback(() => {
    const runtime = voiceModelDownloadRuntime
    setVoiceModelDownloadRuntime(null)
    if (!runtime) return
    runtime.voiceModelDownloadRequired = false
    runtime.notice = ''
    if (selectedRuntimeRef.current !== runtime) return
    setNotice('')
    // 弹窗会在下载成功后调用这里；让状态先完成提交，再从已持久化检查点恢复转写。
    window.setTimeout(() => handleRetryLastTurn(), 0)
  }, [handleRetryLastTurn, voiceModelDownloadRuntime])
  const handleDismissNotice = useCallback(() => {
    const runtime = selectedRuntimeRef.current
    if (runtime) runtime.notice = ''
    setNotice('')
  }, [])

  const handleToolApproval = useCallback((id: string, approved: boolean, reason?: string) => {
    void addToolApprovalResponse({ id, approved, reason })
  }, [addToolApprovalResponse])

  const handleOpenSource = useCallback((source: SourceItem) => {
    const params = new URLSearchParams({ sessionId: source.sessionId })
    if (source.localId) params.set('jumpLocalId', String(source.localId))
    if (source.createTime) params.set('jumpCreateTime', String(source.createTime))
    if (source.localId || source.createTime) params.set('jumpSource', 'deepChat')
    navigate(`/chat?${params.toString()}`)
  }, [navigate])

  const handleMessageFeedback = useCallback((messageId: string, feedback: AgentMessageFeedback | null) => {
    setMessageFeedback((current) => {
      const next = { ...current }
      if (feedback) next[messageId] = feedback
      else delete next[messageId]
      window.localStorage.setItem('weflow.agent.messageFeedback', JSON.stringify(next))
      return next
    })
    if (!feedback) {
      void window.electronAPI.agent.deleteFeedback(messageId, modelConfigRef.current)
      return
    }
    const message = messagesRef.current.find((item) => item.id === messageId)
    const metadata = (message?.metadata || {}) as AgentMessageMetadata
    void window.electronAPI.agent.saveFeedback({
      messageId,
      runId: metadata.agent?.runId,
      conversationId: conversationIdRef.current,
      rating: feedback.rating,
      reason: feedback.reason,
      at: feedback.at,
      answer: message ? messageTextOf(message) : undefined,
      modelConfig: modelConfigRef.current,
    })
  }, [])

  const handleEditUserMessage = useCallback(async (messageIndex: number, nextText: string) => {
    if (busy) return
    const currentMessages = messagesRef.current
    const message = currentMessages[messageIndex]
    if (!message || message.role !== 'user') return
    const latestUserIndex = currentMessages.reduce((latest, item, index) => item.role === 'user' ? index : latest, -1)
    if (messageIndex !== latestUserIndex) {
      setNotice('只能编辑最后一条已发送消息。')
      return
    }
    if (!isAgentModelReady(modelConfigRef.current)) {
      setNotice('请先在设置中完成 AI 模型、Base URL 和 API Key 配置。')
      return
    }

    const parsed = getUserMessageDisplay(message.parts)
    const files = message.parts.filter((part): part is Extract<UIMessage['parts'][number], { type: 'file' }> => part.type === 'file')
    const encodedText = encodeMessage(nextText.trim(), parsed.mentions)
    if (!encodedText.trim() && files.length === 0) return
    const existingMetadata = message.metadata && typeof message.metadata === 'object'
      ? message.metadata as AgentMessageMetadata
      : {}

    setNotice('')
    setProgress([])
    selectedRuntime.modelConfig = modelConfigRef.current
    selectedRuntime.activePlanStartIndex = messageIndex
    selectedRuntime.executionElapsedBeforeMs = 0
    selectedRuntime.executionSegmentStartedAt = Date.now()
    setPlanRevision((current) => current + 1)
    try {
      await sendMessage({
        text: encodedText,
        files,
        messageId: message.id,
        metadata: {
          ...existingMetadata,
          createdAt: existingMetadata.createdAt || Date.now(),
        } satisfies AgentMessageMetadata,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '消息重新发送失败'
      setNotice(detail)
      throw error
    }
  }, [busy, selectedRuntime, sendMessage])

  const handleForkFromMessage = useCallback(async (messageIndex: number) => {
    if (busy || forkingMessageId) return
    const currentMessages = messagesRef.current
    const target = currentMessages[messageIndex]
    if (!target || target.role !== 'assistant' || messageIndex >= currentMessages.length - 1) return

    setForkingMessageId(target.id)
    setNotice('')
    try {
      const branchMessages = currentMessages.slice(0, messageIndex + 1)
      const branchTitle = buildContinuationConversationTitle(conversationTitle)
      const parentConversationId = conversationIdRef.current
      const result = await window.electronAPI.agent.createConversation({
        title: branchTitle,
        scope: scopeRef.current,
        modelProvider: modelConfigRef.current?.provider || 'weflow',
        modelId: modelConfigRef.current?.model || '',
        source: 'weflow-fork',
        externalId: parentConversationId ? `${parentConversationId}:${target.id}` : target.id,
      })
      const record = result.success ? normalizeConversationRecord(result.conversation) : null
      if (!record) throw new Error(result.error || '创建续聊失败')

      const saved = await window.electronAPI.agent.saveConversationMessages({
        id: record.id,
        messages: branchMessages,
        scope: scopeRef.current,
        modelProvider: modelConfigRef.current?.provider || 'weflow',
        modelId: modelConfigRef.current?.model || '',
      })
      if (!saved.success) {
        await window.electronAPI.agent.deleteConversation(record.id)
        throw new Error(saved.error || '保存续聊上下文失败')
      }

      const branchRuntime = createConversationRuntime({
        conversationId: record.id,
        conversationTitle: record.title,
        messages: branchMessages,
        mentions: [...mentions],
        scope: scopeRef.current,
        mode: agentModeRef.current,
        modelConfig: modelConfigRef.current,
      })
      branchRuntime.notice = '已从这条回答创建续聊，原对话仍保留在历史记录中。'
      runtimesByConversationIdRef.current.set(record.id, branchRuntime)
      selectConversationRuntime(branchRuntime)
      await refreshRecords()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建续聊失败')
    } finally {
      setForkingMessageId('')
    }
  }, [busy, conversationTitle, createConversationRuntime, forkingMessageId, mentions, refreshRecords, selectConversationRuntime])

  const copyText = useCallback((id: string, value: string) => {
    void navigator.clipboard.writeText(value)
    setCopiedMessageId(id)
    window.setTimeout(() => setCopiedMessageId(''), 1200)
  }, [])

  const handleRegenerate = useCallback((messageIndex: number) => {
    if (busy) return
    const message = messagesRef.current[messageIndex]
    if (!message) return
    selectedRuntime.modelConfig = modelConfigRef.current
    selectedRuntime.executionElapsedBeforeMs = 0
    selectedRuntime.executionSegmentStartedAt = Date.now()
    setRegeneratingMessageId(message.id)
    void regenerate({ messageId: message.id }).finally(() => {
      setRegeneratingMessageId((current) => current === message.id ? '' : current)
    })
  }, [busy, regenerate, selectedRuntime])

  const speak = useCallback((id: string, value: string) => {
    if (!('speechSynthesis' in window)) return
    if (speakingMessageId === id) {
      window.speechSynthesis.cancel()
      setSpeakingMessageId('')
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(value)
    utterance.onend = () => setSpeakingMessageId((current) => current === id ? '' : current)
    utterance.onerror = () => setSpeakingMessageId((current) => current === id ? '' : current)
    setSpeakingMessageId(id)
    window.speechSynthesis.speak(utterance)
  }, [speakingMessageId])

  const openSettings = useCallback(() => {
    navigate('/settings', { state: { initialTab: 'aiCommon', backgroundLocation: routeLocation } })
  }, [navigate, routeLocation])

  const handleModelProfileSelect = useCallback((profileId: string, model: string) => {
    if (!profileId || !model) return
    const profile = modelProfiles.find((item) => item.id === profileId)
    if (profileId === activeModelProfileId && profile?.model === model) return
    void (async () => {
      try {
        await configService.patchAiModelProfile(profileId, { model, contextWindow: undefined }, true)
        await reloadModelConfiguration()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '模型配置切换失败')
      }
    })()
  }, [activeModelProfileId, modelProfiles, reloadModelConfiguration])

  const handleAttachmentError = useCallback((error: { code: 'max_files' | 'max_file_size' | 'accept' }) => {
    const message = error.code === 'max_files'
      ? '最多可添加 6 张图片。'
      : error.code === 'max_file_size'
        ? '单张图片不能超过 8 MB。'
        : '本地仅支持上传 JPEG、PNG、GIF、WebP、AVIF 或 BMP 图片。'
    setNotice(message)
  }, [])

  const handleDeleteRecord = useCallback(async (record: AgentConversationRecord) => {
    if (deletingConversationIdsRef.current.has(record.id)) return
    deletingConversationIdsRef.current.add(record.id)
    const runtime = runtimesByConversationIdRef.current.get(record.id)
    const deletingSelectedRuntime = selectedRuntimeRef.current === runtime
    try {
      if (runtime && (runtime.chat.status === 'submitted' || runtime.chat.status === 'streaming')) {
        requestRuntimeStop(runtime)
      }
      const result = await window.electronAPI.agent.deleteConversation(record.id)
      if (!result.success) return
      pendingTitleIdsRef.current.delete(record.id)
      pendingTitleTextsRef.current.delete(record.id)
      titleRequestsInFlightRef.current.delete(record.id)
      titleAttemptCountsRef.current.delete(record.id)
      verifiedGeneratedTitleIdsRef.current.delete(record.id)
      const titleRetryTimer = titleRetryTimersRef.current.get(record.id)
      if (titleRetryTimer !== undefined) window.clearTimeout(titleRetryTimer)
      titleRetryTimersRef.current.delete(record.id)
      runtimesByConversationIdRef.current.delete(record.id)
      runtime?.dispose()
      if (deletingSelectedRuntime) newConversation()
      await refreshRecords()
      setRecordsOpen(true)
    } finally {
      deletingConversationIdsRef.current.delete(record.id)
    }
  }, [newConversation, refreshRecords, requestRuntimeStop])

  const handleRenameRecord = useCallback(async (record: AgentConversationRecord, title: string) => {
    const nextTitle = title.trim().slice(0, 24)
    if (!nextTitle || nextTitle === record.title) return
    const result = await window.electronAPI.agent.renameConversation(record.id, nextTitle)
    if (!result.success) {
      setNotice(result.error || '重命名失败')
      return
    }
    pendingTitleIdsRef.current.delete(record.id)
    pendingTitleTextsRef.current.delete(record.id)
    titleAttemptCountsRef.current.delete(record.id)
    verifiedGeneratedTitleIdsRef.current.add(record.id)
    const titleRetryTimer = titleRetryTimersRef.current.get(record.id)
    if (titleRetryTimer !== undefined) window.clearTimeout(titleRetryTimer)
    titleRetryTimersRef.current.delete(record.id)
    const runtime = runtimesByConversationIdRef.current.get(record.id)
    if (runtime) {
      runtime.conversationTitle = nextTitle
      runtime.conversationTitleGenerated = true
    }
    if (conversationIdRef.current === record.id) {
      setConversationTitle(nextTitle)
      setConversationTitleGenerated(true)
    }
    await refreshRecords()
  }, [refreshRecords])

  const handleTogglePin = useCallback(async (record: AgentConversationRecord) => {
    const result = await window.electronAPI.agent.updateConversationMetadata(record.id, { pinned: !record.pinned })
    if (!result.success) {
      setNotice(result.error || '更新置顶状态失败')
      return
    }
    await refreshRecords()
  }, [refreshRecords])

  const latestUserId = active ? [...messages].reverse().find((message) => message.role === 'user')?.id : undefined
  const currentInvestigationPlan = useMemo(
    () => resolveCurrentTurnInvestigationPlan(messages, selectedRuntime.activePlanStartIndex),
    [messages, planRevision, selectedRuntime.activePlanStartIndex, selectedRuntime.key],
  )
  const activeProgress = active
    ? progress.filter((item) => item.visible !== false && !['run_finished'].includes(item.stage)).slice(-1)[0]
    : undefined
  const latestMessage = messages[messages.length - 1]
  const assistantVisibleTextStarted = latestMessage?.role === 'assistant'
    && Boolean(messageTextOf(latestMessage).trim())
  const assistantToolRunning = latestMessage?.role === 'assistant'
    && latestMessage.parts.some((part) => isToolUIPart(part) && ![
      'output-available',
      'output-error',
      'output-denied',
    ].includes(part.state))
  // 工具完成后的间隙中，模型正在决定下一步，因此恢复等待提示行。
  // 正在执行/等待批准的工具卡片或可见的最终正文会替换该提示行。
  const shouldShowResponsePending = active
    && busy
    && !assistantVisibleTextStarted
    && !assistantToolRunning

  useEffect(() => {
    if (shouldShowResponsePending) {
      setResponsePendingLeaving(false)
      const timer = window.setTimeout(() => setResponsePendingVisible(true), 180)
      return () => window.clearTimeout(timer)
    }
    setResponsePendingLeaving(true)
    const timer = window.setTimeout(() => {
      setResponsePendingVisible(false)
      setResponsePendingLeaving(false)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [shouldShowResponsePending])
  const modelReady = isAgentModelReady(modelConfig)
  const memoryPanelModelConfig = useMemo(
    () => modelConfig ? { ...modelConfig, reasoningEffort } : null,
    [modelConfig, reasoningEffort],
  )
  const conversationTokenEstimate = useMemo(
    () => estimateAgentContextMessagesTokens(messages),
    [messages],
  )
  const topbarTitle = !isEmptyConversation && conversationTitleGenerated && conversationTitle.trim()
    ? conversationTitle.trim()
    : ''

  // 跨页面运行只保留 useChat、IPC 流和持久化状态；隐藏时卸载消息 Markdown、
  // WebGL、粒子及视觉动画，避免后台流式更新重绘用户正在使用的其他页面。
  if (!active) return <div aria-hidden="true" className="agent-background-runtime" />

  return (
    <Surface
      className="agent-page relative flex h-full min-h-0 flex-col overflow-hidden"
      ref={agentPageRef}
      style={{ '--agent-radius': '18px' } as CSSProperties}
      variant="transparent"
    >
      <header className={`agent-topbar ${isEmptyConversation ? 'is-empty' : ''}`}>
        <div aria-atomic="true" aria-live="polite" className="agent-page-heading min-w-0">
          {topbarTitle && (
            <h1 className="agent-page-title" title={topbarTitle}>
              <span className="agent-page-title-text" key={`${selectedRuntime.key}:${topbarTitle}`}>
                {topbarTitle}
              </span>
            </h1>
          )}
        </div>
        <div className="agent-topbar-actions">
          <AgentMemoryPanel modelConfig={memoryPanelModelConfig} />
          <AgentRecordsMenu
            isOpen={recordsOpen}
            onOpenChange={(open) => { setRecordsOpen(open); if (open) void refreshRecords() }}
            records={records}
            selectedId={conversationId}
            onOpenRecord={(record) => { void loadConversation(record.id) }}
            onDeleteRecord={handleDeleteRecord}
            onRenameRecord={handleRenameRecord}
            onTogglePin={handleTogglePin}
          />
          {!isEmptyConversation && (
            <Tooltip delay={0}>
              <HeroButton aria-label="新建对话" className="agent-icon-button size-10 min-w-10 p-0" isIconOnly onPress={newConversation} size="md" variant="tertiary">
                <PencilToSquare className="size-4.5" />
              </HeroButton>
              <Tooltip.Content placement="bottom">新建对话</Tooltip.Content>
            </Tooltip>
          )}
        </div>
      </header>

      <main className={`agent-main relative min-h-0 flex-1 overflow-hidden ${isEmptyConversation ? 'is-empty' : ''}`}>
        {isEmptyConversation ? (
          <div className="agent-empty-copy-shell">
            <h1 className="agent-empty-copy" key={`empty-copy-${emptyCopyIndex}`}>
              {EMPTY_PROMPT_LINES[emptyCopyIndex]}
            </h1>
          </div>
        ) : (
          <Conversation className="agent-conversation min-h-0 min-w-0 w-full flex-1">
            <ConversationAutoScroll enabled trigger={latestUserId} />
            <ConversationContent
              className="agent-conversation-content mx-auto min-h-full w-full max-w-5xl gap-6"
              scrollClassName="agent-conversation-scroll agent-scrollbar"
            >
              {messages.map((message, index) => (
                <AgentMessageItem
                  key={message.id}
                  message={message}
                  messageIndex={index}
                  isLastMessage={index === messages.length - 1}
                  busy={displayBusy}
                  status={displayStatus}
                  subAgentProgress={index === messages.length - 1 ? progress : NO_AGENT_PROGRESS}
                  toolElapsedByKey={NO_TOOL_ELAPSED_BY_KEY}
                  liveToolStartedAtByKey={index === messages.length - 1 && displayBusy
                    ? selectedRuntime.toolStartedAtByKey
                    : undefined}
                  liveExecutionElapsedBeforeMs={index === messages.length - 1 && displayBusy
                    ? selectedRuntime.executionElapsedBeforeMs
                    : undefined}
                  liveExecutionSegmentStartedAt={index === messages.length - 1 && displayBusy
                    ? selectedRuntime.executionSegmentStartedAt
                    : undefined}
                  selectedModelSupportsTools
                  copied={copiedMessageId === message.id}
                  speaking={speakingMessageId === message.id}
                  regenerating={regeneratingMessageId === message.id}
                  canEditUser={message.role === 'user' && message.id === latestUserId && !busy}
                  sentAt={message.role === 'user' ? readAgentMessageTimestamp(message, messages[index + 1]) : undefined}
                  canForkFromHere={message.role === 'assistant' && index < messages.length - 1 && !busy && !forkingMessageId}
                  sessionNameOf={sessionNameOf}
                  mentionTargetOf={mentionTargetOf}
                  onCopyMessage={copyText}
                  onSpeak={speak}
                  onOpenUsageDetails={setUsageDetails}
                  onRegenerate={handleRegenerate}
                  onEditUser={handleEditUserMessage}
                  onForkFromHere={handleForkFromMessage}
                  onPreviewGeneratedImage={(payload) => setPreview(payload)}
                  onOpenSource={handleOpenSource}
                  onToolApproval={handleToolApproval}
                  feedback={messageFeedback[message.id]}
                  onFeedback={handleMessageFeedback}
                />
              ))}
              {responsePendingVisible && !assistantVisibleTextStarted && !assistantToolRunning && (
                <Message
                  className={`agent-response-pending-message ${responsePendingLeaving ? 'is-leaving' : ''}`}
                  from="assistant"
                >
                  <MessageContent>
                    <ModelWaitingLine label={activeProgress?.title} />
                  </MessageContent>
                </Message>
              )}
            </ConversationContent>
            <ConversationScrollButton className="bottom-4 z-30 agent-scroll-glass" />
          </Conversation>
        )}

        <div className="agent-composer-dock">
          <div className="agent-composer-track" ref={composerTrackRef}>
            {notice && (
              <div className="agent-notice" role="alert">
                <CircleInfo className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">{notice}</span>
                {!modelReady && (
                  <button onClick={openSettings} type="button">打开设置</button>
                )}
                {selectedRuntime.voiceModelDownloadRequired && (
                  <button onClick={() => setVoiceModelDownloadRuntime(selectedRuntime)} type="button">下载模型</button>
                )}
                <button
                  aria-label="关闭提示"
                  className="agent-notice-dismiss"
                  onClick={handleDismissNotice}
                  title="关闭提示"
                  type="button"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            )}
            {queuedMessage && (
              <div className="agent-message-queue" role="status">
                <span className="agent-message-queue__label">下一条</span>
                <span className="agent-message-queue__preview">
                  {queuedMessage.text.trim() || `${queuedMessage.files.length} 张图片`}
                </span>
                <button type="button" onClick={handleSendQueuedNow}>
                  {busy ? '停止当前并发送' : '立即发送'}
                </button>
                <button type="button" onClick={handleCancelQueued}>取消</button>
              </div>
            )}
            {currentInvestigationPlan && (
              <InvestigationPlanPanel
                plan={currentInvestigationPlan}
                visible={!assistantVisibleTextStarted}
              />
            )}
            <PromptInputProvider
              accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp"
              maxFiles={6}
              maxFileSize={8 * 1024 * 1024}
              onError={handleAttachmentError}
            >
              <PromptInputControllerBridge controllerRef={promptControllerRef} />
              <PromptInput
                accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp"
                className="agent-prompt-input w-full"
                enableLiquidGlass={false}
                maxFiles={6}
                maxFileSize={8 * 1024 * 1024}
                multiple
                onError={handleAttachmentError}
                onSubmit={handleSubmit}
              >
                <PromptInputBody className="agent-prompt-body">
                  <PromptInputAttachments className="agent-attachments">
                    {(attachment) => <PromptInputAttachment className="agent-attachment" data={attachment} />}
                  </PromptInputAttachments>
                  <AgentMentionPromptTextarea
                    aria-activedescendant={activeMentionQuery && mentionTypeaheadTargets.length > 0
                      ? `agent-mention-suggestion-${Math.min(mentionSuggestionIndex, mentionTypeaheadTargets.length - 1)}`
                      : undefined}
                    aria-autocomplete="list"
                    aria-controls={activeMentionQuery ? 'agent-mention-suggestions' : undefined}
                    aria-expanded={Boolean(activeMentionQuery)}
                    aria-haspopup="listbox"
                    aria-label="向 AI Agent 提问"
                    autoComplete="off"
                    className="min-h-11 max-h-44 px-4 py-2.5 text-[15px] leading-7 md:text-[15px]"
                    mentions={mentions}
                    onChange={handlePromptChange}
                    onKeyDown={handlePromptKeyDown}
                    onPaste={handlePromptPaste}
                    placeholder="询问聊天、联系人、时间线或任何你想找回的细节…"
                    textareaRef={promptTextareaRef}
                  />
                </PromptInputBody>
                {activeMentionQuery && (
                  <MentionTypeahead
                    activeIndex={Math.min(mentionSuggestionIndex, Math.max(mentionTypeaheadTargets.length - 1, 0))}
                    isLoading={mentionLoading}
                    onActiveIndexChange={setMentionSuggestionIndex}
                    onDismiss={dismissMentionTypeahead}
                    onSelect={(target) => insertMentionAtCursor(target, activeMentionQuery)}
                    query={activeMentionQuery.query}
                    sessions={sessions}
                  />
                )}
                <PromptInputFooter className="agent-prompt-footer items-center gap-2 px-3 pt-1 pb-2.5">
                  <PromptInputTools className="agent-prompt-tools gap-1">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger aria-label="添加图片" />
                      <PromptInputActionMenuContent><PromptInputActionAddAttachments label="添加图片" /></PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                    <ErrorBoundary
                      fallback={(
                        <span
                          aria-label="提及功能加载失败"
                          className="grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground/55 text-base"
                          role="status"
                          title="提及功能暂时不可用，请重新进入 AI Agent"
                        >
                          @
                        </span>
                      )}
                    >
                      <MentionTriggerButton
                        mentions={mentions}
                        sessions={sessions}
                        isLoading={mentionLoading}
                        onRequest={loadMentionTargets}
                        onAdd={insertMentionAtCursor}
                      />
                    </ErrorBoundary>
                  </PromptInputTools>
                  <div className="agent-composer-meta">
                    <AgentTokenMeter
                      contextWindow={modelConfig?.contextWindow}
                      contextTokens={conversationTokenEstimate}
                    />
                    <div className="agent-composer-model">
                      <AgentModelSelector
                        activeId={activeModelProfileId}
                        loading={modelLoading}
                        profiles={modelProfiles}
                        providers={modelProviders}
                        catalogLoading={modelCatalogLoading}
                        onAdd={openSettings}
                        onOpen={() => { void loadModelCatalog() }}
                        onSelect={handleModelProfileSelect}
                      />
                    </div>
                    <div className="shrink-0">
                      <AgentReasoningEffortControl value={reasoningEffort} onChange={setReasoningEffort} />
                    </div>
                    <AgentPromptPrimaryAction
                      busy={busy}
                      resumeAvailable={selectedRuntime.resumeAvailable && modelReady && !selectedRuntime.voiceModelDownloadRequired}
                      status={displayStatus}
                      stopping={stopping}
                      onResume={handleRetryLastTurn}
                    />
                  </div>
                </PromptInputFooter>
              </PromptInput>
            </PromptInputProvider>
          </div>
        </div>
      </main>
      {usageDetails && <UsageDetailsModal data={usageDetails} modelInfoByKey={modelInfoByKey} onClose={() => setUsageDetails(null)} />}
      {preview && <ImagePreview src={preview.src} originRect={preview.originRect} onClose={() => setPreview(null)} />}
      {voiceModelDownloadRuntime && (
        <VoiceTranscribeDialog
          onClose={handleCloseVoiceModelDownload}
          onDownloadComplete={handleVoiceModelDownloadComplete}
        />
      )}
    </Surface>
  )
}
