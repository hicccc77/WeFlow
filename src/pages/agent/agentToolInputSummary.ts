export type ToolCallOutcome = 'pending' | 'success' | 'error' | 'denied'

export type ToolInputSummaryOptions = {
  outcome?: ToolCallOutcome
  sessionNameOf?: (sessionId: string) => string
  toolLabelOf?: (toolName: string) => string
}

export type ToolInputSummaryRow = {
  label: string
  value: string
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function cleanText(value: unknown, maxLength = 120): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : ''
}

function finiteNumber(value: unknown): number | null {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function stringList(value: unknown, limit = 8, maxLength = 80): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))).slice(0, limit)
}

function quote(value: unknown, maxLength = 80): string {
  const normalized = cleanText(value, maxLength)
  return normalized ? `“${normalized}”` : ''
}

function join(parts: Array<string | undefined | null | false>): string {
  return parts.filter((part): part is string => Boolean(part)).join('\n')
}

function field(label: string, value: string): string {
  return value ? `${label}  ${value}` : ''
}

function dateRange(record: JsonRecord): string {
  const start = cleanText(record.startDate, 10)
  const end = cleanText(record.endDate, 10)
  if (start && end) return `${start} 至 ${end}`
  if (start) return `${start} 起`
  if (end) return `截至 ${end}`
  return ''
}

function sessionLabel(value: unknown, sessionNameOf?: (sessionId: string) => string): string {
  const sessionId = cleanText(value, 512)
  if (!sessionId) return '当前范围'
  if (['global', 'all', 'local-chat'].includes(sessionId.toLowerCase())) return '全部会话'
  const resolved = cleanText(sessionNameOf?.(sessionId), 100)
  if (resolved && resolved !== sessionId) return resolved
  // 允许模型直接传入唯一显示名称。若把该值隐藏为“指定会话”，不相关的调用在 UI 中会显得完全相同。
  const looksLikeTechnicalId = /^(?:accountId_|gh_|\d+@chatroom\b)/i.test(sessionId)
  if (!looksLikeTechnicalId) return sessionId
  // 渲染端查询会异步解析此值。在完成前，既要让不同会话可区分，也不能暴露完整 ID。
  return `会话名称解析中（…${sessionId.slice(-6)}）`
}

function directionLabel(value: unknown): string {
  if (value === 'backward') return '从后向前'
  if (value === 'forward') return '从前向后'
  if (value === 'before') return '向前'
  if (value === 'after') return '向后'
  if (value === 'around') return '前后'
  return ''
}

function selectionLabel(value: unknown): string {
  if (value === 'uniform') return '均匀分布'
  if (value === 'mixed') return '兼顾时间分布与活跃位置'
  return ''
}

function anchorLabel(record: JsonRecord): string {
  const anchorAt = cleanText(record.anchorAt, 32)
  if (anchorAt) return anchorAt
  const anchorDate = cleanText(record.anchorDate, 10)
  if (anchorDate) return anchorDate
  return cleanText(record.messageRef, 32) ? '指定消息位置' : ''
}

function readRequestSummary(value: unknown, sessionNameOf?: (sessionId: string) => string): string {
  const record = asRecord(value)
  if (!record) return ''
  return join([
    field('会话', sessionLabel(record.sessionId, sessionNameOf)),
    field('范围', dateRange(record)),
    field('方式', record.cursor ? '从上次位置续读' : directionLabel(record.direction)),
  ])
}

function namedPeriod(value: unknown, fallback: string): string {
  const record = asRecord(value)
  if (!record) return fallback
  const label = cleanText(record.label, 60) || fallback
  const range = dateRange(record)
  return range ? `${label}（${range}）` : label
}

function queryList(record: JsonRecord): string[] {
  const queries = stringList(record.queries, 8, 100)
  const single = cleanText(record.query, 100)
  if (single && !queries.includes(single)) queries.unshift(single)
  return queries.slice(0, 8)
}

function summarizedQueries(record: JsonRecord): string {
  const queries = queryList(record)
  if (queries.length === 0) return ''
  return field('关键词', queries.map((item) => quote(item)).join(' '))
}

