import { useState, useEffect, useCallback, useMemo, useRef, type UIEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, RefreshCw, X, User, Users, MessageSquare, Loader2, FolderOpen, Download, ChevronDown, MessageCircle, UserX, AlertTriangle, ClipboardList, Aperture } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { toContactTypeCardCounts, useContactTypeCountsStore } from '../stores/contactTypeCountsStore'
import * as configService from '../services/config'
import type { ContactInfo } from '../types/models'
import { ContactSnsTimelineDialog } from '../components/Sns/ContactSnsTimelineDialog'
import { type ContactSnsTimelineTarget, isSingleContactSession } from '../components/Sns/contactSnsTimeline'
import './ContactsPage.scss'

interface ContactEnrichInfo {
    displayName?: string
    avatarUrl?: string
}

const AVATAR_ENRICH_BATCH_SIZE = 80
const SEARCH_DEBOUNCE_MS = 120
const VIRTUAL_ROW_HEIGHT = 76
const VIRTUAL_OVERSCAN = 10
const DEFAULT_CONTACTS_LOAD_TIMEOUT_MS = 3000
const AVATAR_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

interface ContactsLoadSession {
    requestId: string
    startedAt: number
    attempt: number
    timeoutMs: number
}

interface ContactsLoadIssue {
    kind: 'timeout' | 'error'
    title: string
    message: string
    reason: string
    errorDetail?: string
    occurredAt: number
    elapsedMs: number
}

type ContactsDataSource = 'cache' | 'network' | null

