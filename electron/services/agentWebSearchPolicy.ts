import type { AgentToolSource } from './agentToolCatalog'

const DIRECT_WEB_REFERENCE_PATTERN = /(?:联网|上网|网页|网站|官网|官方网站|浏览器|google|谷歌|bing|必应|百度)/i
const SEARCH_REQUEST_PATTERN = /(?:搜搜看|搜一搜|搜一下|搜索(?:一下|看看|下)?|查查(?:看)?|查一下)/i
const LOCAL_DATA_REFERENCE_PATTERN = /(?:聊天(?:记录)?|消息(?:记录)?|朋友圈|联系人|会话|本地(?:数据|记录)?)/i
const SOURCE_VERIFICATION_PATTERN = /(?:出自(?:哪|哪里|何处|什么)|出处|原文来源|原句来源|最早(?:出处|来源|发布)|是否(?:真的)?(?:出自|来自)|真伪|误传|误署)/i
const TIME_SENSITIVE_PATTERN = /(?:最新|实时|截至(?:现在|目前|今日|今天)|今天|今日|当前).{0,12}(?:新闻|消息|进展|价格|行情|数据|版本|政策|规定|规则|赛程|比分|天气)/i

export function explicitlyRequestsWebSearch(value: unknown): boolean {
  const question = String(value || '').trim()
  if (!question) return false
  if (DIRECT_WEB_REFERENCE_PATTERN.test(question)) return true
  if (SOURCE_VERIFICATION_PATTERN.test(question)) return true
  if (TIME_SENSITIVE_PATTERN.test(question)) return true
  if (LOCAL_DATA_REFERENCE_PATTERN.test(question)) return false
  return SEARCH_REQUEST_PATTERN.test(question)
}

export function shouldRequireAgentWebSearch(
  source: AgentToolSource,
  question: unknown,
  searchToolName?: string | null,
): boolean {
  if (!String(searchToolName || '').trim()) return false
  if (source === 'web') return true
  return source === 'auto' && explicitlyRequestsWebSearch(question)
}
