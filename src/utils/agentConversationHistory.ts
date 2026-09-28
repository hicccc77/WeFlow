type AgentHistoryPart = Record<string, unknown>
type AgentHistoryMessage = Record<string, unknown> & {
  id?: unknown
  role?: unknown
  parts?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function partType(value: unknown): string {
  return String(record(value)?.type || '')
}

/**
 * Build safe cross-turn model history from UI messages.
 *
 * A UI assistant message contains the complete execution trace for display: reasoning, step
 * boundaries, tool calls/results and provider item IDs. Replaying that trace in a later Responses
 * request is both unnecessary and incompatible with lazy tool registration. The next turn only
 * needs the delivered assistant answer; local evidence remains available through Agent tools.
 */
export function agentConversationHistoryForModel(messages: unknown): AgentHistoryMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.flatMap((message): AgentHistoryMessage[] => {
    const source = record(message) as AgentHistoryMessage | null
    if (!source || !Array.isArray(source.parts)) return []
    if (source.role !== 'assistant') return [source]

    const parts = source.parts
    let finalBoundary = -1
    for (let index = 0; index < parts.length; index += 1) {
      const type = partType(parts[index])
      if (type.startsWith('tool-') || type === 'dynamic-tool') finalBoundary = index
    }
    if (finalBoundary < 0) {
      for (let index = 0; index < parts.length; index += 1) {
        if (partType(parts[index]) === 'step-start') finalBoundary = index
      }
    }

    let answerParts = parts.slice(finalBoundary + 1).flatMap((part): AgentHistoryPart[] => {
      const value = record(part)
      if (!value || value.type !== 'text' || typeof value.text !== 'string' || !value.text.trim()) return []
      // Strip provider item IDs/metadata so a later Responses request serializes ordinary text
      // instead of references to items owned by a previous provider response.
      return [{ type: 'text', text: value.text }]
    })
    if (answerParts.length === 0) {
      const fallback = [...parts].reverse().find((part) => {
        const value = record(part)
        return value?.type === 'text' && typeof value.text === 'string' && value.text.trim()
      })
      const value = record(fallback)
      if (value && typeof value.text === 'string') answerParts = [{ type: 'text', text: value.text }]
    }

    const compactionParts = parts.filter((part) => partType(part) === 'data-compaction')
    const retainedParts = [...answerParts, ...compactionParts]
    if (retainedParts.length === 0) return []
    return [{
      id: source.id,
      role: 'assistant',
      parts: retainedParts,
    }]
  })
}