function countLabel(value: unknown, unit: string): string {
  const count = finiteNumber(value)
  return count != null ? `${Math.max(0, Math.round(count))} ${unit}` : ''
}

function capabilityLabels(
  value: unknown,
  toolLabelOf?: (toolName: string) => string,
): string[] {
  return stringList(value, 12, 80).map((name) => toolLabelOf?.(name) || name)
}

function genericSafeSummary(record: JsonRecord, sessionNameOf?: (sessionId: string) => string): string {
  const pieces: string[] = []
  const safeTextKeys: Array<[string, string]> = [
    ['query', '查询'],
    ['keyword', '关键词'],
    ['title', '标题'],
    ['action', '操作'],
    ['language', '语言'],
    ['format', '格式'],
    ['reason', '原因'],
  ]
  for (const [key, label] of safeTextKeys) {
    const value = cleanText(record[key], 100)
    if (value) pieces.push(field(label, value))
    if (pieces.length >= 3) break
  }
  const sessionId = cleanText(record.sessionId, 512)
  if (sessionId) pieces.push(field('会话', sessionLabel(sessionId, sessionNameOf)))
  const range = dateRange(record)
  if (range) pieces.push(field('范围', range))
  const requests = Array.isArray(record.requests) ? record.requests.length : null
  if (requests != null) pieces.push(field('请求', `${requests} 项`))
  const queries = Array.isArray(record.queries) ? record.queries.length : null
  if (queries != null) pieces.push(field('关键词', `${queries} 组`))
  const limit = finiteNumber(record.limit)
  if (limit != null) pieces.push(field('数量', `${Math.max(0, Math.round(limit))}`))
  const summary = join(pieces.slice(0, 4))
  if (summary) return summary
  const providedCount = Object.values(record).filter((value) => value !== undefined && value !== null && value !== '').length
  return providedCount > 0 ? '已配置本次调用所需信息' : '使用默认设置'
}

