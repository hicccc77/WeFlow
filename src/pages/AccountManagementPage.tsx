import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, UserPlus, Trash2, ArrowRightLeft, CheckCircle2, Database } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import * as configService from '../services/config'
import './AccountManagementPage.scss'

interface ScannedWxidOption {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

interface ManagedAccountItem {
  wxid: string
  normalizedWxid: string
  displayName: string
  avatarUrl?: string
  modifiedTime?: number
  configUpdatedAt?: number
  hasConfig: boolean
  isCurrent: boolean
  fromScan: boolean
}

type AccountProfileCacheEntry = {
  displayName?: string
  avatarUrl?: string
  updatedAt?: number
}

interface DeleteUndoState {
  targetWxid: string
  deletedConfigEntries: Array<[string, configService.WxidConfig]>
  deletedProfileEntries: Array<[string, AccountProfileCacheEntry]>
  previousCurrentWxid: string
  shouldRestoreAsCurrent: boolean
  previousDbConnected: boolean
}

type NoticeState =
  | { type: 'success' | 'error' | 'info'; text: string }
  | null

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'
const ACCOUNT_PROFILES_CACHE_KEY = 'account_profiles_cache_v1'

const HIDDEN_DELETED_ACCOUNT_NORM_IDS_KEY = 'weflow_account_mgmt_hidden_deleted_norm_v1'

const readHiddenDeletedAccountNormIds = (): Set<string> => {
  try {
    const raw = window.localStorage.getItem(HIDDEN_DELETED_ACCOUNT_NORM_IDS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string' && x.length > 0))
  } catch {
    return new Set()
  }
}

const writeHiddenDeletedAccountNormIds = (ids: Set<string>): void => {
  try {
    window.localStorage.setItem(HIDDEN_DELETED_ACCOUNT_NORM_IDS_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    
  }
}

const addHiddenDeletedAccountNormId = (normalized: string): void => {
  if (!normalized) return
  const next = readHiddenDeletedAccountNormIds()
  next.add(normalized)
  writeHiddenDeletedAccountNormIds(next)
}

const removeHiddenDeletedAccountNormId = (normalized: string): void => {
  if (!normalized) return
  const next = readHiddenDeletedAccountNormIds()
  if (!next.delete(normalized)) return
  writeHiddenDeletedAccountNormIds(next)
}

const DEFAULT_ACCOUNT_DISPLAY_NAME = '微信用户'

const normalizeAccountId = (value?: string | null): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

const resolveAccountDisplayName = (
  candidates: Array<unknown>,
  wxidCandidates: Set<string>
): string => {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (candidate.length === 0) continue
    const normalized = candidate.trim().toLowerCase()
    if (normalized.startsWith('wxid_')) continue
    if (normalized && wxidCandidates.has(normalized)) continue
    return candidate
  }
  return DEFAULT_ACCOUNT_DISPLAY_NAME
}

const resolveAccountAvatarText = (displayName?: string): string => {
  if (typeof displayName !== 'string' || displayName.length === 0) return '微'
  const visible = displayName.trim()
  return (visible && [...visible][0]) || '微'
}

const readAccountProfilesCache = (): Record<string, AccountProfileCacheEntry> => {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_PROFILES_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, AccountProfileCacheEntry> : {}
  } catch {
    return {}
  }
}

function AccountManagementPage() {
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const setDbConnected = useAppStore(state => state.setDbConnected)
  const resetChatStore = useChatStore(state => state.reset)
  const clearAnalyticsStoreCache = useAnalyticsStore(state => state.clearCache)

  const [dbPath, setDbPath] = useState('')
  const [currentWxid, setCurrentWxid] = useState('')
  const [accounts, setAccounts] = useState<ManagedAccountItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [workingWxid, setWorkingWxid] = useState('')
  const [notice, setNotice] = useState<NoticeState>(null)
  const [deleteUndoState, setDeleteUndoState] = useState<DeleteUndoState | null>(null)

  const loadAccounts = useCallback(async () => {
    setIsLoading(true)
    try {
      const [path, rawCurrentWxid, wxidConfigs] = await Promise.all([
        configService.getDbPath(),
        configService.getMyWxid(),
        configService.getWxidConfigs()
      ])
      const nextDbPath = String(path || '').trim()
      const nextCurrentWxid = String(rawCurrentWxid || '').trim()
      const normalizedCurrent = normalizeAccountId(nextCurrentWxid) || nextCurrentWxid
      setDbPath(nextDbPath)
      setCurrentWxid(nextCurrentWxid)

      let scannedWxids: ScannedWxidOption[] = []
      if (nextDbPath) {
        try {
          const scanned = await window.electronAPI.dbPath.scanWxids(nextDbPath)
          scannedWxids = Array.isArray(scanned) ? scanned as ScannedWxidOption[] : []
        } catch {
          scannedWxids = []
        }
      }

      const accountProfileCache = readAccountProfilesCache()
      const configEntries = Object.entries(wxidConfigs || {})
      const configByNormalized = new Map<string, { key: string; value: configService.WxidConfig }>()
      for (const [wxid, cfg] of configEntries) {
        const normalized = normalizeAccountId(wxid) || wxid
        if (!normalized) continue
        const previous = configByNormalized.get(normalized)
        if (!previous || Number(cfg?.updatedAt || 0) > Number(previous.value?.updatedAt || 0)) {
          configByNormalized.set(normalized, { key: wxid, value: cfg || {} })
        }
      }

      const merged = new Map<string, ManagedAccountItem>()
      for (const scanned of scannedWxids) {
        const normalized = normalizeAccountId(scanned.wxid) || scanned.wxid
        if (!normalized) continue
        const cached = accountProfileCache[scanned.wxid] || accountProfileCache[normalized]
        const matchedConfig = configByNormalized.get(normalized)
        const wxidCandidates = new Set<string>([
          String(scanned.wxid || '').trim().toLowerCase(),
          String(normalized || '').trim().toLowerCase()
        ].filter(Boolean))
        const displayName = resolveAccountDisplayName(
          [scanned.nickname, cached?.displayName],
          wxidCandidates
        )
        merged.set(normalized, {
          wxid: scanned.wxid,
          normalizedWxid: normalized,
          displayName,
          avatarUrl: scanned.avatarUrl || cached?.avatarUrl,
          modifiedTime: Number(scanned.modifiedTime || 0),
          configUpdatedAt: Number(matchedConfig?.value?.updatedAt || 0),
          hasConfig: Boolean(matchedConfig),
          isCurrent: Boolean(normalizedCurrent) && normalized === normalizedCurrent,
          fromScan: true
        })
      }

      for (const [normalized, matchedConfig] of configByNormalized.entries()) {
        if (merged.has(normalized)) continue
        const wxid = matchedConfig.key
        const cached = accountProfileCache[wxid] || accountProfileCache[normalized]
        const wxidCandidates = new Set<string>([
          String(wxid || '').trim().toLowerCase(),
          String(normalized || '').trim().toLowerCase()
        ].filter(Boolean))
        const displayName = resolveAccountDisplayName(
          [cached?.displayName],
          wxidCandidates
        )
        merged.set(normalized, {
          wxid,
          normalizedWxid: normalized,
          displayName,
          avatarUrl: cached?.avatarUrl,
          modifiedTime: 0,
          configUpdatedAt: Number(matchedConfig.value?.updatedAt || 0),
          hasConfig: true,
          isCurrent: Boolean(normalizedCurrent) && normalized === normalizedCurrent,
          fromScan: false
        })
      }

      // 被「删除配置」移除的账号：微信目录仍在扫描结果里会出现无配置条目，持久化隐藏避免误导；
      // 若后续再次保存该账号配置，则自动恢复展示。
      const hiddenDeletedNormIds = readHiddenDeletedAccountNormIds()
      for (const [normalized, item] of Array.from(merged.entries())) {
        if (!hiddenDeletedNormIds.has(normalized)) continue
        if (item.hasConfig) {
          hiddenDeletedNormIds.delete(normalized)
          writeHiddenDeletedAccountNormIds(hiddenDeletedNormIds)
          continue
        }
        merged.delete(normalized)
      }

      const nextAccounts = Array.from(merged.values()).sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) return -1
        if (!a.isCurrent && b.isCurrent) return 1
        const scanDiff = Number(b.modifiedTime || 0) - Number(a.modifiedTime || 0)
        if (scanDiff !== 0) return scanDiff
        return Number(b.configUpdatedAt || 0) - Number(a.configUpdatedAt || 0)
      })
      setAccounts(nextAccounts)
    } catch (error) {
      console.error('加载账号列表失败:', error)
      setNotice({ type: 'error', text: '加载账号列表失败，请稍后重试' })
      setAccounts([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAccounts()
    const onWxidChanged = () => { void loadAccounts() }
    const onWindowFocus = () => { void loadAccounts() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadAccounts()
      }
    }
    window.addEventListener('wxid-changed', onWxidChanged as EventListener)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('wxid-changed', onWxidChanged as EventListener)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [loadAccounts])

  const clearRuntimeCacheState = useCallback(async () => {
    if (isDbConnected) {
      await window.electronAPI.chat.close()
    }
    window.localStorage.removeItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
    clearAnalyticsStoreCache()
    resetChatStore()
  }, [clearAnalyticsStoreCache, isDbConnected, resetChatStore])

  const applyWxidConfig = useCallback(async (wxid: string, wxidConfig: configService.WxidConfig | null) => {
    await configService.setMyWxid(wxid)
    await configService.setDecryptKey(wxidConfig?.decryptKey || '')
    await configService.setImageXorKey(typeof wxidConfig?.imageXorKey === 'number' ? wxidConfig.imageXorKey : 0)
    await configService.setImageAesKey(wxidConfig?.imageAesKey || '')
  }, [])

  const handleSwitchAccount = useCallback(async (wxid: string) => {
    if (!wxid || workingWxid) return
    const targetNormalized = normalizeAccountId(wxid) || wxid
    const currentNormalized = normalizeAccountId(currentWxid) || currentWxid
    if (targetNormalized && currentNormalized && targetNormalized === currentNormalized) return

    setWorkingWxid(wxid)
    setNotice(null)
    setDeleteUndoState(null)
    try {
      const allConfigs = await configService.getWxidConfigs()
      const configEntries = Object.entries(allConfigs || {})
      const matched = configEntries.find(([key]) => {
        const normalized = normalizeAccountId(key) || key
        return key === wxid || normalized === targetNormalized
      })
      const targetConfig = matched?.[1] || null
      await applyWxidConfig(wxid, targetConfig)
      await clearRuntimeCacheState()
      window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid } }))
      setNotice({ type: 'success', text: `已切换到账号「${wxid}」` })
      await loadAccounts()
    } catch (error) {
      console.error('切换账号失败:', error)
      setNotice({ type: 'error', text: '切换账号失败，请稍后重试' })
    } finally {
      setWorkingWxid('')
    }
  }, [applyWxidConfig, clearRuntimeCacheState, currentWxid, loadAccounts, workingWxid])

  const handleAddAccount = useCallback(async () => {
    if (workingWxid) return
    setNotice(null)
    setDeleteUndoState(null)
    try {
      await window.electronAPI.window.openOnboardingWindow({ mode: 'add-account' })
      await loadAccounts()
      const latestWxid = String(await configService.getMyWxid() || '').trim()
      window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: latestWxid } }))
    } catch (error) {
      console.error('打开添加账号引导失败:', error)
      setNotice({ type: 'error', text: '打开添加账号引导失败，请稍后重试' })
    }
  }, [loadAccounts, workingWxid])

  const handleDeleteAccountConfig = useCallback(async (targetWxid: string) => {
    if (!targetWxid || workingWxid) return

    const normalizedTarget = normalizeAccountId(targetWxid) || targetWxid

    setWorkingWxid(targetWxid)
    setNotice(null)
    setDeleteUndoState(null)
    try {
      const allConfigs = await configService.getWxidConfigs()
      const nextConfigs: Record<string, configService.WxidConfig> = { ...allConfigs }
      const matchedKeys = Object.keys(nextConfigs).filter((key) => {
        const normalized = normalizeAccountId(key) || key
        return key === targetWxid || normalized === normalizedTarget
      })

      if (matchedKeys.length === 0) {
        setNotice({ type: 'info', text: `账号「${targetWxid}」暂无可删除配置` })
        return
      }

      const deletedConfigEntries: Array<[string, configService.WxidConfig]> = matchedKeys.map((key) => [key, nextConfigs[key] || {}])
      for (const key of matchedKeys) {
        delete nextConfigs[key]
      }
      await configService.setWxidConfigs(nextConfigs)

      const accountProfileCache = readAccountProfilesCache()
      const deletedProfileEntries: Array<[string, AccountProfileCacheEntry]> = []
      for (const key of Object.keys(accountProfileCache)) {
        const normalized = normalizeAccountId(key) || key
        if (key === targetWxid || normalized === normalizedTarget) {
          deletedProfileEntries.push([key, accountProfileCache[key]])
          delete accountProfileCache[key]
        }
      }
      window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountProfileCache))

      const currentNormalized = normalizeAccountId(currentWxid) || currentWxid
      const isDeletingCurrent = Boolean(currentNormalized && currentNormalized === normalizedTarget)
      const undoPayload: DeleteUndoState = {
        targetWxid,
        deletedConfigEntries,
        deletedProfileEntries,
        previousCurrentWxid: currentWxid,
        shouldRestoreAsCurrent: isDeletingCurrent,
        previousDbConnected: isDbConnected
      }

      if (isDeletingCurrent) {
        await clearRuntimeCacheState()

        const remainingEntries = Object.entries(nextConfigs)
          .filter(([wxid]) => Boolean(String(wxid || '').trim()))
          .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))

        if (remainingEntries.length > 0) {
          const [nextWxid, nextConfig] = remainingEntries[0]
          await applyWxidConfig(nextWxid, nextConfig || null)
          window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: nextWxid } }))
          addHiddenDeletedAccountNormId(normalizedTarget)
          setDeleteUndoState(undoPayload)
          setNotice({ type: 'success', text: `已删除「${targetWxid}」配置，并切换到「${nextWxid}」` })
          await loadAccounts()
          return
        }

        await configService.setMyWxid('')
        await configService.setDecryptKey('')
        await configService.setImageXorKey(0)
        await configService.setImageAesKey('')
        setDbConnected(false)
        window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: '' } }))
        addHiddenDeletedAccountNormId(normalizedTarget)
        setDeleteUndoState(undoPayload)
        setNotice({ type: 'info', text: `已删除「${targetWxid}」配置，当前无可用账号配置，可撤回或添加账号` })
        await loadAccounts()
        return
      }

      addHiddenDeletedAccountNormId(normalizedTarget)
      setDeleteUndoState(undoPayload)
      setNotice({ type: 'success', text: `已删除账号「${targetWxid}」配置` })
      await loadAccounts()
    } catch (error) {
      console.error('删除账号配置失败:', error)
      setNotice({ type: 'error', text: '删除账号配置失败，请稍后重试' })
    } finally {
      setWorkingWxid('')
    }
  }, [applyWxidConfig, clearRuntimeCacheState, currentWxid, isDbConnected, loadAccounts, setDbConnected, workingWxid])

  const handleUndoDelete = useCallback(async () => {
    if (!deleteUndoState || workingWxid) return

    setWorkingWxid(`undo:${deleteUndoState.targetWxid}`)
    setNotice(null)
    try {
      const currentConfigs = await configService.getWxidConfigs()
      const restoredConfigs: Record<string, configService.WxidConfig> = { ...currentConfigs }
      for (const [key, configValue] of deleteUndoState.deletedConfigEntries) {
        restoredConfigs[key] = configValue || {}
      }
      await configService.setWxidConfigs(restoredConfigs)
      removeHiddenDeletedAccountNormId(normalizeAccountId(deleteUndoState.targetWxid) || deleteUndoState.targetWxid)

      const accountProfileCache = readAccountProfilesCache()
      for (const [key, profile] of deleteUndoState.deletedProfileEntries) {
        accountProfileCache[key] = profile
      }
      window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountProfileCache))

      if (deleteUndoState.shouldRestoreAsCurrent && deleteUndoState.previousCurrentWxid) {
        const previousNormalized = normalizeAccountId(deleteUndoState.previousCurrentWxid) || deleteUndoState.previousCurrentWxid
        const restoreConfigEntry = Object.entries(restoredConfigs)
          .filter(([key]) => {
            const normalized = normalizeAccountId(key) || key
            return key === deleteUndoState.previousCurrentWxid || normalized === previousNormalized
          })
          .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))[0]
        const restoreConfig = restoreConfigEntry?.[1] || null

        await clearRuntimeCacheState()
        await applyWxidConfig(deleteUndoState.previousCurrentWxid, restoreConfig)
        if (deleteUndoState.previousDbConnected) {
          setDbConnected(true, dbPath || undefined)
        }
        window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: deleteUndoState.previousCurrentWxid } }))
      }

      setNotice({ type: 'success', text: `已撤回删除，账号「${deleteUndoState.targetWxid}」配置已恢复` })
      setDeleteUndoState(null)
      await loadAccounts()
    } catch (error) {
      console.error('撤回删除失败:', error)
      setNotice({ type: 'error', text: '撤回删除失败，请稍后重试' })
    } finally {
      setWorkingWxid('')
    }
  }, [applyWxidConfig, clearRuntimeCacheState, dbPath, deleteUndoState, loadAccounts, setDbConnected, workingWxid])

  const currentAccountLabel = useMemo(() => {
    if (!currentWxid) return '未设置'
    return currentWxid
  }, [currentWxid])

  const formatTime = (value?: number): string => {
    const ts = Number(value || 0)
    if (!ts) return '未知'
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '未知'
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
  }

  return (
    <div className="account-management-page">
      <header className="account-management-header">
        <div>
          <h2>账号管理</h2>
          <p>统一管理切换账号、添加账号、删除账号配置。</p>
        </div>
        <div className="account-management-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void loadAccounts()} disabled={isLoading || Boolean(workingWxid)}>
            <RefreshCw size={16} /> {isLoading ? '刷新中...' : '刷新'}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleAddAccount} disabled={Boolean(workingWxid)}>
            <UserPlus size={16} /> 添加账号
          </button>
        </div>
      </header>

      <section className="account-management-summary">
        <div className="summary-item">
          <span className="summary-label">数据库目录</span>
          <span className="summary-value">{dbPath || '未配置'}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">当前账号</span>
          <span className="summary-value">{currentAccountLabel}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">账号数量</span>
          <span className="summary-value">{accounts.length}</span>
        </div>
      </section>

      {notice && (
        <div className={`account-notice ${notice.type}`}>
          <span>{notice.text}</span>
          {deleteUndoState && (notice.type === 'success' || notice.type === 'info') && (
            <button
              type="button"
              className="notice-action"
              onClick={() => void handleUndoDelete()}
              disabled={Boolean(workingWxid)}
            >
              撤回
            </button>
          )}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="account-empty">
          <Database size={20} />
          <span>未发现可管理账号，请先添加账号或检查数据库目录。</span>
        </div>
      ) : (
        <div className="account-list">
          {accounts.map((account) => (
            <article key={account.normalizedWxid} className={`account-card ${account.isCurrent ? 'is-current' : ''}`}>
              <div className="account-avatar">
                {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <span>{resolveAccountAvatarText(account.displayName)}</span>}
              </div>
              <div className="account-main">
                <div className="account-title-row">
                  <h3>{account.displayName}</h3>
                  {account.isCurrent && (
                    <span className="account-badge current">
                      <CheckCircle2 size={12} /> 当前
                    </span>
                  )}
                  {account.hasConfig ? (
                    <span className="account-badge ok">已保存配置</span>
                  ) : (
                    <span className="account-badge warn">未保存配置</span>
                  )}
                </div>
                <div className="account-meta">wxid: {account.wxid}</div>
                <div className="account-meta">
                  最近数据更新时间: {formatTime(account.modifiedTime)} · 配置更新时间: {formatTime(account.configUpdatedAt)}
                  {!account.fromScan && <span className="meta-tip">（仅配置记录）</span>}
                </div>
              </div>
              <div className="account-card-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleSwitchAccount(account.wxid)}
                  disabled={Boolean(workingWxid) || account.isCurrent || !account.hasConfig || !account.fromScan}
                >
                  <ArrowRightLeft size={14} /> {account.isCurrent ? '当前账号' : (!account.hasConfig ? '无配置' : (account.fromScan ? '切换' : '无数据'))}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void handleDeleteAccountConfig(account.wxid)}
                  disabled={Boolean(workingWxid) || !account.hasConfig}
                >
                  <Trash2 size={14} /> 删除配置
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <footer className="account-management-footer">
        删除仅影响 WeFlow 本地配置，不会删除微信原始数据文件。
      </footer>
    </div>
  )
}

export default AccountManagementPage
