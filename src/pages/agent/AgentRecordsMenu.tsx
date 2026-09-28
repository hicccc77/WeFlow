/**
 * Agent 对话记录下拉菜单：从 AgentPage.tsx 拆出，并用 React.memo 包裹。
 *
 * 历史记录打开时若把所有条目一次性挂到 DOM，每条记录又包含标题、
 * 时间和操作按钮，记录一多（默认 50 条），
 * 首次打开就要同步创建数百个组件实例和 DOM 节点，容易占满主线程并造成明显卡顿。
 *
 * 这里做两件事：
 *  1. 限制渲染量：增加搜索框和可见上限，打开时最多渲染 30 条，
 *     老记录靠搜索定位，而不是全量渲染后滚动翻找。
 *  2. 使用 memo 隔离：AgentPage 流式输出时约每 50 毫秒重渲染一次；原来即使菜单关闭，
 *     conversationRecords.map(...) 也会重建整棵 Popover 元素树。虽然 react-aria 的
 *     Popover 在 isOpen=false 时不会挂载 DOM，但 JSX 求值在此之前已经发生。
 *     只要传入的 props 引用不变，这一层就可以完全跳过重渲染。
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Button as HeroButton, Popover, SearchField } from '@heroui/react'
import { Clock, ClockArrowRotateLeft, Magnifier, TrashBin } from '@gravity-ui/icons'
import { Check, Pencil, Pin, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AgentConversationRecord } from './agentConversationHelpers'

/** 菜单打开时最多渲染的记录数；更多记录通过搜索框收窄，而不是全部挂到 DOM。 */
const RECORDS_VISIBLE_LIMIT = 30

type AgentRecordsMenuProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  records: AgentConversationRecord[]
  selectedId: number | null
  onOpenRecord: (record: AgentConversationRecord) => void
  onDeleteRecord: (record: AgentConversationRecord) => void | Promise<void>
  onRenameRecord: (record: AgentConversationRecord, title: string) => void | Promise<void>
  onTogglePin: (record: AgentConversationRecord) => void | Promise<void>
}

function formatRecordTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function AgentRecordsMenuImpl({
  isOpen,
  onOpenChange,
  records,
  selectedId,
  onOpenRecord,
  onDeleteRecord,
  onRenameRecord,
  onTogglePin,
}: AgentRecordsMenuProps) {
  // 搜索词放在组件本地：打开时清空，避免上次的关键词残留影响这次查看。
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    if (isOpen) setSearch('')
  }, [isOpen])

  // 有关键词时按标题过滤，没有关键词时取全部；最后统一裁剪到可见上限。
  const { visibleRecords, totalCount, isFiltered, hasMore } = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = keyword
      ? records.filter((record) => record.title.toLowerCase().includes(keyword))
      : records
    return {
      visibleRecords: filtered.slice(0, RECORDS_VISIBLE_LIMIT),
      totalCount: filtered.length,
      isFiltered: keyword.length > 0,
      hasMore: filtered.length > RECORDS_VISIBLE_LIMIT,
    }
  }, [records, search])

  const isEmpty = records.length === 0
  const noMatch = !isEmpty && visibleRecords.length === 0

  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange}>
      <HeroButton
        aria-label="对话记录"
        aria-expanded={isOpen}
        className="group relative size-10 min-w-10 overflow-visible rounded-xl p-0 text-muted-foreground data-[hovered=true]:bg-accent/10 data-[hovered=true]:text-foreground"
        isIconOnly
        render={(buttonProps) => <button {...buttonProps} title="对话记录" />}
        size="md"
        variant="tertiary"
      >
        <Clock className="size-4.5" />
        <span
          aria-hidden
          className="pointer-events-none absolute top-[calc(100%+0.375rem)] right-0 z-50 whitespace-nowrap rounded-lg border border-border/70 bg-popover px-2 py-1 text-popover-foreground text-xs opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
        >
          对话记录
        </span>
      </HeroButton>
      <Popover.Content
        className="w-[min(28rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/70 bg-popover p-0 text-popover-foreground shadow-xl"
        placement="bottom end"
      >
        <Popover.Dialog aria-label="历史对话" className="p-0 outline-none">
          {/* 搜索框：粘性置顶，滚动列表时保持可见。空状态/无匹配时也保留，方便重新输入。 */}
          <div className="border-border/60 border-b bg-popover/95 px-3 pt-3 pb-2.5 backdrop-blur">
            <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
              <span className="font-semibold text-sm">历史对话</span>
              <span className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-muted-foreground text-xs tabular-nums">
                {records.length} 条
              </span>
            </div>
            <SearchField aria-label="搜索对话记录" className="w-full" value={search} onChange={setSearch}>
              <SearchField.Group className="h-10 w-full rounded-xl border border-border/70 bg-background/60 shadow-none">
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="搜索对话标题" />
                <SearchField.ClearButton aria-label="清除搜索" />
              </SearchField.Group>
            </SearchField>
          </div>
          <div
            aria-label="历史对话列表"
            className="agent-scrollbar max-h-[min(70vh,32rem)] overflow-y-auto p-1.5"
            role="list"
          >
            {isEmpty ? (
              <div className="flex min-h-32 items-center justify-center rounded-xl py-7 text-center" role="status">
                <span>
                  <ClockArrowRotateLeft className="mx-auto mb-2 size-6 text-muted-foreground" />
                  <span className="block font-medium text-foreground text-sm">暂无对话记录</span>
                  <span className="mt-1 block text-muted-foreground text-xs">开始一次新对话后会显示在这里</span>
                </span>
              </div>
            ) : noMatch ? (
              <div className="flex min-h-32 items-center justify-center rounded-xl py-7 text-center" role="status">
                <span className="min-w-0 max-w-full px-4">
                  <Magnifier className="mx-auto mb-2 size-6 text-muted-foreground" />
                  <span className="block font-medium text-foreground text-sm">没有匹配的对话</span>
                  <span className="mt-1 block truncate text-muted-foreground text-xs">换个关键词搜索“{search.trim()}”</span>
                </span>
              </div>
            ) : (
              <>
                <AnimatePresence initial={false} mode="popLayout">
                  {visibleRecords.map((record) => {
                    const selected = record.id === selectedId
                    const editing = editingId === record.id
                    return (
                      <motion.div
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        className={`group/record min-h-14 rounded-xl border border-transparent p-1.5 transition-colors motion-reduce:transition-none ${selected
                          ? 'bg-primary/10'
                          : 'hover:bg-accent/10 focus-within:bg-accent/10'}`}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -12, scale: 0.975 }}
                        initial={reduceMotion ? false : { opacity: 0, x: 8, scale: 0.985 }}
                        key={record.id}
                        layout={reduceMotion ? false : 'position'}
                        role="listitem"
                        transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                      >
                        {editing ? (
                          <div className="agent-record-inline-edit">
                          <input
                            aria-label="编辑对话标题"
                            autoFocus
                            maxLength={24}
                            value={editTitle}
                            onChange={(event) => setEditTitle(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setEditingId(null)
                              if (event.key === 'Enter' && editTitle.trim()) {
                                void onRenameRecord(record, editTitle.trim())
                                setEditingId(null)
                              }
                            }}
                          />
                          <button aria-label="取消编辑" type="button" onClick={() => setEditingId(null)}><X className="size-4" /></button>
                          <button
                            aria-label="保存标题"
                            disabled={!editTitle.trim()}
                            type="button"
                            onClick={() => { void onRenameRecord(record, editTitle.trim()); setEditingId(null) }}
                          ><Check className="size-4" /></button>
                          </div>
                        ) : (
                          <div className="flex min-h-12 items-center gap-1">
                          <button
                            aria-current={selected ? 'page' : undefined}
                            className="flex min-w-0 flex-1 items-center self-stretch rounded-lg border-0 bg-transparent px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() => onOpenRecord(record)}
                            type="button"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                {record.pinned && <Pin aria-label="已置顶" className="size-3.5 shrink-0 text-primary" />}
                                <span className="truncate font-medium text-foreground text-sm">{record.title}</span>
                                {record.source === 'weflow-fork' && <small className="shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">续聊</small>}
                              </span>
                              <span className="mt-0.5 block truncate text-muted-foreground text-xs tabular-nums">
                                {formatRecordTime(record.updatedAt)}
                              </span>
                            </span>
                          </button>
                          <HeroButton
                            aria-label={record.pinned ? `取消置顶 ${record.title}` : `置顶 ${record.title}`}
                            className="agent-record-action-button size-9 min-w-9 shrink-0 p-0 text-muted-foreground"
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            onPress={() => { void onTogglePin(record) }}
                          ><Pin className={`size-4 ${record.pinned ? 'fill-current text-primary' : ''}`} /></HeroButton>
                          <HeroButton
                            aria-label={`重命名 ${record.title}`}
                            className="agent-record-action-button size-9 min-w-9 shrink-0 p-0 text-muted-foreground"
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            onPress={() => { setEditingId(record.id); setEditTitle(record.title); setDeleteConfirmId(null) }}
                          ><Pencil className="size-4" /></HeroButton>
                          <HeroButton
                            aria-label={`删除 ${record.title}`}
                            className="agent-record-delete-button size-9 min-w-9 shrink-0 p-0 text-muted-foreground"
                            isIconOnly
                            render={(buttonProps) => <button {...buttonProps} title={`删除 ${record.title}`} />}
                            size="sm"
                            variant="ghost"
                            onPress={() => setDeleteConfirmId(record.id)}
                          >
                            <TrashBin className="size-4" />
                          </HeroButton>
                          </div>
                        )}
                        <AnimatePresence initial={false}>
                          {deleteConfirmId === record.id && (
                            <motion.div
                              animate={{ height: 'auto', marginTop: 8, opacity: 1, y: 0 }}
                              className="agent-record-delete-confirm-shell"
                              exit={{ height: 0, marginTop: 0, opacity: 0, y: reduceMotion ? 0 : -5 }}
                              initial={reduceMotion
                                ? { height: 0, marginTop: 0, opacity: 0 }
                                : { height: 0, marginTop: 0, opacity: 0, y: -7 }}
                              transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                            >
                              <div className="agent-record-delete-confirm" role="alert">
                                <span>永久删除这段对话？</span>
                                <button type="button" onClick={() => setDeleteConfirmId(null)}>取消</button>
                                <button type="button" onClick={() => { void onDeleteRecord(record); setDeleteConfirmId(null) }}>删除</button>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
                {/* 截断提示：当记录超过可见上限且未在搜索态时，告知用户总数并引导用搜索。 */}
                {hasMore && (
                  <div className="mt-1 min-h-10 rounded-xl bg-muted/20 px-3 py-2 text-center text-muted-foreground text-xs" role="status">
                    {isFiltered
                      ? `还有 ${totalCount - RECORDS_VISIBLE_LIMIT} 条匹配，请细化关键词`
                      : `共 ${totalCount} 条，已显示最近 ${RECORDS_VISIBLE_LIMIT} 条，输入关键词搜索更多`}
                  </div>
                )}
              </>
            )}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

export const AgentRecordsMenu = memo(AgentRecordsMenuImpl)
