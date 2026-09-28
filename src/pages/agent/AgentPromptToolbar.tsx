/** Agent 输入框的发送、模型选择和控制器桥接。 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { Button as HeroButton, Popover } from '@heroui/react'
import { ArrowsRotateLeft, Check, ChevronDown, Plus } from '@gravity-ui/icons'
import { Search } from 'lucide-react'
import type { ChatStatus } from 'ai'
import type { AiConfigPreset } from '@/services/config'
import type { AIProviderInfo } from '@/types/ai'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import { formatAIModelDisplayName } from '@/utils/aiModelDisplay'
import { estimateAgentPartTokens, estimateAgentTextTokens } from '@/utils/agentTokenEstimate'
import { formatAgentContextWindow } from '@/utils/modelTokenLimits'
import {
  PromptInputSubmit,
  usePromptInputController,
  type PromptInputControllerProps,
} from '@/components/ai-elements/prompt-input'

export function AgentModelSelector({
  profiles,
  providers,
  activeId,
  loading,
  catalogLoading = false,
  onSelect,
  onAdd,
  onOpen,
}: {
  profiles: AiConfigPreset[]
  providers: AIProviderInfo[]
  activeId: string
  loading: boolean
  catalogLoading?: boolean
  onSelect: (profileId: string, model: string) => void
  onAdd: () => void
  onOpen?: () => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const firstChoiceRef = useRef<HTMLButtonElement>(null)
  const active = profiles.find((profile) => profile.id === activeId) || profiles[0]
  const activeProvider = providers.find((provider) => provider.id === active?.provider)
  const label = loading ? '读取模型…' : active?.model ? formatAIModelDisplayName(active.model) : '添加模型配置'
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groups = useMemo(() => {
    const orderedProfiles = [...profiles].sort((left, right) => {
      if (left.id === activeId) return -1
      if (right.id === activeId) return 1
      const leftUsesActiveProvider = left.provider === active?.provider
      const rightUsesActiveProvider = right.provider === active?.provider
      if (leftUsesActiveProvider !== rightUsesActiveProvider) return leftUsesActiveProvider ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true })
    })

    return orderedProfiles.map((profile) => {
      const provider = providers.find((item) => item.id === profile.provider)
      const models = Array.from(new Set([
        profile.model,
        ...(profile.models || []),
        ...(provider?.models || []),
      ].map((model) => model.trim()).filter(Boolean)))
      const orderedModels = profile.id === activeId && active?.model
        ? [active.model, ...models.filter((model) => model !== active.model)]
        : models
      const filteredModels = normalizedQuery
        ? orderedModels.filter((model) => (
          `${provider?.displayName || profile.provider} ${provider?.id || ''} ${profile.name} ${model} ${formatAIModelDisplayName(model)}`
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        ))
        : orderedModels
      return { profile, provider, models: filteredModels }
    }).filter((group) => group.models.length > 0)
  }, [active?.model, active?.provider, activeId, normalizedQuery, profiles, providers])
  const firstChoice = groups[0]?.models[0] && groups[0]
    ? { profileId: groups[0].profile.id, model: groups[0].models[0] }
    : null

  useEffect(() => {
    if (!isOpen) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (open) onOpen?.()
    else setQuery('')
  }

  const chooseModel = (profileId: string, model: string) => {
    setIsOpen(false)
    setQuery('')
    onSelect(profileId, model)
  }

  return (
    <Popover isOpen={isOpen} onOpenChange={handleOpenChange}>
      <HeroButton
        aria-expanded={isOpen}
        aria-label={`当前模型：${label}，打开模型选择器`}
        className="agent-model-selector-trigger"
        render={(buttonProps) => <button {...buttonProps} title={active?.name || label} />}
        size="sm"
        variant="ghost"
        onPress={() => setIsOpen(true)}
      >
        {active && (
          <AIProviderLogo
            alt={activeProvider?.displayName || active.provider}
            className="agent-model-selector-logo"
            logo={activeProvider?.logo}
            providerId={active.provider}
            size={15}
          />
        )}
        <span className="agent-model-selector-label">{label}</span>
        <ChevronDown aria-hidden="true" className="agent-model-selector-chevron" />
      </HeroButton>
      <Popover.Content className="agent-model-selector-popover p-0" placement="bottom end">
        <Popover.Dialog className="p-0">
          <div className="agent-model-search">
            <div className="agent-model-search-field">
              <Search aria-hidden="true" size={15} />
              <input
                ref={searchInputRef}
                aria-label="搜索供应商或模型"
                placeholder="搜索供应商或模型…"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    firstChoiceRef.current?.focus()
                  } else if (event.key === 'Enter' && firstChoice) {
                    event.preventDefault()
                    chooseModel(firstChoice.profileId, firstChoice.model)
                  }
                }}
              />
            </div>
            {catalogLoading && (
              <div aria-live="polite" className="px-2 pb-1 text-muted-foreground text-xs" role="status">
                正在更新可用模型…
              </div>
            )}
            <div aria-label="模型搜索结果" className="agent-model-search-list" role="listbox">
              {groups.length === 0 && <div className="agent-model-search-empty" role="status">没有匹配的供应商或模型</div>}
              {groups.map(({ profile, provider, models }, groupIndex) => (
                <div aria-label={`${provider?.displayName || profile.provider || '自定义'} · ${profile.name}`} className="agent-model-search-group" key={profile.id} role="group">
                  <div className="agent-model-search-heading">
                    <span>{provider?.displayName || profile.provider || '自定义'} · {profile.name}</span>
                    {profile.id === activeId && <small>当前</small>}
                  </div>
                  {models.map((model, modelIndex) => (
                    <button
                      ref={groupIndex === 0 && modelIndex === 0 ? firstChoiceRef : undefined}
                      aria-selected={profile.id === activeId && model === active?.model}
                      className="agent-model-search-option"
                      key={`${profile.id}:${model}`}
                      role="option"
                      title={model}
                      type="button"
                      onClick={() => chooseModel(profile.id, model)}
                    >
                      <AIProviderLogo
                        alt={provider?.displayName || profile.provider}
                        className="agent-model-command-logo"
                        logo={provider?.logo}
                        providerId={profile.provider}
                        size={18}
                      />
                      <span className="agent-model-command-copy">
                        <strong>{formatAIModelDisplayName(model)}</strong>
                        <small>{provider?.displayName || profile.provider} · {profile.name}</small>
                      </span>
                      {profile.id === activeId && model === active?.model && <Check className="agent-model-command-check size-4 text-primary" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="agent-model-config-footer">
              <button
                className="agent-model-search-option"
                type="button"
                onClick={() => {
                  setIsOpen(false)
                  setQuery('')
                  onAdd()
                }}
              >
                <Plus />
                <span className="agent-model-command-copy">
                  <strong>管理模型配置…</strong>
                  <small>添加供应商、基础地址或 API Key</small>
                </span>
              </button>
            </div>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

export function AgentTokenMeter({
  contextTokens,
  contextWindow,
}: {
  contextTokens: number
  contextWindow?: number
}) {
  const { textInput, attachments } = usePromptInputController()
  const deferredDraft = useDeferredValue(textInput.value)
  const limit = Math.max(0, Math.floor(Number(contextWindow) || 0))
  if (limit <= 0) return null
  const draftTokens = deferredDraft
    ? 10 + estimateAgentTextTokens(deferredDraft)
    : 0
  const attachmentTokens = attachments.files.length * estimateAgentPartTokens({ type: 'file' })
  const current = Math.max(0, Math.floor(contextTokens + draftTokens + attachmentTokens))
  const ratio = Math.max(0, Math.min(1, current / limit))
  const tone = ratio >= 0.9 ? 'is-danger' : ratio >= 0.72 ? 'is-warning' : ''
  const currentLabel = current === 0 ? '0' : formatAgentContextWindow(current)
  const limitLabel = formatAgentContextWindow(limit)
  const accessibleLabel = `下次请求上下文估算：${current.toLocaleString('zh-CN')} / ${limit.toLocaleString('zh-CN')} tokens`

  return (
    <span
      aria-label={accessibleLabel}
      className={`agent-token-meter ${tone}`}
    >
      <span
        aria-hidden
        className="agent-token-meter__ring"
        style={{ '--agent-token-ratio': `${ratio * 360}deg` } as CSSProperties}
      />
      <span aria-hidden className="agent-token-meter__value">
        <small>下次请求</small>
        <strong>{currentLabel}</strong>
        <span className="agent-token-meter__separator">/</span>
        <span>{limitLabel}</span>
      </span>
    </span>
  )
}

export function AgentPromptSubmit({
  busy,
  status,
  resumeAvailable = false,
  stopping = false,
  onResume,
}: {
  busy: boolean
  status: ChatStatus
  resumeAvailable?: boolean
  stopping?: boolean
  onResume?: () => void
}) {
  const { textInput, attachments } = usePromptInputController()
  const hasNewContent = Boolean(textInput.value.trim()) || attachments.files.length > 0
  const shouldResume = !busy && !stopping && resumeAvailable && !hasNewContent
  const disabled = stopping || (!busy && !hasNewContent && !shouldResume)
  const isStopping = !stopping && (status === 'submitted' || status === 'streaming')
  const actionLabel = stopping ? '正在结束' : shouldResume ? '继续回答' : undefined

  return (
    <PromptInputSubmit
      aria-label={actionLabel}
      className={isStopping
        ? 'size-9 min-h-9 min-w-9 rounded-xl border border-border/70 bg-background/60 p-0 text-foreground shadow-none transition-colors data-[hovered=true]:border-destructive/30 data-[hovered=true]:bg-destructive/10 data-[hovered=true]:text-destructive data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-ring motion-reduce:transition-none dark:bg-background/35'
        : 'size-9 min-h-9 min-w-9 rounded-xl p-0 shadow-sm shadow-primary/15 transition-[background-color,box-shadow] data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-ring motion-reduce:transition-none'}
      disabled={disabled}
      status={stopping || shouldResume ? 'ready' : status}
      title={actionLabel}
      type={stopping || shouldResume ? 'button' : 'submit'}
      variant={isStopping ? 'tertiary' : 'default'}
      onPress={shouldResume ? onResume : undefined}
    >
      {stopping
        ? <ArrowsRotateLeft aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        : shouldResume ? <ArrowsRotateLeft className="size-4" /> : undefined}
    </PromptInputSubmit>
  )
}

export function AgentPromptPrimaryAction({
  busy,
  status,
  resumeAvailable,
  stopping,
  onResume,
}: {
  busy: boolean
  status: ChatStatus
  resumeAvailable: boolean
  stopping: boolean
  onResume: () => void
}) {
  return <AgentPromptSubmit busy={busy} resumeAvailable={resumeAvailable} status={status} stopping={stopping} onResume={onResume} />
}

export function PromptInputControllerBridge({
  controllerRef,
}: {
  controllerRef: MutableRefObject<PromptInputControllerProps | null>
}) {
  const controller = usePromptInputController()
  useEffect(() => {
    controllerRef.current = controller
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [controller, controllerRef])
  return null
}
