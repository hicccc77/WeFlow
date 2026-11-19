type AgentPageModule = typeof import('./AgentPage')

let agentPagePromise: Promise<AgentPageModule> | null = null

function importAgentPage() {
  return import('./AgentPage')
}

/**
 * 预加载 AI Agent 页面。
 *
 * 导入失败时必须丢弃已缓存的 Promise：否则一次失败会被永久记住，
 * 之后每次进入 AI Agent 都会立刻拿到同一个 rejected promise。
 */
export function loadAgentPage() {
  if (!agentPagePromise) {
    agentPagePromise = importAgentPage().catch((error) => {
      agentPagePromise = null
      throw error
    })
  }
  return agentPagePromise
}
