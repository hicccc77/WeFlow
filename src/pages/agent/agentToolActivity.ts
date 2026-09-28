export type AgentToolActivityKind =
  | 'capability'
  | 'conversation'
  | 'reading'
  | 'context'
  | 'search'
  | 'analysis'
  | 'planning'
  | 'voice'
  | 'media'
  | 'moments'
  | 'memory'
  | 'web'
  | 'delegate'
  | 'command'
  | 'file'
  | 'desktop'
  | 'action'
  | 'other'

export type AgentToolActivityCall = {
  toolName: string
  input?: unknown
  status: AgentToolActivityStatus
}

export type AgentToolActivityStatus = 'active' | 'complete' | 'pending'

type ActivityCopy = {
  active: string
  complete: string
  kind: AgentToolActivityKind
}

const TOOL_ACTIVITY_KINDS: Record<string, AgentToolActivityKind> = {
  request_tools: 'capability',
  list_conversation_manifest: 'conversation',
  list_sessions: 'conversation',
  read_raw_messages: 'reading',
  read_raw_message_ranges: 'reading',
  read_raw_timeline: 'reading',
  read_raw_timeline_sample: 'reading',
  read_raw_timeline_samples: 'reading',
  read_messages_by_time: 'reading',
  read_recent_messages: 'reading',
  read_recent_activity: 'reading',
  read_message_thread: 'context',
  read_event_contexts: 'context',
  inspect_message_context: 'context',
  search_raw_messages: 'search',
  locate_conversations_by_message_text: 'search',
  search_and_read_raw_messages: 'search',
  search_messages: 'search',
  analyze_interaction_patterns: 'analysis',
  compare_interaction_periods: 'analysis',
  relationship_overview: 'analysis',
  inspect_relationship_timeline: 'analysis',
  inspect_relationship_events: 'analysis',
  total_message_ranking: 'analysis',
  select_evidence_focus: 'analysis',
  select_event_units: 'analysis',
  screen_event_shard: 'analysis',
  review_evidence: 'analysis',
  set_investigation_plan: 'planning',
  update_investigation_plan: 'planning',
  update_research_notebook: 'planning',
  plan_evidence: 'planning',
  transcribe_voice_messages: 'voice',
  review_focused_voice: 'voice',
  review_focused_images: 'media',
  review_focused_media: 'media',
  inspect_media_image: 'media',
  present_media_image: 'media',
  search_moments: 'moments',
  read_memory: 'memory',
  recall: 'memory',
  list_memories: 'memory',
  remember: 'memory',
  forget: 'memory',
  audit_memories: 'memory',
  apply_memory_fix: 'memory',
  auto_memory: 'memory',
  web_search: 'web',
  google_search: 'web',
  delegate_analysis: 'delegate',
  run_command: 'command',
  file_change: 'file',
  desktop_screenshot: 'desktop',
  desktop_ocr: 'desktop',
  rollback_operation: 'action',
  persona_control: 'action',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function cleanText(value: unknown, maxLength = 80): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : ''
}

function quotedSession(input: unknown, sessionNameOf?: (sessionId: string) => string): string {
  const record = asRecord(input)
  const sessionId = cleanText(record?.sessionId, 512)
  if (!sessionId) return ''
  const displayName = cleanText(sessionNameOf?.(sessionId), 80)
  if (!displayName || displayName === sessionId) return ''
  return `“${displayName}”`
}

function requestCount(input: unknown, key: string): number {
  const value = asRecord(input)?.[key]
  return Array.isArray(value) ? value.length : 0
}

function copy(kind: AgentToolActivityKind, verb: string, object: string): ActivityCopy {
  const spacer = /^\d/.test(object) ? ' ' : ''
  return {
    active: `${verb}${spacer}${object}`,
    complete: `${verb}了${spacer}${object}`,
    kind,
  }
}

export function agentToolActivityKind(toolName: string): AgentToolActivityKind {
  const direct = TOOL_ACTIVITY_KINDS[toolName]
  if (direct) return direct
  if (/search|locate|find/i.test(toolName)) return 'search'
  if (/read|list|inspect/i.test(toolName)) return 'reading'
  if (/analy|compare|review|rank/i.test(toolName)) return 'analysis'
  if (/image|media|photo/i.test(toolName)) return 'media'
  if (/voice|audio|transcrib/i.test(toolName)) return 'voice'
  if (/memory|remember|recall/i.test(toolName)) return 'memory'
  if (/command|shell|terminal/i.test(toolName)) return 'command'
  if (/file|edit|write/i.test(toolName)) return 'file'
  return 'other'
}

