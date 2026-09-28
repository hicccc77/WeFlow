/**
 * 单条 Agent 消息的渲染：从 AgentPage.tsx 的 messages.map() 中拆出，并用 React.memo 包裹。
 *
 * 需要独立组件的原因：useChat 流式更新时，@ai-sdk/react 只替换当前消息的对象引用，
 * 其他历史消息保持原引用不变。但如果直接在 messages.map() 中内联构建每条消息的 JSX，
 * 即使只有最后一条消息约每 50 毫秒更新一次，全部历史消息也会重新构建；
 * 对话越长、代码块越多，性能损耗越明显。
 *
 * 这里增加 memo 边界并使用自定义比较函数：只有当前消息正处于流式输出末尾时，才关注
 * toolElapsedByKey 和 subAgentProgress 等高频字段；历史消息的工具耗时和子助手进度早已
 * 就定型了，这两个字段再怎么变也不需要重渲染。
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Check, Copy, Xmark } from '@gravity-ui/icons'
import {
  BookOpenText,
  ChartNoAxesColumn,
  PencilLine,
  ShieldCheck,
  ShieldX,
  Wrench,
} from 'lucide-react'
import type { ChatStatus, UIMessage } from 'ai'
import type { IconComponent } from '@/types/icon'
import {
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
} from '@/components/ai-elements/chain-of-thought'
import {
  Message,
  MessageAttachment,
  MessageAttachments,
  MessageAction,
  MessageContent,
  MessageResponse,
  MessageStreamingIndicator,
} from '@/components/ai-elements/message'
import type { AgentProgressEvent } from '@/features/aiagent/transport/ipcChatTransport'
import { InlineMentionText, getUserMessageDisplay, type MentionTargetResolver } from './AgentMentions'
import {
  MessageSources,
  MessageWebSources,
  buildRenderSegments,
  collectRetrievalBadges,
  extractSources,
  extractWebSources,
  formatElapsed,
  formatToolName,
  getDelegateTasks,
  isAgentChainPart,
  pushBadge,
  renderChainLabel,
  toolPartName,
  toolPartProgressKey,
  toolProgressKey,
  type AgentChainPart,
  type AgentMessagePart,
  type SourceItem,
} from './agentMessageHelpers'
import { AGENT_TOOL_NOT_RUN_ERROR, readSubAgentProgressFromMessage, readToolElapsedFromMessage, type AgentMessageMetadata } from './agentConversationHelpers'
import { MessageUsageStats, type AgentMessageFeedback } from './AgentUsageStats'
import { SubAgentProgressPanel } from './AgentSubAgentProgress'
import { CompactionMarker, MessageChainOfThought, ThinkingChainStep, ToolChainGroup, ToolChainStep, type CompactionPartData } from './AgentMessageBlocks'
import { isInvestigationPlanToolPart } from './agentInvestigationPlan'
import { collectToolSessionDisplayNames } from './agentToolPresentation'
import {
  agentToolActivityKind,
  summarizeAgentToolActivities,
  type AgentToolActivityKind,
} from './agentToolActivity'

const TOOL_ACTIVITY_ICONS: Record<AgentToolActivityKind, IconComponent> = {
  capability: Wrench,
  conversation: BookOpenText,
  reading: BookOpenText,
  context: BookOpenText,
  search: BookOpenText,
  analysis: ChartNoAxesColumn,
  planning: ChartNoAxesColumn,
  voice: Wrench,
  media: Wrench,
  moments: BookOpenText,
  memory: BookOpenText,
  web: BookOpenText,
  delegate: ChartNoAxesColumn,
  command: Wrench,
  file: Wrench,
  desktop: Wrench,
  action: Wrench,
  other: Wrench,
}

function toolActivityIcon(toolName: string): IconComponent {
  return TOOL_ACTIVITY_ICONS[agentToolActivityKind(toolName)]
}

const USER_MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const USER_MESSAGE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function AnimatedToolElapsed({ value }: { value: string }) {
  return (
    <span aria-label={value} className="agent-tool-elapsed">
      <span aria-hidden="true" className="agent-tool-elapsed-value" key={value}>{value}</span>
    </span>
  )
}

export type AgentImagePreviewPayload = {
  src: string
  originRect: { left: number; top: number; width: number; height: number }
}

export type AgentMessageItemProps = {
  message: UIMessage
  messageIndex: number
  isLastMessage: boolean
  busy: boolean
  status: ChatStatus
  subAgentProgress: AgentProgressEvent[]
  toolElapsedByKey: Record<string, number>
  liveToolStartedAtByKey?: Record<string, number>
  liveExecutionElapsedBeforeMs?: number
  liveExecutionSegmentStartedAt?: number | null
  selectedModelSupportsTools: boolean
  copied: boolean
  speaking: boolean
  regenerating: boolean
  canEditUser: boolean
  sentAt?: number
  canForkFromHere: boolean
  sessionNameOf: (sessionId: string) => string
  mentionTargetOf: MentionTargetResolver
  onCopyMessage: (messageId: string, text: string) => void
  onSpeak: (messageId: string, text: string) => void
  onOpenUsageDetails: (data: AgentMessageMetadata) => void
  onRegenerate: (messageIndex: number) => void
  onEditUser: (messageIndex: number, text: string) => Promise<void>
  onForkFromHere: (messageIndex: number) => Promise<void>
  onPreviewGeneratedImage: (payload: AgentImagePreviewPayload) => void
  onOpenSource: (item: SourceItem) => void
  onToolApproval: (approvalId: string, approved: boolean, reason?: string) => void
  feedback?: AgentMessageFeedback
  onFeedback: (messageId: string, feedback: AgentMessageFeedback | null) => void
}

function AgentMessageItemImpl({
  message,
  messageIndex,
  isLastMessage,
  busy,
  status,
  subAgentProgress,
  toolElapsedByKey,
  liveToolStartedAtByKey,
  liveExecutionElapsedBeforeMs,
  liveExecutionSegmentStartedAt,
  selectedModelSupportsTools,
  copied,
  speaking,
  regenerating,
  canEditUser,
  sentAt,
  canForkFromHere,
  sessionNameOf,
  mentionTargetOf,
  onCopyMessage,
  onSpeak,
  onOpenUsageDetails,
  onRegenerate,
  onEditUser,
  onForkFromHere,
  onPreviewGeneratedImage,
  onOpenSource,
  onToolApproval,
  feedback,
  onFeedback,
}: AgentMessageItemProps) {
  const lastPart = message.parts[message.parts.length - 1]
  const activeRootProgress = [...subAgentProgress]
    .reverse()
    .find((event) => (event.depth ?? 0) === 0 && event.visible !== false)
  const lastExecutionPartIndex = message.parts.reduce(
    (lastIndex, part, index) => isAgentChainPart(part) || part.type === 'data-compaction' ? index : lastIndex,
    -1,
  )
  const liveInvestigatorText = message.role === 'assistant'
    && isLastMessage
    && busy
    && status === 'streaming'
    && activeRootProgress?.stage !== 'finalizing'
  const stageTextPartIndexes = new Set(message.role === 'assistant'
    ? message.parts.flatMap((part, index) => part.type === 'text'
      && (index < lastExecutionPartIndex || (liveInvestigatorText && index === message.parts.length - 1))
      ? [index]
      : [])
    : [],
  )
  const finalTextParts = message.parts.filter((part, index) => part.type === 'text' && !stageTextPartIndexes.has(index))
  const assistantText = message.role === 'assistant'
    ? finalTextParts.map((part) => part.type === 'text' ? part.text : '').join('\n\n').trim()
    : ''
  // `finalizing` 只表示 worker 已开始准备最终回答；模型请求、服务端推理和重试都可能
  // 发生在首个正文字符之前。AI SDK 的 text-start 也会先创建一个空文本 part。
  // 因此只能在最终正文真正出现可见字符后结束并收起执行区，不能依据阶段或空 part 猜测。
  const answerWritingStarted = message.role === 'assistant' && Boolean(assistantText)
  const isReasoningStreaming = isLastMessage
    && status === 'streaming'
    && lastPart?.type === 'reasoning'
    && !answerWritingStarted
  const chainActive = isLastMessage && busy && !answerWritingStarted
  const executionTimerActive = isLastMessage && busy
  const [activeToolNow, setActiveToolNow] = useState(() => Date.now())
  useEffect(() => {
    if (!executionTimerActive) return
    setActiveToolNow(Date.now())
    const timer = window.setInterval(() => setActiveToolNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [executionTimerActive])
  // AI SDK 收到 text-start 后，会在首个正文字符到达前先创建一条空助手消息。
  // 此时仍由通用等待提示表示状态，避免同时出现空正文光标；
  // 只有正文已经包含内容后才显示流式指示器。
  const assistantTextStreaming = message.role === 'assistant'
    && isLastMessage
    && status === 'streaming'
    && Boolean(assistantText.trim())
  const assistantAnswerFinished = message.role === 'assistant'
    && (!isLastMessage || (!busy && status === 'ready'))
  const assistantDisplayText = assistantText
  const userMessageDate = sentAt !== undefined && Number.isFinite(sentAt) && sentAt > 0
    ? new Date(sentAt)
    : null
  const validUserMessageDate = userMessageDate && !Number.isNaN(userMessageDate.getTime()) ? userMessageDate : null
  const userDisplay = message.role === 'user' ? getUserMessageDisplay(message.parts, mentionTargetOf) : null
  const editableUserText = message.role === 'user'
    ? message.parts
      .map((part, index) => part.type === 'text' ? (userDisplay?.textByPartIndex.get(index) ?? part.text) : '')
      .filter(Boolean)
      .join('\n')
      .trim()
    : ''
  const [editingUser, setEditingUser] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  useEffect(() => {
    if (!canEditUser) {
      setEditingUser(false)
      setSavingEdit(false)
    }
  }, [canEditUser])
  const persistedSubAgentEvents = message.role === 'assistant' ? readSubAgentProgressFromMessage(message) : []
  // progress/status 也会触发最后一条消息重渲染；parts 未变化时不要重复遍历、解析
  // 工具输出，因为聊天证据兼容解析最多可能处理 2 MB 的 JSON 字符串。
  const webSources = useMemo(
    () => message.role === 'assistant' ? extractWebSources(message.parts) : [],
    [message.parts, message.role],
  )
  const sources = useMemo(
    () => assistantAnswerFinished
      ? extractSources(message.parts)
      : { items: [], total: 0, truncated: false },
    [assistantAnswerFinished, message.parts],
  )
  const toolSessionDisplayNames = useMemo(
    () => collectToolSessionDisplayNames(message.parts),
    [message.parts],
  )
  const resolvedSessionNameOf = (sessionId: string) => toolSessionDisplayNames.get(sessionId)
    || sessionNameOf(sessionId)
  const subAgentEventsForMessage = message.role === 'assistant'
    ? (isLastMessage && subAgentProgress.length > 0 ? subAgentProgress : persistedSubAgentEvents)
    : []
  const persistedToolElapsed = message.role === 'assistant' ? readToolElapsedFromMessage(message) : {}
  const resolvedToolElapsedByKey: Record<string, number> = {
    ...persistedToolElapsed,
    ...toolElapsedByKey,
  }
  for (const event of subAgentEventsForMessage) {
    if (!event.toolName || typeof event.elapsedMs !== 'number' || !Number.isFinite(event.elapsedMs)) continue
    resolvedToolElapsedByKey[toolProgressKey(event.toolName, event.toolCallId)] = event.elapsedMs
  }
  const metadata = (message as { metadata?: AgentMessageMetadata }).metadata
  const trace = metadata?.agent?.trace || metadata?.ciphertalk?.trace
  const rootProgressEvents = subAgentEventsForMessage.filter((event) => (event.depth ?? 0) === 0)
  const progressStartedAt = rootProgressEvents.reduce<number | undefined>(
    (earliest, event) => !Number.isFinite(event.at) ? earliest : earliest === undefined ? event.at : Math.min(earliest, event.at),
    undefined,
  )
  const progressFinishedAt = rootProgressEvents.reduce<number | undefined>(
    (latest, event) => !Number.isFinite(event.at) ? latest : latest === undefined ? event.at : Math.max(latest, event.at),
    undefined,
  )
  // 续跑时 AI SDK 会用一条新的 assistant 消息替换中断消息，新消息在 finish 前没有旧 trace。
  // 运行中的累计时间必须优先使用会话 runtime，而不能从这条临时消息的 metadata 重新从零推算。
  const persistedExecutionStartedAt = typeof trace?.startedAt === 'number' && Number.isFinite(trace.startedAt)
    ? trace.startedAt
    : progressStartedAt
  const executionStartedAt = executionTimerActive
    && typeof liveExecutionSegmentStartedAt === 'number'
    && Number.isFinite(liveExecutionSegmentStartedAt)
    ? liveExecutionSegmentStartedAt
    : persistedExecutionStartedAt
  const persistedExecutionElapsedBeforeMs = typeof trace?.elapsedBeforeMs === 'number' && Number.isFinite(trace.elapsedBeforeMs)
    ? Math.max(0, trace.elapsedBeforeMs)
    : 0
  const executionElapsedBeforeMs = executionTimerActive
    && typeof liveExecutionElapsedBeforeMs === 'number'
    && Number.isFinite(liveExecutionElapsedBeforeMs)
    ? Math.max(0, liveExecutionElapsedBeforeMs)
    : persistedExecutionElapsedBeforeMs
  const summedToolElapsedMs = Object.values(resolvedToolElapsedByKey)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((total, value) => total + value, 0)
  const executionElapsedMs = executionTimerActive && executionStartedAt !== undefined
    ? executionElapsedBeforeMs + Math.max(0, activeToolNow - executionStartedAt)
    : typeof trace?.totalElapsedMs === 'number' && Number.isFinite(trace.totalElapsedMs)
      ? trace.totalElapsedMs
      : !chainActive && executionStartedAt !== undefined && progressFinishedAt !== undefined
      ? Math.max(0, progressFinishedAt - executionStartedAt)
      : !chainActive && summedToolElapsedMs > 0
        ? summedToolElapsedMs
        : undefined
  const orderedSegments = buildRenderSegments(message.parts)
  const allChainItems = orderedSegments.flatMap((segment) => segment.kind === 'chain' ? segment.items : [])
  const allExecutionItems = message.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part, index }) => (
      (isAgentChainPart(part) && !isInvestigationPlanToolPart(part))
      || part.type === 'data-compaction'
      || (part.type === 'text' && stageTextPartIndexes.has(index))
    ))
  const executionPartIndexes = new Set(allExecutionItems.map(({ index }) => index))
  const firstExecutionSegmentIndex = orderedSegments.findIndex((segment) => segment.kind === 'chain'
    ? segment.items.some(({ index }) => executionPartIndexes.has(index))
    : executionPartIndexes.has(segment.index))
  const userFileParts = message.role === 'user'
    ? message.parts
      .map((part, index) => ({ part, index }))
      .filter((item): item is { part: Extract<UIMessage['parts'][number], { type: 'file' }>; index: number } => item.part.type === 'file')
    : []
  const hasRenderableUserText = message.role === 'user'
    && message.parts.some((part, index) => {
      if (part.type !== 'text') return false
      const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
      return Boolean(displayText.trim())
    })
  const shouldRenderMessageContent = message.role !== 'user'
    || hasRenderableUserText
    || userFileParts.length > 0
    || Boolean(userDisplay?.mentions.length)
  const saveEditedUserMessage = async () => {
    const nextText = editDraft.trim()
    if (savingEdit || (!nextText && userFileParts.length === 0)) return
    setSavingEdit(true)
    try {
      await onEditUser(messageIndex, nextText)
      setEditingUser(false)
    } catch {
      // 父组件已经把可恢复的错误展示在输入框上方；保留编辑态供用户继续修改或重试。
    } finally {
      setSavingEdit(false)
    }
  }
  // generate_image、send_sticker、send_random_image、send_media_from_history 和 present_media_image
  // 的产出图统一收进媒体墙，避免朋友圈九图被纵向铺成九个重复卡片。
  const toolImageOf = (part: AgentMessagePart, index: number) => {
    if (!isAgentChainPart(part)) return null
    const isSticker = part.type === 'tool-send_sticker'
    const isRandomImage = part.type === 'tool-send_random_image'
    const isHistoryMedia = part.type === 'tool-send_media_from_history'
    const isPresentedMedia = part.type === 'tool-present_media_image'
    const isGenerated = part.type === 'tool-generate_image'
    if ((!isSticker && !isRandomImage && !isHistoryMedia && !isPresentedMedia && !isGenerated) || part.state !== 'output-available') return null
    const output = part.output as { success?: unknown; imageRef?: unknown; filePath?: unknown; from?: unknown; sender?: unknown; time?: unknown; mediaKind?: unknown } | undefined
    if (isPresentedMedia && output?.success !== true) return null
    const filePath = String(output?.filePath || '')
    if (!filePath) return null
    const normalizedPath = filePath.replace(/\\/g, '/')
    const imageSrc = encodeURI(`file://${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`).replace(/#/g, '%23')
    const caption = isRandomImage || isHistoryMedia || isPresentedMedia
      ? [output?.sender, output?.from, output?.time].map((v) => String(v || '')).filter(Boolean).join(' · ')
      : ''
    return {
      alt: isSticker || output?.mediaKind === 'emoji'
        ? '表情包'
        : isRandomImage || isHistoryMedia || isPresentedMedia
          ? '历史图片'
          : 'AI 生成的图片',
      caption,
      compact: isSticker || output?.mediaKind === 'emoji',
      dedupeKey: String(output?.imageRef || filePath),
      imageSrc,
      index,
    }
  }

  const renderToolImageGallery = (items: Array<{ part: AgentChainPart; index: number }>) => {
    const candidates = items
      .map(({ part, index }) => toolImageOf(part, index))
      .filter((image): image is NonNullable<ReturnType<typeof toolImageOf>> => Boolean(image))
    const images = Array.from(new Map(candidates.map((image) => [image.dedupeKey, image])).values())
    if (images.length === 0) return null
    const captions = Array.from(new Set(images.map((image) => image.caption).filter(Boolean)))
    const caption = captions.length === 1 ? captions[0] : images.length > 1 ? `共 ${images.length} 张图片` : ''

    return (
      <figure className="agent-media-figure" data-count={Math.min(images.length, 3)}>
        <div className="agent-media-gallery">
          {images.map((image, imageIndex) => (
            <button
              aria-label={`预览第 ${imageIndex + 1} 张图片，共 ${images.length} 张`}
              className={`agent-media-item${image.compact ? ' is-compact' : ''}`}
              key={`tool-image-${image.index}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                onPreviewGeneratedImage({
                  src: image.imageSrc,
                  originRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                })
              }}
              title={image.caption || '点击预览'}
              type="button"
            >
              <img alt={image.alt} decoding="async" draggable={false} loading="lazy" src={image.imageSrc} />
              {images.length > 1 && imageIndex === images.length - 1 && (
                <span aria-hidden="true" className="agent-media-count">{images.length} 张</span>
              )}
            </button>
          ))}
        </div>
        {caption && (
          <figcaption className="agent-media-caption">{caption}</figcaption>
        )}
      </figure>
    )
  }
  const toolDone = (part: AgentChainPart) => part.state === 'output-available'
    || part.state === 'output-error'
    || part.state === 'output-denied'
  const renderToolChainItem = ({ part, index, summaryLabel }: {
    part: AgentChainPart
    index: number
    summaryLabel?: string
  }) => {
    const toolName = toolPartName(part)
    const done = toolDone(part)
    const notRun = part.state === 'output-error' && part.errorText === AGENT_TOOL_NOT_RUN_ERROR
    const toolActive = !done && chainActive
    const toolLabel = formatToolName(toolName)
    const progressKey = toolPartProgressKey(part, toolName)
    const nameProgressKey = toolProgressKey(toolName)
    const hasConcreteToolCallId = progressKey !== nameProgressKey
    const activeStartedAt = toolActive
      ? liveToolStartedAtByKey?.[progressKey]
        ?? (!hasConcreteToolCallId ? liveToolStartedAtByKey?.[nameProgressKey] : undefined)
        ?? [...subAgentEventsForMessage].reverse().find((event) => (
            Number.isFinite(event.at)
            && event.stage !== 'tool_finished'
            && event.stage !== 'run_finished'
            && event.stage !== 'error'
            && (
              toolProgressKey(event.toolName || '', event.toolCallId) === progressKey
              || (
                !hasConcreteToolCallId
                && event.toolName === toolName
                && toolProgressKey(event.toolName) === nameProgressKey
              )
            )
          ))?.at
      : undefined
    const activeElapsedLabel = toolActive && activeStartedAt !== undefined
      ? formatElapsed(Math.max(0, activeToolNow - activeStartedAt))
      : ''
    const stateLabel = part.state === 'approval-requested'
      ? '等待确认'
      : part.state === 'approval-responded'
        ? '已确认'
        : part.state === 'output-denied'
          ? '已拒绝'
          : ''
    const primaryLabel = notRun
      ? `未运行 ${toolLabel}`
      : summaryLabel ?? `${done ? '已运行' : toolActive ? '正在运行' : '尚未运行'} ${toolLabel}`
    const suffixLabel = activeElapsedLabel || stateLabel
    const labelContent = suffixLabel ? (
      <span className="agent-tool-label">
        {primaryLabel}
        <span aria-hidden="true"> · </span>
        {activeElapsedLabel ? <AnimatedToolElapsed value={activeElapsedLabel} /> : stateLabel}
      </span>
    ) : primaryLabel
    const label = renderChainLabel(labelContent, toolActive)
    // 联网搜索的 URL 统一放在回答末尾的“网页来源”中；执行过程只展示不含站点信息的调用摘要。
    const badges: string[] = []
    const delegateTasks = toolName === 'delegate_analysis' ? getDelegateTasks(part) : undefined
    if (part.state === 'output-available') {
      for (const badge of collectRetrievalBadges(toolName, part.output)) pushBadge(badges, badge)
    }
    return (
      <ToolChainStep
        active={toolActive}
        icon={toolActivityIcon(toolName)}
        input={part.input}
        key={`chain-${index}`}
        label={label}
        outcome={notRun
          ? 'pending'
          : part.state === 'output-available'
          ? 'success'
          : part.state === 'output-error'
            ? 'error'
            : part.state === 'output-denied'
              ? 'denied'
              : 'pending'}
        output={part.state === 'output-available' ? part.output : undefined}
        sessionNameOf={resolvedSessionNameOf}
        status={done ? 'complete' : toolActive ? 'active' : 'pending'}
        callState={part.state}
        toolName={toolName}
      >
        {badges.length > 0 && (
          <ChainOfThoughtSearchResults>
            {badges.map((badge) => (
              <ChainOfThoughtSearchResult key={badge}>
                {badge}
              </ChainOfThoughtSearchResult>
            ))}
          </ChainOfThoughtSearchResults>
        )}
        {notRun && (
          <p className="text-xs leading-5 text-muted-foreground">回答已结束；继续回答时会重新运行此工具。</p>
        )}
        {part.state === 'output-error' && part.errorText && !notRun && (
          <p className="text-xs leading-5 text-destructive">{part.errorText}</p>
        )}
        {part.state === 'output-denied' && (
          <p className="text-xs leading-5 text-muted-foreground">用户拒绝了这次工具操作。</p>
        )}
        {part.state === 'approval-requested' && typeof (part as { approval?: { id?: unknown } }).approval?.id === 'string' && (
          <div className="agent-tool-approval" role="group" aria-label={`授权 ${toolLabel}`}>
            <div className="agent-tool-approval-copy">
              <ShieldCheck aria-hidden="true" className="size-4" />
              <span>
                <strong>需要你的确认</strong>
                <small>{toolName === 'remember' ? 'AI 想把这条信息写入长期记忆，你之后可以随时修改或删除。' : toolName === 'forget' ? 'AI 想永久删除一条长期记忆。' : '这项操作会改变本地数据。'}</small>
              </span>
            </div>
            <div className="agent-tool-approval-actions">
              <button type="button" onClick={() => onToolApproval((part as { approval: { id: string } }).approval.id, false, '用户拒绝了本次写入操作')}>
                <ShieldX className="size-3.5" />拒绝
              </button>
              <button type="button" onClick={() => onToolApproval((part as { approval: { id: string } }).approval.id, true)}>
                <ShieldCheck className="size-3.5" />仅允许这一次
              </button>
            </div>
          </div>
        )}
        {toolName === 'delegate_analysis' && subAgentEventsForMessage.length > 0 && (
          <SubAgentProgressPanel events={subAgentEventsForMessage} tasks={delegateTasks} />
        )}
      </ToolChainStep>
    )
  }
  const renderChainSegment = () => {
    type ChainPhase =
      | { kind: 'reasoning'; item: { part: AgentChainPart; index: number } }
      | { kind: 'stage'; item: { part: AgentMessagePart; index: number } }
      | { kind: 'tools'; items: Array<{ part: AgentChainPart; index: number }> }
      | { kind: 'compaction'; item: { part: AgentMessagePart; index: number } }
    const phases: ChainPhase[] = []
    for (const item of allExecutionItems) {
      if (item.part.type === 'data-compaction') {
        phases.push({ kind: 'compaction', item })
        continue
      }
      if (item.part.type === 'text') {
        phases.push({ kind: 'stage', item })
        continue
      }
      if (!isAgentChainPart(item.part)) continue
      if (item.part.type === 'reasoning') {
        phases.push({ kind: 'reasoning', item })
        continue
      }
      const previous = phases[phases.length - 1]
      const currentToolName = toolPartName(item.part)
      const isIndependentMediaReview = currentToolName === 'review_focused_voice'
        || currentToolName === 'review_focused_images'
      const previousHasIndependentMediaReview = previous?.kind === 'tools'
        && previous.items.some(({ part }) => {
          const name = toolPartName(part)
          return name === 'review_focused_voice' || name === 'review_focused_images'
        })
      // 语音与图片审查必须始终显示为两个独立工具行，不能再折叠成一个组合工具组。
      if (previous?.kind === 'tools' && !isIndependentMediaReview && !previousHasIndependentMediaReview) previous.items.push(item)
      else phases.push({ kind: 'tools', items: [item] })
    }
    return (
      <MessageChainOfThought
        active={chainActive}
        elapsedMs={executionElapsedMs}
        key={`chain-${allExecutionItems[0]?.index ?? 0}`}
        startedAt={executionStartedAt}
        stopped={trace?.executionState === 'stopped'}
      >
        {phases.map((phase) => {
          if (phase.kind === 'compaction') {
            const partId = (phase.item.part as { id?: string }).id
            return (
              <CompactionMarker
                data={((phase.item.part as { data?: CompactionPartData }).data) || {}}
                inline
                key={`compaction-${partId || phase.item.index}`}
              />
            )
          }
          if (phase.kind === 'tools') {
            const activityCalls = phase.items.map(({ part }) => ({
              input: part.input,
              status: toolDone(part) ? 'complete' as const : chainActive ? 'active' as const : 'pending' as const,
              toolName: toolPartName(part),
            }))
            const groupActive = activityCalls.some(({ status }) => status === 'active')
            const groupStatus = groupActive
              ? 'active' as const
              : activityCalls.every(({ status }) => status === 'complete')
                ? 'complete' as const
                : 'pending' as const
            const activityLabel = summarizeAgentToolActivities(activityCalls, resolvedSessionNameOf)
            if (phase.items.length === 1) {
              return renderToolChainItem({ ...phase.items[0], summaryLabel: activityLabel })
            }
            const activityIcons = Array.from(new Set(activityCalls.map(({ toolName }) => toolActivityIcon(toolName))))
            const groupIcon = activityIcons.length === 1 ? activityIcons[0] : Wrench
            return (
              <ToolChainGroup
                active={groupActive}
                icon={groupIcon}
                key={`tools-${phase.items[0]?.index ?? 0}`}
                label={activityLabel}
                status={groupStatus}
              >
                {phase.items.map((item) => renderToolChainItem(item))}
              </ToolChainGroup>
            )
          }
          if (phase.kind === 'stage') {
            const { part, index } = phase.item
            if (part.type !== 'text' || !part.text.trim()) return null
            const stageActive = liveInvestigatorText && index === message.parts.length - 1
            return (
              <MessageResponse
                className="agent-stage-copy"
                isStreaming={stageActive}
                key={`stage-${index}`}
                showStreamingIndicator={false}
              >
                {part.text}
              </MessageResponse>
            )
          }
          const { part, index } = phase.item
          if (part.type !== 'reasoning' || !part.text.trim()) return null
          const reasoningActive = isReasoningStreaming && index === message.parts.length - 1
          return (
            <ThinkingChainStep active={reasoningActive} key={`reasoning-${index}`}>
              <MessageResponse
                className="agent-thinking-content"
                isStreaming={reasoningActive}
                showStreamingIndicator={false}
              >
                {part.text}
              </MessageResponse>
            </ThinkingChainStep>
          )
        })}
      </MessageChainOfThought>
    )
  }
  const renderExecutionContainer = (key: string) => {
    const mediaGallery = renderToolImageGallery(allChainItems)
    if (allExecutionItems.length === 0 && !mediaGallery) return null
    return (
      <div className="agent-response-block agent-execution-segment space-y-2" key={key}>
        {allExecutionItems.length > 0 && renderChainSegment()}
        {mediaGallery}
      </div>
    )
  }

  return (
    <Message from={message.role}>
      {shouldRenderMessageContent && (
        <MessageContent className={message.role === 'user' ? 'agent-user-message-content px-4 py-3' : undefined}>
          {userFileParts.length > 0 && (
            <MessageAttachments className="justify-end">
              {userFileParts.map(({ part, index }) => (
                <MessageAttachment data={part} displayMode="content" key={`user-file-${index}`} />
              ))}
            </MessageAttachments>
          )}
          {message.role === 'user' && editingUser && (
            <div className="w-[min(34rem,70vw)] max-w-full space-y-2">
              <textarea
                aria-label="编辑最后一条消息"
                autoFocus
                className="agent-scrollbar min-h-24 w-full resize-y rounded-xl border border-border/70 bg-background/75 px-3 py-2 text-[15px] leading-6 text-foreground outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                disabled={savingEdit}
                onChange={(event) => setEditDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditingUser(false)
                    return
                  }
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    void saveEditedUserMessage()
                  }
                }}
                value={editDraft}
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-[11px] leading-4 text-muted-foreground">Ctrl/⌘ + Enter 保存并重新发送</span>
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-45"
                  disabled={savingEdit}
                  onClick={() => setEditingUser(false)}
                  type="button"
                >
                  <Xmark className="size-3.5" />
                  取消
                </button>
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-45"
                  disabled={savingEdit || (!editDraft.trim() && userFileParts.length === 0)}
                  onClick={() => { void saveEditedUserMessage() }}
                  type="button"
                >
                  <Check className="size-3.5" />
                  {savingEdit ? '正在重新发送…' : '保存并重新发送'}
                </button>
              </div>
            </div>
          )}
          {orderedSegments.map((segment, segmentIndex) => {
            const isLastSegment = segmentIndex === orderedSegments.length - 1
            if (segment.kind === 'chain') {
              // 一条助手消息只能有一个执行流。source/data 等不可见 part 可能把 AI SDK 的
              // reasoning/tool parts 切成多段，但它们仍属于同一次处理，统一收进首个执行容器。
              if (segmentIndex !== firstExecutionSegmentIndex) return null
              return renderExecutionContainer(`chain-${segment.items[0]?.index ?? 0}`)
            }
            const { part, index } = segment
            if (part.type === 'text') {
              if (stageTextPartIndexes.has(index)) {
                // 调查者可能先输出阶段说明，再发起首个工具调用。此时尚没有 chain segment，
                // 仍要立即显示唯一的执行过程容器，而不是让界面暂时空白。
                if (segmentIndex === firstExecutionSegmentIndex) {
                  return renderExecutionContainer(`stage-${index}`)
                }
                return null
              }
              if (message.role === 'user' && editingUser) return null
              const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
              if (!displayText) return null
              if (message.role === 'user') {
                return (
                  <InlineMentionText
                    key={`text-${index}`}
                    segments={userDisplay?.segmentsByPartIndex.get(index) || [{ kind: 'text', text: displayText }]}
                  />
                )
              }
              return (
                <MessageResponse
                  className="agent-response-block"
                  isStreaming={assistantTextStreaming && isLastSegment}
                  key={`text-${index}`}
                  showStreamingIndicator={false}
                >
                  {displayText}
                </MessageResponse>
              )
            }
            if (part.type === 'file') {
              if (message.role === 'user') return null
              return (
                <MessageAttachments key={`file-${index}`}>
                  <MessageAttachment data={part} />
                </MessageAttachments>
              )
            }
            if (part.type === 'data-compaction') {
              if (segmentIndex === firstExecutionSegmentIndex) {
                return renderExecutionContainer(`compaction-${index}`)
              }
              return null
            }
            return null
          })}
          {assistantTextStreaming && <MessageStreamingIndicator />}
          {message.role === 'assistant' && <MessageWebSources items={webSources} />}
          {assistantAnswerFinished && (
            <MessageSources
              items={sources.items}
              nameOf={resolvedSessionNameOf}
              onOpenSource={onOpenSource}
              total={sources.total}
              truncated={sources.truncated}
            />
          )}
          {message.role === 'assistant' && !(isLastMessage && busy) && (
            <MessageUsageStats
              canRegenerate={selectedModelSupportsTools}
              copied={copied}
              metadata={message.metadata}
              messageText={assistantDisplayText}
              onCopy={() => onCopyMessage(message.id, assistantDisplayText)}
              onOpenDetails={onOpenUsageDetails}
              onRegenerate={() => onRegenerate(messageIndex)}
              onSpeak={() => onSpeak(message.id, assistantDisplayText)}
              onFork={canForkFromHere ? () => { void onForkFromHere(messageIndex) } : undefined}
              feedback={feedback}
              onFeedback={(value) => onFeedback(message.id, value)}
              regenerateDisabled={busy}
              regenerating={regenerating}
              speaking={speaking}
            />
          )}
        </MessageContent>
      )}
      {message.role === 'user' && !editingUser && (
        <div aria-label="用户消息操作" className="agent-user-message-meta">
          {validUserMessageDate && (
            <time dateTime={validUserMessageDate.toISOString()} title={USER_MESSAGE_DATE_TIME_FORMATTER.format(validUserMessageDate)}>
              {USER_MESSAGE_TIME_FORMATTER.format(validUserMessageDate)}
            </time>
          )}
          <div className="agent-user-message-actions" role="group">
            <MessageAction
              className="agent-user-message-action"
              label={copied ? '已复制' : '复制'}
              onClick={() => onCopyMessage(message.id, editableUserText)}
              tooltip={copied ? '已复制' : '复制消息'}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </MessageAction>
            {canEditUser && (
              <MessageAction
                className="agent-user-message-action"
                label="编辑"
                onClick={() => {
                  setEditDraft(editableUserText)
                  setEditingUser(true)
                }}
                tooltip="编辑最后一条消息"
              >
                <PencilLine className="size-3.5" />
              </MessageAction>
            )}
          </div>
        </div>
      )}
    </Message>
  )
}

function propsAreEqual(prev: AgentMessageItemProps, next: AgentMessageItemProps): boolean {
  // AI SDK 7 会在内容变化时替换当前 assistant 消息对象；message 引用就是完整且可靠
  // 的更新边界。不能仅因“最后一条/正在忙”就强制重渲染，否则父组件的无关状态变化
  // 也会每次重建工具卡片和动画树。
  if (prev.message !== next.message) return false
  if (prev.messageIndex !== next.messageIndex) return false
  if (prev.isLastMessage !== next.isLastMessage) return false
  if (prev.busy !== next.busy) return false
  if (prev.status !== next.status) return false
  if (prev.selectedModelSupportsTools !== next.selectedModelSupportsTools) return false
  if (prev.copied !== next.copied) return false
  if (prev.speaking !== next.speaking) return false
  if (prev.regenerating !== next.regenerating) return false
  if (prev.canEditUser !== next.canEditUser) return false
  if (prev.sentAt !== next.sentAt) return false
  if (prev.canForkFromHere !== next.canForkFromHere) return false
  if (prev.feedback !== next.feedback) return false
  if (prev.sessionNameOf !== next.sessionNameOf) return false
  if (prev.mentionTargetOf !== next.mentionTargetOf) return false
  // 这几个只有"这条正好是正在流式输出的最后一条"时才会体现在渲染结果里；
  // 历史消息自己的工具耗时/子助手进度早就定型了，二者再怎么变都不用重渲染历史消息。
  if (next.isLastMessage) {
    if (prev.toolElapsedByKey !== next.toolElapsedByKey) return false
    if (prev.subAgentProgress !== next.subAgentProgress) return false
    if (prev.liveToolStartedAtByKey !== next.liveToolStartedAtByKey) return false
    if (prev.liveExecutionElapsedBeforeMs !== next.liveExecutionElapsedBeforeMs) return false
    if (prev.liveExecutionSegmentStartedAt !== next.liveExecutionSegmentStartedAt) return false
  }
  return true
}

export const AgentMessageItem = memo(AgentMessageItemImpl, propsAreEqual)
AgentMessageItem.displayName = 'AgentMessageItem'
