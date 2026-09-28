export type AgentToolOutcome = 'pending' | 'success' | 'error' | 'denied'

export type AgentToolPresentation = {
  label: string
  resultLabel: string
}

/**
 * 所有内置 Agent 工具面向用户的展示契约。
 *
 * 在这里保留历史别名，使持久化会话仍然可读。冒烟测试会把 Electron 实时工具目录
 * 与此记录比较，因此新增或重命名的工具不会静默回退成“调用扩展工具”。
 */
export const AGENT_TOOL_PRESENTATIONS: Record<string, AgentToolPresentation> = {
  request_tools: { label: '加载工具能力', resultLabel: '能力' },
  list_conversation_manifest: { label: '查看会话概览', resultLabel: '会话' },
  read_raw_messages: { label: '连续阅读聊天原文', resultLabel: '原文' },
  read_raw_message_ranges: { label: '并行阅读多段原文', resultLabel: '区间' },
  read_raw_timeline: { label: '跨期阅读聊天原文', resultLabel: '原文' },
  read_raw_timeline_sample: { label: '跨期抽样阅读原文', resultLabel: '采样' },
  read_raw_timeline_samples: { label: '并行跨期阅读原文', resultLabel: '会话' },
  search_raw_messages: { label: '搜索消息正文', resultLabel: '正文命中' },
  locate_conversations_by_message_text: { label: '定位会话线索', resultLabel: '会话' },
  read_message_thread: { label: '补充消息上下文', resultLabel: '上下文' },
  read_event_contexts: { label: '并行补充事件上下文', resultLabel: '上下文' },
  search_and_read_raw_messages: { label: '搜索并阅读上下文', resultLabel: '检索' },
  analyze_interaction_patterns: { label: '分析互动模式', resultLabel: '分析' },
  compare_interaction_periods: { label: '比较互动阶段', resultLabel: '比较' },
  set_investigation_plan: { label: '制定调查计划', resultLabel: '计划' },
  update_investigation_plan: { label: '更新调查进度', resultLabel: '计划' },
  update_research_notebook: { label: '更新研究笔记', resultLabel: '笔记' },
  transcribe_voice_messages: { label: '按需转写语音', resultLabel: '转写' },
  review_focused_voice: { label: '转写语音', resultLabel: '结果' },
  review_focused_images: { label: '查看图片', resultLabel: '结果' },
  // 仅用于已保存会话；新任务已拆成上面的两个独立工具。
  review_focused_media: { label: '检查语音和图片', resultLabel: '结果' },
  inspect_media_image: { label: '查看图片', resultLabel: '图片' },
  present_media_image: { label: '展示图片', resultLabel: '图片' },
  search_moments: { label: '搜索朋友圈', resultLabel: '动态' },
  read_memory: { label: '读取相关记忆', resultLabel: '记忆' },
  recall: { label: '查找记忆', resultLabel: '记忆' },
  remember: { label: '保存记忆', resultLabel: '记忆' },
  forget: { label: '删除记忆', resultLabel: '记忆' },
  web_search: { label: '联网搜索', resultLabel: '网页' },
  google_search: { label: '联网搜索', resultLabel: '网页' },
  rollback_operation: { label: '回滚操作', resultLabel: '回滚' },
  desktop_screenshot: { label: '桌面截图', resultLabel: '截图' },
  desktop_ocr: { label: '桌面 OCR', resultLabel: '文字' },
  audit_memories: { label: '记忆体检', resultLabel: '检查' },
  apply_memory_fix: { label: '修复记忆', resultLabel: '修复' },
  persona_control: { label: '数字分身', resultLabel: '分身' },
  auto_memory: { label: '自动记忆', resultLabel: '记忆' },
  delegate_analysis: { label: '委托子助手', resultLabel: '任务' },
  run_command: { label: '运行命令', resultLabel: '命令' },
  file_change: { label: '文件变更', resultLabel: '文件' },
  // 继续映射历史 Agent 工具，避免采用模型主导的工具架构后，已保存会话失去原有含义。
  list_sessions: { label: '查看会话', resultLabel: '会话' },
  list_memories: { label: '查看记忆', resultLabel: '记忆' },
  relationship_overview: { label: '整理关系概览', resultLabel: '关系' },
  inspect_relationship_timeline: { label: '检查关系时间线', resultLabel: '时间线' },
  inspect_relationship_events: { label: '整理关系事件', resultLabel: '事件' },
  inspect_message_context: { label: '补充消息上下文', resultLabel: '上下文' },
  read_messages_by_time: { label: '按时间读取聊天', resultLabel: '原文' },
  read_recent_messages: { label: '读取最近聊天', resultLabel: '原文' },
  read_recent_activity: { label: '查看近期互动', resultLabel: '互动' },
  search_messages: { label: '搜索聊天记录', resultLabel: '命中' },
  total_message_ranking: { label: '统计总消息量排行', resultLabel: '排行' },
  plan_evidence: { label: '规划证据', resultLabel: '计划' },
  select_evidence_focus: { label: '选择证据焦点', resultLabel: '证据' },
  select_event_units: { label: '选择事件单元', resultLabel: '事件' },
  screen_event_shard: { label: '筛选事件分片', resultLabel: '事件' },
  review_evidence: { label: '复核证据', resultLabel: '复核' },
}

