/**
 * 消息渲染用的小型展示组件：模型能力图标、模型下拉项、计划卡片、压缩标记、执行过程折叠框、用户消息操作条。
 * 本文件从 AgentPage.tsx 拆出。
 */
import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Dropdown, Label } from '@heroui/react'
import { Bulb, ChevronDown, CurlyBrackets, FileText, Picture, Wrench } from '@gravity-ui/icons'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtDisclosureStep,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import type { IconComponent } from '@/types/icon'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import type { AIModelInfo } from '@/types/ai'
import { formatToolName } from './agentMessageHelpers'
import { toolInputSummaryRows, type ToolCallOutcome } from './agentToolInputSummary'
import {
  agentToolResultLabel,
  agentToolResultSummary,
  collectToolSessionDisplayNames,
} from './agentToolPresentation'

export type AgentModelItem = {
  chef: string
  chefSlug: string
  id: string
  name: string
  modelDetail?: AIModelInfo
  disabled?: boolean
}

// 与设置页 ModelCapabilityStrip 使用同一套能力图标。
const CAPABILITY_ICONS = [
  { key: 'reasoning', label: '推理', icon: Bulb, on: (d: AIModelInfo) => d.capabilities.reasoning },
  { key: 'tool', label: '工具调用', icon: Wrench, on: (d: AIModelInfo) => d.capabilities.toolCall },
  { key: 'structured', label: '结构化输出', icon: CurlyBrackets, on: (d: AIModelInfo) => d.capabilities.structuredOutput },
  { key: 'image', label: '图像输入', icon: Picture, on: (d: AIModelInfo) => d.modalities.input.includes('image') },
  { key: 'pdf', label: 'PDF', icon: FileText, on: (d: AIModelInfo) => d.modalities.input.includes('pdf') },
]

export function ModelCapabilityIcons({ detail }: { detail: AIModelInfo }) {
  const active = CAPABILITY_ICONS.filter((item) => item.on(detail))
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {active.map(({ key, label, icon: Icon }) => (
        <span className="inline-flex" key={key} title={`${label}：支持`}>
          <Icon className="size-3.5" />
        </span>
      ))}
    </span>
  )
}

export const ModelItem = memo(
  ({ model }: { model: AgentModelItem }) => {
    return (
      <Dropdown.Item id={model.id} key={model.id} textValue={model.name}>
        <Dropdown.ItemIndicator />
        {model.chefSlug && <AIProviderLogo providerId={model.chefSlug} alt={model.chef} className="shrink-0" size={20} />}
        <Label className="min-w-0 flex-1 truncate text-left">{model.name}</Label>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {model.modelDetail && <ModelCapabilityIcons detail={model.modelDetail} />}
          {model.disabled && <span className="text-xs text-muted-foreground">无工具</span>}
        </span>
      </Dropdown.Item>
    )
  }
)
ModelItem.displayName = 'ModelItem'

// 上下文自动压缩标记（data-compaction part）：动态预算接近上限时，早期历史会被 AI 摘要折叠。
// 作为历史性记录持久落在消息里——点开看摘要，全程都在。
export type CompactionPartData = {
  summary?: string
  foldedMessages?: number
  approxTokensBefore?: number
  approxTokensAfter?: number
  contextWindow?: number
  foldedThroughMessageId?: string
  contextWindowSource?: 'manual' | 'catalog' | 'inferred' | 'default'
  modelId?: string
  reason?: 'context-pressure' | 'provider-overflow'
  createdAt?: number
}

