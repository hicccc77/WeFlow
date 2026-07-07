/**
 * ExportV2 — Session utility functions
 * Pure functions for session classification, sorting, and merging.
 */

import type { ChatSession as AppChatSession, ContactInfo } from '../../../types/models'
import type { ConversationTab, DisplayNamePreference, SessionRow } from '../types'
import { displayNameOrFallback, pickDisplayName } from '../../../utils/displayName'

// ─── Session type classification ─────────────────────────────

export const toKindByContactType = (session: AppChatSession, contact?: ContactInfo): ConversationTab => {
  if (session.username.endsWith('@chatroom')) return 'group'
  if (session.username.startsWith('gh_')) return 'official'
  if (contact?.type === 'official') return 'official'
  if (contact?.type === 'former_friend') return 'former_friend'
  return 'private'
}

export const toKindByContact = (contact: ContactInfo): ConversationTab => {
  if (contact.type === 'group') return 'group'
  if (contact.type === 'official') return 'official'
  if (contact.type === 'former_friend') return 'former_friend'
  return 'private'
}

// ─── Session filtering predicates ────────────────────────────

export const isContentScopeSession = (session: SessionRow): boolean =>
  session.kind === 'private' || session.kind === 'group' || session.kind === 'former_friend'

export const isExportConversationSession = (session: SessionRow): boolean =>
  session.kind === 'private' || session.kind === 'group' || session.kind === 'former_friend'

export const isSingleContactSession = (sessionId: string): boolean => {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return false
  if (normalized.includes('@chatroom')) return false
  if (normalized.startsWith('gh_')) return false
  return true
}

export const matchesContactTab = (contact: ContactInfo, tab: ConversationTab): boolean => {
  if (tab === 'private') return contact.type === 'friend'
  if (tab === 'group') return contact.type === 'group'
  if (tab === 'official') return contact.type === 'official'
  return contact.type === 'former_friend'
}

// ─── Build session rows from sessions + contacts ─────────────

export const toSessionRowsWithContacts = (
  sessions: AppChatSession[],
  contactMap: Record<string, ContactInfo>
): SessionRow[] => {
  const sessionMap = new Map<string, AppChatSession>()
  for (const session of sessions || []) {
    sessionMap.set(session.username, session)
  }

  const contacts = Object.values(contactMap)
    .filter((contact) => (
      contact.type === 'friend' ||
      contact.type === 'group' ||
      contact.type === 'official' ||
      contact.type === 'former_friend'
    ))

  if (contacts.length > 0) {
    return contacts
      .map((contact) => {
        const session = sessionMap.get(contact.username)
        const latestTs = session?.sortTimestamp || session?.lastTimestamp || 0
        return {
          ...(session || {
            username: contact.username,
            type: 0,
            unreadCount: 0,
            summary: '',
            sortTimestamp: latestTs,
            lastTimestamp: latestTs,
            lastMsgType: 0
          }),
          username: contact.username,
          kind: toKindByContact(contact),
          wechatId: contact.username,
          displayName: displayNameOrFallback(contact.username, contact.displayName, session?.displayName),
          avatarUrl: session?.avatarUrl || contact.avatarUrl,
          remark: contact.remark,
          nickname: contact.nickname,
          hasSession: Boolean(session)
        } as SessionRow
      })
      .sort((a, b) => {
        const latestA = a.sortTimestamp || a.lastTimestamp || 0
        const latestB = b.sortTimestamp || b.lastTimestamp || 0
        if (latestA !== latestB) return latestB - latestA
        return displayNameOrFallback(a.username, a.displayName).localeCompare(displayNameOrFallback(b.username, b.displayName), 'zh-Hans-CN')
      })
  }

  return sessions
    .map((session) => {
      const contact = contactMap[session.username]
      return {
        ...session,
        kind: toKindByContactType(session, contact),
        wechatId: contact?.username || session.username,
        displayName: displayNameOrFallback(session.username, contact?.displayName, session.displayName),
        avatarUrl: session.avatarUrl || contact?.avatarUrl,
        remark: contact?.remark,
        nickname: contact?.nickname,
        hasSession: true
      } as SessionRow
    })
    .sort((a, b) => (b.sortTimestamp || b.lastTimestamp || 0) - (a.sortTimestamp || a.lastTimestamp || 0))
}

// ─── Array equality check ────────────────────────────────────

export const areStringArraysEqual = (left: string[], right: string[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export const getSelectionScopeFromRows = (rows: SessionRow[]): import('../types').TaskScope => {
  if (rows.length === 0) return 'single'
  if (rows.length === 1) return 'single'
  return 'multi'
}

export const resolveScopeDisplayNames = (
  rows: SessionRow[], 
  pref: DisplayNamePreference
): string[] => {
  return rows.map(r => {
    if (pref === 'nickname') return displayNameOrFallback(r.username, r.nickname, r.remark, r.displayName)
    return displayNameOrFallback(r.username, r.remark, r.nickname, r.displayName)
  })
}

// ─── Name comparison helper ──────────────────────────────────

export const toComparableNameSet = (values: Array<string | undefined | null>): Set<string> => {
  const set = new Set<string>()
  for (const value of values) {
    const normalized = pickDisplayName(value)?.trim() || ''
    if (!normalized) continue
    set.add(normalized)
  }
  return set
}