function activityCopy(call: AgentToolActivityCall, sessionNameOf?: (sessionId: string) => string): ActivityCopy {
  const { toolName, input } = call
  const kind = agentToolActivityKind(toolName)
  const session = quotedSession(input, sessionNameOf)
  switch (toolName) {
    case 'request_tools': return copy(kind, '加载', '工具能力')
    case 'list_conversation_manifest':
    case 'list_sessions': return copy(kind, '读取', '会话目录')
    case 'read_raw_timeline_samples': {
      const count = requestCount(input, 'requests')
      return copy(kind, '查阅', count > 0 ? `${count} 个会话的聊天原文` : '多个会话的聊天原文')
    }
    case 'read_raw_message_ranges': {
      const count = requestCount(input, 'requests')
      return copy(kind, '查阅', count > 0 ? `${count} 段聊天原文` : '多段聊天原文')
    }
    case 'read_raw_timeline':
    case 'read_raw_timeline_sample':
    case 'read_raw_messages':
    case 'read_messages_by_time':
    case 'read_recent_messages': return copy(kind, '查阅', session ? `${session}的聊天原文` : '聊天原文')
    case 'read_recent_activity': return copy(kind, '查阅', '近期互动')
    case 'read_message_thread':
    case 'read_event_contexts':
    case 'inspect_message_context': return copy(kind, '补充', '消息上下文')
    case 'locate_conversations_by_message_text': return copy(kind, '定位', '相关会话')
    case 'search_and_read_raw_messages': return copy(kind, '搜索并查阅', '聊天原文')
    case 'search_raw_messages':
    case 'search_messages': return copy(kind, '搜索', '聊天记录')
    case 'analyze_interaction_patterns': return copy(kind, '分析', session ? `${session}的互动模式` : '互动模式')
    case 'compare_interaction_periods': return copy(kind, '比较', '互动阶段')
    case 'relationship_overview': return copy(kind, '分析', '关系概览')
    case 'inspect_relationship_timeline': return copy(kind, '核对', '关系时间线')
    case 'inspect_relationship_events': return copy(kind, '整理', '关系事件')
    case 'total_message_ranking': return copy(kind, '统计', '会话消息量')
    case 'select_evidence_focus':
    case 'select_event_units':
    case 'screen_event_shard':
    case 'review_evidence': return copy(kind, '分析', '关键证据')
    case 'set_investigation_plan':
    case 'update_investigation_plan':
    case 'plan_evidence': return copy(kind, '规划', '调查步骤')
    case 'update_research_notebook': return copy(kind, '整理', '研究笔记')
    case 'transcribe_voice_messages': {
      const count = requestCount(input, 'voiceRefs')
      return copy(kind, '转写', count > 0 ? `${count} 条语音` : '语音')
    }
    case 'review_focused_media': {
      const count = requestCount(input, 'decisions')
      const inputRecord = asRecord(input)
      const decisions = Array.isArray(inputRecord?.decisions) ? inputRecord.decisions : []
      const voices = decisions.filter((item) => cleanText(asRecord(item)?.mediaRef).startsWith('voice_')).length
      const images = decisions.filter((item) => cleanText(asRecord(item)?.mediaRef).startsWith('image_')).length
      const target = voices > 0 && images === 0
        ? `${voices} 条语音`
        : images > 0 && voices === 0
          ? `${images} 张图片`
          : count > 0 ? `${count} 项语音和图片` : '语音和图片'
      return copy(kind, '检查', target)
    }
    case 'review_focused_voice': {
      const count = requestCount(input, 'selections') || requestCount(input, 'decisions')
      return copy(kind, '转写', count > 0 ? `${count} 条语音` : '语音')
    }
    case 'review_focused_images': {
      const count = requestCount(input, 'selections') || requestCount(input, 'decisions')
      return copy(kind, '查看', count > 0 ? `${count} 张图片` : '图片')
    }
    case 'inspect_media_image': return copy(kind, '查看', '图片内容')
    case 'present_media_image': return copy(kind, '展示', '图片')
    case 'search_moments': return copy(kind, '查阅', '朋友圈')
    case 'read_memory':
    case 'recall':
    case 'list_memories': return copy(kind, '读取', '相关记忆')
    case 'remember':
    case 'forget': {
      const count = requestCount(input, 'items')
      return copy(kind, '更新', count > 0 ? `${count} 项记忆` : '记忆')
    }
    case 'audit_memories':
    case 'apply_memory_fix':
    case 'auto_memory': return copy(kind, '更新', '记忆')
    case 'web_search':
    case 'google_search': return copy(kind, '搜索', '网页')
    case 'delegate_analysis': return copy(kind, '委托', '子助手分析')
    case 'run_command': return copy(kind, '运行', '命令')
    case 'file_change': return copy(kind, '修改', '文件')
    case 'desktop_screenshot':
    case 'desktop_ocr': return copy(kind, '查看', '桌面')
    case 'rollback_operation': return copy(kind, '回滚', '操作')
    case 'persona_control': return copy(kind, '调整', '数字分身')
    default: return copy(kind, '调用', '工具')
  }
}

function joinActivities(items: string[]): string {
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]}并${items[1]}`
  return `${items.slice(0, -1).join('、')}并${items[items.length - 1]}`
}

export function summarizeAgentToolActivities(
  calls: AgentToolActivityCall[],
  sessionNameOf?: (sessionId: string) => string,
): string {
  const phrases = Array.from(new Set(calls.map((call) => {
    const activity = activityCopy(call, sessionNameOf)
    if (call.status === 'active') return `正在${activity.active}`
    if (call.status === 'pending') return `尚未${activity.active}`
    return activity.complete
  })))
  const visible = phrases.length > 3
    ? [...phrases.slice(0, 2), `另有 ${phrases.length - 2} 类工具活动`]
    : phrases
  const summary = joinActivities(visible)
  return summary || '调用工具'
}