export const AGENT_TOOL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_TOOL_PRESENTATIONS).map(([name, presentation]) => [name, presentation.label]),
)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value)
  if (direct) return direct
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return null
  try {
    return asRecord(JSON.parse(normalized))
  } catch {
    return null
  }
}

function text(value: unknown, maxLength = 160): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : ''
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value)
  return number == null ? null : Math.max(0, Math.round(number))
}

function collectionLength(record: Record<string, unknown>, key: string): number | null {
  return Array.isArray(record[key]) ? record[key].length : null
}

function batchReadActivitySuffix(record: Record<string, unknown>, unit: string): string {
  const completed = nonNegativeInteger(record.completedCount)
  const failed = nonNegativeInteger(record.failedCount)
  const reused = nonNegativeInteger(record.skippedDuplicateCount)
  const parts = [
    completed != null && completed > 0 ? `新读取 ${completed} 个${unit}` : '',
    reused != null && reused > 0 ? `复用 ${reused} 个${unit}` : '',
    failed != null && failed > 0 ? `失败 ${failed} 个${unit}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? `（${parts.join('，')}）` : ''
}

function isNoNewRawRead(record: Record<string, unknown>): boolean {
  return record.noNewRangeRead === true
    || record.noNewSourceRead === true
    || record.status === 'already_returned'
}

function reusedBatchCount(record: Record<string, unknown>, fallback = 0): number {
  return nonNegativeInteger(record.skippedDuplicateCount)
    ?? nonNegativeInteger(record.requestedCount)
    ?? fallback
}

function outputConversation(record: Record<string, unknown>): string {
  return text(record.conversation || record.displayName, 80)
}

function rangeText(record: Record<string, unknown>): string {
  const range = asRecord(record.range)
  if (!range) return ''
  const startAt = text(range.startAt, 32)
  const endAt = text(range.endAt, 32)
  return startAt && endAt ? `（${startAt} 至 ${endAt}）` : ''
}

export function formatAgentToolName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return '调用外部工具'
  return AGENT_TOOL_PRESENTATIONS[toolName]?.label || '调用扩展工具'
}

export function agentToolResultLabel(toolName: string, outcome: AgentToolOutcome): string {
  if (outcome === 'error') return '错误'
  if (outcome === 'denied' || outcome === 'pending') return '状态'
  return AGENT_TOOL_PRESENTATIONS[toolName]?.resultLabel || '结果'
}

/** 从工具输出中收集稳定的“会话 ID → 显示名称”映射。 */
export function collectToolSessionDisplayNames(...values: unknown[]): Map<string, string> {
  const names = new Map<string, string>()
  const visited = new WeakSet<object>()
  let inspected = 0

  const visit = (value: unknown, depth: number) => {
    if (typeof value === 'string') {
      const parsed = parseRecord(value)
      if (parsed) visit(parsed, depth + 1)
      return
    }
    if (depth > 8 || inspected >= 20_000 || !value || typeof value !== 'object') return
    if (visited.has(value as object)) return
    visited.add(value as object)
    inspected += 1
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }

    const record = value as Record<string, unknown>
    const sessionId = text(record.sessionId || record.username || record.primarySessionId, 512)
    const displayName = text(record.conversation || record.displayName || record.sessionName || record.primaryDisplayName, 100)
    if (sessionId && displayName && displayName !== sessionId) names.set(sessionId, displayName)

    // 内置工具结果只使用这些容器。限制遍历范围可以避免扫描消息正文和任意供应商载荷。
    for (const key of ['input', 'output', 'data', 'result', 'target', 'requests', 'sessions', 'pages', 'contexts', 'conversations', 'results', 'records']) {
      visit(record[key], depth + 1)
    }
  }

  for (const value of values) visit(value, 0)
  return names
}

/** 在当前或持久化工具部分中查找技术性的会话 ID。 */
export function collectToolSessionIds(...values: unknown[]): Set<string> {
  const ids = new Set<string>()
  const visited = new WeakSet<object>()
  let inspected = 0

  const visit = (value: unknown, depth: number) => {
    if (typeof value === 'string') {
      const parsed = parseRecord(value)
      if (parsed) visit(parsed, depth + 1)
      return
    }
    if (depth > 8 || inspected >= 20_000 || !value || typeof value !== 'object') return
    if (visited.has(value as object)) return
    visited.add(value as object)
    inspected += 1
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    for (const candidate of [record.sessionId, record.username, record.primarySessionId]) {
      const sessionId = text(candidate, 512)
      if (/^(?:accountId_|gh_|\d+@chatroom\b)/i.test(sessionId)) ids.add(sessionId)
    }
    if (Array.isArray(record.alternativeSessionIds)) {
      for (const candidate of record.alternativeSessionIds) {
        const sessionId = text(candidate, 512)
        if (/^(?:accountId_|gh_|\d+@chatroom\b)/i.test(sessionId)) ids.add(sessionId)
      }
    }
    for (const key of ['input', 'output', 'data', 'result', 'target', 'requests', 'sessions', 'pages', 'contexts', 'conversations', 'results', 'records']) {
      visit(record[key], depth + 1)
    }
  }

  for (const value of values) visit(value, 0)
  return ids
}

/** 工具专用的结果摘要；计数保持其真实语义。 */
export function agentToolResultSummary(
  toolName: string,
  output: unknown,
  outcome: AgentToolOutcome,
  progress: { callState?: string; status?: 'complete' | 'active' | 'pending' } = {},
): string {
  if (outcome === 'error') return '调用失败，错误信息已显示在执行步骤中'
  if (outcome === 'denied') return '本次调用未执行'
  if (output == null) {
    if (outcome !== 'pending') return '本次调用已完成，但没有可展示的结果'
    if (progress.callState === 'approval-requested') return '等待你的确认'
    if (progress.callState === 'approval-responded') return '已确认，等待执行'
    if (progress.callState === 'input-streaming') {
      return progress.status === 'active' ? '正在准备调用内容' : '调用内容尚未准备完成'
    }
    return progress.status === 'active' ? '正在处理' : '本次调用尚未完成'
  }
  const value = parseRecord(output)
  if (!value) return '调用已完成，结果已用于当前回答'
  const structuredMemoryMutation = (toolName === 'remember' || toolName === 'forget') && Array.isArray(value.results)
  if ((value.success === false || value.error) && !structuredMemoryMutation) {
    const detail = text(value.error, 120)
    return detail ? `未取得数据：${detail}` : '调用未完成，未取得可用数据'
  }
  if (value.reused === true) return '已复用本轮先前取得的工具结果'

  const sessionId = text(value.sessionId).toLocaleLowerCase()
  if (['global', 'all', 'local-chat'].includes(sessionId)) {
    return '未取得数据：调用时没有指定有效的会话'
  }

  switch (toolName) {
    case 'request_tools': {
      const enabled = collectionLength(value, 'enabledTools') ?? 0
      const added = collectionLength(value, 'newlyEnabled') ?? 0
      return `可用工具 ${enabled} 个，本次新加载 ${added} 个`
    }
    case 'list_conversation_manifest': {
      const count = collectionLength(value, 'sessions') ?? nonNegativeInteger(value.count) ?? 0
      return `返回 ${count} 个会话及其确定性统计`
    }
    case 'read_raw_timeline':
    case 'read_raw_timeline_sample': {
      const pages = nonNegativeInteger(value.returnedPageCount)
        ?? nonNegativeInteger(value.completedCount)
        ?? collectionLength(value, 'pages')
        ?? 0
      const conversation = outputConversation(value)
      if (isNoNewRawRead(value)) {
        return conversation
          ? `“${conversation}”的跨期原文已在本轮读取，本次没有新增页面`
          : '相同跨期原文已在本轮读取，本次没有新增页面'
      }
      const prefix = conversation ? `读取“${conversation}”` : '完成跨期阅读'
      const failed = nonNegativeInteger(value.failedCount)
      const reused = nonNegativeInteger(value.skippedDuplicateCount) ?? 0
      return `${prefix}的 ${pages} 个连续原文页${reused > 0 ? `（复用 ${reused} 个已读窗口）` : ''}${failed != null && failed > 0 ? `（${failed} 个窗口未返回）` : ''}`
    }
    case 'read_raw_timeline_samples': {
      const requested = nonNegativeInteger(value.requestedCount)
        ?? collectionLength(value, 'conversations')
        ?? 0
      const pages = nonNegativeInteger(value.returnedPageCount)
        ?? collectionLength(value, 'pages')
        ?? 0
      if (isNoNewRawRead(value)) {
        const reused = reusedBatchCount(value, requested)
        return reused > 0
          ? `已复用 ${reused} 个会话的跨期阅读结果，本次没有新增页面`
          : '这些会话的跨期原文已在本轮读取，本次没有新增页面'
      }
      return `读取 ${requested} 个会话，返回 ${pages} 个连续原文页${batchReadActivitySuffix(value, '会话')}`
    }
    case 'read_raw_message_ranges': {
      const requested = nonNegativeInteger(value.count)
        ?? nonNegativeInteger(value.requestedCount)
        ?? nonNegativeInteger(value.completedCount)
        ?? 0
      const pages = nonNegativeInteger(value.returnedPageCount) ?? collectionLength(value, 'pages') ?? 0
      if (isNoNewRawRead(value)) {
        const reused = reusedBatchCount(value, requested)
        return reused > 0
          ? `已复用 ${reused} 个原文区间，本次没有新增页面`
          : '这些原文区间已在本轮读取，本次没有新增页面'
      }
      return `读取 ${requested} 个原文区间，返回 ${pages} 个原文页${batchReadActivitySuffix(value, '区间')}`
    }
    case 'read_event_contexts': {
      const requested = nonNegativeInteger(value.requestedCount) ?? collectionLength(value, 'contexts') ?? 0
      const contexts = collectionLength(value, 'contexts') ?? 0
      if (isNoNewRawRead(value)) {
        const reused = reusedBatchCount(value, contexts || requested)
        return reused > 0
          ? `已复用 ${reused} 个事件上下文，本次没有新增原文`
          : '这些事件上下文已在本轮读取，本次没有新增原文'
      }
      return `补充 ${requested} 个事件，返回 ${contexts} 个连续上下文${batchReadActivitySuffix(value, '事件')}`
    }
    case 'read_raw_messages':
    case 'read_message_thread': {
      const count = nonNegativeInteger(value.messageCount)
      if (count != null) {
        const coverage = value.coverageStatus === 'complete'
          ? '，该范围已读完'
          : value.hasMore === true ? '，仍可继续追读' : ''
        return `连续读取 ${count} 条原文${rangeText(value)}${coverage}`
      }
      break
    }
    case 'inspect_message_context': {
      const count = collectionLength(value, 'messages') ?? nonNegativeInteger(value.count) ?? 0
      return `补充目标消息前后 ${count} 条上下文`
    }
    case 'inspect_relationship_events': {
      const count = nonNegativeInteger(value.evidenceCount) ?? collectionLength(value, 'events') ?? 0
      return `整理 ${count} 条关系事件证据`
    }
    case 'inspect_relationship_timeline': {
      const evidence = nonNegativeInteger(value.evidenceCount) ?? collectionLength(value, 'evidence')
      if (evidence != null) return `核对关系时间线，保留 ${evidence} 条证据`
      break
    }
    case 'analyze_interaction_patterns': {
      const total = nonNegativeInteger(value.totalMessages)
      const activeDays = nonNegativeInteger(value.activeDays)
      if (total != null) return `核对 ${total} 条消息的互动模式${activeDays != null ? `，覆盖 ${activeDays} 个活跃日` : ''}`
      break
    }
    case 'read_messages_by_time':
    case 'read_recent_messages': {
      const count = collectionLength(value, 'messages') ?? nonNegativeInteger(value.count) ?? 0
      return `读取 ${count} 条聊天原文`
    }
    case 'read_recent_activity': {
      const messages = nonNegativeInteger(value.messageCount) ?? 0
      const evidence = nonNegativeInteger(value.evidenceCount) ?? collectionLength(value, 'evidence') ?? 0
      return `检查 ${messages} 条近期消息，保留 ${evidence} 条证据`
    }
    case 'plan_evidence': {
      const claims = collectionLength(value, 'claims') ?? 0
      const actions = collectionLength(value, 'actions') ?? 0
      return `已规划 ${claims} 项待核主张和 ${actions} 项取证动作`
    }
    case 'review_evidence': {
      const supported = collectionLength(value, 'supportedClaims') ?? 0
      const gaps = collectionLength(value, 'materialGaps') ?? collectionLength(value, 'unresolvedGaps') ?? 0
      return `已复核证据，支持 ${supported} 项主张，仍有 ${gaps} 项缺口`
    }
    case 'screen_event_shard': {
      const inspected = nonNegativeInteger(value.inspectedEventCount) ?? 0
      const selected = collectionLength(value, 'selectedEventIds') ?? 0
      return `筛选 ${inspected} 个事件，保留 ${selected} 个候选`
    }
    case 'select_event_units': {
      const selected = collectionLength(value, 'selectedUnitIds') ?? 0
      const direct = collectionLength(value, 'directEvidenceUnitIds') ?? 0
      return `选择 ${selected} 个事件单元，其中 ${direct} 个包含直接证据`
    }
    case 'select_evidence_focus': {
      const events = collectionLength(value, 'decisiveEventIds') ?? 0
      const alternatives = collectionLength(value, 'alternativeSessionIds') ?? 0
      return `选择 ${events} 个关键事件，并保留 ${alternatives} 个对照会话`
    }
    case 'total_message_ranking': {
      const rankings = collectionLength(value, 'rankings') ?? nonNegativeInteger(value.count) ?? 0
      return `生成 ${rankings} 个会话的总消息量排行`
    }
    case 'search_raw_messages': {
      const matches = collectionLength(value, 'matches')
        ?? collectionLength(value, 'hits')
        ?? nonNegativeInteger(value.matchCount)
        ?? 0
      return matches === 0
        ? '消息正文逐字命中 0 条'
        : `消息正文逐字命中 ${matches} 条`
    }
    case 'locate_conversations_by_message_text': {
      const conversations = collectionLength(value, 'conversations') ?? 0
      const matches = nonNegativeInteger(value.matchCount) ?? nonNegativeInteger(value.totalMatchedMessages)
      return `定位 ${conversations} 个会话${matches != null ? `，共 ${matches} 条命中` : ''}`
    }
    case 'search_and_read_raw_messages': {
      const queries = collectionLength(value, 'queries') ?? 0
      const matches = nonNegativeInteger(value.matchCount) ?? collectionLength(value, 'matches') ?? 0
      const contexts = nonNegativeInteger(value.contextCount) ?? collectionLength(value, 'contexts')
      return `检验 ${queries} 组字面线索，定位 ${matches} 条消息${contexts != null ? `，读取 ${contexts} 处连续上下文` : ''}`
    }
    case 'transcribe_voice_messages': {
      const requested = nonNegativeInteger(value.requested) ?? collectionLength(value, 'transcripts') ?? 0
      const transcribed = nonNegativeInteger(value.transcribed) ?? collectionLength(value, 'transcripts') ?? 0
      return `按需转写 ${transcribed}/${requested} 条语音`
    }
    case 'review_focused_voice':
    case 'review_focused_images': {
      const isVoice = toolName === 'review_focused_voice'
      const selections = Array.isArray(value.selections) ? value.selections : []
      if (selections.length > 0) {
        const requested = nonNegativeInteger(value.requestedCount) ?? selections.length
        const failed = nonNegativeInteger(value.failedCount) ?? 0
        const completed = nonNegativeInteger(value.completedCount) ?? Math.max(0, requested - failed)
        const remaining = nonNegativeInteger(value.remainingCount)
        const subject = isVoice ? '语音' : '图片'
        const unit = isVoice ? '条' : '张'
        return [
          `实际${isVoice ? '转写' : '查看'} ${completed}/${requested} ${unit}${subject}${failed > 0 ? `，其中 ${failed} ${unit}读取失败` : ''}`,
          remaining != null && remaining > 0 ? `另有 ${remaining} ${unit}${subject}未被本次调用选择` : '',
        ].filter(Boolean).join('；')
      }
      // 仅兼容仍含 inspect/skip 的旧快照。
      const decisions = Array.isArray(value.decisions) ? value.decisions : []
      const remainingKind = asRecord(value.remainingKind)
      const remainingCount = nonNegativeInteger(remainingKind?.count)
      const remainingBatches = nonNegativeInteger(remainingKind?.batches)
      const maximumBatchSize = nonNegativeInteger(value.maximumBatchSize)
        ?? nonNegativeInteger(remainingKind?.batchSize)
      const failed = isVoice
        ? (Array.isArray(value.transcriptionBatches) ? value.transcriptionBatches : [])
          .flatMap((batch) => {
            const record = asRecord(batch)
            return Array.isArray(record?.transcripts) ? record.transcripts : []
          })
          .filter((item) => asRecord(item)?.success === false).length
        : (Array.isArray(value.inspectedImages) ? value.inspectedImages : [])
          .filter((item) => asRecord(item)?.success === false).length
      const subject = isVoice ? '语音' : '图片'
      const unit = isVoice ? '条' : '张'
      return [
        `本批 ${decisions.length} ${unit}${subject}已完成决定${failed > 0 ? `，其中 ${failed} ${unit}读取失败` : ''}`,
        remainingBatches != null && remainingBatches > 0 && remainingCount != null
          ? isVoice
            ? `${subject}还剩 ${remainingBatches} 批（${remainingCount} ${unit}）`
            : `${subject}按上限还剩至少 ${remainingBatches} 批（${remainingCount} ${unit}，每批最多 ${maximumBatchSize || 32} ${unit}）`
          : `${subject}已检查完成`,
      ].join('；')
    }
    case 'review_focused_media': {
      const decisions = Array.isArray(value.decisions) ? value.decisions : []
      const remaining = nonNegativeInteger(value.remainingCount)
      const remainingMedia = asRecord(value.remainingMedia)
      const remainingBatches = nonNegativeInteger(remainingMedia?.batches)
      const remainingVoice = asRecord(remainingMedia?.voice)
      const remainingImages = asRecord(remainingMedia?.image)
      const remainingVoiceCount = nonNegativeInteger(remainingVoice?.count)
      const remainingVoiceBatches = nonNegativeInteger(remainingVoice?.batches)
      const remainingImageCount = nonNegativeInteger(remainingImages?.count)
      const remainingImageBatches = nonNegativeInteger(remainingImages?.batches)
      const transcriptionFailures = (Array.isArray(value.transcriptionBatches) ? value.transcriptionBatches : [])
        .flatMap((batch) => {
          const record = asRecord(batch)
          return Array.isArray(record?.transcripts) ? record.transcripts : []
        })
        .filter((item) => asRecord(item)?.success === false).length
      const imageFailures = (Array.isArray(value.inspectedImages) ? value.inspectedImages : [])
        .filter((item) => asRecord(item)?.success === false).length
      const failed = transcriptionFailures + imageFailures
      const remainingDetails = [
        remainingVoiceCount != null && remainingVoiceBatches != null
          ? `语音 ${remainingVoiceCount} 条（${remainingVoiceBatches} 批）`
          : '',
        remainingImageCount != null && remainingImageBatches != null
          ? `图片 ${remainingImageCount} 张（${remainingImageBatches} 批）`
          : '',
      ].filter(Boolean).join('，')
      return [
        `本批 ${decisions.length} 项已完成决定${failed > 0 ? `，其中 ${failed} 项读取失败` : ''}`,
        remainingBatches != null && remainingBatches > 0 && remainingDetails
          ? `当前还剩 ${remainingBatches} 批：${remainingDetails}`
          : remaining != null && remaining > 0
            ? `当前还剩 ${remaining} 项（旧记录未保存分类和批次）`
            : '本轮媒体已检查完成',
      ].join('；')
    }
    case 'compare_interaction_periods': {
      const periodA = asRecord(value.periodA)
      const periodB = asRecord(value.periodB)
      const totalA = nonNegativeInteger(periodA?.totalMessages)
      const totalB = nonNegativeInteger(periodB?.totalMessages)
      if (totalA != null && totalB != null) return `完成两个时期的比较：${totalA} 条与 ${totalB} 条消息`
      return '已按相同口径比较两个互动时期'
    }
    case 'inspect_media_image':
      return '已读取图片的真实画面'
    case 'present_media_image':
      return '图片已加入当前回答'
    case 'search_moments': {
      const posts = collectionLength(value, 'posts') ?? nonNegativeInteger(value.count) ?? 0
      return `返回 ${posts} 条朋友圈动态${value.hasMore === true ? '，仍有更多结果' : ''}`
    }
    case 'read_memory': {
      const entries = collectionLength(value, 'entries') ?? 0
      return `读取 ${entries} 条相关记忆`
    }
    case 'remember':
    case 'forget': {
      const results = (Array.isArray(value.results) ? value.results : [])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item))
      if (results.length === 0) {
        if (toolName === 'remember') return value.changed === false ? '长期记忆无需修改' : '已按你的要求更新长期记忆'
        return value.changed === false ? '没有需要删除或修正的记忆' : '已按你的要求清理长期记忆'
      }
      const completed = results.filter((item) => ['updated', 'already-covered', 'already-completed'].includes(text(item.status))).length
      const failed = results.filter((item) => text(item.status) === 'failed').length
      const action = toolName === 'remember' ? '记忆更新' : '记忆清理'
      if (value.complete === true) return `${action}已完成，共处理 ${completed} 项`
      return `${action}尚未全部完成：${completed} 项成功，${failed} 项需要重试`
    }
    case 'web_search':
    case 'google_search': {
      const results = collectionLength(value, 'results') ?? nonNegativeInteger(value.count) ?? 0
      return `返回 ${results} 个网页结果`
    }
    case 'set_investigation_plan':
      return '已建立调查计划'
    case 'update_investigation_plan':
      return '已更新调查计划和研究备忘'
    case 'update_research_notebook':
      return '已更新研究笔记'
    default:
      break
  }

  const compactedMessageCount = nonNegativeInteger(value.messageCount)
  if (value.uiCompacted === true && compactedMessageCount != null) {
    return `已读取 ${compactedMessageCount} 条消息；页面仅保留必要摘要和可核对证据`
  }
  if (value.timeFacts && typeof value.timeFacts === 'object') {
    const facts = value.timeFacts as Record<string, unknown>
    const total = nonNegativeInteger(facts.totalMessages)
    const inactiveDays = nonNegativeInteger(facts.daysSinceLastMessage)
    if (total != null && inactiveDays != null) return `核对 ${total} 条消息的时间分布，距上次聊天 ${inactiveDays} 天`
    if (total != null) return `核对 ${total} 条消息的时间分布`
  }
  if (value.frequency && value.interactionPatterns) {
    const frequency = value.frequency as Record<string, unknown>
    const total = nonNegativeInteger(frequency.totalMessages)
    const coverage = asRecord(value.coverage)
    const sampled = nonNegativeInteger(coverage?.sampledMessages)
    if (total != null && sampled != null) return `统计 ${total} 条消息的频率，并分析 ${sampled} 条互动样本`
  }
  if (value.periodA && value.periodB && value.changeFromAToB) return '已比较两个时期的互动总量与回应模式'

  const collectionLabels: Array<[string, string]> = [
    ['posts', '条朋友圈动态'],
    ['messages', '条聊天消息'],
    ['relationships', '位联系人互动'],
    ['people', '位提及者'],
    ['sessions', '个会话'],
    ['hits', '条相关结果'],
    ['results', '条相关结果'],
    ['records', '条记录'],
    ['events', '个时间线事件'],
    ['memories', '条记忆'],
    ['sources', '个网页来源'],
    ['rankings', '项排行'],
  ]
  for (const [key, label] of collectionLabels) {
    const count = collectionLength(value, key)
    if (count != null) return `${count} ${label}`
  }

  const count = nonNegativeInteger(value.count)
  if (count != null) return `${count} 条可用信息`
  const messagesScanned = nonNegativeInteger(value.messagesScanned)
  const sessionsScanned = nonNegativeInteger(value.sessionsScanned)
  if (messagesScanned != null && sessionsScanned != null) return `检查 ${sessionsScanned} 个会话中的 ${messagesScanned} 条消息`
  if (messagesScanned != null) return `检查 ${messagesScanned} 条消息`
  const presentation = AGENT_TOOL_PRESENTATIONS[toolName]
  return presentation ? `${presentation.label}已完成` : '扩展工具调用已完成'
}