export function CompactionMarker({ data, inline = false }: { data: CompactionPartData; inline?: boolean }) {
  const [open, setOpen] = useState(false)
  const summaryId = useId()
  const { approxTokensBefore: before, approxTokensAfter: after, contextWindow } = data
  const triggeredPct = before && contextWindow ? Math.round((before / contextWindow) * 100) : null
  const savedPct = before && after && before > after ? Math.round((1 - after / before) * 100) : null
  if (inline) {
    return (
      <div className="agent-compaction-inline">
        <button
          aria-controls={data.summary ? summaryId : undefined}
          aria-expanded={open}
          className="agent-compaction-inline-trigger"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <span aria-hidden="true" className="agent-chain-inline-icon">
            <FileText className="size-3.5" />
          </span>
          <span>上下文已自动压缩</span>
          <ChevronDown aria-hidden="true" className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && data.summary && (
          <div className="agent-compaction-inline-summary" id={summaryId}>{data.summary}</div>
        )}
      </div>
    )
  }
  return (
    <div className="my-3">
      <button
        aria-expanded={open}
        className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-(--agent-radius,12px) text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3 py-1">
          <FileText className="size-3.5 shrink-0" />
          上下文已自动压缩
          {triggeredPct != null && <span className="text-muted-foreground/80">· 触发于 {triggeredPct}%</span>}
          {savedPct != null && savedPct > 0 && <span className="text-muted-foreground/80">· 省 {savedPct}%</span>}
          <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
      {open && data.summary && (
        <div className="mt-2 whitespace-pre-wrap wrap-break-word rounded-(--agent-radius,12px) border border-border/50 bg-card/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          {data.summary}
        </div>
      )}
    </div>
  )
}

