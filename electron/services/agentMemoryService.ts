import { app } from 'electron'
import { randomUUID } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { agentMemoryRelevance } from './agentMemoryRelevance'

export type AgentMemoryCategory = 'identity' | 'preference' | 'relationship' | 'project' | 'communication' | 'habit' | 'goal' | 'event' | 'other'

export type AgentMemoryEntry = {
  id: string
  title: string
  detail: string
  category: AgentMemoryCategory
  createdAt: number
  updatedAt: number
}

export type AgentMemoryEntryDraft = Pick<AgentMemoryEntry, 'title' | 'detail' | 'category'>

export type AgentMemoryEntryPatchOperation =
  | { op: 'add'; entry: AgentMemoryEntryDraft }
  | { op: 'update'; targetId: string; entry: AgentMemoryEntryDraft }
  | { op: 'delete'; targetId: string }

export type AgentMemoryScope =
  | { kind: 'global' }
  | { kind: 'session'; sessionId: string; displayName?: string }

export type AgentMemorySource = {
  kind: 'manual' | 'conversation'
  conversationId?: number
  messageId?: string
  note?: string
}

export type AgentMemoryRecord = {
  id: string
  content: string
  category: AgentMemoryCategory
  confidence: number
  scope: AgentMemoryScope
  source: AgentMemorySource
  createdAt: number
  updatedAt: number
  expiresAt?: number
  archived?: boolean
}

export type AgentMemorySummarySnapshot = {
  enabled: boolean
  summary: string
  entries: AgentMemoryEntry[]
  needsRebuild: boolean
  updatedAt?: number
  lastReviewedAt?: number
  lastReviewStatus?: 'updated' | 'unchanged' | 'failed'
  lastReviewError?: string
  revision: number
  processedTurnCount: number
  legacyMemoryCount: number
}

type MemoryEnvelope = {
  version: 7
  enabled: boolean
  summary: string
  entries: AgentMemoryEntry[]
  needsRebuild: boolean
  summaryUpdatedAt?: number
  lastReviewedAt?: number
  lastReviewStatus?: 'updated' | 'unchanged' | 'failed'
  lastReviewError?: string
  revision: number
  processedTurnIds: string[]
  memories: AgentMemoryRecord[]
}

export type AgentMemorySummaryApplyResult = {
  applied: boolean
  changed: boolean
  conflict: boolean
  snapshot: AgentMemorySummarySnapshot
}

const CATEGORIES = new Set<AgentMemoryCategory>([
  'identity',
  'preference',
  'relationship',
  'project',
  'communication',
  'habit',
  'goal',
  'event',
  'other',
])

const CATEGORY_LABELS: Record<AgentMemoryCategory, string> = {
  identity: '关于你',
  preference: '偏好',
  relationship: '重要关系',
  project: '长期项目',
  communication: '沟通方式',
  habit: '习惯',
  goal: '目标与规划',
  event: '重要经历',
  other: '其他',
}

function userDataPath(): string {
  return String(process.env.WEFLOW_USER_DATA_PATH || '').trim() || app.getPath('userData')
}

function normalizeContent(value: unknown): string {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

export function normalizeAgentMemorySummary(value: unknown): string {
  const normalized = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 16_000)
  if (!normalized || /^(?:无|暂无|none|empty)$/i.test(normalized)) return ''
  return /^#{2,4}\s+/m.test(normalized) ? normalized : `### 概览\n\n${normalized}`
}

function normalizeEntryTitle(value: unknown): string {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function normalizeEntryDetail(value: unknown): string {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4_000)
}

function normalizeEntry(value: unknown, previous?: AgentMemoryEntry): AgentMemoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AgentMemoryEntry>
  const title = normalizeEntryTitle(candidate.title)
  const detail = normalizeEntryDetail(candidate.detail)
  if (!title || !detail) return null
  const now = Date.now()
  return {
    id: String(candidate.id || previous?.id || randomUUID()).trim().slice(0, 180),
    title,
    detail,
    category: CATEGORIES.has(candidate.category as AgentMemoryCategory) ? candidate.category as AgentMemoryCategory : 'other',
    createdAt: Number(candidate.createdAt || previous?.createdAt || now),
    updatedAt: Number(candidate.updatedAt || previous?.updatedAt || now),
  }
}

