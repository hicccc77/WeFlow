const SEARCH_TIMEOUT_MS = 10_000
const MAX_SEARCH_RESPONSE_BYTES = 1_500_000
const MAX_QUERY_VARIANTS = 2

export type WebSearchEngine = 'bing' | 'duckduckgo'

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  domain: string
  relevanceScore: number
  matchedTerms: string[]
}

export type WebSearchAttempt = {
  engine: WebSearchEngine
  query: string
  parsedCount: number
  acceptedCount: number
  error?: string
}

export type WebSearchResponse = {
  success: true
  query: string
  engine: 'weflow'
  engines: WebSearchEngine[]
  executedQueries: string[]
  searchedAt: string
  quality: 'exact' | 'relevant' | 'limited'
  results: WebSearchResult[]
  count: number
  attempts: WebSearchAttempt[]
  note: string
}

type ParsedWebSearchResult = Omit<WebSearchResult, 'relevanceScore' | 'matchedTerms'>

type SearchRelevanceProfile = {
  compactFocus: string
  exactPhrases: string[]
  terms: string[]
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

const SEARCH_PREFIX_PATTERN = /^(?:(?:请|麻烦)?(?:帮我)?(?:联网|上网|在网上|网页)?(?:搜索|搜搜看|搜一搜|搜一下|搜|查找|查查|查一下|查询)\s*)+/i
const SEARCH_SUFFIX_PATTERN = /(?:的)?(?:准确|具体|真正|最早)?(?:出处|来源|原文来源|原句来源|是哪来的|来自哪里|出自哪里)(?:并)?(?:给出|附上|提供)?(?:可核验|可靠|真实)?(?:来源|链接|证据)?[。.!！?？\s]*$/i
const TRACKING_QUERY_PARAMETER = /^(?:utm_.+|spm|from|ref|referrer|source|campaign|ved|ei)$/i

function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hexadecimal = entity[1]?.toLowerCase() === 'x'
      const parsed = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : match
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function plainText(value: string): string {
  return decodeHtml(value)
    .replace(/<!\[CDATA\[|\]\]>/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tagContent(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
  return match?.[1] || ''
}

function normalizeResultUrl(value: string): string | null {
  try {
    const decoded = decodeHtml(value).trim()
    const absolute = decoded.startsWith('//') ? `https:${decoded}` : decoded
    const url = new URL(absolute)
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg')
      if (target) return normalizeResultUrl(target)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (TRACKING_QUERY_PARAMETER.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return null
  }
}

function toResult(title: string, urlValue: string, snippet: string): ParsedWebSearchResult | null {
  const url = normalizeResultUrl(urlValue)
  if (!url) return null
  return {
    title: plainText(title) || new URL(url).hostname,
    url,
    snippet: plainText(snippet).slice(0, 700),
    domain: new URL(url).hostname.replace(/^www\./i, ''),
  }
}

function uniqueParsedResults(results: Array<ParsedWebSearchResult | null>, limit: number): ParsedWebSearchResult[] {
  const output: ParsedWebSearchResult[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (!result || seen.has(result.url)) continue
    seen.add(result.url)
    output.push(result)
    if (output.length >= limit) break
  }
  return output
}

export function parseBingRss(value: string, limit: number): ParsedWebSearchResult[] {
  const items = value.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []
  return uniqueParsedResults(items.map((item) => toResult(
    tagContent(item, 'title'),
    plainText(tagContent(item, 'link')),
    tagContent(item, 'description'),
  )), limit)
}

export function parseDuckDuckGoHtml(value: string, limit: number): ParsedWebSearchResult[] {
  const blocks = value.match(/<(?:div|article)\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>[\s\S]*?(?=<(?:div|article)\b[^>]*class=["'][^"']*\bresult\b|$)/gi) || []
  const blockResults = blocks.map((block) => {
    const link = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) return null
    const snippet = /<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block)?.[1] || ''
    return toResult(link[2], link[1], snippet)
  })
  if (blockResults.some(Boolean)) return uniqueParsedResults(blockResults, limit)

  const links = Array.from(value.matchAll(
    /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/gi,
  ))
  return uniqueParsedResults(links.map((match) => {
    const afterLink = value.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 5_000)
    const snippet = /<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(afterLink)?.[1] || ''
    return toResult(match[2], match[1], snippet)
  }), limit)
}

function compactComparable(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, '')
}

function normalizeQuoteMarks(value: string): string {
  return value.replace(/[“”‘’「」『』]/g, '"')
}

function quotedPhrases(value: string): string[] {
  const normalized = normalizeQuoteMarks(value)
  return Array.from(normalized.matchAll(/"([^"\r\n]{2,180})"/g))
    .map((match) => plainText(match[1]))
    .filter(Boolean)
}

function stripSearchInstructions(value: string): string {
  return normalizeQuoteMarks(value)
    .replace(SEARCH_PREFIX_PATTERN, '')
    .replace(SEARCH_SUFFIX_PATTERN, '')
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)))
}

