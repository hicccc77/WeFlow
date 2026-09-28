/**
 * 运行时与渲染器共用的保守 token 估算器。
 * 这里的数值不是服务商计费数据；
 * 共用实现只是为了让编辑器计量和运行时压缩保持在同一尺度。
 */

type TokenEstimablePart = Record<string, unknown>

const RAW_EVIDENCE_TOOL_NAMES = new Set([
  'read_raw_messages',
  'read_raw_message_ranges',
  'read_raw_timeline',
  'read_raw_timeline_samples',
  'read_message_thread',
  'read_event_contexts',
  'search_raw_messages',
  'search_and_read_raw_messages',
])

function compactRawEvidencePointer(value: unknown): Record<string, unknown> | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!record) return null
  const compact: Record<string, unknown> = {}
  for (const key of [
    'status',
    'pageId',
    'pageHash',
    'sessionId',
    'displayName',
    'conversation',
    'range',
    'requestedRange',
    'coverageStatus',
    'messageCount',
    'estimatedTokens',
    'tokenBudget',
    'cacheHit',
    'nextCursor',
    'hasMore',
  ]) {
    if (record[key] !== undefined) compact[key] = record[key]
  }
  return Object.keys(compact).length > 0 ? compact : null
}

export type TokenEstimableMessage = {
  parts?: readonly unknown[]
}

/**
 * 原文读取结果只在当前调查中临时保留正文。跨轮会话保留页指针，原文仍可从
 * 加密页缓存重新读取；统一这个表示可避免刷新前后的上下文估算发生跳变。
 */
export function compactAgentToolOutputForRetention(toolName: string, output: unknown): unknown {
  const record = output && typeof output === 'object'
    ? output as Record<string, unknown>
    : null
  if (!record || !RAW_EVIDENCE_TOOL_NAMES.has(toolName)) return output

  const compact: Record<string, unknown> = { success: record.success }
  for (const key of [
    'status',
    'pageId',
    'pageHash',
    'sessionId',
    'displayName',
    'conversation',
    'range',
    'requestedRange',
    'coverageStatus',
    'messageCount',
    'estimatedTokens',
    'tokenBudget',
    'cacheHit',
    'nextCursor',
    'hasMore',
    'noNewRangeRead',
    'noNewSourceRead',
    'requestedCount',
    'count',
    'completedCount',
    'failedCount',
    'skippedDuplicateCount',
    'skippedCount',
    'returnedPageCount',
    'newSourceCount',
    'matchCount',
    'contextCount',
    'query',
    'queries',
    'sourceCoverage',
    'skippedRequests',
  ]) {
    if (record[key] !== undefined) compact[key] = record[key]
  }
  for (const key of ['pages', 'contexts', 'conversations']) {
    if (!Array.isArray(record[key])) continue
    compact[key] = (record[key] as unknown[])
      .map(compactRawEvidencePointer)
      .filter((value): value is Record<string, unknown> => value != null)
  }
  if (typeof record.workingNotes === 'string' && record.workingNotes.trim()) {
    compact.workingNotes = record.workingNotes.slice(0, 2_000)
  }
  compact.note = '原文正文未写入会话记录；后续可按页指针从本地加密缓存重新读取。'
  return compact
}

function safeJSONStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value ?? '') : serialized
  } catch {
    return String(value ?? '')
  }
}

export function estimateAgentTextTokens(value: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const char of String(value || '')) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii)
}

export function estimateAgentPartTokens(part: unknown): number {
  const candidate = (part && typeof part === 'object' ? part : {}) as TokenEstimablePart
  const type = String(candidate.type || '')
  if (type === 'text') return estimateAgentTextTokens(String(candidate.text || '')) + 2
  if (type === 'file') return 768
  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    return estimateAgentTextTokens(safeJSONStringify({
      type,
      toolName: candidate.toolName,
      input: candidate.input,
      output: candidate.output,
      errorText: candidate.errorText,
    })) + 16
  }
  return estimateAgentTextTokens(safeJSONStringify(candidate)) + 4
}

export function estimateAgentMessagesTokens(messages: readonly TokenEstimableMessage[]): number {
  return messages.reduce((total, message) => (
    total + 8 + (message.parts || []).reduce<number>(
      (partTotal, part) => partTotal + estimateAgentPartTokens(part),
      0,
    )
  ), 0)
}

function clipContextText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const notice = '\n…[较早内容已裁剪]…\n'
  const available = Math.max(80, maxChars - notice.length)
  const head = Math.ceil(available * 0.62)
  const tail = Math.max(0, available - head)
  return `${value.slice(0, head)}${notice}${tail > 0 ? value.slice(-tail) : ''}`
}

function clipContextValue(value: unknown, maxChars: number): unknown {
  const serialized = safeJSONStringify(value)
  if (serialized.length <= maxChars) return value
  return {
    compacted: true,
    note: '旧工具结果已按上下文预算裁剪；关键结论会保留在会话摘要中。',
    preview: clipContextText(serialized, maxChars),
  }
}

/**
 * 估算下一次模型请求实际会保留的会话消息，而不是渲染器中完整的展示数据。
 * 推理密文、进度事件和来源卡片不会发回模型；工具参数与结果按运行时相同的
 * 普通压缩尺度计量，避免把仅供 UI 展示的数据误算为上下文占用。
 */
export function estimateAgentContextMessagesTokens(messages: readonly TokenEstimableMessage[]): number {
  const recentBoundary = Math.max(0, messages.length - 8)
  return messages.reduce((total, message, messageIndex) => {
    const old = messageIndex < recentBoundary
    const partsTotal = (message.parts || []).reduce<number>((partTotal, part) => {
      const candidate = (part && typeof part === 'object' ? part : {}) as TokenEstimablePart
      const type = String(candidate.type || '')
      if (
        type === 'reasoning'
        || type === 'reasoning-file'
        || type === 'step-start'
        || type.startsWith('data-')
        || type.startsWith('source-')
      ) return partTotal

      if (type.startsWith('tool-') || type === 'dynamic-tool') {
        const normalized = { ...candidate }
        const toolName = String(candidate.toolName || (type.startsWith('tool-') ? type.slice(5) : ''))
        if ('input' in normalized) normalized.input = clipContextValue(normalized.input, 4_000)
        if (normalized.state === 'output-available' && 'output' in normalized) {
          normalized.output = clipContextValue(
            compactAgentToolOutputForRetention(toolName, normalized.output),
            old ? 2_400 : 12_000,
          )
        }
        if (normalized.state === 'output-error' && typeof normalized.errorText === 'string') {
          normalized.errorText = clipContextText(normalized.errorText, 1_200)
        }
        return partTotal + estimateAgentPartTokens(normalized)
      }

      return partTotal + estimateAgentPartTokens(part)
    }, 0)
    return total + (partsTotal > 0 ? 8 + partsTotal : 0)
  }, 0)
}

export function estimateAgentUnknownTokens(value: unknown): number {
  return estimateAgentTextTokens(typeof value === 'string' ? value : safeJSONStringify(value))
}