function entriesFromSummary(summary: string, updatedAt?: number): AgentMemoryEntry[] {
  const normalized = normalizeAgentMemorySummary(summary)
  if (!normalized) return []
  const matches = Array.from(normalized.matchAll(/^###\s+(.+)$/gmu))
  const now = Number(updatedAt || Date.now())
  if (matches.length === 0) {
    return [normalizeEntry({ title: '概览', detail: normalized, category: 'other', createdAt: now, updatedAt: now })!]
  }
  return matches.map((match, index) => normalizeEntry({
    title: match[1],
    detail: normalized.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? normalized.length).trim(),
    category: /关系|家人|朋友|伴侣|情感/u.test(match[1]) ? 'relationship' : 'other',
    createdAt: now,
    updatedAt: now,
  })).filter((entry): entry is AgentMemoryEntry => Boolean(entry))
}

function summaryFromEntries(entries: AgentMemoryEntry[]): string {
  return entries.map((entry) => `### ${entry.title}\n\n${entry.detail}`).join('\n\n')
}

function normalizeScope(value: unknown): AgentMemoryScope {
  const candidate = value && typeof value === 'object' ? value as Partial<AgentMemoryScope> : null
  if (candidate?.kind === 'session') {
    const sessionId = String((candidate as { sessionId?: unknown }).sessionId || '').trim().slice(0, 256)
    if (sessionId) {
      const displayName = String((candidate as { displayName?: unknown }).displayName || '').trim().slice(0, 120)
      return { kind: 'session', sessionId, displayName: displayName || undefined }
    }
  }
  return { kind: 'global' }
}

function normalizeSource(value: unknown): AgentMemorySource {
  const candidate = value && typeof value === 'object' ? value as Partial<AgentMemorySource> : null
  const conversationId = Number(candidate?.conversationId || 0)
  return {
    kind: candidate?.kind === 'conversation' ? 'conversation' : 'manual',
    conversationId: Number.isFinite(conversationId) && conversationId > 0 ? conversationId : undefined,
    messageId: String(candidate?.messageId || '').trim().slice(0, 160) || undefined,
    note: String(candidate?.note || '').trim().slice(0, 240) || undefined,
  }
}

function normalizeRecord(value: unknown): AgentMemoryRecord | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AgentMemoryRecord>
  const content = normalizeContent(candidate.content)
  const id = String(candidate.id || '').trim()
  if (!id || !content) return null
  const now = Date.now()
  const confidence = Number(candidate.confidence)
  const expiresAt = Number(candidate.expiresAt || 0)
  return {
    id,
    content,
    category: CATEGORIES.has(candidate.category as AgentMemoryCategory) ? candidate.category as AgentMemoryCategory : 'other',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 1,
    scope: normalizeScope(candidate.scope),
    source: normalizeSource(candidate.source),
    createdAt: Number(candidate.createdAt || now),
    updatedAt: Number(candidate.updatedAt || now),
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined,
    archived: candidate.archived === true || undefined,
  }
}

function activeMemories(memories: AgentMemoryRecord[]): AgentMemoryRecord[] {
  const now = Date.now()
  return memories.filter((item) => !item.archived && (!item.expiresAt || item.expiresAt > now))
}

function summaryFromLegacyMemories(memories: AgentMemoryRecord[]): string {
  const grouped = new Map<AgentMemoryCategory, string[]>()
  for (const memory of activeMemories(memories).sort((left, right) => right.updatedAt - left.updatedAt)) {
    const values = grouped.get(memory.category) || []
    if (!values.some((content) => content.toLocaleLowerCase() === memory.content.toLocaleLowerCase())) {
      values.push(memory.content)
    }
    grouped.set(memory.category, values)
  }
  return Array.from(grouped.entries())
    .map(([category, values]) => `### ${CATEGORY_LABELS[category]}\n\n${values.slice(0, 12).join('；')}。`)
    .join('\n\n')
}