function ContactsPage() {
    const [contacts, setContacts] = useState<ContactInfo[]>([])
    const [selectedUsernames, setSelectedUsernames] = useState<Set<string>>(new Set())
    const [isLoading, setIsLoading] = useState(true)
    const [searchKeyword, setSearchKeyword] = useState('')
    const [debouncedSearchKeyword, setDebouncedSearchKeyword] = useState('')
    const [contactTypes, setContactTypes] = useState({
        friends: true,
        groups: false,
        officials: false,
        deletedFriends: false
    })

    // 导出模式与查看详情
    const [exportMode, setExportMode] = useState(false)
    const [selectedContact, setSelectedContact] = useState<ContactInfo | null>(null)
    const [snsUserPostCounts, setSnsUserPostCounts] = useState<Record<string, number>>({})
    const [snsUserPostCountsStatus, setSnsUserPostCountsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const [snsTimelineTarget, setSnsTimelineTarget] = useState<ContactSnsTimelineTarget | null>(null)
    const navigate = useNavigate()
    const { setCurrentSession } = useChatStore()

    // 导出相关状态
    const [exportFormat, setExportFormat] = useState<'json' | 'csv' | 'vcf'>('json')
    const [exportAvatars, setExportAvatars] = useState(true)
    const [exportFolder, setExportFolder] = useState('')
    const [isExporting, setIsExporting] = useState(false)
    const [showFormatSelect, setShowFormatSelect] = useState(false)
    const formatDropdownRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const loadVersionRef = useRef(0)
    const [avatarEnrichProgress, setAvatarEnrichProgress] = useState({
        loaded: 0,
        total: 0,
        running: false
    })
    const [scrollTop, setScrollTop] = useState(0)
    const [listViewportHeight, setListViewportHeight] = useState(480)
    const sharedTabCounts = useContactTypeCountsStore(state => state.tabCounts)
    const syncContactTypeCounts = useContactTypeCountsStore(state => state.syncFromContacts)
    const loadAttemptRef = useRef(0)
    const loadTimeoutTimerRef = useRef<number | null>(null)
    const [contactsLoadTimeoutMs, setContactsLoadTimeoutMs] = useState(DEFAULT_CONTACTS_LOAD_TIMEOUT_MS)
    const [loadSession, setLoadSession] = useState<ContactsLoadSession | null>(null)
    const [loadIssue, setLoadIssue] = useState<ContactsLoadIssue | null>(null)
    const [showDiagnostics, setShowDiagnostics] = useState(false)
    const [diagnosticTick, setDiagnosticTick] = useState(Date.now())
    const [contactsDataSource, setContactsDataSource] = useState<ContactsDataSource>(null)
    const [contactsUpdatedAt, setContactsUpdatedAt] = useState<number | null>(null)
    const [avatarCacheUpdatedAt, setAvatarCacheUpdatedAt] = useState<number | null>(null)
    const contactsLoadTimeoutMsRef = useRef(DEFAULT_CONTACTS_LOAD_TIMEOUT_MS)
    const contactsCacheScopeRef = useRef('default')
    const contactsAvatarCacheRef = useRef<Record<string, configService.ContactsAvatarCacheEntry>>({})

    const ensureContactsCacheScope = useCallback(async () => {
        if (contactsCacheScopeRef.current !== 'default') {
            return contactsCacheScopeRef.current
        }
        const [dbPath, myWxid] = await Promise.all([
            configService.getDbPath(),
            configService.getMyWxid()
        ])
        const scopeKey = dbPath || myWxid
            ? `${dbPath || ''}::${myWxid || ''}`
            : 'default'
        contactsCacheScopeRef.current = scopeKey
        return scopeKey
    }, [])

    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const value = await configService.getContactsLoadTimeoutMs()
                if (!cancelled) {
                    setContactsLoadTimeoutMs(value)
                }
            } catch (error) {
                console.error('读取通讯录超时配置失败:', error)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [])

    useEffect(() => {
        contactsLoadTimeoutMsRef.current = contactsLoadTimeoutMs
    }, [contactsLoadTimeoutMs])

    const mergeAvatarCacheIntoContacts = useCallback((sourceContacts: ContactInfo[]): ContactInfo[] => {
        const avatarCache = contactsAvatarCacheRef.current
        if (!sourceContacts.length || Object.keys(avatarCache).length === 0) {
            return sourceContacts
        }
        let changed = false
        const merged = sourceContacts.map((contact) => {
            const cachedAvatar = avatarCache[contact.username]?.avatarUrl
            if (!cachedAvatar || contact.avatarUrl) {
                return contact
            }
            changed = true
            return {
                ...contact,
                avatarUrl: cachedAvatar
            }
        })
        return changed ? merged : sourceContacts
    }, [])

    const upsertAvatarCacheFromContacts = useCallback((
        scopeKey: string,
        sourceContacts: ContactInfo[],
        options?: { prune?: boolean; markCheckedUsernames?: string[] }
    ) => {
        if (!scopeKey) return
        const nextCache = { ...contactsAvatarCacheRef.current }
        const now = Date.now()
        const markCheckedSet = new Set((options?.markCheckedUsernames || []).filter(Boolean))
        const usernamesInSource = new Set<string>()
        let changed = false

        for (const contact of sourceContacts) {
            const username = String(contact.username || '').trim()
            if (!username) continue
            usernamesInSource.add(username)
            const prev = nextCache[username]
            const avatarUrl = String(contact.avatarUrl || '').trim()
            if (!avatarUrl) continue
            const updatedAt = !prev || prev.avatarUrl !== avatarUrl ? now : prev.updatedAt
            const checkedAt = markCheckedSet.has(username) ? now : (prev?.checkedAt || now)
            if (!prev || prev.avatarUrl !== avatarUrl || prev.updatedAt !== updatedAt || prev.checkedAt !== checkedAt) {
                nextCache[username] = {
                    avatarUrl,
                    updatedAt,
                    checkedAt
                }
                changed = true
            }
        }

        for (const username of markCheckedSet) {
            const prev = nextCache[username]
            if (!prev) continue
            if (prev.checkedAt !== now) {
                nextCache[username] = {
                    ...prev,
                    checkedAt: now
                }
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

        if (!changed) return
        contactsAvatarCacheRef.current = nextCache
        setAvatarCacheUpdatedAt(now)
        void configService.setContactsAvatarCache(scopeKey, nextCache).catch((error) => {
            console.error('写入通讯录头像缓存失败:', error)
        })
    }, [])

    const applyEnrichedContacts = useCallback((enrichedMap: Record<string, ContactEnrichInfo>) => {
        if (!enrichedMap || Object.keys(enrichedMap).length === 0) return

        setContacts(prev => {
            let changed = false
            const next = prev.map(contact => {
                const enriched = enrichedMap[contact.username]
                if (!enriched) return contact
                const displayName = enriched.displayName || contact.displayName
                const avatarUrl = enriched.avatarUrl || contact.avatarUrl
                if (displayName === contact.displayName && avatarUrl === contact.avatarUrl) {
                    return contact
                }
                changed = true
                return {
                    ...contact,
                    displayName,
                    avatarUrl
                }
            })
            return changed ? next : prev
        })

        setSelectedContact(prev => {
            if (!prev) return prev
            const enriched = enrichedMap[prev.username]
            if (!enriched) return prev
            const displayName = enriched.displayName || prev.displayName
            const avatarUrl = enriched.avatarUrl || prev.avatarUrl
            if (displayName === prev.displayName && avatarUrl === prev.avatarUrl) {
                return prev
            }
            return {
                ...prev,
                displayName,
                avatarUrl
            }
        })
    }, [])

    const enrichContactsInBackground = useCallback(async (
        sourceContacts: ContactInfo[],
        loadVersion: number,
        scopeKey: string
    ) => {
        const sourceByUsername = new Map<string, ContactInfo>()
        for (const contact of sourceContacts) {
            if (!contact.username) continue
            sourceByUsername.set(contact.username, contact)
        }
        const now = Date.now()
        const usernames = sourceContacts
            .map(contact => contact.username)
            .filter(Boolean)
            .filter((username) => {
                const currentContact = sourceByUsername.get(username)
                if (!currentContact) return false
                const cacheEntry = contactsAvatarCacheRef.current[username]
                if (!cacheEntry || !cacheEntry.avatarUrl) {
                    return !currentContact.avatarUrl
                }
                if (currentContact.avatarUrl && currentContact.avatarUrl !== cacheEntry.avatarUrl) {
                    return true
                }
                const checkedAt = cacheEntry.checkedAt || 0
                return now - checkedAt >= AVATAR_RECHECK_INTERVAL_MS
            })

        const total = usernames.length
        setAvatarEnrichProgress({
            loaded: 0,
            total,
            running: total > 0
        })
        if (total === 0) return

        for (let i = 0; i < total; i += AVATAR_ENRICH_BATCH_SIZE) {
            if (loadVersionRef.current !== loadVersion) return
            const batch = usernames.slice(i, i + AVATAR_ENRICH_BATCH_SIZE)
            if (batch.length === 0) continue

            try {
                const avatarResult = await window.electronAPI.chat.enrichSessionsContactInfo(batch)
                if (loadVersionRef.current !== loadVersion) return
                if (avatarResult.success && avatarResult.contacts) {
                    applyEnrichedContacts(avatarResult.contacts)
                    for (const [username, enriched] of Object.entries(avatarResult.contacts)) {
                        const prev = sourceByUsername.get(username)
                        if (!prev) continue
                        sourceByUsername.set(username, {
                            ...prev,
                            displayName: enriched.displayName || prev.displayName,
                            avatarUrl: enriched.avatarUrl || prev.avatarUrl
                        })
                    }
                }
                const batchContacts = batch
                    .map(username => sourceByUsername.get(username))
                    .filter((contact): contact is ContactInfo => Boolean(contact))
                upsertAvatarCacheFromContacts(scopeKey, batchContacts, {
                    markCheckedUsernames: batch
                })
            } catch (e) {
                console.error('分批补全头像失败:', e)
            }

            const loaded = Math.min(i + batch.length, total)
            setAvatarEnrichProgress({
                loaded,
                total,
                running: loaded < total
            })

            await new Promise(resolve => setTimeout(resolve, 0))
        }
    }, [applyEnrichedContacts, upsertAvatarCacheFromContacts])

    // 加载通讯录
    const loadContacts = useCallback(async (options?: { scopeKey?: string }) => {
        const scopeKey = options?.scopeKey || await ensureContactsCacheScope()
        const loadVersion = loadVersionRef.current + 1
        loadVersionRef.current = loadVersion
        loadAttemptRef.current += 1
        const startedAt = Date.now()
        const timeoutMs = contactsLoadTimeoutMsRef.current
        const requestId = `contacts-${startedAt}-${loadAttemptRef.current}`
        setLoadSession({
            requestId,
            startedAt,
            attempt: loadAttemptRef.current,
            timeoutMs
        })
        setLoadIssue(null)
        setShowDiagnostics(false)
        if (loadTimeoutTimerRef.current) {
            window.clearTimeout(loadTimeoutTimerRef.current)
            loadTimeoutTimerRef.current = null
        }
        const timeoutTimerId = window.setTimeout(() => {
            if (loadVersionRef.current !== loadVersion) return
            const elapsedMs = Date.now() - startedAt
            setLoadIssue({
                kind: 'timeout',
                title: '通讯录加载超时',
                message: `等待超过 ${timeoutMs}ms，联系人列表仍未返回。`,
                reason: 'chat.getContacts 长时间未返回，可能是数据库查询繁忙或连接异常。',
                occurredAt: Date.now(),
                elapsedMs
            })
        }, timeoutMs)
        loadTimeoutTimerRef.current = timeoutTimerId

        setIsLoading(true)
        setAvatarEnrichProgress({
            loaded: 0,
            total: 0,
            running: false
        })
        try {
            const contactsResult = await window.electronAPI.chat.getContacts()

            if (loadVersionRef.current !== loadVersion) return
            if (contactsResult.success && contactsResult.contacts) {
                if (loadTimeoutTimerRef.current === timeoutTimerId) {
                    window.clearTimeout(loadTimeoutTimerRef.current)
                    loadTimeoutTimerRef.current = null
                }
                const contactsWithAvatarCache = mergeAvatarCacheIntoContacts(contactsResult.contacts)
                setContacts(contactsWithAvatarCache)
                syncContactTypeCounts(contactsWithAvatarCache)
                setSelectedUsernames(new Set())
                setSelectedContact(prev => {
                    if (!prev) return prev
                    return contactsWithAvatarCache.find(contact => contact.username === prev.username) || null
                })
                const now = Date.now()
                setContactsDataSource('network')
                setContactsUpdatedAt(now)
                setLoadIssue(null)
                setIsLoading(false)
                upsertAvatarCacheFromContacts(scopeKey, contactsWithAvatarCache, { prune: true })
                void configService.setContactsListCache(
                    scopeKey,
                    contactsWithAvatarCache.map(contact => ({
                        username: contact.username,
                        displayName: contact.displayName,
                        remark: contact.remark,
                        nickname: contact.nickname,
                        alias: contact.alias,
                        labels: contact.labels,
                        detailDescription: contact.detailDescription,
                        type: contact.type
                    }))
                ).catch((error) => {
                    console.error('写入通讯录缓存失败:', error)
                })
                void enrichContactsInBackground(contactsWithAvatarCache, loadVersion, scopeKey)
                return
            }
            const elapsedMs = Date.now() - startedAt
            setLoadIssue({
                kind: 'error',
                title: '通讯录加载失败',
                message: '联系人接口返回失败，未拿到联系人列表。',
                reason: 'chat.getContacts 返回 success=false。',
                errorDetail: contactsResult.error || '未知错误',
                occurredAt: Date.now(),
                elapsedMs
            })
        } catch (e) {
            console.error('加载通讯录失败:', e)
            const elapsedMs = Date.now() - startedAt
            setLoadIssue({
                kind: 'error',
                title: '通讯录加载失败',
                message: '联系人请求执行异常。',
                reason: '调用 chat.getContacts 发生异常。',
                errorDetail: String(e),
                occurredAt: Date.now(),
                elapsedMs
            })
        } finally {
            if (loadTimeoutTimerRef.current === timeoutTimerId) {
                window.clearTimeout(loadTimeoutTimerRef.current)
                loadTimeoutTimerRef.current = null
            }
            if (loadVersionRef.current === loadVersion) {
                setIsLoading(false)
            }
        }
    }, [
        ensureContactsCacheScope,
        enrichContactsInBackground,
        mergeAvatarCacheIntoContacts,
        syncContactTypeCounts,
        upsertAvatarCacheFromContacts
    ])

    useEffect(() => {
        let cancelled = false
        void (async () => {
            const scopeKey = await ensureContactsCacheScope()
            if (cancelled) return
            try {
                const [cacheItem, avatarCacheItem] = await Promise.all([
                    configService.getContactsListCache(scopeKey),
                    configService.getContactsAvatarCache(scopeKey)
                ])
                const avatarCacheMap = avatarCacheItem?.avatars || {}
                contactsAvatarCacheRef.current = avatarCacheMap
                setAvatarCacheUpdatedAt(avatarCacheItem?.updatedAt || null)
                if (!cancelled && cacheItem && Array.isArray(cacheItem.contacts) && cacheItem.contacts.length > 0) {
                    const cachedContacts: ContactInfo[] = cacheItem.contacts.map(contact => ({
                        ...contact,
                        avatarUrl: avatarCacheMap[contact.username]?.avatarUrl
                    }))
                    setContacts(cachedContacts)
                    syncContactTypeCounts(cachedContacts)
                    setContactsDataSource('cache')
                    setContactsUpdatedAt(cacheItem.updatedAt || null)
                    setIsLoading(false)
                }
            } catch (error) {
                console.error('读取通讯录缓存失败:', error)
            }
            if (!cancelled) {
                void loadContacts({ scopeKey })
            }
        })()
        return () => {
            cancelled = true
        }
    }, [ensureContactsCacheScope, loadContacts, syncContactTypeCounts])

    useEffect(() => {
        return () => {
            if (loadTimeoutTimerRef.current) {
                window.clearTimeout(loadTimeoutTimerRef.current)
                loadTimeoutTimerRef.current = null
            }
            loadVersionRef.current += 1
        }
    }, [])

    useEffect(() => {
        if (!loadIssue || contacts.length > 0) return
        if (!(isLoading && loadIssue.kind === 'timeout')) return
        const timer = window.setInterval(() => {
            setDiagnosticTick(Date.now())
        }, 500)
        return () => window.clearInterval(timer)
    }, [contacts.length, isLoading, loadIssue])

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedSearchKeyword(searchKeyword.trim().toLowerCase())
        }, SEARCH_DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
    }, [searchKeyword])

    const loadSnsUserPostCounts = useCallback(async (options?: { force?: boolean }) => {
        if (!options?.force && (snsUserPostCountsStatus === 'loading' || snsUserPostCountsStatus === 'ready')) {
            return
        }

        setSnsUserPostCountsStatus('loading')
        try {
            const result = await window.electronAPI.sns.getUserPostCounts()
            if (!result.success || !result.counts) {
                setSnsUserPostCountsStatus('error')
                return
            }

            const normalizedCounts: Record<string, number> = {}
            for (const [rawUsername, rawCount] of Object.entries(result.counts)) {
                const username = String(rawUsername || '').trim()
                if (!username) continue
                const value = Number(rawCount)
                normalizedCounts[username] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
            }

            setSnsUserPostCounts(normalizedCounts)
            setSnsUserPostCountsStatus('ready')
        } catch (error) {
            console.error('加载通讯录联系人朋友圈条数失败:', error)
            setSnsUserPostCountsStatus('error')
        }
    }, [snsUserPostCountsStatus])

    useEffect(() => {
        if (!selectedContact || !isSingleContactSession(selectedContact.username)) return
        if (snsUserPostCountsStatus !== 'idle') return
        void loadSnsUserPostCounts()
    }, [loadSnsUserPostCounts, selectedContact, snsUserPostCountsStatus])

    const filteredContacts = useMemo(() => {
        let filtered = contacts.filter(contact => {
            if (contact.type === 'friend' && !contactTypes.friends) return false
            if (contact.type === 'group' && !contactTypes.groups) return false
            if (contact.type === 'official' && !contactTypes.officials) return false
            if (contact.type === 'former_friend' && !contactTypes.deletedFriends) return false
            return true
        })

        if (debouncedSearchKeyword) {
            filtered = filtered.filter(contact =>
                contact.displayName?.toLowerCase().includes(debouncedSearchKeyword) ||
                contact.remark?.toLowerCase().includes(debouncedSearchKeyword) ||
                contact.username.toLowerCase().includes(debouncedSearchKeyword)
            )
        }

        return filtered
    }, [contacts, contactTypes, debouncedSearchKeyword])

    const contactTypeCounts = useMemo(() => toContactTypeCardCounts(sharedTabCounts), [sharedTabCounts])

    useEffect(() => {
        if (!listRef.current) return
        listRef.current.scrollTop = 0
        setScrollTop(0)
    }, [debouncedSearchKeyword, contactTypes])

    useEffect(() => {
        const node = listRef.current
        if (!node) return

        const updateViewportHeight = () => {
            setListViewportHeight(Math.max(node.clientHeight, VIRTUAL_ROW_HEIGHT))
        }
        updateViewportHeight()

        const observer = new ResizeObserver(() => updateViewportHeight())
        observer.observe(node)
        return () => observer.disconnect()
    }, [filteredContacts.length, isLoading])

    useEffect(() => {
        const maxScroll = Math.max(0, filteredContacts.length * VIRTUAL_ROW_HEIGHT - listViewportHeight)
        if (scrollTop <= maxScroll) return
        setScrollTop(maxScroll)
        if (listRef.current) {
            listRef.current.scrollTop = maxScroll
        }
    }, [filteredContacts.length, listViewportHeight, scrollTop])

    // 搜索和类型过滤
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node
            if (showFormatSelect && formatDropdownRef.current && !formatDropdownRef.current.contains(target)) {
                setShowFormatSelect(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showFormatSelect])

    const selectedInFilteredCount = useMemo(() => {
        return filteredContacts.reduce((count, contact) => {
            return selectedUsernames.has(contact.username) ? count + 1 : count
        }, 0)
    }, [filteredContacts, selectedUsernames])
    const allFilteredSelected = filteredContacts.length > 0 && selectedInFilteredCount === filteredContacts.length

    const selectedContactSupportsSns = useMemo(() => {
        return Boolean(selectedContact && isSingleContactSession(selectedContact.username))
    }, [selectedContact])

    const selectedContactSnsCount = useMemo(() => {
        if (!selectedContactSupportsSns || !selectedContact) return null
        if (snsUserPostCountsStatus !== 'ready') return null
        const rawCount = Number(snsUserPostCounts[selectedContact.username] || 0)
        return Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0
    }, [selectedContact, selectedContactSupportsSns, snsUserPostCounts, snsUserPostCountsStatus])

    const selectedContactSnsEntryLabel = useMemo(() => {
        if (!selectedContactSupportsSns) return ''
        if (selectedContactSnsCount !== null) {
            return `朋友圈：${selectedContactSnsCount.toLocaleString('zh-CN')}条`
        }
        if (snsUserPostCountsStatus === 'error') return '朋友圈：查看'
        return '朋友圈：统计中...'
    }, [selectedContactSupportsSns, selectedContactSnsCount, snsUserPostCountsStatus])

    const openSelectedContactSnsTimeline = useCallback(() => {
        if (!selectedContact || !selectedContactSupportsSns) return
        if (snsUserPostCountsStatus === 'idle') {
            void loadSnsUserPostCounts()
        }
        setSnsTimelineTarget({
            username: selectedContact.username,
            displayName: selectedContact.displayName || selectedContact.remark || selectedContact.nickname || selectedContact.username,
            avatarUrl: selectedContact.avatarUrl
        })
    }, [loadSnsUserPostCounts, selectedContact, selectedContactSupportsSns, snsUserPostCountsStatus])

    const { startIndex, endIndex } = useMemo(() => {
        if (filteredContacts.length === 0) {
            return { startIndex: 0, endIndex: 0 }
        }
        const baseStart = Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT)
        const visibleCount = Math.ceil(listViewportHeight / VIRTUAL_ROW_HEIGHT)
        const nextStart = Math.max(0, baseStart - VIRTUAL_OVERSCAN)
        const nextEnd = Math.min(filteredContacts.length, nextStart + visibleCount + VIRTUAL_OVERSCAN * 2)
        return {
            startIndex: nextStart,
            endIndex: nextEnd
        }
    }, [filteredContacts.length, listViewportHeight, scrollTop])

    const visibleContacts = useMemo(() => {
        return filteredContacts.slice(startIndex, endIndex)
    }, [filteredContacts, startIndex, endIndex])

    const onContactsListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
        setScrollTop(event.currentTarget.scrollTop)
    }, [])

    const issueElapsedMs = useMemo(() => {
        if (!loadIssue) return 0
        if (isLoading && loadSession) {
            return Math.max(loadIssue.elapsedMs, diagnosticTick - loadSession.startedAt)
        }
        return loadIssue.elapsedMs
    }, [diagnosticTick, isLoading, loadIssue, loadSession])

    const diagnosticsText = useMemo(() => {
        if (!loadIssue || !loadSession) return ''
        return [
            `请求ID: ${loadSession.requestId}`,
            `请求序号: 第 ${loadSession.attempt} 次`,
            `阈值配置: ${loadSession.timeoutMs}ms`,
            `当前状态: ${loadIssue.kind === 'timeout' ? '超时等待中' : '请求失败'}`,
            `累计耗时: ${(issueElapsedMs / 1000).toFixed(1)}s`,
            `发生时间: ${new Date(loadIssue.occurredAt).toLocaleString()}`,
            `阶段: chat.getContacts`,
            `原因: ${loadIssue.reason}`,
            `错误详情: ${loadIssue.errorDetail || '无'}`
        ].join('\n')
    }, [issueElapsedMs, loadIssue, loadSession])

    const copyDiagnostics = useCallback(async () => {
        if (!diagnosticsText) return
        try {
            await navigator.clipboard.writeText(diagnosticsText)
            alert('诊断信息已复制')
        } catch (error) {
            console.error('复制诊断信息失败:', error)
            alert('复制失败，请手动复制诊断信息')
        }
    }, [diagnosticsText])

    const contactsUpdatedAtLabel = useMemo(() => {
        if (!contactsUpdatedAt) return ''
        return new Date(contactsUpdatedAt).toLocaleString()
    }, [contactsUpdatedAt])

    const avatarCachedCount = useMemo(() => {
        return contacts.reduce((count, contact) => (
            contact.avatarUrl ? count + 1 : count
        ), 0)
    }, [contacts])

    const avatarCacheUpdatedAtLabel = useMemo(() => {
        if (!avatarCacheUpdatedAt) return ''
        return new Date(avatarCacheUpdatedAt).toLocaleString()
    }, [avatarCacheUpdatedAt])

    const toggleContactSelected = (username: string, checked: boolean) => {
        setSelectedUsernames(prev => {
            const next = new Set(prev)
            if (checked) {
                next.add(username)
            } else {
                next.delete(username)
            }
            return next
        })
    }

    const toggleAllFilteredSelected = (checked: boolean) => {
        setSelectedUsernames(prev => {
            const next = new Set(prev)
            filteredContacts.forEach(contact => {
                if (checked) {
                    next.add(contact.username)
                } else {
                    next.delete(contact.username)
                }
            })
            return next
        })
    }

    const getAvatarLetter = (name: string) => {
        if (!name) return '?'
        return [...name][0] || '?'
    }

    const getContactTypeIcon = (type: string) => {
        switch (type) {
            case 'friend': return <User size={14} />
            case 'group': return <Users size={14} />
            case 'official': return <MessageSquare size={14} />
            case 'former_friend': return <UserX size={14} />
            default: return <User size={14} />
        }
    }

    const getContactTypeName = (type: string) => {
        switch (type) {
            case 'friend': return '好友'
            case 'group': return '群聊'
            case 'official': return '公众号'
            case 'former_friend': return '曾经的好友'
            default: return '其他'
        }
    }

    // 选择导出文件夹
    const selectExportFolder = async () => {
        try {
            const result = await window.electronAPI.dialog.openDirectory({
                title: '选择导出位置'
            })
            if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
                setExportFolder(result.filePaths[0])
            }
        } catch (e) {
            console.error('选择文件夹失败:', e)
        }
    }

    // 开始导出
    const startExport = async () => {
        if (!exportFolder) {
            alert('请先选择导出位置')
            return
        }
        if (selectedUsernames.size === 0) {
            alert('请至少选择一个联系人')
            return
        }

        setIsExporting(true)
        try {
            const exportOptions = {
                format: exportFormat,
                exportAvatars,
                contactTypes: {
                    friends: contactTypes.friends,
                    groups: contactTypes.groups,
                    officials: contactTypes.officials
                },
                selectedUsernames: Array.from(selectedUsernames)
            }

            const result = await window.electronAPI.export.exportContacts(exportFolder, exportOptions)

            if (result.success) {
                alert(`导出成功！共导出 ${result.successCount} 个联系人`)
            } else {
                alert(`导出失败：${result.error}`)
            }
        } catch (e) {
            console.error('导出失败:', e)
            alert(`导出失败：${String(e)}`)
        } finally {
            setIsExporting(false)
        }
    }

    const exportFormatOptions = [
        { value: 'json', label: 'JSON', desc: '详细格式，包含完整联系人信息' },
        { value: 'csv', label: 'CSV (Excel)', desc: '电子表格格式，适合Excel查看' },
        { value: 'vcf', label: 'VCF (vCard)', desc: '标准名片格式，支持导入手机' }
    ]

    const getOptionLabel = (value: string) => {
        return exportFormatOptions.find(opt => opt.value === value)?.label || value
    }

    return (
        <div className="contacts-page">
            {/* 左侧：联系人列表 */}
            <div className="contacts-panel">
                <div className="panel-header">
                    <h2>通讯录</h2>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button
                            className={`icon-btn export-mode-btn ${exportMode ? 'active' : ''}`}
                            onClick={() => { setExportMode(!exportMode); setSelectedContact(null) }}
                            title={exportMode ? '退出导出模式' : '进入导出模式'}
                        >
                            <Download size={18} />
                        </button>
                        <button className="icon-btn" onClick={() => void loadContacts()} disabled={isLoading}>
                            <RefreshCw size={18} className={isLoading ? 'spin' : ''} />
                        </button>
                    </div>
                </div>

                <div className="search-bar">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="搜索联系人..."
                        value={searchKeyword}
                        onChange={e => setSearchKeyword(e.target.value)}
                    />
                    {searchKeyword && (
                        <button className="clear-btn" onClick={() => setSearchKeyword('')}>
                            <X size={14} />
                        </button>
                    )}
                </div>

                <div className="type-filters">
                    <label className={`filter-chip ${contactTypes.friends ? 'active' : ''}`}>
                        <input type="checkbox" checked={contactTypes.friends} onChange={e => setContactTypes({ ...contactTypes, friends: e.target.checked })} />
                        <User size={16} />
                        <span className="chip-label">好友</span>
                        <span className="chip-count">{contactTypeCounts.friends}</span>
                    </label>
                    <label className={`filter-chip ${contactTypes.groups ? 'active' : ''}`}>
                        <input type="checkbox" checked={contactTypes.groups} onChange={e => setContactTypes({ ...contactTypes, groups: e.target.checked })} />
                        <Users size={16} />
                        <span className="chip-label">群聊</span>
                        <span className="chip-count">{contactTypeCounts.groups}</span>
                    </label>
                    <label className={`filter-chip ${contactTypes.officials ? 'active' : ''}`}>
                        <input type="checkbox" checked={contactTypes.officials} onChange={e => setContactTypes({ ...contactTypes, officials: e.target.checked })} />
                        <MessageSquare size={16} />
                        <span className="chip-label">公众号</span>
                        <span className="chip-count">{contactTypeCounts.officials}</span>
                    </label>
                    <label className={`filter-chip ${contactTypes.deletedFriends ? 'active' : ''}`}>
                        <input type="checkbox" checked={contactTypes.deletedFriends} onChange={e => setContactTypes({ ...contactTypes, deletedFriends: e.target.checked })} />
                        <UserX size={16} />
                        <span className="chip-label">曾经的好友</span>
                        <span className="chip-count">{contactTypeCounts.deletedFriends}</span>
                    </label>
                </div>


                {exportMode && (
                    <div className="selection-toolbar">
                        <label className="checkbox-item">
                            <input
                                type="checkbox"
                                checked={allFilteredSelected}
                                onChange={e => toggleAllFilteredSelected(e.target.checked)}
                                disabled={filteredContacts.length === 0}
                            />
                            <span>全选当前筛选结果</span>
                        </label>
                        <span className="selection-count">已选 {selectedUsernames.size}（当前筛选 {selectedInFilteredCount} / {filteredContacts.length}）</span>
                    </div>
                )}

                {contacts.length === 0 && loadIssue ? (
                    <div className="load-issue-state">
                        <div className="issue-card">
                            <div className="issue-title">
                                <AlertTriangle size={18} />
                                <span>{loadIssue.title}</span>
                            </div>
                            <p className="issue-message">{loadIssue.message}</p>
                            <p className="issue-reason">{loadIssue.reason}</p>
                            <ul className="issue-hints">
                                <li>可能原因1：数据库当前仍在执行高开销查询（例如导出页后台统计）。</li>
                                <li>可能原因2：contact.db 数据量较大，首次查询时间过长。</li>
                                <li>可能原因3：数据库连接状态异常或 IPC 调用卡住。</li>
                            </ul>
                            <div className="issue-actions">
                                <button className="issue-btn primary" onClick={() => void loadContacts()}>
                                    <RefreshCw size={14} />
                                    <span>重试加载</span>
                                </button>
                                <button className="issue-btn" onClick={() => setShowDiagnostics(prev => !prev)}>
                                    <ClipboardList size={14} />
                                    <span>{showDiagnostics ? '收起诊断详情' : '查看诊断详情'}</span>
                                </button>
                                <button className="issue-btn" onClick={copyDiagnostics}>
                                    <span>复制诊断信息</span>
                                </button>
                            </div>
                            {showDiagnostics && (
                                <pre className="issue-diagnostics">{diagnosticsText}</pre>
                            )}
                        </div>
                    </div>
                ) : isLoading && contacts.length === 0 ? (
                    <div className="loading-state">
                        <Loader2 size={32} className="spin" />
                        <span>联系人加载中...</span>
                    </div>
                ) : filteredContacts.length === 0 ? (
                    <div className="empty-state">
                        <span>暂无联系人</span>
                    </div>
                ) : (
                    <div className="contacts-list" ref={listRef} onScroll={onContactsListScroll}>
                        <div
                            className="contacts-list-virtual"
                            style={{ height: filteredContacts.length * VIRTUAL_ROW_HEIGHT }}
                        >
                            {visibleContacts.map((contact, idx) => {
                            const absoluteIndex = startIndex + idx
                            const top = absoluteIndex * VIRTUAL_ROW_HEIGHT
                            const isChecked = selectedUsernames.has(contact.username)
                            const isActive = !exportMode && selectedContact?.username === contact.username
                            return (
                                <div
                                    key={contact.username}
                                    className="contact-row"
                                    style={{ transform: `translateY(${top}px)` }}
                                >
                                    <div
                                        className={`contact-item ${exportMode && isChecked ? 'selected' : ''} ${isActive ? 'active' : ''}`}
                                        onClick={() => {
                                            if (exportMode) {
                                                toggleContactSelected(contact.username, !isChecked)
                                            } else {
                                                setSelectedContact(isActive ? null : contact)
                                            }
                                        }}
                                    >
                                        {exportMode && (
                                            <label className="contact-select" onClick={e => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={isChecked}
                                                    onChange={e => toggleContactSelected(contact.username, e.target.checked)}
                                                />
                                            </label>
                                        )}
                                        <div className="contact-avatar">
                                            {contact.avatarUrl ? (
                                                <img src={contact.avatarUrl} alt="" loading="lazy" />
                                            ) : (
                                                <span>{getAvatarLetter(contact.displayName)}</span>
                                            )}
                                        </div>
                                        <div className="contact-info">
                                            <div className="contact-name">{contact.displayName}</div>
                                            {contact.remark && contact.remark !== contact.displayName && (
                                                <div className="contact-remark">备注: {contact.remark}</div>
                                            )}
                                        </div>
                                        <div className={`contact-type ${contact.type}`}>
                                            {getContactTypeIcon(contact.type)}
                                            <span>{getContactTypeName(contact.type)}</span>
                                        </div>
                                    </div>
                                </div>
                            )
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* 右侧面板 */}
            {exportMode ? (
                <div className="settings-panel">
                    <div className="panel-header">
                        <h2>导出设置</h2>
                    </div>

                    <div className="settings-content">
                        <div className="setting-section">
                            <h3>导出格式</h3>
                            <div className="format-select" ref={formatDropdownRef}>
                                <button
                                    type="button"
                                    className={`select-trigger ${showFormatSelect ? 'open' : ''}`}
                                    onClick={() => setShowFormatSelect(!showFormatSelect)}
                                >
                                    <span className="select-value">{getOptionLabel(exportFormat)}</span>
                                    <ChevronDown size={16} />
                                </button>
                                {showFormatSelect && (
                                    <div className="select-dropdown">
                                        {exportFormatOptions.map(option => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                className={`select-option ${exportFormat === option.value ? 'active' : ''}`}
                                                onClick={() => {
                                                    setExportFormat(option.value as 'json' | 'csv' | 'vcf')
                                                    setShowFormatSelect(false)
                                                }}
                                            >
                                                <span className="option-label">{option.label}</span>
                                                <span className="option-desc">{option.desc}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="setting-section">
                            <h3>导出选项</h3>
                            <label className="checkbox-item">
                                <input type="checkbox" checked={exportAvatars} onChange={e => setExportAvatars(e.target.checked)} />
                                <span>导出头像</span>
                            </label>
                        </div>

                        <div className="setting-section">
                            <h3>导出位置</h3>
                            <div className="export-path-display">
                                <FolderOpen size={16} />
                                <span>{exportFolder || '未设置'}</span>
                            </div>
                            <button className="select-folder-btn" onClick={selectExportFolder}>
                                <FolderOpen size={16} />
                                <span>选择导出目录</span>
                            </button>
                        </div>
                    </div>

                    <div className="export-action">
                        <button
                            className="export-btn"
                            onClick={startExport}
                            disabled={!exportFolder || isExporting || selectedUsernames.size === 0}
                        >
                            {isExporting ? (
                                <><Loader2 size={18} className="spin" /><span>导出中...</span></>
                            ) : (
                                <><Download size={18} /><span>开始导出</span></>
                            )}
                        </button>
                    </div>
                </div>
            ) : selectedContact ? (
                <div className="settings-panel">
                    <div className="panel-header">
                        <h2>联系人详情</h2>
                    </div>
                    <div className="settings-content">
                        <div className="detail-profile">
                            <div className="detail-avatar">
                                {selectedContact.avatarUrl ? (
                                    <img src={selectedContact.avatarUrl} alt="" />
                                ) : (
                                    <span>{getAvatarLetter(selectedContact.displayName)}</span>
                                )}
                            </div>
                            <div className="detail-name">{selectedContact.displayName}</div>
                            <div className={`contact-type ${selectedContact.type}`}>
                                {getContactTypeIcon(selectedContact.type)}
                                <span>{getContactTypeName(selectedContact.type)}</span>
                            </div>
                        </div>

                        <div className="detail-info-list">
                            <div className="detail-row"><span className="detail-label">用户名</span><span className="detail-value">{selectedContact.username}</span></div>
                            <div className="detail-row"><span className="detail-label">昵称</span><span className="detail-value">{selectedContact.nickname || selectedContact.displayName}</span></div>
                            {selectedContact.remark && <div className="detail-row"><span className="detail-label">备注</span><span className="detail-value">{selectedContact.remark}</span></div>}
                            {selectedContact.alias && <div className="detail-row"><span className="detail-label">微信号</span><span className="detail-value">{selectedContact.alias}</span></div>}
                            {selectedContact.labels && selectedContact.labels.length > 0 && <div className="detail-row"><span className="detail-label">标签</span><span className="detail-value">{selectedContact.labels.join('、')}</span></div>}
                            {selectedContact.detailDescription && <div className="detail-row"><span className="detail-label">详细描述</span><span className="detail-value">{selectedContact.detailDescription}</span></div>}
                            <div className="detail-row"><span className="detail-label">类型</span><span className="detail-value">{getContactTypeName(selectedContact.type)}</span></div>
                            {selectedContactSupportsSns && (
                                <div className="detail-row">
                                    <span className="detail-label">朋友圈</span>
                                    <button
                                        type="button"
                                        className="detail-entry-btn"
                                        onClick={openSelectedContactSnsTimeline}
                                    >
                                        <Aperture size={14} />
                                        <span>{selectedContactSnsEntryLabel}</span>
                                    </button>
                                </div>
                            )}
                        </div>

                        <button
                            className="goto-chat-btn"
                            onClick={() => {
                                setCurrentSession(selectedContact.username)
                                navigate('/chat')
                            }}
                        >
                            <MessageCircle size={18} />
                            <span>查看聊天记录</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="settings-panel">
                    <div className="empty-detail">
                        <User size={48} />
                        <span>点击左侧联系人查看详情</span>
                    </div>
                </div>
            )}
            <ContactSnsTimelineDialog
                target={snsTimelineTarget}
                onClose={() => setSnsTimelineTarget(null)}
                initialTotalPosts={selectedContact && snsTimelineTarget?.username === selectedContact.username ? selectedContactSnsCount : null}
                initialTotalPostsLoading={selectedContact && snsTimelineTarget?.username === selectedContact.username
                    ? snsUserPostCountsStatus === 'idle' || snsUserPostCountsStatus === 'loading'
                    : false}
            />
        </div>
    )
}

export default ContactsPage
