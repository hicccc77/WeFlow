export function isAgentEligibleSession(sessionId?: string, selfAccountId?: string): boolean {
  const id = String(sessionId || '').trim()
  if (!id || id === String(selfAccountId || '').trim()) return false
  return !id.endsWith('@chatroom') && !id.startsWith('gh_')
}