function cjkNgrams(value: string): string[] {
  const output: string[] = []
  for (const chunk of value.match(/[\p{Script=Han}]{2,}/gu) || []) {
    if (chunk.length <= 3) {
      output.push(chunk)
      continue
    }
    for (let index = 0; index <= chunk.length - 3; index += 1) output.push(chunk.slice(index, index + 3))
  }
  return output
}

function relevanceTerms(value: string): string[] {
  const latinAndNumbers = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu) || []
  const nonHan = latinAndNumbers.filter((token) => !/^[\p{Script=Han}]+$/u.test(token))
  return uniqueStrings([...nonHan, ...cjkNgrams(value)]).slice(0, 80)
}

function createRelevanceProfile(query: string): SearchRelevanceProfile {
  const phrases = quotedPhrases(query)
  const focus = phrases[0] || stripSearchInstructions(query) || query
  const exactPhrases = uniqueStrings((phrases.length > 0 ? phrases : [focus])
    .map(compactComparable)
    .filter((phrase) => phrase.length >= 4))
  return {
    compactFocus: compactComparable(focus),
    exactPhrases,
    terms: relevanceTerms(focus),
  }
}

function scoreResult(result: ParsedWebSearchResult, profile: SearchRelevanceProfile): WebSearchResult | null {
  const title = compactComparable(result.title)
  const haystack = compactComparable(`${result.title} ${result.snippet} ${result.domain}`)
  const exactMatches = profile.exactPhrases.filter((phrase) => haystack.includes(phrase))
  const matchedTerms = profile.terms.filter((term) => haystack.includes(compactComparable(term)))
  const titleMatches = profile.terms.filter((term) => title.includes(compactComparable(term)))
  const coverage = profile.terms.length > 0 ? matchedTerms.length / profile.terms.length : 0
  const titleCoverage = profile.terms.length > 0 ? titleMatches.length / profile.terms.length : 0
  const focusMatch = profile.compactFocus.length >= 4 && haystack.includes(profile.compactFocus)
  const score = Math.round(
    (exactMatches.length > 0 || focusMatch ? 100 : 0)
    + coverage * 70
    + titleCoverage * 30,
  )
  const enoughTermOverlap = profile.terms.length <= 2
    ? matchedTerms.length >= 1
    : matchedTerms.length >= 2 && coverage >= 0.16
  if (!focusMatch && exactMatches.length === 0 && !enoughTermOverlap) return null
  return {
    ...result,
    relevanceScore: score,
    matchedTerms: uniqueStrings([...exactMatches, ...matchedTerms]).slice(0, 10),
  }
}

export function rankWebSearchResults(
  query: string,
  results: ParsedWebSearchResult[],
  limit: number,
): WebSearchResult[] {
  const profile = createRelevanceProfile(query)
  const unique = uniqueParsedResults(results, Math.max(limit * 6, 30))
  return unique
    .map((result) => scoreResult(result, profile))
    .filter((result): result is WebSearchResult => Boolean(result))
    .sort((left, right) => right.relevanceScore - left.relevanceScore || left.title.localeCompare(right.title, 'zh-CN'))
    .slice(0, limit)
}

export function buildWebSearchQueryVariants(value: unknown): string[] {
  const query = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!query) return []
  const phrases = quotedPhrases(query)
  const focus = phrases[0] || stripSearchInstructions(query) || query
  const looksLikeQuotation = phrases.length > 0 || /[，。！？；：,!?;:]/.test(focus)
  const variants = looksLikeQuotation && focus.length <= 180
    ? [`"${focus.replace(/"/g, '')}"`, `${focus} 出处`]
    : [query, focus]
  return uniqueStrings(variants).slice(0, MAX_QUERY_VARIANTS)
}