function ToolCallSummary({ callState, input, sessionNameOf, status, toolName, output, outcome = 'pending' }: {
  callState?: string
  input?: unknown
  sessionNameOf?: (sessionId: string) => string
  status: 'complete' | 'active' | 'pending'
  toolName: string
  output?: unknown
  outcome?: ToolCallOutcome
}) {
  const returnedSessionNames = collectToolSessionDisplayNames(output)
  const resolvedSessionNameOf = (sessionId: string) => returnedSessionNames.get(sessionId)
    || sessionNameOf?.(sessionId)
    || sessionId
  const inputRows = toolInputSummaryRows(toolName, input, {
    outcome,
    sessionNameOf: resolvedSessionNameOf,
    toolLabelOf: formatToolName,
  })
  const resultLabel = agentToolResultLabel(toolName, outcome)
  const visibleResultLabel = inputRows.some((row) => row.label === resultLabel)
    ? outcome === 'pending' || outcome === 'denied' ? '进度' : '结果'
    : resultLabel
  return (
    <div className="agent-tool-summary" role="status">
      {inputRows.map((row, index) => (
        <div className="agent-tool-summary-row" key={`${row.label}-${index}`}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
      <div className="agent-tool-summary-row">
        <span>{visibleResultLabel}</span>
        <p>{agentToolResultSummary(toolName, output, outcome, { callState, status })}</p>
      </div>
    </div>
  )
}

// 工具整行就是摘要的折叠触发器：进行中自动展开，结束后自动收起；用户点过后尊重手动状态。
export function ToolChainStep({ active, callState, children, icon, input, label, outcome, output, sessionNameOf, status, toolName }: {
  active: boolean
  callState?: string
  children?: ReactNode
  icon?: IconComponent
  input?: unknown
  label: ReactNode
  outcome?: ToolCallOutcome
  output?: unknown
  sessionNameOf?: (sessionId: string) => string
  status: 'complete' | 'active' | 'pending'
  toolName: string
}) {
  const [open, setOpen] = useState(active)
  const userToggledRef = useRef(false)
  useEffect(() => {
    if (!userToggledRef.current) setOpen(active)
  }, [active])
  return (
    <ChainOfThoughtDisclosureStep
      className="agent-tool-run"
      icon={icon}
      onOpenChange={(value) => { userToggledRef.current = true; setOpen(value) }}
      open={open}
      label={label}
      status={status}
    >
      {children}
      <ToolCallSummary callState={callState} input={input} outcome={outcome} output={output} sessionNameOf={sessionNameOf} status={status} toolName={toolName} />
    </ChainOfThoughtDisclosureStep>
  )
}

export function ToolChainGroup({ active, children, icon, label, status }: {
  active: boolean
  children: ReactNode
  icon?: IconComponent
  label: string
  status: 'complete' | 'active' | 'pending'
}) {
  const [open, setOpen] = useState(active)
  const userToggledRef = useRef(false)
  useEffect(() => {
    if (!userToggledRef.current) setOpen(active)
  }, [active])
  return (
    <ChainOfThoughtDisclosureStep
      className="agent-tool-group"
      icon={icon || Wrench}
      label={label}
      onOpenChange={(value) => { userToggledRef.current = true; setOpen(value) }}
      open={open}
      status={status}
    >
      <div className="agent-tool-group-items">{children}</div>
    </ChainOfThoughtDisclosureStep>
  )
}

// 推理默认展开，完成后也保持当前展开状态；只有用户主动点击时才收起。
export function ThinkingChainStep({ active, children }: {
  active: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <ChainOfThoughtDisclosureStep
      className="agent-thinking-phase"
      icon={Bulb}
      label="推理过程"
      onOpenChange={setOpen}
      open={open}
      status={active ? 'active' : 'complete'}
    >
      {children}
    </ChainOfThoughtDisclosureStep>
  )
}

function formatExecutionElapsed(ms: number): string {
  const totalSeconds = Math.max(1, Math.floor(ms / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}\u202Fh ${minutes}\u202Fm ${seconds}\u202Fs`
  if (minutes > 0) return `${minutes}\u202Fm ${seconds}\u202Fs`
  return `${totalSeconds}\u202Fs`
}

// 进行中默认展开；一旦进入正文阶段就强制收起一次，之后仍允许用户手动重开查看。
export function MessageChainOfThought({ active, children, elapsedMs, startedAt, stopped = false }: {
  active: boolean
  children: ReactNode
  elapsedMs?: number
  startedAt?: number
  stopped?: boolean
}) {
  const [open, setOpen] = useState(active)
  const [now, setNow] = useState(() => Date.now())
  const userToggledRef = useRef(false)
  const previousActiveRef = useRef(active)
  const hasExternalElapsed = typeof elapsedMs === 'number'
  useEffect(() => {
    const activeChanged = previousActiveRef.current !== active
    previousActiveRef.current = active
    if (activeChanged) {
      userToggledRef.current = false
      setOpen(active)
      return
    }
    if (!userToggledRef.current) setOpen(active)
  }, [active])
  useEffect(() => {
    if (!active || !startedAt || hasExternalElapsed) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active, hasExternalElapsed, startedAt])
  const resolvedElapsedMs = typeof elapsedMs === 'number'
    ? Math.max(0, elapsedMs)
    : active && startedAt
      ? Math.max(0, now - startedAt)
      : undefined
  const title = stopped
    ? resolvedElapsedMs === undefined ? '已停止' : `已在 ${formatExecutionElapsed(resolvedElapsedMs)} 后停止`
    : active
      ? resolvedElapsedMs === undefined ? '已处理' : `已处理 ${formatExecutionElapsed(resolvedElapsedMs)}`
      : resolvedElapsedMs === undefined ? '已处理' : `已处理 ${formatExecutionElapsed(resolvedElapsedMs)}`
  return (
    <ChainOfThought
      aria-label="AI 执行过程"
      className="agent-execution-flow rounded-none border-0 bg-transparent p-0"
      onOpenChange={(value) => { userToggledRef.current = true; setOpen(value) }}
      open={open}
      role="group"
    >
      <ChainOfThoughtHeader
        aria-label={`${open ? '收起' : '展开'}${title}`}
        className="agent-chain-header hover:bg-transparent"
        icon={null}
      >
        {title}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent className="agent-chain-content space-y-0 border-t pt-2">{children}</ChainOfThoughtContent>
    </ChainOfThought>
  )
}
