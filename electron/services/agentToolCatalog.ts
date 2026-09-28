export type AgentToolSource = 'auto' | 'chat' | 'moments' | 'web'

export function initialAgentToolNames(
  source: AgentToolSource,
  searchToolName?: string | null,
): Set<string> {
  const names = new Set<string>()
  names.add('read_memory')
  const normalizedSearchToolName = String(searchToolName || '').trim()
  if (normalizedSearchToolName && (source === 'auto' || source === 'web')) {
    names.add(normalizedSearchToolName)
  }
  return names
}

export function resolveAgentToolRequest(
  enabledToolNames: Iterable<string>,
  requestedToolNames: Iterable<string>,
  availableToolNames: Iterable<string>,
): {
  enabledTools: string[]
  newlyEnabled: string[]
  rejectedTools: string[]
} {
  const available = new Set(Array.from(availableToolNames, (name) => String(name || '').trim()).filter(Boolean))
  const enabled = new Set(Array.from(enabledToolNames, (name) => String(name || '').trim()).filter((name) => available.has(name)))
  const newlyEnabled = new Set<string>()
  const rejected = new Set<string>()
  const requested = Array.from(requestedToolNames, (name) => String(name || '').trim()).filter(Boolean)
  for (const name of requested) {
    if (!name || name === 'request_tools' || !available.has(name)) {
      if (name) rejected.add(name)
      continue
    }
    if (!enabled.has(name)) newlyEnabled.add(name)
    enabled.add(name)
  }
  return {
    enabledTools: Array.from(enabled).sort(),
    newlyEnabled: Array.from(newlyEnabled).sort(),
    rejectedTools: Array.from(rejected).sort(),
  }
}