export function normalizeWebSearchQuerySignature(value: unknown): string {
  const variants = buildWebSearchQueryVariants(value)
  return compactComparable(variants[0] || String(value || ''))
}

async function fetchSearchPage(url: URL, parentSignal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abort()
  else parentSignal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('联网搜索超时')), SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WeFlow/5.0',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > MAX_SEARCH_RESPONSE_BYTES) throw new Error('搜索响应过大')
    const data = await response.arrayBuffer()
    if (data.byteLength > MAX_SEARCH_RESPONSE_BYTES) throw new Error('搜索响应过大')
    const page = new TextDecoder().decode(data)
    if (/captcha|unusual traffic|verify you are human|异常流量|人机验证/i.test(page)) {
      throw new Error('搜索引擎要求人机验证')
    }
    return page
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abort)
  }
}

async function queryEngine(
  engine: WebSearchEngine,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ParsedWebSearchResult[]> {
  if (engine === 'bing') {
    const url = new URL('https://www.bing.com/search')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'rss')
    url.searchParams.set('setlang', 'zh-Hans')
    return parseBingRss(await fetchSearchPage(url, signal), limit)
  }
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  return parseDuckDuckGoHtml(await fetchSearchPage(url, signal), limit)
}

export async function searchWeb(
  input: { query: string; limit?: number },
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  const query = String(input.query || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!query) throw new Error('联网搜索词不能为空')
  const limit = Math.max(1, Math.min(Math.floor(Number(input.limit) || 6), 8))
  const variants = buildWebSearchQueryVariants(query)
  const attempts: WebSearchAttempt[] = []
  const candidates: ParsedWebSearchResult[] = []
  const engines: WebSearchEngine[] = ['bing', 'duckduckgo']
  let ranked: WebSearchResult[] = []

  for (const variant of variants) {
    const settled = await Promise.allSettled(engines.map(async (engine) => ({
      engine,
      results: await queryEngine(engine, variant, Math.max(limit * 3, 12), signal),
    })))
    for (let index = 0; index < settled.length; index += 1) {
      const engine = engines[index]
      const outcome = settled[index]
      if (outcome.status === 'rejected') {
        attempts.push({
          engine,
          query: variant,
          parsedCount: 0,
          acceptedCount: 0,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
        continue
      }
      candidates.push(...outcome.value.results)
      const accepted = rankWebSearchResults(query, outcome.value.results, limit)
      attempts.push({
        engine,
        query: variant,
        parsedCount: outcome.value.results.length,
        acceptedCount: accepted.length,
      })
    }
    ranked = rankWebSearchResults(query, candidates, limit)
    if (ranked.some((result) => result.relevanceScore >= 100) || ranked.length >= Math.min(3, limit)) break
  }

  if (ranked.length === 0) {
    const errors = attempts
      .filter((attempt) => attempt.error)
      .map((attempt) => `${attempt.engine}: ${attempt.error}`)
    const parsedCount = attempts.reduce((sum, attempt) => sum + attempt.parsedCount, 0)
    const detail = errors.length > 0
      ? errors.join('；')
      : parsedCount > 0
        ? `解析到 ${parsedCount} 条页面，但均未通过与查询内容的相关性校验`
        : '搜索引擎没有返回可解析结果'
    throw new Error(`联网搜索暂时没有可靠结果（${detail.slice(0, 360)}）`)
  }

  const quality = ranked.some((result) => result.relevanceScore >= 100)
    ? 'exact'
    : ranked.length >= 3
      ? 'relevant'
      : 'limited'
  return {
    success: true,
    query,
    engine: 'weflow',
    engines: uniqueStrings(attempts.filter((attempt) => attempt.parsedCount > 0).map((attempt) => attempt.engine)) as WebSearchEngine[],
    executedQueries: uniqueStrings(attempts.map((attempt) => attempt.query)),
    searchedAt: new Date().toISOString(),
    quality,
    results: ranked,
    count: ranked.length,
    attempts,
    note: quality === 'limited'
      ? '只找到少量通过相关性校验的结果；请明确限定结论。除非需要核对不同事实，不要只改写同一查询反复搜索。'
      : '单次调用已完成查询变体、双引擎合并、去重和相关性校验。exact 只表示页面文字精确命中，不代表其中的出处或事实已经权威核实；如结果主要来自问答或转载页，可用至多一次不同查询核对候选事实，否则请基于现有结果回答，不要只改写措辞重复搜索。',
  }
}
