import { Fragment, useEffect, useRef, useState } from 'react'
import { Button as HeroButton, Dropdown, Label, SearchField } from '@heroui/react'
import { At, Persons, Xmark } from '@gravity-ui/icons'
import type { UIMessage } from 'ai'

export type MentionTarget = {
  username: string
  displayName: string
  kind: 'person' | 'group' | 'official'
  avatarUrl?: string
}

export type MentionTargetResolver = (username: string, displayName?: string) => MentionTarget | undefined

export type MentionTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; target: MentionTarget }

export type MentionInputQuery = {
  start: number
  end: number
  query: string
}

export const MENTION_SESSION_PAGE_SIZE = 1000

export function findActiveMentionQuery(text: string, caret: number): MentionInputQuery | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const beforeCaret = text.slice(0, safeCaret)
  const start = beforeCaret.lastIndexOf('@')
  if (start < 0) return null

  const query = beforeCaret.slice(start + 1)
  if (/[@\s\[\]{}()（）【】，,。.!！?？;；:："'“”‘’\r\n]/u.test(query)) return null

  // Do not treat the @ inside an email address or ASCII identifier as a mention.
  const previousCharacter = text[start - 1] || ''
  if (previousCharacter && /[A-Za-z0-9_.+-]/u.test(previousCharacter)) return null

  return { start, end: safeCaret, query }
}

function mentionNameMatchesAt(text: string, start: number, name: string): boolean {
  if (!name || !text.startsWith(name, start)) return false
  const lastNameCharacter = name[name.length - 1] || ''
  const nextCharacter = text[start + name.length] || ''
  return !(/[A-Za-z0-9_]$/u.test(lastNameCharacter) && /^[A-Za-z0-9_]/u.test(nextCharacter))
}

export function findNextUnresolvedMentionQuery(
  text: string,
  selectedMentions: MentionTarget[],
  sessions: MentionTarget[],
  fromIndex = 0,
  knownOnly = false,
): MentionInputQuery | null {
  const selectedNames = selectedMentions
    .map((target) => target.displayName.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const availableNames = sessions
    .filter((target) => !selectedMentions.some((selected) => selected.username === target.username))
    .map((target) => target.displayName.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)

  let cursor = Math.max(0, fromIndex)
  while (cursor < text.length) {
    const start = text.indexOf('@', cursor)
    if (start < 0) return null
    const previousCharacter = text[start - 1] || ''
    if (previousCharacter && /[A-Za-z0-9_.+-]/u.test(previousCharacter)) {
      cursor = start + 1
      continue
    }

    const nameStart = start + 1
    const selectedName = selectedNames.find((name) => mentionNameMatchesAt(text, nameStart, name))
    if (selectedName) {
      cursor = nameStart + selectedName.length
      continue
    }

    const knownName = availableNames.find((name) => mentionNameMatchesAt(text, nameStart, name))
    if (knownName) return { start, end: nameStart + knownName.length, query: knownName }

    if (knownOnly) {
      cursor = nameStart
      continue
    }

    let end = nameStart
    while (end < text.length && !/[@\s\[\]{}()（）【】，,。.!！?？;；:："'“”‘’\r\n]/u.test(text[end])) end += 1
    return { start, end, query: text.slice(nameStart, end) }
  }
  return null
}

export function classifyTarget(username: string): MentionTarget['kind'] {
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'person'
}

export function toMentionTarget(username: string, displayName?: string, avatarUrl?: string): MentionTarget {
  return { username, displayName: displayName || username, kind: classifyTarget(username), avatarUrl }
}

export function splitMentionPrefix(text: string): { mentions: MentionTarget[]; text: string } {
  const mentions: MentionTarget[] = []
  let rest = text
  while (true) {
    const match = rest.match(/^@([^\[\]\r\n]+)\[([^\]\r\n]+)\][ \t]*/)
    if (!match) break
    const displayName = match[1].trim()
    const username = match[2].trim()
    if (!displayName || !username) break
    mentions.push(toMentionTarget(username, displayName))
    rest = rest.slice(match[0].length)
  }
  return { mentions, text: mentions.length ? rest.replace(/^\r?\n/, '') : text }
}

function resolveMentionTarget(target: MentionTarget, resolveTarget?: MentionTargetResolver): MentionTarget {
  const resolved = resolveTarget?.(target.username, target.displayName)
  if (!resolved) return target
  return {
    ...resolved,
    displayName: target.displayName || resolved.displayName,
    avatarUrl: resolved.avatarUrl || target.avatarUrl,
  }
}

function legacyMentionHeader(text: string, resolveTarget?: MentionTargetResolver): {
  mentions: MentionTarget[]
  text: string
} | null {
  const newlineIndex = text.search(/\r?\n/)
  if (newlineIndex < 0) return null
  const header = text.slice(0, newlineIndex)
  const body = text.slice(newlineIndex).replace(/^\r?\n/, '')
  const mentions: MentionTarget[] = []
  let cursor = 0
  while (cursor < header.length) {
    while (header[cursor] === ' ' || header[cursor] === '\t') cursor += 1
    const match = header.slice(cursor).match(/^@([^\[\]\r\n]+?)\[([^\]\r\n]+)\]/)
    if (!match) return null
    const displayName = match[1].trim()
    const username = match[2].trim()
    if (!displayName || !username) return null
    mentions.push(resolveMentionTarget(toMentionTarget(username, displayName), resolveTarget))
    cursor += match[0].length
  }
  return mentions.length > 0 ? { mentions, text: body } : null
}

export function parseMentionText(text: string, resolveTarget?: MentionTargetResolver): {
  mentions: MentionTarget[]
  plainText: string
  segments: MentionTextSegment[]
} {
  const legacy = legacyMentionHeader(text, resolveTarget)
  if (legacy) {
    const segments: MentionTextSegment[] = []
    legacy.mentions.forEach((target, index) => {
      if (index > 0) segments.push({ kind: 'text', text: ' ' })
      segments.push({ kind: 'mention', target })
    })
    if (legacy.text) segments.push({ kind: 'text', text: `${segments.length > 0 ? ' ' : ''}${legacy.text}` })
    return {
      mentions: legacy.mentions,
      plainText: `${legacy.mentions.map((target) => `@${target.displayName}`).join(' ')}${legacy.text ? ` ${legacy.text}` : ''}`,
      segments,
    }
  }

  const mentions: MentionTarget[] = []
  const segments: MentionTextSegment[] = []
  const pattern = /@([^\[\]\r\n]+?)\[([^\]\r\n]+)\]/gu
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    const target = resolveMentionTarget(toMentionTarget(match[2].trim(), match[1].trim()), resolveTarget)
    mentions.push(target)
    segments.push({ kind: 'mention', target })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  if (segments.length === 0 && text) segments.push({ kind: 'text', text })
  return {
    mentions,
    plainText: segments.map((segment) => segment.kind === 'mention' ? `@${segment.target.displayName}` : segment.text).join(''),
    segments,
  }
}

export function encodeMentionText(text: string, mentions: MentionTarget[]): string {
  if (!text || mentions.length === 0) return text
  const candidates = mentions
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => target.displayName.trim() && target.username.trim())
    .sort((left, right) => right.target.displayName.length - left.target.displayName.length || left.index - right.index)
  let encoded = ''
  let cursor = 0
  while (cursor < text.length) {
    if (text[cursor] !== '@') {
      encoded += text[cursor]
      cursor += 1
      continue
    }
    const matched = candidates.find(({ target }) => {
      if (!text.startsWith(target.displayName, cursor + 1)) return false
      const lastNameCharacter = target.displayName[target.displayName.length - 1] || ''
      const nextCharacter = text[cursor + target.displayName.length + 1] || ''
      return !(/[A-Za-z0-9_]$/.test(lastNameCharacter) && /^[A-Za-z0-9_]/.test(nextCharacter))
    })?.target
    if (!matched) {
      encoded += text[cursor]
      cursor += 1
      continue
    }
    encoded += `@${matched.displayName}[${matched.username}]`
    cursor += matched.displayName.length + 1
  }
  return encoded
}

