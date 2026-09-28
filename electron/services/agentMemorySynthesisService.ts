import { streamText } from 'ai'
import { createAgentModel } from './agentModelAdapter'
import {
  agentMemoryStore,
  type AgentMemoryCategory,
  type AgentMemoryEntryDraft,
  type AgentMemoryEntryPatchOperation,
  type AgentMemoryEntry,
  type AgentMemorySummarySnapshot,
} from './agentMemoryService'
import { createAgentTextRedactionSession } from './agentTextRedaction'
import { filterAutomaticMemoryEntries, filterAutomaticMemoryPatch, type AgentMemoryQualityIssue } from './agentMemoryQuality'
import type { AgentFeedbackMemoryEvidence, AgentFeedbackMemorySample, AgentFeedbackReason } from './agentFeedbackStore'
import type { AgentModelConfig } from './agentService'

export type AgentMemorySynthesisResult = {
  success: boolean
  changed?: boolean
  skipped?: boolean
  summary?: AgentMemorySummarySnapshot
  error?: string
  diagnostics?: {
    generatedOperationCount: number
    acceptedOperationCount: number
    rejected: Array<{ title: string; issues: AgentMemoryQualityIssue[] }>
  }
}

export type AgentMemoryConversationExchange = {
  turnId?: string
  occurredAt?: number
  userText: string
  assistantText: string
}

type MemoryUpdateMode = 'conversation' | 'feedback' | 'instruction' | 'refresh'

function text(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim()
}

function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const message = value as { role?: unknown; content?: unknown; parts?: unknown }
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.parts)) return ''
  return message.parts
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === 'text' ? text(candidate.text) : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function latestUserText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown }
    if (message?.role !== 'user') continue
    const content = messageText(message)
    if (content) return content
  }
  return ''
}

function memorySamplingOptions(config: AgentModelConfig): { temperature?: number } {
  const modelId = String(config.model || '').trim().toLocaleLowerCase()
  const reasoningModel = config.protocol === 'openai-responses' && /^(?:gpt-5|o[1-4](?:-|$))/.test(modelId)
  return reasoningModel || config.protocol === 'anthropic' ? {} : { temperature: 0.1 }
}

function modelIsConfigured(config?: AgentModelConfig | null): config is AgentModelConfig {
  return Boolean(config?.model && config.baseURL && (config.apiKey || config.provider === 'ollama'))
}

function promptTime(timestamp: number = Date.now()): string {
  const date = new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now())
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${sign}${offsetHours}:${offsetRemainder}`
}

function feedbackReasonLabel(reason?: AgentFeedbackReason): string {
  switch (reason) {
    case 'incorrect': return '事实不准确'
    case 'missing': return '漏掉关键信息'
    case 'overreach': return '推断过度'
    case 'unclear': return '表达不清楚'
    case 'verbose': return '太啰嗦'
    case 'shallow': return '不够深入'
    case 'direct': return '直接切题'
    case 'clear': return '表达清楚'
    case 'thorough': return '分析充分'
    case 'evidence': return '证据扎实'
    case 'tone': return '语气风格'
    case 'method': return '处理方法'
    default: return '未选择具体原因'
  }
}

const MEMORY_CATEGORIES = new Set<AgentMemoryCategory>([
  'identity', 'preference', 'relationship', 'project', 'communication', 'habit', 'goal', 'event', 'other',
])

function normalizeMemoryEntryDraft(value: unknown): AgentMemoryEntryDraft | null {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const entry: AgentMemoryEntryDraft = {
    title: text(candidate.title).slice(0, 80),
    detail: text(candidate.detail).slice(0, 4_000),
    category: MEMORY_CATEGORIES.has(candidate.category as AgentMemoryCategory)
      ? candidate.category as AgentMemoryCategory
      : 'other',
  }
  return entry.title && entry.detail ? entry : null
}

function normalizeMemoryPatchOperation(value: unknown): AgentMemoryEntryPatchOperation | null {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const op = text(candidate.op)
  const targetId = text(candidate.targetId).slice(0, 180)
  if (op === 'delete') return targetId ? { op: 'delete', targetId } : null
  if (op !== 'add' && op !== 'update') return null
  const entry = normalizeMemoryEntryDraft(candidate)
  if (!entry || (op === 'update' && !targetId)) return null
  return op === 'add' ? { op, entry } : { op, targetId, entry }
}

function parseMemoryPatch(value: string): AgentMemoryEntryPatchOperation[] | null {
  const match = /<memory_patch>([\s\S]*?)<\/memory_patch>/iu.exec(value)
  if (!match) return null
  const serialized = match[1].trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try {
    const parsed = JSON.parse(serialized || '[]') as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.map(normalizeMemoryPatchOperation).filter((operation): operation is AgentMemoryEntryPatchOperation => Boolean(operation)).slice(0, 12)
  } catch {
    return null
  }
}

function partialJsonStringField(source: string, field: string): string {
  const match = new RegExp(`"${field}"\\s*:\\s*"`, 'u').exec(source)
  if (!match) return ''
  let value = ''
  let escaped = false
  for (let index = match.index + match[0].length; index < source.length; index += 1) {
    const character = source[index]
    if (!escaped) {
      if (character === '"') break
      if (character === '\\') {
        escaped = true
        continue
      }
      value += character
      continue
    }
    escaped = false
    if (character === 'n') value += '\n'
    else if (character === 'r') value += '\r'
    else if (character === 't') value += '\t'
    else if (character === 'b') value += '\b'
    else if (character === 'f') value += '\f'
    else if (character === 'u') {
      const unicode = source.slice(index + 1, index + 5)
      if (/^[0-9a-f]{4}$/iu.test(unicode)) {
        value += String.fromCharCode(Number.parseInt(unicode, 16))
        index += 4
      }
    } else value += character
  }
  return value
}

