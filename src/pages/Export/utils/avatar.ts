/**
 * ExportV2 — Avatar utility functions
 * Pure functions for avatar URL normalization, caching logic, and merge operations.
 */

import type { ContactInfo } from '../../../types/models'
import type * as configService from '../../../services/config'
import { INLINE_AVATAR_CACHE_MAX_LENGTH } from '../constants'

// ─── URL normalization ───────────────────────────────────────

export const normalizeExportAvatarUrl = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  if (lower === 'null' || lower === 'undefined') return undefined
  return normalized
}

export const shouldPersistExportAvatarUrl = (value?: string | null): value is string => {
  const normalized = normalizeExportAvatarUrl(value)
  if (!normalized) return false
  if (!normalized.startsWith('data:')) return true
  return normalized.length <= INLINE_AVATAR_CACHE_MAX_LENGTH
}

// ─── Contact map from caches ─────────────────────────────────

export const toContactMapFromCaches = (
  contacts: configService.ContactsListCacheContact[],
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
): Record<string, ContactInfo> => {
  const map: Record<string, ContactInfo> = {}
  for (const contact of contacts || []) {
    if (!contact?.username) continue
    const cachedAvatarUrl = avatarEntries[contact.username]?.avatarUrl
    map[contact.username] = {
      ...contact,
      avatarUrl: shouldPersistExportAvatarUrl(cachedAvatarUrl) ? cachedAvatarUrl : undefined
    }
  }
  return map
}

// ─── Avatar cache compaction ─────────────────────────────────

export const compactExportAvatarEntries = (
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
): {
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
  changed: boolean
} => {
  const nextCache: Record<string, configService.ContactsAvatarCacheEntry> = {}
  let changed = false
  for (const [username, entry] of Object.entries(avatarEntries || {})) {
    const normalizedUsername = String(username || '').trim()
    const avatarUrl = normalizeExportAvatarUrl(entry?.avatarUrl)
    if (!normalizedUsername || !shouldPersistExportAvatarUrl(avatarUrl)) {
      changed = true
      continue
    }
    nextCache[normalizedUsername] = {
      avatarUrl,
      updatedAt: Number(entry?.updatedAt || 0) || Date.now(),
      checkedAt: Number(entry?.checkedAt || 0) || Date.now()
    }
    if (
      normalizedUsername !== username ||
      avatarUrl !== entry?.avatarUrl ||
      nextCache[normalizedUsername].updatedAt !== entry?.updatedAt ||
      nextCache[normalizedUsername].checkedAt !== entry?.checkedAt
    ) {
      changed = true
    }
  }
  return { avatarEntries: nextCache, changed }
}

// ─── Merge avatar cache into contacts ────────────────────────

export const mergeAvatarCacheIntoContacts = (
  sourceContacts: ContactInfo[],
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
): ContactInfo[] => {
  if (!sourceContacts.length || Object.keys(avatarEntries).length === 0) {
    return sourceContacts
  }

  let changed = false
  const merged = sourceContacts.map((contact) => {
    const cachedAvatar = avatarEntries[contact.username]?.avatarUrl
    if (!shouldPersistExportAvatarUrl(cachedAvatar) || contact.avatarUrl) {
      return contact
    }
    changed = true
    return {
      ...contact,
      avatarUrl: cachedAvatar
    }
  })

  return changed ? merged : sourceContacts
}

// ─── Upsert avatar cache from contacts ───────────────────────

export const upsertAvatarCacheFromContacts = (
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>,
  sourceContacts: ContactInfo[],
  options?: { prune?: boolean; markCheckedUsernames?: string[]; now?: number }
): {
  avatarEntries: Record<string, configService.ContactsAvatarCacheEntry>
  changed: boolean
  updatedAt: number | null
} => {
  const compactedCache = compactExportAvatarEntries(avatarEntries)
  const nextCache = { ...compactedCache.avatarEntries }
  const now = options?.now || Date.now()
  const markCheckedSet = new Set((options?.markCheckedUsernames || []).filter(Boolean))
  const usernamesInSource = new Set<string>()
  let changed = compactedCache.changed

  for (const contact of sourceContacts) {
    const username = String(contact.username || '').trim()
    if (!username) continue
    usernamesInSource.add(username)
    const prev = nextCache[username]
    const avatarUrl = normalizeExportAvatarUrl(contact.avatarUrl)
    if (!shouldPersistExportAvatarUrl(avatarUrl)) continue
    const updatedAt = !prev || prev.avatarUrl !== avatarUrl ? now : prev.updatedAt
    const checkedAt = markCheckedSet.has(username) ? now : (prev?.checkedAt || now)
    if (!prev || prev.avatarUrl !== avatarUrl || prev.updatedAt !== updatedAt || prev.checkedAt !== checkedAt) {
      nextCache[username] = { avatarUrl, updatedAt, checkedAt }
      changed = true
    }
  }

  for (const username of markCheckedSet) {
    const prev = nextCache[username]
    if (!prev) continue
    if (prev.checkedAt !== now) {
      nextCache[username] = { ...prev, checkedAt: now }
      changed = true
    }
  }

  if (options?.prune) {
    for (const username of Object.keys(nextCache)) {
      if (usernamesInSource.has(username)) continue
      delete nextCache[username]
      changed = true
    }
  }

  return {
    avatarEntries: nextCache,
    changed,
    updatedAt: changed ? now : null
  }
}
