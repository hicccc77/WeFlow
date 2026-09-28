import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button as HeroButton, Dropdown, Modal } from '@heroui/react'
import { ArrowUp, Brain, CircleAlert, MoreHorizontal, Power, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMemoryEntry, AgentMemorySummarySnapshot } from '@/types/electron'
import type { AgentModelConfig } from '@/features/aiagent/transport/ipcChatTransport'

const EMPTY_SUMMARY: AgentMemorySummarySnapshot = {
  enabled: true,
  summary: '',
  entries: [],
  needsRebuild: true,
  revision: 0,
  processedTurnCount: 0,
  legacyMemoryCount: 0,
}

type MemoryContentPhase = 'idle' | 'leaving' | 'waiting' | 'revealing'
const MEMORY_CONTENT_EXIT_MS = 170
const MEMORY_REVEAL_TICK_MS = 28

function modelIsReady(config?: AgentModelConfig | null): boolean {
  return Boolean(config?.model && config.baseURL && (config.apiKey || config.provider === 'ollama'))
}

function formatActivityAt(timestamp: number | undefined, now: number, action: '更新' | '检查'): string {
  if (!timestamp) return action === '更新' ? '尚未更新' : '尚未检查'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return `刚刚${action}`
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前${action}`
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前${action}`
  return `${new Date(timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}${action}`
}

function memoryPreviewEntries(
  entries: Array<Pick<AgentMemoryEntry, 'title' | 'detail' | 'category'>>,
): AgentMemoryEntry[] {
  const now = Date.now()
  return entries
    .filter((entry) => entry.title.trim())
    .map((entry, index) => ({
      ...entry,
      id: `memory-preview-${index}`,
      createdAt: now,
      updatedAt: now,
    }))
}