/** 返回用户可读的摘要，同时不暴露游标、引用、哈希或路径。 */
export function toolInputSummary(
  toolName: string,
  input: unknown,
  options: ToolInputSummaryOptions = {},
): string {
  const record = asRecord(input)
  if (!record) return options.outcome === 'pending' ? '正在准备调用内容' : '使用默认设置'
  const session = () => sessionLabel(record.sessionId, options.sessionNameOf)
  const range = () => dateRange(record)
  const limit = () => countLabel(record.limit, '条')

  switch (toolName) {
    case 'request_tools': {
      const tools = capabilityLabels(record.tools, options.toolLabelOf)
      return tools.length > 0 ? join(['加载能力', ...tools]) : '检查可用工具能力'
    }
    case 'list_conversation_manifest': {
      const sort = record.sort === 'message_count' ? '消息量' : record.sort === 'name' ? '名称' : '最近活动'
      return join([
        field('排序', sort),
        field('数量', limit() || '最多 50 个会话'),
        field('范围', record.includeGroups === false ? '不含群聊' : record.includeGroups === true ? '包含群聊' : ''),
        finiteNumber(record.offset) ? field('起点', `第 ${Number(record.offset) + 1} 个会话`) : '',
      ])
    }
    case 'list_sessions':
      return join([
        field('数量', limit() || '使用默认数量'),
        field('范围', record.peopleOnly === true ? '仅私聊联系人' : record.peopleOnly === false ? '包含群聊' : ''),
      ])
    case 'read_raw_messages':
      return readRequestSummary(record, options.sessionNameOf)
    case 'read_raw_message_ranges': {
      const requests = Array.isArray(record.requests) ? record.requests.slice(0, 8) : []
      const previews = requests.slice(0, 3).map((item, index) => {
        const request = asRecord(item)
        if (!request) return ''
        const scope = join([
          field('会话', sessionLabel(request.sessionId, options.sessionNameOf)),
          field('范围', dateRange(request)),
          field('方式', request.cursor ? '从上次位置续读' : directionLabel(request.direction)),
        ])
        return scope ? `区间 ${index + 1}\n${scope}` : ''
      }).filter(Boolean)
      return join([
        field('读取', `${requests.length} 个原文区间`),
        ...previews,
        requests.length > 3 ? `其余  ${requests.length - 3} 个区间` : '',
      ])
    }
    case 'read_raw_timeline':
    case 'read_raw_timeline_sample':
      return join([
        field('会话', session()),
        field('范围', range()),
        field('窗口', countLabel(record.windows, '个连续窗口')),
        field('单窗预算', countLabel(record.windowTokenBudget, 'tokens')),
        field('选取', selectionLabel(record.selectionMode)),
      ])
    case 'read_raw_timeline_samples': {
      const requests = Array.isArray(record.requests) ? record.requests.slice(0, 8) : []
      const previews = requests.slice(0, 4).map((item, index) => {
        const request = asRecord(item)
        if (!request) return ''
        const scope = join([
          field('会话', sessionLabel(request.sessionId, options.sessionNameOf)),
          field('范围', dateRange(request)),
          field('窗口', countLabel(request.windows, '个连续窗口')),
          field('选取', selectionLabel(request.selectionMode)),
        ])
        return scope ? `会话 ${index + 1}\n${scope}` : ''
      }).filter(Boolean)
      return join([
        field('读取', `${requests.length} 个会话`),
        ...previews,
        requests.length > 4 ? `其余  ${requests.length - 4} 个会话` : '',
      ])
    }
    case 'search_raw_messages':
      return join([
        field('正文关键词', quote(record.query)),
        field(
          '搜索范围',
          cleanText(record.sessionId, 512)
            ? session()
            : record.includeGroups === true ? '全部会话（含群聊）' : '全部直接会话',
        ),
        field('范围', range()),
        field('最多返回', limit()),
        record.includeFirstContext === true ? field('上下文', '读取首个命中位置') : '',
        finiteNumber(record.offset) ? field('起点', `第 ${Number(record.offset) + 1} 条命中`) : '',
      ])
    case 'locate_conversations_by_message_text':
      return join([
        summarizedQueries(record) || '关键词\n未提供',
        field('范围', range()),
        field('每个关键词', countLabel(record.hitsPerQuery, '条命中')),
      ])
    case 'read_message_thread':
      return join([
        field('会话', session()),
        field('锚点', anchorLabel(record)),
        field('方向', directionLabel(record.direction) || '前后补充'),
        field('上下文', countLabel(record.contextCount, '条消息') || '自动选择连续范围'),
      ])
    case 'read_event_contexts': {
      const requests = Array.isArray(record.requests) ? record.requests.slice(0, 6) : []
      const previews = requests.slice(0, 4).map((item, index) => {
        const request = asRecord(item)
        if (!request) return ''
        const scope = join([
          field('会话', sessionLabel(request.sessionId, options.sessionNameOf)),
          field('锚点', anchorLabel(request)),
          field('方向', directionLabel(request.direction) || '前后补充'),
          field('上下文', countLabel(request.contextCount, '条消息') || '自动选择连续范围'),
        ])
        return scope ? `事件 ${index + 1}\n${scope}` : ''
      }).filter(Boolean)
      return join([
        field('读取', `${requests.length} 个事件上下文`),
        ...previews,
        requests.length > 4 ? `其余  ${requests.length - 4} 个事件` : '',
      ])
    }
    case 'inspect_message_context':
      return join([
        field('会话', session()),
        field('锚点', finiteNumber(record.localId) != null || finiteNumber(record.createTime) != null || cleanText(record.messageKey, 32) ? '指定消息位置' : ''),
        field('上下文', countLabel(record.contextCount, '条消息') || '自动选择连续范围'),
      ])
    case 'inspect_relationship_timeline':
      return join([
        field('会话', session()),
        field('末段消息', countLabel(record.recentMessageLimit, '条')),
      ])
    case 'inspect_relationship_events':
      return join([
        field('会话', session()),
        field('事件', countLabel(record.maxEvents, '个')),
      ])
    case 'read_messages_by_time':
      return join([
        field('会话', session()),
        field('范围', range()),
        field('消息', limit()),
      ])
    case 'read_recent_messages':
      return join([
        field('会话', session()),
        field('消息', limit()),
        finiteNumber(record.offset) ? field('起点', `第 ${Number(record.offset) + 1} 条`) : '',
      ])
    case 'read_recent_activity':
      return join([
        field('范围', range() || (finiteNumber(record.lookbackDays) != null ? `最近 ${Number(record.lookbackDays)} 天` : '')),
        field('会话', countLabel(record.maxSessions, '个')),
        field('消息', countLabel(record.maxMessages, '条')),
        cleanText(record.focus, 100) ? field('重点', cleanText(record.focus, 100)) : '',
      ])
    case 'search_and_read_raw_messages':
      return join([
        summarizedQueries(record) || '关键词\n未提供',
        field('会话', session()),
        field('范围', range()),
        field('每个关键词', countLabel(record.contextsPerQuery ?? record.contextMatches, '处上下文')),
        field('每处上下文', countLabel(record.contextCount, '条消息')),
      ])
    case 'analyze_interaction_patterns':
      return join([field('会话', session()), field('范围', range())])
    case 'compare_interaction_periods':
      return join([
        field('会话', session()),
        field('时期 A', namedPeriod(record.periodA, '未命名时期')),
        field('时期 B', namedPeriod(record.periodB, '未命名时期')),
      ])
    case 'set_investigation_plan':
      return join([
        field('计划', cleanText(record.title, 120) || '未命名'),
        field('步骤', countLabel(Array.isArray(record.steps) ? record.steps.length : 0, '个')),
        field('要求', countLabel(Array.isArray(record.answerRequirements) ? record.answerRequirements.length : 0, '项')),
      ])
    case 'plan_evidence':
      return join([
        field('目标', cleanText(record.goal, 140) || '规划当前问题的证据'),
        field('主张', countLabel(Array.isArray(record.claims) ? record.claims.length : 0, '项')),
        field('维度', countLabel(Array.isArray(record.analysisDimensions) ? record.analysisDimensions.length : 0, '个')),
        field('来源', countLabel(Array.isArray(record.sources) ? record.sources.length : 0, '类')),
      ])
    case 'select_evidence_focus':
      return join([
        field('主要会话', sessionLabel(record.primarySessionId, options.sessionNameOf)),
        field('对照会话', countLabel(Array.isArray(record.alternativeSessionIds) ? record.alternativeSessionIds.length : 0, '个')),
        field('关键事件', countLabel(Array.isArray(record.decisiveEventIds) ? record.decisiveEventIds.length : 0, '个')),
        cleanText(record.reason, 120) ? field('理由', cleanText(record.reason, 120)) : '',
      ])
    case 'select_event_units':
      return join([
        field('主要会话', sessionLabel(record.primarySessionId, options.sessionNameOf)),
        field('对照会话', countLabel(Array.isArray(record.alternativeSessionIds) ? record.alternativeSessionIds.length : 0, '个')),
        field('事件单元', countLabel(Array.isArray(record.selectedUnitIds) ? record.selectedUnitIds.length : 0, '个')),
        field('直接证据', countLabel(Array.isArray(record.directEvidenceUnitIds) ? record.directEvidenceUnitIds.length : 0, '个')),
      ])
    case 'screen_event_shard':
      return join([
        field('分片', cleanText(record.shardId, 80) || '指定事件分片'),
        field('评估', countLabel(Array.isArray(record.unitAssessments) ? record.unitAssessments.length : 0, '项')),
        cleanText(record.coverageNote, 120) ? field('覆盖', cleanText(record.coverageNote, 120)) : '',
      ])
    case 'review_evidence':
      return join([
        field('状态', record.ready === true ? '可以成文' : record.ready === false ? '仍需补证' : '复核证据'),
        cleanText(record.confidence, 40) ? field('置信度', cleanText(record.confidence, 40)) : '',
        field('支持主张', countLabel(Array.isArray(record.supportedClaims) ? record.supportedClaims.length : 0, '项')),
        field('证据缺口', countLabel(Array.isArray(record.materialGaps) ? record.materialGaps.length : 0, '项')),
      ])
    case 'update_investigation_plan':
      return join([
        cleanText(record.title, 120) ? field('计划', cleanText(record.title, 120)) : '更新当前计划',
        field('状态变更', countLabel(Array.isArray(record.stepUpdates) ? record.stepUpdates.length : 0, '项')),
        field('新增步骤', countLabel(Array.isArray(record.addSteps) ? record.addSteps.length : 0, '个')),
        Array.isArray(record.uncertainties) ? field('待确认', `${record.uncertainties.length} 项`) : '',
      ])
    case 'update_research_notebook':
      return join([
        field('确认事实', countLabel(Array.isArray(record.confirmedFacts) ? record.confirmedFacts.length : 0, '条')),
        field('当前解释', countLabel(Array.isArray(record.currentInterpretations) ? record.currentInterpretations.length : 0, '个')),
        field('待核问题', countLabel(Array.isArray(record.openQuestions) ? record.openQuestions.length : 0, '个')),
        cleanText(record.nextReading, 120) ? field('下一步', cleanText(record.nextReading, 120)) : '',
      ]) || '清理当前研究笔记'
    case 'transcribe_voice_messages': {
      const refs = Array.isArray(record.voiceRefs) ? record.voiceRefs : []
      return join([
        field('语音', `${refs.length} 条`),
        cleanText(record.reason, 140) ? field('目的', cleanText(record.reason, 140)) : '',
      ])
    }
    case 'review_focused_media': {
      const decisions = Array.isArray(record.decisions)
        ? record.decisions.map(asRecord).filter((item): item is JsonRecord => Boolean(item))
        : []
      const voices = decisions.filter((item) => cleanText(item.mediaRef).startsWith('voice_')).length
      const images = decisions.filter((item) => cleanText(item.mediaRef).startsWith('image_')).length
      const inspected = decisions.filter((item) => item.action === 'inspect').length
      const skipped = decisions.filter((item) => item.action === 'skip').length
      if (voices > 0 && images === 0) {
        return join([
          field('范围', `${voices} 条语音`),
          field('决定', `转写 ${inspected} 条，跳过 ${skipped} 条`),
        ])
      }
      if (images > 0 && voices === 0) {
        return join([
          field('范围', `${images} 张图片`),
          field('决定', `查看 ${inspected} 张，跳过 ${skipped} 张`),
        ])
      }
      return join([
        field('范围', `${decisions.length} 项（语音 ${voices}，图片 ${images}）`),
        field('决定', `读取 ${inspected} 项，跳过 ${skipped} 项`),
      ])
    }
    case 'review_focused_voice':
    case 'review_focused_images': {
      const isVoice = toolName === 'review_focused_voice'
      const selections = Array.isArray(record.selections)
        ? record.selections.map(asRecord).filter((item): item is JsonRecord => Boolean(item))
        : []
      if (selections.length > 0) {
        return join([
          field('范围', isVoice ? `${selections.length} 条语音` : `${selections.length} 张图片`),
          field('执行', isVoice
            ? `实际转写 ${selections.length} 条`
            : `实际查看 ${selections.length} 张`),
        ])
      }
      // 仅兼容旧快照。新调用不再接受 inspect/skip 决策表。
      const decisions = Array.isArray(record.decisions)
        ? record.decisions.map(asRecord).filter((item): item is JsonRecord => Boolean(item))
        : []
      const inspected = decisions.filter((item) => item.action === 'inspect').length
      const skipped = decisions.filter((item) => item.action === 'skip').length
      return join([
        field('范围', isVoice ? `${decisions.length} 条语音` : `${decisions.length} 张图片`),
        field('决定', isVoice
          ? `转写 ${inspected} 条，跳过 ${skipped} 条`
          : `查看 ${inspected} 张，跳过 ${skipped} 张`),
      ])
    }
    case 'inspect_media_image':
      return '读取指定图片的实际画面'
    case 'present_media_image':
      return '展示模型已核验的指定图片'
    case 'search_moments': {
      const users = stringList(record.usernames, 20, 100)
      const singleUser = cleanText(record.username, 100)
      if (singleUser && !users.includes(singleUser)) users.unshift(singleUser)
      return join([
        cleanText(record.query, 100) ? field('关键词', quote(record.query)) : '读取朋友圈动态',
        users.length > 0 ? field('用户', `${users.length} 位`) : '',
        field('范围', range()),
        field('结果', limit()),
        finiteNumber(record.offset) ? field('起点', `第 ${Number(record.offset) + 1} 条动态`) : '',
      ])
    }
    case 'read_memory': {
      const titles = stringList(record.titles, 12, 80)
      return titles.length > 0 ? field('读取', titles.map((title) => quote(title, 80)).join('、')) : '读取相关个人记忆'
    }
    case 'recall':
    case 'list_memories':
      return cleanText(record.query, 140) ? field('查询', quote(record.query, 140)) : '查看当前问题相关的记忆'
    case 'remember':
    case 'forget': {
      const items = Array.isArray(record.items)
        ? record.items.map(asRecord).filter((item): item is JsonRecord => Boolean(item)).slice(0, 12)
        : []
      if (items.length === 0) {
        if (toolName === 'remember') {
          return join([
            cleanText(record.category, 40) ? field('类别', cleanText(record.category, 40)) : '',
            cleanText(record.content, 140) ? field('内容', cleanText(record.content, 140)) : '',
          ])
        }
        return cleanText(record.instruction, 140)
          ? field('内容', cleanText(record.instruction, 140))
          : '删除用户指定的一条记忆'
      }
      const previews = items
        .map((item) => cleanText(item.content, 72))
        .filter(Boolean)
        .slice(0, 3)
      return join([
        field('项目', `${items.length} 项`),
        previews.length > 0 ? field('内容', previews.join('；')) : '',
      ])
    }
    case 'web_search':
    case 'google_search':
      return join([field('关键词', quote(record.query)), field('结果', limit())])
    case 'search_messages':
      return join([
        field('关键词', quote(record.query)),
        field('会话', session()),
        field('结果', limit()),
      ])
    case 'relationship_overview':
      return join([
        field('联系人', countLabel(record.limit, '位') || '使用默认数量'),
        field('每人消息', countLabel(record.messagesPerPerson, '条')),
      ])
    case 'total_message_ranking':
      return field('排行', countLabel(record.limit, '位') || '使用默认数量')
    case 'desktop_screenshot':
      return join([
        cleanText(record.windowTitle, 100) ? field('窗口', cleanText(record.windowTitle, 100)) : '当前桌面',
        record.includeCursor === true ? '包含鼠标' : '',
      ])
    case 'desktop_ocr':
      return join([
        '识别当前屏幕文字',
        cleanText(record.language, 40) ? field('语言', cleanText(record.language, 40)) : '',
        asRecord(record.region) ? '限定屏幕区域' : '',
      ])
    case 'audit_memories':
      return join(['检查长期记忆的冲突与过期项', limit()])
    case 'apply_memory_fix':
      return join([
        cleanText(record.action, 60) ? field('方式', cleanText(record.action, 60)) : '应用指定记忆修复',
        cleanText(record.reason, 120) ? field('原因', cleanText(record.reason, 120)) : '',
      ])
    case 'persona_control':
      return join([
        cleanText(record.action, 80) ? field('操作', cleanText(record.action, 80)) : '调整数字分身',
        cleanText(record.displayName, 80) ? field('对象', cleanText(record.displayName, 80)) : '',
      ])
    case 'auto_memory':
      return join([
        cleanText(record.action, 80) ? field('操作', cleanText(record.action, 80)) : '处理自动记忆',
        cleanText(record.content, 120) ? field('内容', cleanText(record.content, 120)) : '',
      ])
    case 'rollback_operation':
      return join([
        '回滚用户指定的操作',
        cleanText(record.reason, 120) ? field('原因', cleanText(record.reason, 120)) : '',
      ])
    case 'delegate_analysis': {
      const tasks = Array.isArray(record.tasks) ? record.tasks : []
      const titles = tasks.map((task) => cleanText(asRecord(task)?.title, 80)).filter(Boolean).slice(0, 4)
      return join([
        field('任务数', `${tasks.length || 1} 项`),
        ...(titles.length > 0 ? titles.map((title) => field('任务', title)) : [field('任务', cleanText(record.task, 120))]),
      ])
    }
    case 'run_command':
      return cleanText(record.command, 180) ? field('命令', cleanText(record.command, 180)) : '执行模型生成的命令'
    case 'file_change': {
      const changes = Array.isArray(record.changes) ? record.changes.length : finiteNumber(record.count)
      return join([
        cleanText(record.action, 60) ? field('操作', cleanText(record.action, 60)) : '应用文件变更',
        changes != null ? field('变更', `${changes} 处`) : '',
      ])
    }
    default: {
      return genericSafeSummary(record, options.sessionNameOf)
    }
  }
}

