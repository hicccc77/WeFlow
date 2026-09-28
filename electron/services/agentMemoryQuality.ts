export type AgentMemoryQualityEntry = {
  title: string
  detail: string
  category: string
}

export type AgentMemoryQualityIssue =
  | 'non_operational_category'
  | 'episodic_time_anchor'
  | 'quoted_source_material'
  | 'timeline_narrative'
  | 'numeric_detail_density'
  | 'profile_framing'
  | 'missing_ai_guidance'
  | 'multi_paragraph_detail'
  | 'excessive_detail'

export type AgentMemoryQualityRejection<T> = {
  entry: T
  issues: AgentMemoryQualityIssue[]
}

export type AgentMemoryQualityPatchOperation<T extends AgentMemoryQualityEntry = AgentMemoryQualityEntry> =
  | { op: 'add'; entry: T }
  | { op: 'update'; targetId: string; entry: T }
  | { op: 'delete'; targetId: string }

const OPERATIONAL_CATEGORIES = new Set([
  'preference',
  'project',
  'communication',
  'goal',
])

const AI_GUIDANCE_PATTERN = /(?:AI|Agent|回答|解释|建议|检索|核实|沟通|协作|呈现|表达|追问|引用|区分|避免|优先|应当|应该|需要|可以|不要|不能|适合|希望|偏好|关注)/iu
const ABSOLUTE_DATE_PATTERN = /(?:\b(?:19|20)\d{2}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2}日?)?\b|\b\d{1,2}[-/.月]\d{1,2}日?\b)/u
const CLOCK_TIME_PATTERN = /(?:\b\d{1,2}:\d{2}\b|(?:上午|下午|傍晚|晚上|凌晨)\s*\d{1,2}\s*[点时])/u
// 短术语、指代词和界面文案可以帮助描述触发条件；只有较长引文才像在保存原始聊天。
const QUOTED_MATERIAL_PATTERN = /(?:“[^”\n]{16,}”|"[^"\n]{16,}")/u
const TIMELINE_MARKER_PATTERN = /(?:起初|随后|后来|之后|此前|当时|期间|最终|最后|先是|紧接着)/gu
const PROFILE_TITLE_PATTERN = /^(?:你|用户)(?:的|在|会|有|是|正|曾|习惯|偏好|要求|希望|授权|保存|经常|通常)/u

export function inspectAutomaticMemoryEntry(entry: AgentMemoryQualityEntry): AgentMemoryQualityIssue[] {
  const title = String(entry.title || '').trim()
  const detail = String(entry.detail || '').trim()
  const combined = `${title}\n${detail}`
  const issues: AgentMemoryQualityIssue[] = []

  if (!OPERATIONAL_CATEGORIES.has(String(entry.category || ''))) issues.push('non_operational_category')
  if (ABSOLUTE_DATE_PATTERN.test(combined) || CLOCK_TIME_PATTERN.test(combined)) issues.push('episodic_time_anchor')
  if (QUOTED_MATERIAL_PATTERN.test(combined)) issues.push('quoted_source_material')
  if (Array.from(detail.matchAll(TIMELINE_MARKER_PATTERN)).length >= 2) issues.push('timeline_narrative')
  if (PROFILE_TITLE_PATTERN.test(title)) issues.push('profile_framing')

  const digitCount = Array.from(combined).filter((character) => /\d/u.test(character)).length
  if (digitCount >= 8 || (combined.length > 0 && digitCount / combined.length > 0.06)) {
    issues.push('numeric_detail_density')
  }
  if (!AI_GUIDANCE_PATTERN.test(detail)) issues.push('missing_ai_guidance')
  if (/\n\s*\n/u.test(detail)) issues.push('multi_paragraph_detail')
  if (detail.length > 140) issues.push('excessive_detail')

  return Array.from(new Set(issues))
}

export function filterAutomaticMemoryEntries<T extends AgentMemoryQualityEntry>(entries: T[]): {
  accepted: T[]
  rejected: Array<AgentMemoryQualityRejection<T>>
} {
  const accepted: T[] = []
  const rejected: Array<AgentMemoryQualityRejection<T>> = []
  for (const entry of entries) {
    const issues = inspectAutomaticMemoryEntry(entry)
    if (issues.length === 0) accepted.push(entry)
    else rejected.push({ entry, issues })
  }
  return { accepted, rejected }
}

export function filterAutomaticMemoryPatch<T extends AgentMemoryQualityEntry>(
  operations: Array<AgentMemoryQualityPatchOperation<T>>,
  limit = 2,
): {
  accepted: Array<AgentMemoryQualityPatchOperation<T>>
  rejected: Array<AgentMemoryQualityRejection<T>>
} {
  const accepted: Array<AgentMemoryQualityPatchOperation<T>> = []
  const rejected: Array<AgentMemoryQualityRejection<T>> = []
  for (const operation of operations) {
    if (operation.op === 'delete') {
      accepted.push(operation)
      continue
    }
    const issues = inspectAutomaticMemoryEntry(operation.entry)
    if (issues.length === 0) accepted.push(operation)
    else rejected.push({ entry: operation.entry, issues })
  }
  return { accepted: accepted.slice(0, Math.max(0, limit)), rejected }
}
