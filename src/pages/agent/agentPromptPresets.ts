/** Agent 思考强度选项；问题和调查路径由模型与用户当前对话决定。 */
import type { AgentReasoningEffort } from '@/features/aiagent/transport/ipcChatTransport'

export const REASONING_EFFORT_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'none', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '极高' },
]

export function reasoningEffortLabel(value: AgentReasoningEffort, compact = false): string {
  const label = REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label ?? '高'
  return compact ? label.replace(/^思考：/, '') : label
}

