export type AgentRuntimeMemoryEntry = {
  title: string
  detail: string
}

function clean(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit)
}

export function mergeAgentRuntimeMemoryEntries(
  existing: AgentRuntimeMemoryEntry[],
  incoming: AgentRuntimeMemoryEntry[],
  limit = 12,
): AgentRuntimeMemoryEntry[] {
  const byTitle = new Map<string, AgentRuntimeMemoryEntry>()
  for (const candidate of [...existing, ...incoming]) {
    const title = clean(candidate?.title, 80)
    const detail = clean(candidate?.detail, 4_000)
    if (!title || !detail) continue
    byTitle.set(title.toLocaleLowerCase(), { title, detail })
  }
  return Array.from(byTitle.values()).slice(-Math.max(1, Math.min(12, Math.floor(limit || 12))))
}

export function agentRuntimeMemoryGuidance(entries: AgentRuntimeMemoryEntry[]): string {
  const normalized = mergeAgentRuntimeMemoryEntries([], entries)
  if (normalized.length === 0) return ''
  return [
    '以下是你已经主动按标题读取、并判断可能与本轮相关的个人记忆详情。',
    '先区分其中的内容性质：回答方式、沟通边界、格式和工作方法属于个性化行为规则；它们与当前请求的触发条件相符时必须实际执行，不能只提到读过、随后仍按默认习惯回答。若当前用户消息明确改变了要求，以当前消息为准。',
    '人物、事件、时间、数量和当前状态仍然只是检索线索，不能因出现在记忆里就当成事实。行为规则的执行若依赖这些事实，应继续读取必要的一手材料，然后按该规则完成回答，而不是用泛化追问代替。',
    `已读取记忆：${JSON.stringify(normalized)}`,
  ].join('\n')
}