function parseMemoryPatchPreview(value: string): AgentMemoryEntryPatchOperation[] {
  const openingTag = /<memory_patch>/iu.exec(value)
  if (!openingTag) return []
  const source = value.slice(openingTag.index + openingTag[0].length).replace(/^\s*```(?:json)?\s*/iu, '')
  const objects: Array<{ source: string; complete: boolean }> = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push({ source: source.slice(start, index + 1), complete: true })
        start = -1
      }
    }
  }
  if (start >= 0) objects.push({ source: source.slice(start), complete: false })

  return objects.slice(0, 12).flatMap((object) => {
    if (object.complete) {
      try {
        const operation = normalizeMemoryPatchOperation(JSON.parse(object.source))
        return operation ? [operation] : []
      } catch {
        return []
      }
    }
    const op = partialJsonStringField(object.source, 'op')
    const targetId = partialJsonStringField(object.source, 'targetId').trim().slice(0, 180)
    if (op === 'delete') return targetId ? [{ op: 'delete' as const, targetId }] : []
    if (op !== 'add' && op !== 'update') return []
    const title = partialJsonStringField(object.source, 'title').trim().slice(0, 80)
    const detail = partialJsonStringField(object.source, 'detail').slice(0, 4_000)
    if (!title) return []
    const categoryValue = partialJsonStringField(object.source, 'category') as AgentMemoryCategory
    const entry = {
      title,
      detail,
      category: MEMORY_CATEGORIES.has(categoryValue) ? categoryValue : 'other',
    }
    return op === 'update' && targetId
      ? [{ op: 'update' as const, targetId, entry }]
      : op === 'add'
        ? [{ op: 'add' as const, entry }]
        : []
  })
}

function previewEntriesAfterPatch(
  existing: AgentMemoryEntry[],
  operations: AgentMemoryEntryPatchOperation[],
): AgentMemoryEntryDraft[] {
  const next = existing.map(({ title, detail, category, id }) => ({ title, detail, category, id }))
  for (const operation of operations) {
    if (operation.op === 'delete') {
      const index = next.findIndex((entry) => entry.id === operation.targetId)
      if (index >= 0) next.splice(index, 1)
      continue
    }
    const index = operation.op === 'update'
      ? next.findIndex((entry) => entry.id === operation.targetId)
      : next.findIndex((entry) => entry.title.toLocaleLowerCase() === operation.entry.title.toLocaleLowerCase())
    if (index >= 0) next[index] = { ...operation.entry, id: next[index].id }
    else next.push({ ...operation.entry, id: `preview-${next.length}` })
  }
  return next.map(({ title, detail, category }) => ({ title, detail, category }))
}

function baseSystemPrompt(): string {
  return [
    `本次整理的当前时间基准是 ${promptTime()}。所有“现在、目前、最近、将要”等相对时间判断都必须以这个时刻为准。`,
    '你负责维护一组供未来 AI 按需读取的“个人记忆”。它是 AI 的长期工作指引，不是用户简历、人物档案、事件摘要、关系档案或备忘录。',
    '每条自动记忆都必须回答三个问题：它在什么类型的未来请求中相关；用户有哪些稳定偏好、目标或边界；AI 应据此怎样调整回答或工作方式。只描述用户发生过什么、认识谁或处于什么阶段，不构成记忆。',
    '标题必须命名一个可复用的交互主题，让 AI 只看标题就能判断是否值得读取；不得以具体事件、具体第三方或时间节点作为标题主体。详情必须采用面向未来的操作性表达，不得逐项复述原始素材。',
    '自动整理优先保存反复验证的回答偏好、沟通边界、协作方式、长期目标，以及会持续改变 AI 工作方式的项目约束。先做“合格助手基线检验”：任何称职 AI 本来就应遵守的通用原则，不属于个人记忆；只有用户相对于通用基线的稳定差异才值得保存。',
    '稳定性采用明确证据规则：用户直接纠正过 Agent、明确要求以后怎样做，单次即可形成记忆；同类行为在至少两个独立会话中反复出现，也可形成记忆；仅从一次普通提问猜出的偏好不得保存。',
    '记忆库会随新会话逐步增长，不需要每次重新整理全部内容。每条详情必须是一个 35 到 95 字的紧凑段落，最多两句；不得出现括号示例、“例如/比如”或用户原句，只留下触发场景、用户差异与 AI 行动。',
    '同一未来场景下会触发相同行动的内容必须合并，不能为了覆盖素材而拆成相邻条目。自动条目只能使用 preference、communication、goal 或 project 分类。',
    '对每条候选信息判断时间稳定性和未来复用价值。仅在有限时间窗口内成立、只服务于单次任务或很快会自然失效的信息，通常不应作为长期记忆；如果一段阶段性经历具有持续影响，只保留其长期意义，并用绝对日期、明确时间范围或已结束的表达来描述。',
    '不得把历史对话或旧条目中的相对时间表述直接延续为当前事实。无法从带时间的原始信息确认某个状态仍在持续时，删除当前状态断言，或将其改写为有时间边界的历史事实。记忆不是实时状态数据库。',
    '第三方资料和关系经过不得由自动记忆保存。工具、权限、数据源、归档存在性和运行环境属于系统上下文，也不得写成个人记忆。若对话暴露出稳定的回应偏好或沟通边界，只能抽象为用户自身的 AI 交互指引。',
    '用户自己的表述是判断其偏好、边界和意图的唯一依据。Agent 已完成的回答只能帮助理解本轮发生了什么、用户在纠正什么，不得用来反推用户的心理、关系模式、关注重点或回答偏好；Agent 自己写出的分析和建议绝不是记忆证据。',
    '证据优先级从高到低：用户对 Agent 的明确纠错或“以后怎样回答”的要求；多个独立会话中重复出现的格式、查证或工具要求；普通主题兴趣。先处理前两类。仅仅反复谈某个主题，不等于用户偏好某一种分析结论，也不得据此为用户建立心理画像。',
    '点赞和点踩只是弱行为证据，不等于用户明确说过某项偏好。单条反馈绝不能新增或修改记忆；只有至少三个不同回答的同方向反馈共同支持同一种、可复用的回答方式时，才能形成或修正一条记忆。反馈所针对的事实内容、人物、地点和主题本身不得进入记忆。',
    '从反馈学习时，只能归纳回答的组织方式、深度、语气、证据使用、检索策略、直接程度或解题方法。先比较多个赞同与不赞同回答中的共同差异；若共同点不清晰、只是合格助手的通用要求，或证据可能由问题主题造成，必须输出空 patch。',
    '不同会话中的要求表面冲突时，先判断是否存在不同触发条件，并 update 为一条带条件的规则。某种主动推断或操作只有在用户明确要求时才成立，不能扩展到用户未授权的普通场景。',
    '新信息与旧条目冲突时，以用户最新且明确的表述为准。已有条目默认保持不变：只有新证据确实补充或纠正某条时才 update；只有用户明确否定或要求忘记时才 delete；同主题不得另建近义条目。',
    '不要保存密码、密钥、验证码、完整证件号、完整电话号码、支付信息，或与用户无关的第三方隐私。',
    '输出增量 JSON 数组，而不是完整记忆。新增：{"op":"add","title":string,"category":"preference"|"communication"|"goal"|"project","detail":string}；更新：{"op":"update","targetId":string,"title":string,"category":...,"detail":string}；删除：{"op":"delete","targetId":string}。update/delete 的 targetId 必须来自当前条目。',
    '一次普通会话最多输出 2 个操作，批量回顾最多 6 个操作。详情使用“你”称呼用户，不得包含 Markdown 标题。',
    '只能输出一次 <memory_patch>[...]</memory_patch>，标签之外不得有任何文字。没有新增或变化时输出 <memory_patch>[]</memory_patch>。',
  ].join('\n')
}

function updatePrompt(options: {
  mode: MemoryUpdateMode
  currentEntries: Array<AgentMemoryEntryDraft & { id: string }>
  userText?: string
  assistantText?: string
  occurredAt?: number
  instruction?: string
  recentExchanges?: AgentMemoryConversationExchange[]
  feedbackSamples?: AgentFeedbackMemorySample[]
}): string {
  const current = options.currentEntries.length > 0
    ? JSON.stringify(options.currentEntries)
    : '[]'
  const recent = (options.recentExchanges || [])
    .slice(-24)
    .map((exchange, index) => [
      `近期对话 ${index + 1}：`,
      exchange.occurredAt ? `发生时间：${promptTime(exchange.occurredAt)}` : '',
      `用户：${text(exchange.userText).slice(0, 1_200)}`,
      `Agent 已完成的回答：${text(exchange.assistantText).slice(0, 2_000)}`,
    ].filter(Boolean).join('\n'))
    .join('\n\n')
  const feedback = (options.feedbackSamples || [])
    .slice(-24)
    .map((sample, index) => [
      `独立回答反馈 ${index + 1}：${sample.rating === 'up' ? '点赞' : '点踩'}（${feedbackReasonLabel(sample.reason)}）`,
      `反馈时间：${promptTime(sample.at)}`,
      `用户请求：${text(sample.question).slice(0, 800)}`,
      `Agent 最终回答：${text(sample.answer).slice(0, 1_800)}`,
    ].join('\n'))
    .join('\n\n')
  if (options.mode === 'instruction') {
    return [
      `当前个人记忆条目：\n${current}`,
      `用户对记忆的自然语言修改要求：\n${options.instruction || ''}`,
      '严格执行这条修改要求，只返回必要的增量操作。若用户要求忘记某项，delete 对应条目；若用户纠正某项，update 对应条目；新增内容使用 add。不要输出或改动无关条目。',
    ].join('\n\n')
  }
  if (options.mode === 'refresh') {
    return [
      `当前个人记忆条目：\n${current}`,
      recent ? `近期已完成的对话（按时间先后排列）：\n${recent}` : '',
      '这是批量回顾模式，但仍然只能输出增量 patch，不能复写完整记忆。找出明确纠错或跨独立会话反复出现的稳定差异，新增缺失条目，或更新真正需要补充的对应条目。不要因为旧条目没有在近期对话出现就删除它。人物档案、事件记录、关系经过、阶段状态、运行时能力说明和通用助手纪律不得保存。',
    ].filter(Boolean).join('\n\n')
  }
  if (options.mode === 'feedback') {
    return [
      `当前个人记忆条目：\n${current}`,
      feedback ? `用户对不同回答的有效反馈（按时间先后排列）：\n${feedback}` : '',
      '这是反馈聚合后的增量学习。逐项寻找跨至少三个不同回答重复出现、且同方向反馈支持的回答特征；点赞与点踩可以互相对照，但任何一个样本都不能单独作为结论。',
      '只允许 add 或 update 最多两条 preference/communication 记忆。不得 delete；不得保存问题与回答中的具体事实、主题内容、人物信息或一次性做法；不得把“准确、清楚、有帮助”等通用质量基线写成个人偏好。证据不足或当前条目已经准确覆盖时返回空 patch。',
    ].filter(Boolean).join('\n\n')
  }
  return [
    `当前个人记忆条目：\n${current}`,
    recent ? `此前近期已完成的对话（用于理解跨轮上下文，按时间先后排列）：\n${recent}` : '',
    `本轮对话完成时间：${promptTime(options.occurredAt)}`,
    `本轮用户消息（这是判断用户感受与意图的主要依据）：\n${options.userText || ''}`,
    options.assistantText ? `本轮 Agent 已完成的回答（可用于指代解析及采用其中经调查获得的具体事实；不可采用猜测、建议或评价）：\n${options.assistantText}` : '',
    '这是新会话后的增量整理。近期上下文只能用于验证重复性，本轮新证据才决定是否 add/update/delete。已有条目默认保留；不要重复输出未变化条目。不得记录人物档案、事件经过、关系历史、当前阶段或运行时能力，只使用 preference、communication、goal 或 project 分类。',
  ].filter(Boolean).join('\n\n')
}

async function generatePatch(options: {
  mode: MemoryUpdateMode
  snapshot: AgentMemorySummarySnapshot
  modelConfig: AgentModelConfig
  userText?: string
  assistantText?: string
  occurredAt?: number
  instruction?: string
  recentExchanges?: AgentMemoryConversationExchange[]
  feedbackSamples?: AgentFeedbackMemorySample[]
  onPreview?: (entries: AgentMemoryEntryDraft[]) => void
}): Promise<AgentMemoryEntryPatchOperation[]> {
  const redaction = createAgentTextRedactionSession()
  const prompt = redaction.redactText(updatePrompt({
    mode: options.mode,
    currentEntries: options.snapshot.entries.map(({ id, title, detail, category }) => ({ id, title, detail, category })),
    userText: text(options.userText).slice(0, 8_000),
    assistantText: text(options.assistantText).slice(0, 4_000),
    occurredAt: options.occurredAt,
    instruction: text(options.instruction).slice(0, 2_000),
    recentExchanges: options.recentExchanges,
    feedbackSamples: options.feedbackSamples,
  }))
  const result = streamText({
    model: createAgentModel(options.modelConfig),
    system: baseSystemPrompt(),
    prompt,
    maxOutputTokens: 3_200,
    ...memorySamplingOptions(options.modelConfig),
    reasoning: 'none',
    abortSignal: AbortSignal.timeout(90_000),
  })
  let output = ''
  let lastPreview = ''
  for await (const delta of result.textStream) {
    output += delta
    if (options.onPreview) {
      const operations = parseMemoryPatchPreview(output)
      const preview = previewEntriesAfterPatch(options.snapshot.entries, operations)
      const serialized = JSON.stringify(preview)
      if (operations.length > 0 && serialized !== lastPreview) {
        lastPreview = serialized
        options.onPreview(preview)
      }
    }
  }
  const operations = parseMemoryPatch(output)
  if (operations === null) {
    throw new Error(`记忆模型未返回有效增量操作（finishReason: ${String(await result.finishReason || 'unknown')}）`)
  }
  // 脱敏标记有意不还原：摘要不应重新持久化完整手机号或证件号。
  return operations
}

async function applyModelUpdate(options: {
  mode: MemoryUpdateMode
  modelConfig?: AgentModelConfig | null
  userText?: string
  assistantText?: string
  occurredAt?: number
  instruction?: string
  processedTurnId?: string
  recentExchanges?: AgentMemoryConversationExchange[]
  feedbackSamples?: AgentFeedbackMemorySample[]
  recordFailure?: boolean
  onPreview?: (entries: AgentMemoryEntryDraft[]) => void
}): Promise<AgentMemorySynthesisResult> {
  if (!modelIsConfigured(options.modelConfig)) {
    const error = '当前没有可用的 AI 模型配置，无法更新记忆摘要'
    return {
      success: false,
      error,
      summary: options.recordFailure === false ? agentMemoryStore.getSummary() : agentMemoryStore.recordReviewFailure(error),
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = agentMemoryStore.getSummary()
    if (!snapshot.enabled) return { success: true, skipped: true, summary: snapshot }
    if (options.processedTurnId && agentMemoryStore.hasProcessedTurn(options.processedTurnId)) {
      return { success: true, skipped: true, summary: snapshot }
    }
    try {
      const generatedOperations = await generatePatch({
        ...options,
        modelConfig: options.modelConfig,
        snapshot,
      })
      const eligibleGeneratedOperations = options.mode === 'feedback'
        ? generatedOperations.filter((operation) => operation.op !== 'delete')
        : generatedOperations
      const filtered = options.mode === 'instruction'
        ? { accepted: eligibleGeneratedOperations.slice(0, 12), rejected: [] }
        : filterAutomaticMemoryPatch(eligibleGeneratedOperations, options.mode === 'refresh' ? 6 : 2)
      const operations = filtered.accepted as AgentMemoryEntryPatchOperation[]
      const diagnostics: NonNullable<AgentMemorySynthesisResult['diagnostics']> = {
        generatedOperationCount: generatedOperations.length,
        acceptedOperationCount: operations.length,
        rejected: filtered.rejected.map(({ entry, issues }) => ({ title: entry.title, issues })),
      }
      const applied = agentMemoryStore.applyEntryPatch(operations, {
        expectedRevision: snapshot.revision,
        processedTurnId: options.processedTurnId,
      })
      if (applied.conflict) continue
      return { success: true, changed: applied.changed, summary: applied.snapshot, diagnostics }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '记忆更新失败')
      return {
        success: false,
        error: message,
        summary: options.recordFailure === false ? agentMemoryStore.getSummary() : agentMemoryStore.recordReviewFailure(message),
      }
    }
  }
  const error = '记忆在更新期间发生了变化，请重试'
  return { success: false, error, summary: agentMemoryStore.recordReviewFailure(error) }
}

export async function synthesizeAgentMemoryFromFeedback(options: {
  evidence: AgentFeedbackMemoryEvidence
  modelConfig?: AgentModelConfig | null
}): Promise<AgentMemorySynthesisResult> {
  if (!options.evidence.eligible || !options.evidence.fingerprint || options.evidence.samples.length < 3) {
    return { success: true, skipped: true, summary: agentMemoryStore.getSummary() }
  }
  return applyModelUpdate({
    mode: 'feedback',
    modelConfig: options.modelConfig,
    feedbackSamples: options.evidence.samples,
    processedTurnId: `feedback-${options.evidence.fingerprint}`,
    recordFailure: false,
  })
}

export async function synthesizeAgentMemoryFromConversation(options: {
  messages: unknown[]
  assistantAnswer?: string
  occurredAt?: number
  modelConfig?: AgentModelConfig | null
  turnId: string
  recentExchanges?: AgentMemoryConversationExchange[]
}): Promise<AgentMemorySynthesisResult> {
  const userText = latestUserText(Array.isArray(options.messages) ? options.messages : [])
  if (!userText) return { success: true, skipped: true, summary: agentMemoryStore.getSummary() }
  return applyModelUpdate({
    mode: 'conversation',
    modelConfig: options.modelConfig,
    userText,
    assistantText: options.assistantAnswer,
    occurredAt: options.occurredAt,
    recentExchanges: options.recentExchanges,
    processedTurnId: String(options.turnId || '').trim() || undefined,
  })
}

export async function reviseAgentMemorySummary(options: {
  instruction: string
  modelConfig?: AgentModelConfig | null
  processedTurnId?: string
  onPreview?: (entries: AgentMemoryEntryDraft[]) => void
}): Promise<AgentMemorySynthesisResult> {
  const instruction = text(options.instruction).slice(0, 2_000)
  if (!instruction) return { success: false, error: '请输入希望记忆如何修改' }
  return applyModelUpdate({
    mode: 'instruction',
    modelConfig: options.modelConfig,
    instruction,
    processedTurnId: text(options.processedTurnId).slice(0, 180) || undefined,
    onPreview: options.onPreview,
  })
}

export async function refreshAgentMemorySummary(options: {
  modelConfig?: AgentModelConfig | null
  recentExchanges?: AgentMemoryConversationExchange[]
  onPreview?: (entries: AgentMemoryEntryDraft[]) => void
}): Promise<AgentMemorySynthesisResult> {
  const existing = agentMemoryStore.getSummary()
  if (existing.enabled && existing.needsRebuild && existing.entries.length > 0) {
    const retained = filterAutomaticMemoryEntries(existing.entries).accepted
    agentMemoryStore.replaceEntries(retained, { expectedRevision: existing.revision })
  }
  const exchanges = Array.isArray(options.recentExchanges) ? options.recentExchanges : []
  const batches = exchanges.length > 0
    ? Array.from({ length: Math.ceil(exchanges.length / 16) }, (_, index) => exchanges.slice(index * 16, index * 16 + 16))
    : [[]]
  let latest: AgentMemorySynthesisResult | null = null
  let changed = false
  const diagnostics: NonNullable<AgentMemorySynthesisResult['diagnostics']> = {
    generatedOperationCount: 0,
    acceptedOperationCount: 0,
    rejected: [],
  }
  for (const batch of batches) {
    const result = await applyModelUpdate({
      mode: 'refresh',
      modelConfig: options.modelConfig,
      recentExchanges: batch,
      onPreview: options.onPreview,
    })
    latest = result
    changed ||= result.changed === true
    if (result.diagnostics) {
      diagnostics.generatedOperationCount += result.diagnostics.generatedOperationCount
      diagnostics.acceptedOperationCount += result.diagnostics.acceptedOperationCount
      diagnostics.rejected.push(...result.diagnostics.rejected)
    }
    if (!result.success) return { ...result, changed, diagnostics }
  }
  return { ...latest!, changed, diagnostics }
}