export function segmentComposerMentionText(text: string, mentions: MentionTarget[]): MentionTextSegment[] {
  if (!text) return []
  const candidates = mentions
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => target.displayName.trim() && target.username.trim())
    .sort((left, right) => right.target.displayName.length - left.target.displayName.length || left.index - right.index)
  if (candidates.length === 0) return [{ kind: 'text', text }]

  const segments: MentionTextSegment[] = []
  let cursor = 0
  let textStart = 0
  while (cursor < text.length) {
    if (text[cursor] !== '@' || (text[cursor - 1] && /[A-Za-z0-9_.+-]/u.test(text[cursor - 1]))) {
      cursor += 1
      continue
    }
    const matched = candidates.find(({ target }) => (
      mentionNameMatchesAt(text, cursor + 1, target.displayName)
    ))?.target
    if (!matched) {
      cursor += 1
      continue
    }
    if (cursor > textStart) segments.push({ kind: 'text', text: text.slice(textStart, cursor) })
    segments.push({ kind: 'mention', target: matched })
    cursor += matched.displayName.length + 1
    textStart = cursor
  }
  if (textStart < text.length) segments.push({ kind: 'text', text: text.slice(textStart) })
  return segments.length > 0 ? segments : [{ kind: 'text', text }]
}

export function getUserMessageDisplay(parts: UIMessage['parts'], resolveTarget?: MentionTargetResolver): {
  mentions: MentionTarget[]
  textByPartIndex: Map<number, string>
  segmentsByPartIndex: Map<number, MentionTextSegment[]>
} {
  const mentions: MentionTarget[] = []
  const textByPartIndex = new Map<number, string>()
  const segmentsByPartIndex = new Map<number, MentionTextSegment[]>()
  const seen = new Set<string>()
  parts.forEach((part, index) => {
    if (part.type !== 'text') return
    const parsed = parseMentionText(part.text || '', resolveTarget)
    textByPartIndex.set(index, parsed.plainText)
    segmentsByPartIndex.set(index, parsed.segments)
    for (const target of parsed.mentions) {
      if (seen.has(target.username)) continue
      seen.add(target.username)
      mentions.push(target)
    }
  })
  return { mentions, textByPartIndex, segmentsByPartIndex }
}