function normalizeEnvelope(value: unknown): MemoryEnvelope {
  const candidate = value && typeof value === 'object' ? value as {
    version?: unknown
    enabled?: unknown
    summary?: unknown
    entries?: unknown
    needsRebuild?: unknown
    summaryUpdatedAt?: unknown
    lastReviewedAt?: unknown
    lastReviewStatus?: unknown
    lastReviewError?: unknown
    revision?: unknown
    processedTurnIds?: unknown
    memories?: unknown
  } : null
  const rawMemories: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(candidate?.memories)
      ? candidate.memories
      : []
  const memories = rawMemories.map(normalizeRecord).filter((item): item is AgentMemoryRecord => Boolean(item))
  const isVersionTwo = candidate?.version === 2
  const isVersionThree = candidate?.version === 3
  const isVersionFour = candidate?.version === 4
  const isVersionFive = candidate?.version === 5
  const isVersionSix = candidate?.version === 6
  const isVersionSeven = candidate?.version === 7
  const isStructured = isVersionTwo || isVersionThree || isVersionFour || isVersionFive || isVersionSix || isVersionSeven
  const summaryUpdatedAt = isStructured && Number(candidate?.summaryUpdatedAt) > 0
    ? Number(candidate?.summaryUpdatedAt)
    : undefined
  const storedEntries = (isVersionThree || isVersionFour || isVersionFive || isVersionSix || isVersionSeven) && Array.isArray(candidate?.entries)
    ? candidate.entries.map((entry: unknown) => normalizeEntry(entry)).filter((entry): entry is AgentMemoryEntry => Boolean(entry))
    : []
  const legacySummary = isStructured
    ? normalizeAgentMemorySummary(candidate?.summary) || summaryFromLegacyMemories(memories)
    : summaryFromLegacyMemories(memories)
  const entries = storedEntries.length > 0 ? storedEntries : entriesFromSummary(legacySummary, summaryUpdatedAt)
  return {
    version: 7,
    enabled: isStructured ? candidate?.enabled !== false : true,
    summary: summaryFromEntries(entries),
    entries,
    needsRebuild: isVersionSeven
      ? candidate?.needsRebuild === true
      : true,
    summaryUpdatedAt,
    lastReviewedAt: isStructured && Number(candidate?.lastReviewedAt) > 0
      ? Number(candidate?.lastReviewedAt)
      : undefined,
    lastReviewStatus: isStructured && ['updated', 'unchanged', 'failed'].includes(String(candidate?.lastReviewStatus || ''))
      ? candidate?.lastReviewStatus as MemoryEnvelope['lastReviewStatus']
      : undefined,
    lastReviewError: isStructured
      ? String(candidate?.lastReviewError || '').replace(/\u0000/g, '').trim().slice(0, 500) || undefined
      : undefined,
    revision: isStructured ? Math.max(0, Math.floor(Number(candidate?.revision) || 0)) : 0,
    processedTurnIds: isStructured && Array.isArray(candidate?.processedTurnIds)
      ? candidate.processedTurnIds.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(-200)
      : [],
    memories,
  }
}

export class AgentMemoryStore {
  private filePath(): string {
    return join(userDataPath(), 'agent-memories.json')
  }

