export function buildGroupNicknameIdCandidates(values: Array<string | undefined | null>): string[] {
  const set = new Set<string>()
  for (const rawValue of values) {
    const raw = String(rawValue || '').trim()
    if (!raw) continue
    set.add(raw)
  }
  return Array.from(set)
}

export function normalizeGroupNicknameIdentity(value: string): string {
  return String(value || '').trim().toLowerCase()
}

export function normalizeGroupNickname(value: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed) return ''
  const cleaned = trimmed.replace(/[\x00-\x1F\x7F]/g, '')
  if (!cleaned) return ''
  if (/^[,"'“”‘’，、]+$/.test(cleaned)) return ''
  return cleaned
}

export function resolveGroupNicknameByCandidates(groupNicknamesMap: Map<string, string>, candidates: Array<string | undefined | null>): string {
  const idCandidates = buildGroupNicknameIdCandidates(candidates)
  if (idCandidates.length === 0) return ''

  for (const id of idCandidates) {
    const normalizedId = normalizeGroupNicknameIdentity(id)
    if (!normalizedId) continue
    const candidateNickname = normalizeGroupNickname(groupNicknamesMap.get(normalizedId) || '')
    if (!candidateNickname) continue
    return candidateNickname
  }

  return ''
}
