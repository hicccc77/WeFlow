let agentPagePromise: ReturnType<typeof importAgentPage> | null = null

function importAgentPage() {
  return import('./AgentPage')
}

export function loadAgentPage() {
  agentPagePromise ??= importAgentPage()
  return agentPagePromise
}
