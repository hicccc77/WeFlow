/**
 * ExportV2 — useContactsLoader hook
 *
 * Encapsulates the logic for loading contacts from config/cache and network,
 * and performing background avatar enrichment via electron APIs.
 */

import { useState, useRef, useCallback } from 'react'
import type { ContactInfo } from '../../../types/models'
import type { ContactsAvatarCacheEntry } from '../../../services/config'
import * as configService from '../../../services/config'
import {
  toContactMapFromCaches,
  mergeAvatarCacheIntoContacts,
  upsertAvatarCacheFromContacts
} from '../utils/avatar'
import {
  CONTACT_ENRICH_TIMEOUT_MS,
  EXPORT_AVATAR_ENRICH_BATCH_SIZE
} from '../constants'

export interface ContactsLoaderResult {
  contactMap: Record<string, ContactInfo>
  avatarEntries: Record<string, ContactsAvatarCacheEntry>
  isLoading: boolean
  isEnriching: boolean
  dataSource: 'cache' | 'network' | null
  lastUpdatedAt: number
  loadContacts: (scopeKey: string, candidateUsernames?: string[]) => Promise<void>
  abort: () => void
}

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: any
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer))
}

export function useContactsLoader(): ContactsLoaderResult {
  const [contactMap, setContactMap] = useState<Record<string, ContactInfo>>({})
  const [avatarEntries, setAvatarEntries] = useState<Record<string, ContactsAvatarCacheEntry>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [isEnriching, setIsEnriching] = useState(false)
  const [dataSource, setDataSource] = useState<'cache' | 'network' | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(0)

  const abortControllerRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const loadContacts = useCallback(async (scopeKey: string, candidateUsernames?: string[]) => {
    abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const signal = controller.signal

    setIsLoading(true)

    try {
      // 1. Initial async cache load
      const [contactsCache, avatarCache] = await Promise.all([
        configService.getContactsListCache(scopeKey),
        configService.getContactsAvatarCache(scopeKey)
      ])
      
      const cachedContacts = contactsCache?.contacts || []
      const cachedAvatarEntries = avatarCache?.avatars || {}
      
      let currentContactMap = toContactMapFromCaches(cachedContacts, cachedAvatarEntries)
      let currentAvatarEntries = { ...cachedAvatarEntries }

      setContactMap(currentContactMap)
      setAvatarEntries(currentAvatarEntries)
      setDataSource(cachedContacts.length > 0 ? 'cache' : 'network')
      if (cachedContacts.length === 0) {
        setLastUpdatedAt(Date.now())
      }

      setIsLoading(false)

      if (signal.aborted) return

      // 2. Background fetch & enrich
      setIsEnriching(true)

      try {
        const contactsResult = await withTimeout(
          window.electronAPI.chat.getContacts({ lite: true }),
          CONTACT_ENRICH_TIMEOUT_MS
        ).catch(() => null)

        if (signal.aborted) return

        const contactsFromNetwork: ContactInfo[] = contactsResult?.success && contactsResult.contacts
          ? contactsResult.contacts
          : []

        if (contactsFromNetwork.length > 0) {
          const contactsWithCachedAvatar = mergeAvatarCacheIntoContacts(contactsFromNetwork, currentAvatarEntries)
          const nextContactMap = contactsWithCachedAvatar.reduce<Record<string, ContactInfo>>((map, contact) => {
            map[contact.username] = contact
            return map
          }, {})

          for (const [username, cachedContact] of Object.entries(currentContactMap)) {
            if (!nextContactMap[username]) {
              nextContactMap[username] = cachedContact
            }
          }

          currentContactMap = nextContactMap
          setContactMap(currentContactMap)
          setLastUpdatedAt(Date.now())

          // Save to config
          await configService.setContactsListCache(scopeKey, Object.values(currentContactMap).map(c => ({
            username: c.username,
            displayName: c.displayName || '',
            type: c.type || 'other',
            remark: c.remark,
            nickname: c.nickname,
            alias: c.alias,
            labels: c.labels,
            description: c.description,
            detailDescription: c.detailDescription,
            region: c.region
          })))

          const upsertResult = upsertAvatarCacheFromContacts(currentAvatarEntries, Object.values(currentContactMap), {
            prune: true,
            now: Date.now()
          })

          currentAvatarEntries = upsertResult.avatarEntries
          setAvatarEntries(currentAvatarEntries)
          if (upsertResult.changed) {
            await configService.setContactsAvatarCache(scopeKey, currentAvatarEntries)
          }
        }

        if (signal.aborted) return

        // 3. Avatar enrich for missing
        const sourceContacts = Object.values(currentContactMap)
        const sourceByUsername = new Map<string, ContactInfo>()
        for (const contact of sourceContacts) {
          if (!contact?.username) continue
          sourceByUsername.set(contact.username, contact)
        }

        const candidatesToEnrich = candidateUsernames?.length
          ? candidateUsernames
          : sourceContacts.map(c => c.username)

        const needsEnrichment = candidatesToEnrich
          .filter(Boolean)
          .filter((username) => {
            const currentContact = sourceByUsername.get(username)
            return !currentContact?.avatarUrl
          })

        if (needsEnrichment.length > 0) {
          let hasEnrichChanges = false
          let enrichContactMap: Record<string, ContactInfo> = { ...currentContactMap }
          let enrichAvatarEntries = { ...currentAvatarEntries }

          for (let i = 0; i < needsEnrichment.length; i += EXPORT_AVATAR_ENRICH_BATCH_SIZE) {
            if (signal.aborted) break
            const batch = needsEnrichment.slice(i, i + EXPORT_AVATAR_ENRICH_BATCH_SIZE)
            if (batch.length === 0) continue

            const enrichResult = await withTimeout(
              window.electronAPI.chat.enrichSessionsContactInfo(batch, {
                skipDisplayName: true,
                onlyMissingAvatar: true
              }),
              CONTACT_ENRICH_TIMEOUT_MS
            ).catch(() => null)

            if (signal.aborted) break

            if (enrichResult?.success && enrichResult.contacts) {
              const enrichedBatch = enrichResult.contacts as Record<string, { displayName?: string; avatarUrl?: string }>
              let batchChanged = false

              for (const [username, enriched] of Object.entries(enrichedBatch)) {
                if (!enriched.avatarUrl) continue
                enrichContactMap[username] = {
                  ...(enrichContactMap[username] || { username, displayName: username, type: 'other' }),
                  avatarUrl: enriched.avatarUrl
                }
                hasEnrichChanges = true
                batchChanged = true
              }

              if (batchChanged) {
                setContactMap(enrichContactMap)
                const upsertResult = upsertAvatarCacheFromContacts(enrichAvatarEntries, Object.values(enrichContactMap), {
                  now: Date.now()
                })
                if (upsertResult.changed) {
                  enrichAvatarEntries = upsertResult.avatarEntries
                  setAvatarEntries(enrichAvatarEntries)
                  await configService.setContactsAvatarCache(scopeKey, enrichAvatarEntries)
                }
              }
            }
          }

          if (hasEnrichChanges && !signal.aborted) {
            await configService.setContactsListCache(scopeKey, Object.values(enrichContactMap).map(c => ({
              username: c.username,
              displayName: c.displayName || '',
              type: c.type || 'other',
              remark: c.remark,
              nickname: c.nickname,
              alias: c.alias,
              labels: c.labels,
              description: c.description,
              detailDescription: c.detailDescription,
              region: c.region
            })))
            setLastUpdatedAt(Date.now())
          }
        }
      } finally {
        if (!signal.aborted) {
          setIsEnriching(false)
        }
      }
    } catch (err) {
      console.error('[useContactsLoader] Error loading contacts:', err)
      if (!signal.aborted) {
        setIsLoading(false)
        setIsEnriching(false)
      }
    }
  }, [abort])

  return {
    contactMap,
    avatarEntries,
    isLoading,
    isEnriching,
    dataSource,
    lastUpdatedAt,
    loadContacts,
    abort
  }
}