export function AgentMemoryPanel({ modelConfig }: { modelConfig?: AgentModelConfig | null }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(false)
  const [summary, setSummary] = useState<AgentMemorySummarySnapshot>(EMPTY_SUMMARY)
  const [displayedEntries, setDisplayedEntries] = useState<AgentMemoryEntry[]>([])
  const [contentPhase, setContentPhase] = useState<MemoryContentPhase>('idle')
  const [instruction, setInstruction] = useState('')
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const workingRef = useRef(false)
  const modelConfigRef = useRef(modelConfig)
  // AgentPage 在流式 token 到达时会频繁重渲染。模型配置只供用户主动操作时读取，
  // 不能因为等价配置对象换了引用就重建 load/rebuild 回调并重新加载整个弹窗。
  modelConfigRef.current = modelConfig
  const autoRebuildAttemptedRef = useRef(false)
  const summaryRef = useRef<AgentMemorySummarySnapshot>(EMPTY_SUMMARY)
  const displayedEntriesRef = useRef<AgentMemoryEntry[]>([])
  const exitTimerRef = useRef<number | null>(null)
  const revealTimerRef = useRef<number | null>(null)
  const activePreviewRequestIdRef = useRef('')
  const previewReadyRef = useRef(true)
  const previewReceivedRef = useRef(false)
  const pendingPreviewRef = useRef<AgentMemoryEntry[] | null>(null)

  const updateSummaryState = useCallback((next: AgentMemorySummarySnapshot) => {
    summaryRef.current = next
    setSummary(next)
  }, [])

  const updateDisplayedEntries = useCallback((entries: AgentMemoryEntry[]) => {
    displayedEntriesRef.current = entries
    setDisplayedEntries(entries)
  }, [])

  const cancelContentAnimation = useCallback(() => {
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
    if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current)
    exitTimerRef.current = null
    revealTimerRef.current = null
  }, [])

  useEffect(() => cancelContentAnimation, [cancelContentAnimation])

  const dismissDisplayedEntries = useCallback(async () => {
    cancelContentAnimation()
    if (displayedEntriesRef.current.length === 0) {
      setContentPhase('waiting')
      return
    }
    setContentPhase('leaving')
    await new Promise<void>((resolve) => {
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null
        updateDisplayedEntries([])
        setContentPhase('waiting')
        resolve()
      }, MEMORY_CONTENT_EXIT_MS)
    })
  }, [cancelContentAnimation, updateDisplayedEntries])

  const revealEntries = useCallback((entries: AgentMemoryEntry[]) => {
    cancelContentAnimation()
    if (entries.length === 0) {
      updateDisplayedEntries([])
      setContentPhase('idle')
      return
    }
    const totalCharacters = entries.reduce((total, entry) => total + entry.title.length + entry.detail.length, 0)
    const charactersPerTick = Math.max(5, Math.ceil(totalCharacters / 62))
    let revealedCharacters = 0
    setContentPhase('revealing')

    const tick = () => {
      revealedCharacters = Math.min(totalCharacters, revealedCharacters + charactersPerTick)
      let remaining = revealedCharacters
      const visibleEntries: AgentMemoryEntry[] = []
      for (const entry of entries) {
        if (remaining <= 0) break
        const titleLength = Math.min(entry.title.length, remaining)
        const title = entry.title.slice(0, titleLength)
        remaining -= titleLength
        const detailLength = Math.min(entry.detail.length, Math.max(0, remaining))
        const detail = entry.detail.slice(0, detailLength)
        remaining -= detailLength
        visibleEntries.push({ ...entry, title, detail })
      }
      updateDisplayedEntries(visibleEntries)
      if (revealedCharacters >= totalCharacters) {
        revealTimerRef.current = null
        updateDisplayedEntries(entries)
        setContentPhase('idle')
        return
      }
      revealTimerRef.current = window.setTimeout(tick, MEMORY_REVEAL_TICK_MS)
    }
    tick()
  }, [cancelContentAnimation, updateDisplayedEntries])

  const rebuild = useCallback(async (automatic = false) => {
    const currentModelConfig = modelConfigRef.current
    if (workingRef.current || !modelIsReady(currentModelConfig)) {
      if (!automatic && !modelIsReady(currentModelConfig)) setError('请先在 Agent 中选择并配置可用的 AI 模型')
      return
    }
    workingRef.current = true
    const requestId = crypto.randomUUID()
    activePreviewRequestIdRef.current = requestId
    previewReadyRef.current = false
    previewReceivedRef.current = false
    pendingPreviewRef.current = null
    const previous = summaryRef.current
    setWorking(true)
    setBootstrapping(automatic)
    setError('')
    const transition = (automatic
      ? Promise.resolve().then(() => {
          cancelContentAnimation()
          updateDisplayedEntries([])
          setContentPhase('waiting')
        })
      : dismissDisplayedEntries()).then(() => {
        previewReadyRef.current = true
        const pendingPreview = pendingPreviewRef.current
        if (pendingPreview && activePreviewRequestIdRef.current === requestId) {
          cancelContentAnimation()
          updateDisplayedEntries(pendingPreview)
          setContentPhase('revealing')
        }
      })
    try {
      const [result] = await Promise.all([
        window.electronAPI.agent.refreshMemorySummary(currentModelConfig || undefined, requestId),
        transition,
      ])
      if (result.summary) updateSummaryState(result.summary)
      if (!result.success || !result.summary) throw new Error(result.error || '个人记忆重建失败')
      if (previewReceivedRef.current) {
        cancelContentAnimation()
        updateDisplayedEntries(result.summary.entries)
        setContentPhase('idle')
      } else {
        revealEntries(result.summary.entries)
      }
      setNow(Date.now())
    } catch (cause) {
      await transition
      revealEntries(previous.entries)
      setError(cause instanceof Error ? cause.message : '个人记忆重建失败')
    } finally {
      if (activePreviewRequestIdRef.current === requestId) activePreviewRequestIdRef.current = ''
      previewReadyRef.current = true
      pendingPreviewRef.current = null
      workingRef.current = false
      setWorking(false)
      setBootstrapping(false)
    }
  }, [cancelContentAnimation, dismissDisplayedEntries, revealEntries, updateDisplayedEntries, updateSummaryState])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.agent.getMemorySummary()
      if (!result.success || !result.summary) throw new Error(result.error || '记忆摘要读取失败')
      updateSummaryState(result.summary)
      updateDisplayedEntries(result.summary.entries)
      setContentPhase('idle')
      const shouldRebuild = result.summary.enabled
        && result.summary.needsRebuild
        && modelIsReady(modelConfigRef.current)
        && !autoRebuildAttemptedRef.current
      if (shouldRebuild) {
        autoRebuildAttemptedRef.current = true
        setLoading(false)
        await rebuild(true)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记忆摘要读取失败')
    } finally {
      setLoading(false)
    }
  }, [rebuild, updateDisplayedEntries, updateSummaryState])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  useEffect(() => window.electronAPI.agent.onMemoryUpdated((next) => {
    updateSummaryState(next)
    if (!workingRef.current) {
      cancelContentAnimation()
      updateDisplayedEntries(next.entries)
      setContentPhase('idle')
    }
    setNow(Date.now())
  }), [cancelContentAnimation, updateDisplayedEntries, updateSummaryState])

  useEffect(() => window.electronAPI.agent.onMemoryPreview((preview) => {
    if (!preview?.requestId || preview.requestId !== activePreviewRequestIdRef.current) return
    const entries = memoryPreviewEntries(Array.isArray(preview.entries) ? preview.entries : [])
    if (entries.length === 0) return
    previewReceivedRef.current = true
    pendingPreviewRef.current = entries
    if (!previewReadyRef.current) return
    cancelContentAnimation()
    updateDisplayedEntries(entries)
    setContentPhase('revealing')
  }), [cancelContentAnimation, updateDisplayedEntries])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  const activityLabel = useMemo(() => {
    if (summary.lastReviewStatus === 'failed') return '更新失败'
    if (summary.lastReviewStatus === 'unchanged' && summary.lastReviewedAt) {
      return formatActivityAt(summary.lastReviewedAt, now, '检查')
    }
    return formatActivityAt(summary.updatedAt || summary.lastReviewedAt, now, summary.updatedAt ? '更新' : '检查')
  }, [now, summary.lastReviewedAt, summary.lastReviewStatus, summary.updatedAt])

  const submitInstruction = async () => {
    const value = instruction.trim()
    if (!value || workingRef.current) return
    const currentModelConfig = modelConfigRef.current
    if (!modelIsReady(currentModelConfig)) {
      setError('请先在 Agent 中选择并配置可用的 AI 模型')
      return
    }
    const previous = summaryRef.current
    workingRef.current = true
    const requestId = crypto.randomUUID()
    activePreviewRequestIdRef.current = requestId
    previewReadyRef.current = false
    previewReceivedRef.current = false
    pendingPreviewRef.current = null
    setWorking(true)
    setError('')
    setInstruction('')
    const transition = dismissDisplayedEntries().then(() => {
      previewReadyRef.current = true
      const pendingPreview = pendingPreviewRef.current
      if (pendingPreview && activePreviewRequestIdRef.current === requestId) {
        cancelContentAnimation()
        updateDisplayedEntries(pendingPreview)
        setContentPhase('revealing')
      }
    })
    try {
      const [result] = await Promise.all([
        window.electronAPI.agent.updateMemorySummary(value, currentModelConfig || undefined, requestId),
        transition,
      ])
      if (result.summary) updateSummaryState(result.summary)
      if (!result.success || !result.summary) throw new Error(result.error || '记忆摘要更新失败')
      if (previewReceivedRef.current) {
        cancelContentAnimation()
        updateDisplayedEntries(result.summary.entries)
        setContentPhase('idle')
      } else {
        revealEntries(result.summary.entries)
      }
      setNow(Date.now())
    } catch (cause) {
      await transition
      revealEntries(previous.entries)
      setInstruction((current) => current || value)
      setError(cause instanceof Error ? cause.message : '记忆摘要更新失败')
    } finally {
      if (activePreviewRequestIdRef.current === requestId) activePreviewRequestIdRef.current = ''
      previewReadyRef.current = true
      pendingPreviewRef.current = null
      workingRef.current = false
      setWorking(false)
    }
  }

  const refresh = async () => rebuild(false)

  const toggleEnabled = async () => {
    if (workingRef.current) return
    workingRef.current = true
    setWorking(true)
    setError('')
    try {
      const result = await window.electronAPI.agent.setMemoryEnabled(!summary.enabled)
      if (!result.success || !result.summary) throw new Error(result.error || '记忆设置保存失败')
      updateSummaryState(result.summary)
      cancelContentAnimation()
      updateDisplayedEntries(result.summary.entries)
      setContentPhase('idle')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记忆设置保存失败')
    } finally {
      workingRef.current = false
      setWorking(false)
    }
  }

  const clearAndDisable = async () => {
    if (workingRef.current) return
    workingRef.current = true
    setWorking(true)
    setError('')
    try {
      const result = await window.electronAPI.agent.clearMemorySummary({ disable: true })
      if (!result.success || !result.summary) throw new Error(result.error || '记忆删除失败')
      updateSummaryState(result.summary)
      cancelContentAnimation()
      updateDisplayedEntries([])
      setContentPhase('idle')
      setConfirmClear(false)
      setInstruction('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记忆删除失败')
    } finally {
      workingRef.current = false
      setWorking(false)
    }
  }

  const handleInstructionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submitInstruction()
  }

  return (
    <>
      <HeroButton
        aria-label="记忆摘要"
        className="agent-icon-button size-10 min-w-10 p-0"
        isIconOnly
        render={(buttonProps) => <button {...buttonProps} title="记忆摘要" />}
        size="md"
        variant="tertiary"
        onPress={() => setOpen(true)}
      >
        <Brain className="size-4.5" />
      </HeroButton>

      <Modal>
        <Modal.Backdrop isOpen={open} variant="blur" onOpenChange={(next) => { setOpen(next); if (!next) setConfirmClear(false) }}>
          <Modal.Container className="agent-memory-modal-container" placement="center">
            <Modal.Dialog aria-label="记忆摘要" className="agent-memory-dialog">
              <Modal.Header className="agent-memory-summary-header">
                <div className="agent-memory-summary-heading">
                  <Modal.Heading>记忆摘要</Modal.Heading>
                  <span data-status={summary.lastReviewStatus}>{summary.enabled ? activityLabel : '已关闭'}</span>
                </div>
                <Dropdown>
                  <HeroButton aria-label="记忆选项" className="agent-memory-header-action" isIconOnly size="sm" variant="ghost">
                    <MoreHorizontal className="size-4.5" />
                  </HeroButton>
                  <Dropdown.Popover className="agent-memory-menu-popover" placement="bottom end">
                    <Dropdown.Menu aria-label="记忆选项">
                      <Dropdown.Item id="refresh" isDisabled={working || !summary.enabled} textValue={summary.entries.length > 0 ? '重建个人记忆' : '分析近期对话'} onAction={() => { void refresh() }}>
                        <RefreshCw className="size-4" />
                        <span>{summary.entries.length > 0 ? '重建个人记忆' : '分析近期对话'}</span>
                      </Dropdown.Item>
                      <Dropdown.Item id="toggle" isDisabled={working} textValue={summary.enabled ? '关闭记忆' : '开启记忆'} onAction={() => { void toggleEnabled() }}>
                        <Power className="size-4" />
                        <span>{summary.enabled ? '关闭记忆' : '开启记忆'}</span>
                      </Dropdown.Item>
                      <Dropdown.Item id="clear" className="agent-memory-menu-danger" isDisabled={working || (summary.entries.length === 0 && summary.legacyMemoryCount === 0)} textValue="删除并关闭记忆" onAction={() => setConfirmClear(true)}>
                        <Trash2 className="size-4" />
                        <span>删除并关闭记忆</span>
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
                <Modal.CloseTrigger aria-label="关闭记忆摘要" className="agent-memory-header-action">
                  <X className="size-4.5" />
                </Modal.CloseTrigger>
              </Modal.Header>

              <Modal.Body className="agent-memory-summary-body agent-scrollbar">
                {loading ? (
                  <div className="agent-memory-summary-state" role="status">
                    <RefreshCw className="size-5 animate-spin motion-reduce:animate-none" />
                    <strong>正在读取记忆摘要</strong>
                  </div>
                ) : bootstrapping && displayedEntries.length === 0 ? (
                  <div className="agent-memory-building" role="status">
                    <div className="agent-memory-building-copy">
                      <strong>正在建立你的个人记忆</strong>
                      <p>Agent 正在从近期对话中提炼稳定且未来仍有帮助的信息。</p>
                    </div>
                    <div className="agent-memory-building-preview" aria-hidden="true">
                      <section><span data-role="title" /><span /><span /><span /></section>
                      <section><span data-role="title" /><span /><span /></section>
                      <section><span data-role="title" /><span /><span /><span /></section>
                    </div>
                  </div>
                ) : !summary.enabled ? (
                  <div className="agent-memory-summary-state">
                    <Brain className="size-7" />
                    <strong>记忆已关闭</strong>
                    <p>Agent 不会使用现有记忆，也不会从新对话中生成记忆。已有摘要会保留，重新开启后继续使用。</p>
                    <button disabled={working} type="button" onClick={() => { void toggleEnabled() }}>开启记忆</button>
                  </div>
                ) : contentPhase === 'waiting' ? (
                  <div className="agent-memory-rewriting" role="status">
                    <span className="agent-memory-rewriting-indicator" aria-hidden="true"><i /><i /><i /></span>
                    <strong>正在重新整理个人记忆</strong>
                    <p>旧内容已收起，新内容会在整理完成后逐步出现。</p>
                  </div>
                ) : displayedEntries.length > 0 ? (
                  <div
                    aria-busy={contentPhase !== 'idle'}
                    aria-live={contentPhase === 'idle' ? 'polite' : 'off'}
                    className="agent-memory-entry-list"
                    data-phase={contentPhase}
                  >
                    {displayedEntries.map((entry, index) => (
                      <section className="agent-memory-entry" key={entry.id}>
                        <h3>{entry.title}</h3>
                        <div className="agent-memory-entry-detail" data-streaming={contentPhase === 'revealing' || undefined}>
                          {contentPhase === 'revealing' ? (
                            <p>
                              {entry.detail}
                              {index === displayedEntries.length - 1 && <span className="agent-memory-stream-caret" aria-hidden="true" />}
                            </p>
                          ) : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.detail}</ReactMarkdown>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : summary.lastReviewStatus === 'failed' ? (
                  <div className="agent-memory-summary-state" data-status="failed">
                    <CircleAlert className="size-7" />
                    <strong>这次没有建立成功</strong>
                    <p>{summary.lastReviewError || 'Agent 没能完成本次记忆整理，你可以稍后重试。'}</p>
                    <button disabled={working} type="button" onClick={() => { void refresh() }}>
                      {working ? '正在重试…' : '重试'}
                    </button>
                  </div>
                ) : summary.processedTurnCount > 0 ? (
                  <div className="agent-memory-summary-state" data-variant="quiet">
                    <div className="agent-memory-empty-icon"><Sparkles className="size-5" /></div>
                    <strong>暂时没有需要长期保留的内容</strong>
                    <p>近期对话已经检查过了。真正稳定且有助于未来交流的信息出现时，会自动在这里形成记忆。</p>
                  </div>
                ) : (
                  <div className="agent-memory-summary-state" data-variant="quiet">
                    <div className="agent-memory-empty-icon"><Sparkles className="size-5" /></div>
                    <strong>个人记忆会在这里逐渐形成</strong>
                    <p>不需要手动整理。Agent 会在对话后自动保留稳定、有意义、未来仍然有帮助的信息。</p>
                  </div>
                )}
              </Modal.Body>

              <Modal.Footer className="agent-memory-summary-footer">
                {confirmClear && (
                  <div className="agent-memory-clear-confirm" role="alert">
                    <div>
                      <strong>删除全部记忆并关闭？</strong>
                      <span>个人记忆会被永久删除，对话记录不会删除。</span>
                    </div>
                    <button type="button" onClick={() => setConfirmClear(false)}>取消</button>
                    <button disabled={working} type="button" onClick={() => { void clearAndDisable() }}>删除</button>
                  </div>
                )}
                {error && <div className="agent-memory-summary-error" role="alert">{error}</div>}
                <div className="agent-memory-instruction-shell" data-disabled={!summary.enabled || undefined}>
                  <textarea
                    aria-label="提问或更新记忆"
                    disabled={!summary.enabled || working}
                    maxLength={2_000}
                    placeholder={summary.enabled ? '提问或更新' : '开启记忆后可更新'}
                    rows={1}
                    value={instruction}
                    onChange={(event) => setInstruction(event.currentTarget.value)}
                    onKeyDown={handleInstructionKeyDown}
                  />
                  <button aria-label="提交记忆更新" disabled={!summary.enabled || !instruction.trim() || working} type="button" onClick={() => { void submitInstruction() }}>
                    {working ? <RefreshCw className="size-4.5 animate-spin motion-reduce:animate-none" /> : <ArrowUp className="size-4.5" />}
                  </button>
                </div>
                <p className="agent-memory-summary-hint">用自然语言说明要补充、纠正或忘记什么，Agent 会自动调整相关记忆。</p>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}
