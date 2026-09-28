export interface ContactSnsTimelineTarget {
  username: string
  displayName: string
  avatarUrl?: string
}

export interface ContactSnsRankItem {
  name: string
  count: number
  latestTime: number
}

export type ContactSnsRankMode = 'likes' | 'comments'

export const isSingleContactSession = (sessionId: string): boolean => {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return false
  if (normalized.includes('@chatroom')) return false
  if (normalized.startsWith('gh_')) return false
  return true
}

export const getAvatarLetter = (name: string): string => {
  if (!name) return '?'
  return [...name][0] || '?'
}