function avatarLetter(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function MentionAvatar({ target, compact = false }: { target: MentionTarget; compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full border border-border/60 bg-background/70 font-medium text-muted-foreground ${compact ? 'size-5 text-[10px]' : 'size-9 text-xs'}`}
    >
      {target.avatarUrl ? (
        <img alt="" className="size-full object-cover" draggable={false} src={target.avatarUrl} />
      ) : (
        avatarLetter(target.displayName)
      )}
    </span>
  )
}

function targetKindLabel(kind: MentionTarget['kind']): string {
  if (kind === 'group') return '群聊'
  if (kind === 'official') return '公众号'
  return '联系人'
}

export function InlineMentionText({ segments }: { segments: MentionTextSegment[] }) {
  return (
    <div className="agent-user-inline-text">
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <span key={`text-${index}`}>{segment.text}</span>
        const previous = segments[index - 1]
        const next = segments[index + 1]
        const addSpaceBefore = previous?.kind === 'text' && !/\s$/u.test(previous.text)
        const addSpaceAfter = Boolean(next && (next.kind === 'mention' || !/^\s/u.test(next.text)))
        return (
          <Fragment key={`mention-${segment.target.username}-${index}`}>
            {addSpaceBefore && ' '}
            <span
              aria-label={`提及${targetKindLabel(segment.target.kind)} ${segment.target.displayName}`}
              className="agent-inline-mention"
              data-kind={segment.target.kind}
              title={`${targetKindLabel(segment.target.kind)} · ${segment.target.displayName}`}
            >
              <span aria-hidden="true" className="agent-inline-mention-at">@</span>
              <span>{segment.target.displayName}</span>
            </span>
            {addSpaceAfter && ' '}
          </Fragment>
        )
      })}
    </div>
  )
}

export function filterMentionTargets(sessions: MentionTarget[], query: string, limit = 30): MentionTarget[] {
  const keyword = query.trim().toLowerCase()
  return sessions
    .filter((item) => (
      !keyword
      || `${item.displayName} ${item.username} ${targetKindLabel(item.kind)}`.toLowerCase().includes(keyword)
    ))
    .slice(0, limit)
}

export function MentionTypeahead({
  query,
  sessions,
  isLoading,
  activeIndex,
  onActiveIndexChange,
  onDismiss,
  onRequest,
  onSelect,
}: {
  query: string
  sessions: MentionTarget[]
  isLoading: boolean
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onDismiss: () => void
  onRequest?: (query: string) => void
  onSelect: (target: MentionTarget) => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const visible = filterMentionTargets(sessions, query)

  useEffect(() => {
    const timer = window.setTimeout(() => onRequest?.(query.trim()), query.trim() ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [onRequest, query])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (target instanceof HTMLTextAreaElement && target.closest('.agent-prompt-input')) return
      onDismiss()
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onDismiss])

  return (
    <div className="agent-mention-typeahead" ref={panelRef}>
      <div className="agent-mention-typeahead__heading">
        <span>提及联系人或群</span>
        {query && <span className="agent-mention-typeahead__query">@{query}</span>}
      </div>
      <div
        aria-label="提及联系人或群"
        className="agent-mention-typeahead__list"
        id="agent-mention-suggestions"
        role="listbox"
      >
        {isLoading && visible.length === 0 ? (
          <div aria-disabled="true" className="agent-mention-typeahead__status" role="option">正在查找…</div>
        ) : visible.length === 0 ? (
          <div aria-disabled="true" className="agent-mention-typeahead__status" role="option">未找到匹配对象</div>
        ) : visible.map((target, index) => (
          <button
            aria-selected={index === activeIndex}
            className="agent-mention-typeahead__option"
            data-active={index === activeIndex ? 'true' : undefined}
            id={`agent-mention-suggestion-${index}`}
            key={target.username}
            onClick={() => onSelect(target)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActiveIndexChange(index)}
            role="option"
            type="button"
          >
            <MentionAvatar target={target} />
            <span className="agent-mention-typeahead__name">{target.displayName}</span>
            <span className="agent-mention-typeahead__kind">{targetKindLabel(target.kind)}</span>
          </button>
        ))}
      </div>
      <div className="agent-mention-typeahead__hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
    </div>
  )
}

export function MentionTargetChips({ targets, align = 'start' }: { targets: MentionTarget[]; align?: 'start' | 'end' }) {
  if (!targets.length) return null
  return (
    <div
      aria-label="提及对象"
      className={`mb-1 flex flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : ''}`}
      role="list"
    >
      {targets.map((target) => (
        <span
          className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 py-1 pr-2.5 pl-1.5 font-medium text-primary text-xs"
          key={target.username}
          role="listitem"
        >
          <MentionAvatar compact target={target} />
          <span className="max-w-44 truncate">@{target.displayName}</span>
        </span>
      ))}
    </div>
  )
}

export function MentionField({
  mentions,
  onRemove,
}: {
  mentions: MentionTarget[]
  onRemove: (target: MentionTarget) => void
}) {
  if (mentions.length === 0) return null

  return (
    <div aria-label="已提及" className="flex w-full flex-wrap justify-start gap-1.5 px-3 pt-2" role="list">
      {mentions.map((target) => (
        <span
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 py-0.5 pr-1 pl-1.5 font-medium text-primary text-xs"
          key={target.username}
          role="listitem"
        >
          <MentionAvatar compact target={target} />
          <span className="max-w-44 truncate">@{target.displayName}</span>
          <button
            aria-label={`移除提及 ${target.displayName}`}
            className="grid size-8 shrink-0 place-items-center rounded-full text-primary outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
            onClick={() => onRemove(target)}
            title={`移除 ${target.displayName}`}
            type="button"
          >
            <Xmark className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  )
}

export function MentionTriggerButton({
  mentions,
  sessions,
  isLoading,
  onAdd,
  onRequest,
}: {
  mentions: MentionTarget[]
  sessions: MentionTarget[]
  isLoading: boolean
  onAdd: (target: MentionTarget) => void
  onRequest?: (query: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const keyword = search.trim().toLowerCase()
  const visible = filterMentionTargets(sessions, keyword)

  useEffect(() => {
    if (!isOpen) return
    const timer = window.setTimeout(() => onRequest?.(search.trim()), keyword ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [isOpen, keyword, onRequest, search])

  return (
    <Dropdown
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (open) setSearch('')
      }}
    >
      <HeroButton
        aria-label="提及联系人或群"
        className="size-9 min-w-9 rounded-xl p-0 text-muted-foreground data-[hovered=true]:text-foreground"
        isIconOnly
        render={(buttonProps) => <button {...buttonProps} title="提及联系人或群" />}
        size="sm"
        variant="ghost"
      >
        <At className="size-4.5" />
      </HeroButton>
      <Dropdown.Popover
        className="agent-mention-popover w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border/70 bg-popover p-0 text-popover-foreground shadow-xl"
        placement="top start"
      >
        <div className="border-border/60 border-b bg-popover/95 p-2.5 backdrop-blur">
          <SearchField aria-label="搜索联系人或群" className="w-full" value={search} onChange={setSearch}>
            <SearchField.Group className="h-10 w-full rounded-xl border border-border/70 bg-background/70 shadow-none">
              <SearchField.SearchIcon />
              <SearchField.Input autoFocus placeholder="搜索联系人、群聊或公众号" />
              <SearchField.ClearButton aria-label="清除搜索" />
            </SearchField.Group>
          </SearchField>
        </div>
        <Dropdown.Menu
          aria-label="提及联系人或群"
          className="agent-scrollbar max-h-72 gap-1 overflow-y-auto p-1.5"
        >
          {isLoading ? (
            <Dropdown.Item key="mention-loading" id="mention-loading" isDisabled textValue="联系人加载中">
              <Label>联系人加载中…</Label>
            </Dropdown.Item>
          ) : visible.length === 0 ? (
            <Dropdown.Item
              className="min-h-20 justify-center text-center data-[disabled=true]:opacity-100"
              key="mention-empty"
              id="mention-empty"
              isDisabled
              textValue="未找到联系人"
            >
              <span>
                <Label className="block">未找到匹配对象</Label>
                <span className="mt-1 block text-muted-foreground text-xs">换个名字或账号号试试</span>
              </span>
            </Dropdown.Item>
          ) : (
            visible.map((target) => {
              const selected = mentions.some((mention) => mention.username === target.username)
              return (
                <Dropdown.Item
                  aria-selected={selected}
                  className="min-h-12 rounded-xl px-2.5 py-2 data-[hovered=true]:bg-accent/10"
                  id={`mention-target:${target.username}`}
                  key={`mention-target:${target.username}`}
                  textValue={target.displayName}
                  onAction={() => {
                    onAdd(target)
                    setIsOpen(false)
                  }}
                >
                  <MentionAvatar target={target} />
                  <Label>{target.displayName}</Label>
                  <span>{selected ? '已在范围内' : targetKindLabel(target.kind)}</span>
                </Dropdown.Item>
              )
            })
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

export function ScopeBadge({ mentions }: { mentions: MentionTarget[] }) {
  const label = mentions.length === 1 ? `仅 ${mentions[0].displayName}` : '全部聊天'
  return (
    <span
      aria-label={`查询范围：${label}`}
      className="inline-flex min-h-8 max-w-52 items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-muted-foreground text-xs"
      title={`查询范围：${label}`}
    >
      <Persons className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
