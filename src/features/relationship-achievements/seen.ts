const STORAGE_PREFIX = 'weflow.relationship-achievements.seen.v1'

const stableHash = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const storageKey = (sessionId: string, accountScope?: string): string =>
  `${STORAGE_PREFIX}.${stableHash(`${String(accountScope || '').trim()}:${String(sessionId || '').trim()}`)}`

export const readSeenRelationshipAchievementIds = (
  sessionId: string,
  accountScope?: string
): Set<string> => {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId, accountScope))
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export const markRelationshipAchievementIdsSeen = (
  sessionId: string,
  achievementIds: string[],
  accountScope?: string
): void => {
  if (typeof window === 'undefined' || achievementIds.length === 0) return
  try {
    const key = storageKey(sessionId, accountScope)
    const current = readSeenRelationshipAchievementIds(sessionId, accountScope)
    achievementIds.forEach((id) => current.add(id))
    window.localStorage.setItem(key, JSON.stringify(Array.from(current)))
  } catch {
    // Discovery history is a progressive enhancement; storage failures must not block the page.
  }
}
