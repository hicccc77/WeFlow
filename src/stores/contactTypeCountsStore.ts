import { create } from 'zustand'
import type { ContactInfo } from '../types/models'

export interface ContactTypeTabCounts {
  private: number
  group: number
  official: number
  former_friend: number
}

export interface ContactTypeCardCounts {
  friends: number
  groups: number
  officials: number
  deletedFriends: number
}

const emptyTabCounts: ContactTypeTabCounts = {
  private: 0,
  group: 0,
  official: 0,
  former_friend: 0
}

let inflightPromise: Promise<ContactTypeTabCounts> | null = null

const normalizeCounts = (counts?: Partial<ContactTypeTabCounts> | null): ContactTypeTabCounts => {
  return {
    private: Number.isFinite(counts?.private) ? Math.max(0, Math.floor(Number(counts?.private))) : 0,
    group: Number.isFinite(counts?.group) ? Math.max(0, Math.floor(Number(counts?.group))) : 0,
    official: Number.isFinite(counts?.official) ? Math.max(0, Math.floor(Number(counts?.official))) : 0,
    former_friend: Number.isFinite(counts?.former_friend) ? Math.max(0, Math.floor(Number(counts?.former_friend))) : 0
  }
}

export const toContactTypeTabCountsFromContacts = (contacts: ContactInfo[]): ContactTypeTabCounts => {
  const next = { ...emptyTabCounts }
  for (const contact of contacts || []) {
    if (contact.type === 'friend') next.private += 1
    if (contact.type === 'group') next.group += 1
    if (contact.type === 'official') next.official += 1
    if (contact.type === 'former_friend') next.former_friend += 1
  }
  return next
}

export const toContactTypeCardCounts = (counts: ContactTypeTabCounts): ContactTypeCardCounts => {
  return {
    friends: counts.private,
    groups: counts.group,
    officials: counts.official,
    deletedFriends: counts.former_friend
  }
}

interface ContactTypeCountsState {
  tabCounts: ContactTypeTabCounts
  isLoading: boolean
  isReady: boolean
  updatedAt: number
  setTabCounts: (counts: ContactTypeTabCounts) => void
  syncFromContacts: (contacts: ContactInfo[]) => void
  ensureLoaded: (options?: { force?: boolean }) => Promise<ContactTypeTabCounts>
}

export const useContactTypeCountsStore = create<ContactTypeCountsState>((set, get) => ({
  tabCounts: { ...emptyTabCounts },
  isLoading: false,
  isReady: false,
  updatedAt: 0,
  setTabCounts: (counts) => {
    const normalized = normalizeCounts(counts)
    set({
      tabCounts: normalized,
      isReady: true,
      updatedAt: Date.now()
    })
  },
  syncFromContacts: (contacts) => {
    const fromContacts = toContactTypeTabCountsFromContacts(contacts || [])
    get().setTabCounts(fromContacts)
  },
  ensureLoaded: async (options) => {
    if (!options?.force && get().isReady) {
      return get().tabCounts
    }
    if (inflightPromise) {
      return inflightPromise
    }

    set({ isLoading: true })
    inflightPromise = (async () => {
      try {
        const result = await window.electronAPI.chat.getContactTypeCounts()
        if (result?.success && result.counts) {
          const normalized = normalizeCounts(result.counts)
          set({
            tabCounts: normalized,
            isReady: true,
            updatedAt: Date.now()
          })
          return normalized
        }
      } catch (error) {
        console.error('加载联系人类型计数失败:', error)
      }
      return get().tabCounts
    })().finally(() => {
      inflightPromise = null
      set({ isLoading: false })
    })

    return inflightPromise
  }
}))