const INPUT_FALLBACK_LABELS: Record<string, string> = {
  request_tools: '能力',
  review_focused_voice: '语音',
  review_focused_images: '图片',
  review_focused_media: '范围',
  inspect_media_image: '图片',
  present_media_image: '图片',
  search_moments: '动态',
  read_memory: '记忆',
  recall: '记忆',
  remember: '记忆',
  forget: '记忆',
  desktop_screenshot: '截图',
  desktop_ocr: '识别',
  audit_memories: '检查',
  apply_memory_fix: '修复',
  rollback_operation: '回滚',
  delegate_analysis: '任务',
  run_command: '命令',
  file_change: '文件',
}

function isGroupedSummaryHeader(line: string): boolean {
  return /^(?:区间|会话|事件) \d+$/.test(line)
}

function splitSummaryField(line: string): ToolInputSummaryRow | null {
  const match = /^(.{1,16}?) {2,}(.+)$/.exec(line)
  if (!match) return null
  const label = match[1].trim()
  const value = match[2].trim()
  return label && value ? { label, value } : null
}

/** 把紧凑文本契约拆分成可独立对齐的 UI 行。 */
export function toolInputSummaryRows(
  toolName: string,
  input: unknown,
  options: ToolInputSummaryOptions = {},
): ToolInputSummaryRow[] {
  const fallbackLabel = INPUT_FALLBACK_LABELS[toolName] || '内容'
  const lines = toolInputSummary(toolName, input, options)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    const record = asRecord(input)
    return [{
      label: fallbackLabel,
      value: record
        ? genericSafeSummary(record, options.sessionNameOf)
        : options.outcome === 'pending' ? '正在准备调用内容' : '使用默认设置',
    }]
  }
  const rows: ToolInputSummaryRow[] = []

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const fieldRow = splitSummaryField(line)
    if (fieldRow) {
      rows.push(fieldRow)
      index += 1
      continue
    }

    if (line === '关键词' || line === '加载能力') {
      const values: string[] = []
      index += 1
      while (index < lines.length && !splitSummaryField(lines[index]) && !isGroupedSummaryHeader(lines[index])) {
        values.push(lines[index])
        index += 1
      }
      rows.push({
        label: line === '加载能力' ? '能力' : line,
        value: values.join('\n') || '未提供',
      })
      continue
    }

    if (isGroupedSummaryHeader(line)) {
      const values: string[] = []
      index += 1
      while (index < lines.length && !isGroupedSummaryHeader(lines[index]) && !lines[index].startsWith('其余  ')) {
        values.push(lines[index])
        index += 1
      }
      rows.push({ label: line, value: values.join('\n') || '未提供范围' })
      continue
    }

    const previous = rows[rows.length - 1]
    if (previous?.label === fallbackLabel) previous.value = `${previous.value}\n${line}`
    else rows.push({ label: fallbackLabel, value: line })
    index += 1
  }

  return rows.slice(0, 16)
}
