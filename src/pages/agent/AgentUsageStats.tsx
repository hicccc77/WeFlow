/**
 * 消息用量与费用统计：token 明细格式化、按本地模型价格表估算费用，以及消息底部操作条和详情弹窗。
 * 本文件从 AgentPage.tsx 拆出。
 */
import { useState, type ReactNode } from 'react'
import { Button as HeroButton, Modal } from '@heroui/react'
import {
  ArrowsRotateLeft,
  BranchesRightArrowRight,
  ChartColumn,
  Check,
  ChevronDown,
  CircleCheck,
  CircleInfo,
  Clock,
  Copy,
  Database,
  Layers,
  Volume,
  Xmark,
} from '@gravity-ui/icons'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { UIMessage } from 'ai'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import type { AIModelInfo } from '@/types/ai'
import { finiteNumber, parseAgentMessageMetadata, type AgentMessageMetadata } from './agentConversationHelpers'
import { formatToolName } from './agentMessageHelpers'

export function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatEstimatedCost(value: number): string {
  if (value <= 0) return '约 $0.0000'
  return `约 $${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`
}

export function formatDurationMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(Math.round(value / 100) / 10).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function localCalendarDay(value: number): number {
  const date = new Date(value)
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatClockTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTaskCompletionTime(value: number, now = Date.now()): string {
  const date = new Date(value)
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return ''
  const daysAgo = Math.max(0, Math.round((localCalendarDay(now) - localCalendarDay(value)) / 86_400_000))
  if (daysAgo === 0) return `已于 ${formatClockTime(date)} 完成`
  if (daysAgo === 1) return '已于昨天完成'
  if (daysAgo === 2) return '已于前天完成'
  return `已于 ${daysAgo} 天前完成`
}

export function formatAbsoluteTaskCompletionTime(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return ''
  return `已于 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${formatClockTime(date)} 完成`
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

export function formatFinishReason(value: string): string {
  switch (value) {
    case 'stop':
      return '正常结束'
    case 'tool-calls':
      return '工具调用'
    case 'length':
      return '长度限制'
    case 'content-filter':
      return '内容过滤'
    case 'error':
      return '出错'
    case 'other':
      return '其他'
    default:
      return value
  }
}

function estimateUsageCost(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  if (!cost) return null

  const inputTokens = finiteNumber(usage.inputTokens)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(usage.inputTokenDetails?.cacheWriteTokens)
  const noCacheTokens = finiteNumber(usage.inputTokenDetails?.noCacheTokens)
    ?? (inputTokens !== undefined
      ? Math.max(0, inputTokens - (cacheReadTokens || 0) - (cacheWriteTokens || 0))
      : undefined)
  const outputTokens = finiteNumber(usage.outputTokens)

  let total = 0
  let priced = false
  const add = (tokens: number | undefined, pricePerMillion: number | undefined) => {
    if (tokens === undefined || pricePerMillion === undefined) return
    total += (tokens / 1_000_000) * pricePerMillion
    priced = true
  }

  add(noCacheTokens, cost.input)
  add(cacheReadTokens, cost.cacheRead ?? cost.input)
  add(cacheWriteTokens, cost.cacheWrite ?? cost.input)
  add(outputTokens, cost.output)
  return priced ? total : null
}

function estimateCacheSavings(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  const inputPrice = finiteNumber(cost?.input)
  const cacheReadPrice = finiteNumber(cost?.cacheRead)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  if (inputPrice === undefined || cacheReadPrice === undefined || cacheReadTokens === undefined || cacheReadTokens <= 0) return null
  return Math.max(0, (cacheReadTokens / 1_000_000) * (inputPrice - cacheReadPrice))
}

function formatCacheProvider(value: string | undefined): string {
  switch (value) {
    case 'openai-responses':
      return 'OpenAI Responses'
    case 'anthropic':
      return 'Anthropic'
    case 'google':
      return 'Google'
    case 'openai-compatible':
      return 'OpenAI-compatible'
    case 'none':
      return '未识别'
    default:
      return value || '未知'
  }
}

function formatContextSource(value: 'manual' | 'catalog' | 'inferred' | 'default' | undefined): string {
  switch (value) {
    case 'manual':
      return '手动设置'
    case 'catalog':
      return '模型目录'
    case 'inferred':
      return '智能推断'
    case 'default':
      return '安全默认值'
    default:
      return '未知来源'
  }
}

function truncateCacheKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > 56 ? `${value.slice(0, 28)}…${value.slice(-16)}` : value
}

function cacheHitRateNote(metadata: AgentMessageMetadata, cacheReadTokens: number | undefined): string | undefined {
  const providerCache = metadata.agent?.providerCache || metadata.ciphertalk?.providerCache
  if (providerCache?.promptCacheEnabled === false) {
    return providerCache.reason || '当前 provider 未启用可控 prompt cache'
  }
  if (cacheReadTokens === undefined) {
    return providerCache?.promptCacheEnabled
      ? '已发送缓存参数，但服务商未返回缓存读 token'
      : '服务商未返回缓存读 token'
  }
  if (cacheReadTokens <= 0) {
    return providerCache?.promptCacheEnabled
      ? '已发送缓存参数，本次未命中 provider 侧缓存'
      : '服务商返回 0 个缓存读 token'
  }
  return providerCache?.promptCacheEnabled ? 'provider 侧缓存已命中' : undefined
}

type UsageDetailRow = {
  id: string
  label: string
  value: ReactNode
  note?: string
}

const USAGE_SUMMARY_DEFINITIONS = [
  { id: 'traceTotalElapsed', label: '任务耗时', icon: Clock, tone: 'time' },
  { id: 'totalTokens', label: '模型请求累计 Token', icon: Layers, tone: 'tokens' },
  { id: 'cacheHitRate', label: '缓存命中', icon: Database, tone: 'cache' },
  { id: 'estimatedCost', label: '估算费用', icon: ChartColumn, tone: 'cost' },
  { id: 'finishReason', label: '完成状态', icon: CircleCheck, tone: 'status' },
] as const

const USAGE_SECTION_DEFINITIONS = [
  {
    id: 'overview',
    title: '回答概览',
    description: '模型选择与本轮完成状态',
    wide: false,
    rowIds: ['model', 'textRedaction', 'finishReason'],
  },
  {
    id: 'context',
    title: '上下文与预算',
    description: '模型可见范围及最终成文额度',
    wide: false,
    rowIds: ['contextWindow', 'finalAnswerBudget', 'finalAnswerUsed', 'finalAnswerSegments', 'contextEstimate'],
  },
  {
    id: 'tokens',
    title: 'Token 构成',
    description: '本轮全部模型请求的累计用量',
    wide: false,
    rowIds: ['usageScope', 'inputTokens', 'noCacheTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'textTokens', 'reasoningTokens'],
  },
  {
    id: 'execution',
    title: '阅读与执行',
    description: '原文阅读、建议性检查点、模型步骤与工具性能',
    wide: false,
    rowIds: [
      'researchReadPages', 'researchCheckpoints', 'researchFeedback', 'researchToolResults',
      'traceFirstOutput', 'traceSteps', 'traceTools', 'traceSlowestTool',
    ],
  },
  {
    id: 'cache',
    title: 'Prompt Cache',
    description: '服务商缓存策略与本轮命中情况',
    wide: true,
    rowIds: ['providerCacheStatus', 'providerCacheKey', 'providerCacheField', 'providerCacheRetention'],
  },
] as const

const USAGE_TECHNICAL_ROW_IDS = new Set<string>(['agentDebugLog', 'traceStepDetails', 'traceToolDetails', 'rawUsage'])

export function buildUsageDetailRows(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): UsageDetailRow[] {
  const rows: UsageDetailRow[] = []
  const usage = metadata.usage
  const add = (id: string, label: string, value: unknown, note?: string) => {
    if (value === undefined || value === null || value === '') return
    rows.push({ id, label, value: String(value), note })
  }
  const addTokens = (id: string, label: string, value: unknown, note?: string) => {
    const n = finiteNumber(value)
    if (n !== undefined) rows.push({ id, label, value: formatTokenCount(n), note })
  }

  add('model', '模型', [metadata.modelProvider, metadata.modelId].filter(Boolean).join(' / '))
  const privacy = metadata.agent?.privacy
  if (privacy && ((privacy.phoneMatches || 0) > 0 || (privacy.identityCardMatches || 0) > 0)) {
    add(
      'textRedaction',
      '文本脱敏',
      `手机号 ${privacy.phoneMatches || 0} 处，身份证 ${privacy.identityCardMatches || 0} 处`,
      `发送模型前已替换；不同手机号 ${privacy.uniquePhones || 0} 个，不同身份证 ${privacy.uniqueIdentityCards || 0} 个`,
    )
  }
  if (metadata.finishReason) add('finishReason', '结束原因', formatFinishReason(metadata.finishReason), metadata.rawFinishReason)
  addTokens(
    'contextWindow',
    '上下文窗口',
    metadata.context?.contextWindow,
    metadata.context?.contextWindowSource ? formatContextSource(metadata.context.contextWindowSource) : undefined,
  )
  addTokens('finalAnswerBudget', '最终成文预算', metadata.context?.finalAnswerBudget ?? metadata.context?.maxOutputTokens)
  addTokens('finalAnswerUsed', '最终成文已用', metadata.context?.finalAnswerTokensUsed)
  add('finalAnswerSegments', '成文请求段数', metadata.context?.finalAnswerSegments)
  add('agentDebugLog', '调试日志', metadata.agent?.debugLogPath)
  const research = metadata.agent?.research
  if (research) {
    const investigationSteps = research.investigationPlan?.steps || []
    if (investigationSteps.length > 0) {
      const completed = investigationSteps.filter((step) => step.status === 'completed').length
      const inProgress = investigationSteps.filter((step) => step.status === 'in_progress').length
      const skipped = investigationSteps.filter((step) => step.status === 'skipped').length
      add(
        'investigationPlan',
        '模型调查计划',
        `${completed}/${investigationSteps.length} 已完成`,
        `进行中 ${inProgress} 项，跳过 ${skipped} 项；只用于追踪，不决定是否允许回答`,
      )
    }
    add('researchReadPages', '已读原文页', research.readPages?.length || 0)
    add('researchFeedback', '建议反馈', research.feedback?.length || 0)
    add('researchToolResults', '工具结果', research.toolResultCount || 0)
  }
  addTokens(
    'contextEstimate',
    metadata.context?.compacted ? '首次请求前压缩前估算' : '首次请求前上下文估算',
    metadata.context?.estimatedTokensBefore,
    metadata.context?.compacted && metadata.context.estimatedTokensAfter !== undefined
      ? `压缩后约 ${formatTokenCount(metadata.context.estimatedTokensAfter)} tokens`
      : undefined,
  )

  const providerCache = metadata.agent?.providerCache || metadata.ciphertalk?.providerCache
  if (providerCache) {
    add(
      'providerCacheStatus',
      'Prompt cache',
      providerCache.promptCacheEnabled ? '已启用' : '未启用',
      [
        formatCacheProvider(providerCache.promptCacheProvider),
        providerCache.reason,
      ].filter(Boolean).join('；'),
    )
    add('providerCacheKey', '缓存 key', truncateCacheKey(providerCache.promptCacheKey), '用于 provider 侧 prompt cache 分组')
    add('providerCacheField', '请求字段', providerCache.requestBodyPromptCacheField, '实际写入 provider 请求体的缓存字段')
    add('providerCacheRetention', '缓存保留', providerCache.promptCacheRetention, 'OpenAI 5.1 系列支持 24h；未显示则使用 provider 默认')
  }

  const trace = metadata.agent?.trace || metadata.ciphertalk?.trace
  const requestCount = finiteNumber(trace?.stepCount)
    ?? (Array.isArray(trace?.steps) ? trace.steps.length : 0)
  if (usage && requestCount > 0) {
    add(
      'usageScope',
      '统计范围',
      `${requestCount} 次模型请求累计`,
      '同一条用户问题会在调查、阅读和成文阶段触发多次模型请求；累计用量不等于任意一次请求的上下文占用',
    )
  }
  addTokens('inputTokens', '累计输入 tokens', usage?.inputTokens)
  const cacheReadTokens = finiteNumber(usage?.inputTokenDetails?.cacheReadTokens)
  const cacheHitRate = finiteNumber(usage?.cacheHitRate)
    ?? (() => {
      const inputTokens = finiteNumber(usage?.inputTokens)
      return inputTokens && cacheReadTokens !== undefined ? cacheReadTokens / inputTokens : undefined
    })()
  if (cacheHitRate !== undefined) add('cacheHitRate', '缓存命中率', formatPercent(cacheHitRate), cacheHitRateNote(metadata, cacheReadTokens))
  else if (providerCache) add('cacheHitRate', '缓存命中率', '未返回', cacheHitRateNote(metadata, cacheReadTokens))
  addTokens('noCacheTokens', '其中普通输入', usage?.inputTokenDetails?.noCacheTokens)
  addTokens('cacheReadTokens', '其中缓存读取', cacheReadTokens, '已包含在累计输入中，不会再次计入总量')
  addTokens('cacheWriteTokens', '其中缓存写入', usage?.inputTokenDetails?.cacheWriteTokens)
  addTokens('outputTokens', '累计输出 tokens', usage?.outputTokens)
  addTokens('textTokens', '其中文本输出', usage?.outputTokenDetails?.textTokens)
  addTokens('reasoningTokens', '其中推理输出', usage?.outputTokenDetails?.reasoningTokens)
  addTokens('totalTokens', '模型请求累计 tokens', usage?.totalTokens, '服务商返回的各次模型请求用量之和；缓存读取属于输入，不会重复相加')

  const estimatedCost = estimateUsageCost(metadata, modelInfoByKey)
  if (estimatedCost !== null) add('estimatedCost', '估算费用', formatEstimatedCost(estimatedCost), '按本地模型价格表估算')
  const cacheSavings = estimateCacheSavings(metadata, modelInfoByKey)
  if (cacheSavings !== null && cacheSavings > 0) add('cacheSavings', '缓存节省', formatEstimatedCost(cacheSavings), '按普通输入价与缓存读价差估算')

  if (trace) {
    const traceSteps = Array.isArray(trace.steps) ? trace.steps : []
    const traceTools = Array.isArray(trace.tools) ? trace.tools : []
    add('traceTotalElapsed', '总耗时', trace.totalElapsedMs !== undefined ? formatDurationMs(trace.totalElapsedMs) : undefined, 'Agent 本轮端到端耗时')
    add('traceFirstOutput', '首个输出', trace.firstOutputMs !== undefined ? formatDurationMs(trace.firstOutputMs) : undefined, '从开始到首次文本/推理/工具输入')
    add('traceSteps', '模型请求数', finiteNumber(trace.stepCount) ?? traceSteps.length)
    add('traceTools', '工具调用数', finiteNumber(trace.toolCount) ?? traceTools.length)
    const slowestTool = traceTools.reduce((best, item) => (item.elapsedMs > (best?.elapsedMs ?? -1) ? item : best), undefined as (typeof traceTools)[number] | undefined)
    if (slowestTool) add('traceSlowestTool', '最慢工具', `${formatToolName(slowestTool.toolName)} · ${formatDurationMs(slowestTool.elapsedMs)}`, slowestTool.error)
    if (traceSteps.length > 0) {
      rows.push({
        id: 'traceStepDetails',
        label: '模型步骤耗时',
        value: (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-(--agent-radius,12px) border border-border/50 bg-card/50 p-3 text-xs leading-5">
            {traceSteps.map((step) => [
              `第 ${step.stepNumber + 1} 步`,
              step.provider && step.modelId ? `${step.provider}/${step.modelId}` : undefined,
              step.elapsedMs !== undefined ? `耗时=${formatDurationMs(step.elapsedMs)}` : undefined,
              step.responseMs !== undefined ? `响应=${formatDurationMs(step.responseMs)}` : undefined,
              step.timeToFirstOutputMs !== undefined ? `首输出=${formatDurationMs(step.timeToFirstOutputMs)}` : undefined,
              step.usage?.inputTokens !== undefined ? `输入=${formatTokenCount(step.usage.inputTokens)}` : undefined,
              step.usage?.inputTokenDetails?.cacheReadTokens !== undefined ? `缓存读取=${formatTokenCount(step.usage.inputTokenDetails.cacheReadTokens)}` : undefined,
              step.finishReason ? `结束原因=${formatFinishReason(step.finishReason)}` : undefined,
              step.usage?.raw ? `原始数据=${JSON.stringify(step.usage.raw)}` : undefined,
            ].filter(Boolean).join(' · ')).join('\n')}
          </pre>
        ),
        note: 'AI SDK 7 性能追踪',
      })
    }
    if (traceTools.length > 0) {
      rows.push({
        id: 'traceToolDetails',
        label: '工具耗时',
        value: (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-(--agent-radius,12px) border border-border/50 bg-card/50 p-3 text-xs leading-5">
            {traceTools.map((item) => [
              formatToolName(item.toolName),
              formatDurationMs(item.elapsedMs),
              item.error ? `错误=${item.error}` : undefined,
            ].filter(Boolean).join(' · ')).join('\n')}
          </pre>
        ),
        note: 'AI SDK 7 工具执行追踪',
      })
    }
  }

  if (usage?.raw) {
    rows.push({
      id: 'rawUsage',
      label: '服务商原始用量',
      value: (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-(--agent-radius,12px) border border-border/50 bg-card/50 p-3 text-xs leading-5">
          {JSON.stringify(usage.raw, null, 2)}
        </pre>
      ),
    })
  }

  return rows
}

export function messageTextOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

export type AgentMessageFeedback = {
  rating: 'up' | 'down'
  reason?: AgentFeedbackReason
  at: number
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

const POSITIVE_FEEDBACK_REASONS: ReadonlyArray<readonly [AgentFeedbackReason, string]> = [
  ['direct', '直接切题'],
  ['clear', '表达清楚'],
  ['thorough', '分析充分'],
  ['evidence', '证据扎实'],
  ['tone', '语气合适'],
  ['method', '方法合适'],
]

const NEGATIVE_FEEDBACK_REASONS: ReadonlyArray<readonly [AgentFeedbackReason, string]> = [
  ['incorrect', '事实不准确'],
  ['missing', '漏掉重点'],
  ['overreach', '推断过度'],
  ['unclear', '表达不清'],
  ['verbose', '太啰嗦'],
  ['shallow', '不够深入'],
  ['tone', '语气不合适'],
  ['method', '方法不合适'],
]

export function MessageUsageStats({
  canRegenerate,
  metadata,
  messageText,
  copied,
  regenerateDisabled,
  regenerating,
  speaking,
  onCopy,
  onOpenDetails,
  onRegenerate,
  onSpeak,
  onFork,
  feedback,
  onFeedback,
}: {
  canRegenerate: boolean
  metadata: unknown
  messageText: string
  copied: boolean
  regenerateDisabled: boolean
  regenerating: boolean
  speaking: boolean
  onCopy: () => void
  onOpenDetails: (data: AgentMessageMetadata) => void
  onRegenerate: () => void
  onSpeak: () => void
  onFork?: () => void
  feedback?: AgentMessageFeedback
  onFeedback: (feedback: AgentMessageFeedback | null) => void
}) {
  const parsed = parseAgentMessageMetadata(metadata)
  const [showFeedbackReasons, setShowFeedbackReasons] = useState(feedback?.rating === 'down')
  const [showAbsoluteCompletionTime, setShowAbsoluteCompletionTime] = useState(false)
  if (!parsed && !messageText) return null

  const trace = parsed?.agent?.trace || parsed?.ciphertalk?.trace
  const traceTotalElapsed = finiteNumber(trace?.totalElapsedMs)
  const traceStartedAt = finiteNumber(trace?.startedAt)
  const traceFinishedAt = finiteNumber(trace?.finishedAt)
  const completedAt = traceFinishedAt !== undefined && traceFinishedAt > 0
    ? traceFinishedAt
    : traceStartedAt !== undefined && traceStartedAt > 0 && traceTotalElapsed !== undefined && traceTotalElapsed >= 0
      ? traceStartedAt + traceTotalElapsed
      : undefined
  const relativeCompletionTime = completedAt !== undefined ? formatTaskCompletionTime(completedAt) : ''
  const absoluteCompletionTime = completedAt !== undefined ? formatAbsoluteTaskCompletionTime(completedAt) : ''

  return (
    <div className="min-h-10 border-border/50 border-t pt-2.5 text-xs leading-5 text-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <MessageActions className="shrink-0">
          <MessageAction
            disabled={!messageText}
            label="复制"
            onClick={onCopy}
            tooltip={copied ? '已复制' : '复制'}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </MessageAction>
          <MessageAction
            aria-pressed={feedback?.rating === 'up'}
            label="有帮助"
            onClick={() => {
              if (feedback?.rating === 'up') {
                setShowFeedbackReasons(false)
                onFeedback(null)
                return
              }
              setShowFeedbackReasons(true)
              onFeedback({ rating: 'up', at: Date.now() })
            }}
            tooltip={feedback?.rating === 'up' ? '已记录为有帮助，点击取消' : '有帮助 · 多次相似反馈可改进记忆'}
          >
            <ThumbsUp className={`size-3.5 ${feedback?.rating === 'up' ? 'fill-current text-primary' : ''}`} />
          </MessageAction>
          <MessageAction
            aria-pressed={feedback?.rating === 'down'}
            label="需要改进"
            onClick={() => {
              if (feedback?.rating === 'down') {
                setShowFeedbackReasons(false)
                onFeedback(null)
                return
              }
              setShowFeedbackReasons(true)
              onFeedback({ rating: 'down', at: Date.now() })
            }}
            tooltip={feedback?.rating === 'down' ? '已记录为需要改进，点击取消' : '需要改进 · 多次相似反馈可改进记忆'}
          >
            <ThumbsDown className={`size-3.5 ${feedback?.rating === 'down' ? 'fill-current text-destructive' : ''}`} />
          </MessageAction>
          <MessageAction
            disabled={!messageText}
            label={speaking ? '停止播放' : '播放'}
            onClick={onSpeak}
            tooltip={speaking ? '停止播放' : '播放'}
          >
            <Volume className={`size-3.5 ${speaking ? 'text-accent-foreground' : ''}`} />
          </MessageAction>
          <MessageAction
            disabled={!canRegenerate || regenerateDisabled}
            label="重新生成"
            onClick={onRegenerate}
            tooltip="重新生成"
          >
            <ArrowsRotateLeft className={`size-3.5 ${regenerating ? 'animate-spin motion-reduce:animate-none' : ''}`} />
          </MessageAction>
          {onFork && (
            <MessageAction
              disabled={regenerateDisabled}
              label="从这里续聊"
              onClick={onFork}
              tooltip="从这里创建续聊"
            >
              <BranchesRightArrowRight className="size-3.5" />
            </MessageAction>
          )}
          <MessageAction
            disabled={!parsed}
            label="详情"
            onClick={() => parsed && onOpenDetails(parsed)}
            startsGroup
            tooltip="详情"
          >
            <CircleInfo className="size-3.5" />
          </MessageAction>
        </MessageActions>
        {completedAt !== undefined && relativeCompletionTime && absoluteCompletionTime && (
          <button
            aria-label={`${showAbsoluteCompletionTime ? absoluteCompletionTime : relativeCompletionTime}，点击${showAbsoluteCompletionTime ? '显示相对时间' : '显示绝对日期'}`}
            aria-live="polite"
            aria-pressed={showAbsoluteCompletionTime}
            className="agent-completion-time"
            onClick={() => setShowAbsoluteCompletionTime((value) => !value)}
            title={showAbsoluteCompletionTime ? '点击显示相对完成时间' : `${absoluteCompletionTime}，点击显示绝对日期`}
            type="button"
          >
            {showAbsoluteCompletionTime ? absoluteCompletionTime : relativeCompletionTime}
          </button>
        )}
      </div>
      {showFeedbackReasons && feedback && (
        <div aria-label={feedback.rating === 'up' ? '选择回答做得好的地方' : '选择回答需要改进的地方'} className="agent-feedback-detail">
          <div className="agent-feedback-detail-heading">
            <span>{feedback.rating === 'up' ? '哪里做得好？' : '哪里需要改进？'}</span>
            <small>可选 · 多个回答出现一致信号后才会更新记忆</small>
          </div>
          <div className="agent-feedback-reasons" role="group">
          {(feedback.rating === 'up' ? POSITIVE_FEEDBACK_REASONS : NEGATIVE_FEEDBACK_REASONS).map(([reason, label]) => (
            <button
              aria-pressed={feedback?.reason === reason}
              data-selected={feedback?.reason === reason || undefined}
              key={reason}
              type="button"
              onClick={() => onFeedback({ rating: 'down', reason, at: Date.now() })}
            >
              {label}
            </button>
          ))}
          </div>
        </div>
      )}
      {feedback && !showFeedbackReasons && (
        <p aria-live="polite" className="agent-feedback-learning-note">
          已记录；系统只会根据多个回答中的稳定倾向逐步调整记忆。
        </p>
      )}
    </div>
  )
}

export function UsageDetailsModal({
  data,
  modelInfoByKey,
  onClose,
}: {
  data: AgentMessageMetadata
  modelInfoByKey: Map<string, AIModelInfo>
  onClose: () => void
}) {
  const rows = buildUsageDetailRows(data, modelInfoByKey)
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const summaryItems = USAGE_SUMMARY_DEFINITIONS
    .flatMap((definition) => {
      const row = rowById.get(definition.id)
      return row ? [{ ...definition, row }] : []
    })
    .slice(0, 4)
  const summaryIds = new Set<string>(summaryItems.map((item) => item.id))
  const sectionRowIds = new Set<string>(USAGE_SECTION_DEFINITIONS.flatMap((section) => [...section.rowIds]))
  const sections = USAGE_SECTION_DEFINITIONS.flatMap((definition) => {
    const sectionRows = definition.rowIds.flatMap((id) => {
      if (summaryIds.has(id)) return []
      const row = rowById.get(id)
      return row ? [row] : []
    })
    return sectionRows.length > 0 ? [{ ...definition, rows: sectionRows }] : []
  })
  const technicalRows = rows.filter((row) => (
    !summaryIds.has(row.id)
    && (USAGE_TECHNICAL_ROW_IDS.has(row.id) || !sectionRowIds.has(row.id))
  ))

  return (
    <Modal>
      <Modal.Backdrop isOpen variant="blur" onOpenChange={(open) => { if (!open) onClose() }}>
        <Modal.Container className="agent-usage-modal-container" placement="center">
          <Modal.Dialog aria-label="本轮任务报告" className="agent-usage-dialog">
            <Modal.Header className="agent-usage-modal-header">
              <span className="agent-usage-heading-icon">
                <ChartColumn className="size-5" />
              </span>
              <span className="agent-usage-heading-copy">
                <Modal.Heading className="agent-usage-heading-title">本轮任务报告</Modal.Heading>
                <span>模型调用、上下文预算与执行性能</span>
              </span>
              <Modal.CloseTrigger aria-label="关闭任务报告" className="agent-usage-close">
                <Xmark className="size-4" />
              </Modal.CloseTrigger>
            </Modal.Header>
            <Modal.Body className="agent-usage-modal-body agent-scrollbar">
              {summaryItems.length > 0 && (
                <section aria-label="本轮摘要" className="agent-usage-summary">
                  {summaryItems.map(({ id, icon: Icon, label, row, tone }) => (
                    <article className="agent-usage-summary-card" data-tone={tone} key={id}>
                      <span className="agent-usage-summary-icon"><Icon className="size-4" /></span>
                      <span className="agent-usage-summary-label">{label}</span>
                      <strong>{row.value}</strong>
                    </article>
                  ))}
                </section>
              )}

              <div className="agent-usage-section-grid">
                {sections.map((section) => (
                  <section className="agent-usage-section" data-wide={section.wide || undefined} key={section.id}>
                    <header>
                      <h3>{section.title}</h3>
                      <p>{section.description}</p>
                    </header>
                    <dl>
                      {section.rows.map((row) => (
                        <div className="agent-usage-field" key={row.id}>
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                          {row.note && <p>{row.note}</p>}
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>

              {technicalRows.length > 0 && (
                <details className="agent-usage-technical">
                  <summary>
                    <span>
                      <strong>技术详情</strong>
                      <small>步骤耗时、调试路径与服务商原始数据</small>
                    </span>
                    <ChevronDown className="size-4" />
                  </summary>
                  <dl>
                    {technicalRows.map((row) => (
                      <div className="agent-usage-technical-field" key={row.id}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                        {row.note && <p>{row.note}</p>}
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </Modal.Body>
            <Modal.Footer className="agent-usage-modal-footer">
              <span>统计覆盖这一次回答中的全部模型请求</span>
              <HeroButton size="sm" variant="primary" onPress={onClose}>完成</HeroButton>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
