function normalize(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, 1_200).toLocaleLowerCase()
}

function searchTerms(value: string): string[] {
  const normalized = normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const words = normalized.split(/\s+/).filter((item) => item.length >= 2)
  const compact = normalized.replace(/\s+/g, '')
  const bigrams: string[] = []
  for (let index = 0; index < compact.length - 1 && bigrams.length < 24; index += 1) {
    bigrams.push(compact.slice(index, index + 2))
  }
  return Array.from(new Set([...words, ...bigrams]))
}

export type AgentMemoryRelevance = {
  score: number
  exact: boolean
  matchedTerms: string[]
}

/**
 * 用精确包含、长词命中和双字覆盖率计算保守的词面相关度。
 * 该分数只用于召回排序，不能作为记忆内容真实或语义相关的证明。
 */
export function agentMemoryRelevance(query: string, memoryText: string): AgentMemoryRelevance {
  const normalizedQuery = normalize(query)
  const normalizedMemory = normalize(memoryText)
  if (!normalizedQuery || !normalizedMemory) return { score: 0, exact: false, matchedTerms: [] }

  const compactQuery = normalizedQuery.replace(/[^\p{L}\p{N}]+/gu, '')
  const compactMemory = normalizedMemory.replace(/[^\p{L}\p{N}]+/gu, '')
  const exact = compactQuery.length >= 2 && compactMemory.includes(compactQuery)
  if (exact) return { score: 1, exact: true, matchedTerms: [compactQuery] }

  const terms = searchTerms(normalizedQuery)
  const matchedTerms = terms.filter((term) => normalizedMemory.includes(term))
  const longMatches = matchedTerms.filter((term) => term.length >= 3)
  const queryBigrams = terms.filter((term) => term.length === 2)
  const matchedBigrams = matchedTerms.filter((term) => term.length === 2)
  const requiredBigramMatches = Math.max(2, Math.ceil(queryBigrams.length * 0.22))
  if (longMatches.length === 0 && matchedBigrams.length < requiredBigramMatches) {
    return { score: 0, exact: false, matchedTerms }
  }

  const bigramCoverage = queryBigrams.length > 0 ? matchedBigrams.length / queryBigrams.length : 0
  const distinctiveCoverage = terms.length > 0 ? longMatches.length / terms.length : 0
  return {
    score: Math.min(0.99, bigramCoverage * 0.72 + distinctiveCoverage * 0.28),
    exact: false,
    matchedTerms,
  }
}