  private readState(): MemoryEnvelope {
    const filePath = this.filePath()
    if (!existsSync(filePath)) return normalizeEnvelope(null)
    try {
      return normalizeEnvelope(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch {
      return normalizeEnvelope(null)
    }
  }

  private withWriteLock<T>(operation: () => T): T {
    const lockPath = `${this.filePath()}.lock`
    mkdirSync(dirname(lockPath), { recursive: true })
    let descriptor: number | null = null
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        descriptor = openSync(lockPath, 'wx')
        break
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException | undefined)?.code || '')
        if (code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath)
        } catch { /* 另一个进程可能刚好释放了锁。 */ }
        const signal = new Int32Array(new SharedArrayBuffer(4))
        Atomics.wait(signal, 0, 0, 25)
      }
    }
    if (descriptor === null) throw new Error('记忆正在被另一个任务更新，请稍后重试')
    try {
      return operation()
    } finally {
      try { closeSync(descriptor) } catch { /* 锁文件仍会继续清理。 */ }
      try { unlinkSync(lockPath) } catch { /* 进程退出后陈旧锁会被下一次更新清理。 */ }
    }
  }

  private writeState(state: MemoryEnvelope): void {
    const filePath = this.filePath()
    mkdirSync(dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8')
    try {
      renameSync(temporaryPath, filePath)
    } finally {
      if (existsSync(temporaryPath)) {
        try { unlinkSync(temporaryPath) } catch { /* 下次读取不会接纳临时文件。 */ }
      }
    }
  }

  private snapshotOf(state: MemoryEnvelope): AgentMemorySummarySnapshot {
    return {
      enabled: state.enabled,
      summary: summaryFromEntries(state.entries),
      entries: state.entries,
      needsRebuild: state.needsRebuild,
      updatedAt: state.summaryUpdatedAt,
      lastReviewedAt: state.lastReviewedAt,
      lastReviewStatus: state.lastReviewStatus,
      lastReviewError: state.lastReviewError,
      revision: state.revision,
      processedTurnCount: state.processedTurnIds.length,
      legacyMemoryCount: activeMemories(state.memories).length,
    }
  }

  getSummary(): AgentMemorySummarySnapshot {
    return this.snapshotOf(this.readState())
  }

  hasProcessedTurn(turnId: string): boolean {
    const normalized = String(turnId || '').trim()
    return Boolean(normalized) && this.readState().processedTurnIds.includes(normalized)
  }

  replaceSummary(
    summary: string,
    options: { expectedRevision?: number; processedTurnId?: string } = {},
  ): AgentMemorySummaryApplyResult {
    return this.replaceEntries(entriesFromSummary(summary), options)
  }

  replaceEntries(
    entries: AgentMemoryEntryDraft[],
    options: { expectedRevision?: number; processedTurnId?: string } = {},
  ): AgentMemorySummaryApplyResult {
    return this.withWriteLock(() => {
      const state = this.readState()
      if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
        return { applied: false, changed: false, conflict: true, snapshot: this.snapshotOf(state) }
      }
      const processedTurnId = String(options.processedTurnId || '').trim().slice(0, 180)
      if (processedTurnId && state.processedTurnIds.includes(processedTurnId)) {
        return { applied: false, changed: false, conflict: false, snapshot: this.snapshotOf(state) }
      }
      const previousByTitle = new Map(state.entries.map((entry) => [entry.title.toLocaleLowerCase(), entry]))
      const now = Date.now()
      const normalized = entries
        .map((entry) => {
          const previous = previousByTitle.get(normalizeEntryTitle(entry.title).toLocaleLowerCase())
          return normalizeEntry({
            ...entry,
            id: previous?.id,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
          }, previous)
        })
        .filter((entry): entry is AgentMemoryEntry => Boolean(entry))
        .filter((entry, index, values) => values.findIndex((candidate) => candidate.title.toLocaleLowerCase() === entry.title.toLocaleLowerCase()) === index)
        .slice(0, 24)
      const comparable = (values: AgentMemoryEntry[]) => values.map(({ title, detail, category }) => ({ title, detail, category }))
      const changed = JSON.stringify(comparable(normalized)) !== JSON.stringify(comparable(state.entries))
      state.entries = normalized
      state.summary = summaryFromEntries(normalized)
      state.needsRebuild = false
      if (changed) state.summaryUpdatedAt = Date.now()
      state.lastReviewedAt = Date.now()
      state.lastReviewStatus = changed ? 'updated' : 'unchanged'
      state.lastReviewError = undefined
      if (processedTurnId) state.processedTurnIds.push(processedTurnId)
      state.processedTurnIds = Array.from(new Set(state.processedTurnIds)).slice(-200)
      state.revision += 1
      this.writeState(state)
      return { applied: true, changed, conflict: false, snapshot: this.snapshotOf(state) }
    })
  }

  applyEntryPatch(
    operations: AgentMemoryEntryPatchOperation[],
    options: { expectedRevision?: number; processedTurnId?: string } = {},
  ): AgentMemorySummaryApplyResult {
    return this.withWriteLock(() => {
      const state = this.readState()
      if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
        return { applied: false, changed: false, conflict: true, snapshot: this.snapshotOf(state) }
      }
      const processedTurnId = String(options.processedTurnId || '').trim().slice(0, 180)
      if (processedTurnId && state.processedTurnIds.includes(processedTurnId)) {
        return { applied: false, changed: false, conflict: false, snapshot: this.snapshotOf(state) }
      }

      const next = [...state.entries]
      const now = Date.now()
      for (const operation of operations.slice(0, 12)) {
        if (operation.op === 'delete') {
          const targetId = String(operation.targetId || '').trim()
          const index = next.findIndex((entry) => entry.id === targetId)
          if (index >= 0) next.splice(index, 1)
          continue
        }

        const targetId = operation.op === 'update' ? String(operation.targetId || '').trim() : ''
        const normalizedTitle = normalizeEntryTitle(operation.entry.title)
        const targetIndex = targetId
          ? next.findIndex((entry) => entry.id === targetId)
          : next.findIndex((entry) => entry.title.toLocaleLowerCase() === normalizedTitle.toLocaleLowerCase())
        const previous = targetIndex >= 0 ? next[targetIndex] : undefined
        const normalized = normalizeEntry({
          ...operation.entry,
          id: previous?.id,
          createdAt: previous?.createdAt || now,
          updatedAt: now,
        }, previous)
        if (!normalized) continue
        if (targetIndex >= 0) next[targetIndex] = normalized
        else next.push(normalized)
      }

      const deduplicated = next
        .filter((entry, index, values) => values.findIndex((candidate) => candidate.title.toLocaleLowerCase() === entry.title.toLocaleLowerCase()) === index)
        .slice(0, 24)
      const comparable = (values: AgentMemoryEntry[]) => values.map(({ title, detail, category }) => ({ title, detail, category }))
      const changed = JSON.stringify(comparable(deduplicated)) !== JSON.stringify(comparable(state.entries))
      state.entries = deduplicated
      state.summary = summaryFromEntries(deduplicated)
      state.needsRebuild = false
      if (changed) state.summaryUpdatedAt = now
      state.lastReviewedAt = now
      state.lastReviewStatus = changed ? 'updated' : 'unchanged'
      state.lastReviewError = undefined
      if (processedTurnId) state.processedTurnIds.push(processedTurnId)
      state.processedTurnIds = Array.from(new Set(state.processedTurnIds)).slice(-200)
      state.revision += 1
      this.writeState(state)
      return { applied: true, changed, conflict: false, snapshot: this.snapshotOf(state) }
    })
  }

  recordReviewFailure(error: unknown): AgentMemorySummarySnapshot {
    return this.withWriteLock(() => {
      const state = this.readState()
      state.lastReviewedAt = Date.now()
      state.lastReviewStatus = 'failed'
      state.lastReviewError = String(error || '记忆更新失败').replace(/\u0000/g, '').trim().slice(0, 500) || '记忆更新失败'
      state.revision += 1
      this.writeState(state)
      return this.snapshotOf(state)
    })
  }

  setEnabled(enabled: boolean): AgentMemorySummarySnapshot {
    return this.withWriteLock(() => {
      const state = this.readState()
      if (state.enabled === enabled) return this.snapshotOf(state)
      state.enabled = enabled
      state.revision += 1
      this.writeState(state)
      return this.snapshotOf(state)
    })
  }

  clear(options: { disable?: boolean } = {}): AgentMemorySummarySnapshot {
    return this.withWriteLock(() => {
      const state = this.readState()
      state.summary = ''
      state.entries = []
      state.needsRebuild = false
      state.summaryUpdatedAt = undefined
      state.lastReviewedAt = undefined
      state.lastReviewStatus = undefined
      state.lastReviewError = undefined
      state.processedTurnIds = []
      state.memories = []
      if (options.disable) state.enabled = false
      state.revision += 1
      this.writeState(state)
      return this.snapshotOf(state)
    })
  }

  list(options: { query?: string; includeArchived?: boolean; scope?: AgentMemoryScope } = {}): AgentMemoryRecord[] {
    const query = normalizeContent(options.query)
    const now = Date.now()
    return this.readState().memories
      .filter((item) => options.includeArchived || !item.archived)
      .filter((item) => !item.expiresAt || item.expiresAt > now)
      .filter((item) => {
        if (!options.scope) return true
        if (item.scope.kind === 'global') return true
        return options.scope.kind === 'session' && item.scope.sessionId === options.scope.sessionId
      })
      .filter((item) => !query || agentMemoryRelevance(
        query,
        `${item.content} ${item.category} ${item.scope.kind === 'session' ? item.scope.displayName || item.scope.sessionId : ''}`,
      ).score > 0)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  create(input: Partial<AgentMemoryRecord>): AgentMemoryRecord {
    const content = normalizeContent(input.content)
    if (!content) throw new Error('记忆内容不能为空')
    return this.withWriteLock(() => {
      const state = this.readState()
      const requestedScope = normalizeScope(input.scope)
      const duplicate = state.memories.find((item) => (
        !item.archived
        && item.content.toLocaleLowerCase() === content.toLocaleLowerCase()
        && item.scope.kind === requestedScope.kind
        && (item.scope.kind !== 'session' || (requestedScope.kind === 'session' && item.scope.sessionId === requestedScope.sessionId))
      ))
      if (duplicate) return duplicate
      const now = Date.now()
      const record = normalizeRecord({
        ...input,
        id: randomUUID(),
        content,
        scope: requestedScope,
        createdAt: now,
        updatedAt: now,
      })!
      state.memories.push(record)
      state.revision += 1
      this.writeState(state)
      return record
    })
  }

  update(id: string, patch: Partial<AgentMemoryRecord>): AgentMemoryRecord | null {
    return this.withWriteLock(() => {
      const state = this.readState()
      const index = state.memories.findIndex((item) => item.id === id)
      if (index < 0) return null
      const record = normalizeRecord({
        ...state.memories[index],
        ...patch,
        id: state.memories[index].id,
        source: patch.source ? normalizeSource(patch.source) : state.memories[index].source,
        scope: patch.scope ? normalizeScope(patch.scope) : state.memories[index].scope,
        updatedAt: Date.now(),
      })
      if (!record) throw new Error('记忆内容不能为空')
      state.memories[index] = record
      state.revision += 1
      this.writeState(state)
      return record
    })
  }

  delete(id: string): boolean {
    return this.withWriteLock(() => {
      const state = this.readState()
      const next = state.memories.filter((item) => item.id !== id)
      if (next.length === state.memories.length) return false
      state.memories = next
      state.revision += 1
      this.writeState(state)
      return true
    })
  }

  readEntriesByTitles(titles: string[]): AgentMemoryEntry[] {
    const state = this.readState()
    if (!state.enabled) return []
    const requested = Array.from(new Set(titles.map(normalizeEntryTitle).filter(Boolean))).slice(0, 12)
    return requested.flatMap((title) => {
      const exact = state.entries.find((entry) => entry.title.toLocaleLowerCase() === title.toLocaleLowerCase())
      if (exact) return [exact]
      const related = state.entries
        .map((entry) => ({ entry, score: agentMemoryRelevance(title, entry.title).score }))
        .sort((left, right) => right.score - left.score)[0]
      return related && related.score >= 0.45 ? [related.entry] : []
    }).filter((entry, index, values) => values.findIndex((candidate) => candidate.id === entry.id) === index)
  }

  contextFor(_query: string, _scope: AgentMemoryScope): string {
    const state = this.readState()
    if (!state.enabled || state.entries.length === 0) return ''
    return state.entries.map((entry) => `- ${entry.title}`).join('\n')
  }
}

export const agentMemoryStore = new AgentMemoryStore()
